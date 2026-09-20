import { getDb } from './db';

export type TelegramUpdateClaim = 'claimed' | 'completed' | 'in_progress';

export function claimTelegramUpdate(updateId: number): TelegramUpdateClaim {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO telegram_processed_updates (update_id, status)
    VALUES (?, 'processing')
  `).run(updateId);
  if (inserted.changes === 1) return 'claimed';

  const row = db.prepare(`
    SELECT status FROM telegram_processed_updates WHERE update_id = ?
  `).get(updateId) as { status: 'processing' | 'completed' } | undefined;
  if (row?.status === 'completed') return 'completed';

  const reclaimed = db.prepare(`
    UPDATE telegram_processed_updates
    SET claimed_at = datetime('now'), updated_at = datetime('now')
    WHERE update_id = ?
      AND status = 'processing'
      AND updated_at <= datetime('now', '-2 minutes')
  `).run(updateId);
  return reclaimed.changes === 1 ? 'claimed' : 'in_progress';
}

export function completeTelegramUpdate(updateId: number): void {
  getDb().prepare(`
    UPDATE telegram_processed_updates
    SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE update_id = ?
  `).run(updateId);
}
