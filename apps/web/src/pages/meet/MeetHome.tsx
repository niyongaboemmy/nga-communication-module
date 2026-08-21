import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CalendarPlus,
  FileText,
  Loader2,
  Radio,
  Sparkles,
  Users,
  Video,
  CalendarDays,
  Clock,
} from "lucide-react";
import {
  normalizeJoinCode,
  JOIN_CODE_PATTERN,
  CATEGORY_TO_POLICY,
  type MeetCategory,
} from "@tupo/shared";
import { MeetCalendar, dayKey, type CalendarEntry } from "./MeetCalendar";
import { QuickSchedule } from "./QuickSchedule";
import { usePermissions } from "../../hooks/usePermissions";
import { Avatar, Card, EmptyState } from "../../components/ui";
import * as meetApi from "./api";

/**
 * The Meet landing screen.
 *
 * Three jobs in priority order, which is also the visual order: get into a
 * meeting that is happening now, start one, or find one that already happened.
 * A meetings list is what people arrive for least often, so it goes last.
 */

export const MeetHome: React.FC = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();

  const [meetings, setMeetings] = useState<meetApi.MeetingListItem[]>([]);
  const [capabilities, setCapabilities] =
    useState<meetApi.MeetCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<Date>(() => new Date());

  const canStart = can("MEET_START");
  const canSchedule = can("MEET_SCHEDULE");

  const load = useCallback(async () => {
    try {
      const [list, caps] = await Promise.all([
        meetApi.listMeetings("mine"),
        meetApi.getCapabilities(),
      ]);
      setMeetings(list);
      setCapabilities(caps);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load your meetings.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startInstant = async () => {
    setStarting(true);
    setError(null);
    try {
      const meeting = await meetApi.startInstant({ title: "Instant meeting" });
      navigate(`/app/meet/${meeting.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start a meeting.",
      );
      setStarting(false);
    }
  };

  /* Whether what has been typed could be a meeting code at all. The submit
     button follows this rather than "is there any text", because a button
     that is always enabled and usually 404s teaches people to distrust it. */
  const codeLooksValid = JOIN_CODE_PATTERN.test(normalizeJoinCode(code));

  const joinByCode = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeJoinCode(code);
    if (!JOIN_CODE_PATTERN.test(normalized)) {
      setError(
        "That does not look like a meeting code. They look like abc-defg-hij.",
      );
      return;
    }
    navigate(`/app/meet/${normalized}`);
  };

  /* When a meeting *happens*: the scheduled time for one that has not run,
     the actual start for one that has. Sorting and grouping both need one
     answer to that question rather than two. */
  const meetingWhen = (m: meetApi.MeetingListItem): Date | null => {
    const iso = m.scheduled_start ?? m.started_at ?? m.ended_at;
    return iso ? new Date(iso) : null;
  };

  const calendarEntries: CalendarEntry[] = useMemo(
    () =>
      meetings.flatMap((m) => {
        const when = meetingWhen(m);
        return when
          ? [
              {
                id: m.id,
                title: m.title,
                start: when.toISOString(),
                status: m.status,
              },
            ]
          : [];
      }),
    [meetings],
  );

  const dayMeetings = useMemo(() => {
    const key = dayKey(selectedDay);
    return (
      meetings
        // Live meetings have their own section directly above; listing them here
        // as well is the same meeting telling you the same thing twice.
        .filter((m) => m.status !== "live")
        .filter((m) => {
          const w = meetingWhen(m);
          return w && dayKey(w) === key;
        })
        .sort(
          (a, b) =>
            (meetingWhen(a)?.getTime() ?? 0) - (meetingWhen(b)?.getTime() ?? 0),
        )
    );
  }, [meetings, selectedDay]);

  const schedule = useCallback(
    async (input: {
      title: string;
      scheduledStart: string;
      scheduledEnd: string;
      category: MeetCategory;
    }) => {
      await meetApi.createMeeting({
        title: input.title,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        // The category *is* the admission policy; sending both keeps a meeting
        // scheduled here identical to one made in the full scheduler.
        settings: { admissionPolicy: CATEGORY_TO_POLICY[input.category] },
      });
      await load();
    },
    [load],
  );

  const live = meetings.filter((m) => m.status === "live");

  // Anything already listed under the selected day is not also "coming up" —
  // the same meeting appearing twice on one screen makes the reader check
  // whether they are in fact two meetings.
  const shownForDay = new Set(dayMeetings.map((m) => m.id));
  const upcoming = meetings.filter(
    (m) => m.status === "scheduled" && !shownForDay.has(m.id),
  );
  const past = meetings.filter(
    (m) => m.status === "ended" || m.status === "cancelled",
  );

  return (
    <div className="tupo-aurora mx-auto max-w-7xl space-y-5 p-4 sm:p-6 lg:px-8">
      {error && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {error}
        </p>
      )}

      {/* The launcher.
          
          This was two cards, each with an icon chip carrying no information, a
          heading, a sentence nobody reads, and a placeholder that already said
          what the field was — four ways of saying "join a meeting" stacked on
          top of each other. It is one row now: the two things you can do on
          the left, the one thing you can type on the right. */}
      <header className="flex flex-col gap-3 pt-2 xl:flex-row xl:items-center xl:justify-between xl:gap-6">
        <div className="flex min-w-0 items-center gap-3">
          {/* The mark, not a badge. A filled tile competes with the primary
              action for the eye, and the page already has one accent surface
              that matters — the button that starts a meeting. */}
          <Video
            size={26}
            strokeWidth={1.75}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400"
          />
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-text-primary-light dark:text-text-primary-dark">
              Meet
            </h1>
            {/* <p className="truncate text-sm text-text-secondary-light dark:text-text-secondary-dark">
              Lessons, staff meetings and parent calls — with notes taken for you.
            </p> */}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 xl:shrink-0">
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => void startInstant()}
              disabled={!canStart || starting}
              className="tupo-press flex flex-1 items-center justify-center gap-2 rounded-full bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-150 disabled:opacity-40 sm:flex-none"
            >
              {starting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <span className="relative flex h-2 w-2">
                  {/* A live dot on the primary action: this button does not
                      open a form, it puts you on camera. */}
                  <span className="tupo-live-dot absolute inset-0 rounded-full bg-white/90" />
                  <span className="relative h-2 w-2 rounded-full bg-white" />
                </span>
              )}
              Start now
            </button>

            <button
              onClick={() => navigate("/app/meet/new")}
              disabled={!canSchedule}
              className="tupo-press flex flex-1 items-center justify-center gap-2 rounded-full border border-border-light bg-white px-4 py-2.5 dark:bg-elevated-dark/60 text-sm font-medium text-text-primary-light transition-colors duration-150 hover:border-blue-300 hover:bg-surface-light disabled:opacity-40 dark:border-border-dark dark:text-text-primary-dark dark:hover:border-blue-800 dark:hover:bg-white/[0.03] sm:flex-none"
            >
              <CalendarPlus size={15} /> Schedule
            </button>
          </div>

          <form
            onSubmit={joinByCode}
            className="relative flex min-w-0 flex-1 items-center"
          >
            <label htmlFor="meet-join-code" className="sr-only">
              Meeting code
            </label>
            <input
              id="meet-join-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter a meeting code"
              // Meeting codes are lowercase letters only; the browser's
              // helpfulness here produces "Abc-Defg-Hij" and a 404.
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full min-w-0 rounded-xl border border-border-light bg-white py-2.5 pl-3 pr-11 text-sm text-text-primary-light transition-colors duration-150 placeholder:font-sans placeholder:text-text-secondary-light/60 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-border-dark dark:bg-elevated-dark/60 dark:text-text-primary-dark dark:placeholder:text-text-secondary-dark/60 dark:focus:bg-elevated-dark"
              style={{ fontFamily: code ? undefined : "inherit" }}
            />
            <button
              type="submit"
              disabled={!codeLooksValid}
              aria-label="Join this meeting"
              className={
                "absolute right-1.5 grid h-8 w-8 place-items-center rounded-full transition-all duration-150 " +
                // Only lights up once what has been typed could actually be a
                // code — an enabled button that always 404s teaches people to
                // distrust it.
                (codeLooksValid
                  ? "bg-blue-600 text-white"
                  : "bg-transparent text-text-secondary-light/40 dark:text-text-secondary-dark/40")
              }
            >
              <ArrowRight size={15} />
            </button>
          </form>
        </div>
      </header>

      {!canStart && (
        <p className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
          You can join meetings you are invited to, but not start your own.
        </p>
      )}

      {/* Deployment honesty: what this server can and cannot do. */}
      {capabilities &&
        (!capabilities.sfu || !capabilities.ai || !capabilities.turn) && (
          <div className="rounded-xl border border-border-light bg-surface-light px-3 py-2.5 text-xs leading-relaxed text-text-secondary-light dark:border-border-dark/40 dark:bg-elevated-dark/40 dark:text-text-secondary-dark">
            {!capabilities.sfu && (
              <p>
                No media server is configured, so meetings run peer-to-peer and
                are limited to{""}
                {capabilities.meshMaxParticipants} people. Create a Cloudflare
                Realtime app and set{""}
                <code>CLOUDFLARE_REALTIME_APP_ID</code> and{""}
                <code>CLOUDFLARE_REALTIME_APP_SECRET</code> to lift that — there
                is nothing to run.
              </p>
            )}
            {!capabilities.turn && (
              <p>
                No TURN server is configured — calls may fail on restricted
                networks.
              </p>
            )}
            {!capabilities.ai && (
              <p>
                No AI provider is configured, so notes and summaries are
                unavailable.
              </p>
            )}
          </div>
        )}

      {loading ? (
        <div className="grid place-items-center py-10">
          <Loader2
            size={20}
            className="animate-spin text-text-secondary-light"
          />
        </div>
      ) : (
        /* Two columns from `lg`: what is happening on the left, when things
           happen on the right. Below that the calendar drops underneath the
           agenda rather than beside it — on a phone the agenda is the answer
           and the grid is the reference. */
        <div className="space-y-5">
          {/* Full width and above the fold on every size: walking into a
              meeting that is happening now is the single most urgent thing
              this page does. */}
          {live.length > 0 && (
            <Section
              count={live.length}
              title="Happening now"
              icon={Radio}
              tone="live"
            >
              {live.map((m) => (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  onOpen={() => navigate(`/app/meet/${m.id}`)}
                />
              ))}
            </Section>
          )}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-5">
              <Card className="p-4 sm:p-5">
                <MeetCalendar
                  entries={calendarEntries}
                  selected={selectedDay}
                  onSelect={setSelectedDay}
                  onOpenEntry={(id) => {
                    const m = meetings.find((x) => x.id === id);
                    navigate(
                      m && (m.status === "ended" || m.status === "cancelled")
                        ? `/app/meet/${id}/summary`
                        : `/app/meet/${id}`,
                    );
                  }}
                />
              </Card>
              <div className="grid gap-5 sm:grid-cols-2">
                {upcoming.length > 0 && (
                  <Section
                    count={upcoming.length}
                    title="Coming up"
                    icon={CalendarPlus}
                  >
                    {upcoming.slice(0, 8).map((m) => (
                      <MeetingRow
                        key={m.id}
                        meeting={m}
                        onOpen={() => navigate(`/app/meet/${m.id}`)}
                      />
                    ))}
                  </Section>
                )}

                {past.length > 0 && (
                  <Section
                    count={past.length}
                    title="Recent"
                    icon={FileText}
                    action={
                      <button
                        onClick={() => navigate("/app/meet/history")}
                        className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-blue-600 transition-colors duration-150 hover:bg-blue-500/10 dark:text-blue-400"
                      >
                        Full history <ArrowRight size={11} />
                      </button>
                    }
                  >
                    {past.slice(0, 8).map((m) => (
                      <MeetingRow
                        key={m.id}
                        meeting={m}
                        past
                        onOpen={() => navigate(`/app/meet/${m.id}/summary`)}
                      />
                    ))}
                  </Section>
                )}
              </div>

              {meetings.length === 0 && (
                <EmptyState
                  title="No meetings yet"
                  hint={
                    canStart
                      ? "Start one now, or pick a date on the calendar to schedule one."
                      : "Meetings you are invited to will appear here."
                  }
                />
              )}
            </div>

            {/* Sticky, so the day panel stays with you down a long month. */}
            <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
              {/* The selected day, always shown — an empty day is information
                  too, and it is where the "nothing on, schedule something"
                  invitation belongs. */}
              <Section
                title={
                  isToday(selectedDay)
                    ? "Today"
                    : selectedDay.toLocaleDateString([], {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                      })
                }
                icon={CalendarDays}
              >
                {dayMeetings.length > 0 ? (
                  dayMeetings.map((m) => (
                    <MeetingRow
                      key={m.id}
                      meeting={m}
                      onOpen={() =>
                        navigate(
                          m.status === "ended" || m.status === "cancelled"
                            ? `/app/meet/${m.id}/summary`
                            : `/app/meet/${m.id}`,
                        )
                      }
                    />
                  ))
                ) : (
                  <p className="rounded-xl border border-dashed border-border-light px-3 py-4 text-center text-xs text-text-secondary-light dark:border-border-dark/60 dark:text-text-secondary-dark">
                    Nothing scheduled
                    {isToday(selectedDay) ? " today" : " that day"}.
                    {canSchedule &&
                      " Pick a time on the right to add something."}
                  </p>
                )}
              </Section>

              <Card className="space-y-4 p-4">
                {canSchedule ? (
                  <QuickSchedule
                    day={selectedDay}
                    onSchedule={schedule}
                    onOpenFull={() => navigate("/app/meet/new")}
                  />
                ) : (
                  <p className="flex items-start gap-1.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    <Clock size={13} className="mt-0.5 shrink-0" />
                    Meetings you are invited to appear here. You cannot schedule
                    your own.
                  </p>
                )}
              </Card>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
};

const isToday = (d: Date): boolean => dayKey(d) === dayKey(new Date());

/**
 * "Aline, Eric and 4 others" — names first, because a name is what tells you
 * whether this is your meeting. Falls back to the count when the roster is
 * larger than the six the server sends.
 */
function presenceSummary(m: meetApi.MeetingListItem): string {
  const present = m.present ?? [];
  if (!present.length) return "";
  const names = present.map((p) => p.name.split(" ")[0] ?? p.name);
  const others = Math.max(0, m.active_count - present.length);

  if (names.length === 1)
    return others ? `${names[0]} and ${others} others` : `${names[0]}`;
  const shown = names.slice(0, 2).join(", ");
  const rest = others + Math.max(0, names.length - 2);
  return rest ? `${shown} and ${rest} other${rest > 1 ? "s" : ""}` : `${shown}`;
}

const Section: React.FC<{
  title: string;
  icon: typeof Radio;
  tone?: "live";
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon: Icon, tone, count, action, children }) => (
  <section>
    <h2 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
      {tone === "live" ? (
        <span
          className="tupo-live-dot h-2 w-2 rounded-full bg-red-500"
          aria-hidden="true"
        />
      ) : (
        <Icon size={13} />
      )}
      {title}
      {typeof count === "number" && count > 1 && (
        <span className="rounded-full bg-surface-light px-1.5 text-[10px] font-semibold text-text-secondary-light/80 dark:bg-white/5 dark:text-text-secondary-dark/80">
          {count}
        </span>
      )}
      {action && <span className="ml-auto normal-case">{action}</span>}
    </h2>
    <div className="space-y-1.5">{children}</div>
  </section>
);

const MeetingRow: React.FC<{
  meeting: meetApi.MeetingListItem;
  past?: boolean;
  onOpen: () => void;
}> = ({ meeting, past, onOpen }) => {
  const when =
    meeting.status === "live"
      ? "Live now"
      : meeting.scheduled_start
        ? new Date(meeting.scheduled_start).toLocaleString([], {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            day: "numeric",
            month: "short",
          })
        : meeting.ended_at
          ? new Date(meeting.ended_at).toLocaleDateString([], {
              day: "numeric",
              month: "short",
            })
          : "";

  return (
    <button
      onClick={onOpen}
      className={
        "tupo-lift group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left " +
        (meeting.status === "live"
          ? // Live gets a warm border and a tinted ground, so the one meeting
            // you can actually walk into never reads as another list row.
            "border-red-500/30 bg-red-50/60 hover:border-red-400 dark:border-red-500/25 dark:bg-red-500/[0.06] dark:hover:border-red-500/50"
          : "border-border-light bg-white hover:border-blue-300 hover:bg-surface-light dark:border-border-dark/40 dark:bg-elevated-dark/40 dark:hover:border-blue-800 dark:hover:bg-elevated-dark")
      }
    >
      <span className="relative shrink-0">
        <Avatar
          name={meeting.host_name}
          src={meeting.host_avatar ?? undefined}
          size={34}
        />
        {meeting.status === "live" && (
          <span
            aria-hidden="true"
            className="tupo-live-dot absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-red-500 dark:border-elevated-dark"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">
            {meeting.title}
          </span>
          {meeting.status === "live" && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-500">
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500"
                aria-hidden="true"
              />
              Live
            </span>
          )}
          {meeting.has_minutes && (
            <Sparkles
              size={11}
              className="shrink-0 text-blue-500"
              aria-label="Has AI minutes"
            />
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          <span className="truncate">{meeting.host_name}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{when}</span>
          {meeting.active_count > 0 && !meeting.present?.length && (
            <span className="flex shrink-0 items-center gap-0.5">
              <Users size={11} /> {meeting.active_count}
            </span>
          )}
        </span>

        {/* Who is actually in there. A row of faces answers "has my class
            started without me?" in one glance, where a number does not. */}
        {!!meeting.present?.length && (
          <span className="mt-1.5 flex items-center gap-1.5">
            <span className="flex -space-x-1.5">
              {meeting.present.slice(0, 5).map((p, i) => (
                <span
                  key={`${p.name}-${i}`}
                  title={p.role === "host" ? `${p.name} (host)` : p.name}
                  className="rounded-full ring-2 ring-white dark:ring-elevated-dark"
                >
                  <Avatar name={p.name} src={p.avatar ?? undefined} size={20} />
                </span>
              ))}
            </span>
            <span className="truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
              {presenceSummary(meeting)}
            </span>
          </span>
        )}
      </span>
      {/* Live meetings get a real call to action. The whole row is still the
          control — a nested button would be a second tab stop to the same
          place — but "Join" states the offer, and lights up on hover so the
          row reads as something you act on rather than something you read. */}
      {meeting.status === "live" ? (
        <span className="flex shrink-0 items-center gap-2">
          <span className="hidden font-mono text-[11px] text-text-secondary-light/60 dark:text-text-secondary-dark/60 sm:inline">
            {meeting.join_code}
          </span>
          {/* The accent, not red. Red on a call surface means "leave", and a
              red button on a red-tinted row is the one place that reading
              really matters. */}
          <span
            aria-hidden="true"
            className="flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-transform duration-150 group-hover:scale-[1.04]"
          >
            <Video size={13} />
            Join
          </span>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className={
              past
                ? "text-[11px] font-medium text-text-secondary-light/70 dark:text-text-secondary-dark/70"
                : "rounded-md bg-surface-light px-1.5 py-0.5 font-mono text-[11px] text-text-secondary-light/70 dark:bg-white/5 dark:text-text-secondary-dark/70"
            }
          >
            {past
              ? meeting.has_minutes
                ? "Notes ready"
                : "Summary"
              : meeting.join_code}
          </span>
          <ArrowRight
            size={14}
            aria-hidden="true"
            className="-ml-1 shrink-0 text-text-secondary-light/0 transition-all duration-200 group-hover:ml-0 group-hover:text-blue-500 dark:text-text-secondary-dark/0 dark:group-hover:text-blue-400"
          />
        </span>
      )}
    </button>
  );
};
