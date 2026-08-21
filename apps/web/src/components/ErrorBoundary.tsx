import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * A boundary so one broken component cannot blank the whole app.
 *
 * React unmounts the entire tree when a render throws and nothing catches it.
 * Without a boundary, a null-dereference in a floating mini-call widget takes
 * the sidebar, the conversation and the composer with it, and the user sees a
 * white page with no way back — the worst possible presentation of a small bug.
 *
 * This was found by a browser test that suddenly could not see the sidebar: a
 * Vite hot-reload had invalidated a context identity, one consumer threw, and
 * the whole application disappeared. Hot-reload is a development-only cause,
 * but "any component throwing removes the product" is not a development-only
 * consequence.
 *
 * `resetKey` re-mounts the subtree when it changes, so navigating away from a
 * broken route clears the error rather than leaving it stuck.
 */

interface Props {
  children: React.ReactNode;
  /** Rendered instead of the default panel. `null` fails silently — correct for
   *  decoration like a floating widget, never for a whole screen. */
  fallback?: React.ReactNode | null;
  /** Changing this clears the error and retries. */
  resetKey?: unknown;
  /** Names the area in the default message, e.g. "chat". */
  label?: string;
}

interface State { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Logged rather than swallowed: a boundary that hides the failure from the
    // console is how a bug survives to production.
    console.error('[boundary] a component tree failed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div
        role="alert"
        className="grid h-full min-h-40 place-items-center p-6 text-center"
      >
        <div className="max-w-sm">
          <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400">
            <AlertTriangle size={20} />
          </span>
          <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
            Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}
          </h2>
          <p className="mt-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
            The rest of Tupo is still working. Reloading usually clears it.
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <RotateCcw size={13} /> Try again
          </button>
        </div>
      </div>
    );
  }
}
