import { getDb } from './db';
import {
  findFactsByTopic,
  insertEpisode,
  insertFact,
  updateFact,
  type FactCategory,
  type FactStatus,
} from './memory';

export type ExplicitFeedback =
  | 'helpful'
  | 'not_helpful'
  | 'dismissed'
  | 'not_now'
  | 'wrong'
  | 'started'
  | 'completed'
  | 'already_known'
  | 'retry';

export interface FeedbackLearningInput {
  source: 'coach_response' | 'task_recommendation' | 'alert' | 'native_guidance' | 'native_classification' | 'behavior_insight' | 'session_feedback';
  feedback: ExplicitFeedback;
  surface?: string | null;
  momentMode?: string | null;
  reason?: string | null;
  subject?: string | null;
  outcomeId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface FeedbackLearningResult {
  episodeId: number;
  factId: number;
  topic: string;
  operation: 'inserted' | 'updated';
}

export interface LearnedFeedbackFact {
  id: number;
  category: FactCategory;
  topic: string;
  content: string;
  confidence: number;
  importance: number;
  status: FactStatus;
  source: string;
  confirmed_count: number;
  last_confirmed: string;
  created_at: string;
}

const POSITIVE = new Set<ExplicitFeedback>(['helpful', 'started', 'completed']);
const NEGATIVE = new Set<ExplicitFeedback>(['not_helpful', 'wrong', 'dismissed', 'not_now', 'retry']);

function cleanText(value?: string | null, max = 280): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'general';
}

function sourceLabel(source: FeedbackLearningInput['source']): string {
  return source.replace(/_/g, ' ');
}

function buildFact(input: FeedbackLearningInput): {
  category: FactCategory;
  topic: string;
  content: string;
  confidence: number;
  importance: number;
} {
  const subject = cleanText(input.subject, 140);
  const reason = cleanText(input.reason, 220);
  const surface = cleanText(input.surface, 60);
  const moment = cleanText(input.momentMode, 60);
  const base = sourceLabel(input.source);
  const subjectPart = subject ? ` about "${subject}"` : '';
  const contextPart = [
    surface ? `surface=${surface}` : null,
    moment ? `mode=${moment}` : null,
  ].filter(Boolean).join(', ');
  const context = contextPart ? ` (${contextPart})` : '';
  const reasonPart = reason ? ` Reason: ${reason}` : '';

  if (input.feedback === 'wrong') {
    return {
      category: 'constraint',
      topic: `${slug(input.source)}_wrong_fit`,
      content: `User marked ${base}${subjectPart} as wrong${context}.${reasonPart || ' Avoid repeating this inference without stronger evidence.'}`,
      confidence: reason ? 0.9 : 0.84,
      importance: 0.82,
    };
  }

  if (input.feedback === 'not_helpful') {
    return {
      category: 'preference',
      topic: `${slug(input.source)}_not_helpful`,
      content: `User said ${base}${subjectPart} was not helpful${context}.${reasonPart || ' Adjust timing, tone, or recommendation fit before using this pattern again.'}`,
      confidence: reason ? 0.86 : 0.8,
      importance: 0.74,
    };
  }

  if (input.feedback === 'dismissed' || input.feedback === 'not_now') {
    return {
      category: 'preference',
      topic: `${slug(input.source)}_timing`,
      content: `User deferred or dismissed ${base}${subjectPart}${context}.${reasonPart || ' Treat this as a timing/salience signal, not a permanent dislike.'}`,
      confidence: reason ? 0.78 : 0.72,
      importance: 0.62,
    };
  }

  if (input.feedback === 'already_known') {
    return {
      category: 'preference',
      topic: `${slug(input.source)}_novelty`,
      content: `User marked ${base}${subjectPart} as already known${context}. Prefer fresher, less repetitive insights next time.`,
      confidence: 0.82,
      importance: 0.7,
    };
  }

  if (input.feedback === 'retry') {
    return {
      category: 'constraint',
      topic: `${slug(input.source)}_retry_needed`,
      content: `User requested a retry for ${base}${subjectPart}${context}.${reasonPart || ' Previous answer likely missed the useful framing or specificity.'}`,
      confidence: reason ? 0.86 : 0.78,
      importance: 0.72,
    };
  }

  if (input.feedback === 'started' || input.feedback === 'completed') {
    return {
      category: 'pattern',
      topic: `${slug(input.source)}_actionable_fit`,
      content: `User acted on ${base}${subjectPart}${context}. Similar recommendations are more likely to fit when matched to this context.`,
      confidence: input.feedback === 'completed' ? 0.86 : 0.8,
      importance: input.feedback === 'completed' ? 0.78 : 0.7,
    };
  }

  return {
    category: 'preference',
    topic: `${slug(input.source)}_works`,
    content: `User marked ${base}${subjectPart} as helpful${context}.${reasonPart || ' Similar tone, timing, and specificity are likely useful.'}`,
    confidence: reason ? 0.82 : 0.76,
    importance: 0.68,
  };
}

function upsertFeedbackFact(
  fact: ReturnType<typeof buildFact>,
  episodeId: number,
): { factId: number; operation: 'inserted' | 'updated' } {
  const existing = findFactsByTopic(fact.category, fact.topic)
    .filter(row => row.source === 'feedback_learning' || row.source === 'extracted')
    .sort((a, b) => b.confirmed_count - a.confirmed_count)[0];

  if (existing) {
    updateFact(existing.id, {
      content: fact.content,
      confidence: Math.max(existing.confidence, fact.confidence),
      importance: Math.max(existing.importance, fact.importance),
      mergeEpisodeIds: [episodeId],
      status: 'active',
    });
    return { factId: existing.id, operation: 'updated' };
  }

  return {
    factId: insertFact({
      category: fact.category,
      topic: fact.topic,
      content: fact.content,
      confidence: fact.confidence,
      importance: fact.importance,
      source: 'feedback_learning',
      sourceEpisodeIds: [episodeId],
      status: 'active',
    }),
    operation: 'inserted',
  };
}

export function recordExplicitFeedbackLearning(input: FeedbackLearningInput): FeedbackLearningResult {
  const fact = buildFact(input);
  const subject = cleanText(input.subject, 140);
  const reason = cleanText(input.reason, 220);
  const polarity = POSITIVE.has(input.feedback)
    ? 'positive'
    : NEGATIVE.has(input.feedback)
      ? 'negative'
      : 'neutral';

  const episodeId = insertEpisode('manual', `Feedback: ${input.feedback} on ${sourceLabel(input.source)}${subject ? ` (${subject})` : ''}`, {
    rawContext: {
      source: input.source,
      feedback: input.feedback,
      polarity,
      surface: input.surface ?? null,
      momentMode: input.momentMode ?? null,
      reason,
      subject,
      outcomeId: input.outcomeId ?? null,
      metadata: input.metadata ?? {},
      learnedFact: fact.content,
    },
    importance: fact.importance,
  });

  const stored = upsertFeedbackFact(fact, episodeId);
  return {
    episodeId,
    factId: stored.factId,
    topic: fact.topic,
    operation: stored.operation,
  };
}

export function getFeedbackLearningSummary(limit = 20): LearnedFeedbackFact[] {
  return getDb().prepare(`
    SELECT id, category, topic, content, confidence, importance, status, source,
           confirmed_count, last_confirmed, created_at
    FROM mem_facts
    WHERE source = 'feedback_learning'
      AND status != 'superseded'
    ORDER BY importance DESC, confirmed_count DESC, last_confirmed DESC
    LIMIT ?
  `).all(limit) as LearnedFeedbackFact[];
}
