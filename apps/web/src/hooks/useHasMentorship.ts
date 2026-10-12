import { useEffect, useState } from 'react';
import { getMentorship } from '../pages/chat/api';

/**
 * Whether the signed-in person has a mentor or mentees in NGA MIS — what reveals
 * the Mentorship entry in the rail. Remembered for a few minutes in this tab so
 * every navigation does not ask MIS again.
 */
const KEY = 'tupo.hasMentorship';
const TTL_MS = 5 * 60_000;

export function useHasMentorship(userId: string | undefined): boolean {
  const [has, setHas] = useState<boolean>(() => {
    try {
      const raw = sessionStorage.getItem(KEY);
      const saved = raw ? (JSON.parse(raw) as { userId: string; at: number; has: boolean }) : null;
      return !!saved && saved.userId === userId && Date.now() - saved.at < TTL_MS && saved.has;
    } catch { return false; }
  });

  useEffect(() => {
    if (!userId) return;
    try {
      const raw = sessionStorage.getItem(KEY);
      const saved = raw ? (JSON.parse(raw) as { userId: string; at: number; has: boolean }) : null;
      if (saved && saved.userId === userId && Date.now() - saved.at < TTL_MS) { setHas(saved.has); return; }
    } catch { /* storage blocked: ask */ }
    let cancelled = false;
    getMentorship()
      .then((m) => {
        const value = !!m.mentor || m.mentees.length > 0;
        if (!cancelled) setHas(value);
        try { sessionStorage.setItem(KEY, JSON.stringify({ userId, at: Date.now(), has: value })); } catch { /* ignore */ }
      })
      // MIS unreachable: keep the rail as it is; the page itself explains.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);

  return has;
}
