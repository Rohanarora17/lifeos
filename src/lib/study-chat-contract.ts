import type { StudySubject } from './endsem-contract';

export type StudyActivityKind = 'meal' | 'break' | 'class' | 'commitment';
export interface StudyActivity {
  id: string;
  kind: StudyActivityKind;
  title: string;
  startedAt: string;
  expectedReturnAt: string | null;
  status: 'pending' | 'away' | 'returned' | 'cancelled';
  revision: number;
  calendarEventId: string | null;
}
export interface StudyProtectedInterval {
  id?: string;
  title: string;
  start: string;
  end: string;
  kind?: StudyActivityKind;
}
export interface StudyCalendarEvent extends StudyProtectedInterval {
  id: string;
  subject?: StudySubject | null;
}
export interface StudyCalendarSnapshot {
  status: 'fresh' | 'stale' | 'unconfigured';
  events: StudyCalendarEvent[];
  syncedAt: string | null;
  warning: string | null;
}
export interface StudyDaySession {
  id: string;
  title: string;
  subject: StudySubject;
  start: string;
  end: string;
  durationMinutes: number;
  status: string;
}
export interface StudyDayPlan {
  date: string;
  revision: number;
  sessions: StudyDaySession[];
  remainingSeconds: number;
  scheduledMinutes: number;
  shortfallMinutes: number;
  anticipatedClassMinutes: number;
  calendarStatus: StudyCalendarSnapshot['status'];
  needsInput: string | null;
  warning: string | null;
  endAt: string | null;
}
export interface StudyChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}
export interface StudyChatPrompt {
  id: string;
  text: string;
  kind: 'return' | 'overdue' | 'start' | 'clarification';
  createdAt: string;
}
export interface StudyChatState {
  ok: true;
  date: string;
  revision: number;
  /** Campaign permits input; independent of whether conversation mode was activated. */
  enabled: boolean;
  messages: StudyChatMessage[];
  activity: StudyActivity | null;
  pendingPrompt: StudyChatPrompt | null;
  pendingQuestion: string | null;
  plan: StudyDayPlan | null;
  remainingSeconds: number;
  measuredSeconds: number;
  selfReportedSeconds: number;
  classSeconds: number;
  reply?: string;
  window?: {mode:'consecutive24';startsAt:string;endsAt:string};
}
