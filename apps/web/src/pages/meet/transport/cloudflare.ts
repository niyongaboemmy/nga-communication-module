import type { Socket } from 'socket.io-client';
import {
  SIMULCAST_LAYERS, AUDIO_BITRATE, SCREENSHARE_BITRATE, SFU_KEEPALIVE_MS,
  sfuTrackName, parseSfuTrackName,
} from '@tupo/shared';
import type { VideoQuality } from '@tupo/shared';
import { apiPost, apiPut } from '../../../lib/api';
import type { MediaTransport, TransportInit } from './types.js';

/**
 * Cloudflare Realtime SFU transport.
 *
 * One PeerConnection to Cloudflare, carrying everything: this client's own
 * tracks going up, and every track it has chosen to watch coming down. That
 * single connection is what makes a large meeting possible — a publisher
 * uploads once whatever the size of the audience, so the cost of a 400-person
 * assembly is one uplink each rather than 399.
 *
 * The shape of Cloudflare's API drives the design. There is **no room**: it is
 * a pub/sub of sessions and tracks, and the application decides who subscribes
 * to what. Tupo already knows — `tupo-realtime` owns the roster — so:
 *
 *  - track names are *derived* from the participant id (`cam-<id>`, `mic-<id>`,
 *    `screen-<id>`) and never exchanged;
 *  - the only thing that has to travel is each publisher's session id, which
 *    rides on the roster;
 *  - **subscription is demand-driven**. `setSubscriptions` pulls tracks for the
 *    tiles actually on screen and closes the rest. In a room of four hundred
 *    that is the difference between twenty-five downstreams and four hundred.
 *
 * The app secret is never here. Every call goes through Tupo's own API, which
 * authorises it against the meeting first — see `routes/meet.ts`.
 */

interface CloudflareTrack {
  location: 'local' | 'remote';
  mid?: string;
  sessionId?: string;
  trackName?: string;
  kind?: 'audio' | 'video';
  simulcast?: { preferredRid?: string; priorityOrdering?: 'none' | 'asciibetical' };
}

interface TracksResponse {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: { sdp: string; type: 'offer' | 'answer' };
  tracks?: Array<CloudflareTrack & { errorCode?: string; errorDescription?: string }>;
}

/**
 * How long a video subscription survives its tile disappearing.
 *
 * Long enough to ride out a layout change, short enough that scrolling away
 * from someone stops costing their bandwidth almost immediately.
 */
const UNSUBSCRIBE_GRACE_MS = 4000;

/** What this client is currently pulling, keyed by the remote track name. */
interface Subscription {
  participantId: string;
  kind: 'cam' | 'mic' | 'screen' | 'screenaudio';
  mid: string;
}

export class CloudflareTransport implements MediaTransport {
  readonly kind = 'cloudflare' as const;

  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private local: MediaStream | null = null;
  private screen: MediaStream | null = null;

  private micSender: RTCRtpSender | null = null;
  private camSender: RTCRtpSender | null = null;
  private screenSender: RTCRtpSender | null = null;

  private readonly subscriptions = new Map<string, Subscription>();
  /** participantId → the streams being assembled for them from arriving tracks. */
  private readonly remote = new Map<string, {
    camera: MediaStream; screen: MediaStream; hasVideo: boolean; hasAudio: boolean;
  }>();
  /** Transceiver mid → which participant and kind Cloudflare gave us. */
  private readonly midMap = new Map<string, { participantId: string; kind: string }>();
  /** participantId → their publishing session, learned from the roster. */
  private readonly sessions = new Map<string, string>();
  /**
   * Who is presenting right now, learned from `meet:presenting`.
   *
   * A screen share is a track the SFU only forwards on request, exactly like a
   * camera — but unlike a camera it has no tile of its own reporting visibility,
   * so nothing in the visibility-driven path would ever pull it. Without this
   * set the share is announced on the socket (the banner appears) and not one
   * frame is ever subscribed to: the stage stays empty.
   */
  private readonly presenting = new Set<string>();
  /**
   * The last set of visible tiles.
   *
   * Kept because subscription is driven by two independent things: which tiles
   * are on screen, and who is publishing. The tiles report only when they
   * change, so a participant who starts publishing *after* their tile appeared
   * would never be pulled — the room has nothing new to say about visibility.
   * Re-applying the remembered set on a new publisher closes that gap.
   */
  private lastVisible: Array<{ participantId: string; quality: VideoQuality }> = [];
  /**
   * Video subscriptions pending closure, and when they became unwanted.
   *
   * A tile reports width 0 for a moment whenever the layout changes — opening
   * a panel, switching to speaker view, a re-render. Closing on the first such
   * report and re-pulling a moment later costs a visible flicker, a fresh
   * renegotiation and a new mid every time. Waiting a few seconds before
   * closing turns that churn into nothing at all, and the cost of being wrong
   * is a few seconds of video nobody is looking at.
   */
  private readonly closing = new Map<string, number>();

  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private publishQuality: VideoQuality = 'high';
  private closed = false;
  /** Serialises negotiation — Cloudflare rejects overlapping renegotiations. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly socket: Socket,
    private readonly init: TransportInit,
  ) {}

  private get endpoint(): string {
    return this.init.sfuEndpoint ?? `/api/meet/${this.init.meetingId}/sfu`;
  }

  /** Everything that renegotiates runs through here, one at a time. */
  private serialise<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // Swallow rejections on the chain itself so one failure does not poison
    // every negotiation that follows it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /* ---------------- lifecycle ---------------- */

