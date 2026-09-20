import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { registerTelegramCommands, TELEGRAM_COMMANDS } from '@/lib/telegram-command-catalog';

function telegramTokenError(): string {
  try {
    const snapshot = buildPersonalizationSnapshot({
      surface: 'telegram',
      maxInsights: 2,
      includeMemoryFacts: 2,
    });
    if (snapshot.today.plannedFocus.nextTitle) {
      return `Telegram is not connected yet. Add TELEGRAM_BOT_TOKEN before reminder commands can protect ${snapshot.today.plannedFocus.nextTitle}.`;
    }
    if (snapshot.feedback.alertFatigueLevel === 'high') {
      return 'Telegram is not connected yet. Add TELEGRAM_BOT_TOKEN before quiet-mode reminder feedback can sync.';
    }
    return `Telegram is not connected yet. Add TELEGRAM_BOT_TOKEN before LifeOS can send reminders around ${snapshot.userState.nextBestFocusWindow}.`;
  } catch {
    return 'Telegram is not connected yet. Add TELEGRAM_BOT_TOKEN before registering commands.';
  }
}

export async function POST() {
  const tok = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  if (!tok) {
    return NextResponse.json({ error: telegramTokenError() }, { status: 400 });
  }

  const result = await registerTelegramCommands(tok);
  if (!result.ok) {
    return NextResponse.json({ error: result.description || 'Telegram rejected the command list.' }, { status: 500 });
  }

  return NextResponse.json({ success: true, registered: TELEGRAM_COMMANDS.length, commands: TELEGRAM_COMMANDS });
}

export async function GET() {
  const tok = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  if (!tok) {
    return NextResponse.json({ error: telegramTokenError() }, { status: 400 });
  }

  const res = await fetch(`https://api.telegram.org/bot${tok}/getMyCommands`);
  const data = await res.json();
  return NextResponse.json(data);
}
