import type { Socket } from 'socket.io-client';
import { SIMULCAST_LAYERS, AUDIO_BITRATE } from '@tupo/shared';
import type { VideoQuality } from '@tupo/shared';
import type { MediaTransport, TransportInit } from './types.js';
import { gradeConnection } from './types.js';

/**
 * Peer-to-peer mesh transport.
 *
 * The signalling handshake is TaskMentor's proctoring module, renamed: the
 * server relays offer / answer / ice and never touches media. Cloudflare TURN
 * carries the traffic when a network blocks UDP, which is most school networks.
 *
 * Mesh is the right answer for a small call — no server hop, so lower latency
 * and no egress bill — and the wrong answer above a handful of people, because
 * every publisher uploads one copy of its camera *per peer*. The server refuses
 * to place a larger meeting here (`MESH_MAX_PARTICIPANTS`), so this file can
 * assume it is dealing with a few peers, not a hundred.
 */

interface Peer {
  pc: RTCPeerConnection;
  /** Sender for our camera track, so its encoding can be retuned in place. */
  videoSender: RTCRtpSender | null;
  audioSender: RTCRtpSender | null;
  screenSender: RTCRtpSender | null;
  /** ICE that arrived before the remote description; replayed once it lands. */
  pendingCandidates: RTCIceCandidateInit[];
  makingOffer: boolean;
  /** Perfect-negotiation politeness. The peer that joined later yields. */
  polite: boolean;
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
}

const STATS_INTERVAL_MS = 5000;

export class MeshTransport implements MediaTransport {
  readonly kind = 'mesh' as const;

