// URL categorization types & utilities
// Static rule-based classification has been removed in favor of the
// unified domain_categories cache (seeded in db.ts, updated by AI + user overrides).

import { getDb } from './db';

export type Category = 'productive' | 'neutral' | 'distraction';
export type Subcategory =
    | 'coding' | 'documentation' | 'research' | 'learning'
    | 'youtube-educational' | 'youtube-entertainment' | 'youtube-music'
    | 'social-media' | 'news' | 'shopping' | 'gaming' | 'entertainment'
    | 'communication' | 'productivity-tool' | 'finance'
    | 'other';

export interface CategoryResult {
    category: Category;
    subcategory: Subcategory;
    confidence: 'high' | 'medium' | 'low';
}

export function extractDomain(url: string): string {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

// ── Auto-Learn Domain Patterns from Usage Data ──────────────────────

/**
 * Analyze browsing patterns and learn domain classifications.
 * Called during deep analysis to evolve the domain map over time.
 *
 * Logic:
 * - If a domain is consistently visited during productive hours → productive
 * - If a domain is always followed by tab-switch bursts → distraction
 * - If a domain never triggers nudges and has long sessions → productive
 * - If nudges are frequently triggered on a domain → distraction
 * 
 * Now writes directly to domain_categories for instant feedback loop.
 */
export function learnDomainClassifications() {
    try {
        const db = getDb();

        // Get domains with enough usage data (min 5 visits, last 14 days)
        const domainStats = db.prepare(`
            SELECT 
                domain,
                category as current_category,
                COUNT(*) as visit_count,
                AVG(duration_seconds) as avg_duration,
                SUM(CASE WHEN category = 'productive' THEN 1 ELSE 0 END) as productive_count,
                SUM(CASE WHEN category = 'distraction' THEN 1 ELSE 0 END) as distraction_count,
                SUM(CASE WHEN category = 'neutral' THEN 1 ELSE 0 END) as neutral_count
            FROM activities
            WHERE started_at >= datetime('now', '-14 days')
              AND domain NOT IN ('newtab', 'extensions', 'localhost', 'context-switch')
            GROUP BY domain
            HAVING visit_count >= 5
            ORDER BY visit_count DESC
            LIMIT 30
        `).all() as {
            domain: string;
            current_category: string;
            visit_count: number;
            avg_duration: number;
            productive_count: number;
            distraction_count: number;
            neutral_count: number;
        }[];

        // Get nudge data per domain
        const nudgeStats = db.prepare(`
            SELECT domain, COUNT(*) as nudge_count
            FROM nudge_log
            WHERE created_at >= datetime('now', '-14 days')
              AND domain IS NOT NULL
            GROUP BY domain
        `).all() as { domain: string; nudge_count: number }[];

        const nudgeMap = new Map(nudgeStats.map(n => [n.domain, n.nudge_count]));

        for (const stat of domainStats) {
            const total = stat.productive_count + stat.distraction_count + stat.neutral_count;
            const productiveRatio = stat.productive_count / total;
            const distractionRatio = stat.distraction_count / total;
            const nudgeCount = nudgeMap.get(stat.domain) || 0;
            const nudgeRatio = nudgeCount / stat.visit_count;

            let learnedCategory: Category | null = null;
            let learnedSubcategory: Subcategory = 'other';
            let reason = '';

            // Strong productive signal: 70%+ productive visits, low nudges
            if (productiveRatio >= 0.7 && nudgeRatio < 0.1) {
                learnedCategory = 'productive';
                reason = `${Math.round(productiveRatio * 100)}% productive visits, ${nudgeCount} nudges`;
            }
            // Strong distraction signal: 70%+ distraction visits or high nudge rate
            else if (distractionRatio >= 0.7 || nudgeRatio >= 0.5) {
                learnedCategory = 'distraction';
                learnedSubcategory = nudgeRatio >= 0.5 ? 'entertainment' : 'social-media';
                reason = `${Math.round(distractionRatio * 100)}% distraction visits, ${nudgeCount} nudges`;
            }
            // Moderate productive: 50%+ productive, long sessions, few nudges
            else if (productiveRatio >= 0.5 && stat.avg_duration > 300 && nudgeRatio < 0.2) {
                learnedCategory = 'productive';
                reason = `${Math.round(stat.avg_duration / 60)}m avg sessions, low nudge rate`;
            }

            if (learnedCategory) {
                // Write directly into the domain cache for instant effect
                // Use confidence 0.75 so user overrides (1.0) and seeded rules (0.8) can still win
                try {
                    db.prepare(`
                        INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
                        VALUES (?, ?, ?, 0.75, ?)
                        ON CONFLICT(domain) DO UPDATE SET
                            category = CASE WHEN confidence < 0.8 THEN excluded.category ELSE category END,
                            subcategory = CASE WHEN confidence < 0.8 THEN excluded.subcategory ELSE subcategory END,
                            ai_reasoning = CASE WHEN confidence < 0.8 THEN excluded.ai_reasoning ELSE ai_reasoning END,
                            updated_at = datetime('now')
                    `).run(stat.domain, learnedCategory, learnedSubcategory, reason);
                } catch { /* ignore if table doesn't exist yet */ }
            }
        }
    } catch (err) {
        console.error('Domain classification learning failed:', err);
    }
}
