import { apiGet, apiPost, apiPatch, apiDelete } from '../../lib/api';
import type {
  ComposePostPayload, CreatePagePayload, EditPostPayload, FeedCommentView, FeedFilter,
  FeedPageAnalytics, FeedPageDetail, FeedPageSummary, FeedPollView, FeedPostView,
  FeedReaction, FeedReactionSummary, FeedReportReason, FeedSort, FeedTimelinePage,
  UpdatePagePayload,
} from '@tupo/shared';

/** REST client for Tupo Feed — one thin function per endpoint. */

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const getFeed = (opts: { cursor?: string; sort?: FeedSort; filter?: FeedFilter } = {}) =>
  apiGet<FeedTimelinePage>(`/api/feed${qs({ cursor: opts.cursor, sort: opts.sort, filter: opts.filter })}`)
    .then((r) => r.data!);

export const getBookmarks = (cursor?: string) =>
  apiGet<FeedTimelinePage>(`/api/feed/bookmarks${qs({ cursor })}`).then((r) => r.data!);

export const getPost = (id: string) =>
  apiGet<{ post: FeedPostView }>(`/api/feed/posts/${id}`).then((r) => r.data!.post);

export const listPages = (opts: { mine?: boolean; kind?: string; q?: string } = {}) =>
  apiGet<{ pages: FeedPageSummary[] }>(
    `/api/feed/pages${qs({ mine: opts.mine ? '1' : undefined, kind: opts.kind, q: opts.q })}`,
  ).then((r) => r.data!.pages);

export const getPage = (idOrSlug: string) =>
  apiGet<{ page: FeedPageDetail }>(`/api/feed/pages/${idOrSlug}`).then((r) => r.data!.page);

export const createPage = (payload: CreatePagePayload) =>
  apiPost<{ page: FeedPageDetail }>('/api/feed/pages', payload).then((r) => r.data!.page);

export const updatePage = (id: string, patch: UpdatePagePayload) =>
  apiPatch<{ page: FeedPageDetail }>(`/api/feed/pages/${id}`, patch).then((r) => r.data!.page);

export const deletePage = (id: string) => apiDelete(`/api/feed/pages/${id}`);

export const followPage = (id: string, notify = true) =>
  apiPost<{ page: FeedPageSummary }>(`/api/feed/pages/${id}/follow`, { notify }).then((r) => r.data!.page);

export const unfollowPage = (id: string) =>
  apiDelete<{ page: FeedPageSummary }>(`/api/feed/pages/${id}/follow`).then((r) => r.data!.page);

export const setPageNotify = (id: string, notify: boolean) =>
  apiPost(`/api/feed/pages/${id}/notify`, { notify });

export const addEditor = (id: string, userId: string, role: 'owner' | 'editor') =>
  apiPost<{ page: FeedPageDetail }>(`/api/feed/pages/${id}/editors`, { userId, role }).then((r) => r.data!.page);

export const removeEditor = (id: string, userId: string) =>
  apiDelete<{ page: FeedPageDetail }>(`/api/feed/pages/${id}/editors/${userId}`).then((r) => r.data!.page);

export const getPagePosts = (id: string, opts: { cursor?: string; sort?: FeedSort } = {}) =>
  apiGet<FeedTimelinePage>(`/api/feed/pages/${id}/posts${qs({ cursor: opts.cursor, sort: opts.sort })}`)
    .then((r) => r.data!);

export const getPageAnalytics = (id: string, range: '7d' | '30d' | 'all') =>
  apiGet<{ analytics: FeedPageAnalytics }>(`/api/feed/pages/${id}/analytics${qs({ range })}`)
    .then((r) => r.data!.analytics);

export const createPost = (pageId: string, payload: Omit<ComposePostPayload, 'pageId'>) =>
  apiPost<{ postId: string; status: string }>(`/api/feed/pages/${pageId}/posts`, payload).then((r) => r.data!);

