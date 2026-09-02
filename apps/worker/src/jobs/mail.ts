/**
 * Mail jobs (FR-MAIL-7, FR-MAIL-8, FR-MAIL-10).
 *
 *   mail:send       — deliver one message's SMTP copies right after it is sent
 *   mail:campaign   — fan a bulk send out to its recipients and track delivery
 *   mail:list-sync  — re-materialise one distribution list
 *   mail:sweep      — the safety net: scheduled sends whose time has come,
 *                     due campaigns, queued SMTP the immediate job missed,
 *                     and a periodic re-sync of every derived list
 *
 * Everything the jobs actually do lives in `@tupo/mail`, shared with the API,
 * so "who may receive this" is decided in exactly one place.
 */
import {
  deliverSmtp, runCampaign, runDueCampaigns, syncList, syncAllLists,
  dispatchPendingSmtp, sendDueScheduled,
} from '@tupo/mail';

export async function runMailSend(data: { messageId: string }): Promise<unknown> {
  return deliverSmtp(data.messageId);
}

export async function runMailCampaign(data: { campaignId: string }): Promise<unknown> {
  return runCampaign(data.campaignId);
}

export async function runMailListSync(data: { listId: string }): Promise<unknown> {
  return syncList(data.listId);
}

let lastListSync = 0;
const LIST_RESYNC_MS = 15 * 60_000;

/**
 * The periodic sweep. Cheap when there is nothing to do — a handful of indexed
 * lookups that usually return no rows.
 */
export async function runMailSweeps(): Promise<unknown> {
  const scheduled = await sendDueScheduled();
  const smtp = await dispatchPendingSmtp();
  const campaigns = await runDueCampaigns();

  let lists: { lists: number; members: number } | null = null;
  if (Date.now() - lastListSync > LIST_RESYNC_MS) {
    lists = await syncAllLists();
    lastListSync = Date.now();
  }

  return { scheduled, smtp, campaigns, lists };
}
