import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGuardianContext } from '@/lib/guardian-runtime';
import { getSchedulerStatus } from '@/lib/scheduler';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

export async function GET() {
  const now = Date.now();

  // ── Process ──────────────────────────────────────────────────────────────
  const mem = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  // ── DB ───────────────────────────────────────────────────────────────────
  let dbStatus: 'ok' | 'error' = 'ok';
  let dbSizeBytes = 0;
  let dbStats: Record<string, number> = {};

  try {
    const db = getDb();
    const dbPath = path.join(process.cwd(), 'data', 'lifeos.db');
    dbSizeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    const tables = [
      'guardian_session_summaries',
      'guardian_override_requests',
      'guardian_artifact_versions',
      'tasks',
      'habits',
      'goals',
      'mem_facts',
    ];
    for (const t of tables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
        dbStats[t] = row.c;
      } catch { dbStats[t] = -1; }
    }
  } catch {
    dbStatus = 'error';
  }

  // ── Guardian ─────────────────────────────────────────────────────────────
  const { activeSession } = getGuardianContext();

  // ── Scheduler ────────────────────────────────────────────────────────────
  const scheduler = getSchedulerStatus();

  // ── OS ───────────────────────────────────────────────────────────────────
  const loadAvg = os.loadavg();
  const freeMem = os.freemem();
  const totalMem = os.totalmem();

  // ── Log files ────────────────────────────────────────────────────────────
  const logsDir = path.join(process.cwd(), 'logs');
  const logFiles: Record<string, number> = {};
  for (const f of ['server.log', 'server-error.log', 'daemon.log', 'daemon-error.log']) {
    const p = path.join(logsDir, f);
    logFiles[f] = fs.existsSync(p) ? fs.statSync(p).size : 0;
  }

  return NextResponse.json({
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    timestamp: new Date(now).toISOString(),
    uptime: {
      seconds: uptimeSeconds,
      human: formatUptime(uptimeSeconds),
    },
    process: {
      heapUsedMb: round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: round(mem.heapTotal / 1024 / 1024),
      rssMb: round(mem.rss / 1024 / 1024),
      externalMb: round(mem.external / 1024 / 1024),
    },
    os: {
      loadAvg1m: round(loadAvg[0]),
      loadAvg5m: round(loadAvg[1]),
      freeMemMb: round(freeMem / 1024 / 1024),
      totalMemMb: round(totalMem / 1024 / 1024),
      memUsedPct: round((1 - freeMem / totalMem) * 100),
    },
    db: {
      status: dbStatus,
      sizeMb: round(dbSizeBytes / 1024 / 1024),
      rows: dbStats,
    },
    guardian: {
      activeSession: activeSession
        ? {
            sessionId: activeSession.sessionId,
            targetTitle: activeSession.targetTitle,
            state: activeSession.state,
            focusScore: activeSession.focusScoreHistory?.slice(-1)[0] ?? null,
          }
        : null,
    },
    scheduler: {
      initialized: scheduler.initialized,
      jobs: scheduler.jobs.map(j => ({
        name: j.name,
        schedule: j.schedule,
        lastRun: j.lastRun,
        nextRun: j.nextRun,
        running: j.running,
      })),
    },
    logs: logFiles,
  });
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
