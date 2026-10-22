import { getDb } from './db';
import { endsemHour, getEndsemState } from './endsem-study';
import { STUDY_SUBJECT_LABELS, studyDuration } from './endsem-contract';
import { sendTelegram } from './telegram';

type EventKind = 'morning' | 'push' | 'review';
interface Reminder {event_key: string; kind: EventKind; message: string; study_seconds: number; telegram_sent_at: string | null; telegram_attempted_at: string | null}

export async function runEndsemAccountability(options: {
  now?: Date;
  send?: (message: string) => Promise<boolean>;
} = {}): Promise<{action: EventKind | 'none'}> {
  const now = options.now || new Date(), state = getEndsemState(now), hour = endsemHour(now);
  if (state.conversationalMode || state.phase!=='active' || state.paused || hour<8 || hour>=23 || state.activeStudy || (state.today.delayUntil && Date.parse(state.today.delayUntil)>now.getTime())) return {action:'none'};
  const db = getDb();
  const subject = STUDY_SUBJECT_LABELS[state.nextSubject];
  const remaining = studyDuration(state.today.remainingSeconds);
  const minutes = Math.max(5,Math.min(50,Math.ceil(state.today.remainingSeconds/60)));
  const nextStartMissed = state.nextCommittedStartAt && now.getTime()>=Date.parse(state.nextCommittedStartAt)+5*60_000 && state.today.totalSeconds===0;
  const needsPush = state.today.status==='behind' || nextStartMissed || (state.today.delayUntil && Date.parse(state.today.delayUntil)<=now.getTime());
  let kind: EventKind | null = null, key = '', message = '';
  const reviewExists = db.prepare('SELECT 1 FROM endsem_events WHERE event_key = ?').get(`${state.date}:review`);
  if (hour>=state.checkpointHours[3] && !reviewExists) {
    kind='review';key=`${state.date}:review`;
    message=`Endsem review: ${studyDuration(state.today.totalSeconds)} / 8h studied (${studyDuration(state.today.measuredSeconds)} measured; ${studyDuration(state.today.selfReportedSeconds)} self-reported). ${state.today.remainingSeconds ? `${remaining} still left today. Start ${minutes} minutes of ${subject} now.` : 'Target reached.'} Record what you studied and tomorrow’s first start in LifeOS. Probability: 10 Nov. ADSA: 13 Nov.`;
  } else if (state.today.remainingSeconds>0 && needsPush) {
    kind='push';
    const lastPush = db.prepare("SELECT created_at FROM endsem_events WHERE date = ? AND kind IN ('push','review') ORDER BY created_at DESC LIMIT 1").get(state.date) as {created_at:string} | undefined;
    if (!lastPush || now.getTime()-Date.parse(lastPush.created_at)>=10*60_000) {
      key=`${state.date}:push:${Math.floor(now.getTime()/600_000)}`;
      message=`Lock in. You have ${remaining} left to reach 8 hours today. Start the next ${minutes} minutes of ${subject}. Open LifeOS: Start now, Delay 10 minutes, or Record a blocker. A delay or blocker does not count as study. Probability: 10 Nov. ADSA: 13 Nov.`;
    }
  } else if (state.today.totalSeconds===0 && hour<state.checkpointHours[0]) {
    kind='morning';key=`${state.date}:morning`;
    message=`Endsem Lock-In: 8 hours today. Start the next ${minutes} minutes of ${subject}. Probability: 10 Nov; ADSA: 13 Nov. Checkpoints: ${state.checkpointHours.map(h=>`${h}:00`).join(', ')} IST. Open LifeOS and start now.`;
  }
  let inserted = false;
  if (kind && key) {
    inserted = db.transaction(()=>{
      const result = db.prepare('INSERT OR IGNORE INTO endsem_events(event_key,date,kind,message,study_seconds,created_at) VALUES(?,?,?,?,?,?)').run(key,state.date,kind,message,state.today.totalSeconds,now.toISOString());
      if (!result.changes) return false;
      db.prepare("INSERT INTO alerts(type,message,severity,created_at) VALUES('endsem_lock_in',?,'urgent',?)").run(message,now.toISOString());
      return true;
    })();
  }
  // Retry only the current, still-relevant message. A failed transport never
  // creates another in-app alert or marks a Telegram message as delivered.
  const pending = db.prepare('SELECT event_key,kind,message,study_seconds,telegram_sent_at,telegram_attempted_at FROM endsem_events WHERE date = ? ORDER BY created_at DESC LIMIT 1').get(state.date) as Reminder | undefined;
  const stillRelevant = pending && pending.study_seconds===state.today.totalSeconds && (pending.kind==='review' || (pending.kind==='push' && needsPush && state.today.remainingSeconds>0) || (pending.kind==='morning' && state.today.totalSeconds===0 && hour<state.checkpointHours[0]));
  if (pending && stillRelevant && !pending.telegram_sent_at && state.telegramEnabled && (options.send || state.telegramConfigured) && (!pending.telegram_attempted_at || now.getTime()-Date.parse(pending.telegram_attempted_at)>=5*60_000)) {
    // Claim a retry before awaiting the network, so overlapping scheduler ticks
    // cannot both deliver the same reminder.
    const claimed = db.prepare('UPDATE endsem_events SET telegram_attempted_at = ? WHERE event_key = ? AND telegram_sent_at IS NULL AND (telegram_attempted_at IS NULL OR telegram_attempted_at <= ?)').run(now.toISOString(),pending.event_key,new Date(now.getTime()-5*60_000).toISOString());
    if (claimed.changes) {
      let delivered = false;
      try { delivered = await (options.send || ((value: string)=>sendTelegram(value,'')))(pending.message); } catch { /* keep failure pending */ }
      if (delivered) db.prepare('UPDATE endsem_events SET telegram_sent_at = ? WHERE event_key = ?').run(now.toISOString(),pending.event_key);
    }
  }
  return {action:inserted && kind ? kind : 'none'};
}
