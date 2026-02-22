// URL categorization rules & utilities
// Combines static rules + AI-learned domain classifications

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

// Static baseline rules (overridable by learned classifications)
const DOMAIN_RULES: Record<string, CategoryResult> = {
    // Productive
    'github.com': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'gitlab.com': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'stackoverflow.com': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'developer.mozilla.org': { category: 'productive', subcategory: 'documentation', confidence: 'high' },
    'docs.google.com': { category: 'productive', subcategory: 'productivity-tool', confidence: 'high' },
    'notion.so': { category: 'productive', subcategory: 'productivity-tool', confidence: 'high' },
    'figma.com': { category: 'productive', subcategory: 'productivity-tool', confidence: 'high' },
    'linear.app': { category: 'productive', subcategory: 'productivity-tool', confidence: 'high' },
    'vercel.com': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'arxiv.org': { category: 'productive', subcategory: 'research', confidence: 'high' },
    'scholar.google.com': { category: 'productive', subcategory: 'research', confidence: 'high' },
    'medium.com': { category: 'productive', subcategory: 'learning', confidence: 'medium' },
    'dev.to': { category: 'productive', subcategory: 'learning', confidence: 'high' },
    'hashnode.com': { category: 'productive', subcategory: 'learning', confidence: 'high' },
    'npmjs.com': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'pypi.org': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'coursera.org': { category: 'productive', subcategory: 'learning', confidence: 'high' },
    'udemy.com': { category: 'productive', subcategory: 'learning', confidence: 'high' },
    'edx.org': { category: 'productive', subcategory: 'learning', confidence: 'high' },
    'leetcode.com': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'hackerrank.com': { category: 'productive', subcategory: 'coding', confidence: 'high' },
    'kaggle.com': { category: 'productive', subcategory: 'research', confidence: 'high' },

    // Distraction
    'twitter.com': { category: 'distraction', subcategory: 'social-media', confidence: 'high' },
    'x.com': { category: 'distraction', subcategory: 'social-media', confidence: 'high' },
    'instagram.com': { category: 'distraction', subcategory: 'social-media', confidence: 'high' },
    'facebook.com': { category: 'distraction', subcategory: 'social-media', confidence: 'high' },
    'reddit.com': { category: 'distraction', subcategory: 'social-media', confidence: 'medium' },
    'tiktok.com': { category: 'distraction', subcategory: 'social-media', confidence: 'high' },
    'netflix.com': { category: 'distraction', subcategory: 'entertainment', confidence: 'high' },
    'twitch.tv': { category: 'distraction', subcategory: 'entertainment', confidence: 'high' },
    'amazon.com': { category: 'distraction', subcategory: 'shopping', confidence: 'medium' },
    'flipkart.com': { category: 'distraction', subcategory: 'shopping', confidence: 'medium' },

    // Neutral
    'google.com': { category: 'neutral', subcategory: 'other', confidence: 'low' },
    'gmail.com': { category: 'neutral', subcategory: 'communication', confidence: 'medium' },
    'mail.google.com': { category: 'neutral', subcategory: 'communication', confidence: 'medium' },
    'calendar.google.com': { category: 'productive', subcategory: 'productivity-tool', confidence: 'high' },
    'drive.google.com': { category: 'productive', subcategory: 'productivity-tool', confidence: 'medium' },
};

