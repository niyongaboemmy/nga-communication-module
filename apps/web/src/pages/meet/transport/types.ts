import type { RTCIceServerLike, VideoQuality } from '@tupo/shared';

/**
 * The media transport interface.
 *
 * Everything else in the Meet module — the roster, the lobby, host controls,
 * chat, captions, polls, the AI panel — is written against this and is
 * identical whether the pixels travel peer-to-peer or through an SFU. That is
 * the point: a media server is a heavy thing to put between a developer and
 * every feature in a module, and only two files below this line care which one
 * is in use.
 */

export interface RemoteMedia {
  participantId: string;
  /** The camera. Never the screen — a presenter's face and their slides are
   *  two different things and the UI shows both at once. */
  stream: MediaStream | null;
  /** The shared surface, when this participant is presenting. */
  screenStream: MediaStream | null;
  audioStream: MediaStream | null;
  isScreenShare: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface TransportEvents {
  onRemoteMedia: (media: RemoteMedia) => void;
  onRemoteGone: (participantId: string) => void;
  /** Per-connection health, sampled from getStats(). Drives the ladder. */
  onQuality: (q: { quality: 'excellent' | 'good' | 'poor' | 'lost'; packetLoss: number; rttMs: number }) => void;
  onError: (message: string) => void;
}

export interface TransportInit {
  meetingId: string;
  participantId: string;
  iceServers: RTCIceServerLike[];
  events: TransportEvents;
  /** Cloudflare only — Tupo's own proxy, since the app secret stays server-side. */
  sfuEndpoint?: string;
}

export interface MediaTransport {
  readonly kind: 'mesh' | 'sfu' | 'cloudflare';

  connect(local: MediaStream | null): Promise<void>;
  disconnect(): Promise<void>;

  /** Replace the published camera/mic — used when the device picker changes. */
  publish(stream: MediaStream | null): Promise<void>;
  setMicEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;

  /**
   * Swap the camera track being sent, or send nothing at all.
   *
   * `enabled = false` on a track leaves the *device* open — the capture keeps
   * running and the hardware light stays on, which people reasonably read as
   * "it is still watching me". Releasing the device means stopping the track,
   * and a stopped track cannot be un-stopped: turning the camera back on
   * acquires a new one, which has to be handed to the peer connection.
   *
   * `replaceTrack` does this without renegotiating, so it costs nothing.
   */
  replaceVideoTrack(track: MediaStreamTrack | null): Promise<void>;

  /** Returns the MediaStream id, which mesh peers need to bind the track. */
  startScreenShare(stream: MediaStream): Promise<string | null>;
  stopScreenShare(): Promise<void>;

  /**
   * Cap what this client *sends*. On the SFU this pauses simulcast layers
   * nobody is consuming; on mesh it re-encodes at the requested rung. Either
   * way it is the uplink saving, and it is what a "poor connection" resolves to.
   */
  setPublishQuality(quality: VideoQuality): Promise<void>;

  /**
   * Declare what this client is actually *showing*, and how big.
   *
   * This is the single largest downlink saving in the module: a 160px thumbnail
   * has no use for 720p and an off-screen tile has no use for any video at all.
   * On the SFU it selects a simulcast layer per publisher; on mesh it sets the
   * receiver's preference on the corresponding transceiver.
   */
  setSubscriptions(visible: Array<{ participantId: string; quality: VideoQuality }>): Promise<void>;
}

/**
 * Map a rendered tile's pixel width to the layer that should feed it.
 *
 * Lives in @tupo/shared: the rung ladder is part of the media contract, not a
 * detail of this transport, and it is where it can be tested.
 */
export { qualityForWidth } from '@tupo/shared';

/**
 * Interpret WebRTC stats as a health verdict.
 *
 * The thresholds are deliberately generous at the bottom: on a school
 * connection, 3% loss is an ordinary Tuesday, and a UI that shouts about it
 * every few seconds gets ignored — which means it is also ignored at 15%.
 */
export function gradeConnection(packetLoss: number, rttMs: number):
  'excellent' | 'good' | 'poor' | 'lost' {
  if (packetLoss >= 0.25 || rttMs > 2000) return 'lost';
  if (packetLoss >= 0.08 || rttMs > 500) return 'poor';
  if (packetLoss >= 0.03 || rttMs > 250) return 'good';
  return 'excellent';
}
