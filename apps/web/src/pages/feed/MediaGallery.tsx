import React, { useCallback, useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, FileText, Download, Play } from 'lucide-react';
import type { FeedMediaItem } from '@tupo/shared';
import { useMediaUrl } from './lib';
import { downloadFile } from '../chat/uploads';

/** One tile inside the mosaic. */
const Tile: React.FC<{ item: FeedMediaItem; onOpen: () => void; className?: string; overlay?: number }> = ({
  item, onOpen, className = '', overlay,
}) => {
  const url = useMediaUrl(item.fileId, item.kind !== 'document');

  if (item.kind === 'document') {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); void downloadFile(item.fileId, item.name ?? 'file'); }}
        className={`flex items-center gap-3 rounded-xl border border-border-light bg-surface-light p-3 text-left transition-colors hover:bg-blue-50 dark:border-border-dark/50 dark:bg-card-dark/40 dark:hover:bg-blue-900/20 ${className}`}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300">
          <FileText size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">{item.name ?? 'Document'}</span>
          <span className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
            {item.size ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : 'Download'}
          </span>
        </span>
        <Download size={16} className="text-text-secondary-light dark:text-text-secondary-dark" />
      </button>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      className={`group relative overflow-hidden bg-slate-100 dark:bg-card-dark ${className}`}
      style={{ aspectRatio: item.w && item.h ? `${item.w} / ${item.h}` : undefined }}
    >
      {url && item.kind === 'image' && (
        <img src={url} alt={item.name ?? ''} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
      )}
      {url && item.kind === 'video' && (
        <>
          <video src={url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
          <span className="absolute inset-0 grid place-items-center bg-black/25">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-white/90 text-slate-900"><Play size={20} className="ml-0.5" /></span>
          </span>
        </>
      )}
      {!url && <span className="feed-skeleton absolute inset-0" />}
      {overlay ? (
        <span className="absolute inset-0 grid place-items-center bg-black/55 text-2xl font-semibold text-white">+{overlay}</span>
      ) : null}
    </button>
  );
};

const Lightbox: React.FC<{ items: FeedMediaItem[]; index: number; onClose: () => void }> = ({ items, index, onClose }) => {
  const [i, setI] = useState(index);
  const item = items[i]!;
  const url = useMediaUrl(item.fileId, true);
  const go = useCallback((d: number) => setI((c) => (c + d + items.length) % items.length), [items.length]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = ''; };
  }, [go, onClose]);

  return (
    <div className="animate-fade-in fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"><X size={20} /></button>
      {items.length > 1 && (
        <>
          <button onClick={(e) => { e.stopPropagation(); go(-1); }} aria-label="Previous" className="absolute left-3 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"><ChevronLeft size={22} /></button>
          <button onClick={(e) => { e.stopPropagation(); go(1); }} aria-label="Next" className="absolute right-3 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"><ChevronRight size={22} /></button>
        </>
      )}
      <div className="max-h-[88vh] max-w-5xl" onClick={(e) => e.stopPropagation()}>
        {url && item.kind === 'image' && <img src={url} alt={item.name ?? ''} className="max-h-[88vh] rounded-lg object-contain" />}
        {url && item.kind === 'video' && <video src={url} controls autoPlay className="max-h-[88vh] rounded-lg" />}
        {!url && <div className="feed-skeleton h-96 w-96 rounded-lg" />}
      </div>
      {items.length > 1 && (
        <span className="absolute bottom-4 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white">{i + 1} / {items.length}</span>
      )}
    </div>
  );
};

export const MediaGallery: React.FC<{ media: FeedMediaItem[]; bleed?: boolean }> = ({ media, bleed = false }) => {
  const [lightbox, setLightbox] = useState<number | null>(null);
  if (!media.length) return null;

  const visual = media.filter((m) => m.kind !== 'document');
  const docs = media.filter((m) => m.kind === 'document');
  const open = (m: FeedMediaItem) => setLightbox(visual.indexOf(m));
  const round = bleed ? '' : 'rounded-xl';

  const grid = (() => {
    if (visual.length === 0) return null;
    if (visual.length === 1) return <Tile item={visual[0]!} onOpen={() => open(visual[0]!)} className={`max-h-[36rem] w-full ${round}`} />;
    if (visual.length === 2) return (
      <div className={`grid grid-cols-2 gap-1 overflow-hidden ${round}`}>
        {visual.map((m) => <Tile key={m.fileId} item={m} onOpen={() => open(m)} className="aspect-square" />)}
      </div>
    );
    if (visual.length === 3) return (
      <div className={`grid grid-cols-2 gap-1 overflow-hidden ${round}`}>
        <Tile item={visual[0]!} onOpen={() => open(visual[0]!)} className="row-span-2 h-full" />
        <Tile item={visual[1]!} onOpen={() => open(visual[1]!)} className="aspect-[4/3]" />
        <Tile item={visual[2]!} onOpen={() => open(visual[2]!)} className="aspect-[4/3]" />
      </div>
    );
    return (
      <div className={`grid grid-cols-2 gap-1 overflow-hidden ${round}`}>
        {visual.slice(0, 4).map((m, idx) => (
          <Tile key={m.fileId} item={m} onOpen={() => open(m)} className="aspect-square"
            overlay={idx === 3 && visual.length > 4 ? visual.length - 4 : undefined} />
        ))}
      </div>
    );
  })();

  return (
    <div className={bleed ? 'space-y-1' : 'mt-3 space-y-2'}>
      {grid}
      {docs.length > 0 && (
        <div className={bleed ? 'space-y-2 px-3 pt-2 sm:px-4' : 'space-y-2'}>
          {docs.map((d) => <Tile key={d.fileId} item={d} onOpen={() => {}} />)}
        </div>
      )}
      {lightbox !== null && <Lightbox items={visual} index={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
};
