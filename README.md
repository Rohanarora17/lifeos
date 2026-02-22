# ⚡ LifeOS — Personal Productivity OS

A self-hosted productivity tracker that runs 24/7 on your Mac Mini. Tracks browsing, screen time, habits, tasks, and GitHub activity — with AI-powered behavioral intelligence that learns your patterns over time.

![Dashboard](https://img.shields.io/badge/status-active-brightgreen) ![Next.js](https://img.shields.io/badge/Next.js-16-black) ![License](https://img.shields.io/badge/license-private-blue)

---

## 🚀 Quick Start (5 minutes)

### Prerequisites
- **Node.js 18+** (`node --version`)
- **Mac Mini** (or any Mac running 24/7)
- **Gemini API Key** — get one free at [aistudio.google.com](https://aistudio.google.com/apikey)

### Step 1: Install & Run

```bash
# Clone / navigate to the project
cd lifeos

# Install dependencies
npm install

# Start the server
npm run dev
```

Open **http://localhost:3000** — you should see the dashboard.

### Step 2: Configure Settings

Go to **Settings** (⚙️ in sidebar) and fill in:

| Setting | Where to get it |
|---------|-----------------|
| **Gemini API Key** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **GitHub PAT** | GitHub → Settings → Developer settings → Personal access tokens → Generate (scopes: `read:user`, `repo`) |
| **GitHub Username** | Your GitHub handle (e.g. `rohan`) |
| **Calendar ICS URL** | Google Calendar → ⚙️ → Settings → Your calendar → "Secret address in iCal format" |

Hit **Save Changes**.

### Step 3: Load the Chrome Extension

1. Open Chrome/Brave and go to `chrome://extensions`
2. Toggle **Developer mode** ON (top-right corner)
3. Click **"Load unpacked"**
4. Select the `extension/` folder inside this project
5. Pin the ⚡ LifeOS extension to your toolbar

The extension will now track:
- Every tab you visit (domain, title, time spent)
- Tab switches (for focus/entropy analysis)
- YouTube video details
- Idle detection (pauses tracking when you're away)

### Step 4: Run 24/7 on Mac Mini

Install the LaunchAgent so LifeOS starts automatically on boot:

```bash
bash scripts/install-launchagent.sh
```

This will:
- ✅ Create a LaunchAgent at `~/Library/LaunchAgents/com.lifeos.server.plist`
- ✅ Start the server automatically on login
- ✅ Auto-restart if it crashes
- ✅ Log output to `logs/lifeos-stdout.log`

**Useful commands:**
```bash
# Check if running
launchctl list | grep lifeos

# Stop the server
launchctl unload ~/Library/LaunchAgents/com.lifeos.server.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.lifeos.server.plist
launchctl load ~/Library/LaunchAgents/com.lifeos.server.plist

# View logs
tail -f logs/lifeos-stdout.log
```

### Step 5: Enable Screen Time (Optional)

LifeOS can read per-app usage from macOS. To enable:

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Add **Terminal** (or your terminal app, e.g. iTerm, Warp)
3. In Settings page, click **🖥️ Collect Screen Time**

Without Full Disk Access, it falls back to listing running apps (less detailed).

---

## 📱 Features

### Dashboard
- **Accountability Score** — productivity vs distraction ratio
- **XP & Levels** — gamified progress tracking
- **Activity Feed** — real-time browsing log
- **7-day Trends** — charts and top domains

### 📋 Task Board
- 6-column Kanban (Backlog → Done)
- Drag-and-drop + inline creation

### 🔥 Habits
- 365-day contribution heatmap
- Streak counter
- Daily check-in toggles

### 📊 Analytics
- 7-day area charts (productive/distraction/neutral)
- XP trend
- Top domains breakdown

### 🧠 AI Insights
5-tab behavioral intelligence dashboard:
- **Overview** — archetype classification, hourly heatmap
- **Focus** — deep work scoring, flow detection, entropy
- **Consistency** — 5-dimension index (work, habits, tasks, focus, timing)
- **Goals** — alignment scoring vs user-defined targets
- **Insights** — AI-generated observations with 👍/👎 feedback loop

### 📅 Calendar
- Google Calendar events (synced via ICS feed)
- Today and 7-day upcoming views

### ⚙️ Settings
- API keys & account connections
- Sync buttons (GitHub, Calendar, Screen Time)
- Scheduler status with manual trigger
- Scoring configuration
- Domain classification overrides

---

## ⚡ Automated Scheduler

These jobs run automatically in the background:

| Job | Schedule | What it does |
|-----|----------|--------------|
| 🌅 Morning Brief | Daily at 08:00 | AI-generated day preview with calendar + pending tasks |
| 📝 Daily Summary | Daily at 23:00 | AI productivity report with XP calculation |
| 🧠 Deep Analysis | Daily at 23:30 | Full behavioral analysis (7 algorithms + AI synthesis) |
| 🐙 GitHub Sync | Every 2 hours | Pulls commits, PRs, issues, reviews |
| 📅 Calendar Sync | Every 4 hours | Refreshes events from ICS feed |
| 🖥️ Screen Time | Every 30 minutes | Collects macOS app usage data |

Times are configurable in Settings.

---

## 🗂️ Project Structure

```
lifeos/
├── src/
│   ├── app/                    # Next.js pages + API routes
│   │   ├── api/
│   │   │   ├── activity/       # Browsing activity CRUD
│   │   │   ├── behavior/       # AI behavioral analysis
│   │   │   ├── calendar/       # Calendar sync
│   │   │   ├── cron/           # Scheduler status + triggers
│   │   │   ├── dashboard/      # Dashboard data aggregation
│   │   │   ├── github/         # GitHub activity sync
│   │   │   ├── goals/          # Goal CRUD
│   │   │   ├── habits/         # Habit tracking
│   │   │   ├── nudge/          # AI distraction nudges
│   │   │   ├── screentime/     # macOS screen time
│   │   │   ├── settings/       # Settings CRUD
│   │   │   ├── summary/        # Daily summary + morning brief
│   │   │   └── tasks/          # Task management
│   │   ├── activity/           # Activity timeline page
│   │   ├── analytics/          # Analytics charts page
│   │   ├── calendar/           # Calendar page
│   │   ├── habits/             # Habit heatmap page
│   │   ├── insights/           # 5-tab AI insights page
│   │   ├── settings/           # Settings page
│   │   └── tasks/              # Kanban board page
│   ├── components/
│   │   └── Sidebar.tsx         # Navigation sidebar
│   ├── lib/
│   │   ├── ai.ts               # Gemini API integration
│   │   ├── behavior.ts         # 7 behavioral algorithms + AI learning
│   │   ├── calendar.ts         # ICS feed parser
│   │   ├── categories.ts       # URL classification rules
│   │   ├── db.ts               # SQLite schema + helpers
│   │   ├── github.ts           # GitHub REST API sync
│   │   ├── scheduler.ts        # Cron job scheduler
│   │   ├── scoring.ts          # XP, levels, accountability
│   │   └── screentime.ts       # macOS screen time reader
│   └── instrumentation.ts      # Server startup hook
├── extension/                   # Chrome/Brave extension
│   ├── manifest.json
│   ├── background.js           # Tab tracking, idle detection
│   ├── content-youtube.js      # YouTube video extraction
│   ├── popup.html/js           # Extension popup UI
│   └── icons/
├── scripts/
│   └── install-launchagent.sh  # Auto-start installer
├── data/                        # SQLite database (auto-created)
└── logs/                        # Server logs (auto-created)
```

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension not tracking | Check `chrome://extensions` → LifeOS Tracker is enabled. Check console for errors. |
| "GitHub PAT or username not configured" | Go to Settings → fill in both GitHub PAT and Username → Save |
| Calendar shows "No Events" | Get ICS URL: Google Calendar → ⚙️ → Settings → scroll to your calendar → "Secret address in iCal format" |
| Screen time shows 0 apps | Enable Full Disk Access for Terminal in System Settings |
| Server not starting on boot | Run `bash scripts/install-launchagent.sh` again. Check `launchctl list | grep lifeos` |
| Port 3000 already in use | `lsof -i :3000` then `kill -9 <PID>`, or change port in `package.json` |

---

## 🧪 Tech Stack

- **Frontend:** Next.js 16, React 19, Tailwind CSS 4
- **Backend:** Next.js API routes, better-sqlite3
- **AI:** Google Gemini API
- **Extension:** Manifest V3, Chrome/Brave
- **Scheduler:** Native setInterval via Next.js instrumentation
- **Database:** SQLite (zero-config, file-based)
