import { getDb } from './db';

// ============================================================
//  KNOWLEDGE GRAPH ENGINE
//  BKT-inspired mastery propagation through concept dependencies
// ============================================================

export interface KnowledgeNode {
    id: number;
    title: string;
    description: string | null;
    goal_id: number | null;
    node_type: 'concept' | 'skill' | 'topic';
    mastery: number; // 0.0 - 1.0
    created_at: string;
}

export interface KnowledgeEdge {
    id: number;
    from_node_id: number;
    to_node_id: number;
    edge_type: 'prerequisite' | 'related';
    weight: number;
}

export interface NodeTaskLink {
    id: number;
    node_id: number;
    task_id: number | null;
    study_session_id: number | null;
    contribution: number;
}

export interface GraphNode extends KnowledgeNode {
    edges_out: KnowledgeEdge[];
    linked_tasks: { id: number; title: string; status: string }[];
    isBlocked: boolean;   // true if prerequisites are not sufficiently mastered
    prereqMastery: number; // average mastery of all prerequisites
}

/**
 * Fetch the complete knowledge graph for a specific goal.
 */
export function buildKnowledgeGraph(goalId: number): { nodes: GraphNode[]; edges: KnowledgeEdge[] } {
    const db = getDb();

    const rawNodes = db.prepare(
        `SELECT * FROM knowledge_nodes WHERE goal_id = ? ORDER BY created_at ASC`
    ).all(goalId) as KnowledgeNode[];

    const edges = db.prepare(
        `SELECT ke.* FROM knowledge_edges ke
         JOIN knowledge_nodes kn ON ke.from_node_id = kn.id
         WHERE kn.goal_id = ?`
    ).all(goalId) as KnowledgeEdge[];

    const nodeIds = rawNodes.map(n => n.id);
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    // Build adjacency for quick lookup
    const edgesByFrom: Record<number, KnowledgeEdge[]> = {};
    const edgesInto: Record<number, KnowledgeEdge[]> = {}; // prerequisite edges pointing INTO each node
    for (const edge of edges) {
        if (!edgesByFrom[edge.from_node_id]) edgesByFrom[edge.from_node_id] = [];
        edgesByFrom[edge.from_node_id].push(edge);
        if (!edgesInto[edge.to_node_id]) edgesInto[edge.to_node_id] = [];
        edgesInto[edge.to_node_id].push(edge);
    }

    // Build a map for mastery lookup
    const masteryById: Record<number, number> = {};
    for (const n of rawNodes) masteryById[n.id] = n.mastery;

    // Fetch linked tasks for all nodes
    const taskLinks = nodeIds.length > 0 ? db.prepare(
        `SELECT ntl.node_id, t.id, t.title, t.status
         FROM node_task_links ntl
         JOIN tasks t ON ntl.task_id = t.id
         WHERE ntl.node_id IN (${nodeIds.join(',')}) AND ntl.task_id IS NOT NULL`
    ).all() as { node_id: number; id: number; title: string; status: string }[] : [];

    const tasksByNode: Record<number, { id: number; title: string; status: string }[]> = {};
    for (const link of taskLinks) {
        if (!tasksByNode[link.node_id]) tasksByNode[link.node_id] = [];
        tasksByNode[link.node_id].push({ id: link.id, title: link.title, status: link.status });
    }

    const nodes: GraphNode[] = rawNodes.map(n => {
        const prereqs = (edgesInto[n.id] || []).filter(e => e.edge_type === 'prerequisite');
        const prereqMastery = prereqs.length === 0
            ? 1.0
            : prereqs.reduce((sum, e) => sum + (masteryById[e.from_node_id] || 0), 0) / prereqs.length;

        return {
            ...n,
            edges_out: edgesByFrom[n.id] || [],
            linked_tasks: tasksByNode[n.id] || [],
            isBlocked: prereqs.length > 0 && prereqMastery < 0.5,
            prereqMastery,
        };
    });

    return { nodes, edges };
}

/**
 * BKT-inspired mastery propagation.
 * Called after a task or study session is completed.
 * Updates the mastery of linked nodes, then forward-propagates through edges.
 */
export function propagateMastery(taskId: number | null, studySessionId: number | null): void {
    const db = getDb();

    // Find all nodes linked to this task/study session
    let links: NodeTaskLink[];
    if (taskId) {
        links = db.prepare(
            `SELECT * FROM node_task_links WHERE task_id = ?`
        ).all(taskId) as NodeTaskLink[];
    } else if (studySessionId) {
        links = db.prepare(
            `SELECT * FROM node_task_links WHERE study_session_id = ?`
        ).all(studySessionId) as NodeTaskLink[];
    } else return;

    for (const link of links) {
        updateNodeMastery(link.node_id, link.contribution);
    }
}

/**
 * Update a single node's mastery using the asymptotic BKT formula,
 * then propagate forward (to dependents) with discounted weight.
 */
