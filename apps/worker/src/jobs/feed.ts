/**
 * Feed jobs (FR-FEED-4).
 *
 *   feed:sweep — publish scheduled posts whose time has come and fan them out
 *
 * The work lives in `@tupo/feed`, shared with the API, so a scheduled post
 * publishes by exactly the same path as one published by hand.
 */
import { runFeedSweep } from '@tupo/feed';

export async function runFeedSweeps(): Promise<unknown> {
  return runFeedSweep();
}
