import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../../lib/api';
import type {
  MailThreadSummary, MailThreadView, MailLabel, MailboxCounts, MailFolder, MailPrefs,
  MailRecipientDelivery, MailDistributionList, MailTemplate, MailCampaignView, MailComposePayload,
  MailCampaignPayload, MailPerson, MailAiAction, MailAiComposeResult, MailAiSubjectResult,
  MailAiThreadSummary, MailAiSmartReplies, MailAiCampaignDraft,
} from '@tupo/shared';

/** The REST client for Tupo Mail. One function per endpoint, thin. */

export const getCounts = () =>
  apiGet<{ counts: MailboxCounts }>('/api/mail/counts').then((r) => r.data!.counts);

export const listLabels = () =>
  apiGet<{ labels: MailLabel[] }>('/api/mail/labels').then((r) => r.data!.labels);

export const createLabel = (name: string, color: string) =>
  apiPost<{ label: MailLabel }>('/api/mail/labels', { name, color }).then((r) => r.data!.label);

export const deleteLabel = (id: string) => apiDelete(`/api/mail/labels/${id}`);

export interface ThreadPage { threads: MailThreadSummary[]; nextCursor: string | null }

export const listThreads = (opts: {
  folder: MailFolder; label?: string; q?: string; cursor?: string;
}) => {
  const p = new URLSearchParams({ folder: opts.folder });
  if (opts.label) p.set('label', opts.label);
  if (opts.q) p.set('q', opts.q);
  if (opts.cursor) p.set('cursor', opts.cursor);
  return apiGet<ThreadPage>(`/api/mail/threads?${p}`).then((r) => r.data!);
};

export const getThread = (id: string) =>
  apiGet<{ thread: MailThreadView }>(`/api/mail/threads/${id}`).then((r) => r.data!.thread);

export const moveThread = (id: string, folder: MailFolder) =>
  apiPost(`/api/mail/threads/${id}/move`, { folder });

export const starThread = (id: string, starred: boolean) =>
  apiPost(`/api/mail/threads/${id}/star`, { starred });

export const markThread = (id: string, read: boolean) =>
  apiPost(`/api/mail/threads/${id}/read`, { read });

export const setThreadLabels = (id: string, labels: string[]) =>
  apiPost(`/api/mail/threads/${id}/labels`, { labels });

export const purgeThread = (id: string) => apiDelete(`/api/mail/threads/${id}`);

export interface ComposeResult { messageId: string; threadId: string; draft: boolean; scheduled: boolean }

export const compose = (payload: MailComposePayload) =>
  apiPost<ComposeResult>('/api/mail/compose', payload).then((r) => r.data!);

export const deleteDraft = (id: string) => apiDelete(`/api/mail/drafts/${id}`);

export const cancelScheduled = (messageId: string) =>
  apiPost(`/api/mail/messages/${messageId}/cancel`);

export const getDelivery = (messageId: string) =>
  apiGet<{ recipients: MailRecipientDelivery[] }>(`/api/mail/messages/${messageId}/delivery`)
    .then((r) => r.data!.recipients);

export const getPrefs = () =>
  apiGet<{ prefs: MailPrefs }>('/api/mail/prefs').then((r) => r.data!.prefs);

export const updatePrefs = (patch: Partial<MailPrefs>) =>
  apiPut<{ prefs: MailPrefs }>('/api/mail/prefs', patch).then((r) => r.data!.prefs);

export const searchDirectory = (q: string) =>
  apiGet<{ people: MailPerson[] }>(`/api/mail/directory?q=${encodeURIComponent(q)}`)
    .then((r) => r.data!.people);

/* Distribution lists */
export const listLists = () =>
  apiGet<{ lists: MailDistributionList[] }>('/api/mail/lists').then((r) => r.data!.lists);
export const createList = (body: { name: string; description?: string; origin?: string }) =>
  apiPost<{ list: MailDistributionList }>('/api/mail/lists', body).then((r) => r.data!.list);
export const updateList = (id: string, body: Record<string, unknown>) =>
  apiPatch<{ list: MailDistributionList }>(`/api/mail/lists/${id}`, body).then((r) => r.data!.list);
export const deleteList = (id: string) => apiDelete(`/api/mail/lists/${id}`);
export const listMembers = (id: string) =>
  apiGet<{ members: Array<{ address: string; name: string; userId: string | null; source: string }> }>(
    `/api/mail/lists/${id}/members`).then((r) => r.data!.members);
export const addMember = (id: string, body: { address: string; name?: string }) =>
  apiPost(`/api/mail/lists/${id}/members`, body);
