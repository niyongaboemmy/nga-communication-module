import React, { useMemo, useState } from 'react';
import { ArrowBigUp, Check, Send } from 'lucide-react';
import type { MeetQuestion } from '@tupo/shared';
import { PanelShell, PanelButton, PanelEmpty } from './Shell';

/**
 * Q&A.
 *
 * Distinct from chat on purpose. Chat is a stream and a question posted there
 * scrolls away; this is a queue that stays put, sorts by upvotes, and records
 * which questions were actually answered. In a lesson or an assembly that
 * difference decides whether a quiet pupil's question ever gets asked.
 */

export interface QandAPanelProps {
  questions: MeetQuestion[];
  youParticipantId: string | null;
  isHost: boolean;
  onClose: () => void;
  onAsk: (text: string) => void;
  onUpvote: (questionId: string) => void;
  onAnswer: (questionId: string, answerText: string) => void;
}

export const QandAPanel: React.FC<QandAPanelProps> = ({
  questions, youParticipantId, isHost, onClose, onAsk, onUpvote, onAnswer,
}) => {
  const [draft, setDraft] = useState('');
  const [answering, setAnswering] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');

  // Unanswered first, most-upvoted first within each group: the top of the list
  // is always the question the room most wants asked next.
  const ordered = useMemo(() => [...questions].sort((a, b) => {
    if (a.answered !== b.answered) return a.answered ? 1 : -1;
    if (a.upvotes !== b.upvotes) return b.upvotes - a.upvotes;
    return a.createdAt.localeCompare(b.createdAt);
  }), [questions]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onAsk(text);
    setDraft('');
  };

  const open = ordered.filter((q) => !q.answered).length;

  return (
    <PanelShell
      title="Questions"
      subtitle={questions.length ? `${open} waiting · ${questions.length - open} answered` : undefined}
      onClose={onClose}
      footer={
        <form onSubmit={submit} className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask a question…"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            aria-label="Ask"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-30"
          >
            <Send size={15} />
          </button>
        </form>
      }
    >
      {ordered.length === 0 ? (
        <PanelEmpty
          title="No questions yet."
          hint="Questions asked here stay in a queue instead of scrolling away in chat."
        />
      ) : (
        <ul className="space-y-2 p-3">
          {ordered.map((q) => (
            <li
              key={q.id}
              className={
                'rounded-xl border p-3 ' +
                (q.answered ? 'border-white/5 bg-white/[0.02] opacity-70' : 'border-white/10 bg-white/5')
              }
            >
              <div className="flex gap-2.5">
                <button
                  onClick={() => onUpvote(q.id)}
                  aria-label={`Upvote: ${q.text}`}
                  className="flex h-11 w-9 shrink-0 flex-col items-center justify-center rounded-full bg-white/5 text-white/60 transition-colors duration-150 hover:bg-blue-600/25 hover:text-blue-200"
                >
                  <ArrowBigUp size={15} />
                  <span className="text-[10px] font-semibold tabular-nums">{q.upvotes}</span>
                </button>

                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug text-white/90">{q.text}</p>
                  <p className="mt-1 text-[10px] text-white/40">
                    {q.participantId === youParticipantId ? 'You' : q.askedBy}
                    {q.answered && ' · answered'}
                  </p>

                  {q.answerText && (
                    <p className="mt-2 rounded-lg bg-emerald-500/10 p-2 text-xs leading-relaxed text-emerald-100/90">
                      {q.answerText}
                    </p>
                  )}

                  {isHost && !q.answered && (
                    answering === q.id ? (
                      <div className="mt-2 space-y-1.5">
                        <input
                          value={answerText}
                          onChange={(e) => setAnswerText(e.target.value)}
                          placeholder="Answer (optional — you can also just mark it answered)"
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none"
                        />
                        <div className="flex gap-2">
                          <PanelButton
                            variant="ghost"
                            onClick={() => { setAnswering(null); setAnswerText(''); }}
                          >
                            Cancel
                          </PanelButton>
                          <PanelButton
                            className="flex-1"
                            onClick={() => {
                              onAnswer(q.id, answerText.trim());
                              setAnswering(null);
                              setAnswerText('');
                            }}
                          >
                            <Check size={12} /> Mark answered
                          </PanelButton>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAnswering(q.id)}
                        className="mt-1.5 text-[11px] text-blue-300 hover:text-blue-200"
                      >
                        Answer this
                      </button>
                    )
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
};
