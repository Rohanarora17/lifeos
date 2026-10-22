export const ENDSEM_START = '2026-10-22';
export const ENDSEM_END = '2026-11-13';
export const ENDSEM_TIME_ZONE = 'Asia/Kolkata';
export const ENDSEM_TARGET_SECONDS = 8 * 60 * 60;
export type StudySubject = 'probability' | 'adsa';
export const STUDY_SUBJECT_LABELS: Record<StudySubject, string> = { probability: 'Probability', adsa: 'ADSA' };

export interface EndsemDay {
  date: string;
  measuredSeconds: number;
  selfReportedSeconds: number;
  classSeconds: number;
  totalSeconds: number;
  remainingSeconds: number;
  subjectSeconds: Record<StudySubject, number>;
  status: 'upcoming' | 'on_track' | 'behind' | 'complete' | 'missed';
  expectedSeconds: number;
  delayUntil: string | null;
  delayCount: number;
  blocker: string | null;
  review: string | null;
  nextStartAt: string | null;
}

export interface EndsemState {
  date: string;
  timeZone: string;
  startDate: string;
  endDate: string;
  targetSeconds: number;
  phase: 'setup' | 'active' | 'finished';
  paused: boolean;
  conversationalMode: boolean;
  checkpointHours: number[];
  nextSubject: StudySubject;
  probabilityFinishedAt: string | null;
  exams: Array<{subject: StudySubject; date: string}>;
  today: EndsemDay;
  days: EndsemDay[];
  activeStudy: boolean;
  telegramConfigured: boolean;
  telegramEnabled: boolean;
  collectorReady: boolean;
  lastTelegramSentAt: string | null;
  latestPrompt: string | null;
  nextCommittedStartAt: string | null;
}

export function studyDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