export const editPost = (id: string, patch: EditPostPayload) =>
  apiPatch<{ post: FeedPostView | null }>(`/api/feed/posts/${id}`, patch).then((r) => r.data!.post);

export const publishPost = (id: string) =>
  apiPost<{ post: FeedPostView }>(`/api/feed/posts/${id}/publish`).then((r) => r.data!.post);

export const unpublishPost = (id: string) => apiPost(`/api/feed/posts/${id}/unpublish`);
export const deletePost = (id: string) => apiDelete(`/api/feed/posts/${id}`);

export const reactToPost = (id: string, emoji: FeedReaction | null) =>
  (emoji === null
    ? apiDelete<{ reactions: FeedReactionSummary }>(`/api/feed/posts/${id}/reactions`)
    : apiPost<{ reactions: FeedReactionSummary }>(`/api/feed/posts/${id}/reactions`, { emoji })
  ).then((r) => r.data!.reactions);

export const reactToComment = (id: string, emoji: FeedReaction | null) =>
  (emoji === null
    ? apiDelete<{ reactionCount: number }>(`/api/feed/comments/${id}/reactions`)
    : apiPost<{ reactionCount: number }>(`/api/feed/comments/${id}/reactions`, { emoji })
  ).then((r) => r.data!.reactionCount);

export interface CommentPage { items: FeedCommentView[]; nextCursor: string | null; }

export const listComments = (postId: string, cursor?: string) =>
  apiGet<CommentPage>(`/api/feed/posts/${postId}/comments${qs({ cursor })}`).then((r) => r.data!);

export const listReplies = (commentId: string, cursor?: string) =>
  apiGet<CommentPage>(`/api/feed/comments/${commentId}/replies${qs({ cursor })}`).then((r) => r.data!);

export const addComment = (postId: string, body: string, parentId?: string) =>
  apiPost<{ comment: FeedCommentView }>(`/api/feed/posts/${postId}/comments`, { body, parentId })
    .then((r) => r.data!.comment);

export const editComment = (id: string, body: string) =>
  apiPatch<{ comment: FeedCommentView }>(`/api/feed/comments/${id}`, { body }).then((r) => r.data!.comment);

export const deleteComment = (id: string) => apiDelete(`/api/feed/comments/${id}`);

export const votePoll = (postId: string, choices: number[]) =>
  apiPost<{ poll: FeedPollView }>(`/api/feed/posts/${postId}/vote`, { choices }).then((r) => r.data!.poll);

export const rsvpEvent = (postId: string, going: boolean) =>
  apiPost<{ going: boolean; goingCount: number }>(`/api/feed/posts/${postId}/rsvp`, { going }).then((r) => r.data!);

export const recordView = (id: string) => apiPost(`/api/feed/posts/${id}/view`).catch(() => {});
export const sharePost = (id: string) =>
  apiPost<{ shareCount: number }>(`/api/feed/posts/${id}/share`).then((r) => r.data!.shareCount);
export const bookmarkPost = (id: string) => apiPost(`/api/feed/posts/${id}/bookmark`);
export const unbookmarkPost = (id: string) => apiDelete(`/api/feed/posts/${id}/bookmark`);

export const reportPost = (id: string, reason: FeedReportReason, note?: string) =>
  apiPost(`/api/feed/posts/${id}/report`, { reason, note });
export const reportComment = (id: string, reason: FeedReportReason, note?: string) =>
  apiPost(`/api/feed/comments/${id}/report`, { reason, note });

export interface FeedReportListItem { reports: import('@tupo/shared').FeedReportView[]; }

export const getModerationQueue = (status: 'open' | 'actioned' | 'dismissed' = 'open') =>
  apiGet<FeedReportListItem>(`/api/feed/moderation${qs({ status })}`).then((r) => r.data!.reports);

export const actOnReport = (id: string, action: 'remove' | 'warn' | 'dismiss', note?: string) =>
  apiPost(`/api/feed/moderation/${id}/act`, { action, note });
