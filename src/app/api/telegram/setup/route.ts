import { NextResponse } from 'next/server';
import { captureChatId, formatTelegramSetupConfirmation, sendTelegram } from '@/lib/telegram';

// POST: Query Telegram getUpdates to capture chat ID, then send a test message.
// Call this after sending /start to your bot.
export async function POST() {
  const chatId = await captureChatId();
  if (!chatId) {
    return NextResponse.json(
      { error: 'No messages found. Send /start to your Telegram bot first, then retry.' },
      { status: 404 }
    );
  }

  await sendTelegram(formatTelegramSetupConfirmation());

  return NextResponse.json({ success: true, chatId });
}
