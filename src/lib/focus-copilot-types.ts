export type FocusCopilotSource =
  | 'native_ptt'
  | 'native_text'
  | 'native_selection'
  | 'native_hotkey'
  | 'native_observation'
  | 'extension_hotkey'
  | 'extension_selection'
  | 'extension_context'
  | 'voice';

export interface FocusCopilotCallout {
  x: number;
  y: number;
  width?: number;
  height?: number;
  label: string;
  confidence: number;
}

export interface FocusCopilotContextUsed {
  hadScreenshot: boolean;
  hadSelectedText: boolean;
  hadScreenHistory: boolean;
  hadContextNarrative: boolean;
  hadCursorPoint?: boolean;
  usedUilContext?: boolean;
}

export interface FocusCopilotTurnRequest {
  sessionId?: string | null;
  transcript?: string;
  audio?: Blob;
  base64Jpeg?: string;
  selectedText?: string;
  question?: string;
  appInFocus?: string;
  windowTitle?: string;
  source?: FocusCopilotSource;
  screenSize?: {
    width: number;
    height: number;
  };
  cursorPoint?: {
    x: number;
    y: number;
  };
}

export interface FocusCopilotTurnResponse {
  ok: boolean;
  transcript?: string;
  mode: 'guidance' | 'voice_action' | 'empty' | 'error';
  answer?: string;
  spokenAnswer?: string;
  callouts: FocusCopilotCallout[];
  contextUsed: FocusCopilotContextUsed;
  outcomeId?: number;
  error?: string;
}

export type NativeIngestKind =
  | 'app_dwell'
  | 'capture_heartbeat'
  | 'sensitivity_skip'
  | 'overlay_feedback'
  | 'observation_summary';

export interface NativeIngestPayload {
  kind: NativeIngestKind;
  sessionId?: string | null;
  appInFocus?: string;
  windowTitle?: string;
  startedAt?: string;
  durationSeconds?: number;
  category?: 'deep_work' | 'shallow_work' | 'communication' | 'consumption' | 'distraction' | 'idle';
  attentionQuality?: 'focused' | 'browsing' | 'consuming' | 'distracted' | 'idle';
  specificContent?: string;
  productiveForGoals?: boolean;
  confidence?: number;
  feedback?: 'helpful' | 'not_helpful' | 'dismissed' | 'retry';
  outcomeId?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}
