import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const action = searchParams.get('action');
        const db = getDb();

        // 1. Database Backup
        if (action === 'backup') {
            const dbPath = path.join(process.cwd(), 'data', 'lifeos.db');
            const backupPath = path.join(process.cwd(), 'data', `lifeos_backup_${new Date().toISOString().slice(0, 10)}.db`);

            // Cleanup old backups (keep last 7 days)
            const dataDir = path.join(process.cwd(), 'data');
            const files = fs.readdirSync(dataDir);
            files.forEach(file => {
                if (file.startsWith('lifeos_backup_')) {
                    const filePath = path.join(dataDir, file);
                    const stats = fs.statSync(filePath);
                    const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
                    if (ageDays > 7) {
                        fs.unlinkSync(filePath);
                    }
                }
            });

            // Create new backup
            fs.copyFileSync(dbPath, backupPath);
            console.log(`[Cron] Database backup created at ${backupPath}`);
            return NextResponse.json({ success: true, message: 'Backup created' });
        }

        // 2. Smart Archiving (Lossless Compression)
        if (action === 'archive') {
            // Compress activities older than 60 days
            const archiveDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

            // Ensure no duplicate daily aggregates exist before inserting
            db.prepare(`DELETE FROM daily_domain_aggregates WHERE date <= ?`).run(archiveDate);

            // Group granular data by Day + Domain + Category, and SUM the duration
            const archiveCount = db.prepare(`
                INSERT INTO daily_domain_aggregates (date, domain, category, total_duration)
                SELECT 
                    date(started_at) as date,
                    domain,
                    category,
                    SUM(duration_seconds) as total_duration
                FROM activities
                WHERE date(started_at) <= ?
                GROUP BY date(started_at), domain, category
            `).run(archiveDate).changes;

            // Delete the raw bloated rows
            const deletedCount = db.prepare(`
                DELETE FROM activities WHERE date(started_at) <= ?
            `).run(archiveDate).changes;

            console.log(`[Cron] Smart Archiving Complete: Compressed ${deletedCount} raw rows into ${archiveCount} daily aggregate rows.`);

            // VACUUM to reclaim actual disk space in SQLite
            db.prepare('VACUUM').run();

            return NextResponse.json({
                success: true,
                message: `Archived ${deletedCount} raw rows into ${archiveCount} aggregates.`
            });
        }

        return NextResponse.json({ error: 'Invalid action parameter' }, { status: 400 });

    } catch (error: any) {
        console.error('[Cron] Error:', error);
        return NextResponse.json({ error: 'Internal server error: ' + error.message }, { status: 500 });
    }
}
