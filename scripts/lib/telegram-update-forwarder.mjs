const DEFAULT_WEBHOOK_TIMEOUT_MS = 30_000;

function webhookUrl(appUrl) {
  return `${String(appUrl).replace(/\/$/, '')}/api/telegram/webhook`;
}

export async function forwardTelegramUpdate({
  appUrl,
  update,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
}) {
  try {
    const response = await fetchImpl(webhookUrl(appUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.error(`[telegram] application webhook failed: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[telegram] application webhook delivery failed:', String(error));
    return false;
  }
}

export async function deliverTelegramUpdates({ appUrl, updates, fetchImpl = fetch }) {
  let nextOffset = null;
  let delivered = 0;
  for (const update of updates) {
    const ok = await forwardTelegramUpdate({ appUrl, update, fetchImpl });
    if (!ok) break;
    delivered += 1;
    nextOffset = Number(update.update_id) + 1;
  }
  return { nextOffset, delivered };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startTelegramPolling({ appUrl, botToken, fetchImpl = fetch }) {
  let offset = 0;
  let failureDelayMs = 1_000;
  console.log('[telegram] Starting transport-only long-poll loop…');

  while (true) {
    try {
      const params = new URLSearchParams({
        offset: String(offset),
        timeout: '25',
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      });
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/getUpdates?${params}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`getUpdates HTTP ${response.status}`);
      const body = await response.json();
      if (!body.ok) throw new Error(body.description || 'getUpdates returned ok=false');

      const result = await deliverTelegramUpdates({ appUrl, updates: body.result || [], fetchImpl });
      if (result.nextOffset !== null) offset = result.nextOffset;
      if ((body.result || []).length > result.delivered) {
        await wait(failureDelayMs);
        failureDelayMs = Math.min(failureDelayMs * 2, 30_000);
        continue;
      }
      failureDelayMs = 1_000;
    } catch (error) {
      if (!String(error).includes('TimeoutError') && !String(error).includes('AbortError')) {
        console.error('[telegram] poll transport error:', String(error));
      }
      await wait(failureDelayMs);
      failureDelayMs = Math.min(failureDelayMs * 2, 30_000);
    }
  }
}
