import { getDb } from './db';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ============================================================
//  macOS SCREEN TIME — Reads per-app usage from KnowledgeC.db
//  This is the system SQLite database that tracks app usage.
// ============================================================

interface ScreenTimeEntry {
    app_name: string;
    bundle_id: string;
    usage_seconds: number;
    category: string;
    date: string;
}

// Common app → category mapping
const APP_CATEGORIES: Record<string, string> = {
    // Productive
    'com.apple.dt.Xcode': 'productive',
    'com.microsoft.VSCode': 'productive',
    'com.googlecode.iterm2': 'productive',
    'com.apple.Terminal': 'productive',
    'com.github.Electron': 'productive', // Generic Electron (VS Code, etc.)
    'com.figma.Desktop': 'productive',
    'com.linear': 'productive',
    'com.tinyspeck.slackmacgap': 'neutral', // Slack
    'com.hnc.Discord': 'neutral',
    'us.zoom.xos': 'neutral',

    // Browsers (can be either)
    'com.apple.Safari': 'neutral',
    'com.google.Chrome': 'neutral',
    'org.mozilla.firefox': 'neutral',
    'com.brave.Browser': 'neutral',
    'company.thebrowser.Browser': 'neutral', // Arc

    // Distraction
    'com.apple.MobileSMS': 'distraction',
    'com.apple.iChat': 'distraction',
    'com.tweetbot.whale': 'distraction',

    // System (ignore)
    'com.apple.finder': 'system',
    'com.apple.SystemPreferences': 'system',
    'com.apple.loginwindow': 'system',
    'com.apple.Spotlight': 'system',
};

/**
 * Collect screen time data from macOS KnowledgeC database.
 * Falls back to `lsappinfo` if KnowledgeC is not accessible.
 */
export function collectScreenTime(date?: string): ScreenTimeEntry[] {
    const targetDate = date || new Date(Date.now() + 19800000).toISOString().slice(0, 10);

    // Try KnowledgeC database first
    const knowledgeCPath = path.join(
        os.homedir(),
        'Library/Application Support/Knowledge/knowledgeC.db'
    );

    if (fs.existsSync(knowledgeCPath)) {
        try {
            return readKnowledgeC(knowledgeCPath, targetDate);
        } catch (err) {
            console.error('KnowledgeC read failed (may need Full Disk Access):', err);
        }
    }

    // Fallback: use `lsappinfo` for currently running apps
    try {
        return getRunningAppsUsage(targetDate);
    } catch (err) {
        console.error('App usage fallback failed:', err);
        return [];
    }
}

/**
 * Read app usage from the macOS KnowledgeC SQLite database.
 * Requires Full Disk Access permission for the terminal/app.
 */
function readKnowledgeC(dbPath: string, date: string): ScreenTimeEntry[] {
    try {
        // Use sqlite3 CLI to read (avoids locking issues with better-sqlite3)
        const query = `
      SELECT
        ZOBJECT.ZVALUESTRING as bundle_id,
        SUM(ZOBJECT.ZENDDATE - ZOBJECT.ZSTARTDATE) as usage_seconds
      FROM ZOBJECT
      WHERE ZSTREAMNAME = '/app/usage'
        AND datetime(ZOBJECT.ZSTARTDATE + 978307200, 'unixepoch', 'localtime') LIKE '${date}%'
        AND ZOBJECT.ZVALUESTRING IS NOT NULL
        AND ZOBJECT.ZENDDATE IS NOT NULL
        AND ZOBJECT.ZSTARTDATE IS NOT NULL
      GROUP BY ZOBJECT.ZVALUESTRING
      HAVING usage_seconds > 30
      ORDER BY usage_seconds DESC;
    `;

        let output = '';
        try {
            output = execSync(
                `sqlite3 -separator '|' "${dbPath}" "${query}"`,
                { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
            ).toString().trim();
        } catch (execErr: any) {
            const stderr = execErr.stderr ? execErr.stderr.toString() : String(execErr);
            if (stderr.includes('authorization denied') || stderr.includes('Operation not permitted')) {
                console.warn('\n⚠️  [ScreenTime] Native Mac App tracking paused.');
                console.warn('⚠️  To track native apps, grant "Full Disk Access" to your Terminal app in your Mac System Settings -> Privacy & Security.\n');
                return [];
            }
            console.error('[ScreenTime] SQLite query failed:', stderr);
            return [];
        }

        if (!output) return [];

        return output.split('\n').map(line => {
            const [bundle_id, seconds] = line.split('|');
            const usage_seconds = Math.round(parseFloat(seconds) || 0);
            const app_name = bundle_id.split('.').pop() || bundle_id;
            const category = APP_CATEGORIES[bundle_id] || categorizeByName(app_name);

            return { app_name, bundle_id, usage_seconds, category, date };
        }).filter(e => e.category !== 'system' && e.usage_seconds > 60);
    } catch {
        return [];
    }
}

/**
 * Fallback: get currently running apps and estimate usage.
 * This is less accurate but doesn't need Full Disk Access.
 */
function getRunningAppsUsage(date: string): ScreenTimeEntry[] {
    try {
        const output = execSync(
            'lsappinfo list | grep -E "bundleID|pid|"',
            { encoding: 'utf-8', timeout: 5000 }
        ).trim();

        // Parse running app bundle IDs
        const bundleIds = output.match(/"bundleID"="([^"]+)"/g)?.map(m => {
            const match = m.match(/"bundleID"="([^"]+)"/);
            return match ? match[1] : '';
        }).filter(Boolean) || [];

        // We can only see what's running right now, not historical usage
        return [...new Set(bundleIds)].map(bundle_id => {
            const app_name = bundle_id.split('.').pop() || bundle_id;
            const category = APP_CATEGORIES[bundle_id] || categorizeByName(app_name);
            return {
                app_name,
                bundle_id,
                usage_seconds: 0, // We don't know actual usage from lsappinfo
                category,
                date,
            };
        }).filter(e => e.category !== 'system');
    } catch {
        return [];
    }
}

