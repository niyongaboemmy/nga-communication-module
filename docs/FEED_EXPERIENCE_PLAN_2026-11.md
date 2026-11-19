# Tupo feed: interaction gap analysis and implementation plan

**Date:** 19 November 2026
**Branch:** `feat/feed-experience` (from `main` ccf467d)

**Method:**
- Code review of `apps/web/src/pages/feed` (6.7k lines), `packages/feed` and `apps/api/src/routes/feed.ts`.
- A live run: a page seeded through the real composer with 3 photos, a 6 s video, a PDF and a link post, screenshotted at desktop and phone sizes.
- The user's report that a page image fails or is slow to update.

---

## 1. What is already solid

These are kept as they are:
- **Media viewer:** pinch, double-tap zoom, swipe between items, swipe down to close, download, thumbnails.
- **Photo collages** in Facebook's layouts, which keep each photo's shape.
- **Reactions:** hold for more, keyboard access, and a list of who reacted.
- **Feed list:** pull to refresh, infinite scroll, and skeletons on first load.
- **Comments:** replies, edit and delete.

## 2. Gaps

Severity: **High** = broken or misleading · **Medium** = missing interaction people expect · **Low** = polish.

| ID | Sev | Area | Gap (evidence) |
|---|---|---|---|
| F-01 | High | Images | **A page photo update does not reach the rest of the feed** (reported). After a new avatar or cover, the "Your pages" sidebar, the suggestions and every post card keep the old image (or initials) until a reload. Only the page screen refreshes (`PageScreens.uploadBranding` calls `setPage` locally; `FeedProvider`'s lists are never told). |
| F-02 | High | Images | `useMediaUrl` never resets when its file id changes. While a new id resolves it keeps showing the **previous** picture, and when the id is cleared it keeps the stale one for good. |
| F-03 | High | Video | In-post video autoplays **muted with no controls**: no unmute, no progress, no duration, no buffering state. Sound is reachable only by opening the viewer (live run: `controls:false, muted:true`; the only button is "Play video"). |
| F-04 | Medium | Video | Opening the viewer restarts the video from 0 instead of continuing where the inline video was. The viewer shows no buffering state. |
| F-05 | High | Previews | **Link posts never get a preview card.** The composer never fetches one and the server never unfurls feed posts (live run: the MDN link post shows bare text). |
| F-06 | Medium | Previews | Documents can only be downloaded: no in-app preview of a PDF or an image file, no feedback while downloading. The size shows "0.0 MB" for small files. |
| F-07 | High | Sharing | **Share is only the OS sheet or a silent copy.** There is no way to send a post into a Tupo chat. When the clipboard is refused it just says "Could not copy the link" and offers nothing else (live run). Chat already accepts a `post_share` message type, but nothing sends or renders it. |
| F-08 | High | Feedback | **Delete post** uses the browser's native `confirm()`, and the post stays on screen until a socket event (none if the socket is down). **Move to drafts** leaves the post in place with no confirmation. |
| F-09 | Medium | Feedback | The feed's error state has no Try again button. The page screen and comments have the same issue. |
| F-10 | Low | Reading | "See more" has no "See less". The clamp is by characters, so it can cut mid-emoji line. |
| F-11 | Low | Design | New and touched surfaces must follow the NGA rules (blue only, no shadows). The post menu and reactors dialog use shadows. |

## 3. Plan

| Phase | Items | What ships |
|---|---|---|
| **P1 Images stay current** | F-01, F-02 | `useMediaUrl` resets per id. A `feed:page-updated` event updates the sidebar, suggestions and every loaded post card of that page at once. |
| **P2 Honest feedback** | F-08, F-09, F-10 | An in-app confirm for delete, with the post removed at once (restored on failure). Move to drafts removes the post, with a toast and an "Open drafts" action. Try again on every error state. See less. |
| **P3 Video people can control** | F-03, F-04 | An inline control strip: tap to unmute or mute (remembered per device, a single sound source), a progress bar, remaining time, and a buffering spinner. The viewer continues from the inline position and shows buffering. |
| **P4 Previews** | F-05, F-06 | `POST /api/feed/link-preview` reuses chat's SSRF-guarded `fetchPreview`. The composer detects the first link and shows a removable preview card, with a skeleton while it loads. The preview is published with the post. Documents get a preview viewer (PDF inline, image files in the media viewer), a busy state on download, and readable sizes. |
| **P5 Sharing** | F-07 | A share sheet with four ways out: **Send in chat** (search conversations, then send a `post_share` message), **Copy link** (with a visible link field when the clipboard is refused), **Share via…** (the OS sheet, where available) and **Open post**. Chat renders `post_share` as a post card that fetches the post with the viewer's own permissions, so nothing leaks to someone who cannot see it. Every share counts. |
| **P6 Tests and polish** | F-11 + all | Suite `verify:feed:experience` covering each item, with screenshots. Regression of `verify:feed`, `verify:feed:ui`, `verify:feed:media`, the API tests and the bundle budget. |

## 4. Acceptance

1. **F-01/F-02:** after changing a page photo, the sidebar row and that page's post cards show the new image within 1 s, with no reload.
2. **F-03:** an in-post video can be unmuted and muted in place, shows progress and time left, and shows a spinner while buffering.
3. **F-04:** opening the viewer continues from the inline position.
4. **F-05:** typing a link in the composer shows a preview card (or nothing, if the site has none). The published post shows it.
5. **F-06:** a PDF opens in an in-app preview. Download shows progress. Sizes read "12 KB" and "3.4 MB".
6. **F-07:** Share opens a sheet. Send in chat delivers a post card the recipient can open. Copy link works, or shows the link to copy by hand.
7. **F-08:** deleting asks in-app, and the post disappears at once. Move to drafts removes it and says where it went.
8. **F-09:** every error state has a working Try again.

## 5. Status

| Phase | Commit | Result |
|---|---|---|
| P1 | | |
| P2 | | |
| P3 | | |
| P4 | | |
| P5 | | |
| P6 | | |
