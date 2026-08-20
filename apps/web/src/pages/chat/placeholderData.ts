import type { Conversation, Member, Message } from './types';

/**
 * PLACEHOLDER CONTENT — not real data, and not a mock of an API that exists.
 *
 * Phase 1 is what builds `/api/conversations`, `/api/messages` and the realtime
 * gateway (SRS §17). Until then this module is what lets the redesigned layout
 * be reviewed, styled and tested against realistic density: long names, long
 * messages, mixed reactions, a failed send, a pending send, a system notice.
 *
 * Delete this file when the Phase 1 endpoints land. `useChatData()` in
 * `data.ts` is the single import site, so removing it is a one-line change.
 */

const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

export const PLACEHOLDER_CONVERSATIONS: Conversation[] = [
  {
    id: 'c-staff', kind: 'channel', name: 'staff-room', topic: 'Anything and everything, staff only',
    unread: 3, mention: true, starred: true, muted: false, memberCount: 48,
    lastMessage: { author: 'Aline U.', preview: '@you could you cover period 4 tomorrow?', at: minutesAgo(4) },
  },
  {
    id: 'c-announce', kind: 'announcement', name: 'school-announcements', topic: 'Read-only for most members',
    unread: 1, mention: false, starred: true, muted: false, memberCount: 1240,
    lastMessage: { author: 'Head Teacher', preview: 'Term 3 reports are published on the MIS.', at: hoursAgo(2) },
  },
  {
    id: 'c-4b', kind: 'channel', name: 'class-4b', topic: 'Homework, notices and questions for S4B',
    unread: 12, mention: false, starred: false, muted: false, memberCount: 34,
    lastMessage: { author: 'Eric N.', preview: 'Sir, is the chemistry practical still on Friday?', at: minutesAgo(26) },
  },
  {
    id: 'c-science', kind: 'channel', name: 'science-dept', topic: 'Lab bookings and scheme of work',
    unread: 0, mention: false, starred: false, muted: true, memberCount: 11,
    lastMessage: { author: 'Jean P.', preview: 'Lab 2 is booked all of Thursday.', at: hoursAgo(6) },
  },
  {
    id: 'g-exams', kind: 'group', name: 'Exams working group', unread: 0, mention: false,
    starred: false, muted: false, memberCount: 6,
    lastMessage: { author: 'You', preview: 'Sent the draft timetable.', at: daysAgo(1) },
  },
  {
    id: 'd-aline', kind: 'dm', name: 'Aline Uwase', topic: 'Deputy Head — Academics', presence: 'online',
    unread: 2, mention: true, starred: true, muted: false,
    lastMessage: { author: 'Aline Uwase', preview: 'Perfect, thank you.', at: minutesAgo(12) },
  },
  {
    id: 'd-jean', kind: 'dm', name: 'Jean-Paul Habimana', topic: 'Chemistry teacher', presence: 'busy',
    unread: 0, mention: false, starred: false, muted: false,
    lastMessage: { author: 'You', preview: 'I will send the marks tonight.', at: hoursAgo(3) },
  },
  {
    id: 'd-claudine', kind: 'dm', name: 'Claudine Mukamana', topic: 'Parent — S4B', presence: 'away',
    unread: 0, mention: false, starred: false, muted: false,
    lastMessage: { author: 'Claudine Mukamana', preview: 'Thank you for the update on Eric.', at: daysAgo(2) },
  },
  {
    id: 'd-ops', kind: 'dm', name: 'Emmanuel Ndayisaba', topic: 'ICT support', presence: 'offline',
    unread: 0, mention: false, starred: false, muted: false,
    lastMessage: { author: 'Emmanuel Ndayisaba', preview: 'Projector in Lab 1 is fixed.', at: daysAgo(4) },
  },
];

export const PLACEHOLDER_MESSAGES: Record<string, Message[]> = {
  'c-staff': [
    {
      id: 'm1', authorId: 'u-sys', authorName: 'Tupo', body: 'Aline Uwase set the topic to "Anything and everything, staff only".',
      at: daysAgo(1), system: true,
    },
    {
      id: 'm2', authorId: 'u-aline', authorName: 'Aline Uwase', authorRole: 'Deputy Head',
      body: 'Morning everyone. Reminder that the S4 mock timetable goes out this afternoon — please check your invigilation slots and flag clashes before 16:00.',
      at: hoursAgo(5), status: 'read',
      reactions: [{ emoji: '👍', count: 7, mine: true }, { emoji: '🙏', count: 2, mine: false }],
      replyCount: 4,
    },
    {
      id: 'm3', authorId: 'u-jean', authorName: 'Jean-Paul Habimana', authorRole: 'Chemistry',
      body: 'I have a clash on Wednesday — I am down for both Lab 2 and invigilation in Hall B.',
      at: hoursAgo(4), status: 'read',
    },
    {
      id: 'm4', authorId: 'u-jean', authorName: 'Jean-Paul Habimana', authorRole: 'Chemistry',
      body: 'Happy to take the lab if someone can swap the hall.',
      at: hoursAgo(4), status: 'read',
      reactions: [{ emoji: '✅', count: 1, mine: false }],
    },
    {
      id: 'm5', authorId: 'me', authorName: 'You',
      body: 'I can take Hall B on Wednesday. Attaching the revised sheet.',
      at: hoursAgo(3), status: 'read',
      attachments: [{ id: 'a1', name: 'S4-mock-invigilation-v2.xlsx', size: '84 KB', kind: 'document' }],
    },
    {
      id: 'm6', authorId: 'u-aline', authorName: 'Aline Uwase', authorRole: 'Deputy Head',
      body: 'Perfect — updated. @you could you cover period 4 tomorrow as well? Marie is at the district meeting.',
      at: minutesAgo(4), status: 'delivered',
    },
    {
      id: 'm7', authorId: 'me', authorName: 'You', body: 'Yes, that works.',
      at: minutesAgo(1), status: 'pending',
    },
    {
      id: 'm8', authorId: 'me', authorName: 'You', body: 'I will bring the marked scripts with me.',
      at: minutesAgo(1), status: 'failed',
    },
  ],
};

export const PLACEHOLDER_MEMBERS: Member[] = [
  { id: 'u-aline', name: 'Aline Uwase', role: 'Deputy Head — Academics', presence: 'online' },
  { id: 'u-jean', name: 'Jean-Paul Habimana', role: 'Chemistry teacher', presence: 'busy' },
  { id: 'u-marie', name: 'Marie Ingabire', role: 'Mathematics teacher', presence: 'away' },
  { id: 'u-emma', name: 'Emmanuel Ndayisaba', role: 'ICT support', presence: 'offline' },
  { id: 'u-grace', name: 'Grace Mutesi', role: 'Head of English', presence: 'online' },
];
