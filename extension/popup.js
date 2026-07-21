// LifeOS — Popup Script (Enhanced)

let API_BASE = 'http://localhost:3000/api';
let APP_URL = 'http://localhost:3000';

chrome.storage.local.get('apiUrl', (data) => {
  if (data.apiUrl) {
    API_BASE = data.apiUrl;
    APP_URL = data.apiUrl.replace(/\/api$/, '');
  }
  loadData();
  loadFocusSection();
});

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: APP_URL });
});

// ── Voice permission management ───────────────────────────────────────────────
// MV3 offscreen documents cannot trigger the browser permission dialog on their
// own — it requires a user gesture in a visible context (the popup).
// This button calls getUserMedia from the popup, granting mic access that the
// offscreen document then inherits for push-to-talk.

async function checkMicPermission() {
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    return result.state; // 'granted' | 'prompt' | 'denied'
  } catch {
    return 'prompt';
  }
}

async function initVoiceButton() {
  const btn = document.getElementById('enableVoiceBtn');
  const row = document.getElementById('voice-permission-row');
  if (!btn || !row) return;

  const state = await checkMicPermission();

  if (state === 'granted') {
    // Already granted — show a subtle green indicator, no button needed
    row.innerHTML = `<span style="font-size: 11px; color: #4ade80; display: flex; align-items: center; gap: 5px;">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      Voice enabled — Cmd+Shift+Space to talk
    </span>`;
    return;
  }

  if (state === 'denied') {
    row.innerHTML = `<span style="font-size: 11px; color: #f87171;">Mic blocked — allow in Chrome site settings</span>`;
    return;
  }

  btn.addEventListener('click', async () => {
    btn.textContent = 'Waiting for permission...';
    btn.disabled = true;
    try {
      // This triggers the browser permission dialog (requires user gesture)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // Immediately release the stream — we only needed to trigger the grant
      stream.getTracks().forEach(t => t.stop());
      row.innerHTML = `<span style="font-size: 11px; color: #4ade80; display: flex; align-items: center; gap: 5px;">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Voice enabled — Cmd+Shift+Space to talk
      </span>`;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        row.innerHTML = `<span style="font-size: 11px; color: #f87171;">Permission denied — allow mic in Chrome settings</span>`;
      } else {
        btn.textContent = 'Enable Voice (Cmd+Shift+Space)';
        btn.disabled = false;
      }
    }
  });
}

initVoiceButton();

// --- Live time-on-site counter ---
let liveTimerInterval = null;

function startLiveTimer(startedAt) {
  if (liveTimerInterval) clearInterval(liveTimerInterval);
  const el = document.getElementById('live-time');
  if (!el) return;

  const update = () => {
    const secs = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    el.textContent = m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  };
  update();
  liveTimerInterval = setInterval(update, 1000);
}

// --- Focus Session UI ---
let focusUpdateInterval = null;

function formatFocusDuration(mins) {
  const rounded = Math.max(0, Math.round(Number(mins) || 0));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function addDurationOption(options, minutes, label) {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric) || numeric <= 0) return;
  const rounded = Math.max(5, Math.round(numeric / 5) * 5);
  if (options.some(option => option.minutes === rounded)) return;
  options.push({ minutes: rounded, label });
}

function buildPopupDurationOptions({ adaptiveDuration, personalization, selectedTask, topTask }) {
  const options = [];
  const mode = personalization?.mode || 'normal';
  const base = Math.round(Number(adaptiveDuration) || 45);

  addDurationOption(options, selectedTask?.estimatedMinutes, 'This task');
  addDurationOption(options, base, mode === 'recovery' ? 'Recovery default' : mode === 'deadline_pressure' ? 'Pressure default' : 'Today default');

  if (mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low') {
    addDurationOption(options, Math.min(base, 20), 'Small start');
    addDurationOption(options, Math.min(Math.max(base, 25), 35), 'Manageable');
  } else if (mode === 'deadline_pressure') {
    addDurationOption(options, Math.max(base, 45), 'Serious sprint');
    addDurationOption(options, Math.max(base, 75), 'Deep push');
  } else if (mode === 'planning') {
    addDurationOption(options, Math.min(base, 30), 'Planning pass');
    addDurationOption(options, Math.max(base, 45), 'Setup block');
  } else {
    addDurationOption(options, Math.max(25, base - 15), 'Shorter');
    addDurationOption(options, Math.min(120, base + 15), 'Deeper');
  }

  addDurationOption(options, topTask?.estimatedMinutes, 'Top recommendation');
  return options.slice(0, 5);
}

function renderDurationOptions(options) {
  return options
    .map(option => `<option value="${option.minutes}">${option.label} (${formatFocusDuration(option.minutes)})</option>`)
    .join('');
}

