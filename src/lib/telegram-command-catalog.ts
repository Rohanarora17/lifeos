export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

export const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = [
  { command: 'start', description: 'Connect this private chat and open the menu' },
  { command: 'menu', description: 'Open the current action menu' },
  { command: 'status', description: 'Live session, energy, and focus status' },
  { command: 'tasks', description: "Today's current ranked tasks" },
  { command: 'task', description: "Alias for today's /tasks" },
  { command: 'habits', description: "Today's current habit check-ins" },
  { command: 'goals', description: 'Current goal health status' },
  { command: 'plan', description: "Tomorrow's current adaptive plan" },
  { command: 'weekly', description: 'Current week plan and progress' },
  { command: 'standup', description: "Today's standup brief" },
  { command: 'morning', description: "Open today's morning check-in" },
  { command: 'journal', description: "Open today's evening journal" },
  { command: 'reflect', description: "Alias for today's /journal" },
  { command: 'freshstart', description: 'Set the coaching history start date' },
  { command: 'review', description: 'Live pending session reviews' },
  { command: 'reviews', description: 'Alias for current /review queue' },
  { command: 'report', description: "Today's current productivity report" },
  { command: 'calibration', description: 'Current model calibration accuracy' },
  { command: 'session', description: 'Start a focus session now: /session Topic' },
  { command: 'endsession', description: 'End the live focus session now' },
  { command: 'end', description: 'Alias for /endsession now' },
  { command: 'addtask', description: 'Create a task: /addtask Title' },
  { command: 'deletetask', description: 'Delete a task: /deletetask name' },
  { command: 'addgoal', description: 'Create a goal: /addgoal Title' },
  { command: 'deletegoal', description: 'Delete a goal: /deletegoal name' },
  { command: 'addhabit', description: 'Create a habit: /addhabit Name' },
  { command: 'deletehabit', description: 'Archive a habit: /deletehabit name' },
  { command: 'pause', description: 'Pause proactive coaching now' },
  { command: 'resume', description: 'Resume proactive coaching now' },
  { command: 'help', description: 'Show the complete command reference' },
];

export function formatTelegramCommandHelp(): string {
  return TELEGRAM_COMMANDS
    .filter(({ command }) => !['start', 'task', 'reviews', 'reflect', 'end'].includes(command))
    .map(({ command, description }) => `/${command} — ${description}`)
    .join('\n');
}

export async function registerTelegramCommands(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; description?: string }> {
  if (!botToken) return { ok: false, description: 'Telegram bot token is not configured.' };
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
    });
    const body = await response.json() as { ok?: boolean; description?: string };
    return { ok: response.ok && body.ok === true, description: body.description };
  } catch (error) {
    return { ok: false, description: String(error) };
  }
}
