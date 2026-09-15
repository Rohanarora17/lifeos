export type IntelligenceRefreshDisposition = 'ignore' | 'dirty_only' | 'synthesize';

const SYNTHESIS_TRIGGERS = new Set([
  'activity_correction',
  'correction_recorded',
  'evening_checkin',
  'explicit_dashboard_state',
  'fresh_start',
  'intention_stored',
  'morning_checkin',
  'session_end',
  'task_completed',
]);

export function intelligenceRefreshDisposition(trigger: string): IntelligenceRefreshDisposition {
  if (trigger.startsWith('alert_suppressed:')) return 'ignore';
  if (SYNTHESIS_TRIGGERS.has(trigger)) return 'synthesize';
  if (trigger.startsWith('coach_feedback:') || trigger.startsWith('task_recommendation_feedback:')) return 'synthesize';
  if (trigger.startsWith('alert_feedback:')) return 'synthesize';
  if (trigger === 'native_guidance_feedback' || trigger === 'native_app_classification_ui' || trigger === 'native_app_classification') return 'synthesize';
  if (trigger === 'voice_task_completion_checked') return 'synthesize';
  return 'dirty_only';
}

export function shouldRunScheduledIntelligenceRefresh(input: { dirty: boolean; activeSession: boolean }): boolean {
  return input.dirty && !input.activeSession;
}
