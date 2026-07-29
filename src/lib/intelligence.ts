import { getDb, getSetting } from './db';
import { getUnblockedNextConcepts } from './graph';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import { getMemoryContext } from './memory';
import { getAdaptiveBands, classifyCognitiveLoad, classifyGoalHealth, classifyFocus } from './adaptive-bands';
import {
  formatHistoryEpochContext,
  getHistoryEpochInfo,
  getHistoryStartDate,
  historyStartEpochMs,
  isInCurrentHistory,
  lookbackStartDate,
} from './history-epoch';

// ============================================================
//  COGNITIVE INTELLIGENCE ENGINE
//  Zeigarnik audit, smart prioritization, self-efficacy recovery
// ============================================================

interface CognitiveLoadAudit {
  openTaskCount: number;
  mentalBandwidth: number; // 0-100, lower = more overloaded
  status: 'clear' | 'moderate' | 'overloaded';
  quickWins: { id: number; title: string; status: string; created_at: string }[];
  deferCandidates: { id: number; title: string; status: string; priority: string }[];
}

interface RecommendedTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  goalTitle: string | null;
  score: number;
  reason: string;
}

interface EfficacyMode {
  rate: number;
  isRecoveryMode: boolean;
  message: string;
  suggestedActions: string[];
}

/**
 * Zeigarnik Effect — Cognitive Load Audit
 * Counts open tasks and suggests quick wins to close mental loops.
 */
export function getCognitiveLoadAudit(): CognitiveLoadAudit {
  const db = getDb();

  const openTasks = db.prepare(
    "SELECT id, title, status, priority, created_at, due_date FROM tasks WHERE status IN ('todo', 'doing') ORDER BY created_at ASC"
  ).all() as any[];

  const count = openTasks.length;
  const bands = getAdaptiveBands();
  const baseline = Math.max(3, bands.cognitiveLoadModerate / 12);
  const bandwidth = Math.max(0, Math.min(100, 100 - (count - baseline) * 12));
  const status = classifyCognitiveLoad(bandwidth);

  // Quick wins: oldest tasks with low/medium priority (likely small)
  const quickWins = openTasks
    .filter(t => t.priority !== 'critical' && t.priority !== 'high')
    .slice(0, 3);

  // Defer candidates: tasks with no deadline and low priority
  const deferCandidates = openTasks
    .filter(t => !t.due_date && (t.priority === 'low' || t.priority === 'medium'))
    .slice(-3);

  return { openTaskCount: count, mentalBandwidth: bandwidth, status, quickWins, deferCandidates };
}

/**
 * Smart Prioritization — "What to Work on Next"
 * Ranks all active tasks by composite score using TMT, goal urgency, efficacy match.
 */
export function getSmartPrioritization(): RecommendedTask[] {
  const db = getDb();

  const activeTasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.goal_id, t.created_at,
           g.title as goal_title, g.deadline as goal_deadline
    FROM tasks t
    LEFT JOIN goals g ON t.goal_id = g.id
    WHERE t.status IN ('todo', 'doing')
    ORDER BY t.position ASC
  `).all() as any[];

  const now = Date.now();
  const priorityWeight: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10 };
  const bands = getAdaptiveBands();
  const deadlineUrgencyMax = 30;
  const deadlineDecay = Math.max(1, Math.round(deadlineUrgencyMax / bands.habitAtRiskDays));
  const goalUrgencyMax = 20;
  const goalDecay = Math.max(1, Math.round(goalUrgencyMax / bands.habitAtRiskDays));

  // Graph-aware: Boost tasks linked to unblocked, undermastered concepts
  let graphBoostTaskIds: Set<number> = new Set();
  try {
    const activeGoals = db.prepare(`SELECT DISTINCT goal_id FROM tasks WHERE status IN ('todo','doing') AND goal_id IS NOT NULL`).all() as { goal_id: number }[];
    for (const { goal_id } of activeGoals) {
      const unblocked = getUnblockedNextConcepts(goal_id);
      for (const concept of unblocked) {
        for (const task of concept.linked_tasks) {
          if (task.status !== 'done') graphBoostTaskIds.add(task.id);
        }
      }
    }
  } catch (e) { /* non-critical */ }

  const scored = activeTasks.map(t => {
    let score = 0;
    let reasons: string[] = [];

    // Priority weight
    const pw = priorityWeight[t.priority] || 20;
    score += pw;
    if (pw >= 30) reasons.push(`${t.priority} priority`);

    // Knowledge graph boost: task directly addresses an unblocked concept
    if (graphBoostTaskIds.has(t.id)) {
      score += 18;
      reasons.push('addresses knowledge gap');
    }

    // Deadline urgency (TMT-inspired: closer deadline = higher score)
    if (t.due_date) {
      const daysLeft = Math.max(0, Math.ceil((new Date(t.due_date).getTime() - now) / 86400000));
      const urgency = Math.max(0, deadlineUrgencyMax - daysLeft * deadlineDecay);
      score += urgency;
      if (daysLeft <= 2) reasons.push(`due ${daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : 'in 2 days'}`);
    }

    // Goal deadline urgency
    if (t.goal_deadline) {
      const goalDaysLeft = Math.max(0, Math.ceil((new Date(t.goal_deadline).getTime() - now) / 86400000));
      const goalUrgency = Math.max(0, goalUrgencyMax - goalDaysLeft * goalDecay);
      score += goalUrgency;
      if (goalDaysLeft <= 7) reasons.push(`goal deadline in ${goalDaysLeft}d`);
    }

    // Goal progress gap — goals behind schedule get boosted
    if (t.goal_id) {
      const goalTasks = db.prepare(
        "SELECT COUNT(*) as total, COUNT(CASE WHEN status='done' THEN 1 END) as done FROM tasks WHERE goal_id = ?"
      ).get(t.goal_id) as { total: number; done: number };
      if (goalTasks.total > 0) {
        const progress = goalTasks.done / goalTasks.total;
        if (progress < bands.goalAtRiskVelocity) {
          score += 15;
          reasons.push(`goal "${t.goal_title}" behind at ${Math.round(progress * 100)}%`);
        }
      }
    }

    // Status boost: "doing" tasks get a small boost (already started)
    if (t.status === 'doing') {
      score += 10;
      reasons.push('in progress');
    }

    // Age penalty: older tasks get a slight boost to prevent staleness
    const ageDays = Math.round((now - new Date(t.created_at).getTime()) / 86400000);
    if (ageDays > 7) {
      score += Math.min(10, ageDays - 7);
      if (ageDays > 14) reasons.push(`${ageDays} days old`);
    }

    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority || 'medium',
      goalTitle: t.goal_title || null,
      score,
      reason: reasons.length > 0 ? reasons.join(' · ') : 'standard priority',
    };
  });

  // Sort by score descending, return top 5
  return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * Self-Efficacy Recovery Mode
 * When rolling task success rate drops below 30%, enter recovery mode.
 */
export function getSelfEfficacyMode(): EfficacyMode {
  const db = getDb();

  const efficacy = db.prepare(`
    SELECT 
      COUNT(CASE WHEN status = 'done' THEN 1 END) as completed,
      COUNT(*) as total
    FROM tasks 
    WHERE status IN ('todo', 'doing', 'done')
    AND created_at >= datetime('now', '-14 days')
  `).get() as { completed: number; total: number };

  const rate = efficacy.total > 0 ? Math.round((efficacy.completed / efficacy.total) * 100) : 50;
  const isRecoveryMode = rate < 30 && efficacy.total >= 5;

  let message = '';
  const suggestedActions: string[] = [];

  if (isRecoveryMode) {
    message = `Your task completion is at ${rate}%. Let's rebuild momentum with some quick wins.`;
    suggestedActions.push('Complete 3 easy tasks to rebuild confidence');
    suggestedActions.push('Defer or remove tasks you won\'t realistically complete');
    suggestedActions.push('Break large tasks into smaller subtasks');
  } else if (rate < 50) {
    message = `Task completion at ${rate}%. Room for improvement — focus on your top priorities.`;
    suggestedActions.push('Prioritize tasks linked to your active goals');
  } else if (rate >= 70) {
    message = `Excellent ${rate}% completion rate! You're in a strong execution rhythm.`;
  } else {
    message = `Solid ${rate}% completion rate. Keep it up!`;
  }

  return { rate, isRecoveryMode, message, suggestedActions };
}

