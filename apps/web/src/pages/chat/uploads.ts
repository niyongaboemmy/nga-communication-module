import { SESSION_KEY } from '../../lib/api';
import type { WireAttachment } from '@tupo/shared';

/**
 * Uploading an attachment, from the browser's side.
 *
 * Three steps, matching the service (SRS §11.1): ask for a ticket, send the
 * bytes, then hand back the file id for the message to reference. The bytes go
 * up with `XMLHttpRequest` rather than `fetch` — not for nostalgia, but because
 * `fetch` still has no upload-progress event, and a 40 MB video with no progress
 * bar is indistinguishable from a frozen tab on a school connection.
 */

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0–1. Reaches 1 when the bytes are sent, before the server confirms. */
  fraction: number;
}

export interface PendingUpload {
  /** Local id, valid only until the upload finishes. */
  localId: string;
  file: File;
  name: string;
  size: number;
  mime: string;
  kind: WireAttachment['kind'];
  /** Object URL for an image/video preview; revoked when the upload is cleared. */
  previewUrl?: string;
  progress: number;
  state: 'pending' | 'uploading' | 'ready' | 'failed' | 'cancelled';
  fileId?: string;
  error?: string;
  cancel?: () => void;
  /** Media facts computed while previewing, sent up as metadata. */
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
}

/** Matches the server's classifier, so the two never disagree about a file. */
export function attachmentKind(mime: string): WireAttachment['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/^(application\/pdf|application\/msword|application\/vnd|text\/)/.test(mime)) return 'document';
  return 'other';
}

/** Kept in step with MAX_FILE_SIZE_BYTES in apps/files/.env. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Types refused outright.
 *
 * Not an antivirus — that is the worker's job in production. This is the much
 * narrower rule that an executable has no business being passed around a school
 * chat, and refusing it at the point of choosing is kinder than refusing it
 * after a five-minute upload.
 */
const BLOCKED_EXTENSIONS = /\.(exe|msi|bat|cmd|com|scr|pif|vbs|js|jar|app|dmg|deb|rpm|sh|ps1)$/i;

export function validateFile(file: File): string | null {
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `“${file.name}” is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024)} GB.`;
  }
  if (BLOCKED_EXTENSIONS.test(file.name)) {
    return `“${file.name}” is a program. Those cannot be shared here.`;
  }
  return null;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(body.message ?? `Request failed (${res.status})`);
  }
  return body.data as T;
}

const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem(SESSION_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/**
 * Read what the browser already knows about a media file.
 *
 * It has to decode the file to show a preview anyway, so the dimensions and
 * duration are free at this point. Sending them up means the message can
 * reserve the right box before the image loads, which is what stops a chat log
 * jumping around as pictures arrive.
 */
export async function probeMedia(file: File): Promise<Partial<PendingUpload>> {
  const kind = attachmentKind(file.type);
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return {};

  const url = URL.createObjectURL(file);
  try {
    if (kind === 'image') {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
        img.src = url;
      });
      return { width: img.naturalWidth, height: img.naturalHeight, previewUrl: url };
    }

    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error('decode failed'));
      el.src = url;
    });
    return {
      durationMs: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : undefined,
      width: kind === 'video' ? (el as HTMLVideoElement).videoWidth : undefined,
      height: kind === 'video' ? (el as HTMLVideoElement).videoHeight : undefined,
      previewUrl: kind === 'video' ? url : undefined,
    };
  } catch {
    // An undecodable file still uploads; it just gets no preview.
    URL.revokeObjectURL(url);
    return {};
  }
}

export interface UploadHandle {
  promise: Promise<string>;
  cancel: () => void;
}

/**
 * Upload one file, reporting progress and cancellable.
 *
 * Cancellation aborts the request rather than merely ignoring it. On a phone
 * tether, "cancel" that leaves 40 MB still climbing the wire is not a cancel.
 */
export function uploadFile(
  file: File,
  onProgress: (p: UploadProgress) => void,
  meta: Partial<PendingUpload> = {},
): UploadHandle {
  let xhr: XMLHttpRequest | null = null;
  let cancelled = false;

  const promise = (async () => {
    const ticket = await fetch('/api/files/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }),
    }).then(json<{ fileId: string; uploadUrl: string }>);

    if (cancelled) throw new Error('cancelled');

    await new Promise<void>((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('PUT', ticket.uploadUrl, true);
      const headers = authHeaders();
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        onProgress({ loaded: e.loaded, total: e.total, fraction: e.loaded / e.total });
      };
      xhr.onload = () => {
        if (xhr!.status >= 200 && xhr!.status < 300) resolve();
        else {
          let message = `Upload failed (${xhr!.status})`;
          try { message = JSON.parse(xhr!.responseText).message ?? message; } catch { /* keep default */ }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('The connection dropped during upload.'));
      xhr.onabort = () => reject(new Error('cancelled'));
      xhr.send(file);
    });

    // Presentation metadata, best-effort. A missing width costs a reflow, not
    // an attachment, so it must never fail the upload.
    const presentation = {
      width: meta.width, height: meta.height,
      durationMs: meta.durationMs, waveform: meta.waveform,
    };
    if (Object.values(presentation).some((v) => v !== undefined)) {
      await fetch(`/api/files/${ticket.fileId}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(presentation),
      }).catch(() => {});
    }

    return ticket.fileId;
  })();

  return {
    promise,
    cancel: () => { cancelled = true; xhr?.abort(); },
  };
}

/**
 * A URL an `<img>`, `<video>` or `<audio>` can actually load.
 *
 * Those elements cannot send an Authorization header, so the token travels as a
 * 60-second, single-file media ticket instead. The server still runs the full
 * access check on redemption — see the note in apps/files/src/index.ts.
 *
 * Tickets are cached until shortly before they expire, so a scrollback of forty
 * images is forty renders and not forty ticket requests per repaint.
 */
const ticketCache = new Map<string, { token: string; expiresAt: number }>();

export async function inlineUrl(fileId: string): Promise<string> {
  const cached = ticketCache.get(fileId);
  // Renewed with ten seconds to spare, so a ticket cannot expire mid-request.
  if (cached && cached.expiresAt - 10_000 > Date.now()) {
    return `/api/files/${fileId}/content?inline=1&t=${encodeURIComponent(cached.token)}`;
  }

  const { token, expiresIn } = await fetch(`/api/files/${fileId}/ticket`, {
    method: 'POST', headers: authHeaders(),
  }).then(json<{ token: string; expiresIn: number }>);

  ticketCache.set(fileId, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return `/api/files/${fileId}/content?inline=1&t=${encodeURIComponent(token)}`;
}

/**
 * Download a file with the session header attached.
 *
 * A plain `<a href>` cannot carry Authorization, and putting the token in a
 * query string would leak it into browser history and every proxy log between
 * here and the server.
 */
export async function downloadFile(fileId: string, filename: string): Promise<void> {
  const res = await fetch(`/api/files/${fileId}/content`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick — doing it synchronously races the click in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface ConversationFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  messageId: string;
  senderId: string;
  senderName: string;
  createdAt: string;
}

export const listConversationFiles = (conversationId: string, kind?: string) =>
  fetch(
    `/api/files/conversations/${conversationId}${kind ? `?kind=${kind}` : ''}`,
    { headers: authHeaders() },
  ).then(json<{ files: ConversationFile[] }>).then((d) => d.files);
