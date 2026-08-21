import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CalendarPlus,
  ChevronDown,
  Loader2,
  RotateCcw,
  Sparkles,
  Mic,
  MonitorUp,
  Radio,
  ShieldCheck,
  Video,
} from "lucide-react";
import {
  DEFAULT_MEET_SETTINGS,
  CATEGORY_TO_POLICY,
  defaultMeetingName,
} from "@tupo/shared";
import type { MeetCategory, MeetSettings } from "@tupo/shared";
import { AudiencePicker } from "./AudiencePicker";
import type { DirectoryPerson } from "./api";
import { usePermissions } from "../../hooks/usePermissions";
import { Button, Card } from "../../components/ui";
import * as meetApi from "./api";

/**
 * Schedule a meeting.
 *
 * Settings that need a permission are disabled rather than hidden, with the
 * reason spelled out: a teacher who cannot record should learn that here, not
 * by finding the button greyed out mid-lesson. The server re-checks every one
 * of them regardless — this is only so the form does not lie.
 */

const RECURRENCE = [
  { value: "", label: "Does not repeat" },
  { value: "FREQ=DAILY", label: "Every day" },
  { value: "FREQ=WEEKLY", label: "Every week" },
  { value: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", label: "Every weekday" },
  { value: "FREQ=MONTHLY", label: "Every month" },
];

/** Default to the next round half-hour — nobody schedules for 14:07. */
function defaultStart(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  // datetime-local wants local wall time, and toISOString would shift it.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Whether the page has scrolled at all.
 *
 * A sticky header that is *always* a solid bar sits on the page like a
 * cut-out, separated from the content it belongs to. Letting it start
 * transparent and resolve into a bar only once something has scrolled under
 * it keeps the top of the page calm and makes the bar feel earned.
 *
 * The listener is passive: this must never contend with scrolling itself.
 */
function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    // The app scrolls an inner pane, not the window, so the nearest scrollable
    // ancestor is what has to be watched.
    const target = document.querySelector("[data-app-scroll]") ?? window;
    const read = () => {
      const y =
        target === window ? window.scrollY : (target as HTMLElement).scrollTop;
      setScrolled(y > threshold);
    };
    read();
    target.addEventListener("scroll", read, { passive: true });
    return () => target.removeEventListener("scroll", read);
  }, [threshold]);
  return scrolled;
}

