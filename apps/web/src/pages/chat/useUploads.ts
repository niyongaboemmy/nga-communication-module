import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attachmentKind, probeMedia, uploadFile, validateFile, MAX_UPLOAD_BYTES,
} from './uploads';
import type { PendingUpload } from './uploads';

/**
 * The composer's upload tray.
 *
 * Files start uploading the moment they are chosen, not when Send is pressed.
 * By the time someone has typed a sentence to go with a photo, the photo is
 * already there — and if they change their mind, cancelling is a click rather
 * than a wait.
 *
 * The message send then references file ids that are already `ready`, which is
 * why the send path never has to deal with a half-uploaded attachment.
 */

export const MAX_ATTACHMENTS = 10;

export interface UploadTray {
  uploads: PendingUpload[];
  /** File ids ready to be attached to a message. */
  readyIds: string[];
  busy: boolean;
  /**
   * Add files to the tray.
   *
   * `meta` carries facts the caller already knows and `probeMedia` cannot
   * recover — a voice note's waveform is computed from the live analyser while
   * recording, and decoding the finished blob again to rebuild it would be both
   * slower and less accurate.
   */
  add: (files: File[] | FileList, meta?: Partial<PendingUpload>) => void;
  remove: (localId: string) => void;
  clear: () => void;
  errors: string[];
  dismissError: (index: number) => void;
}

let counter = 0;
const nextLocalId = () => `u${Date.now().toString(36)}-${counter++}`;

export function useUploads(): UploadTray {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  // Object URLs are a real leak if forgotten: a session of sharing photos
  // pins every one of them in memory until the tab closes.
  const previewUrls = useRef(new Set<string>());
  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
  }, []);

  const patch = useCallback((localId: string, changes: Partial<PendingUpload>) => {
    setUploads((prev) => prev.map((u) => (u.localId === localId ? { ...u, ...changes } : u)));
  }, []);

  /*
   * The tray's current contents, mirrored in a ref.
   *
   * `add` needs to know how many slots are left *before* it decides what to
   * accept, and it must not do that inside a `setUploads` updater. React runs
   * updaters during the render phase, so calling `setErrors` from inside one is
   * a state update during another component's render — unsupported, and in
   * practice silently dropped. That is exactly how a rejected `.exe` produced
   * no message at all.
   */
  const currentRef = useRef<PendingUpload[]>([]);
  useEffect(() => { currentRef.current = uploads; }, [uploads]);

  const add = useCallback((incoming: File[] | FileList, meta: Partial<PendingUpload> = {}) => {
    const files = Array.from(incoming);
    if (!files.length) return;

    const room = MAX_ATTACHMENTS - currentRef.current.length;
    if (room <= 0) {
      setErrors((e) => [...e, `A message can carry ${MAX_ATTACHMENTS} attachments.`]);
      return;
    }

    const accepted: PendingUpload[] = [];
    const rejected: string[] = [];

    for (const file of files.slice(0, room)) {
      const problem = validateFile(file);
      if (problem) { rejected.push(problem); continue; }
      accepted.push({
        localId: nextLocalId(),
        file,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        kind: attachmentKind(file.type),
        progress: 0,
        state: 'pending',
        ...meta,
      });
    }

    if (files.length > room) {
      rejected.push(`Only ${room} more ${room === 1 ? 'file' : 'files'} would fit.`);
    }
    if (rejected.length) setErrors((e) => [...e, ...rejected]);
    if (!accepted.length) return;

    // The ref is advanced immediately so two drops in the same tick cannot both
    // think the tray is empty and together exceed the limit.
    currentRef.current = [...currentRef.current, ...accepted];
    setUploads((prev) => [...prev, ...accepted]);
    for (const upload of accepted) void start(upload);

    async function start(upload: PendingUpload) {
      patch(upload.localId, { state: 'uploading' });

      const probed = await probeMedia(upload.file);
      if (probed.previewUrl) previewUrls.current.add(probed.previewUrl);
      // Caller-supplied metadata wins: it is measured, not inferred.
      const media = {
        ...probed,
        ...(upload.waveform ? { waveform: upload.waveform } : {}),
        ...(upload.durationMs ? { durationMs: upload.durationMs } : {}),
      };
      patch(upload.localId, media);

      const handle = uploadFile(
        upload.file,
        (p) => patch(upload.localId, { progress: p.fraction }),
        media,
      );
      patch(upload.localId, { cancel: handle.cancel });

      try {
        const fileId = await handle.promise;
        patch(upload.localId, { state: 'ready', progress: 1, fileId });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed.';
        if (message === 'cancelled') {
          // A cancelled upload leaves the tray entirely; it is not a failure to
          // be looked at and dismissed.
          setUploads((prev) => prev.filter((u) => u.localId !== upload.localId));
          return;
        }
        patch(upload.localId, { state: 'failed', error: message });
        setErrors((e) => [...e, `“${upload.name}”: ${message}`]);
      }
    }
  }, [patch]);

  const remove = useCallback((localId: string) => {
    setUploads((prev) => {
      const target = prev.find((u) => u.localId === localId);
      target?.cancel?.();
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrls.current.delete(target.previewUrl);
      }
      return prev.filter((u) => u.localId !== localId);
    });
  }, []);

  const clear = useCallback(() => {
    setUploads((prev) => {
      for (const u of prev) {
        if (u.state === 'uploading') u.cancel?.();
        if (u.previewUrl) {
          URL.revokeObjectURL(u.previewUrl);
          previewUrls.current.delete(u.previewUrl);
        }
      }
      return [];
    });
  }, []);

  const dismissError = useCallback((index: number) => {
    setErrors((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return {
    uploads,
    readyIds: uploads.filter((u) => u.state === 'ready' && u.fileId).map((u) => u.fileId!),
    // Send waits for uploads in flight rather than silently dropping them.
    busy: uploads.some((u) => u.state === 'uploading' || u.state === 'pending'),
    add, remove, clear, errors, dismissError,
  };
}

export { MAX_UPLOAD_BYTES };
