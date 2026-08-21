import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check, Loader2, Pin, PinOff, Plus, Share2, Sparkles, Trash2, Undo2, Wand2, X,
} from 'lucide-react';
import type { MeetNote } from '@tupo/shared';
import { PanelShell, PanelButton, PanelEmpty } from './Shell';
import * as meetApi from '../api';

/**
 * Notes.
 *
 * The design principle here is that **the person owns the note**. The AI is
 * available and genuinely useful, but it is never the author:
 *
 *  - You type. That is the default and the primary path.
 *  - **Capture** lifts the last ~45 seconds of transcript into a note. This is
 *    the feature that makes manual note-taking survive a live meeting: the
 *    moment worth writing down has always just passed, and by the time you have
 *    typed it you have missed the next one.
 *  - **Tidy** cleans up what you wrote without changing what you meant, and the
 *    original is kept so it is always reversible.
 *  - **Keep** takes the AI's current summary and makes it *yours* — a note you
 *    own, which no later regeneration can overwrite.
 *
 * Notes are private until deliberately shared. Shared ones fan out over the
 * socket and land in the meeting's written record.
 */

export interface NotesPanelProps {
  meetingId: string;
  notes: MeetNote[];
  aiAvailable: boolean;
  transcribing: boolean;
  offsetSeconds: number | null;
  onClose: () => void;
  onNotesChanged: (notes: MeetNote[]) => void;
  onShare: (note: MeetNote, shared: boolean) => void;
}