  async connect(local: MediaStream | null): Promise<void> {
    this.local = local;

    const session = await apiPost<{ sessionId: string; participantId: string }>(
      `${this.endpoint}/session`);
    this.sessionId = session.data!.sessionId;

    const pc = new RTCPeerConnection({
      iceServers: this.init.iceServers as RTCIceServer[],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.pc = pc;

    // Development-only introspection, matching the mesh transport's. A media
    // failure through an SFU is invisible from outside — the connection is
    // "connected" whether or not a single packet has arrived — so the
    // acceptance tests measure inbound bytes rather than trusting state.
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __meshPeers?: Record<string, () => unknown>;
        __meshStats?: Record<string, () => Promise<number>>;
        __meshState?: Record<string, string>;
      };
      w.__meshPeers ??= {};
      w.__meshStats ??= {};
      w.__meshState ??= {};

      w.__meshPeers.cloudflare = () => ({
        connection: pc.connectionState,
        publishers: this.sessions.size,
        subscriptions: [...this.subscriptions.keys()],
      });
      w.__meshStats.cloudflare = async () => {
        let bytes = 0;
        (await pc.getStats()).forEach((r) => {
          const report = r as { type: string; kind?: string; bytesReceived?: number };
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            bytes += Number(report.bytesReceived ?? 0);
          }
        });
        return bytes;
      };
      pc.onconnectionstatechange = () => {
        w.__meshState!.cloudflare =
          `${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState}`;
      };
    }

