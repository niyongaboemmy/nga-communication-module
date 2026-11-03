import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, PhoneOff, Video } from 'lucide-react';
import { onSocket } from '../lib/socket';
import { playSound } from '../lib/sounds';
import { isDoNotDisturb } from '../lib/myStatus';
import { useMeetCall } from '../context/MeetCallContext';
import { useNotify } from '../context/NotificationContext';
import { Avatar } from './ui';

interface Ring {
  conversationId: string; meetingId: string; title: string;
  callerId: string; callerName: string; audioOnly: boolean; at: string;
}

/** How long a call rings before it counts as missed. */
const RING_MS = 30_000;

/**
 * The incoming-call screen (N-05). A call started in a conversation used to
 * be a card in the log that nobody noticed; now it rings for 30 s, wherever
 * the person is in Tupo, with Accept and Decline. Unanswered, it becomes a
 * "Missed call" notice with a way back to the conversation. Silent (no ring,
 * no screen, just the notice) under Do not disturb or when already in a call.
 */
export const IncomingCall: React.FC = () => {
  const navigate = useNavigate();
  const { call } = useMeetCall();
  const { notify } = useNotify();
  const [ring, setRing] = useState<Ring | null>(null);
  const inCallRef = useRef(Boolean(call));
  inCallRef.current = Boolean(call);

  const missed = (r: Ring) => notify({
    title: `Missed ${r.audioOnly ? 'call' : 'video call'} from ${r.callerName}`,
    tone: 'warning', durationMs: 0, key: `missed-${r.meetingId}`,
    action: { label: 'Open the conversation', onClick: () => navigate(`/app/chat?c=${r.conversationId}`) },
  });

  useEffect(() => onSocket('call:ring', (r) => {
    // A ring that took long to arrive (a reconnect replay) is not a call any more.
    if (Date.now() - Date.parse(r.at) > RING_MS) return;
    if (isDoNotDisturb() || inCallRef.current) { missed(r); return; }
    setRing(r);
    // Tab in the background: the system notification is what reaches them.
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(`${r.callerName} is calling`, { body: r.title, tag: `call-${r.meetingId}`, requireInteraction: true }); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Ring until answered, declined or timed out.
  useEffect(() => {
    if (!ring) return;
    playSound('ring');
    const again = window.setInterval(() => playSound('ring'), 2_500);
    navigator.vibrate?.([400, 200, 400]);
    const timeout = window.setTimeout(() => { setRing(null); missed(ring); }, Math.max(0, RING_MS - (Date.now() - Date.parse(ring.at))));
    return () => { window.clearInterval(again); window.clearTimeout(timeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring]);

  if (!ring) return null;
  const accept = () => { const r = ring; setRing(null); navigate(`/app/meet/${r.meetingId}`); };
  const decline = () => setRing(null);

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="incoming-call-title" aria-describedby="incoming-call-kind"
      className="fixed inset-0 z-[120] grid place-items-center bg-slate-950/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-xs rounded-3xl bg-slate-900 p-6 text-center text-white shadow-2xl">
        <div className="mx-auto mb-3 w-fit animate-pulse rounded-full ring-4 ring-emerald-400/40">
          <Avatar name={ring.callerName} size={72} />
        </div>
        <h2 id="incoming-call-title" className="text-lg font-semibold">{ring.callerName}</h2>
        <p id="incoming-call-kind" className="mt-1 text-sm text-white/70">
          {ring.audioOnly ? 'Voice call' : 'Video call'} · {ring.title}
        </p>
        <div className="mt-6 flex justify-center gap-10">
          <button onClick={decline} aria-label="Decline"
            className="grid h-14 w-14 place-items-center rounded-full bg-red-600 hover:bg-red-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-300">
            <PhoneOff size={24} />
          </button>
          <button onClick={accept} aria-label="Accept" autoFocus
            className="grid h-14 w-14 place-items-center rounded-full bg-emerald-600 hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300">
            {ring.audioOnly ? <Phone size={24} /> : <Video size={24} />}
          </button>
        </div>
      </div>
    </div>
  );
};
