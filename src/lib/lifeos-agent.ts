// src/lib/lifeos-agent.ts
// Unified agent coordinator — the single brain all surfaces route through.
// Assembles UIL context, routes tool calls, and logs outcomes.
// Does NOT replace telegram-agent.ts — surfaces can call this directly
// or continue using their own handlers that internally call it.

import { getIntelligenceContext, touchIntelligence } from './intelligence';
import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';

export type AgentSurface = 'telegram' | 'web' | 'voice' | 'scheduler';

export interface AgentInput {
  surface: AgentSurface;
  message: string;
  chatId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentOutput {
  message: string;
  action?: string;
  payload?: Record<string, unknown>;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const { surface, message, chatId } = input;

  // 1. Signal new data — keeps UIL profile fresh
  touchIntelligence(`agent_${surface}`);

  // 2. Assemble UIL context
  const uilContext = getIntelligenceContext({
    maxInsights: 3,
    includeToday: true,
    includeThresholds: false,
  });

  // 3. Load recent conversation turns (Telegram or web chat)
  let turnHistory = '';
  if (chatId) {
    try {
      const db = getDb();
      const turns = db.prepare(`
        SELECT role, content FROM telegram_turns
        WHERE chat_id = ? ORDER BY created_at DESC LIMIT 6
      `).all(chatId) as Array<{ role: string; content: string }>;
      if (turns.length > 0) {
        turnHistory = '\n\nRECENT CONVERSATION:\n' + turns.reverse()
          .map(t => `${t.role === 'user' ? 'User' : 'LifeOS'}: ${t.content}`)
          .join('\n');
      }
    } catch { /* telegram_turns may not exist on fresh install */ }
  }

  // 4. Build prompt and call LLM
  const prompt = `You are LifeOS — an intelligent personal agent. Your only job is to help this person become better at focused work and intentional living.

${uilContext}${turnHistory}

User (via ${surface}): ${message}

Respond helpfully and concisely. Draw from the profile above — don't give generic advice. If you need to take action, state what you're doing.`;

  const ai = getGenAI();
  if (!ai) {
    return { message: 'AI client not available — check GEMINI_API_KEY.' };
  }

  let responseText: string;
  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: prompt,
      config: { temperature: 0.3, maxOutputTokens: 500 },
    });
    responseText = result.text ?? 'No response generated.';
  } catch (err) {
    console.error('[lifeos-agent] LLM call failed:', err);
    return { message: 'Failed to generate response. Please try again.' };
  }

  // 5. Log as an agent action outcome (helpful = null until follow-up feedback)
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, helpful)
      VALUES (?, ?, NULL, NULL)
    `).run(`${surface}_response`, message.slice(0, 200));
  } catch { /* non-critical — log failure shouldn't block response */ }

  return { message: responseText };
}