/**
 * Categorize app by name heuristics.
 */
function categorizeByName(name: string): string {
    const lower = name.toLowerCase();
    if (['xcode', 'terminal', 'iterm', 'vscode', 'code', 'intellij', 'webstorm', 'pycharm', 'sublime', 'vim', 'neovim', 'emacs', 'cursor', 'warp'].some(t => lower.includes(t))) return 'productive';
    if (['figma', 'sketch', 'canva', 'notion', 'obsidian', 'linear', 'jira', 'asana', 'trello'].some(t => lower.includes(t))) return 'productive';
    if (['twitter', 'instagram', 'facebook', 'tiktok', 'reddit', 'netflix', 'youtube', 'twitch', 'disney'].some(t => lower.includes(t))) return 'distraction';
    if (['slack', 'discord', 'teams', 'zoom', 'meet', 'messages', 'telegram', 'whatsapp'].some(t => lower.includes(t))) return 'neutral';
    if (['finder', 'spotlight', 'system', 'kernel', 'loginwindow', 'dock', 'launchpad', 'mission', 'notification'].some(t => lower.includes(t))) return 'system';
    return 'neutral';
}

/**
 * Save screen time data to the database.
 */
export function saveScreenTime(entries: ScreenTimeEntry[]) {
    const db = getDb();

    // Ensure table exists
    db.exec(`
    CREATE TABLE IF NOT EXISTS screen_time (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      usage_seconds INTEGER DEFAULT 0,
      category TEXT DEFAULT 'neutral',
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(bundle_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_screentime_date ON screen_time(date);
  `);

    const upsert = db.prepare(`
    INSERT INTO screen_time (app_name, bundle_id, usage_seconds, category, date)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bundle_id, date) DO UPDATE SET
      usage_seconds = ?, category = ?
  `);

    let saved = 0;
    for (const entry of entries) {
        try {
            upsert.run(
                entry.app_name, entry.bundle_id, entry.usage_seconds, entry.category, entry.date,
                entry.usage_seconds, entry.category
            );
            saved++;
        } catch { /* skip */ }
    }
    return saved;
}

/**
 * Get screen time data for a date.
 */
export function getScreenTime(date?: string) {
    const db = getDb();
    const targetDate = date || new Date(Date.now() + 19800000).toISOString().slice(0, 10);

    try {
        const apps = db.prepare(`
      SELECT app_name, bundle_id, usage_seconds, category
      FROM screen_time
      WHERE date = ?
      ORDER BY usage_seconds DESC
    `).all(targetDate) as ScreenTimeEntry[];

        const totalSeconds = apps.reduce((sum, a) => sum + a.usage_seconds, 0);
        const byCategory = apps.reduce((acc, a) => {
            acc[a.category] = (acc[a.category] || 0) + a.usage_seconds;
            return acc;
        }, {} as Record<string, number>);

        return { apps, totalSeconds, byCategory, date: targetDate };
    } catch {
        return { apps: [], totalSeconds: 0, byCategory: {}, date: targetDate };
    }
}
