import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckSquare, FileText, Gavel, Loader2, RefreshCw, Send, Sparkles,
} from 'lucide-react';
import type { MeetActionItem, MeetDecision, MeetParticipant } from '@tupo/shared';
import { PanelShell, PanelButton, PanelEmpty, PanelToggle } from './Shell';
import * as meetApi from '../api';
import type { SummaryContent } from '../api';

/**
 * Tupo AI — the in-meeting notetaker.
 *
 * Every generator here runs over the speaker-attributed transcript and through
 * the four-provider fallback chain, so a quota error on one model is invisible.
 * Three things are deliberate and load-bearing:
 *
 *  1. **Nothing runs until the host turns it on.** The panel's first state is a
 *     consent screen, not a spinner.
 *  2. **Every answer names its model.** "Which model said this" is the first
 *     question anyone asks of a generated summary, and it is answered inline.
 *  3. **The panel says when the transcript is thin.** A summary of four
 *     sentences reads as authoritative and says nothing true, so the honest
 *     answer is to say there is not enough yet.
 */

export interface AiPanelProps {
  meetingId: string;
  aiEnabled: boolean;
  aiPresent: boolean;
  transcribing: boolean;
  captionsSupported: boolean;
  captionCount: number;
  participants: MeetParticipant[];
  canUseAi: boolean;
  isHost: boolean;
  thinking: string | null;
  onClose: () => void;
  onEnableAi: (on: boolean) => void;
  onEnableTranscription: (on: boolean) => void;
}

type Tab = 'summary' | 'actions' | 'decisions' | 'ask';

/** Enough transcript for a summary to be about something. */
const MIN_SEGMENTS = 8;

