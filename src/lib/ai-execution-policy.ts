import { MODEL_PRO, MODEL_REALTIME_ACTIVITY } from './models';

export type AiWorkClass = 'interactive' | 'active_session' | 'background';
export type AiQualityTier = 'routine' | 'reasoning' | 'deep';
export type AiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

type FeaturePolicy = {
  workClass: AiWorkClass;
  qualityTier: AiQualityTier;
  thinkingLevel?: AiThinkingLevel;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

const routine = (workClass: AiWorkClass, maxOutputTokens = 768): FeaturePolicy => ({
  workClass,
  qualityTier: 'routine',
  thinkingLevel: 'minimal',
  maxOutputTokens,
  timeoutMs: 25_000,
});
const reasoning = (workClass: AiWorkClass, maxOutputTokens = 2_048): FeaturePolicy => ({
  workClass,
  qualityTier: 'reasoning',
  thinkingLevel: 'low',
  maxOutputTokens,
  timeoutMs: 30_000,
});
const deep = (workClass: AiWorkClass, maxOutputTokens = 4_096): FeaturePolicy => ({
  workClass,
  qualityTier: 'deep',
  thinkingLevel: 'medium',
  maxOutputTokens,
  timeoutMs: 30_000,
});

/** Every server-side Gemini call belongs to exactly one LifeOS capability. */
export const AI_FEATURE_POLICIES = {
  activity_classification: routine('active_session', 2_048),
  activity_graph_mapping: routine('active_session'),
  alert_rewrite: routine('background', 384),
  assistant_chat: deep('interactive', 4_096),
  behavior_deep_analysis: deep('interactive', 4_096),
  checkin_signal_extraction: routine('interactive', 1_024),
  concept_generation: reasoning('interactive', 3_072),
  daily_summary: reasoning('background', 2_048),
  deep_correlations: deep('interactive', 4_096),
  distraction_nudge: routine('active_session', 512),
  dynamic_guardian_policy: reasoning('background', 2_048),
  evening_reflection: reasoning('interactive', 2_048),
  extension_task_parse: routine('interactive', 1_024),
  guardian_calibration: reasoning('background', 2_048),
  guardian_optimizer: deep('background', 4_096),
  guardian_session_domains: routine('interactive', 768),
  guardian_speech: routine('active_session', 512),
  lifeos_agent: deep('interactive', 4_096),
  lockin_intent: routine('interactive', 768),
  longitudinal_opening: routine('background', 512),
  memory_extraction: routine('background', 2_048),
  monthly_pattern_letter: deep('background', 4_096),
  morning_brief: reasoning('background', 2_048),
  morning_checkin_message: routine('background', 1_024),
  morning_checkin_response: reasoning('interactive', 2_048),
  next_day_planner: reasoning('interactive', 3_072),
  open_loops_audit: reasoning('background', 2_048),
  override_adjudication: reasoning('active_session', 1_024),
  proof_generation: reasoning('interactive', 2_048),
  screen_guidance: reasoning('active_session', 1_024),
  screen_narrative: routine('active_session', 768),
  screen_vision: { ...routine('active_session', 1_024), thinkingLevel: 'low' as const },
  session_intent: reasoning('interactive', 1_024),
  session_reflection: reasoning('active_session', 2_048),
  screenshot_pipeline: { ...routine('active_session', 1_024), thinkingLevel: 'low' as const },
  study_plan: reasoning('interactive', 4_096),
  task_goal_linking: routine('background', 768),
  task_prioritization: routine('background', 2_048),
  telegram_agent: deep('interactive', 4_096),
  unified_intelligence_synthesis: { ...deep('background', 4_096), qualityTier: 'reasoning' as const },
  voice_conversation: deep('active_session', 4_096),
  voice_intent: routine('active_session', 768),
  voice_session_analysis: reasoning('background', 2_048),
  voice_tutor: deep('active_session', 4_096),
  weekly_reckoning: deep('background', 4_096),
} as const satisfies Record<string, FeaturePolicy>;

export type AiFeature = keyof typeof AI_FEATURE_POLICIES;

export type AiCallContext = {
  feature: AiFeature;
  trigger?: string;
  entityId?: string;
  workClass?: AiWorkClass;
  qualityTier?: AiQualityTier;
};

export type AiExecutionPolicy = {
  model: string;
  workClass: AiWorkClass;
  qualityTier: AiQualityTier;
  thinkingLevel: AiThinkingLevel;
  maxOutputTokens: number;
  timeoutMs: number;
};

export function resolveAiExecutionPolicy(_requestedModel: string, context: AiCallContext): AiExecutionPolicy {
  const configured = AI_FEATURE_POLICIES[context.feature];
  const qualityTier = context.qualityTier ?? configured.qualityTier;
  const workClass = context.workClass ?? configured.workClass;
  const model = qualityTier === 'routine' ? MODEL_REALTIME_ACTIVITY : MODEL_PRO;
  const thinkingLevel = qualityTier === 'routine'
    ? configured.thinkingLevel ?? 'minimal'
    : qualityTier === 'deep'
      ? 'medium'
      : configured.thinkingLevel ?? 'low';
  return {
    model,
    workClass,
    qualityTier,
    thinkingLevel,
    maxOutputTokens: configured.maxOutputTokens ?? (qualityTier === 'deep' ? 4_096 : qualityTier === 'reasoning' ? 2_048 : 768),
    timeoutMs: configured.timeoutMs ?? (qualityTier === 'routine' ? 25_000 : 30_000),
  };
}