  private readonly peers = new Map<string, Peer>();
  private local: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  /** participantId → the MediaStream id carrying their screen, as announced
   *  over the socket. Without this the receiver has to guess camera from
   *  screen by track order, which is wrong the moment anyone toggles a camera. */
  private readonly screenStreamIds = new Map<string, string>();
  private publishQuality: VideoQuality = 'high';
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly init: TransportInit,
  ) {}

  /* ---------------- lifecycle ---------------- */

  async connect(local: MediaStream | null): Promise<void> {
    this.local = local;
    this.bindSignalling();
    this.statsTimer = setInterval(() => void this.sampleStats(), STATS_INTERVAL_MS);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    for (const [id, peer] of this.peers) {
      peer.pc.close();
      this.init.events.onRemoteGone(id);
    }
    this.peers.clear();
    this.unbindSignalling();
  }

  /* ---------------- signalling ---------------- */

  // Kept so unbind can remove exactly the listeners this transport added —
  // removeAllListeners would also strip the room hook's own handlers.
  private readonly handlers: Array<[string, (payload: never) => void]> = [];

  private on<T>(event: string, handler: (payload: T) => void): void {
    this.socket.on(event, handler as (...args: unknown[]) => void);
    this.handlers.push([event, handler as (payload: never) => void]);
  }

  /** One place that shapes what the room sees, so every path agrees. */
  private emitMedia(participantId: string, peer: Peer): void {
    const live = (s: MediaStream | null, kind: 'video' | 'audio') =>
      !!s && (kind === 'video' ? s.getVideoTracks() : s.getAudioTracks())
        .some((t) => t.readyState === 'live');

    this.init.events.onRemoteMedia({
      participantId,
      stream: peer.cameraStream,
      screenStream: peer.screenStream,
      audioStream: peer.cameraStream,
      isScreenShare: !!peer.screenStream,
      hasVideo: live(peer.cameraStream, 'video'),
      hasAudio: live(peer.cameraStream, 'audio'),
    });
  }

  /** Told by the room which stream id carries whose screen. */
  setScreenStreamId(participantId: string, streamId: string | null): void {
    if (streamId) this.screenStreamIds.set(participantId, streamId);
    else this.screenStreamIds.delete(participantId);

    const peer = this.peers.get(participantId);
    if (!peer) return;
    if (!streamId && peer.screenStream) {
      peer.screenStream = null;
      this.emitMedia(participantId, peer);
      return;
    }
    // The announcement can arrive after the track. Re-bind if it did.
    if (streamId && peer.cameraStream?.id === streamId) {
      peer.screenStream = peer.cameraStream;
      peer.cameraStream = null;
      this.emitMedia(participantId, peer);
    }
  }

  /**
   * Which end yields when both offer at once.
   *
   * Derived by comparing participant ids, so the two ends *always* reach
   * opposite conclusions, whichever of them created its connection first.
   * Deciding it from who-joined-when — the obvious approach — gets it wrong the
   * moment both sides negotiate simultaneously, which is exactly the case the
   * role exists to resolve.
   */
  private politeWith(participantId: string): boolean {
    return this.init.participantId > participantId;
  }

  private bindSignalling(): void {
    this.on('meet:mesh:peer_joined', (p: { participantId: string; shouldOffer: boolean }) => {
      if (!p.participantId || p.participantId === this.init.participantId) return;
      // Creating the connection adds our tracks, which fires negotiationneeded,
      // which offers. Offering explicitly here as well produced two offers from
      // one side and a guaranteed collision.
      void this.ensurePeer(p.participantId);
    });

    this.on('meet:mesh:peer_left', (p: { participantId: string }) => {
      this.dropPeer(p.participantId);
    });

    this.on('meet:mesh:offer', async (p: { from: string; sdp: string }) => {
      const peer = await this.ensurePeer(p.from);
      try {
        // Perfect negotiation, per the WebRTC spec. A collision is both ends
        // offering at once — which renegotiation makes routine, since adding a
        // screen track on one side fires negotiationneeded exactly as the other
        // side toggles a camera.
        //
        // The impolite end ignores the incoming offer and keeps its own; the
        // polite end accepts, and setRemoteDescription rolls its own offer back
        // implicitly. Rolling back by hand is what produced "Called in wrong
        // state": the signalling state could move across the await in between.
        const collision = peer.makingOffer || peer.pc.signalingState !== 'stable';
        if (collision && !peer.polite) return;

        await peer.pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
        await this.flushCandidates(peer);
        // Argument-less: the browser creates the answer and applies it as one
        // step, so nothing can change state in between.
        await peer.pc.setLocalDescription();
        const answer = peer.pc.localDescription;
        if (answer) this.socket.emit('meet:mesh:answer', { to: p.from, sdp: answer.sdp });
      } catch (err) {
        console.warn(`[mesh] could not answer ${p.from}: ${describe(err)}`);
      }
    });

    this.on('meet:mesh:answer', async (p: { from: string; sdp: string }) => {
      const peer = this.peers.get(p.from);
      if (!peer) return;
      // An answer to an offer we rolled back arrives while we are stable again.
      // It is stale, not broken.
      if (peer.pc.signalingState !== 'have-local-offer') return;
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
        await this.flushCandidates(peer);
      } catch (err) {
        console.warn(`[mesh] stale answer from ${p.from}: ${describe(err)}`);
      }
    });

    this.on('meet:mesh:ice', async (p: { from: string; candidate: RTCIceCandidateInit }) => {
      const peer = this.peers.get(p.from);
      if (!peer || !p.candidate) return;
      // A candidate that arrives before the remote description cannot be added
      // yet — queue it rather than dropping it, or the connection stalls on a
      // slow signalling round trip.
      if (!peer.pc.remoteDescription) {
        peer.pendingCandidates.push(p.candidate);
        return;
      }
      try { await peer.pc.addIceCandidate(p.candidate); } catch { /* stale candidate */ }
    });

    this.on('meet:mesh:renegotiate', (p: { from: string }) => {
      const peer = this.peers.get(p.from);
      if (peer) void this.makeOffer(p.from, peer);
    });
  }

  private unbindSignalling(): void {
    for (const [event, handler] of this.handlers) {
      this.socket.off(event, handler as (...args: unknown[]) => void);
    }
    this.handlers.length = 0;
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const queued = peer.pendingCandidates.splice(0);
    for (const c of queued) {
      try { await peer.pc.addIceCandidate(c); } catch { /* stale candidate */ }
    }
  }

  /* ---------------- peers ---------------- */

  private async ensurePeer(participantId: string): Promise<Peer> {
    const existing = this.peers.get(participantId);
    if (existing) return existing;
    const polite = this.politeWith(participantId);

    const pc = new RTCPeerConnection({
      iceServers: this.init.iceServers as RTCIceServer[],
      // 'all' rather than 'relay': direct paths are tried first and TURN is the
      // fallback, so relay bandwidth is only spent when it is actually needed.
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    const peer: Peer = {
      pc, videoSender: null, audioSender: null, screenSender: null,
      pendingCandidates: [], makingOffer: false, polite,
      cameraStream: null, screenStream: null,
    };
    this.peers.set(participantId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('meet:mesh:ice', { to: participantId, candidate: e.candidate.toJSON() });
      }
    };

    pc.ontrack = (e) => {
      const [incoming] = e.streams;
      const announcedScreenId = this.screenStreamIds.get(participantId);

      // Bind by the stream id the sharer announced, not by track order.
      if (incoming && announcedScreenId && incoming.id === announcedScreenId) {
        peer.screenStream = incoming;
      } else if (incoming) {
        peer.cameraStream = incoming;
      } else {
        // No stream on the track (rare, but legal) — fall back to the camera.
        peer.cameraStream ??= new MediaStream();
        peer.cameraStream.addTrack(e.track);
      }

      // A track ending is how a screen share stops: the sharer hits the
      // browser's own "Stop sharing" and we get no socket event first.
      e.track.onended = () => {
        if (peer.screenStream?.getTracks().every((t) => t.readyState === 'ended')) {
          peer.screenStream = null;
        }
        this.emitMedia(participantId, peer);
      };

      this.emitMedia(participantId, peer);
    };

    pc.onnegotiationneeded = () => { void this.makeOffer(participantId, peer); };

    // Development-only visibility into the handshake. Peer connections fail
    // silently — a muted remote track looks identical whether ICE never
    // connected or the sender simply has their camera off.
    // Development-only introspection. A one-way media failure is invisible from
    // outside — both ends report "connected" — so the negotiated directions and
    // the inbound byte counters are exposed for the acceptance tests and for
    // anyone debugging a call. Stripped from production builds.
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __meshPeers?: Record<string, () => unknown>;
        __meshStats?: Record<string, () => Promise<number>>;
      };
      w.__meshPeers ??= {};
      w.__meshStats ??= {};

      w.__meshStats[participantId] = async () => {
        let bytes = 0;
        (await pc.getStats()).forEach((r) => {
          const report = r as { type: string; kind?: string; bytesReceived?: number };
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            bytes += Number(report.bytesReceived ?? 0);
          }
        });
        return bytes;
      };

      w.__meshPeers[participantId] = () => ({
        connection: pc.connectionState,
        transceivers: pc.getTransceivers().map((t) => ({
          mid: t.mid,
          kind: t.receiver.track?.kind ?? t.sender.track?.kind ?? '?',
          direction: t.direction,
          current: t.currentDirection,
        })),
      });
    }

    pc.onconnectionstatechange = () => {
      if (!import.meta.env.DEV) return;
      const w = window as unknown as { __meshState?: Record<string, string> };
      w.__meshState ??= {};
      w.__meshState[participantId] =
        `${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState}`;
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'failed') {
        // An ICE restart is far cheaper than tearing the peer down and
        // renegotiating from nothing, and it is invisible to the participant
        // list — which is the requirement in SRS §10.3.
        pc.restartIce();
      } else if (state === 'closed') {
        this.dropPeer(participantId);
      }
    };

    if (this.local) {
      for (const track of this.local.getTracks()) {
        const sender = pc.addTrack(track, this.local);
        if (track.kind === 'video') peer.videoSender = sender;
        else peer.audioSender = sender;
      }
      await this.applyEncodings(peer);
    }
    if (this.screen) {
      const [videoTrack] = this.screen.getVideoTracks();
      if (videoTrack) peer.screenSender = pc.addTrack(videoTrack, this.screen);
    }

    // With no local media there is nothing to add and negotiationneeded never
    // fires, so a listen-only participant would never connect at all.
    if (!this.local && !this.screen) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }

    return peer;
  }

  private dropPeer(participantId: string): void {
    const peer = this.peers.get(participantId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(participantId);
    this.init.events.onRemoteGone(participantId);
  }

  private async makeOffer(participantId: string, peer: Peer): Promise<void> {
    if (this.closed) return;
    try {
      peer.makingOffer = true;
      // Argument-less setLocalDescription creates the offer and applies it in
      // one step. Calling createOffer and setLocalDescription separately leaves
      // an await between them, and a remote offer arriving in that window puts
      // the connection in have-remote-offer — which is exactly the state the
      // second call then rejects.
      await peer.pc.setLocalDescription();
      const offer = peer.pc.localDescription;
      if (offer) this.socket.emit('meet:mesh:offer', { to: participantId, sdp: offer.sdp });
    } catch (err) {
      // A negotiation that lost a race is retried by the next
      // negotiationneeded, so this is not worth putting in front of the user.
      if (peer.pc.signalingState !== 'closed') {
        console.warn(`[mesh] offer to ${participantId} deferred: ${describe(err)}`);
      }
    } finally {
      peer.makingOffer = false;
    }
  }

  /* ---------------- publishing ---------------- */

  async publish(stream: MediaStream | null): Promise<void> {
    this.local = stream;
    const video = stream?.getVideoTracks()[0] ?? null;
    const audio = stream?.getAudioTracks()[0] ?? null;

    for (const [id, peer] of this.peers) {
      try {
        // replaceTrack swaps the source without renegotiating, which is what
        // makes changing camera mid-call instant rather than a visible reconnect.
        if (peer.videoSender) await peer.videoSender.replaceTrack(video);
        else if (video && this.local) peer.videoSender = peer.pc.addTrack(video, this.local);

        if (peer.audioSender) await peer.audioSender.replaceTrack(audio);
        else if (audio && this.local) peer.audioSender = peer.pc.addTrack(audio, this.local);

        await this.applyEncodings(peer);
      } catch (err) {
        this.init.events.onError(`Could not republish to ${id}: ${describe(err)}`);
      }
    }
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    // Disabling the track rather than removing it keeps the transceiver in
    // place, so unmuting does not cost a renegotiation round trip.
    for (const track of this.local?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    for (const track of this.local?.getVideoTracks() ?? []) track.enabled = enabled;
  }

  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    // One sender per peer on the mesh, so every peer has to be told.
    await Promise.all([...this.peers.values()].map(async (peer) => {
      const sender = peer.pc.getSenders()
        .find((s) => s.track?.kind === 'video' && s !== peer.screenSender);
      if (sender) await sender.replaceTrack(track).catch(() => {});
    }));
  }

  async startScreenShare(stream: MediaStream): Promise<string | null> {
    this.screen = stream;
    const [track] = stream.getVideoTracks();
    if (!track) return null;
    for (const [id, peer] of this.peers) {
      try {
        // Added on its own MediaStream so the receiver can identify it by id.
        // addTrack fires `negotiationneeded`, and this side then offers — the
        // side that added the track must be the one that offers, so the new
        // screen m-section is in the offer. Asking the *peer* to renegotiate
        // instead (as this used to) made both ends offer at once: on that
        // collision the polite end rolls its own offer back, and if the polite
        // end was the sharer it discarded the very m-section that carries the
        // screen — the share was announced on the socket but no frames ever
        // reached the other side. Half of all shares, split on participant id.
        peer.screenSender = peer.pc.addTrack(track, stream);
      } catch (err) {
        this.init.events.onError(`Could not share to ${id}: ${describe(err)}`);
      }
    }
    return stream.id;
  }

  async stopScreenShare(): Promise<void> {
    for (const track of this.screen?.getTracks() ?? []) track.stop();
    this.screen = null;
    for (const peer of this.peers.values()) {
      if (!peer.screenSender) continue;
      try { peer.pc.removeTrack(peer.screenSender); } catch { /* already gone */ }
      peer.screenSender = null;
    }
  }

  /* ---------------- adaptation ---------------- */

  async setPublishQuality(quality: VideoQuality): Promise<void> {
    if (this.publishQuality === quality) return;
    this.publishQuality = quality;
    for (const peer of this.peers.values()) await this.applyEncodings(peer);
  }

  /**
   * Apply the send-side ladder.
   *
   * Mesh has no SFU to pick a layer per subscriber, so the ceiling applies to
   * everyone — which is exactly why mesh is capped at a few participants. The
   * ladder itself is the same one the SFU uses, so "poor connection" means the
   * same thing on both transports.
   */
  private async applyEncodings(peer: Peer): Promise<void> {
    if (!peer.videoSender) return;
    const params = peer.videoSender.getParameters();
    params.encodings ??= [{}];

    const layer =
      this.publishQuality === 'high' ? SIMULCAST_LAYERS[2] :
      this.publishQuality === 'medium' ? SIMULCAST_LAYERS[1] :
      SIMULCAST_LAYERS[0];

    for (const encoding of params.encodings) {
      if (this.publishQuality === 'off') {
        encoding.active = false;
      } else {
        encoding.active = true;
        encoding.maxBitrate = layer.maxBitrate;
        encoding.maxFramerate = layer.maxFramerate;
        encoding.scaleResolutionDownBy = layer.scaleDownBy;
      }
    }
    try { await peer.videoSender.setParameters(params); } catch { /* unsupported */ }

    if (peer.audioSender) {
      const audioParams = peer.audioSender.getParameters();
      audioParams.encodings ??= [{}];
      for (const e of audioParams.encodings) e.maxBitrate = AUDIO_BITRATE;
      try { await peer.audioSender.setParameters(audioParams); } catch { /* unsupported */ }
    }
  }

  /**
   * On mesh, "unsubscribe" is not available — a peer connection carries what
   * the sender sends. What *is* available is not decoding it: the tile drops
   * its `srcObject`, so the frames arrive but never reach a decoder, and a
   * hidden tile costs no CPU. Nothing to do at the transport layer.
   */
  async setSubscriptions(): Promise<void> { /* handled by the tiles themselves */ }

  /* ---------------- stats ---------------- */

  private async sampleStats(): Promise<void> {
    if (this.closed || this.peers.size === 0) return;
    let worstLoss = 0;
    let worstRtt = 0;

    for (const peer of this.peers.values()) {
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((report) => {
          if (report.type === 'remote-inbound-rtp') {
            const r = report as RTCStatsReport & { fractionLost?: number; roundTripTime?: number };
            worstLoss = Math.max(worstLoss, Number(r.fractionLost ?? 0));
            worstRtt = Math.max(worstRtt, Number(r.roundTripTime ?? 0) * 1000);
          }
        });
      } catch { /* connection closing */ }
    }

    // The verdict is the *worst* peer, not the average: a call is as good as
    // its weakest link, and averaging hides the one person nobody can hear.
    this.init.events.onQuality({
      quality: gradeConnection(worstLoss, worstRtt),
      packetLoss: worstLoss,
      rttMs: Math.round(worstRtt),
    });
  }
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
