// Simple health check mechanism
const iframe = document.getElementById('lifeos-frame');
const errorScreen = document.getElementById('error-screen');

async function checkHealth() {
    try {
        const res = await fetch('http://localhost:3000/api/dashboard');
        if (res.ok) {
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

// Initial check
checkHealth();

// Refresh frame on focus if there was an error
window.addEventListener('focus', () => {
    if (errorScreen.classList.contains('visible')) {
        checkHealth();
        iframe.src = iframe.src; // Reload
    }
});

// Relay focus timer events from sidebar iframe to extension background
window.addEventListener('message', (event) => {
    if (event.origin !== 'http://localhost:3000') return;

    if (event.data && event.data.type === 'LIFEOS_FOCUS_START') {
        chrome.runtime.sendMessage({ type: 'START_FOCUS', duration: event.data.duration });
    }
    if (event.data && event.data.type === 'LIFEOS_FOCUS_STOP') {
        chrome.runtime.sendMessage({ type: 'STOP_FOCUS', duration: event.data.duration });
    }
});