    pc.ontrack = (event) => this.onTrack(event);
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };

    this.bindRoster();
    await this.publishLocal();

    // Cloudflare drops a session after 30 seconds without media, so someone
    // sitting muted with their camera off would be collected while still in
    // the meeting. One cheap GET holds it open.
    this.keepAlive = setInterval(() => {
      void fetch(`${this.endpoint}/session`, {
        headers: authHeader(),
      }).catch(() => {});
    }, SFU_KEEPALIVE_MS);

    this.statsTimer = setInterval(() => void this.sampleStats(), 5000);

    // Tell the room where to find us. Only now — announcing before the tracks
    // exist invites subscriptions to nothing.
    this.socket.emit('meet:sfu:publish', { sessionId: this.sessionId });
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.unbindRoster();
    for (const participantId of this.remote.keys()) this.init.events.onRemoteGone(participantId);
    this.remote.clear();
    this.subscriptions.clear();
    this.midMap.clear();
    this.pc?.close();
    this.pc = null;
  }

  /* ---------------- roster ---------------- */

  private readonly handlers: Array<[string, (payload: never) => void]> = [];

  private bindRoster(): void {
    const on = <T>(event: string, handler: (p: T) => void) => {
      this.socket.on(event, handler as (...args: unknown[]) => void);
      this.handlers.push([event, handler as (p: never) => void]);
    };

    on<{ participantId: string; sessionId: string }>('meet:sfu:published', (p) => {
      if (p.participantId === this.init.participantId) return;
      const known = this.sessions.get(p.participantId);
      this.sessions.set(p.participantId, p.sessionId);
      if (known === p.sessionId) return;
      // Someone started publishing. The stage has nothing new to say about
      // visibility, so nothing else would ever trigger the subscription.
      void this.setSubscriptions(this.lastVisible);
    });

    on<{ participantId: string }>('meet:participant_left', (p) => {
      this.sessions.delete(p.participantId);
      void this.unsubscribeParticipant(p.participantId);
    });
  }

  private unbindRoster(): void {
    for (const [event, handler] of this.handlers) {
      this.socket.off(event, handler as (...args: unknown[]) => void);
    }
    this.handlers.length = 0;
  }

  /**
   * Told by the room who is presenting, so their screen track is pulled the
   * same way a visible camera is. Re-runs the subscription immediately: nothing
   * else would, since the stage has nothing new to say about visibility.
   */
  setPresenting(participantId: string, on: boolean): void {
    if (participantId === this.init.participantId) return;
    if (on === this.presenting.has(participantId)) return;
    if (on) this.presenting.add(participantId);
    else this.presenting.delete(participantId);
    void this.setSubscriptions(this.lastVisible);
  }

  /** Seeded from the roster the socket already delivered on join. */
  setKnownSessions(entries: Array<{ participantId: string; sessionId: string }>): void {
    for (const entry of entries) {
      if (entry.participantId === this.init.participantId) continue;
      this.sessions.set(entry.participantId, entry.sessionId);
    }
  }

  /**
   * Whoever is currently publishing, so a caller can tell whether a silent
   * participant is muted or simply has not started yet. Development aid.
   */
  get publisherCount(): number {
    return this.sessions.size;
  }

  /* ---------------- publishing ---------------- */

  private async publishLocal(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.sessionId) return;

    const tracks: CloudflareTrack[] = [];
    const me = this.init.participantId;

    const addLocal = (
      track: MediaStreamTrack, stream: MediaStream, name: string, simulcast: boolean,
    ) => {
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        ...(simulcast
          ? {
              // Three rungs published once. The SFU serves each subscriber the
              // one their tile needs, which is what lets a phone and a
              // projector watch the same publisher without either compromising.
              sendEncodings: SIMULCAST_LAYERS.map((layer) => ({
                rid: layer.rid,
                maxBitrate: layer.maxBitrate,
                maxFramerate: layer.maxFramerate,
                scaleResolutionDownBy: layer.scaleDownBy,
              })),
            }
          : {}),
      });
      return { transceiver, name };
    };

    const pending: Array<{ transceiver: RTCRtpTransceiver; name: string }> = [];

    for (const track of this.local?.getAudioTracks() ?? []) {
      const entry = addLocal(track, this.local!, sfuTrackName(me, 'mic'), false);
      this.micSender = entry.transceiver.sender;
      pending.push(entry);
    }
    for (const track of this.local?.getVideoTracks() ?? []) {
      const entry = addLocal(track, this.local!, sfuTrackName(me, 'cam'), true);
      this.camSender = entry.transceiver.sender;
      pending.push(entry);
    }

    if (!pending.length) return;

    await pc.setLocalDescription(await pc.createOffer());
    for (const entry of pending) {
      tracks.push({ location: 'local', mid: entry.transceiver.mid ?? undefined, trackName: entry.name });
    }

    const result = await apiPost<TracksResponse>(`${this.endpoint}/tracks`, {
      sessionDescription: { sdp: pc.localDescription!.sdp, type: 'offer' },
      tracks,
    });
    const answer = result.data?.sessionDescription;
    if (answer) await pc.setRemoteDescription(answer);

    await this.applyEncodings();
  }

  async publish(stream: MediaStream | null): Promise<void> {
    this.local = stream;
    const audio = stream?.getAudioTracks()[0] ?? null;
    const video = stream?.getVideoTracks()[0] ?? null;
    // replaceTrack swaps the source with no renegotiation, which is what makes
    // changing camera mid-call instant rather than a visible reconnect.
    if (this.micSender) await this.micSender.replaceTrack(audio);
    if (this.camSender) await this.camSender.replaceTrack(video);
    await this.applyEncodings();
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    for (const track of this.local?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    for (const track of this.local?.getVideoTracks() ?? []) track.enabled = enabled;
  }

  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    // One publishing connection, so one camera sender — but it must not be
    // confused with the screen-share sender, which is also video.
    const screenIds = new Set((this.screen?.getVideoTracks() ?? []).map((t) => t.id));
    const sender = this.pc?.getSenders()
      .find((s) => s.track?.kind === 'video' && !screenIds.has(s.track.id));
    if (sender) await sender.replaceTrack(track).catch(() => {});
  }

  async startScreenShare(stream: MediaStream): Promise<string | null> {
    const pc = this.pc;
    if (!pc) return null;
    this.screen = stream;

    return this.serialise(async () => {
      const tracks: CloudflareTrack[] = [];
      const pending: Array<{ transceiver: RTCRtpTransceiver; name: string }> = [];
      const me = this.init.participantId;

      for (const track of stream.getVideoTracks()) {
        const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
        this.screenSender = transceiver.sender;
        pending.push({ transceiver, name: sfuTrackName(me, 'screen') });
      }
      for (const track of stream.getAudioTracks()) {
        const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
        pending.push({ transceiver, name: sfuTrackName(me, 'screenaudio') });
      }
      if (!pending.length) return null;

      await pc.setLocalDescription(await pc.createOffer());
      for (const entry of pending) {
        tracks.push({ location: 'local', mid: entry.transceiver.mid ?? undefined, trackName: entry.name });
      }

      const result = await apiPost<TracksResponse>(`${this.endpoint}/tracks`, {
        sessionDescription: { sdp: pc.localDescription!.sdp, type: 'offer' },
        tracks,
      });
      const answer = result.data?.sessionDescription;
      if (answer) await pc.setRemoteDescription(answer);

      // A shared slide deck is mostly static, so bitrate is better spent on
      // legibility than on frames.
      if (this.screenSender) {
        const params = this.screenSender.getParameters();
        params.encodings = [{ maxBitrate: SCREENSHARE_BITRATE, maxFramerate: 15 }];
        try { await this.screenSender.setParameters(params); } catch { /* unsupported */ }
      }
      // Nothing to bind by id on this transport — the SFU labels the track.
      return null;
    });
  }

  async stopScreenShare(): Promise<void> {
    const pc = this.pc;
    for (const track of this.screen?.getTracks() ?? []) track.stop();
    this.screen = null;
    if (!pc || !this.screenSender) return;

    await this.serialise(async () => {
      const mid = pc.getTransceivers().find((t) => t.sender === this.screenSender)?.mid;
      this.screenSender = null;
      if (!mid) return;
      await apiPut(`${this.endpoint}/close`, { tracks: [{ mid }], force: true });
    });
  }

  /* ---------------- subscribing ---------------- */

  /**
   * Pull exactly what is on screen, and nothing else.
   *
   * This is the whole reason a large meeting works. The roster may hold four
   * hundred people; the stage renders twenty-five. Subscribing to the rest
   * would cost four hundred downstreams for no visible benefit, so tracks are
   * added as tiles appear and closed as they leave — and audio is treated
   * differently from video, because you want to *hear* people you cannot see.
   */
  async setSubscriptions(
    visible: Array<{ participantId: string; quality: VideoQuality }>,
  ): Promise<void> {
    this.lastVisible = visible;
    if (!this.pc || !this.sessionId || this.closed) return;

    await this.serialise(async () => {
      const wantVideo = new Map(
        visible.filter((v) => v.quality !== 'off').map((v) => [v.participantId, v.quality]));

      const wanted = new Set<string>();
      const toAdd: CloudflareTrack[] = [];

      for (const [participantId, sessionId] of this.sessions) {
        // Audio for everyone publishing: a hundred simultaneous voices is not a
        // real scenario, and not hearing someone because their tile scrolled
        // off is a much worse one.
        const micName = sfuTrackName(participantId, 'mic');
        wanted.add(micName);
        if (!this.subscriptions.has(micName)) {
          toAdd.push({ location: 'remote', sessionId, trackName: micName });
        }

        // A screen share is why people are in the meeting; it is pulled as soon
        // as the room says this participant is presenting, and never dropped for
        // being off-screen. (It has no tile of its own to report visibility, so
        // the presenting set is the only thing that can trigger this.)
        const screenName = sfuTrackName(participantId, 'screen');
        if (this.presenting.has(participantId)) {
          wanted.add(screenName);
          if (!this.subscriptions.has(screenName)) {
            toAdd.push({ location: 'remote', sessionId, trackName: screenName });
          }
        }

        const quality = wantVideo.get(participantId);
        if (!quality) continue;

        const camName = sfuTrackName(participantId, 'cam');
        wanted.add(camName);
        if (!this.subscriptions.has(camName)) {
          toAdd.push({
            location: 'remote', sessionId, trackName: camName,
            // Ask for the rung the tile actually needs. A 160px thumbnail
            // served 720p is the commonest way a call wastes bandwidth.
            simulcast: {
              preferredRid: quality === 'high' ? 'f' : quality === 'medium' ? 'h' : 'q',
              priorityOrdering: 'asciibetical',
            },
          });
        }
      }

      const now = Date.now();
      const toClose: Array<{ name: string; mid: string }> = [];
      for (const [name, sub] of this.subscriptions) {
        if (wanted.has(name)) {
          this.closing.delete(name);
          continue;
        }
        const since = this.closing.get(name);
        if (since === undefined) {
          this.closing.set(name, now);
          continue;
        }
        if (now - since >= UNSUBSCRIBE_GRACE_MS) {
          toClose.push({ name, mid: sub.mid });
          this.closing.delete(name);
        }
      }

      if (toClose.length) {
        // `force` closes the data flow without renegotiating — far cheaper than
        // a full round trip for someone who merely scrolled out of view.
        await apiPut(`${this.endpoint}/close`, {
          tracks: toClose.map((t) => ({ mid: t.mid })), force: true,
        }).catch(() => undefined);
        for (const entry of toClose) {
          this.subscriptions.delete(entry.name);
          this.midMap.delete(entry.mid);
        }
      }

      if (toAdd.length) {
        try {
          await this.pullTracks(toAdd);
        } catch (err) {
          // A failed pull leaves a black tile and no other trace, so it is
          // reported rather than swallowed.
          this.init.events.onError(
            `Could not subscribe to ${toAdd.length} track(s): ${describeError(err)}`);
        }
      }
    });
  }

  /** Add remote tracks and complete the renegotiation Cloudflare asks for. */
  private async pullTracks(tracks: CloudflareTrack[]): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    const result = await apiPost<TracksResponse>(`${this.endpoint}/tracks`, { tracks });
    const payload = result.data;
    if (!payload) return;

    for (const track of payload.tracks ?? []) {
      if (track.errorCode || !track.trackName || !track.mid) continue;
      const parsed = parseSfuTrackName(track.trackName);
      if (!parsed) continue;
      this.subscriptions.set(track.trackName, {
        participantId: parsed.participantId, kind: parsed.kind, mid: track.mid,
      });
      // Bound before the offer is applied, so `ontrack` can identify the track
      // the moment it fires.
      this.midMap.set(track.mid, { participantId: parsed.participantId, kind: parsed.kind });
    }

    if (payload.requiresImmediateRenegotiation && payload.sessionDescription) {
      await pc.setRemoteDescription(payload.sessionDescription);
      // Argument-less: the browser creates the answer and applies it as one
      // step, so no state can change in between.
      await pc.setLocalDescription();
      const answer = pc.localDescription;
      if (!answer) throw new Error('The browser produced no answer to subscribe with.');

      await apiPut(`${this.endpoint}/renegotiate`, {
        sessionDescription: { sdp: answer.sdp, type: 'answer' },
      });

      // Leaving a connection in have-remote-offer costs nothing immediately —
      // the media that was just negotiated flows — but every *later*
      // negotiation on it fails, so a third person joining or a screen share
      // would silently produce nothing. Worth noticing here rather than there.
      if (pc.signalingState !== 'stable') {
        console.warn(`[meet] SFU negotiation left the connection in ${pc.signalingState}`);
      }
    }
  }

  private async unsubscribeParticipant(participantId: string): Promise<void> {
    const theirs = [...this.subscriptions.entries()]
      .filter(([, sub]) => sub.participantId === participantId);
    if (!theirs.length) {
      this.init.events.onRemoteGone(participantId);
      return;
    }
    await apiPut(`${this.endpoint}/close`, {
      tracks: theirs.map(([, sub]) => ({ mid: sub.mid })), force: true,
    }).catch(() => undefined);
    for (const [name, sub] of theirs) {
      this.subscriptions.delete(name);
      this.midMap.delete(sub.mid);
    }
    this.remote.delete(participantId);
    this.init.events.onRemoteGone(participantId);
  }

  /* ---------------- incoming media ---------------- */

  private onTrack(event: RTCTrackEvent): void {
    const mid = event.transceiver.mid;
    const binding = mid ? this.midMap.get(mid) : undefined;
    // Every remote track arrives on a transceiver we asked for by mid, so an
    // unbound one means a track we did not request — ignored rather than
    // guessed at.
    if (!binding) return;

    const { participantId, kind } = binding;
    let entry = this.remote.get(participantId);
    if (!entry) {
      entry = {
        camera: new MediaStream(), screen: new MediaStream(),
        hasVideo: false, hasAudio: false,
      };
      this.remote.set(participantId, entry);
    }

    const target = kind === 'screen' || kind === 'screenaudio' ? entry.screen : entry.camera;
    if (!target.getTracks().includes(event.track)) target.addTrack(event.track);
    if (kind === 'cam') entry.hasVideo = true;
    if (kind === 'mic') entry.hasAudio = true;

    event.track.onended = () => {
      target.removeTrack(event.track);
      if (kind === 'cam') entry!.hasVideo = false;
      if (kind === 'mic') entry!.hasAudio = false;
      this.emit(participantId);
    };

    this.emit(participantId);
  }

  private emit(participantId: string): void {
    const entry = this.remote.get(participantId);
    if (!entry) return;
    this.init.events.onRemoteMedia({
      participantId,
      stream: entry.camera.getTracks().length ? entry.camera : null,
      screenStream: entry.screen.getVideoTracks().length ? entry.screen : null,
      audioStream: entry.camera.getAudioTracks().length ? entry.camera : null,
      isScreenShare: entry.screen.getVideoTracks().length > 0,
      hasVideo: entry.hasVideo,
      hasAudio: entry.hasAudio,
    });
  }

  /* ---------------- adaptation ---------------- */

  async setPublishQuality(quality: VideoQuality): Promise<void> {
    if (this.publishQuality === quality) return;
    this.publishQuality = quality;
    await this.applyEncodings();
  }

  /**
   * Cap the uplink.
   *
   * On an SFU this is a *ceiling*, not a choice: the simulcast rungs stay
   * published and each subscriber still receives the one their tile needs. All
   * this does is stop the top rung being produced at all, which is what a poor
   * connection or the data saver actually wants.
   */
  private async applyEncodings(): Promise<void> {
    if (this.camSender) {
      const params = this.camSender.getParameters();
      if (params.encodings?.length) {
        const ceiling = this.publishQuality === 'high' ? 3
          : this.publishQuality === 'medium' ? 2
          : this.publishQuality === 'low' ? 1 : 0;
        params.encodings.forEach((encoding, index) => {
          // Encodings are ordered lowest rung first, matching SIMULCAST_LAYERS.
          encoding.active = index < ceiling;
          const layer = SIMULCAST_LAYERS[index];
          if (layer) {
            encoding.maxBitrate = layer.maxBitrate;
            encoding.maxFramerate = layer.maxFramerate;
            encoding.scaleResolutionDownBy = layer.scaleDownBy;
          }
        });
        try { await this.camSender.setParameters(params); } catch { /* unsupported */ }
      }
    }

    if (this.micSender) {
      const params = this.micSender.getParameters();
      params.encodings ??= [{}];
      for (const encoding of params.encodings) encoding.maxBitrate = AUDIO_BITRATE;
      try { await this.micSender.setParameters(params); } catch { /* unsupported */ }
    }
  }

  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    let loss = 0;
    let rtt = 0;
    try {
      (await pc.getStats()).forEach((report) => {
        const r = report as RTCStatsReport & {
          type: string; fractionLost?: number; roundTripTime?: number;
        };
        if (r.type === 'remote-inbound-rtp') {
          loss = Math.max(loss, Number(r.fractionLost ?? 0));
          rtt = Math.max(rtt, Number(r.roundTripTime ?? 0) * 1000);
        }
      });
    } catch { /* connection closing */ }

    const { gradeConnection } = await import('./types.js');
    this.init.events.onQuality({
      quality: gradeConnection(loss, rtt), packetLoss: loss, rttMs: Math.round(rtt),
    });
  }
}

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err));

function authHeader(): Record<string, string> {
  const token = localStorage.getItem('tupo_token') ?? localStorage.getItem('tupo_meet_guest');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
