import React, { useState } from 'react';
import { BarChart3, Check, Plus, X } from 'lucide-react';
import type { MeetPoll } from '@tupo/shared';
import { PanelShell, PanelButton, PanelEmpty, PanelInput } from './Shell';

/**
 * Live polls and quizzes.
 *
 * The difference between the two is where the right answer lives. A poll has
 * none. A quiz has one, and the server withholds it until the quiz closes —
 * otherwise it would be sitting in the page for anyone who opened devtools,
 * which in a classroom is the entire class within a minute.
 */

export interface PollsPanelProps {
  polls: MeetPoll[];
  isHost: boolean;
  onClose: () => void;
  onCreate: (p: {
    question: string; options: string[]; kind: 'poll' | 'quiz';
    correctOptionIndex?: number; anonymous: boolean; multipleChoice: boolean;
  }) => void;
  onVote: (pollId: string, optionIndexes: number[]) => void;
  onClosePoll: (pollId: string) => void;
}

export const PollsPanel: React.FC<PollsPanelProps> = ({
  polls, isHost, onClose, onCreate, onVote, onClosePoll,
}) => {
  const [composing, setComposing] = useState(false);
  const [kind, setKind] = useState<'poll' | 'quiz'>('poll');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [correctIndex, setCorrectIndex] = useState(0);
  const [anonymous, setAnonymous] = useState(false);
  const [multipleChoice, setMultipleChoice] = useState(false);

  const reset = () => {
    setComposing(false); setQuestion(''); setOptions(['', '']);
    setCorrectIndex(0); setAnonymous(false); setMultipleChoice(false); setKind('poll');
  };

  const submit = () => {
    const cleaned = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || cleaned.length < 2) return;
    onCreate({
      question: question.trim(),
      options: cleaned,
      kind,
      ...(kind === 'quiz' ? { correctOptionIndex: correctIndex } : {}),
      anonymous,
      multipleChoice,
    });
    reset();
  };

  return (
    <PanelShell
      title="Polls"
      subtitle={polls.length ? `${polls.filter((p) => p.status === 'open').length} open` : undefined}
      onClose={onClose}
      footer={isHost && !composing ? (
        <PanelButton className="w-full" onClick={() => setComposing(true)}>
          <Plus size={13} /> New poll or quiz
        </PanelButton>
      ) : undefined}
    >
      {composing && (
        <section className="space-y-2.5 border-b border-white/10 p-4">
          <div className="flex gap-1">
            {(['poll', 'quiz'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={
                  'flex-1 rounded-full px-2 py-1.5 text-xs font-medium capitalize transition-colors duration-150 ' +
                  (kind === k ? 'bg-blue-600 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20')
                }
              >
                {k}
              </button>
            ))}
          </div>

          <PanelInput
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={kind === 'quiz' ? 'Question' : 'What do you want to ask?'}
          />

          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              {kind === 'quiz' && (
                <button
                  onClick={() => setCorrectIndex(i)}
                  aria-label={`Mark option ${i + 1} correct`}
                  title="Mark as the correct answer"
                  className={
                    'grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors duration-150 ' +
                    (correctIndex === i
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white/10 text-white/40 hover:bg-white/20')
                  }
                >
                  <Check size={13} />
                </button>
              )}
              <PanelInput
                value={o}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
                placeholder={`Option ${i + 1}`}
              />
              {options.length > 2 && (
                <button
                  onClick={() => {
                    setOptions(options.filter((_, j) => j !== i));
                    // The correct answer must follow its option, or removing an
                    // earlier row silently changes which answer is right.
                    if (correctIndex >= i && correctIndex > 0) setCorrectIndex(correctIndex - 1);
                  }}
                  aria-label={`Remove option ${i + 1}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/40 hover:bg-white/10 hover:text-white"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}

          {options.length < 10 && (
            <button
              onClick={() => setOptions([...options, ''])}
              className="text-xs text-blue-300 hover:text-blue-200"
            >
              + Add option
            </button>
          )}

          <label className="flex items-center gap-2 text-xs text-white/70">
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)}
              className="h-3.5 w-3.5 accent-blue-600" />
            Hide who voted for what
          </label>
          <label className="flex items-center gap-2 text-xs text-white/70">
            <input type="checkbox" checked={multipleChoice} onChange={(e) => setMultipleChoice(e.target.checked)}
              className="h-3.5 w-3.5 accent-blue-600" />
            Allow more than one answer
          </label>

          <div className="flex gap-2 pt-1">
            <PanelButton variant="ghost" className="flex-1" onClick={reset}>Cancel</PanelButton>
            <PanelButton
              className="flex-1"
              disabled={!question.trim() || options.filter((o) => o.trim()).length < 2}
              onClick={submit}
            >
              Launch
            </PanelButton>
          </div>
        </section>
      )}

      {polls.length === 0 && !composing ? (
        <PanelEmpty
          title="No polls yet."
          hint={isHost ? 'Ask the room a question, or run a quick quiz.' : 'The host has not run one.'}
        />
      ) : (
        <ul className="space-y-3 p-4">
          {[...polls].reverse().map((poll) => (
            <PollCard key={poll.id} poll={poll} isHost={isHost} onVote={onVote} onClosePoll={onClosePoll} />
          ))}
        </ul>
      )}
    </PanelShell>
  );
};

const PollCard: React.FC<{
  poll: MeetPoll; isHost: boolean;
  onVote: (pollId: string, optionIndexes: number[]) => void;
  onClosePoll: (pollId: string) => void;
}> = ({ poll, isHost, onVote, onClosePoll }) => {
  const [selection, setSelection] = useState<number[]>(poll.myVote ?? []);
  const voted = (poll.myVote?.length ?? 0) > 0;
  const closed = poll.status === 'closed';
  // Results stay hidden until you have voted — seeing the tally first turns a
  // poll into a popularity contest, and a quiz into a giveaway.
  const showResults = voted || closed || isHost;

  const toggle = (index: number) => {
    if (closed) return;
    setSelection((s) => poll.multipleChoice
      ? s.includes(index) ? s.filter((i) => i !== index) : [...s, index]
      : [index]);
  };

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="mb-2 flex items-start gap-2">
        <BarChart3 size={14} className="mt-0.5 shrink-0 text-blue-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-white">{poll.question}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wide text-white/40">
            {poll.kind} · {poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}
            {closed && ' · closed'}
          </p>
        </div>
      </div>

      <ul className="space-y-1.5">
        {poll.options.map((o) => {
          const share = poll.totalVotes > 0 ? o.votes / poll.totalVotes : 0;
          const chosen = selection.includes(o.index);
          const isCorrect = closed && poll.correctOptionIndex === o.index;
          return (
            <li key={o.index}>
              <button
                onClick={() => toggle(o.index)}
                disabled={closed}
                className={
                  'relative w-full overflow-hidden rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150 ' +
                  (isCorrect ? 'border-emerald-500/50 bg-emerald-500/10'
                    : chosen ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-white/10 hover:border-white/25') +
                  (closed ? ' cursor-default' : '')
                }
              >
                {showResults && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-white/5 transition-[width] duration-500"
                    style={{ width: `${share * 100}%` }}
                  />
                )}
                <span className="relative flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-white/90">{o.text}</span>
                  {isCorrect && <Check size={12} className="shrink-0 text-emerald-400" />}
                  {showResults && (
                    <span className="shrink-0 text-[10px] tabular-nums text-white/50">
                      {Math.round(share * 100)}%
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex gap-2">
        {!closed && (
          <PanelButton
            className="flex-1"
            disabled={selection.length === 0}
            onClick={() => onVote(poll.id, selection)}
          >
            {voted ? 'Change vote' : 'Vote'}
          </PanelButton>
        )}
        {isHost && !closed && (
          <PanelButton variant="ghost" onClick={() => onClosePoll(poll.id)}>Close</PanelButton>
        )}
      </div>
    </li>
  );
};
