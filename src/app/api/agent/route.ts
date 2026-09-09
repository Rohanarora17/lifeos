// src/app/api/agent/route.ts
// Unified agent gateway — single POST endpoint for web chat and future surfaces.
// Telegram continues to use its own webhook (/api/telegram/webhook) which
// internally calls surface-specific handlers. This route is for web UI and
// any new surface that doesn't need Telegram-specific routing.

import { NextRequest, NextResponse } from 'next/server';
import { runAgent, AgentSurface } from '@/lib/lifeos-agent';
import { recordHumanContact } from '@/lib/coaching-state';

const VALID_SURFACES: AgentSurface[] = ['telegram', 'web', 'voice', 'scheduler'];

export async function POST(req: NextRequest) {
  let body: { surface?: string; message?: string; chatId?: string; sessionId?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { surface, message, chatId, sessionId } = body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const resolvedSurface: AgentSurface = VALID_SURFACES.includes(surface as AgentSurface)
    ? (surface as AgentSurface)
    : 'web';
  recordHumanContact(`${resolvedSurface}_agent`, { length: message.trim().length });

  try {
    const result = await runAgent({
      surface: resolvedSurface,
      message: message.trim(),
      chatId,
      sessionId,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/agent] runAgent failed:', err);
    return NextResponse.json({ error: 'agent error' }, { status: 500 });
  }
}
