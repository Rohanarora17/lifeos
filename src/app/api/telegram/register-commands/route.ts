import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';

const COMMANDS = [
  { command: 'menu', description: 'Show main menu with all buttons' },
  { command: 'status', description: 'Current session status and energy' },
  { command: 'tasks', description: "Today's ranked tasks" },
  { command: 'habits', description: "Today's habit check-ins" },
  { command: 'goals', description: 'Goal health status' },
  { command: 'plan', description: 'Tomorrow adaptive plan' },
  { command: 'standup', description: 'Morning standup brief' },
  { command: 'review', description: 'Pending session reviews' },
  { command: 'report', description: 'Daily productivity report' },
  { command: 'calibration', description: 'Model calibration accuracy' },
  { command: 'session', description: 'Start a focus session: /session Topic name' },
  { command: 'endsession', description: 'End current focus session' },
  { command: 'addtask', description: 'Create a task: /addtask Title here' },
  { command: 'deletetask', description: 'Delete a task: /deletetask search term' },
  { command: 'addgoal', description: 'Create a goal: /addgoal Title here' },
  { command: 'addhabit', description: 'Create a habit: /addhabit Name here' },
  { command: 'deletehabit', description: 'Archive a habit: /deletehabit search term' },
  { command: 'help', description: 'Full command reference' },
];

export async function POST() {
  const tok = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  if (!tok) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, { status: 400 });
  }

  const res = await fetch(`https://api.telegram.org/bot${tok}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: COMMANDS }),
  });

  const data = await res.json();
  if (!data.ok) {
    return NextResponse.json({ error: data.description }, { status: 500 });
  }

  return NextResponse.json({ success: true, registered: COMMANDS.length, commands: COMMANDS });
}

export async function GET() {
  const tok = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  if (!tok) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, { status: 400 });
  }

  const res = await fetch(`https://api.telegram.org/bot${tok}/getMyCommands`);
  const data = await res.json();
  return NextResponse.json(data);
}
