import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Search, X, ArrowRight } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { IconButton } from '../ui';

/**
 * The cross-app "waffle".
 *
 * This is a deliberate copy of `SystemsMenu` in the MIS
 * (`frontend/src/components/ui/SystemsMenu.tsx`) and TaskMentor
 * (`client/src/components/Layout/SystemsMenu.tsx`) — same panel chrome, same
 * header block, same search, same 4-up grid of elevated icon tiles, same hover
 * arrow. It is the one control a user meets in all four apps, so it is the one
 * place where "close enough" reads as a different product.
 *
 * Two deliberate differences from those two:
 *
 * - No framer-motion. Tupo does not depend on it, and adding a 40 kB animation
 * library for one menu is a poor trade; `animate-pop` in index.css produces
 * the same 150 ms scale-and-drop.
 * - No SSO handoff. MIS and TaskMentor call `authorizeSSO()` to mint a code and
 * open the sibling app already signed in. Tupo's API exposes no such
 * endpoint yet, so tiles navigate to `home_url` and the sibling app runs its
 * own SSO. Wire `handleSystemClick` to a Tupo `/api/sso/authorize` when that
 * lands; nothing else here changes.
 */

interface MisSystem {
  system_id?: number | string;
  name: string;
  client_id?: string;
  home_url?: string;
  icon_url?: string;
}

