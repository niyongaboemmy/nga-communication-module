import { apiDelete, apiGet, apiPost } from './api';

/**
 * Web push on this device (F-04). The server pushes only while the person has
 * no open Tupo tab, so turning this on never doubles what the app shows.
 */

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const supported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

/** The VAPID key as the bytes PushManager wants. */
function keyBytes(base64url: string): ArrayBuffer {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

let configCache: { enabled: boolean; publicKey: string | null } | null = null;
async function config() {
  configCache ??= await apiGet<{ enabled: boolean; publicKey: string | null }>('/api/push/config')
    .then((r) => r.data!).catch(() => ({ enabled: false, publicKey: null }));
  return configCache;
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (!(await config()).enabled) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush(): Promise<PushState> {
  const cfg = await config();
  if (!supported()) return 'unsupported';
  if (!cfg.enabled || !cfg.publicKey) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.publicKey) });
  await apiPost('/api/push/subscriptions', { subscription: sub.toJSON() });
  return 'on';
}

/** Off on this device — and forget it on the server. */
export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (sub) {
    await apiDelete('/api/push/subscriptions', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return supported() ? 'off' : 'unsupported';
}
