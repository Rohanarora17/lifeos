import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildKnowledgeGraph, propagateMastery, generateConceptsForGoal } from '@/lib/graph';

// GET /api/knowledge-graph?goalId=X — Return full graph for a goal
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const goalId = parseInt(searchParams.get('goalId') || '0');
        if (!goalId) {
            // Return all goals with basic node counts
            const db = getDb();
            const goals = db.prepare(
                `SELECT g.id, g.title, COUNT(kn.id) as node_count
                 FROM goals g LEFT JOIN knowledge_nodes kn ON kn.goal_id = g.id
                 WHERE g.active = 1 AND (g.archived = 0 OR g.archived IS NULL)
                 GROUP BY g.id ORDER BY g.created_at DESC`
            ).all();
            return NextResponse.json({ goals });
        }
        const graph = buildKnowledgeGraph(goalId);
        return NextResponse.json(graph);
    } catch (error) {
        console.error('[KG GET]', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST /api/knowledge-graph — Multi-action endpoint
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { action } = body;
        const db = getDb();

        // ------ Create a new concept node ------
        if (action === 'create_node') {
            const { title, description, goal_id, node_type = 'concept' } = body;
            if (!title || !goal_id) return NextResponse.json({ error: 'title and goal_id required' }, { status: 400 });

            const result = db.prepare(
                `INSERT INTO knowledge_nodes (title, description, goal_id, node_type) VALUES (?, ?, ?, ?)`
            ).run(title, description || null, goal_id, node_type);

            return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
        }

        // ------ Create an edge ------
        if (action === 'create_edge') {
            const { from_node_id, to_node_id, edge_type = 'prerequisite', weight = 0.5 } = body;
            if (!from_node_id || !to_node_id) return NextResponse.json({ error: 'from_node_id and to_node_id required' }, { status: 400 });

            const result = db.prepare(
                `INSERT OR IGNORE INTO knowledge_edges (from_node_id, to_node_id, edge_type, weight) VALUES (?, ?, ?, ?)`
            ).run(from_node_id, to_node_id, edge_type, weight);

            return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
        }

        // ------ Link a task to a node ------
        if (action === 'link_task') {
            const { node_id, task_id, contribution = 0.4 } = body;
            if (!node_id || !task_id) return NextResponse.json({ error: 'node_id and task_id required' }, { status: 400 });

            const result = db.prepare(
                `INSERT INTO node_task_links (node_id, task_id, contribution) VALUES (?, ?, ?)`
            ).run(node_id, task_id, contribution);

            return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
        }

        // ------ Trigger mastery propagation manually ------
        if (action === 'propagate') {
            const { task_id, study_session_id } = body;
            propagateMastery(task_id || null, study_session_id || null);
            return NextResponse.json({ success: true });
        }

        // ------ AI-generate concept nodes for a goal ------
        if (action === 'generate_concepts') {
            const { goal_id, goal_title, difficulty = 'intermediate' } = body;
            if (!goal_id || !goal_title) return NextResponse.json({ error: 'goal_id and goal_title required' }, { status: 400 });

            const concepts = await generateConceptsForGoal(goal_title, difficulty);
            if (concepts.length === 0) return NextResponse.json({ error: 'Failed to generate concepts' }, { status: 500 });

            // Persist generated nodes + edges
            const nodeIdMap: Record<string, number> = {};
            for (const concept of concepts) {
                const result = db.prepare(
                    `INSERT INTO knowledge_nodes (title, description, goal_id, node_type) VALUES (?, ?, ?, ?)`
                ).run(concept.title, concept.description, goal_id, concept.node_type);
                nodeIdMap[concept.title] = result.lastInsertRowid as number;
            }

            // Create prerequisite edges
            for (const concept of concepts) {
                const conceptWithPrereqs = concept as typeof concept & { prerequisite_titles?: string[]; prerequisites?: string[] };
                const prereqs: string[] = conceptWithPrereqs.prerequisite_titles || conceptWithPrereqs.prerequisites || [];
                if (prereqs.length > 0) {
                    for (const prereqTitle of prereqs) {
                        const fromId = nodeIdMap[prereqTitle];
                        const toId = nodeIdMap[concept.title];
                        if (fromId && toId) {
                            try {
                                db.prepare(
                                    `INSERT OR IGNORE INTO knowledge_edges (from_node_id, to_node_id, edge_type, weight) VALUES (?, ?, 'prerequisite', 0.7)`
                                ).run(fromId, toId);
                            } catch { /* ignore duplicate */ }
                        }
                    }
                }
            }

            return NextResponse.json({ nodes_created: concepts.length, nodes: concepts });
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    } catch (error) {
        console.error('[KG POST]', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE /api/knowledge-graph?nodeId=X — Delete a node
export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const nodeId = searchParams.get('nodeId');
        if (!nodeId) return NextResponse.json({ error: 'nodeId required' }, { status: 400 });

        const db = getDb();
        db.prepare(`DELETE FROM knowledge_nodes WHERE id = ?`).run(nodeId);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[KG DELETE]', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
