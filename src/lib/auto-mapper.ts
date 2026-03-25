import { getGenAI } from './ai';
import { MODEL_FLASH } from './models';
import getDb from './db';

// Semantically maps a URL/title visited during a focus session to the closest Knowledge Graph concept node

export async function autoMapActivityToGraph(url: string, title: string, sessionId: string) {
    const ai = getGenAI();
    if (!ai) return null;

    try {
        const db = getDb();
        const nodes = db.prepare('SELECT id, title, description FROM knowledge_nodes WHERE node_type = "concept"').all();

        if (!nodes || nodes.length === 0) return null;

        const conceptsContext = nodes.map((n: any) => `ID: ${n.id} | TITLE: ${n.title}`).join('\n');

        const prompt = `You are a semantic mapper for a knowledge graph.
Given the following webpage the user visited during a study session, identify the SINGLE most relevant concept node from the knowledge graph.
If no concept matches well, return null.

Webpage URL: ${url}
Webpage Title: ${title}

Available Concepts:
${conceptsContext}

Return ONLY a JSON object:
{ "conceptNodeId": number | null, "confidence": number }
`;

        const result = await ai.models.generateContent({
            model: MODEL_FLASH || 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });

        const text = (result.text || '').trim();
        const parsed = JSON.parse(text);
        return parsed.conceptNodeId;
    } catch (e) {
        return null;
    }
}
