// LifeOS — Popup Script

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

// --- Focus Session UI ---
let focusUpdateInterval = null;

async function loadFocusSection() {
  const focusEl = document.getElementById('focus-section');
  if (!focusEl) return;

  // Check if a focus session is active
  const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_FOCUS_STATUS' }, r));

  if (status && status.active) {
    renderActiveFocusSession(focusEl, status);
  } else {
    renderFocusStarter(focusEl);
  }
}

async function renderFocusStarter(el) {
  // Fetch goals and tasks for the selector
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
    <div class="focus-panel">
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

    // Brief delay then reload
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
    <div class="focus-panel active">
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

  // Live countdown update
  let remaining = status.remainingSeconds;
  if (focusUpdateInterval) clearInterval(focusUpdateInterval);
  focusUpdateInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(focusUpdateInterval);
      loadFocusSection(); // Reload to show starter
      return;
    }
    const timerEl = document.getElementById('focus-countdown');
    if (timerEl) timerEl.textContent = formatTimer(remaining);
  }, 1000);
}

async function loadData() {
  const content = document.getElementById('content');

  try {
    // Fetch dashboard data
    const res = await fetch(`${API_BASE}/dashboard`);
    const data = await res.json();
    const today = data.today;

    // Get current activity from background
    const activityInfo = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_CURRENT_ACTIVITY' }, resolve);
    });

    const formatTime = (mins) => {
      if (!mins || mins === 0) return '0m';
      if (mins < 60) return `${Math.round(mins)}m`;
      return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
    };

    content.innerHTML = `
      <!-- Streak -->
      <div class="streak-bar">
        <span class="streak-fire">${today.streak > 0 ? '🔥' : '💤'}</span>
        <span class="streak-count">${today.streak}</span>
        <span class="streak-label">day streak</span>
      </div>

      <!-- Stats Grid -->
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-value purple">${today.score}</div>
          <div class="stat-label">Score /100</div>
        </div>
        <div class="stat-box">
          <div class="stat-value blue">Lv.${today.level.level}</div>
          <div class="stat-label">${today.totalXp} XP</div>
        </div>
        <div class="stat-box">
          <div class="stat-value green">${formatTime(today.productive_minutes)}</div>
          <div class="stat-label">Productive</div>
        </div>
        <div class="stat-box">
          <div class="stat-value red">${formatTime(today.distraction_minutes)}</div>
          <div class="stat-label">Distraction</div>
        </div>
      </div>

      <!-- Level Progress -->
      <div class="section">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${today.level.progress}%"></div>
        </div>
        <div class="level-info">
          <span>Level ${today.level.level}</span>
          <span>${today.level.currentXp}/${today.level.nextLevelXp} XP</span>
        </div>
      </div>

      <!-- Current Site -->
      ${activityInfo?.activity ? `
        <div class="section">
          <h3>Currently Tracking</h3>
          <div class="current-site">
            <div class="site-dot neutral"></div>
            <div class="site-info">
              <div class="site-name">${activityInfo.activity.domain}</div>
              <div class="site-time">${activityInfo.activity.title || 'Unknown page'}</div>
              ${activityInfo.activity.tab_group_title ? `
                <div class="workspace-badge" style="background: ${getGroupBg(activityInfo.activity.tab_group_color)}; color: ${getGroupFg(activityInfo.activity.tab_group_color)};">
                  <span class="workspace-dot" style="background: ${getGroupFg(activityInfo.activity.tab_group_color)};"></span>
                  ${activityInfo.activity.tab_group_title}
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Tasks & Habits -->
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-value green">${today.tasks.completed_today}</div>
          <div class="stat-label">Tasks Done</div>
        </div>
        <div class="stat-box">
          <div class="stat-value yellow">${today.habits.completed_today}/${today.habits.total_habits}</div>
          <div class="stat-label">Habits</div>
        </div>
      </div>
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

// Chrome tab group color mappings for workspace badge
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