export const AiPanel: React.FC<AiPanelProps> = ({
  meetingId, aiEnabled, aiPresent, transcribing, captionsSupported, captionCount,
  canUseAi, isHost, thinking, onClose, onEnableAi, onEnableTranscription,
}) => {
  const [tab, setTab] = useState<Tab>('summary');
  const [summary, setSummary] = useState<{ content: SummaryContent; provider: string } | null>(null);
  const [actions, setActions] = useState<{ content: MeetActionItem[]; provider: string } | null>(null);
  const [decisions, setDecisions] = useState<{ content: MeetDecision[]; provider: string } | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<
    { answer: string; grounded: boolean; citations: string[]; provider: string } | null>(null);
  const [busy, setBusy] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enoughTranscript = captionCount >= MIN_SEGMENTS;

  const run = useCallback(async (which: Tab) => {
    setBusy(which);
    setError(null);
    try {
      if (which === 'summary') {
        const r = await meetApi.aiSummary(meetingId);
        setSummary({ content: r.content, provider: r.providerUsed });
      } else if (which === 'actions') {
        const r = await meetApi.aiActionItems(meetingId);
        setActions({ content: r.content, provider: r.providerUsed });
      } else if (which === 'decisions') {
        const r = await meetApi.aiDecisions(meetingId);
        setDecisions({ content: r.content, provider: r.providerUsed });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The AI could not answer.');
    } finally {
      setBusy(null);
    }
  }, [meetingId]);

  /**
   * The server tells the room when there is enough new transcript to be worth
   * re-summarising. Refreshing on a client timer instead would spend quota on
   * a room that has been silent for five minutes.
   */
  useEffect(() => {
    if (thinking === 'summary' && aiPresent && enoughTranscript) void run('summary');
  }, [thinking, aiPresent, enoughTranscript, run]);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setBusy('ask');
    setError(null);
    try {
      const r = await meetApi.aiAsk(meetingId, q);
      setAnswer({ ...r, provider: r.providerUsed });
      setQuestion('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The AI could not answer.');
    } finally {
      setBusy(null);
    }
  };

  /* --- Not yet invited --- */
  if (!aiEnabled || !aiPresent) {
    return (
      <PanelShell title="Tupo AI" subtitle="Notes, action items and answers" onClose={onClose}>
        <div className="space-y-4 p-4">
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <Sparkles size={15} className="text-blue-300" />
              <span className="text-sm font-semibold text-white">Invite Tupo AI to this meeting</span>
            </div>
            <p className="text-xs leading-relaxed text-white/60">
              Tupo AI reads the live captions and keeps a rolling summary, a list of decisions and a
              list of action items — and can answer questions about what has been said. It joins the
              participant list, and everyone is told while it is here.
            </p>
          </div>

          {!canUseAi ? (
            <p className="text-xs text-white/50">
              You do not have permission to use the AI notetaker in this meeting.
            </p>
          ) : !isHost ? (
            <p className="text-xs text-white/50">Only the host can invite Tupo AI.</p>
          ) : (
            <>
              <PanelToggle
                label="Live captions"
                hint={captionsSupported
                  ? 'Each person transcribes their own microphone, so notes are attributed correctly.'
                  : 'Your browser has no speech recognition. Others on Chrome or Edge can still contribute captions.'}
                checked={transcribing}
                onChange={onEnableTranscription}
              />
              <PanelToggle
                label="Tupo AI notetaker"
                hint="Needs captions on — the AI reads the transcript, never the audio."
                checked={aiPresent}
                disabled={!transcribing}
                onChange={onEnableAi}
              />
            </>
          )}
        </div>
      </PanelShell>
    );
  }

  /* --- Active --- */
  return (
    <PanelShell
      title="Tupo AI"
      subtitle={`${captionCount} caption${captionCount === 1 ? '' : 's'} captured`}
      onClose={onClose}
      footer={tab === 'ask' ? (
        <form onSubmit={ask} className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What have I missed?"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy === 'ask' || !question.trim()}
            aria-label="Ask"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-30"
          >
            {busy === 'ask' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </form>
      ) : (
        <PanelButton
          className="w-full"
          disabled={busy !== null || !enoughTranscript}
          onClick={() => void run(tab)}
        >
          {busy === tab
            ? <><Loader2 size={13} className="animate-spin" /> Thinking…</>
            : <><RefreshCw size={13} /> Refresh</>}
        </PanelButton>
      )}
    >
      <nav className="flex gap-1 border-b border-white/10 px-2 py-2">
        {([
          ['summary', 'Summary', FileText],
          ['actions', 'Actions', CheckSquare],
          ['decisions', 'Decisions', Gavel],
          ['ask', 'Ask', Sparkles],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              'flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1.5 text-[11px] font-medium transition-colors duration-150 ' +
              (tab === key ? 'bg-blue-600 text-white' : 'text-white/60 hover:bg-white/10')
            }
          >
            <Icon size={12} /> {label}
          </button>
        ))}
      </nav>

      {!enoughTranscript && (
        <div className="m-3 flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
          <p className="text-xs leading-relaxed text-amber-100/80">
            Not enough has been said yet. Tupo AI will start once the conversation gets going —
            summarising four sentences would read as confident and tell you nothing.
          </p>
        </div>
      )}

      {error && (
        <p className="m-3 rounded-lg border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-200">
          {error}
        </p>
      )}

      <div className="space-y-3 p-4">
        {tab === 'summary' && (
          summary ? (
            <>
              <p className="text-sm font-medium leading-relaxed text-white">{summary.content.headline}</p>
              <ul className="space-y-1.5">
                {summary.content.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-relaxed text-white/70">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-blue-400" />{b}
                  </li>
                ))}
              </ul>
              {summary.content.topics.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {summary.content.topics.map((t) => (
                    <span key={t} className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/60">{t}</span>
                  ))}
                </div>
              )}
              {summary.content.openQuestions.length > 0 && (
                <div>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                    Still open
                  </h4>
                  <ul className="space-y-1">
                    {summary.content.openQuestions.map((q, i) => (
                      <li key={i} className="text-xs text-white/60">{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Provenance provider={summary.provider} />
            </>
          ) : <PanelEmpty title="No summary yet." hint="It will appear as the conversation develops." />
        )}

        {tab === 'actions' && (
          actions ? (
            actions.content.length === 0
              ? <PanelEmpty title="No action items." hint="Nobody has committed to anything yet." />
              : (
                <>
                  <ul className="space-y-2">
                    {actions.content.map((a, i) => (
                      <li key={i} className="rounded-lg bg-white/5 p-2.5">
                        <p className="text-xs leading-relaxed text-white/90">{a.text}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                          {a.owner && (
                            <span className="rounded bg-blue-600/25 px-1.5 py-0.5 text-blue-200">{a.owner}</span>
                          )}
                          {a.due && <span className="text-white/40">due {a.due}</span>}
                          {/* Surfaced rather than hidden: a low-confidence item
                              is a prompt to check, not a fact. */}
                          {typeof a.confidence === 'number' && a.confidence < 0.6 && (
                            <span className="text-amber-300/70">unclear — worth confirming</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Provenance provider={actions.provider} />
                </>
              )
          ) : <PanelEmpty title="No action items yet." hint="Tap refresh to look for them." />
        )}

        {tab === 'decisions' && (
          decisions ? (
            decisions.content.length === 0
              ? <PanelEmpty title="No decisions recorded." hint="Nothing has been settled yet." />
              : (
                <>
                  <ul className="space-y-2">
                    {decisions.content.map((d, i) => (
                      <li key={i} className="rounded-lg bg-white/5 p-2.5">
                        <p className="text-xs font-medium leading-relaxed text-white/90">{d.decision}</p>
                        {d.context && <p className="mt-1 text-[11px] text-white/50">{d.context}</p>}
                        {d.quote && (
                          <p className="mt-1.5 border-l-2 border-white/15 pl-2 text-[11px] italic text-white/40">
                            “{d.quote}”
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                  <Provenance provider={decisions.provider} />
                </>
              )
          ) : <PanelEmpty title="No decisions yet." hint="Tap refresh to look for them." />
        )}

        {tab === 'ask' && (
          answer ? (
            <>
              {!answer.grounded && (
                <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5 text-[11px] text-amber-100/80">
                  This meeting has not covered that. The answer below is what the transcript does say.
                </p>
              )}
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/90">{answer.answer}</p>
              {answer.citations.length > 0 && (
                <div>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">From</h4>
                  <ul className="space-y-1">
                    {answer.citations.map((c, i) => (
                      <li key={i} className="border-l-2 border-white/15 pl-2 text-[11px] italic text-white/50">{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Provenance provider={answer.provider} />
            </>
          ) : (
            <PanelEmpty
              title="Ask about this meeting."
              hint="“What have I missed?” · “What did we decide about the timetable?”"
            />
          )
        )}
      </div>
    </PanelShell>
  );
};

/** Which model produced this. Always shown, never in fine print. */
const Provenance: React.FC<{ provider: string }> = ({ provider }) => (
  <p className="border-t border-white/5 pt-2 text-[10px] text-white/30">
    Generated by {provider} · check anything you plan to act on
  </p>
);