/** One tile. Extracted so the "Back to MIS" entry and a real system share it. */
const AppTile: React.FC<{
  name: string;
  href: string;
  iconUrl?: string;
  /** The MIS tile is orange in TaskMentor's menu; siblings are blue. */
  tone?: 'blue' | 'orange';
  index: number;
}> = ({ name, href, iconUrl, tone = 'blue', index }) => {
  // A broken icon_url is what actually happens in this ecosystem — several
  // systems carry a path that does not resolve from every app's origin. MIS and
  // TaskMentor render the broken-image glyph; falling back to the generic mark
  // is strictly better and costs nothing.
  const [broken, setBroken] = useState(false);

  const hover =
    tone === 'orange'
      ? 'hover:bg-orange-50 dark:hover:bg-orange-600/10'
      : 'hover:bg-blue-50 dark:hover:bg-blue-600/10';
  const cardHover =
    tone === 'orange'
      ? 'group-hover:border-orange-200 dark:group-hover:border-orange-500/30 group-hover:'
      : 'group-hover:border-blue-200 dark:group-hover:border-blue-500/30 group-hover:';
  const labelHover =
    tone === 'orange'
      ? 'group-hover:text-orange-600 dark:group-hover:text-orange-400'
      : 'group-hover:text-blue-600 dark:group-hover:text-blue-400';
  const badge = tone === 'orange' ? 'bg-orange-600' : 'bg-blue-600';
  const glyph = tone === 'orange' ? 'text-orange-500' : 'text-blue-500';

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ animationDelay: `${index * 30}ms` }}
      className={`animate-fade-in group relative flex flex-col items-center rounded-xl p-1.5 pt-2 text-center transition-all duration-200 ${hover}`}
    >
      <span className="relative mb-1.5">
        <span
          className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-gray-100 bg-white transition-all duration-200 group-hover:scale-105 dark:border-border-dark/50 dark:bg-elevated-dark dark: ${cardHover}`}
        >
          {iconUrl && !broken ? (
            <img
              src={iconUrl}
              alt=""
              onError={() => setBroken(true)}
              className="h-6 w-6 rounded-md object-contain"
            />
          ) : (
            <LayoutGrid className={`h-5 w-5 opacity-80 ${glyph}`} />
          )}
        </span>
        <span
          className={`absolute -right-1 -top-1 rounded-full p-0.5 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 ${badge}`}
        >
          <ArrowRight className="h-2 w-2" />
        </span>
      </span>
      <span
        className={`w-full truncate px-0.5 text-[10px] font-bold text-text-secondary-light transition-colors duration-200 dark:text-text-secondary-dark ${labelHover}`}
      >
        {name}
      </span>
    </a>
  );
};

export const AppsSwitcher: React.FC = () => {
  const [systems, setSystems] = useState<MisSystem[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<{ systems: MisSystem[] }>('/api/sso/systems')
      .then((r) => setSystems(r.data?.systems ?? []))
      .catch(() => setSystems([])); // fails open — a MIS blip must not break the navbar
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    // Matches the sibling apps' `autoFocus`, but applied after the panel exists
    // so the browser does not scroll the page to reach it.
    searchRef.current?.focus();
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const misHomeUrl =
    import.meta.env.VITE_MIS_HOME_URL ||
    (import.meta.env.VITE_MIS_LOGIN_URL || '').replace(/\/login\/?$/, '');

  const filtered = useMemo(
    () =>
      systems
        // Never offer the app you are already in.
        .filter((s) => s.client_id !== import.meta.env.VITE_SSO_CLIENT_ID)
        .filter((s) => s.name.toLowerCase().includes(query.toLowerCase())),
    [systems, query],
  );

  // TaskMentor always shows a static "Back to MIS" tile, because the MIS does
  // not list itself in its own systems feed. Ours sometimes does — so only add
  // the static tile when the feed has not already supplied one, or the menu
  // shows the MIS twice.
  const misInFeed = filtered.some((s) => s.client_id === 'mis' || /central mis/i.test(s.name));
  const showBackToMis = !!misHomeUrl && !misInFeed && (!query || 'back to mis'.includes(query.toLowerCase()));

  return (
    <div className="relative" ref={ref}>
      <IconButton label="View applications" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <LayoutGrid size={18} />
      </IconButton>

      {open && (
        <div
          role="menu"
          /* MIS and TaskMentor use bg-white/95 + backdrop-blur-xl. The blur
 cannot work here: the top bar this menu lives in has its own
 backdrop-filter, which makes it a stacking context, so there is no
 backdrop left to sample — the 5% would just show the panes bleeding
 through unblurred. Opaque gives the frosted-panel *appearance* the
 sibling apps intend, which is the thing that has to match. */
          className="animate-pop absolute left-0 z-60 mt-2 w-[300px] origin-top-left overflow-hidden rounded-2xl bg-white ring-1 ring-black/5 sm:w-[340px] dark:bg-chrome-dark dark: dark:ring-white/10"
        >
          <div className="p-3.5 pb-0">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 p-1.5">
                  <LayoutGrid className="h-4 w-4 text-white" />
                </span>
                <span>
                  <span className="block text-sm font-bold leading-tight text-text-primary-light dark:text-text-primary-dark">
                    Apps
                  </span>
                  <span className="block text-[10px] font-medium text-text-secondary-light dark:text-text-secondary-dark/70">
                    NGA Central MIS Ecosystem
                  </span>
                </span>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-full p-1.5 text-gray-400 transition-all duration-200 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-elevated-dark dark:hover:text-gray-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="group relative mb-3">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                <Search className="h-3.5 w-3.5 text-gray-400 transition-colors group-focus-within:text-blue-500 dark:text-gray-500" />
              </span>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search for apps..."
                aria-label="Search for apps"
                className="w-full rounded-full border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-xs text-text-primary-light transition-all placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark/50 dark:text-text-primary-dark dark:placeholder:text-gray-500"
              />
            </div>
          </div>

          <div className="max-h-[360px] overflow-y-auto px-3 pb-3">
            <div className="grid grid-cols-4 gap-1">
              {showBackToMis && <AppTile name="Back to MIS" href={misHomeUrl} tone="orange" index={0} />}
              {filtered.map((s, i) => (
                <AppTile
                  key={s.system_id ?? s.name}
                  name={s.name}
                  href={s.home_url ?? '#'}
                  iconUrl={s.icon_url}
                  index={i + (showBackToMis ? 1 : 0)}
                />
              ))}
            </div>

            {filtered.length === 0 && !showBackToMis && (
              <div className="py-8 text-center">
                <span className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-gray-50 dark:bg-elevated-dark">
                  <Search className="h-5 w-5 text-gray-300 dark:text-gray-600" />
                </span>
                <p className="text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark/70">
                  {query ? `No systems found matching "${query}"` : 'No other applications available'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
