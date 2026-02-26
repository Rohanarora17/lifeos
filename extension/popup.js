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

async function loadFocusSection() {
  const focusEl = document.getElementById('focus-section');
  if (!focusEl) return;

  const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_FOCUS_STATUS' }, r));

  if (status && status.active) {
    renderActiveFocusSession(focusEl, status);
  } else {
    renderFocusStarter(focusEl);
  }
}

async function renderFocusStarter(el) {
  let goals = [], tasks = [];
  try {
    const res = await fetch(`${API_BASE}/extension/session`);
    const data = await res.json();
    goals = data.activeGoals || [];
    tasks = data.activeTasks || [];
  } catch { }

  const goalOptions = goals.map(g => `<option value="goal-${g.id}" data-title="${g.title}">${g.title}</option>`).join('');
  const taskOptions = tasks.map(t => `<option value="task-${t.id}" data-title="${t.title}">${t.title}</option>`).join('');

  el.innerHTML = `
    <div class="focus-panel" style="margin: 0 10px 0;">
      <h3>🎯 Focus Session</h3>
      <select class="focus-select" id="focus-target">
        <option value="">Select a goal or task...</option>
        ${goalOptions ? `<optgroup label="Goals">${goalOptions}</optgroup>` : ''}
        ${taskOptions ? `<optgroup label="Active Tasks">${taskOptions}</optgroup>` : ''}
      </select>
      <div class="focus-row">
        <select class="focus-select" id="focus-duration" style="flex:1;">
          <option value="25">25 min</option>
          <option value="45">45 min</option>
          <option value="60" selected>60 min</option>
          <option value="90">90 min</option>
          <option value="120">2 hours</option>
        </select>
        <button class="focus-btn focus-btn-start" id="focus-start-btn">Start Focus</button>
      </div>
    </div>
  `;

  document.getElementById('focus-start-btn').addEventListener('click', async () => {
    const targetEl = document.getElementById('focus-target');
    const durationEl = document.getElementById('focus-duration');
    const selected = targetEl.value;
    const selectedOption = targetEl.options[targetEl.selectedIndex];
    const duration = parseInt(durationEl.value);

    let goalId = null, goalTitle = null, taskId = null, taskTitle = null;
    if (selected.startsWith('goal-')) {
      goalId = parseInt(selected.replace('goal-', ''));
      goalTitle = selectedOption.dataset.title;
    } else if (selected.startsWith('task-')) {
      taskId = parseInt(selected.replace('task-', ''));
      taskTitle = selectedOption.dataset.title;
    }

    chrome.runtime.sendMessage({
      type: 'START_FOCUS',
      goalId, goalTitle, taskId, taskTitle,
      durationMinutes: duration,
    });

    setTimeout(loadFocusSection, 1000);
  });
}

function renderActiveFocusSession(el, status) {
  const formatTimer = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const target = status.taskTitle || status.goalTitle || 'Focus Session';

  el.innerHTML = `
    <div class="focus-panel active" style="margin: 0 10px 0;">
      <h3>🎯 Focus Active</h3>
      <div class="focus-meta">${target}</div>
      <div class="focus-timer" id="focus-countdown">${formatTimer(status.remainingSeconds)}</div>
      <div class="focus-stats-row">
        <div class="focus-stat">
          <div class="val red">${status.blockedCount}</div>
          <div>Blocked</div>
        </div>
        <div class="focus-stat">
          <div class="val yellow">${status.overrideCount}</div>
          <div>Overrides</div>
        </div>
      </div>
      <div style="margin-top: 10px;">
        <button class="focus-btn focus-btn-stop" id="focus-stop-btn" style="width: 100%;">End Session</button>
      </div>
    </div>
  `;

  document.getElementById('focus-stop-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_FOCUS' });
    clearInterval(focusUpdateInterval);
    setTimeout(loadFocusSection, 1500);
  });

  let remaining = status.remainingSeconds;
  if (focusUpdateInterval) clearInterval(focusUpdateInterval);
  focusUpdateInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(focusUpdateInterval);
      loadFocusSection();
      return;
    }
    const timerEl = document.getElementById('focus-countdown');
    if (timerEl) timerEl.textContent = formatTimer(remaining);
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
  } catch (e) {
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
