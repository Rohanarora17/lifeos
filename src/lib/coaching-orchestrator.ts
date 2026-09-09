import { sendTelegram, type InlineKeyboard } from './telegram';
import {
  buildRecoveryMessage,
  ensureRecoveryEpisode,
  getCoachingState,
  localDateKey,
  recordCoachingDecision,
  recoveryOutreachDue,
} from './coaching-state';

export type CoachingCheckResult = 'not_needed' | 'already_sent' | 'sent' | 'send_failed' | 'reconnecting' | 'paused';

const RECOVERY_KEYBOARD: InlineKeyboard = [
  [{ text: 'Start 10-minute reset', callback_data: 'coach:restart:10' }],
  [
    { text: 'I am stuck', callback_data: 'coach:blocker:difficulty' },
    { text: 'Too much', callback_data: 'coach:blocker:overload' },
  ],
  [{ text: 'Pause coaching', callback_data: 'coach:pause' }],
];

export async function runCoachingRecoveryCheck(now = new Date()): Promise<CoachingCheckResult> {
  const state = getCoachingState({ now });
  if (state.engagement === 'paused') return 'paused';
  if (state.engagement === 'reconnecting') return 'reconnecting';
  if (state.engagement !== 'disengaged') return 'not_needed';
  if (!recoveryOutreachDue(state, now)) return 'already_sent';

  const episode = ensureRecoveryEpisode(state, now);
  if (!episode) return 'not_needed';
  const message = buildRecoveryMessage(state);
  const dedupeKey = `recovery:${localDateKey(now)}`;
  const sent = await sendTelegram(message, 'HTML', RECOVERY_KEYBOARD);
  recordCoachingDecision({
    episodeId: episode.id,
    actionType: 'recovery_outreach',
    status: sent ? 'sent' : 'failed',
    channel: 'telegram',
    message,
    reason: state.reason,
    expectedOutcome: 'Receive enough context to choose and complete a concrete restart.',
    actualOutcome: { transportAccepted: sent },
    dedupeKey,
    now,
  });
  return sent ? 'sent' : 'send_failed';
}