export const Scheduler: React.FC = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const scrolled = useScrolled();

  // Proposed, not imposed: every meeting arrives with a name so a list of them
  // is readable, and the field is editable before anything is saved.
  const [title, setTitle] = useState(() =>
    defaultMeetingName(new Date(), "scheduled"),
  );
  const [category, setCategory] = useState<MeetCategory>("private");
  const [invitees, setInvitees] = useState<DirectoryPerson[]>([]);
  const [description, setDescription] = useState("");
  const [start, setStart] = useState(defaultStart);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [recurrence, setRecurrence] = useState("");
  const [settings, setSettings] = useState<MeetSettings>(DEFAULT_MEET_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRecord = can("MEET_RECORD");
  const canUseAi = can("MEET_AI_USE");
  const canTranscribe = can("MEET_TRANSCRIBE");

  const set = <K extends keyof MeetSettings>(key: K, value: MeetSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const startDate = new Date(start);
      const meeting = await meetApi.createMeeting({
        title: title.trim() || defaultMeetingName(startDate, "scheduled"),
        inviteeIds:
          category === "private" ? invitees.map((p) => p.id) : undefined,
        description: description.trim() || undefined,
        scheduledStart: startDate.toISOString(),
        scheduledEnd: new Date(
          startDate.getTime() + durationMinutes * 60_000,
        ).toISOString(),
        recurrenceRule: recurrence || undefined,
        mediaMode: "auto",
        settings: {
          ...settings,
          admissionPolicy: CATEGORY_TO_POLICY[category],
        },
      });
      navigate(`/app/meet/${meeting.id}/summary`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not schedule the meeting.",
      );
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="tupo-aurora mx-auto max-w-7xl space-y-5 p-4 sm:p-6 lg:px-8"
    >
      {/* Sticky, and carrying the actions.
      
          The form is two columns and several screens long, so a submit button
          at the bottom of it is a scroll away from wherever you happen to be
          when you decide you are done. Putting the actions here means they are
          always reachable — and it is where the way back belongs too, which
          this page did not offer at all. */}
      <header className="sticky top-0 z-20 -mx-4 flex flex-wrap items-end justify-between gap-3 border-b border-border-light/70 bg-background-light/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 dark:border-border-dark/50 dark:bg-background-dark/85 rounded-xl">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate("/app/meet")}
            className="mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary-light transition-colors duration-150 hover:text-text-primary-light dark:text-text-secondary-dark dark:hover:text-text-primary-dark"
          >
            <ArrowLeft size={13} /> Meet
          </button>
          <h1
            className={
              "font-semibold tracking-tight text-text-primary-light transition-[font-size] duration-200 ease-out dark:text-text-primary-dark " +
              (scrolled ? "text-lg" : "text-2xl")
            }
          >
            Schedule a meeting
          </h1>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/app/meet")}
            className="tupo-press rounded-full border border-border-light px-4 py-2.5 text-sm font-medium text-text-secondary-light transition-colors duration-150 hover:border-border-dark/30 hover:bg-surface-light hover:text-text-primary-light dark:border-border-dark dark:text-text-secondary-dark dark:hover:bg-white/5 dark:hover:text-text-primary-dark"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="tupo-press flex items-center gap-2 rounded-full bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-150 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <CalendarPlus size={15} />
            )}
            Schedule
          </button>
        </div>
      </header>

      {error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      )}

      {/* The essentials on the left, everything optional on the right. On one
          column the order is the order you would fill it in. */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 space-y-5">
          <Card className="space-y-4 p-4">
            <Field
              label="Name"
              hint="Proposed from the date and time — change it to anything you like."
            >
              <div className="flex gap-2">
                <Input
                  value={title}
                  onChange={setTitle}
                  placeholder="e.g. S4 Biology — photosynthesis"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setTitle(defaultMeetingName(new Date(start), "scheduled"))
                  }
                  title="Use the proposed name"
                >
                  <RotateCcw size={14} />
                </Button>
              </div>
            </Field>

            <Field
              label="Description"
              hint="Optional. Also what the AI uses to suggest an agenda."
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-border-light bg-white px-3 py-2 text-sm text-text-primary-light focus:border-blue-500 focus:outline-none dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts">
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  required
                  className="w-full rounded-xl border border-border-light bg-white px-3 py-2 text-sm text-text-primary-light focus:border-blue-500 focus:outline-none dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark"
                />
              </Field>
              <Field label="Length">
                <Select
                  value={String(durationMinutes)}
                  onChange={(v) => setDurationMinutes(Number(v))}
                  options={[15, 30, 45, 60, 90, 120].map((m) => ({
                    value: String(m),
                    label:
                      m >= 60
                        ? `${m / 60} hour${m > 60 ? "s" : ""}`
                        : `${m} minutes`,
                  }))}
                />
              </Field>
            </div>

            <Field label="Repeats">
              <Select
                value={recurrence}
                onChange={setRecurrence}
                options={RECURRENCE}
              />
            </Field>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              How people join
            </h2>
            <AudiencePicker
              category={category}
              invitees={invitees}
              onCategoryChange={setCategory}
              onInviteesChange={setInvitees}
            />

            <div className="my-4 h-px bg-border-light dark:bg-border-dark/40" />

            <div className="space-y-1">
              <Toggle
                label="Waiting room"
                hint="People you have not invited knock before entering."
                checked={settings.lobbyEnabled}
                onChange={(v) => set("lobbyEnabled", v)}
              />
              <Toggle
                label="Do not start until the host arrives"
                checked={settings.waitForHost}
                onChange={(v) => set("waitForHost", v)}
              />
              <Toggle
                label="Everyone joins muted"
                hint="Strongly recommended for anything larger than a handful of people."
                checked={settings.joinMuted}
                onChange={(v) => set("joinMuted", v)}
              />
              <Toggle
                label="Everyone joins with the camera off"
                checked={settings.joinCameraOff}
                onChange={(v) => set("joinCameraOff", v)}
              />
              <Toggle
                label="Let guests without an account in"
                hint="They choose a display name. Only ever offered on a public meeting."
                checked={settings.guestsAllowed && category === "public"}
                disabled={category !== "public"}
                onChange={(v) => set("guestsAllowed", v)}
              />
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              <ShieldCheck size={15} className="text-blue-500" /> What people
              can do
            </h2>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Toggle
                label="Webinar mode"
                hint="Only presenters publish video. Everyone else listens, reacts, chats and votes."
                checked={settings.webinarMode}
                onChange={(v) => set("webinarMode", v)}
              />
              <Toggle
                label="Chat"
                checked={settings.allowChat}
                onChange={(v) => set("allowChat", v)}
              />
              <Toggle
                label="Reactions"
                checked={settings.allowReactions}
                onChange={(v) => set("allowReactions", v)}
              />
              <Toggle
                label="Screen sharing"
                checked={settings.allowScreenShare}
                onChange={(v) => set("allowScreenShare", v)}
              />
              <Toggle
                label="Attendees can unmute themselves"
                hint="Turn this off and only the host can give someone the floor."
                checked={settings.allowAttendeeUnmute}
                onChange={(v) => set("allowAttendeeUnmute", v)}
              />
              <Toggle
                label="Attendees can rename themselves"
                checked={settings.allowRename}
                onChange={(v) => set("allowRename", v)}
              />
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              <Video size={15} className="text-blue-500" /> Video and bandwidth
            </h2>
            <div className="space-y-3">
              <Field
                label="Highest video quality"
                hint="Lower it for a class on mobile data — it caps what anyone sends."
              >
                <Select
                  value={settings.maxVideoQuality}
                  onChange={(v) =>
                    set("maxVideoQuality", v as MeetSettings["maxVideoQuality"])
                  }
                  options={[
                    { value: "high", label: "High — 720p" },
                    { value: "medium", label: "Medium — 360p" },
                    { value: "low", label: "Low — 180p" },
                  ]}
                />
              </Field>
              <Toggle
                label="Audio only"
                hint="No video at all. The most reliable option on a poor connection, and it holds far more people."
                checked={settings.audioOnly}
                onChange={(v) => set("audioOnly", v)}
              />
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-5 lg:sticky lg:top-6">
          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              <Sparkles size={15} className="text-blue-500" /> Notes and
              recording
            </h2>
            <div className="space-y-1">
              <Toggle
                label="Live captions and transcript"
                hint={
                  canTranscribe
                    ? "Each participant transcribes their own microphone, so notes are attributed to the right person."
                    : "You do not have permission to enable transcription."
                }
                checked={settings.transcriptionEnabled && canTranscribe}
                disabled={!canTranscribe}
                onChange={(v) => set("transcriptionEnabled", v)}
              />
              <Toggle
                label="Tupo AI notetaker"
                hint="Rolling summary, decisions and action items during the meeting."
                checked={
                  settings.aiAssistantEnabled &&
                  canUseAi &&
                  settings.transcriptionEnabled
                }
                disabled={!canUseAi || !settings.transcriptionEnabled}
                onChange={(v) => set("aiAssistantEnabled", v)}
              />
              <Toggle
                label="Minutes when it ends"
                checked={
                  settings.aiPostMeetingMinutes && settings.aiAssistantEnabled
                }
                disabled={!settings.aiAssistantEnabled}
                onChange={(v) => set("aiPostMeetingMinutes", v)}
              />
              <Toggle
                label="Participation report"
                hint="Talk-time balance and who never spoke — for the lesson record."
                checked={
                  settings.aiEngagementReport && settings.aiAssistantEnabled
                }
                disabled={!settings.aiAssistantEnabled}
                onChange={(v) => set("aiEngagementReport", v)}
              />
              <Toggle
                label="Lesson follow-up"
                hint="Revision points and practice questions from what was taught."
                checked={
                  settings.aiLessonFollowUp && settings.aiAssistantEnabled
                }
                disabled={!settings.aiAssistantEnabled}
                onChange={(v) => set("aiLessonFollowUp", v)}
              />
              <Toggle
                label="Captions on for everyone from the start"
                hint="Rather than each person switching them on themselves."
                checked={
                  settings.captionsDefaultOn && settings.transcriptionEnabled
                }
                disabled={!settings.transcriptionEnabled}
                onChange={(v) => set("captionsDefaultOn", v)}
              />
              <Toggle
                label="Rolling summary during the meeting"
                checked={settings.aiAutoSummary && settings.aiAssistantEnabled}
                disabled={!settings.aiAssistantEnabled}
                onChange={(v) => set("aiAutoSummary", v)}
              />
              <Toggle
                label="Action items"
                hint="Pulled out as they are agreed, not only at the end."
                checked={settings.aiActionItems && settings.aiAssistantEnabled}
                disabled={!settings.aiAssistantEnabled}
                onChange={(v) => set("aiActionItems", v)}
              />
              <Toggle
                label="Allow recording"
                hint={
                  canRecord
                    ? "A visible indicator runs for as long as it records."
                    : "You do not have permission to record meetings."
                }
                checked={settings.recordingEnabled && canRecord}
                disabled={!canRecord}
                onChange={(v) => set("recordingEnabled", v)}
              />
              <Toggle
                label="Start recording automatically"
                hint="Recording begins the moment the meeting does, so nobody has to remember."
                checked={
                  settings.autoRecord && canRecord && settings.recordingEnabled
                }
                disabled={!canRecord || !settings.recordingEnabled}
                onChange={(v) => set("autoRecord", v)}
              />
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
              <Radio size={15} className="text-blue-500" /> Language
            </h2>
            <div className="space-y-3">
              <Field
                label="Spoken language"
                hint="What the captions and notes expect to hear."
              >
                <Select
                  value={settings.primaryLanguage}
                  onChange={(v) => set("primaryLanguage", v)}
                  options={[
                    { value: "en", label: "English" },
                    { value: "rw", label: "Kinyarwanda" },
                    { value: "fr", label: "French" },
                  ]}
                />
              </Field>
              <Toggle
                label="Translate captions"
                hint="Each person reads them in their own language."
                checked={
                  settings.translationEnabled && settings.transcriptionEnabled
                }
                disabled={!settings.transcriptionEnabled}
                onChange={(v) => set("translationEnabled", v)}
              />
            </div>
          </Card>
        </div>
      </div>
    </form>
  );
};

