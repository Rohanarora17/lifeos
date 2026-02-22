import { getDb, getSetting } from './db';

// ============================================================
//  GITHUB ACTIVITY SYNC
//  Fetches commits, PRs, issues, reviews via GitHub REST API
// ============================================================

interface GitHubEvent {
    id: string;
    type: string;
    repo: { name: string };
    created_at: string;
    payload: {
        commits?: { message: string; url: string }[];
        action?: string;
        pull_request?: { title: string; html_url: string };
        issue?: { title: string; html_url: string };
        review?: { body: string; html_url: string };
    };
}

interface SyncResult {
    synced: number;
    errors: string[];
    events: { type: string; repo: string; message: string }[];
}

/**
 * Sync GitHub activity using the stored PAT and username.
 * Fetches the last 100 events and deduplicates against existing records.
 */
export async function syncGitHubActivity(): Promise<SyncResult> {
    const pat = getSetting('github_pat');
    const username = getSetting('github_username');

    if (!pat || !username) {
        return { synced: 0, errors: ['GitHub PAT or username not configured'], events: [] };
    }

    const db = getDb();
    const result: SyncResult = { synced: 0, errors: [], events: [] };

    try {
        // Fetch recent events (paginated, up to 100)
        const events: GitHubEvent[] = [];
        for (let page = 1; page <= 3; page++) {
            const res = await fetch(
                `https://api.github.com/users/${username}/events?per_page=30&page=${page}`,
                {
                    headers: {
                        Authorization: `Bearer ${pat}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                    },
                }
            );

            if (!res.ok) {
                if (res.status === 401) {
                    result.errors.push('Invalid GitHub PAT — check your token');
                    return result;
                }
                if (res.status === 404) {
                    result.errors.push(`GitHub user '${username}' not found`);
                    return result;
                }
                result.errors.push(`GitHub API error: ${res.status}`);
                break;
            }

            const page_events = (await res.json()) as GitHubEvent[];
            events.push(...page_events);
            if (page_events.length < 30) break;
        }

        // Get existing event IDs to deduplicate
        const existingIds = new Set(
            (db.prepare('SELECT url FROM github_activity').all() as { url: string }[])
                .map(r => r.url)
        );

        const insert = db.prepare(
            'INSERT INTO github_activity (type, repo, message, url, created_at) VALUES (?, ?, ?, ?, ?)'
        );

        for (const event of events) {
            const items = parseGitHubEvent(event);
            for (const item of items) {
                if (!existingIds.has(item.url)) {
                    try {
                        insert.run(item.type, item.repo, item.message, item.url, item.created_at);
                        result.synced++;
                        result.events.push({ type: item.type, repo: item.repo, message: item.message });
                        existingIds.add(item.url);
                    } catch { /* skip duplicate */ }
                }
            }
        }
    } catch (err) {
        result.errors.push(`Sync failed: ${String(err)}`);
    }

    return result;
}

/**
 * Parse a GitHub event into one or more activity records.
 */
function parseGitHubEvent(event: GitHubEvent): {
    type: string; repo: string; message: string; url: string; created_at: string;
}[] {
    const repo = event.repo.name;
    const created = event.created_at;
    const items: { type: string; repo: string; message: string; url: string; created_at: string }[] = [];

    switch (event.type) {
        case 'PushEvent':
            if (event.payload.commits) {
                for (const commit of event.payload.commits) {
                    items.push({
                        type: 'commit',
                        repo,
                        message: commit.message.split('\n')[0].slice(0, 200),
                        url: commit.url || `github-push-${event.id}-${commit.message.slice(0, 20)}`,
                        created_at: created,
                    });
                }
            }
            break;

        case 'PullRequestEvent':
            if (event.payload.pull_request) {
                items.push({
                    type: 'pr',
                    repo,
                    message: `${event.payload.action}: ${event.payload.pull_request.title}`,
                    url: event.payload.pull_request.html_url,
                    created_at: created,
                });
            }
            break;

        case 'IssuesEvent':
            if (event.payload.issue) {
                items.push({
                    type: 'issue',
                    repo,
                    message: `${event.payload.action}: ${event.payload.issue.title}`,
                    url: event.payload.issue.html_url,
                    created_at: created,
                });
            }
            break;

        case 'PullRequestReviewEvent':
            if (event.payload.review) {
                items.push({
                    type: 'review',
                    repo,
                    message: `Reviewed PR: ${event.payload.pull_request?.title || 'unknown'}`,
                    url: event.payload.review.html_url,
                    created_at: created,
                });
            }
            break;
    }

    return items;
}

/**
 * Get recent GitHub activity from the database.
 */
export function getGitHubActivity(days: number = 7, limit: number = 50) {
    const db = getDb();
    return db.prepare(`
    SELECT * FROM github_activity
    WHERE created_at >= datetime('now', '-${days} days')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * GitHub stats summary for a given date.
 */
export function getGitHubStats(date: string) {
    const db = getDb();
    const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN type = 'commit' THEN 1 END) as commits,
      COUNT(CASE WHEN type = 'pr' THEN 1 END) as prs,
      COUNT(CASE WHEN type = 'issue' THEN 1 END) as issues,
      COUNT(CASE WHEN type = 'review' THEN 1 END) as reviews,
      COUNT(*) as total
    FROM github_activity
    WHERE date(created_at) = ?
  `).get(date) as { commits: number; prs: number; issues: number; reviews: number; total: number };

    const repos = db.prepare(`
    SELECT repo, COUNT(*) as count
    FROM github_activity
    WHERE date(created_at) = ?
    GROUP BY repo ORDER BY count DESC LIMIT 5
  `).all(date) as { repo: string; count: number }[];

    return { ...stats, repos };
}