const stamp = (offset: number | null): string => {
  if (offset === null) return '';
  const m = Math.floor(offset / 60);
  const s = Math.floor(offset % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const NotesPanel: React.FC<NotesPanelProps> = ({
  meetingId, notes, aiAvailable, transcribing, onClose, onNotesChanged, onShare,
}) => {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const mine = notes.filter((n) => n.isMine !== false);
  const shared = notes.filter((n) => n.isMine === false && n.isShared);

  const refresh = useCallback(async () => {
    try {
      onNotesChanged(await meetApi.listNotes(meetingId));
    } catch { /* a failed refresh is not worth an error banner */ }
  }, [meetingId, onNotesChanged]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async <T,>(key: string, fn: () => Promise<T>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    await run('add', () => meetApi.createNote(meetingId, { body, source: 'manual' }));
    composerRef.current?.focus();
  };

  return (
    <PanelShell
      title="Your notes"
      subtitle={mine.length
        ? `${mine.length} note${mine.length === 1 ? '' : 's'}${shared.length ? ` · ${shared.length} shared with you` : ''}`
        : 'Private to you until you share one'}
      onClose={onClose}
      footer={
        <div className="space-y-2">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line. A note is usually one
              // line written in a hurry, so the fast path should be the common one.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void add(); }
            }}
            rows={2}
            placeholder="Write a note…  (Enter to save, Shift+Enter for a new line)"
            className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex flex-wrap gap-1.5">
            <PanelButton className="flex-1" disabled={!draft.trim() || busy === 'add'} onClick={() => void add()}>
              {busy === 'add' ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              Save note
            </PanelButton>
            <PanelButton
              variant="ghost"
              title={transcribing
                ? 'Save what was just said'
                : 'Needs live captions to be on'}
              disabled={!transcribing || busy === 'capture'}
              onClick={() => void run('capture', () => meetApi.captureNote(meetingId, 45))}
            >
              {busy === 'capture' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              Capture
            </PanelButton>
          </div>
          <p className="text-[10px] leading-relaxed text-white/30">
            {transcribing
              ? 'Capture saves the last 45 seconds of the conversation, so you can listen instead of typing.'
              : 'Turn on live captions to save what was just said with one tap.'}
          </p>
        </div>
      }
    >
      {error && (
        <p className="m-3 rounded-lg border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-200">
          {error}
        </p>
      )}

      {mine.length === 0 && shared.length === 0 ? (
        <PanelEmpty
          title="No notes yet."
          hint="Anything you write stays private to you unless you share it."
        />
      ) : (
        <div className="space-y-2 p-3">
          {mine.map((note) => (
            <article
              key={note.id}
              className={
                'rounded-xl border p-2.5 ' +
                (note.pinned
                  ? 'border-amber-500/30 bg-amber-500/5'
                  : 'border-white/10 bg-white/5')
              }
            >
              <header className="mb-1.5 flex items-center gap-1.5">
                {note.offsetSeconds !== null && (
                  <span className="font-mono text-[10px] text-white/30">{stamp(note.offsetSeconds)}</span>
                )}
                <SourceBadge source={note.source} />
                {note.isShared && (
                  <span className="rounded bg-blue-600/25 px-1 text-[9px] font-medium text-blue-200">
                    Shared
                  </span>
                )}
                <span className="ml-auto flex items-center gap-0.5">
                  <IconAction
                    label={note.pinned ? 'Unpin' : 'Pin to the top'}
                    onClick={() => void run(note.id,
                      () => meetApi.updateNote(meetingId, note.id, { pinned: !note.pinned }))}
                  >
                    {note.pinned ? <PinOff size={11} /> : <Pin size={11} />}
                  </IconAction>
                  <IconAction
                    label={note.isShared ? 'Stop sharing' : 'Share with everyone'}
                    active={note.isShared}
                    onClick={() => void run(note.id, async () => {
                      const updated = await meetApi.updateNote(
                        meetingId, note.id, { isShared: !note.isShared });
                      onShare(updated, !note.isShared);
                    })}
                  >
                    <Share2 size={11} />
                  </IconAction>
                  <IconAction
                    label="Delete"
                    danger
                    onClick={() => void run(note.id, () => meetApi.deleteNote(meetingId, note.id))}
                  >
                    <Trash2 size={11} />
                  </IconAction>
                </span>
              </header>

              {editing === note.id ? (
                <div className="space-y-1.5">
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={4}
                    className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
                  />
                  <div className="flex gap-1.5">
                    <PanelButton variant="ghost" onClick={() => setEditing(null)}>
                      <X size={11} /> Cancel
                    </PanelButton>
                    <PanelButton
                      className="flex-1"
                      onClick={() => void run(note.id, async () => {
                        await meetApi.updateNote(meetingId, note.id, { body: editBody });
                        setEditing(null);
                      })}
                    >
                      <Check size={11} /> Save
                    </PanelButton>
                  </div>
                </div>
              ) : (
                <p
                  onClick={() => { setEditing(note.id); setEditBody(note.body); }}
                  className="cursor-text whitespace-pre-wrap break-words text-xs leading-relaxed text-white/90"
                >
                  {note.body}
                </p>
              )}

              {editing !== note.id && (
                <footer className="mt-2 flex flex-wrap items-center gap-1.5">
                  {aiAvailable && (
                    <button
                      disabled={busy === note.id}
                      onClick={() => void run(note.id, () => meetApi.tidyNote(meetingId, note.id))}
                      className="flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60 transition-colors duration-150 hover:bg-white/15 hover:text-white disabled:opacity-40"
                    >
                      {busy === note.id
                        ? <Loader2 size={9} className="animate-spin" />
                        : <Wand2 size={9} />}
                      Tidy up
                    </button>
                  )}
                  {note.originalBody && (
                    <button
                      onClick={() => void run(note.id, () => meetApi.restoreNote(meetingId, note.id))}
                      className="flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-white/60 hover:bg-white/15 hover:text-white"
                    >
                      <Undo2 size={9} /> Undo tidy
                    </button>
                  )}
                  {note.providerUsed && (
                    <span className="text-[9px] text-white/25">tidied by {note.providerUsed}</span>
                  )}
                </footer>
              )}
            </article>
          ))}

          {shared.length > 0 && (
            <section className="pt-2">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                Shared by others
              </h3>
              <div className="space-y-2">
                {shared.map((note) => (
                  <article key={note.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-2.5">
                    <header className="mb-1 flex items-center gap-1.5">
                      {note.offsetSeconds !== null && (
                        <span className="font-mono text-[10px] text-white/25">
                          {stamp(note.offsetSeconds)}
                        </span>
                      )}
                      <span className="text-[10px] font-medium text-blue-300">{note.authorName}</span>
                    </header>
                    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-white/70">
                      {note.body}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </PanelShell>
  );
};

/** Where the text came from. Shown because "did I write this?" matters later. */
const SourceBadge: React.FC<{ source: MeetNote['source'] }> = ({ source }) => {
  if (source === 'manual') return null;
  const label = source === 'capture' ? 'From the transcript'
    : source === 'tidied' ? 'Tidied' : 'From AI';
  return (
    <span className="rounded bg-white/10 px-1 text-[9px] font-medium text-white/50">{label}</span>
  );
};

const IconAction: React.FC<{
  label: string; danger?: boolean; active?: boolean;
  onClick: () => void; children: React.ReactNode;
}> = ({ label, danger, active, onClick, children }) => (
  <button
    onClick={onClick}
    title={label}
    aria-label={label}
    className={
      'grid h-5 w-5 place-items-center rounded transition-colors duration-150 ' +
      (danger ? 'text-white/30 hover:bg-red-600/20 hover:text-red-300'
        : active ? 'text-blue-300 hover:bg-white/10'
        : 'text-white/30 hover:bg-white/10 hover:text-white')
    }
  >
    {children}
  </button>
);
