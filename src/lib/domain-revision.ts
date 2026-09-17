import { getDb } from './db';

export interface DomainRevision {
  revision: number;
  updatedAt: string | null;
}

export function getDomainRevision(): DomainRevision {
  const row = getDb().prepare(`
    SELECT revision, updated_at FROM domain_revisions WHERE scope='global'
  `).get() as { revision: number; updated_at: string } | undefined;
  return {
    revision: Math.max(0, Number(row?.revision ?? 0)),
    updatedAt: row?.updated_at ?? null,
  };
}
