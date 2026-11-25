import React, { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { apiGet } from '../../lib/api';

/**
 * The account menu's school section (TENANT_SWITCHING_PLAN.md Appendix A.5):
 * the signed-in school's name and logo, and "Switch school" when the person
 * has an account in two or more schools. Switching happens in MIS
 * (/switch-school), which sends the browser back to Tupo's landing page; that
 * page signs in again on its own -- into the new school.
 */
interface School { tid: number; name: string | null; logoUrl: string | null }

let cached: { school: School | null; canSwitch: boolean } | null = null;

export function misSwitchUrl(origin: string = window.location.origin): string {
  const mis = (import.meta.env.VITE_MIS_LOGIN_URL || '').replace(/\/login\/?$/, '');
  return `${mis}/switch-school?return=${encodeURIComponent(`${origin}/`)}`;
}

export const SchoolMenu: React.FC<{ onPicked?: () => void }> = ({ onPicked }) => {
  const [state, setState] = useState(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    Promise.all([
      apiGet<School>('/api/sso/school').catch(() => null),
      apiGet<{ canSwitch: boolean }>('/api/sso/my-schools').catch(() => null),
    ]).then(([school, mine]) => {
      cached = { school: school?.data ?? null, canSwitch: !!mine?.data?.canSwitch };
      if (alive) setState(cached);
    });
    return () => { alive = false; };
  }, []);

  if (!state) {
    return <div className="mx-2.5 my-1.5 h-8 animate-pulse rounded-xl bg-surface-light dark:bg-surface-dark" aria-hidden />;
  }
  const name = state.school?.name;
  if (!name && !state.canSwitch) return null;
  return (
    <>
      {name && (
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          {state.school?.logoUrl ? (
            <img src={state.school.logoUrl} alt="" className="h-6 w-6 shrink-0 rounded-md bg-white object-contain" />
          ) : (
            <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-100 text-[10px] font-bold text-blue-700 dark:bg-blue-500/20 dark:text-blue-200">
              {name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
            </span>
          )}
          <span className="min-w-0 truncate text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark" title={name}>{name}</span>
        </div>
      )}
      {state.canSwitch && (
        <a
          role="menuitem"
          href={misSwitchUrl()}
          onClick={() => onPicked?.()}
          className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-medium text-text-primary-light transition-colors duration-150 hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-surface-dark"
        >
          <Repeat size={15} /> Switch school
        </a>
      )}
      <div className="my-1 h-px bg-border-light dark:bg-card-dark/50" />
    </>
  );
};
