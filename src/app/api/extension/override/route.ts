import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { extractDomain } from '@/lib/categories';
import { sanitizeUrl, sanitizeText } from '@/lib/sanitize';

// POST: Logs when a user overrides a distraction block.
// This is a critical AI learning signal — repeated overrides on a domain
// indicate the AI's classification may be wrong for this user.
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const url = sanitizeUrl(body.url);
        const title = sanitizeText(body.title, 500);
        const reason = sanitizeText(body.reason, 500);

        if (!url) {
            return NextResponse.json({ error: 'Missing URL' }, { status: 400 });
        }

        const domain = extractDomain(url);
        const db = getDb();

        // 1. Log the override event
        db.prepare(`
            INSERT INTO nudge_log (message, domain, duration_minutes, acknowledged)
            VALUES (?, ?, 0, 1)
        `).run(`[OVERRIDE] User overrode AI block: "${reason}"`, domain);

        // 2. Check if this domain has been overridden repeatedly (3+ times in 7 days)
        const overrideCount = db.prepare(`
            SELECT COUNT(*) as c FROM nudge_log
            WHERE domain = ? AND message LIKE '%[OVERRIDE]%'
            AND created_at >= datetime('now', '-7 days')
        `).get(domain) as { c: number };

        // 3. If repeated overrides, learn that this domain is NOT a distraction for this user
        if (overrideCount.c >= 3) {
            try {
                // Store a behavioral memory so the AI classifier remembers
                db.prepare(`
                    INSERT INTO behavioral_memory (memory_type, content, source, confidence, reinforcement_count)
                    VALUES ('categorization_rule', ?, 'user_override', 0.9, ?)
                    ON CONFLICT DO NOTHING
                `).run(
                    `User repeatedly overrode distraction blocks on "${domain}". This domain is likely productive for them. Do NOT classify it as a distraction.`,
                    overrideCount.c
                );

                // Also update the domain_categories cache to reflect this
                db.prepare(`
                    INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
                    VALUES (?, 'productive', 'other', 1.0, ?)
                    ON CONFLICT(domain) DO UPDATE SET
                        category = 'productive', confidence = 1.0,
                        ai_reasoning = ?, updated_at = datetime('now')
                `).run(
                    domain,
                    `User overrode AI block ${overrideCount.c} times — auto-promoted to productive`,
                    `User overrode AI block ${overrideCount.c} times — auto-promoted to productive`
                );
            } catch (e) { /* tables may not exist */ }
        }

        return NextResponse.json({ success: true, overrideCount: overrideCount.c });
    } catch (error) {
        console.error('Override API Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