export const removeMember = (id: string, address: string) =>
  apiDelete(`/api/mail/lists/${id}/members/${encodeURIComponent(address)}`);
export const syncList = (id: string) =>
  apiPost<{ members: number }>(`/api/mail/lists/${id}/sync`).then((r) => r.data!);

/* Templates */
export const listTemplates = () =>
  apiGet<{ templates: MailTemplate[] }>('/api/mail/templates').then((r) => r.data!.templates);
export const createTemplate = (body: Record<string, unknown>) =>
  apiPost<{ template: MailTemplate }>('/api/mail/templates', body).then((r) => r.data!.template);
export const updateTemplate = (id: string, body: Record<string, unknown>) =>
  apiPatch<{ template: MailTemplate }>(`/api/mail/templates/${id}`, body).then((r) => r.data!.template);
export const deleteTemplate = (id: string) => apiDelete(`/api/mail/templates/${id}`);

/* Campaigns */
export const listCampaigns = () =>
  apiGet<{ campaigns: MailCampaignView[] }>('/api/mail/campaigns').then((r) => r.data!.campaigns);
export const getCampaign = (id: string) =>
  apiGet<{ campaign: MailCampaignView }>(`/api/mail/campaigns/${id}`).then((r) => r.data!.campaign);
export const createCampaign = (body: MailCampaignPayload) =>
  apiPost<{ campaign: MailCampaignView }>('/api/mail/campaigns', body).then((r) => r.data!.campaign);
export const updateCampaign = (id: string, body: Partial<MailCampaignPayload>) =>
  apiPatch<{ campaign: MailCampaignView }>(`/api/mail/campaigns/${id}`, body).then((r) => r.data!.campaign);
export const deleteCampaign = (id: string) => apiDelete(`/api/mail/campaigns/${id}`);
export interface CampaignPreview {
  totalRecipients: number; requiresApproval: boolean; missingFields: string[];
  samples: Array<{ to: string; subject: string; bodyHtml: string }>;
}
export const previewCampaign = (id: string) =>
  apiGet<{ preview: CampaignPreview }>(`/api/mail/campaigns/${id}/preview`).then((r) => r.data!.preview);
export const submitCampaign = (id: string) =>
  apiPost<{ campaign: MailCampaignView }>(`/api/mail/campaigns/${id}/submit`).then((r) => r.data!.campaign);
export const approveCampaign = (id: string) =>
  apiPost<{ campaign: MailCampaignView }>(`/api/mail/campaigns/${id}/approve`).then((r) => r.data!.campaign);
export const rejectCampaign = (id: string, reason: string) =>
  apiPost<{ campaign: MailCampaignView }>(`/api/mail/campaigns/${id}/reject`, { reason }).then((r) => r.data!.campaign);
export const cancelCampaign = (id: string) => apiPost(`/api/mail/campaigns/${id}/cancel`);

/* AI assistant */
export const aiStatus = () =>
  apiGet<{ available: boolean }>('/api/mail/ai/status').then((r) => r.data!.available);

export const aiCompose = (body: {
  action: MailAiAction; instruction?: string; currentText?: string; subject?: string;
  recipients?: string[]; threadId?: string; tone?: string;
}) => apiPost<MailAiComposeResult>('/api/mail/ai/compose', body).then((r) => r.data!);

export const aiSubject = (bodyText: string) =>
  apiPost<MailAiSubjectResult>('/api/mail/ai/subject', { bodyText }).then((r) => r.data!);

export const aiSummarize = (threadId: string) =>
  apiPost<MailAiThreadSummary>('/api/mail/ai/summarize', { threadId }).then((r) => r.data!);

export const aiSmartReplies = (threadId: string) =>
  apiPost<MailAiSmartReplies>('/api/mail/ai/smart-replies', { threadId }).then((r) => r.data!);

export const aiCampaign = (brief: string, audience?: string) =>
  apiPost<MailAiCampaignDraft>('/api/mail/ai/campaign', { brief, audience }).then((r) => r.data!);

/* Attachments — reuse the files service two-step upload. */
export async function uploadAttachment(file: File): Promise<{ fileId: string; name: string; mime: string; size: number }> {
  const ticket = await apiPost<{ fileId: string; uploadUrl: string }>('/api/files/tickets', {
    name: file.name, size: file.size, mime: file.type || 'application/octet-stream',
  }).then((r) => r.data!);
  const token = localStorage.getItem('tupo_token');
  const put = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return { fileId: ticket.fileId, name: file.name, mime: file.type || 'application/octet-stream', size: file.size };
}