export function extractDomain(url: string): string {
    try {
        const hostname = new URL(url).hostname;
        return hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/**
 * Classify a URL using a priority chain:
 * 1. AI-learned classifications (from behavioral_memory, highest priority)
 * 2. User overrides from settings (distraction_domains, productive_domains)
 * 3. Static domain rules
 * 4. Keyword-based hints
 * 5. null → let AI classify in real time
 */
export function classifyByRules(url: string, title: string): CategoryResult | null {
    const domain = extractDomain(url);

    // 1. Check AI-learned domain classifications first
    const learned = getLearnedDomainCategory(domain);
    if (learned) return learned;

    // 2. Check user overrides from settings
    const override = checkSettingOverrides(domain);
    if (override) return override;

    // 3. Direct domain match from static rules
    if (DOMAIN_RULES[domain]) {
        return DOMAIN_RULES[domain];
    }

    // Subdomain matching (e.g., mail.google.com)
    for (const [ruleDomain, result] of Object.entries(DOMAIN_RULES)) {
        if (domain.endsWith('.' + ruleDomain) || domain === ruleDomain) {
            return result;
        }
    }

    // YouTube special case - needs AI to determine educational vs entertainment
    if (domain === 'youtube.com' || domain === 'm.youtube.com') {
        return null; // Let AI classify
    }

    // 4. Keyword-based hints
    const lowerTitle = title.toLowerCase();
    const lowerUrl = url.toLowerCase();

    const productiveKeywords = ['tutorial', 'documentation', 'api', 'guide', 'course', 'lecture', 'learn'];
    const distractionKeywords = ['meme', 'funny', 'viral', 'gossip'];

    if (productiveKeywords.some(k => lowerTitle.includes(k) || lowerUrl.includes(k))) {
        return { category: 'productive', subcategory: 'learning', confidence: 'medium' };
    }
    if (distractionKeywords.some(k => lowerTitle.includes(k))) {
        return { category: 'distraction', subcategory: 'entertainment', confidence: 'medium' };
    }

    return null; // Unknown - let AI classify
}

// ── AI-Learned Domain Classification ────────────────────────────────

/**
 * Check if the AI has learned a classification for this domain.
 * Reads from behavioral_memory where memory_type = 'domain_classification'.
 */
function getLearnedDomainCategory(domain: string): CategoryResult | null {
    try {
        const db = getDb();
        const memory = db.prepare(`
            SELECT content, confidence FROM behavioral_memory
            WHERE memory_type = 'domain_classification'
              AND content LIKE ?
              AND superseded = 0
              AND confidence >= 0.6
            ORDER BY confidence DESC, last_reinforced DESC
            LIMIT 1
        `).get(`%"domain":"${domain}"%`) as { content: string; confidence: number } | undefined;

        if (memory) {
            const parsed = JSON.parse(memory.content);
            if (parsed.domain === domain && parsed.category) {
                return {
                    category: parsed.category as Category,
                    subcategory: (parsed.subcategory || 'other') as Subcategory,
                    confidence: memory.confidence >= 0.8 ? 'high' : 'medium',
                };
            }
        }
    } catch { /* table may not exist yet */ }
    return null;
}

/**
 * Check user setting overrides (distraction_domains, productive_domains).
 */
function checkSettingOverrides(domain: string): CategoryResult | null {
    try {
        const db = getDb();
        const distractRow = db.prepare("SELECT value FROM settings WHERE key = 'distraction_domains'").get() as { value: string } | undefined;
        const productiveRow = db.prepare("SELECT value FROM settings WHERE key = 'productive_domains'").get() as { value: string } | undefined;

        if (distractRow?.value) {
            try {
                const domains: string[] = JSON.parse(distractRow.value);
                if (domains.some(d => domain === d || domain.endsWith('.' + d))) {
                    return { category: 'distraction', subcategory: 'other', confidence: 'high' };
                }
            } catch { /* not valid JSON */ }
        }

        if (productiveRow?.value) {
            try {
                const domains: string[] = JSON.parse(productiveRow.value);
                if (domains.some(d => domain === d || domain.endsWith('.' + d))) {
                    return { category: 'productive', subcategory: 'other', confidence: 'high' };
                }
            } catch { /* not valid JSON */ }
        }
    } catch { /* ignore */ }
    return null;
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
              AND domain NOT IN ('newtab', 'extensions', 'localhost')
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

        // Learn: check for AI access to learnMemory
        const { learnMemory } = require('./behavior');

        for (const stat of domainStats) {
            // Skip domains already hardcoded with high confidence
            if (DOMAIN_RULES[stat.domain]?.confidence === 'high') continue;

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
                const content = JSON.stringify({
                    domain: stat.domain,
                    category: learnedCategory,
                    subcategory: learnedSubcategory,
                    reason,
                    visits: stat.visit_count,
                });

                learnMemory('domain_classification', content, 'usage_analysis');
            }
        }
    } catch (err) {
        console.error('Domain classification learning failed:', err);
    }
}
