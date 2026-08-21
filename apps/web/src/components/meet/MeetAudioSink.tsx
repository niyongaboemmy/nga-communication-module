import React, { useEffect, useRef } from 'react';
import { useMeetCall } from '../../context/MeetCallContext';

/**
 * Every remote participant's audio, in one place that outlives the route.
 *
 * Audio used to be played by each `Tile`, which is correct right up until the
 * moment someone navigates away: the tiles unmount, and the call goes silent
 * while still showing as connected in the mini window. Being unable to hear a
 * meeting you are still in is a worse failure than not seeing it.
 *
 * So playback lives here, mounted by the provider alongside the call itself.
 * Video stays with the tiles — a video element that nothing displays is wasted
 * decode — but audio is attached exactly once, for as long as the call lasts.
 *
 * Renders nothing visible.
 */
export const MeetAudioSink: React.FC = () => {
  const { call, room } = useMeetCall();
  const containerRef = useRef<HTMLDivElement>(null);
  /** participantId → the element playing it, so streams are not re-attached. */
  const elements = useRef(new Map<string, HTMLAudioElement>()).current;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !room) return;

    const wanted = new Set<string>();

    for (const [participantId, media] of room.media) {
      // Never play your own microphone back at yourself.
      if (participantId === room.you?.id) continue;
      const stream = media.audioStream;
      if (!stream) continue;
      wanted.add(participantId);

      let el = elements.get(participantId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        // Playing inline matters on iOS, where audio otherwise tries to take
        // over the screen with a native player.
        el.setAttribute('playsinline', '');
        container.appendChild(el);
        elements.set(participantId, el);
      }
      if (el.srcObject !== stream) {
        el.srcObject = stream;
        // Autoplay can be refused until the page has a gesture. Joining a
        // meeting is itself a gesture, so this normally succeeds; when it does
        // not, the next click on any control resolves it.
        void el.play().catch(() => {});
      }
    }

    // Anyone who left takes their element with them.
    for (const [participantId, el] of elements) {
      if (wanted.has(participantId)) continue;
      el.srcObject = null;
      el.remove();
      elements.delete(participantId);
    }
  }, [room, room?.media, elements]);

  // Apply the speaker the user chose in the pre-join screen. Chromium-only;
  // elsewhere output follows the system default and there is nothing to do.
  useEffect(() => {
    const deviceId = call?.speakerId;
    if (!deviceId) return;
    for (const el of elements.values()) {
      const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof withSink.setSinkId === 'function') {
        void withSink.setSinkId(deviceId).catch(() => {});
      }
    }
  }, [call?.speakerId, room?.media, elements]);

  // Tear everything down when the call ends, not when this component happens
  // to re-render.
  useEffect(() => {
    if (call) return;
    for (const [, el] of elements) {
      el.srcObject = null;
      el.remove();
    }
    elements.clear();
  }, [call, elements]);

  return <div ref={containerRef} aria-hidden="true" className="hidden" />;
};
