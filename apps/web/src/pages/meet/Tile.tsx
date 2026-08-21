import React, { useEffect, useRef } from 'react';
import { Hand, MicOff, MonitorUp, Pin, PinOff, Signal, SignalLow, SignalZero } from 'lucide-react';
import type { ConnectionQuality, MeetParticipant } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import type { RemoteMedia } from './transport/types';

/**
 * One participant's tile.
 *
 * The tile is where the downlink saving is actually realised. It reports its
 * own rendered width up to the room, which turns into a simulcast layer choice
 * (SFU) or a decode decision (mesh) — and when it scrolls out of view it stops
 * painting video entirely. A 160px thumbnail served 720p is the single most
 * common way a video call wastes a school's bandwidth.
 */

const QUALITY_ICON: Record<ConnectionQuality, React.ReactNode> = {
  excellent: <Signal size={13} className="text-emerald-400" />,
  good: <Signal size={13} className="text-emerald-400/70" />,
  poor: <SignalLow size={13} className="text-amber-400" />,
  lost: <SignalZero size={13} className="text-red-400" />,
};

export interface TileProps {
  participant: MeetParticipant;
  media?: RemoteMedia;
  /** The local preview, mirrored and always muted. */
  localStream?: MediaStream | null;
  isLocal?: boolean;
  speaking: boolean;
  pinned: boolean;
  spotlighted: boolean;
  /** False when this tile is past the video cap — avatar and audio only. */
  videoAllowed: boolean;
  /** Show this participant's shared screen rather than their camera. */
  showScreen?: boolean;
  onPin?: (participantId: string) => void;
  onVisible?: (participantId: string, width: number) => void;
  compact?: boolean;
}

export const Tile: React.FC<TileProps> = ({
  participant,
  media,
  localStream,
  isLocal = false,
  speaking,
  pinned,
  spotlighted,
  videoAllowed,
  showScreen = false,
  onPin,
  onVisible,
  compact = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // A screen share is never subject to the video cap or the camera toggle:
  // it is the reason the meeting is happening.
  const screenStream = media?.screenStream ?? null;
  const presenting = showScreen && !!screenStream;

  const stream = presenting ? screenStream : isLocal ? (localStream ?? null) : (media?.stream ?? null);

  const showVideo =
    presenting ||
    (videoAllowed &&
      !!stream &&
      (isLocal ? participant.videoEnabled : media?.hasVideo !== false) &&
      participant.videoEnabled);

  /* Attach media. Setting srcObject to null when the tile should not show
   * video is what actually frees the decoder — hiding the element with CSS
   * would keep decoding every frame. */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = showVideo ? stream : null;
    if (showVideo && stream) {
      // Autoplay can reject when the tab has no gesture yet; there is nothing
      // useful to tell the user, and the next interaction fixes it.
      void el.play().catch(() => {});
    }
  }, [stream, showVideo]);

  /* Report size and visibility upward. Both observers are needed: resize
   * catches a layout change, intersection catches a scroll. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onVisible || isLocal) return;

    let visible = true;
    const report = () => {
      onVisible(participant.id, visible ? el.getBoundingClientRect().width : 0);
    };

    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(el);

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting;
        report();
      },
      { threshold: 0.1 },
    );
    intersectionObserver.observe(el);

    report();
    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      // Tell the room this tile is gone, so its subscription can be dropped.
      onVisible(participant.id, 0);
    };
  }, [participant.id, onVisible, isLocal]);

  return (
    <div
      ref={containerRef}
      className={
        // h-full matters: in the speaker, sidebar and spotlight layouts the
        // tile sits in a flex-1 box, and without an explicit height it sizes to
        // its content and leaves the stage half empty. The grid layout's
        // auto-rows-fr already gives it a row height, which is why this only
        // shows up once you switch layouts.
        'group animate-tile-in relative h-full w-full overflow-hidden rounded-2xl bg-slate-900 ' +
        'ring-1 transition-[outline,transform] duration-200 ' +
        (spotlighted
          ? 'ring-2 ring-blue-500'
          : // The speaking ring pulses slowly and softly. A fast, high-contrast
            // pulse on the active speaker is the most distracting thing a video
            // UI can do — it draws the eye away from the face it is framing.
            speaking
            ? 'animate-speaking-ring ring-2 ring-emerald-400'
            : 'ring-white/10')
      }
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          // Mirrored only for your own camera — mirroring a shared screen or
          // someone else's face is disorienting rather than natural.
          className={
            // A shared screen is letterboxed, never cropped — cropping a slide
            // removes exactly the part being pointed at.
            `h-full w-full ${presenting ? 'bg-black object-contain' : 'object-cover'} ` +
            (isLocal && !presenting ? 'scale-x-[-1]' : '')
          }
        />
      ) : (
        <div className="grid h-full w-full place-items-center bg-gradient-to-br from-slate-800 to-slate-900">
          <Avatar name={participant.name} src={participant.avatarUrl ?? undefined} size={compact ? 40 : 72} />
        </div>
      )}

      {/* No <audio> here on purpose. Playback lives in MeetAudioSink, which
 outlives this route — see components/meet/MeetAudioSink.tsx. */}

      {/* Name and state. A single bottom strip rather than scattered badges —
 at thumbnail size, scattered badges become noise. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
        {!participant.audioEnabled && <MicOff size={13} className="shrink-0 text-red-400" />}
        {participant.screenSharing && <MonitorUp size={13} className="shrink-0 text-blue-400" />}
        {participant.handRaised && <Hand size={13} className="animate-hand-raise shrink-0 text-amber-400" />}
        <span className="truncate text-xs font-medium text-white">
          {participant.name}
          {isLocal ? ' (you)' : ''}
        </span>
        {(participant.role === 'host' || participant.role === 'cohost') && (
          <span className="shrink-0 rounded bg-white/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-white/80">
            {participant.role === 'host' ? 'Host' : 'Co-host'}
          </span>
        )}
        <span className="ml-auto shrink-0">{QUALITY_ICON[participant.connectionQuality]}</span>
      </div>

      {/* Shown only when this tile is deliberately not carrying video, so the
 absence reads as a decision rather than a fault. */}
      {!videoAllowed && participant.videoEnabled && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/50 px-1.5 py-0.5 text-[9px] font-medium text-white/70">
          Video paused to save data
        </div>
      )}

      {onPin && !compact && (
        <button
          onClick={() => onPin(participant.id)}
          aria-label={pinned ? `Unpin ${participant.name}` : `Pin ${participant.name}`}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/50 text-white opacity-0 transition-opacity duration-150 hover:bg-black/70 focus-visible:opacity-100 group-hover:opacity-100"
        >
          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      )}
    </div>
  );
};
