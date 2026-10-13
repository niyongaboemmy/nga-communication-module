import type { FeedEventView } from '@tupo/shared';

/** The ICS text for an event. */
export function calendarText(e: Pick<FeedEventView, 'title' | 'startsAt' | 'endsAt' | 'location'>, uid = `${e.title}-${e.startsAt}`): string {
  const fmt = (d: string | Date) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const fold = (line: string) => {
    const out: string[] = [];
    let rest = line;
    while (new TextEncoder().encode(rest).length > 75) {
      let cut = 75;
      while (new TextEncoder().encode(rest.slice(0, cut)).length > 75) cut--;
      out.push(rest.slice(0, cut));
      rest = ` ${rest.slice(cut)}`;
    }
    out.push(rest);
    return out.join('\r\n');
  };
  const end = e.endsAt ?? new Date(new Date(e.startsAt).getTime() + 3600_000).toISOString();
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NGA//Tupo Feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid.replace(/[^A-Za-z0-9.-]/g, '')}@tupo.amashuri.com`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(e.startsAt)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(e.title)}`,
    e.location ? `LOCATION:${esc(e.location)}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).map(fold).join('\r\n') + '\r\n';
  return ics;
}

/**
 * A calendar file every calendar app accepts (D-10): the UID, DTSTAMP and
 * PRODID it must carry, text escaped (commas, semicolons, new lines), long
 * lines folded at 75 octets, and an end time (an hour, when none is given).
 */
export function calendarLink(e: FeedEventView, uid?: string): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(calendarText(e, uid))}`;
}
