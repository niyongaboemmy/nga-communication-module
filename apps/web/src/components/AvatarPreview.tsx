import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { largeAvatarUrl } from '../lib/avatarUrl';

export { largeAvatarUrl };

/** True while a photo preview is open -- popovers that close on outside clicks or Esc
 *  should leave those events to the preview. */
export const avatarPreviewOpen = (): boolean => !!document.querySelector('[data-avatar-lightbox]');

/**
 * Full-screen look at someone's profile photo: the 512 px rendition, their name, and
 * Esc / click outside / the close button to leave. Fades and scales in.
 */
export const AvatarLightbox: React.FC<{ src: string; name: string; caption?: string; onClose: () => void }> = ({
  src, name, caption, onClose,
}) => {
  const [shown, setShown] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [large, setLarge] = useState(() => largeAvatarUrl(src));

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      data-avatar-lightbox=""
      aria-label={`${name}, profile photo`}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 p-6 backdrop-blur-sm transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close photo"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      <figure
        onClick={(e) => e.stopPropagation()}
        className={`flex flex-col items-center gap-4 transition-transform duration-300 ease-out ${shown ? 'scale-100' : 'scale-90'}`}
      >
        <div className="relative h-[min(72vw,22rem)] w-[min(72vw,22rem)] overflow-hidden rounded-full bg-white/10 shadow-2xl ring-4 ring-white/15">
          {!loaded && <div className="absolute inset-0 animate-pulse bg-white/10" />}
          <img
            src={large}
            alt={name}
            onLoad={() => setLoaded(true)}
            // An older or non-MIS link may not have a large size: fall back to the original.
            onError={() => { if (large !== src) setLarge(src); }}
            className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
        </div>
        <figcaption className="text-center text-white">
          <p className="text-base font-semibold">{name}</p>
          {caption && <p className="text-xs text-white/70">{caption}</p>}
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
};
