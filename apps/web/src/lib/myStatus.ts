import { useSyncExternalStore } from 'react';
import type { PresenceChoice, PresenceStatus } from '@tupo/shared';
import { getSocket } from './socket';

/**
 * This person's own status (F-10): what they picked, and what everyone else
 * therefore sees. The gateway works the status out from every tab, meeting
 * and pick, and tells all of this person's devices through `presence:self`;
 * this holds the latest answer for the avatar dot, the status picker and the
 * do-not-disturb check on notifications.
 */

export interface MyStatus { choice: PresenceChoice; status: PresenceStatus }

export const STATUS_CHOICES: ReadonlyArray<{ id: PresenceChoice; label: string; hint: string }> = [
  { id: 'auto', label: 'Automatic', hint: 'Online, or away when idle' },
  { id: 'busy', label: 'Busy', hint: 'Shown as busy everywhere' },
  { id: 'dnd', label: 'Do not disturb', hint: 'No pop-ups or sounds' },
  { id: 'invisible', label: 'Appear offline', hint: 'Others see you as offline' },
];

let current: MyStatus = { choice: 'auto', status: 'online' };
const listeners = new Set<() => void>();

export function setMyStatus(next: MyStatus): void {
  if (next.choice === current.choice && next.status === current.status) return;
  current = next;
  for (const l of listeners) l();
}

export const getMyStatus = (): MyStatus => current;
export const isDoNotDisturb = (): boolean => current.choice === 'dnd';

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function useMyStatus(): MyStatus {
  return useSyncExternalStore(subscribe, getMyStatus);
}

/** What others will see straight after a pick, before the gateway confirms it. */
function expected(choice: PresenceChoice, now: PresenceStatus): PresenceStatus {
  if (choice === 'invisible') return 'offline';
  if (choice === 'dnd') return 'dnd';
  if (now === 'in-a-meeting') return now;
  if (choice === 'busy') return 'busy';
  return now === 'away' ? 'away' : 'online';
}

/** Pick a status for every device. Shown at once; the gateway's answer settles it. */
export function chooseStatus(choice: PresenceChoice): Promise<boolean> {
  const before = current;
  setMyStatus({ choice, status: expected(choice, before.status === 'offline' ? 'online' : before.status) });
  const socket = getSocket();
  if (!socket?.connected) { setMyStatus(before); return Promise.resolve(false); }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { setMyStatus(before); resolve(false); }, 5000);
    socket.emit('presence:choose', { choice }, (r) => {
      clearTimeout(timer);
      if (r?.ok) setMyStatus({ choice: r.choice, status: r.status });
      resolve(Boolean(r?.ok));
    });
  });
}
