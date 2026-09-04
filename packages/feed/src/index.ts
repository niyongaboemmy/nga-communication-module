/**
 * @tupo/feed — the Feed domain (SRS §6.7, FR-FEED-1…12).
 *
 * Imported by tupo-api (REST) and tupo-worker (the scheduled-publish sweep).
 * Every authorisation decision — who may post as a page, who may see a post,
 * who may moderate — lives here, so the REST route and the socket path cannot
 * enforce different rules.
 */
export { FeedError } from './errors.js';
export {
  type FeedActor, type RoleLevel, visibleAudiences, canTargetAudience,
} from './common.js';

export * as pages from './pages.js';
export * as posts from './posts.js';
export * as comments from './comments.js';
export * as reactions from './reactions.js';
export * as polls from './polls.js';
export * as engagement from './engagement.js';
export * as moderation from './moderation.js';
export * as analytics from './analytics.js';

export { getFeed } from './feed.js';
export { publishDueScheduledPosts, hydratePosts, getPostView } from './posts.js';
export { ensureMandatoryFollows } from './pages.js';

import { publishDueScheduledPosts } from './posts.js';

/** Worker sweep entry point — publish scheduled posts whose time has come. */
export async function runFeedSweep(): Promise<{ published: number }> {
  const { published } = await publishDueScheduledPosts();
  return { published: published.length };
}
