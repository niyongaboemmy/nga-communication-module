import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarText } from '../src/pages/feed/calendar.ts';

test('an event calendar file has what calendar apps require, escaped and folded', () => {
  const ics = calendarText({
    title: 'Sports day, finals; all welcome', startsAt: '2026-11-02T08:00:00.000Z', endsAt: null,
    location: 'Main field\nGate B',
  }, 'evt-1');
  const lines = ics.split('\r\n');
  for (const required of ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR', 'BEGIN:VEVENT', 'END:VEVENT']) assert.ok(lines.includes(required), required);
  assert.ok(lines.some((l) => l.startsWith('PRODID:')));
  assert.ok(lines.some((l) => /^UID:evt-1@/.test(l)));
  assert.ok(lines.some((l) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(l)));
  assert.ok(lines.includes('DTSTART:20261102T080000Z'));
  assert.ok(lines.includes('DTEND:20261102T090000Z'), 'an hour when no end is given');
  assert.ok(lines.includes(String.raw`SUMMARY:Sports day\, finals\; all welcome`));
  assert.ok(lines.includes(String.raw`LOCATION:Main field\nGate B`));
  assert.ok(ics.endsWith('\r\n'));
});

test('long lines are folded at 75 octets', () => {
  const ics = calendarText({ title: 'x'.repeat(200), startsAt: '2026-11-02T08:00:00.000Z', endsAt: null, location: null }, 'u');
  for (const l of ics.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75, l);
  assert.ok(ics.includes('\r\n '));
});