/* ------------------------------------------------------------------ *
 * Form primitives
 * ------------------------------------------------------------------ */

const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <label className="block">
    <span className="mb-1 block text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark">
      {label}
    </span>
    {children}
    {hint && (
      <span className="mt-1 block text-xs text-text-secondary-light/70 dark:text-text-secondary-dark/70">
        {hint}
      </span>
    )}
  </label>
);

const Input: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}> = ({ value, onChange, placeholder }) => (
  <input
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className="w-full rounded-xl border border-border-light bg-white px-3 py-2.5 text-sm text-text-primary-light transition-colors duration-150 placeholder:text-text-secondary-light/50 hover:border-blue-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark dark:hover:border-blue-800"
  />
);

const Select: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}> = ({ value, onChange, options }) => (
  <span className="relative block">
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full appearance-none rounded-xl border border-border-light bg-white py-2.5 pl-3 pr-9 text-sm text-text-primary-light transition-colors duration-150 hover:border-blue-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark dark:text-text-primary-dark dark:hover:border-blue-800"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
    <ChevronDown
      size={15}
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary-light/60 dark:text-text-secondary-dark/60"
    />
  </span>
);

/**
 * A switch, not a checkbox.
 *
 * These settings are *states the meeting will be in*, not items being ticked
 * off a list, and a switch says that where a checkbox does not. The real
 * `<input>` stays in the DOM and keeps the label association, so it is still
 * a checkbox to assistive technology and to the keyboard — only the paint is
 * different.
 */
const Toggle: React.FC<{
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, hint, checked, disabled, onChange }) => (
  <label
    className={
      "flex items-start justify-between gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-150 " +
      (disabled
        ? "opacity-50"
        : "cursor-pointer hover:bg-surface-light dark:hover:bg-white/[0.03]")
    }
  >
    <span className="min-w-0">
      <span className="block text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
        {label}
      </span>
      {hint && (
        <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary-light dark:text-text-secondary-dark">
          {hint}
        </span>
      )}
    </span>

    <span className="relative mt-0.5 shrink-0">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={
          "block h-5 w-9 rounded-full transition-colors duration-150 " +
          "peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 " +
          "dark:peer-focus-visible:ring-offset-background-dark " +
          (checked ? "bg-blue-600" : "bg-border-light dark:bg-white/15")
        }
      />
      <span
        aria-hidden="true"
        className={
          "pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white " +
          "transition-transform duration-150 " +
          (checked ? "translate-x-4" : "translate-x-0")
        }
      />
    </span>
  </label>
);
