// LifeOS Sidebar — Extension Shell Script
const iframe = document.getElementById('lifeos-frame');
const errorScreen = document.getElementById('error-screen');

let API_BASE = 'http://localhost:3000/api';
let APP_URL = 'http://localhost:3000';

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
        const res = await fetch(`${API_BASE}/dashboard`);
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

// Relay focus session events from sidebar iframe to extension background
window.addEventListener('message', (event) => {
    if (event.origin !== APP_URL && event.origin !== 'http://localhost:3000') return;

    if (event.data && event.data.type === 'LIFEOS_FOCUS_START') {
        // Relay full focus context to background script
        chrome.runtime.sendMessage({
            type: 'START_FOCUS',
            goalId: event.data.goalId || null,
            goalTitle: event.data.goalTitle || null,
            taskId: event.data.taskId || null,
            taskTitle: event.data.taskTitle || null,
            durationMinutes: event.data.durationMinutes || 60,
        });
    }

    if (event.data && event.data.type === 'LIFEOS_FOCUS_STOP') {
        chrome.runtime.sendMessage({ type: 'STOP_FOCUS' });
    }
});
