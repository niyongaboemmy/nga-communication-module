/**
 * Feed jobs (FR-FEED-4, FR-FEED-14).
 *
 *   feed:sweep  — publish scheduled posts whose time has come and fan them out
 *   story:sweep — expire stories past their 24 hours
 *
 * The work lives in `@tupo/feed`, shared with the API, so a scheduled post
 * publishes — and a story expires — by exactly the same path as a hand-driven
 * one would.
 */
import { runFeedSweep, runStorySweep } from '@tupo/feed';

export async function runFeedSweeps(): Promise<unknown> {
  return runFeedSweep();
}

export async function runStorySweeps(): Promise<unknown> {
  return runStorySweep();
}
