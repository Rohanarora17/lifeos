// LifeOS — Popup Script

let API_BASE = 'http://localhost:3000/api';
let APP_URL = 'http://localhost:3000';

chrome.storage.local.get('apiUrl', (data) => {
  if (data.apiUrl) {
    API_BASE = data.apiUrl;
    APP_URL = data.apiUrl.replace(/\/api$/, '');
  }
  loadData();
});

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: APP_URL });
});

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