/**
 * Detect Goal Conflicts
 * Finds correlations between task completion on one goal and habit/task misses on another.
 */
export function detectGoalConflicts(): { goalA: string; goalB: string; message: string }[] {
  const db = getDb();
  const conflicts: { goalA: string; goalB: string; message: string }[] = [];

  try {
    // Find goals where recent task completion correlates with habit misses
    const goals = db.prepare('SELECT id, title FROM goals WHERE active = 1').all() as any[];

    for (const goal of goals) {
      const linkedHabits = db.prepare(`
        SELECT h.name, h.id FROM habits h WHERE h.goal_id = ? AND h.archived = 0
      `).all(goal.id) as any[];

      for (const habit of linkedHabits) {
        // Check if habit has been missed more than 3 of the last 7 days
        const recent = db.prepare(`
          SELECT COUNT(*) as checked FROM habit_checkins 
          WHERE habit_id = ? AND completed = 1 AND date >= date('now', '-7 days')
        `).get(habit.id) as { checked: number };

        if (recent.checked <= 4) {
          // Check if other goals have been getting tasks completed
          const busyGoals = db.prepare(`
            SELECT g.title, COUNT(*) as completions FROM tasks t
            JOIN goals g ON t.goal_id = g.id
            WHERE t.status = 'done' AND t.completed_at >= datetime('now', '-7 days')
            AND g.id != ?
            GROUP BY g.id HAVING completions >= 3
          `).all(goal.id) as any[];

          for (const busy of busyGoals) {
            conflicts.push({
              goalA: busy.title,
              goalB: goal.title,
              message: `Working on "${busy.title}" may be causing you to miss ${habit.name} (${recent.checked}/7 days this week).`,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[Intelligence] Goal conflict detection error:', err);
  }

  return conflicts;
}

// ============================================================
//  UNIFIED INTELLIGENCE LAYER (UIL)
//
//  A single continuously-evolving model of the user powered by
//  Gemini PRO, synthesizing EVERY signal in the system:
//  sessions · focus scores · voice · mood · goals · tasks ·
//  habits · calendar · chat · behavioral memories · domains.
//
//  Every module reads from getIntelligenceContext() instead of
//  building its own fragmented slice of context.
// ============================================================

export interface AdaptiveThresholds {
  focusDropAlertScore: number;        // Min score before drop alert fires
  cognitiveLoadThreshold: number;     // Open tasks before load alert
  distractionAlertMinutes: number;    // Minutes on distraction before nudge
  sessionDurationSweetSpot: number;   // Recommended sprint length
  habitRiskDays: number;              // Days without check-in = at risk
  cognitiveLoadAdvice?: string;       // Custom AI advice when threshold is breached
  focusDropAdvice?: string;           // Custom AI advice if focus plummets
  habitRiskAdvice?: string;           // Custom motivation to save a streak
  efficacyAdvice?: string;            // Custom advice if task completion rate stays low
}

export interface GoalMomentumMap {
  [goalTitle: string]: 'gaining' | 'stable' | 'stalling' | 'at_risk';
}

export interface UserIntelligenceProfile {
  version: number;
  synthesizedAt: number;
  trigger: string;
  // Cognitive patterns
  peakFocusHours: number[];
  optimalSessionMinutes: number;
  avgSessionFocusScore: number;
  focusTrend: 'improving' | 'declining' | 'stable';
  totalFocusMinutesThisWeek: number;
  // Energy model
  energyByHour: Record<string, number>;
  currentEnergyEstimate: 'high' | 'medium' | 'low';
  energyPattern: string;
  // Behavioral patterns
  topProductiveDomains: string[];
  topDistractionDomains: string[];
  distractionTriggers: string[];
  avoidancePatterns: string[];
  strongTopics: string[];
  frictionTopics: string[];
  // Goals & tasks
  goalMomentum: GoalMomentumMap;
  taskCompletionRate: number;
  activeGoalsSummary: string[];
  nextRecommendedTopic: string;
  // Habits
  habitStreakSummary: string[];
  habitsAtRisk: string[];
  // Today's context
  standupGoalToday: string | null;
  moodToday: 'high' | 'medium' | 'low' | null;
  calendarEventsToday: string[];
  // Learning
  recentStudyTopics: string[];
  knowledgeGaps: string[];
  preferredCoachingStyle: 'direct' | 'balanced' | 'gentle';
  // Adaptive thresholds — calibrated to this user, not hardcoded
  adaptiveThresholds: AdaptiveThresholds;
  // AI narrative
  currentNarrative: string;
  coachingInsights: string[];
  nextBestFocusWindow: string;
  weeklyProgressSummary: string;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

const UIL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let uilProfile: UserIntelligenceProfile | null = null;
let uilCacheTs = 0;
let uilSynthesisRunning = false;
let uilSynthesisQueued = false;

function isUILSynthesisDisabled(): boolean {
  return process.env.LIFEOS_DISABLE_UIL_SYNTHESIS === '1' || process.env.LIFEOS_DISABLE_UIL_SYNTHESIS === 'true';
}

const UIL_DEFAULT: UserIntelligenceProfile = {
  version: 0, synthesizedAt: 0, trigger: 'default',
  peakFocusHours: [9, 15], optimalSessionMinutes: 60,
  avgSessionFocusScore: 70, focusTrend: 'stable', totalFocusMinutesThisWeek: 0,
  energyByHour: {}, currentEnergyEstimate: 'medium', energyPattern: '',
  topProductiveDomains: [], topDistractionDomains: [],
  distractionTriggers: [], avoidancePatterns: [],
  strongTopics: [], frictionTopics: [],
  goalMomentum: {}, taskCompletionRate: 0, activeGoalsSummary: [], nextRecommendedTopic: '',
  habitStreakSummary: [], habitsAtRisk: [],
  standupGoalToday: null, moodToday: null, calendarEventsToday: [],
  recentStudyTopics: [], knowledgeGaps: [],
  preferredCoachingStyle: 'balanced',
  adaptiveThresholds: {
    focusDropAlertScore: 65, cognitiveLoadThreshold: 8,
    distractionAlertMinutes: 15, sessionDurationSweetSpot: 60, habitRiskDays: 2,
    cognitiveLoadAdvice: "Consider knocking out a quick task to build momentum.",
    focusDropAdvice: "Your focus is slipping. Take a 5-minute breather away from screens.",
    habitRiskAdvice: "Don't let your streak break—even 2 minutes counts today.",
    efficacyAdvice: "Focus purely on small, low-friction tasks to rebuild confidence.",
  },
  currentNarrative: '', coachingInsights: [], nextBestFocusWindow: '', weeklyProgressSummary: '',
};

// ─── Signal aggregation ───────────────────────────────────────────────────────

function appendDeterministicCognitiveMap(sections: string[]): void {
  // Shared Cognitive Self-Map — ground truth numbers for UIL synthesis (do not invent contradicting PDI/voluntary claims)
  try {
    // Lazy require avoids circular init with personalization-context consumers
    const { computeCognitiveTraits, formatCognitiveTraitsForPrompt } = require('./cognitive-traits') as typeof import('./cognitive-traits');
    const { getActiveCoachPolicy, formatActiveCoachForPrompt } = require('./cognitive-active-coach') as typeof import('./cognitive-active-coach');
    const { getCognitiveTrajectory } = require('./cognitive-self-answer') as typeof import('./cognitive-self-answer');
    const traits = computeCognitiveTraits({ windowDays: 45 });
    const coach = getActiveCoachPolicy({ traits });
    const traj = getCognitiveTrajectory({ historyLimit: 90 });
    sections.push('\n=== DETERMINISTIC COGNITIVE SELF-MAP (ground truth — do not contradict) ===');
    sections.push(formatCognitiveTraitsForPrompt(traits));
    sections.push(formatActiveCoachForPrompt(coach));
    sections.push(`Trajectory: ${traj.headline} (${traj.historyDays} daily snapshots, ${traj.weeks.length} week buckets)`);
    if (traj.weeks.length) {
      const recent = traj.weeks.slice(-3);
      sections.push(
        'Recent weeks: ' + recent.map(w => {
          const pdi = w.avgPressureDependency == null ? 'n/a' : Math.round(w.avgPressureDependency * 100);
          const vol = w.avgVoluntaryStartRate == null ? 'n/a' : `${Math.round(w.avgVoluntaryStartRate * 100)}%`;
          return `${w.weekStart} PDI=${pdi} vol=${vol} (${w.pressureTrend}/${w.voluntaryTrend})`;
        }).join(' · '),
      );
    }
  } catch {
    /* cognitive map optional if modules fail in constrained envs */
  }
}

function aggregateSignals(): string {
  const db = getDb();
  const nowIst = new Date(Date.now() + 19800000);
  const today = nowIst.toISOString().slice(0, 10);
  const epoch = getHistoryStartDate();
  const fortnight = lookbackStartDate(14, today);
  const monthStart = lookbackStartDate(30, today);
  const epochInfo = getHistoryEpochInfo();
  const sections: string[] = [formatHistoryEpochContext()];

  // Guardian sessions (post-epoch only)
  try {
    const rows = db.prepare(`
      SELECT target_title, goal_title, mood, elapsed_minutes, average_focus_score,
             blocked_count, override_count,
             strftime('%H', started_at, 'localtime') as hour,
             date(completed_at, 'localtime') as day
      FROM guardian_session_summaries
      WHERE date(COALESCE(completed_at, started_at), 'localtime') >= ?
      ORDER BY completed_at DESC LIMIT 30
    `).all(epoch) as Array<Record<string, unknown>>;
    if (rows.length) {
      sections.push('\n=== GUARDIAN SESSIONS (this run) ===');
      for (const s of rows) {
        sections.push(`[${s.day} ${s.hour}:00] "${s.target_title}" — ${s.elapsed_minutes}min, score=${Math.round(Number(s.average_focus_score))}, mood=${s.mood ?? 'unknown'}, blocks=${s.blocked_count}`);
      }
    } else if (epochInfo.isFreshStart) {
      sections.push('\n=== GUARDIAN SESSIONS ===');
      sections.push('No focus sessions yet in this run. That is early-days, not multi-week avoidance.');
    }
  } catch { /* */ }

  // Hourly focus heatmap
  try {
    const rows = db.prepare(`
      SELECT CAST(strftime('%H', started_at, 'localtime') AS INTEGER) as hour,
             ROUND(AVG(average_focus_score)) as avg_score, COUNT(*) as count
      FROM guardian_session_summaries
      WHERE date(COALESCE(completed_at, started_at), 'localtime') >= ?
      GROUP BY hour ORDER BY hour
    `).all(monthStart) as Array<{ hour: number; avg_score: number; count: number }>;
    if (rows.length) {
      sections.push('\n=== HOURLY FOCUS HEATMAP ===');
      sections.push(rows.map(r => `${String(r.hour).padStart(2, '0')}:00 → score=${r.avg_score}, n=${r.count}`).join(' | '));
    }
  } catch { /* */ }

  // Daily scores
  try {
    const rows = db.prepare(`SELECT date, ROUND(score) as score FROM daily_scores WHERE date >= ? ORDER BY date`).all(fortnight) as Array<{ date: string; score: number }>;
    if (rows.length) {
      sections.push('\n=== DAILY SCORES ===');
      sections.push(rows.map(r => `${r.date}:${r.score}`).join(', '));
    }
  } catch { /* */ }

  // Goals + task completion — only goals engaged in this history run
  try {
    const rows = db.prepare(`
      SELECT g.id, g.title, g.deadline, g.created_at, g.updated_at,
             COUNT(t.id) as total, SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) as done,
             COUNT(CASE WHEN t.due_date < date('now') AND t.status != 'done' AND t.created_at >= ? THEN 1 END) as overdue
      FROM goals g LEFT JOIN tasks t ON t.goal_id = g.id
      WHERE g.active = 1 GROUP BY g.id
    `).all(epoch) as Array<Record<string, unknown>>;
    const inScope = rows.filter(g => isInCurrentHistory({
      createdAt: String(g.created_at ?? ''),
      updatedAt: String(g.updated_at ?? ''),
    }));
    if (inScope.length) {
      sections.push('\n=== ACTIVE GOALS (this run) ===');
      for (const g of inScope) {
        const pct = Number(g.total) > 0 ? Math.round((Number(g.done) / Number(g.total)) * 100) : 0;
        sections.push(`"${g.title}" ${pct}% done (${g.done}/${g.total} tasks, ${g.overdue} overdue)${g.deadline ? ` deadline=${g.deadline}` : ''}`);
      }
    } else {
      sections.push('\n=== ACTIVE GOALS ===');
      sections.push(epochInfo.isFreshStart
        ? 'No goals created in this run yet. Do not lecture about pre-epoch goals.'
        : 'No in-scope active goals for this history epoch.');
    }
  } catch { /* */ }

  // Overdue / avoided tasks (created or updated post-epoch only)
  try {
    const rows = db.prepare(`
      SELECT title, julianday('now') - julianday(due_date) as days_overdue
      FROM tasks
      WHERE status != 'done' AND due_date < date('now')
        AND (date(created_at) >= ? OR date(COALESCE(updated_at, created_at)) >= ?)
      ORDER BY days_overdue DESC LIMIT 8
    `).all(epoch, epoch) as Array<{ title: string; days_overdue: number }>;
    if (rows.length) {
      sections.push('\n=== OVERDUE/AVOIDED TASKS ===');
      sections.push(rows.map(r => `"${r.title}" (${Math.round(r.days_overdue)}d overdue)`).join(', '));
    }
  } catch { /* */ }

  // Habits
  try {
    const rows = db.prepare(`
      SELECT h.name, h.icon, COALESCE(h.streak,0) as streak,
             COUNT(CASE WHEN hc.completed=1 AND hc.date >= ? THEN 1 END) as done14,
             MAX(CASE WHEN hc.date=? AND hc.completed=1 THEN 1 ELSE 0 END) as done_today
      FROM habits h LEFT JOIN habit_checkins hc ON hc.habit_id=h.id
      WHERE h.archived=0 GROUP BY h.id
    `).all(fortnight, today) as Array<Record<string, unknown>>;
    if (rows.length) {
      sections.push('\n=== HABITS ===');
      for (const h of rows) {
        sections.push(`${h.icon} ${h.name} — streak=${h.streak}d, 14d=${h.done14}/14, today=${h.done_today ? 'done' : 'PENDING'}`);
      }
    }
  } catch { /* */ }

  // Domain activity (post-epoch lookback)
  try {
    const rows = db.prepare(`
      SELECT domain, category, ROUND(SUM(duration_seconds)/60) as mins
      FROM activities
      WHERE date(started_at) >= ? AND domain != ''
      GROUP BY domain, category ORDER BY mins DESC LIMIT 15
    `).all(fortnight) as Array<{ domain: string; category: string; mins: number }>;
    if (rows.length) {
      sections.push('\n=== BROWSING PATTERNS (this run lookback) ===');
      sections.push(rows.map(r => `${r.domain}(${r.category},${r.mins}min)`).join(', '));
    }
  } catch { /* */ }

  // Voice turns
  try {
    const rows = db.prepare(`SELECT role, text FROM voice_turns ORDER BY created_at DESC LIMIT 25`).all() as Array<{ role: string; text: string }>;
    if (rows.length) {
      sections.push('\n=== RECENT VOICE TURNS ===');
      sections.push(rows.reverse().map(r => `${r.role === 'user' ? 'U' : 'G'}: ${r.text.slice(0, 100)}`).join('\n'));
    }
  } catch { /* */ }

  // Session reflections
  try {
    const rows = db.prepare(`
      SELECT r.reflection_text, s.target_title FROM guardian_session_reflections r
      JOIN guardian_session_summaries s ON s.session_id = r.session_id
      ORDER BY s.completed_at DESC LIMIT 4
    `).all() as Array<{ reflection_text: string; target_title: string }>;
    if (rows.length) {
      sections.push('\n=== SESSION REFLECTIONS ===');
      sections.push(rows.map(r => `"${r.target_title}": ${r.reflection_text.slice(0, 150)}`).join('\n'));
    }
  } catch { /* */ }

  // Today's standup
  try {
    const date = getSetting('standup_goal_date');
    const goal = getSetting('standup_goal_today');
    const mood = getSetting('standup_mood_today');
    if (date === today && goal) {
      sections.push(`\n=== TODAY STANDUP ===\nGoal: "${goal}" Mood: ${mood || '?'}`);
    }
  } catch { /* */ }

  // Behavioral memories
  try {
    const rows = db.prepare(`SELECT memory_type, content, confidence FROM behavioral_memory WHERE confidence>=0.5 AND superseded=0 ORDER BY confidence DESC LIMIT 12`).all() as Array<{ memory_type: string; content: string; confidence: number }>;
    if (rows.length) {
      sections.push('\n=== LEARNED PATTERNS ===');
      sections.push(rows.map(r => `[${r.confidence.toFixed(1)}] ${r.memory_type}: ${r.content}`).join('\n'));
    }
  } catch { /* */ }

  // Semantic profile
  try {
    const row = db.prepare(`SELECT preferred_session_duration, preferred_coaching_style, dominant_distraction_category, peak_focus_hour_start, commitment_follow_through_rate FROM guardian_semantic_profiles ORDER BY updated_at DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
    if (row) {
      sections.push('\n=== SEMANTIC PROFILE ===');
      sections.push(Object.entries(row).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join(', '));
    }
  } catch { /* */ }

  // Semantic memory facts — distilled long-term facts from the 4-tier memory layer
  try {
    const memCtx = getMemoryContext(12);
    if (memCtx) sections.push(`\n${memCtx}`);
  } catch { /* */ }

  // ── Task 9: New signals ────────────────────────────────────────────────────

  // Sleep pattern from recent evening check-ins (post-epoch)
  try {
    const sleepRows = db.prepare(`
      SELECT sleep_time, wake_estimate, mood, energy, day_events, tomorrow_intention
      FROM daily_checkins
      WHERE checkin_type = 'evening'
        AND checkin_date >= ?
        AND (sleep_time IS NOT NULL OR mood IS NOT NULL OR energy IS NOT NULL OR day_events IS NOT NULL)
      ORDER BY checkin_date DESC LIMIT 14
    `).all(epoch) as Array<{
      sleep_time: string | null;
      wake_estimate: string | null;
      mood: string | null;
      energy: string | null;
      day_events: string | null;
      tomorrow_intention: string | null;
    }>;

    if (sleepRows.length > 0) {
      const rowsWithSleep = sleepRows.filter(r => r.sleep_time);
      const avgSleepHour = rowsWithSleep.length > 0
        ? Math.round(rowsWithSleep.reduce((sum, r) => sum + parseInt(r.sleep_time!.split(':')[0], 10), 0) / rowsWithSleep.length)
        : null;
      const avgWakeHour = sleepRows.filter(r => r.wake_estimate).length > 0
        ? Math.round(sleepRows.filter(r => r.wake_estimate).reduce((sum, r) => sum + parseInt(r.wake_estimate!.split(':')[0], 10), 0) / sleepRows.filter(r => r.wake_estimate).length)
        : null;
      sections.push(`\n=== EVENING STATE (last ${sleepRows.length} evenings) ===`);
      if (avgSleepHour !== null) {
        sections.push(`Avg sleep hour: ${avgSleepHour}:00${avgWakeHour !== null ? `, avg wake: ${avgWakeHour}:00` : ''}`);
      }
      const moodEnergy = sleepRows
        .filter(r => r.mood || r.energy)
        .slice(0, 5)
        .map(r => [r.mood ? `mood=${r.mood}` : null, r.energy ? `energy=${r.energy}` : null].filter(Boolean).join(', '));
      if (moodEnergy.length > 0) sections.push('Recent mood/energy: ' + moodEnergy.join(' | '));
      const recentEvents = sleepRows.filter(r => r.day_events).slice(0, 3);
      if (recentEvents.length > 0) {
        sections.push('Recent day factors: ' + recentEvents.map(r => `"${r.day_events}"`).join(', '));
      }
      const recentIntentions = sleepRows.filter(r => r.tomorrow_intention).slice(0, 5);
      if (recentIntentions.length > 0) {
        sections.push('Recent stated intentions: ' + recentIntentions.map(r => `"${r.tomorrow_intention}"`).join(', '));
      }
    }
  } catch { /* daily_checkins may not have sleep columns yet */ }

  // Intention follow-through: did the user do a session matching yesterday's stated intention?
  try {
    const intentionRows = db.prepare(`
      SELECT dc.checkin_date, dc.tomorrow_intention
      FROM daily_checkins dc
      WHERE dc.checkin_type = 'evening'
        AND dc.checkin_date >= ?
        AND dc.tomorrow_intention IS NOT NULL
      ORDER BY dc.checkin_date DESC LIMIT 14
    `).all(epoch) as Array<{ checkin_date: string; tomorrow_intention: string }>;

    let fulfilled = 0;
    for (const row of intentionRows) {
      // Check if a session was started the day after with a matching title
      const nextDay = new Date(new Date(row.checkin_date).getTime() + 86400000).toISOString().slice(0, 10);
      const keyword = row.tomorrow_intention.split(' ').slice(0, 3).join('%');
      const hit = db.prepare(`
        SELECT 1 FROM guardian_session_summaries
        WHERE date(started_at, 'localtime') = ? AND target_title LIKE ?
        LIMIT 1
      `).get(nextDay, `%${keyword}%`);
      if (hit) fulfilled++;
    }
    if (intentionRows.length > 0) {
      const rate = Math.round((fulfilled / intentionRows.length) * 100);
      sections.push(`\n=== INTENTION FOLLOW-THROUGH ===`);
      sections.push(`${fulfilled}/${intentionRows.length} stated intentions followed through (${rate}%) over last 14 evenings`);
    }
  } catch { /* */ }

  // Agent correction frequency — how often does the bot make wrong inferences?
  try {
    const correctionCount = (db.prepare(`
      SELECT COUNT(*) as count FROM mem_facts
      WHERE source = 'telegram_correction'
        AND created_at > datetime('now', '-30 days')
    `).get() as { count: number }).count;

    if (correctionCount > 0) {
      sections.push(`\n=== AGENT CORRECTION SIGNAL ===`);
      sections.push(`${correctionCount} agent misclassifications corrected in last 30 days — review mem_facts source=telegram_correction for patterns`);
    }
  } catch { /* mem_facts may not exist */ }

  // Action outcome quality — were agent actions helpful?
  try {
    const outcomeRows = db.prepare(`
      SELECT action_type, helpful, was_corrected
      FROM agent_action_outcomes
      WHERE created_at > datetime('now', '-30 days')
    `).all() as Array<{ action_type: string; helpful: number | null; was_corrected: number }>;

    if (outcomeRows.length > 0) {
      const resolved = outcomeRows.filter(r => r.helpful !== null);
      const corrected = outcomeRows.filter(r => r.was_corrected === 1);
      if (resolved.length > 0) {
        const quality = Math.round(resolved.reduce((s, r) => s + (r.helpful ?? 0), 0) / resolved.length * 100);
        sections.push(`\n=== AGENT ACTION QUALITY ===`);
        sections.push(`${quality}% of ${resolved.length} evaluated actions were helpful. ${corrected.length} actions were corrected.`);
      }
    }
  } catch { /* agent_action_outcomes may not exist yet */ }

  appendDeterministicCognitiveMap(sections);
  return sections.join('\n');
}

// ─── Gemini synthesis ─────────────────────────────────────────────────────────

async function runUILSynthesis(trigger: string): Promise<UserIntelligenceProfile | null> {
  const ai = getGenAI();
  if (!ai) return null;

  const signals = aggregateSignals();
  if (!signals.trim()) return null;

  const now = new Date(Date.now() + 19800000);
  const timeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: `You are the LifeOS Intelligence Engine. Synthesize a complete, evolving behavioral and cognitive profile from ALL user data signals. Every field must be inferred from the actual data — not generic defaults.

CURRENT TIME: ${timeStr} (IST)
TRIGGER: ${trigger}

${signals}

CRITICAL RULES FOR HISTORY EPOCH:
- Coaching history starts on the HISTORY EPOCH date above. Ignore pre-epoch inactivity.
- Never say the user "did nothing for weeks/months" based on data before the epoch.
- If this is a fresh start (day ≤ 7) and post-epoch sessions/tasks are sparse, write an early-days narrative — not stalled/avoidance guilt about old goals.
- Pre-epoch goals must not appear as active stalled goals unless re-engaged after the epoch.

CRITICAL RULES FOR COGNITIVE SELF-MAP (if present above):
- Pressure Dependency Index, voluntary start rate, activation energy, and crisis performance are DETERMINISTIC measurements. Treat them as ground truth.
- Do NOT invent opposing claims (e.g. saying the user is not deadline-driven when PDI is high).
- currentNarrative and coachingInsights MUST incorporate pressure-wiring / voluntary-start / rewiring goals when those traits have confidence ≥ 0.3 or user stance confirmed/aspirational.
- Celebrate crisis performance as a skill with a cost when crisis bonus is positive; prefer coaching that builds voluntary starts beside it, never shame.

CRITICAL RULES FOR "adaptiveThresholds":
- cognitiveLoadThreshold: Set this to the actual number of active tasks where you believe the user will genuinely start feeling overwhelmed. DO NOT arbitrarily drop this just because their current task count is low. Only lower it if you have evidence they are actively struggling.
- Advice Fields (*Advice): You MUST personalize these deeply based on the specific topics, goals, and habits they are dealing with today. Do not use generic placeholders. Tell them exactly what to do (e.g. "Close Youtube and go back to ZK Proofs", or "Knock out the DSA array problem to regain momentum").

Return ONLY valid JSON (no markdown, no explanation):
{
  "peakFocusHours": [9, 15],
  "optimalSessionMinutes": 75,
  "avgSessionFocusScore": 74,
  "focusTrend": "improving",
  "totalFocusMinutesThisWeek": 340,
  "energyByHour": {"9": 85, "10": 82, "14": 55, "15": 80},
  "currentEnergyEstimate": "medium",
  "energyPattern": "Morning person — peak 9-11am, dips at 2pm, secondary peak 3pm",
  "topProductiveDomains": ["leetcode.com", "arxiv.org"],
  "topDistractionDomains": ["youtube.com", "twitter.com"],
  "distractionTriggers": ["after 45min on math topics", "post-lunch 1-2pm"],
  "avoidancePatterns": ["Write research abstract"],
  "strongTopics": ["ZK proofs", "Groth16"],
  "frictionTopics": ["Linear algebra"],
  "goalMomentum": {"ZK proofs": "gaining", "DSA 150": "stalling"},
  "taskCompletionRate": 62,
  "activeGoalsSummary": ["ZK proofs (72%)", "DSA 150 (30%)"],
  "nextRecommendedTopic": "ZK proofs — momentum strong, continue",
  "habitStreakSummary": ["Leetcode: 12 days", "Gym: 4 days"],
  "habitsAtRisk": ["Morning run"],
  "standupGoalToday": "Complete ZK chapter 3",
  "moodToday": "medium",
  "calendarEventsToday": ["10:00 Team sync"],
  "recentStudyTopics": ["Groth16", "PLONK", "elliptic curves"],
  "knowledgeGaps": ["PLONK constraint system", "why Groth16 needs trusted setup"],
  "preferredCoachingStyle": "direct",
  "adaptiveThresholds": {
    "focusDropAlertScore": 62,
    "cognitiveLoadThreshold": 9,
    "distractionAlertMinutes": 18,
    "sessionDurationSweetSpot": 75,
    "habitRiskDays": 2,
    "cognitiveLoadAdvice": "When you hit this limit, pause and quickly knock out the smallest technical bug to regain momentum.",
    "focusDropAdvice": "Close the Twitter tab and re-center—your ZK Proofs momentum is too good to lose right now.",
    "habitRiskAdvice": "Commit 5 minutes to Leetcode right now so you don't lose that 12-day streak.",
    "efficacyAdvice": "You've been struggling to clear tasks. Grab an easy task from the Groth16 backlog just to get a win."
  },
  "currentNarrative": "You are in a focused phase on ZK proofs with improving scores. DSA has stalled for 5 days. Strongest window is 9-11am.",
  "coachingInsights": [
    "Lock in ZK proofs at 9am — peak hour + current momentum",
    "DSA needs one session this week or goal falls behind",
    "Pre-block YouTube — distraction spike happens at 45min mark"
  ],
  "nextBestFocusWindow": "Today 9am–11am (historical peak + session momentum)",
  "weeklyProgressSummary": "5 sessions this week (up from 3), avg focus 74 (improving). 3/5 habits on track."
}`,
      config: { responseMimeType: 'application/json', temperature: 0 },
    });

    const raw = JSON.parse((result.text || '').trim()) as Partial<UserIntelligenceProfile>;
    if (!raw.currentNarrative) return null;

    const prev = uilProfile ?? UIL_DEFAULT;
    const profile: UserIntelligenceProfile = {
      version: prev.version + 1,
      synthesizedAt: Date.now(),
      trigger,
      peakFocusHours: raw.peakFocusHours ?? prev.peakFocusHours,
      optimalSessionMinutes: raw.optimalSessionMinutes ?? prev.optimalSessionMinutes,
      avgSessionFocusScore: raw.avgSessionFocusScore ?? prev.avgSessionFocusScore,
      focusTrend: raw.focusTrend ?? prev.focusTrend,
      totalFocusMinutesThisWeek: raw.totalFocusMinutesThisWeek ?? prev.totalFocusMinutesThisWeek,
      energyByHour: raw.energyByHour ?? prev.energyByHour,
      currentEnergyEstimate: raw.currentEnergyEstimate ?? prev.currentEnergyEstimate,
      energyPattern: raw.energyPattern ?? prev.energyPattern,
      topProductiveDomains: raw.topProductiveDomains ?? prev.topProductiveDomains,
      topDistractionDomains: raw.topDistractionDomains ?? prev.topDistractionDomains,
      distractionTriggers: raw.distractionTriggers ?? prev.distractionTriggers,
      avoidancePatterns: raw.avoidancePatterns ?? prev.avoidancePatterns,
      strongTopics: raw.strongTopics ?? prev.strongTopics,
      frictionTopics: raw.frictionTopics ?? prev.frictionTopics,
      goalMomentum: raw.goalMomentum ?? prev.goalMomentum,
      taskCompletionRate: raw.taskCompletionRate ?? prev.taskCompletionRate,
      activeGoalsSummary: raw.activeGoalsSummary ?? prev.activeGoalsSummary,
      nextRecommendedTopic: raw.nextRecommendedTopic ?? prev.nextRecommendedTopic,
      habitStreakSummary: raw.habitStreakSummary ?? prev.habitStreakSummary,
      habitsAtRisk: raw.habitsAtRisk ?? prev.habitsAtRisk,
      standupGoalToday: raw.standupGoalToday ?? prev.standupGoalToday,
      moodToday: raw.moodToday ?? prev.moodToday,
      calendarEventsToday: raw.calendarEventsToday ?? prev.calendarEventsToday,
      recentStudyTopics: raw.recentStudyTopics ?? prev.recentStudyTopics,
      knowledgeGaps: raw.knowledgeGaps ?? prev.knowledgeGaps,
      preferredCoachingStyle: raw.preferredCoachingStyle ?? prev.preferredCoachingStyle,
      adaptiveThresholds: {
        focusDropAlertScore: raw.adaptiveThresholds?.focusDropAlertScore ?? prev.adaptiveThresholds.focusDropAlertScore,
        cognitiveLoadThreshold: raw.adaptiveThresholds?.cognitiveLoadThreshold ?? prev.adaptiveThresholds.cognitiveLoadThreshold,
        distractionAlertMinutes: raw.adaptiveThresholds?.distractionAlertMinutes ?? prev.adaptiveThresholds.distractionAlertMinutes,
        sessionDurationSweetSpot: raw.adaptiveThresholds?.sessionDurationSweetSpot ?? prev.adaptiveThresholds.sessionDurationSweetSpot,
        habitRiskDays: raw.adaptiveThresholds?.habitRiskDays ?? prev.adaptiveThresholds.habitRiskDays,
        cognitiveLoadAdvice: raw.adaptiveThresholds?.cognitiveLoadAdvice ?? prev.adaptiveThresholds.cognitiveLoadAdvice,
        focusDropAdvice: raw.adaptiveThresholds?.focusDropAdvice ?? prev.adaptiveThresholds.focusDropAdvice,
        habitRiskAdvice: raw.adaptiveThresholds?.habitRiskAdvice ?? prev.adaptiveThresholds.habitRiskAdvice,
        efficacyAdvice: raw.adaptiveThresholds?.efficacyAdvice ?? prev.adaptiveThresholds.efficacyAdvice,
      },
      currentNarrative: raw.currentNarrative ?? prev.currentNarrative,
      coachingInsights: raw.coachingInsights ?? prev.coachingInsights,
      nextBestFocusWindow: raw.nextBestFocusWindow ?? prev.nextBestFocusWindow,
      weeklyProgressSummary: raw.weeklyProgressSummary ?? prev.weeklyProgressSummary,
    };

    // Persist
    try {
      const db = getDb();
      db.prepare(`INSERT INTO user_intelligence_profile (profile_json, version, synthesized_at, trigger) VALUES (?, ?, datetime('now'), ?)`).run(JSON.stringify(profile), profile.version, trigger);
      // Keep only last 20 versions
      db.prepare(`DELETE FROM user_intelligence_profile WHERE id NOT IN (SELECT id FROM user_intelligence_profile ORDER BY version DESC LIMIT 20)`).run();
    } catch { /* */ }

    console.log(`[UIL] Profile v${profile.version} synthesized (${trigger}): trend=${profile.focusTrend}, coaching_style=${profile.preferredCoachingStyle}`);
    return profile;
  } catch (err) {
    console.error('[UIL] Synthesis failed:', err);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current intelligence profile. Always returns immediately.
 * Loads from memory cache → DB → triggers background synthesis if stale.
 */
function isProfilePreHistory(p: UserIntelligenceProfile): boolean {
  const synthesizedAt = p.synthesizedAt || 0;
  if (!synthesizedAt) return true;
  return synthesizedAt < historyStartEpochMs();
}

function freshStartDefaultProfile(): UserIntelligenceProfile {
  const info = getHistoryEpochInfo();
  return {
    ...UIL_DEFAULT,
    version: 0,
    synthesizedAt: 0,
    trigger: 'fresh_start_epoch',
    currentNarrative: info.isFreshStart
      ? `Day ${info.dayIndex} of the current LifeOS run (history starts ${info.startDate}). Sparse data means early days — not long-term avoidance of old goals.`
      : `Coaching history starts ${info.startDate}. Use only post-epoch evidence.`,
    coachingInsights: [
      `History epoch ${info.startDate} — ignore pre-epoch inactivity narratives.`,
      info.isFreshStart
        ? 'Prefer one small concrete next action over guilt about the past.'
        : 'Judge progress only against post-epoch check-ins, sessions, and plans.',
    ],
    avoidancePatterns: [],
    frictionTopics: [],
    goalMomentum: {},
    activeGoalsSummary: [],
    weeklyProgressSummary: info.isFreshStart
      ? `Fresh start day ${info.dayIndex}: no multi-week inactivity judgment.`
      : `Progress measured since ${info.startDate}.`,
  };
}

export function getIntelligenceProfile(): UserIntelligenceProfile {
  if (uilProfile && Date.now() - uilCacheTs < UIL_CACHE_TTL) {
    if (isProfilePreHistory(uilProfile)) {
      if (!uilSynthesisRunning && !isUILSynthesisDisabled()) void _runSynthesisBackground('history_epoch_refresh');
      return freshStartDefaultProfile();
    }
    return uilProfile;
  }

  // Try DB
  try {
    const db = getDb();
    const row = db.prepare(`SELECT profile_json FROM user_intelligence_profile ORDER BY version DESC LIMIT 1`).get() as { profile_json: string } | undefined;
    if (row?.profile_json) {
      const p = JSON.parse(row.profile_json) as UserIntelligenceProfile;
      if (isProfilePreHistory(p)) {
        uilProfile = null;
        uilCacheTs = 0;
        if (!uilSynthesisRunning && !isUILSynthesisDisabled()) void _runSynthesisBackground('history_epoch_refresh');
        return freshStartDefaultProfile();
      }
      uilProfile = p;
      uilCacheTs = Date.now();
      const staleMs = Date.now() - (p.synthesizedAt || 0);
      if (staleMs > UIL_CACHE_TTL && !uilSynthesisRunning && !isUILSynthesisDisabled()) void _runSynthesisBackground('cache_stale');
      return p;
    }
  } catch { /* */ }

  if (!uilSynthesisRunning && !isUILSynthesisDisabled()) void _runSynthesisBackground('initial');
  return freshStartDefaultProfile();
}

/**
 * Signal that a new data event has occurred.
 * Debounced — rapid calls collapse into one synthesis 5s later.
 */
export function touchIntelligence(trigger: string): void {
  if (isUILSynthesisDisabled()) return;
  if (uilSynthesisQueued || uilSynthesisRunning) return;
  uilSynthesisQueued = true;
  setTimeout(() => {
    uilSynthesisQueued = false;
    void _runSynthesisBackground(trigger);
  }, 5000);
}

async function _runSynthesisBackground(trigger: string): Promise<void> {
  if (uilSynthesisRunning) return;
  uilSynthesisRunning = true;
  try {
    const p = await runUILSynthesis(trigger);
    if (p) { uilProfile = p; uilCacheTs = Date.now(); }
  } finally {
    uilSynthesisRunning = false;
  }
}

/** Force an immediate synthesis (for scheduled jobs). */
export async function forceSynthesis(trigger: string): Promise<UserIntelligenceProfile> {
  if (!uilSynthesisRunning) await _runSynthesisBackground(trigger);
  return getIntelligenceProfile();
}

/**
 * THE CORE FUNCTION — replaces buildBehaviorContext() + buildGoalsContext()
 * in every module. Returns a rich, personalized context string for any LLM prompt.
 */
export function getIntelligenceContext(opts?: {
  maxInsights?: number;
  includeThresholds?: boolean;
  includeToday?: boolean;
}): string {
  const p = getIntelligenceProfile();
  const maxInsights = opts?.maxInsights ?? 3;
  const includeThresholds = opts?.includeThresholds ?? false;
  const includeToday = opts?.includeToday ?? true;

  const ageMin = p.synthesizedAt ? Math.round((Date.now() - p.synthesizedAt) / 60000) : null;
  const ageStr = ageMin !== null ? ` (updated ${ageMin}min ago, v${p.version})` : '';

  const lines: string[] = [
    `=== USER INTELLIGENCE PROFILE${ageStr} ===`,
    formatHistoryEpochContext(),
  ];

  if (p.currentNarrative) lines.push(`\n📌 ${p.currentNarrative}`);

  lines.push(`\n⚡ Peak hours: ${p.peakFocusHours.map(h => `${h}:00`).join(', ')} | Optimal sprint: ${p.optimalSessionMinutes}min | Avg focus: ${p.avgSessionFocusScore}/100 (${p.focusTrend})`);
  if (p.energyPattern) lines.push(`🔋 Energy: ${p.currentEnergyEstimate} — ${p.energyPattern}`);
  lines.push(`🎯 Coaching style: ${p.preferredCoachingStyle}`);

  if (p.activeGoalsSummary.length) {
    lines.push(`\n🏁 Goals: ${p.activeGoalsSummary.join(' · ')}`);
    const gaining = Object.entries(p.goalMomentum).filter(([, m]) => m === 'gaining').map(([g]) => g);
    const stalling = Object.entries(p.goalMomentum).filter(([, m]) => m === 'stalling' || m === 'at_risk').map(([g]) => g);
    if (gaining.length) lines.push(`  ↑ Gaining: ${gaining.join(', ')}`);
    if (stalling.length) lines.push(`  ↓ Stalling: ${stalling.join(', ')}`);
  }
  if (p.nextRecommendedTopic) lines.push(`→ Recommended now: ${p.nextRecommendedTopic}`);

  if (p.strongTopics.length) lines.push(`\n💪 Strong: ${p.strongTopics.join(', ')}`);
  if (p.frictionTopics.length) lines.push(`⚠️ Friction: ${p.frictionTopics.join(', ')}`);
  if (p.distractionTriggers.length) lines.push(`\n🚨 Distraction triggers: ${p.distractionTriggers.join('; ')}`);
  if (p.topDistractionDomains.length) lines.push(`🌐 Top distractions: ${p.topDistractionDomains.slice(0, 4).join(', ')}`);
  if (p.avoidancePatterns.length) lines.push(`⏭️ Avoidance: ${p.avoidancePatterns.join('; ')}`);

  if (p.habitStreakSummary.length) lines.push(`\n🔥 Habits: ${p.habitStreakSummary.join(' · ')}`);
  if (p.habitsAtRisk.length) lines.push(`⚠️ At risk today: ${p.habitsAtRisk.join(', ')}`);

  if (includeToday) {
    if (p.standupGoalToday) lines.push(`\n📌 Today's goal: "${p.standupGoalToday}"`);
    if (p.moodToday) lines.push(`😶 Mood: ${p.moodToday}`);
    if (p.calendarEventsToday.length) lines.push(`📅 Calendar: ${p.calendarEventsToday.join(' · ')}`);
    if (p.nextBestFocusWindow) lines.push(`⏰ Best window: ${p.nextBestFocusWindow}`);
  }

  if (p.recentStudyTopics.length) lines.push(`\n📚 Recent study: ${p.recentStudyTopics.slice(0, 5).join(', ')}`);
  if (p.knowledgeGaps.length) lines.push(`❓ Knowledge gaps: ${p.knowledgeGaps.slice(0, 3).join('; ')}`);

  if (p.coachingInsights.length && maxInsights > 0) {
    lines.push(`\n💡 Coaching insights:`);
    p.coachingInsights.slice(0, maxInsights).forEach((ins, i) => lines.push(`  ${i + 1}. ${ins}`));
  }

  if (includeThresholds) {
    const t = p.adaptiveThresholds;
    lines.push(`\n🔧 Adaptive thresholds: drop_alert=${t.focusDropAlertScore}, load=${t.cognitiveLoadThreshold} tasks, nudge=${t.distractionAlertMinutes}min, sprint=${t.sessionDurationSweetSpot}min`);
  }

  // Shared Cognitive Self-Map — same ground truth every agent/guardian path sees via UIL context
  try {
    const { computeCognitiveTraits, formatCognitiveTraitsForPrompt } = require('./cognitive-traits') as typeof import('./cognitive-traits');
    const { getActiveCoachPolicy, formatActiveCoachForPrompt } = require('./cognitive-active-coach') as typeof import('./cognitive-active-coach');
    const { getCognitiveTrajectory } = require('./cognitive-self-answer') as typeof import('./cognitive-self-answer');
    const traits = computeCognitiveTraits({ windowDays: 45 });
    const coach = getActiveCoachPolicy({ traits });
    const traj = getCognitiveTrajectory({ historyLimit: 90 });
    lines.push('\n' + formatCognitiveTraitsForPrompt(traits));
    lines.push(formatActiveCoachForPrompt(coach));
    lines.push(`📈 Trajectory: ${traj.headline}`);
  } catch { /* optional */ }

  // Append today's screen observation summary (what they've actually been doing)
  if (includeToday) {
    try {
      const db = getDb();
      const today = new Date().toISOString().slice(0, 10);

      // Category breakdown for today
      const cats = db.prepare(`
        SELECT category, COUNT(*) as count
        FROM screen_observations
        WHERE date(observed_at) = ?
        GROUP BY category
        ORDER BY count DESC
      `).all(today) as Array<{ category: string; count: number }>;

      // Most recent specific content (last 3 observations with real content)
      const recent = db.prepare(`
        SELECT app, specific_content, attention_quality, observed_at
        FROM screen_observations
        WHERE date(observed_at) = ?
          AND specific_content IS NOT NULL
          AND specific_content != ''
          AND specific_content != 'idle'
        ORDER BY observed_at DESC
        LIMIT 3
      `).all(today) as Array<{ app: string; specific_content: string; attention_quality: string; observed_at: string }>;

      // Consecutive distraction minutes (last 2h)
      const distractionBlocks = db.prepare(`
        SELECT COUNT(*) as count
        FROM screen_observations
        WHERE observed_at >= datetime('now', '-2 hours')
          AND category IN ('distraction', 'consumption')
      `).get() as { count: number };

      if (cats.length > 0) {
        const catSummary = cats.map(c => `${c.category}(${c.count})`).join(', ');
        lines.push(`\n🖥️ Today's screen: ${catSummary}`);
      }

      if (distractionBlocks.count >= 3) {
        lines.push(`⚠️ ${distractionBlocks.count} distraction observations in last 2h`);
      }

      if (recent.length > 0) {
        const recentStr = recent.map(r => `${r.app}: ${r.specific_content.slice(0, 60)}`).join(' → ');
        lines.push(`🔍 Recent activity: ${recentStr}`);
      }
    } catch { /* screen_observations may not exist yet */ }
  }

  // Append active semantic facts so every prompt sees long-term distilled memory
  try {
    const memCtx = getMemoryContext(6);
    if (memCtx) lines.push(`\n${memCtx}`);
  } catch { /* */ }

  return lines.join('\n');
}
