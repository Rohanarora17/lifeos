// LifeOS Guardian — Background Service Worker
// GUARDIAN MODE ONLY — Zero passive tracking. Absolutely silent outside active sessions.

let API_BASE = 'http://localhost:3000/api';
let guardianActive = false;
let sessionContext = null;

// Sync config
chrome.storage.local.get(['apiUrl'], (data) => {
    if (data.apiUrl) API_BASE = data.apiUrl;
});
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.apiUrl) {
        API_BASE = changes.apiUrl.newValue || 'http://localhost:3000/api';
    }
});

// Context Menu Setup
chrome.runtime.onInstalled.addListener(() => {
    console.log('[LifeOS] Guardian installed. Silent mode active.');
    chrome.contextMenus.create({
        id: "send-to-lifeos",
        title: "Extract Task to LifeOS",
        contexts: ["selection"]
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "send-to-lifeos" && info.selectionText) {
        try {
            const dataInfo = await chrome.storage.local.get('apiKey');
            const apiKey = dataInfo.apiKey;
            const res = await fetch(`${API_BASE}/extension/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                body: JSON.stringify({ text: info.selectionText, url: tab?.url, title: tab?.title })
            });

            if (res.ok) {
                chrome.action.setBadgeText({ text: '✓', tabId: tab?.id });
                chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: tab?.id });
                setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab?.id }), 2000);
            }
        } catch (e) {
            console.error('Failed to send task to LifeOS:', e);
            chrome.action.setBadgeText({ text: '!', tabId: tab?.id });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: tab?.id });
        }
    }
});

function isPrivacyBlocked(url) {
    if (!url || typeof url !== 'string') return true;
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('file://')) return true;

    try {
        const domain = new URL(url).hostname;
        const PRIVACY_BLOCKED_DOMAINS = [
            'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'fidelity.com',
            'paypal.com', 'venmo.com', 'robinhood.com', 'coinbase.com',
            'mychart.com', 'myhealth.va.gov', 'patient.info',
            'accounts.google.com', 'login.microsoftonline.com', 'auth0.com',
            'web.whatsapp.com', 'web.telegram.org'
        ];
        return PRIVACY_BLOCKED_DOMAINS.some(blocked => domain === blocked || domain.endsWith('.' + blocked));
    } catch {
        return true;
    }
}

// ── NEW GUARDIAN PATTERN ──
// Absolutely zero processing if guardianActive is false.

const activeTabs = new Map(); // tabId -> { url, startedAt }

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!guardianActive) return; // HARD STOP — ZERO PROCESSING
    if (changeInfo.status !== 'complete') return;
    if (isPrivacyBlocked(tab.url)) return;
    if (!tab.active) return; // Only track the active tab

    reportTabActivity(tabId, tab.url, tab.title);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (!guardianActive) return; // HARD STOP
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (isPrivacyBlocked(tab.url)) return;
        reportTabActivity(activeInfo.tabId, tab.url, tab.title);
    } catch (e) { }
});

async function reportTabActivity(tabId, url, title) {
    if (!sessionContext || !sessionContext.sessionId) return;

    // Calculate dwell time of the previous tab
    let dwellSeconds = 0;
    if (activeTabs.has('current')) {
        const prev = activeTabs.get('current');
        dwellSeconds = Math.round((Date.now() - prev.startedAt) / 1000);

        // Prevent spamming the same URL
        if (prev.url === url) return;
    }

    activeTabs.set('current', { url, startedAt: Date.now() });

    try {
        const dataInfo = await chrome.storage.local.get('apiKey');
        const apiKey = dataInfo.apiKey;
        await fetch(`${API_BASE}/agent/tab-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({
                sessionId: sessionContext.sessionId,
                url,
                title,
                dwellSeconds,
                type: 'tab_navigation'
            })
        });
    } catch (e) {
        // silent fail
    }
}

// Idle detection (using chrome API)
chrome.idle.setDetectionInterval(60); // 60 seconds
chrome.idle.onStateChanged.addListener(async (state) => {
    if (!guardianActive || !sessionContext?.sessionId) return; // HARD STOP

    const idleSeconds = (state === 'idle' || state === 'locked') ? 60 : 0;

    try {
        const dataInfo = await chrome.storage.local.get('apiKey');
        const apiKey = dataInfo.apiKey;
        await fetch(`${API_BASE}/agent/tab-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({
                sessionId: sessionContext.sessionId,
                url: 'lifeos://idle',
                title: 'User Idle State',
                idleSeconds,
                type: 'idle_state'
            })
        });
    } catch (e) { }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Phase 1 -> Core guardian orchestration commands from server
    if (msg.type === 'START_GUARDIAN') {
        guardianActive = true;
        sessionContext = msg.context;
        console.log('[LifeOS] Guardian Mode ACTIVE', sessionContext);
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        activeTabs.clear();
        sendResponse({ ok: true });
    }

    if (msg.type === 'STOP_GUARDIAN') {
        guardianActive = false;
        sessionContext = null;
        console.log('[LifeOS] Guardian Mode STOPPED');
        chrome.action.setBadgeText({ text: '' });
        activeTabs.clear();
        sendResponse({ ok: true });
    }

    if (msg.type === 'GET_GUARDIAN_STATUS') {
        sendResponse({ active: guardianActive, context: sessionContext });
    }

    // Agent Loop Actions -> Passed to guardian.js content script
    if (msg.type === 'BLOCK_TAB') {
        if (!guardianActive) return; // safety
        chrome.tabs.sendMessage(sender.tab ? sender.tab.id : msg.tabId, {
            type: 'BLOCK_TAB',
            reason: msg.reason,
            targetDisplay: sessionContext?.conceptNodeName || sessionContext?.goalTitle || 'Focus Session'
        });
        sendResponse({ ok: true });
    }

    if (msg.type === 'CLASSIFY_TOAST') {
        if (!guardianActive) return;
        chrome.tabs.sendMessage(sender.tab ? sender.tab.id : msg.tabId, {
            type: 'CLASSIFY_TOAST',
            conceptTitle: msg.conceptTitle
        });
        sendResponse({ ok: true });
    }

    if (msg.type === 'CLOSE_TAB') {
        if (sender.tab && sender.tab.id) chrome.tabs.remove(sender.tab.id);
        sendResponse({ ok: true });
    }

    return true;
});