function updateNodeMastery(nodeId: number, contribution: number, depth: number = 0, studyMinutes: number = 30, qualityMultiplier: number = 1.0): void {
    if (depth > 4) return; // max propagation depth

    const db = getDb();
    const node = db.prepare(`SELECT id, mastery FROM knowledge_nodes WHERE id = ?`).get(nodeId) as { id: number; mastery: number } | undefined;
    if (!node) return;

    // Quality-weighted mastery formula
    const BASE_INCREMENT = 0.10; // Assume note_taking equivalent for now
    const increment = BASE_INCREMENT * qualityMultiplier * Math.min(studyMinutes / 30, 2.0);

    const newMastery = Math.min(1.0, node.mastery + increment);

    db.prepare(`UPDATE knowledge_nodes SET mastery = ? WHERE id = ?`).run(newMastery, nodeId);

    // Forward propagation to dependent nodes via prerequisite edges
    const edges = db.prepare(
        `SELECT * FROM knowledge_edges WHERE from_node_id = ? AND edge_type = 'prerequisite'`
    ).all(nodeId) as KnowledgeEdge[];

    if (newMastery > 0.6) {
        for (const edge of edges) {
            const priorBoost = (newMastery - 0.6) * edge.weight * 0.2;
            if (priorBoost > 0.01) {
                updateNodeMastery(edge.to_node_id, priorBoost * 0.3, depth + 1, studyMinutes, qualityMultiplier);
            }
        }
    }
}

/**
 * Get the overall knowledge mastery score for a goal (0-100).
 * Used as the Knowledge Mastery Bonus in accountability scoring.
 */
export function getGoalMasteryScore(goalId: number): number {
    const db = getDb();
    const nodes = db.prepare(
        `SELECT mastery FROM knowledge_nodes WHERE goal_id = ?`
    ).all(goalId) as { mastery: number }[];

    if (nodes.length === 0) return 0;
    const avg = nodes.reduce((sum, n) => sum + n.mastery, 0) / nodes.length;
    return Math.round(avg * 100);
}

/**
 * Get concepts that are ready to be learned next (unblocked = prerequisites mastered > 50%)
 * and haven't been fully mastered yet (mastery < 0.9).
 */
export function getUnblockedNextConcepts(goalId: number): GraphNode[] {
    const { nodes } = buildKnowledgeGraph(goalId);
    return nodes
        .filter(n => !n.isBlocked && n.mastery < 0.9)
        .sort((a, b) => a.mastery - b.mastery) // prioritize least mastered
        .slice(0, 3);
}

/**
 * Get a text summary of knowledge gaps for AI context injection.
 */
export function getKnowledgeGapSummary(): string {
    const db = getDb();

    const activeGoals = db.prepare(`SELECT id, title FROM goals WHERE active = 1`).all() as { id: number; title: string }[];
    if (activeGoals.length === 0) return '';

    const lines: string[] = ['KNOWLEDGE GRAPH STATUS:'];

    for (const goal of activeGoals) {
        const { nodes } = buildKnowledgeGraph(goal.id);
        if (nodes.length === 0) continue;

        const masteryScore = Math.round(nodes.reduce((s, n) => s + n.mastery, 0) / nodes.length * 100);
        lines.push(`\nGoal: "${goal.title}" — ${masteryScore}% overall mastery`);

        const gaps = nodes.filter(n => !n.isBlocked && n.mastery < 0.5);
        const blocked = nodes.filter(n => n.isBlocked);

        if (gaps.length > 0) {
            lines.push(`  🔴 Undermastered (ready to work on): ${gaps.map(n => `${n.title} (${Math.round(n.mastery * 100)}%)`).join(', ')}`);
        }
        if (blocked.length > 0) {
            lines.push(`  ⏳ Blocked by prerequisites: ${blocked.map(n => n.title).join(', ')}`);
        }
    }

    return lines.join('\n');
}

/**
 * Compute the global knowledge mastery bonus for the accountability score.
 * Returns 0-15 points based on average mastery across all active goals that have knowledge nodes.
 */
export function getKnowledgeMasteryBonus(): number {
    const db = getDb();

    const activeGoals = db.prepare(`SELECT id FROM goals WHERE active = 1`).all() as { id: number }[];
    if (activeGoals.length === 0) return 0;

    const scores: number[] = [];
    for (const goal of activeGoals) {
        const nodes = db.prepare(
            `SELECT mastery FROM knowledge_nodes WHERE goal_id = ?`
        ).all(goal.id) as { mastery: number }[];
        if (nodes.length > 0) {
            const avg = nodes.reduce((s, n) => s + n.mastery, 0) / nodes.length;
            scores.push(avg);
        }
    }

    if (scores.length === 0) return 0;
    const globalAvg = scores.reduce((s, v) => s + v, 0) / scores.length;
    return Math.round(globalAvg * 15); // max 15 bonus points
}

/**
 * AI-driven: Generate initial concept nodes for a goal from its title.
 * Returns an array of suggested concept nodes (not persisted yet).
 */
export async function generateConceptsForGoal(goalTitle: string, difficulty: string = 'intermediate'): Promise<{ title: string; description: string; node_type: 'concept' | 'skill' | 'topic'; prerequisites: number[] }[]> {
    const { getGenAI, generateWithFallback } = await import('./ai');
    const { MODEL_FLASH } = await import('./models');

    const ai = getGenAI();
    if (!ai) return [];

    const prompt = `You are a learning architect. Break down the goal "${goalTitle}" into 5-8 foundational knowledge nodes.
Assume knowledge level: ${difficulty}.
Return ONLY a valid JSON array (no markdown) where each object has:
- title: string (the concept/skill name, 2-5 words)
- description: string (one sentence explanation, what it is and why it matters)  
- node_type: "concept" | "skill" | "topic"
- prerequisite_titles: string[] (titles from the same list that must be learned first, empty for root nodes)

Order from foundational to advanced. Ensure a clear dependency chain.`;

    try {
        const result = await generateWithFallback(ai, {
            model: MODEL_FLASH,
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });

        const text = result.text || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error('[Graph] Failed to generate concepts:', e);
        return [];
    }
}
