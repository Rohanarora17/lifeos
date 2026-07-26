// LifeOS Sidebar — Extension Shell Script
const iframe = document.getElementById('lifeos-frame');
const errorScreen = document.getElementById('error-screen');

let API_BASE = 'http://localhost:3000/api';
let APP_URL = 'http://localhost:3000';

async function apiFetch(url, options = {}) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    const headers = new Headers(options.headers || {});
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    return fetch(url, { ...options, headers });
}

chrome.storage.local.get('apiUrl', (data) => {
    if (data.apiUrl) {
        API_BASE = data.apiUrl;
        APP_URL = data.apiUrl.replace(/\/api$/, '');
    }
    const expectedUrlEl = document.getElementById('expected-url');
    if (expectedUrlEl) expectedUrlEl.innerText = APP_URL;
    checkHealth();
});

async function checkHealth() {
    try {
        const res = await apiFetch(`${API_BASE}/dashboard`);
        if (res.ok) {
            if (!iframe.src || iframe.src === 'about:blank' || document.location.href === iframe.src) {
                iframe.src = APP_URL + '/extension/sidebar';
            }
            iframe.style.display = 'block';
            errorScreen.classList.remove('visible');
        } else {
            throw new Error('Not ok');
        }
    } catch (e) {
        iframe.style.display = 'none';
        errorScreen.classList.add('visible');
    }
}

// Refresh frame on focus if there was an error
window.addEventListener('focus', () => {
    if (errorScreen.classList.contains('visible')) {
        checkHealth();
        iframe.src = iframe.src; // Reload
    }
});

// Relay guardian lifecycle events from the sidebar iframe to the background script.
window.addEventListener('message', (event) => {
    // Accept messages from the configured app URL (which may be a LAN/VPN IP, not localhost).
    // We check host+port rather than full origin so that the check still passes before
    // storage finishes loading APP_URL (APP_URL defaults to localhost:3000 but the iframe
    // may be at a different IP if the server is accessed by IP address).
    const eventOriginHost = event.origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const appUrlHost = APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const isOwnOrigin = eventOriginHost === appUrlHost ||
        eventOriginHost === 'localhost:3000' || eventOriginHost === '127.0.0.1:3000';
    if (!isOwnOrigin) return;

    if (event.data && (event.data.type === 'START_GUARDIAN' || event.data.type === 'LIFEOS_FOCUS_START')) {
        chrome.runtime.sendMessage({
            type: 'START_GUARDIAN',
            context: event.data.context || {
                goalId: event.data.goalId ? String(event.data.goalId) : null,
                goalTitle: event.data.goalTitle || null,
                conceptNodeName: event.data.taskTitle || event.data.goalTitle || 'Focus Session',
                durationMinutes: event.data.durationMinutes || 60,
            },
        });
    }

    if (event.data && (event.data.type === 'STOP_GUARDIAN' || event.data.type === 'LIFEOS_FOCUS_STOP')) {
        chrome.runtime.sendMessage({ type: 'STOP_GUARDIAN' });
    }
});
