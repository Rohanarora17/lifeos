import { NextResponse } from 'next/server';
import { formatTelegramSetupConfirmation, sendTelegram } from '@/lib/telegram';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { getSetting } from '@/lib/db';
import { registerTelegramCommands } from '@/lib/telegram-command-catalog';

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

// POST: Confirm an already-bound chat. The daemon owns getUpdates exclusively;
// the webhook binds the first private /start without a competing poll request.
export async function POST() {
  const chatId = process.env.TELEGRAM_CHAT_ID || getSetting('telegram_chat_id');
  if (!chatId) {
    return NextResponse.json(
      { error: noTelegramMessageError() },
      { status: 409 }
    );
  }

  const token = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  const registration = await registerTelegramCommands(token);
  await sendTelegram(formatTelegramSetupConfirmation());

  return NextResponse.json({
    success: true,
    chatId,
    commandsRegistered: registration.ok,
    commandRegistrationError: registration.ok ? null : registration.description,
  });
}
