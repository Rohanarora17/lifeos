import { NextResponse } from 'next/server';
import { captureChatId, formatTelegramSetupConfirmation, sendTelegram } from '@/lib/telegram';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';

function noTelegramMessageError(): string {
  try {
    const snapshot = buildPersonalizationSnapshot({
      surface: 'telegram',
      maxInsights: 2,
      includeMemoryFacts: 2,
    });
    if (snapshot.today.plannedFocus.nextTitle) {
      return `No Telegram messages found. Send /start to the bot first so LifeOS can attach reminders to ${snapshot.today.plannedFocus.nextTitle}.`;
    }
    if (snapshot.moment.mode === 'planning') {
      return 'No Telegram messages found. Send /start to the bot first so tomorrow planning reminders can reach you.';
    }
    return `No Telegram messages found. Send /start to the bot first so reminders can follow your learned focus window: ${snapshot.userState.nextBestFocusWindow}.`;
  } catch {
    return 'No Telegram messages found. Send /start to your Telegram bot first, then retry.';
  }
}

// POST: Query Telegram getUpdates to capture chat ID, then send a test message.
// Call this after sending /start to your bot.
export async function POST() {
  const chatId = await captureChatId();
  if (!chatId) {
    return NextResponse.json(
      { error: noTelegramMessageError() },
      { status: 404 }
    );
  }

  await sendTelegram(formatTelegramSetupConfirmation());

  return NextResponse.json({ success: true, chatId });
}
