import React, { useCallback, useMemo, useRef } from 'react';
import type { MeetLayout, MeetParticipant } from '@tupo/shared';
import { Tile } from './Tile';
import type { RemoteMedia } from './transport/types';
import type { FloatingReaction } from './useMeetRoom';

/**
 * The stage: grid, speaker, sidebar and spotlight layouts (FR-MEET-8).
 *
 * The layouts are not four independent renderers — they are one tile set
 * arranged three ways, so a participant's tile keeps its identity (and its
 * video element, and therefore its decoder) when the layout changes. Remounting
 * the tiles on a layout switch would black every video for a beat.
 */

export interface StageProps {
  layout: MeetLayout;
  participants: MeetParticipant[];
  you: MeetParticipant | null;
  media: Map<string, RemoteMedia>;
  localStream: MediaStream | null;
  videoTileIds: string[];
  speakingIds: string[];
  activeSpeakerId: string | null;
  spotlightId: string | null;
  pinnedId: string | null;
  reactions: FloatingReaction[];
  /** Whoever is sharing a screen. Their share, not their face, fills the stage. */
  presenterId: string | null;
  onPin: (participantId: string | null) => void;
  onVisible: (visible: Array<{ participantId: string; width: number }>) => void;
}

/** Column count that keeps tiles near 16:9 without measuring the container. */
function gridColumns(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count <= 4) return 'grid-cols-1 sm:grid-cols-2';
  if (count <= 9) return 'grid-cols-2 lg:grid-cols-3';
  if (count <= 16) return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4';
  return 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-5';
}

export const Stage: React.FC<StageProps> = ({
  layout, participants, you, media, localStream, videoTileIds, speakingIds,
  activeSpeakerId, spotlightId, pinnedId, reactions, presenterId, onPin, onVisible,
}) => {
  /* Visibility reports are coalesced: a resize storm during a layout change
   * would otherwise fire one subscription update per tile per frame. */
  const visibleRef = useRef(new Map<string, number>());
  const flushRef = useRef<number | null>(null);

  const handleVisible = useCallback((participantId: string, width: number) => {
    visibleRef.current.set(participantId, width);
    if (flushRef.current !== null) return;
    flushRef.current = window.requestAnimationFrame(() => {
      flushRef.current = null;
      onVisible([...visibleRef.current.entries()]
        .filter(([, width]) => width > 0)
        .map(([participantId, width]) => ({ participantId, width })));
    });
  }, [onVisible]);

  const videoAllowed = useMemo(() => new Set(videoTileIds), [videoTileIds]);

  /**
   * Who occupies the main frame in speaker/sidebar/spotlight.
   *
   * Precedence is an explicit choice first (spotlight, then pin), then whoever
   * is sharing a screen — someone presenting is why the meeting is happening —
   * and only then the active speaker.
   */
  const featured = useMemo(() => {
    const byId = (id: string | null) => participants.find((p) => p.id === id);
    return byId(spotlightId)
      ?? byId(pinnedId)
      ?? byId(presenterId)
      ?? participants.find((p) => p.screenSharing)
      ?? byId(activeSpeakerId)
      ?? participants[0]
      ?? null;
  }, [participants, spotlightId, pinnedId, presenterId, activeSpeakerId]);

  const tileFor = (participant: MeetParticipant, compact = false) => (
    <Tile
      key={participant.id}
      participant={participant}
      media={media.get(participant.id)}
      localStream={localStream}
      isLocal={participant.id === you?.id}
      speaking={speakingIds.includes(participant.id)}
      pinned={pinnedId === participant.id}
      spotlighted={spotlightId === participant.id}
      videoAllowed={videoAllowed.has(participant.id) || participant.id === featured?.id}
      // The featured tile shows the share; the filmstrip copy shows the face,
      // so a presenter is still visible while their slides are on the stage.
      showScreen={participant.id === presenterId && !compact}
      onPin={onPin}
      onVisible={handleVisible}
      compact={compact}
    />
  );

  const others = featured
    ? participants.filter((p) => p.id !== featured.id)
    : participants;

  return (
    <div className="relative h-full min-h-0 w-full">
      {participants.length === 0 ? (
        <div className="grid h-full place-items-center text-sm text-white/50">
          Waiting for others to join…
        </div>
      ) : layout === 'grid' ? (
        <div className={`grid h-full auto-rows-fr gap-2 ${gridColumns(participants.length)}`}>
          {participants.map((p) => tileFor(p))}
        </div>
      ) : layout === 'sidebar' ? (
        <div className="flex h-full gap-2">
          <div className="min-w-0 flex-1">{featured && tileFor(featured)}</div>
          {/* Filmstrip. `w-44` rather than a fraction so the strip does not
              squeeze the stage on a laptop screen. */}
          <div className="flex w-44 shrink-0 flex-col gap-2 overflow-y-auto">
            {others.map((p) => (
              <div key={p.id} className="aspect-video shrink-0">{tileFor(p, true)}</div>
            ))}
          </div>
        </div>
      ) : layout === 'spotlight' ? (
        <div className="h-full">{featured && tileFor(featured)}</div>
      ) : (
        /* speaker: one large frame with a horizontal strip beneath */
        <div className="flex h-full flex-col gap-2">
          <div className="min-h-0 flex-1">{featured && tileFor(featured)}</div>
          {others.length > 0 && (
            <div className="flex h-24 shrink-0 gap-2 overflow-x-auto pb-1">
              {others.map((p) => (
                <div key={p.id} className="aspect-video h-full shrink-0">{tileFor(p, true)}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reactions float over everything and are never persisted — a gesture,
          not a record. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex flex-wrap items-end justify-center gap-2">
        {reactions.map((r) => (
          <span
            key={r.key}
            className="animate-reaction flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-white backdrop-blur-sm"
          >
            <span className="text-lg leading-none">{r.reaction}</span>
            <span className="text-xs font-medium">{r.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
};
