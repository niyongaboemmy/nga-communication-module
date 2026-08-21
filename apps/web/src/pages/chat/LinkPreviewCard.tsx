import React from 'react';
import { Link2 } from 'lucide-react';

/**
 * An unfurled link (FR-MSG-22).
 *
 * Every value here came from somebody else's web page, so all of it is rendered
 * as text through React and none of it as markup. The thumbnail is the one
 * exception worth naming: it is an `<img src>` pointing at a third-party host,
 * which leaks the reader's IP to that host — acceptable for a preview the
 * sender chose to share, and the reason `referrerPolicy` is set so the *URL*
 * of the conversation never travels with it.
 */

export interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export const LinkPreviewCard: React.FC<{
  preview: LinkPreviewData;
  onDark: boolean;
}> = ({ preview, onDark }) => {
  if (!preview.title) return null;

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      data-link-preview=""
      className={`mt-2 flex max-w-sm gap-2.5 overflow-hidden rounded-xl border p-2 transition-colors ${
        onDark
          ? 'border-white/25 bg-white/10 hover:bg-white/15'
          : 'border-border-light bg-surface-light hover:bg-white dark:border-border-dark/50 dark:bg-card-dark/40 dark:hover:bg-card-dark/60'
      }`}
    >
      {preview.imageUrl && (
        <img
          src={preview.imageUrl}
          alt=""
          loading="lazy"
          // No referrer: the third-party host learns nothing about where the
          // link was shared.
          referrerPolicy="no-referrer"
          className="h-14 w-14 shrink-0 rounded-lg object-cover"
          // A broken thumbnail should leave the card, not a torn icon.
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-70">
          <Link2 size={9} />
          {preview.siteName ?? new URL(preview.url).hostname.replace(/^www\./, '')}
        </span>
        <span className="mt-0.5 block truncate text-xs font-semibold">{preview.title}</span>
        {preview.description && (
          <span className="mt-0.5 line-clamp-2 block text-[11px] opacity-80">
            {preview.description}
          </span>
        )}
      </span>
    </a>
  );
};
