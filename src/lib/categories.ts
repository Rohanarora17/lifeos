// URL categorization rules & utilities

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

// Fast rule-based classification before falling back to AI
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

export function classifyByRules(url: string, title: string): CategoryResult | null {
    const domain = extractDomain(url);

    // Direct domain match
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

    // Keyword-based hints
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
