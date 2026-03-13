// LifeOS Guardian Content Script
// Handles UI interventions (block overlay, classify toast) when commanded by the agent loop.
// Completely inert unless a message is received from background.js.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'BLOCK_TAB') {
        injectBlockOverlay(request);
    } else if (request.type === 'CLASSIFY_TOAST') {
        injectClassifyToast(request);
    }
});

function injectBlockOverlay(data) {
    if (document.getElementById('lifeos-guardian-block-overlay')) return;

    document.body.style.overflow = 'hidden';

    const target = data.targetDisplay || 'Focus Session';
    const reason = data.reason || 'Context Violation Detected';

    const overlayHTML = `
        <div id="lifeos-guardian-block-overlay" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(10, 10, 12, 0.98); z-index: 2147483647; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; color: #fff; backdrop-filter: blur(10px);">
            <div style="max-width: 500px; width: 100%; text-align: center; padding: 40px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 20px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
                <div style="font-size: 48px; margin-bottom: 20px;">🛑</div>
                <h1 style="font-size: 24px; font-weight: 900; margin: 0 0 10px 0; letter-spacing: -0.5px; color: #ef4444;">Intervention</h1>
                <p style="font-size: 16px; color: #aaa; margin-bottom: 30px; line-height: 1.5;">${reason}</p>
                
                <div style="background: rgba(0,0,0,0.5); padding: 15px; border-radius: 10px; margin-bottom: 30px; text-align: center;">
                    <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin: 0 0 8px 0;">Currently Focused On</p>
                    <p style="font-size: 16px; font-weight: 700; color: #3b82f6; margin: 0;">${target}</p>
                </div>
                
                <div style="display: flex; gap: 15px; justify-content: center;">
                    <button id="lifeos-btn-close-guardian" style="padding: 12px 24px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; flex: 1;">Close Tab</button>
                    <!-- Strict mode: No bypass button. The agent block is absolute. -->
                </div>
            </div>
            <p style="margin-top: 40px; font-size: 12px; color: #555;">LifeOS Autonomous Guardian</p>
        </div>
    `;

    const div = document.createElement('div');
    div.innerHTML = overlayHTML;
    document.body.appendChild(div.firstElementChild);

    document.getElementById('lifeos-btn-close-guardian').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
    });
}

function injectClassifyToast(data) {
    if (document.getElementById('lifeos-classify-toast')) {
        document.getElementById('lifeos-classify-toast').remove();
    }

    const toastHTML = `
        <div id="lifeos-classify-toast" style="position: fixed; bottom: 20px; right: 20px; background: rgba(10, 10, 12, 0.95); border: 1px solid rgba(59, 130, 246, 0.4); box-shadow: 0 10px 25px rgba(0,0,0,0.5); border-radius: 8px; padding: 12px 20px; z-index: 2147483647; display: flex; align-items: center; gap: 12px; font-family: system-ui, sans-serif; animation: slideInReflect 0.4s ease-out forwards; backdrop-filter: blur(8px);">
            <div style="font-size: 20px;">📚</div>
            <div>
                <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 2px;">Classified</div>
                <div style="font-size: 14px; font-weight: 600; color: #fff;">${data.conceptTitle || 'Studying'}</div>
            </div>
        </div>
        <style>
            @keyframes slideInReflect {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes fadeOutReflect {
                from { opacity: 1; }
                to { opacity: 0; }
            }
        </style>
    `;

    const div = document.createElement('div');
    div.innerHTML = toastHTML;
    document.body.appendChild(div.firstElementChild);

    setTimeout(() => {
        const toast = document.getElementById('lifeos-classify-toast');
        if (toast) {
            toast.style.animation = 'fadeOutReflect 0.5s ease-out forwards';
            setTimeout(() => toast.remove(), 500);
        }
    }, 3000);
}

// GUI bridge: allows the LifeOS web app (which runs in the browser)
// to trigger START_GUARDIAN and STOP_GUARDIAN via window.postMessage.
window.addEventListener('message', (event) => {
    // We only accept messages from ourselves
    if (event.source !== window) return;
    if (event.data && event.data.type === 'START_GUARDIAN') {
        chrome.runtime.sendMessage(event.data);
    }
    if (event.data && event.data.type === 'STOP_GUARDIAN') {
        chrome.runtime.sendMessage(event.data);
    }
});