async function loadFocusSection() {
  const focusEl = document.getElementById('focus-section');
  if (!focusEl) return;

  // SYNC_SESSION forces a server check first so Telegram/dashboard-started sessions show up immediately
  const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'SYNC_SESSION' }, r));

  if (status && status.active) {
    renderActiveFocusSession(focusEl, status);
  } else {
    renderFocusStarter(focusEl);
  }
}

async function renderFocusStarter(el) {
  let goals = [], tasks = [], insights = null;
  try {
    const [stateRes, insightsRes] = await Promise.all([
      fetch(`${API_BASE}/guardian/state`),
      fetch(`${API_BASE}/guardian/insights`),
    ]);
    const data = await stateRes.json();
    insights = insightsRes.ok ? await insightsRes.json() : null;
    goals = data.activeGoals || [];
    tasks = data.activeTasks || [];
  } catch { }

  const recommendedTasks = Array.isArray(insights?.recommendedTasks) ? insights.recommendedTasks : [];
  const topTask = recommendedTasks[0] || null;
  const personalization = insights?.personalization || null;
  const adaptiveDuration = personalization?.recommendedSessionMinutes || topTask?.estimatedMinutes || 45;
  const modeLabel = {
    protect_focus: 'Protect focus',
    deadline_pressure: 'Deadline pressure',
    recovery: 'Recovery',
    planning: 'Planning',
    normal: 'Balanced',
  }[personalization?.mode || 'normal'];
  const initialDurationOptions = buildPopupDurationOptions({
    adaptiveDuration,
    personalization,
    selectedTask: null,
    topTask,
  });
  const goalOptions = goals.map(g => `<option value="goal-${g.id}" data-title="${g.title}">${g.title}</option>`).join('');
  const taskOptions = tasks.map(t => `<option value="task-${t.id}" data-title="${t.title}">${t.title}</option>`).join('');

  el.innerHTML = `
    <div class="focus-panel" style="margin: 0 10px 0;">
      <h3>🎯 Focus Session</h3>
      <div style="font-size: 10px; color: #8888a0; margin: -2px 0 8px;">
        ${modeLabel} · ${personalization?.energy || 'medium'} energy · ${formatFocusDuration(adaptiveDuration)} learned default
      </div>
      <select class="focus-select" id="focus-target">
        <option value="">Select a goal or task...</option>
        ${goalOptions ? `<optgroup label="Goals">${goalOptions}</optgroup>` : ''}
        ${taskOptions ? `<optgroup label="Active Tasks">${taskOptions}</optgroup>` : ''}
      </select>
      <div class="focus-row">
        <select class="focus-select" id="focus-duration" style="flex:1;">
          ${renderDurationOptions(initialDurationOptions)}
        </select>
        <button class="focus-btn focus-btn-start" id="focus-start-btn">Start Focus</button>
      </div>
    </div>
  `;

  document.getElementById('focus-target').addEventListener('change', (event) => {
    const selected = event.target.value;
    const selectedTask = selected.startsWith('task-')
      ? recommendedTasks.find(task => task.id === Number(selected.replace('task-', ''))) || null
      : null;
    const durationEl = document.getElementById('focus-duration');
    const nextOptions = buildPopupDurationOptions({
      adaptiveDuration,
      personalization,
      selectedTask,
      topTask,
    });
    durationEl.innerHTML = renderDurationOptions(nextOptions);
  });

  document.getElementById('focus-start-btn').addEventListener('click', async () => {
    const targetEl = document.getElementById('focus-target');
    const durationEl = document.getElementById('focus-duration');
    const selected = targetEl.value;
    const selectedOption = targetEl.options[targetEl.selectedIndex];
    const duration = parseInt(durationEl.value);

    let goalId = null, goalTitle = null, taskTitle = null;
    if (selected.startsWith('goal-')) {
      goalId = parseInt(selected.replace('goal-', ''));
      goalTitle = selectedOption.dataset.title;
    } else if (selected.startsWith('task-')) {
      taskTitle = selectedOption.dataset.title;
    }

    try {
      const res = await fetch(`${API_BASE}/guardian/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goalId: goalId ? String(goalId) : null,
          goalTitle,
          conceptNodeName: taskTitle || goalTitle || selectedOption.dataset.title || 'Focus Session',
          durationMinutes: duration,
          source: 'extension',
        }),
      });
      const data = await res.json();
      if (!data?.session) return;

      chrome.runtime.sendMessage({
        type: 'START_GUARDIAN',
        context: data.session,
      });

      setTimeout(loadFocusSection, 1000);
    } catch { }
  });
}

function renderActiveFocusSession(el, status) {
  const formatTimer = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const target = status.targetTitle || status.context?.targetTitle || status.context?.goalTitle || 'Focus Session';

  el.innerHTML = `
    <div class="focus-panel active" style="margin: 0 10px 0;">
      <h3>🎯 Focus Active</h3>
      <div class="focus-meta">${target}</div>
      <div class="focus-timer" id="focus-countdown">${formatTimer(status.remainingSeconds)}</div>
      <div class="focus-stats-row">
        <div class="focus-stat">
          <div class="val" style="color: #10b981;" id="focus-val-prod">${formatTimer(status.productiveSeconds || 0)}</div>
          <div>Productive</div>
        </div>
        <div class="focus-stat">
          <div class="val" style="color: #ef4444;" id="focus-val-dist">${formatTimer(status.distractionSeconds || 0)}</div>
          <div>Distracted</div>
        </div>
        <div class="focus-stat">
          <div class="val red" id="focus-val-block">${status.blockedCount}</div>
          <div>Blocked</div>
        </div>
        <div class="focus-stat">
          <div class="val yellow" id="focus-val-over">${status.overrideCount}</div>
          <div>Overrides</div>
        </div>
      </div>
      <div style="margin-top: 10px;">
        <button class="focus-btn focus-btn-stop" id="focus-stop-btn" style="width: 100%;">End Session</button>
      </div>
    </div>
  `;

  document.getElementById('focus-stop-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_GUARDIAN' });
    clearInterval(focusUpdateInterval);
    setTimeout(loadFocusSection, 1500);
  });

  if (focusUpdateInterval) clearInterval(focusUpdateInterval);
  focusUpdateInterval = setInterval(async () => {
    const freshStatus = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_GUARDIAN_STATUS' }, r));
    if (!freshStatus || !freshStatus.active) {
      clearInterval(focusUpdateInterval);
      loadFocusSection();
      return;
    }
    const timerEl = document.getElementById('focus-countdown');
    if (timerEl) timerEl.textContent = formatTimer(freshStatus.remainingSeconds);
    const prodEl = document.getElementById('focus-val-prod');
    if (prodEl) prodEl.textContent = formatTimer(freshStatus.productiveSeconds || 0);
    const distEl = document.getElementById('focus-val-dist');
    if (distEl) distEl.textContent = formatTimer(freshStatus.distractionSeconds || 0);
    const blockEl = document.getElementById('focus-val-block');
    if (blockEl) blockEl.textContent = freshStatus.blockedCount;
    const overEl = document.getElementById('focus-val-over');
    if (overEl) overEl.textContent = freshStatus.overrideCount;
  }, 1000);
}

// --- Main Data Load ---
async function loadData() {
  const content = document.getElementById('content');

  try {
    // Fetch dashboard data + current activity in parallel
    const [dashRes, activityInfo] = await Promise.all([
      fetch(`${API_BASE}/dashboard`).then(r => r.json()),
      new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_CURRENT_ACTIVITY' }, resolve)),
    ]);

    const today = dashRes.today;

    const formatTime = (mins) => {
      if (!mins || mins === 0) return '0m';
      if (mins < 60) return `${Math.round(mins)}m`;
      return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
    };

    // --- Mini Donut SVG ---
    const prod = today.productive_minutes || 0;
    const dist = today.distraction_minutes || 0;
    const neut = today.neutral_minutes || 0;
    const total = prod + dist + neut || 1;
    const r = 28;
    const circ = 2 * Math.PI * r;
    const prodArc = (prod / total) * circ;
    const distArc = (dist / total) * circ;
    const neutArc = (neut / total) * circ;
    const prodOffset = 0;
    const distOffset = prodArc;
    const neutOffset = prodArc + distArc;

    const donutSvg = `
      <svg viewBox="0 0 68 68">
        <circle cx="34" cy="34" r="${r}" fill="none" stroke="#12121a" stroke-width="7"/>
        <circle cx="34" cy="34" r="${r}" fill="none" stroke="#22c55e" stroke-width="7"
          stroke-dasharray="${prodArc} ${circ - prodArc}" stroke-dashoffset="${-prodOffset}" stroke-linecap="round"/>
        <circle cx="34" cy="34" r="${r}" fill="none" stroke="#ef4444" stroke-width="7"
          stroke-dasharray="${distArc} ${circ - distArc}" stroke-dashoffset="${-distOffset}"/>
        <circle cx="34" cy="34" r="${r}" fill="none" stroke="#eab308" stroke-width="7"
          stroke-dasharray="${neutArc} ${circ - neutArc}" stroke-dashoffset="${-neutOffset}"/>
      </svg>
    `;

    // --- Streak ---
    const streakPill = document.getElementById('streak-pill');
    const streakCount = document.getElementById('streak-count');
    if (streakPill && streakCount) {
      streakPill.querySelector('.fire').textContent = today.streak > 0 ? '🔥' : '💤';
      streakCount.textContent = today.streak;
    }

    // --- Currently tracking ---
    let trackingHtml = '';
    if (activityInfo?.activity) {
      const act = activityInfo.activity;
      const catClass = act._category || 'neutral';
      const originalStart = act._originalStartedAt || act.started_at;

      trackingHtml = `
        <div class="section-header">Currently Tracking</div>
        <div class="tracking-card">
          <div class="tracking-row">
            <div class="cat-dot ${catClass}"></div>
            <div class="tracking-info">
              <div class="tracking-domain">${act.domain}</div>
              <div class="tracking-title">${act.title || 'Unknown page'}</div>
              ${act.tab_group_title ? `
                <div class="workspace-badge" style="background: ${getGroupBg(act.tab_group_color)}; color: ${getGroupFg(act.tab_group_color)};">
                  <span class="workspace-dot" style="background: ${getGroupFg(act.tab_group_color)};"></span>
                  ${act.tab_group_title}
                </div>
              ` : ''}
            </div>
            <div class="tracking-time" id="live-time">0s</div>
          </div>
        </div>
      `;

      // Start live timer after render
      setTimeout(() => startLiveTimer(originalStart), 0);
    }

    // --- Top 3 sites ---
    let topSitesHtml = '';
    const topDomains = today.topDomains || [];
    if (topDomains.length > 0) {
      const sitesRows = topDomains.slice(0, 4).map((d, i) => `
        <div class="site-row">
          <span class="site-rank">${i + 1}</span>
          <div class="cat-dot ${d.category}" style="width:6px;height:6px;"></div>
          <span class="site-domain">${d.domain}</span>
          <span class="site-time">${formatTime(d.minutes)}</span>
        </div>
      `).join('');

      topSitesHtml = `
        <div class="section-header">Top Sites Today</div>
        <div class="top-sites">${sitesRows}</div>
      `;
    }

    content.innerHTML = `
      <!-- Score Row: Donut + Quick Stats -->
      <div class="score-row">
        <div class="mini-donut">
          ${donutSvg}
          <div class="center-label">
            <div class="score-num purple">${today.score}</div>
            <div class="score-sub">/ 100</div>
          </div>
        </div>
        <div class="stats-col">
          <div class="mini-stat">
            <div class="val green">${formatTime(today.productive_minutes)}</div>
            <div class="lbl">Productive</div>
          </div>
          <div class="mini-stat">
            <div class="val red">${formatTime(today.distraction_minutes)}</div>
            <div class="lbl">Distraction</div>
          </div>
          <div class="mini-stat">
            <div class="val green">${today.tasks?.completed_today || 0}</div>
            <div class="lbl">Tasks Done</div>
          </div>
          <div class="mini-stat">
            <div class="val yellow">${today.habits?.completed_today || 0}/${today.habits?.total_habits || 0}</div>
            <div class="lbl">Habits</div>
          </div>
        </div>
      </div>

      <!-- XP Bar -->
      <div class="xp-bar-wrap">
        <div class="xp-bar-header">
          <span>Lv.${today.level.level} · ${today.totalXp} XP</span>
          <span>${today.level.currentXp}/${today.level.nextLevelXp} XP</span>
        </div>
        <div class="xp-bar">
          <div class="xp-fill" style="width: ${today.level.progress}%"></div>
        </div>
      </div>

      <!-- Currently Tracking -->
      ${trackingHtml}

      <!-- Top Sites -->
      ${topSitesHtml}
    `;
  } catch {
    content.innerHTML = `
      <div class="loading" style="flex-direction: column; gap: 8px;">
        <div style="font-size: 24px;">⚡</div>
        <div>Can't reach LifeOS server</div>
        <div style="font-size: 11px; color: #555570;">Make sure the app is running at localhost:3000</div>
      </div>
    `;
  }
}

// Chrome tab group color mappings
const GROUP_COLORS = {
  grey: { bg: 'rgba(154,160,166,0.15)', fg: '#9aa0a6' },
  blue: { bg: 'rgba(66,133,244,0.15)', fg: '#4285f4' },
  red: { bg: 'rgba(234,67,53,0.15)', fg: '#ea4335' },
  yellow: { bg: 'rgba(251,188,4,0.15)', fg: '#fbbc04' },
  green: { bg: 'rgba(52,168,83,0.15)', fg: '#34a853' },
  pink: { bg: 'rgba(227,100,163,0.15)', fg: '#e364a3' },
  purple: { bg: 'rgba(168,100,247,0.15)', fg: '#a864f7' },
  cyan: { bg: 'rgba(36,188,208,0.15)', fg: '#24bcd0' },
  orange: { bg: 'rgba(250,123,23,0.15)', fg: '#fa7b17' },
};

function getGroupBg(color) {
  return (GROUP_COLORS[color] || GROUP_COLORS.grey).bg;
}

function getGroupFg(color) {
  return (GROUP_COLORS[color] || GROUP_COLORS.grey).fg;
}
