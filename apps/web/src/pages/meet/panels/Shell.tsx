import React from 'react';
import { X } from 'lucide-react';

/**
 * The chrome every in-meeting side panel shares.
 *
 * Dark rather than themed: the meeting room is deliberately dark whatever the
 * app theme, because a bright panel next to video tiles washes out the faces
 * beside it — which is the one thing a video call cannot afford.
 */
export const PanelShell: React.FC<{
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, subtitle, onClose, footer, children }) => (
  <aside
    aria-label={title}
    className="tupo-glass animate-panel-in-right flex h-full w-full min-w-0 flex-col border-y-0 border-r-0 border-l border-white/[0.07] md:w-80 lg:w-96"
  >
    <header className="flex shrink-0 items-start justify-between gap-2 border-b border-white/10 px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 truncate text-xs text-white/50">{subtitle}</p>}
      </div>
      <button
        onClick={onClose}
        aria-label={`Close ${title}`}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/60 transition-colors duration-150 hover:bg-white/10 hover:text-white"
      >
        <X size={15} />
      </button>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

    {footer && <div className="shrink-0 border-t border-white/10 p-3">{footer}</div>}
  </aside>
);

export const PanelEmpty: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="grid h-full place-items-center px-6 text-center">
    <div>
      <p className="text-sm font-medium text-white/70">{title}</p>
      {hint && <p className="mt-1 text-xs text-white/40">{hint}</p>}
    </div>
  </div>
);

export const PanelButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }
> = ({ variant = 'primary', className = '', children, ...rest }) => (
  <button
    className={
      'inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ' +
      'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ' +
      (variant === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-500'
        : variant === 'danger' ? 'bg-red-600/20 text-red-300 hover:bg-red-600 hover:text-white'
        : 'bg-white/10 text-white/80 hover:bg-white/20') +
      ` ${className}`
    }
    {...rest}
  >
    {children}
  </button>
);

export const PanelInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
  <input
    {...props}
    className={
      'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white ' +
      'placeholder:text-white/30 focus:border-blue-500 focus:outline-none ' +
      (props.className ?? '')
    }
  />
);

/** The label/description/switch row every settings-shaped panel repeats. */
export const PanelToggle: React.FC<{
  label: string; hint?: string; checked: boolean; disabled?: boolean;
  onChange: (next: boolean) => void;
}> = ({ label, hint, checked, disabled, onChange }) => (
  <label className={`flex items-start gap-3 px-4 py-2.5 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
    />
    <span className="min-w-0">
      <span className="block text-sm text-white/90">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-white/40">{hint}</span>}
    </span>
  </label>
);
