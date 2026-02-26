// Listener from background script telling us to block this tab
let _blockContext = null; // Store context for override logging

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'BLOCK_PAGE') {
        _blockContext = {
            reason: request.reason,
            goals: request.goals,
            url: window.location.href,
            title: document.title,
            focusMode: request.focusMode || false,
            focusGoalTitle: request.focusGoalTitle,
            focusTaskTitle: request.focusTaskTitle,
            remainingMinutes: request.remainingMinutes,
        };
        injectBlockOverlay(request);
    }
});

// --- Phase 24: Micro-Interaction Presence Tracking ---
let lastInteraction = Date.now();
const IDLE_THRESHOLD_MS = 60000; // 60 seconds
let isCurrentlyIdle = false;
let throttleTimer = null;

function updateInteraction() {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
        lastInteraction = Date.now();
        throttleTimer = null;
    }, 2000);
}

const interactionEvents = ['mousemove', 'keydown', 'wheel', 'scroll', 'click', 'touchstart'];
interactionEvents.forEach(event => {
    window.addEventListener(event, updateInteraction, { passive: true, capture: true });
});

setInterval(() => {
    const timeSinceLastInteraction = Date.now() - lastInteraction;
    if (timeSinceLastInteraction > IDLE_THRESHOLD_MS && !isCurrentlyIdle) {
        isCurrentlyIdle = true;
        chrome.runtime.sendMessage({ type: 'MICRO_IDLE_STATE_CHANGED', isIdle: true, lastInteraction });
    } else if (timeSinceLastInteraction <= IDLE_THRESHOLD_MS && isCurrentlyIdle) {
        isCurrentlyIdle = false;
        chrome.runtime.sendMessage({ type: 'MICRO_IDLE_STATE_CHANGED', isIdle: false, lastInteraction });
    }
}, 5000);

function injectBlockOverlay(data) {
    if (document.getElementById('lifeos-block-overlay')) return;
    document.body.style.overflow = 'hidden';

    const isFocus = data.focusMode;
    const accentColor = isFocus ? '#3b82f6' : '#ff6e27';
    const borderColor = isFocus ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 100, 0, 0.3)';
    const icon = isFocus ? '🎯' : '🛑';
    const headline = isFocus ? 'Focus Session Active' : 'Context Violation Detected';

    let contextBlock = '';
    if (isFocus && (data.focusTaskTitle || data.focusGoalTitle)) {
        const target = data.focusTaskTitle || data.focusGoalTitle;
        const timeInfo = data.remainingMinutes ? `${data.remainingMinutes} min remaining` : '';
        contextBlock = `
            <div style="background: rgba(0,0,0,0.5); padding: 15px; border-radius: 10px; margin-bottom: 30px; text-align: center;">
                <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin: 0 0 8px 0;">Currently Focused On</p>
                <p style="font-size: 16px; font-weight: 700; color: ${accentColor}; margin: 0;">${target}</p>
                ${timeInfo ? `<p style="font-size: 12px; color: #666; margin: 4px 0 0 0;">${timeInfo}</p>` : ''}
            </div>`;
    } else if (data.goals && data.goals.length > 0) {
        const goalList = data.goals.map(g => `<li><strong>${g.title}</strong></li>`).join('');
        contextBlock = `
            <div style="background: rgba(0,0,0,0.5); padding: 15px; border-radius: 10px; margin-bottom: 30px; text-align: left;">
                <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin: 0 0 10px 0;">Your Active Goals</p>
                <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #ddd; line-height: 1.6;">${goalList}</ul>
            </div>`;
    }

    const overrideLabel = isFocus ? 'I need this for my task' : 'Override Block';

    const overlayHTML = `
        <div id="lifeos-block-overlay" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(10, 10, 12, 0.98); z-index: 2147483647; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; color: #fff; backdrop-filter: blur(10px);">
            <div style="max-width: 500px; text-align: center; padding: 40px; background: rgba(255, 255, 255, 0.05); border: 1px solid ${borderColor}; border-radius: 20px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
                <div style="font-size: 48px; margin-bottom: 20px;">${icon}</div>
                <h1 style="font-size: 24px; font-weight: 900; margin: 0 0 10px 0; letter-spacing: -0.5px; color: ${accentColor};">${headline}</h1>
                <p style="font-size: 16px; color: #aaa; margin-bottom: 30px; line-height: 1.5;">${data.reason}</p>
                ${contextBlock}
                <div style="display: flex; gap: 15px; justify-content: center;">
                    <button id="lifeos-btn-close" style="padding: 12px 24px; background: ${accentColor}; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer;">Close Tab</button>
                    <button id="lifeos-btn-override" style="padding: 12px 24px; background: transparent; color: #888; border: 1px solid #444; border-radius: 8px; font-size: 14px; cursor: pointer;">${overrideLabel}</button>
                </div>
            </div>
            <p style="margin-top: 40px; font-size: 12px; color: #555;">LifeOS ${isFocus ? 'Focus Engine' : 'Context Engine'}</p>
        </div>
    `;

    const div = document.createElement('div');
    div.innerHTML = overlayHTML;
    document.body.appendChild(div.firstElementChild);

    document.getElementById('lifeos-btn-close').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
    });

    document.getElementById('lifeos-btn-override').addEventListener('click', () => {
        if (_blockContext) {
            chrome.runtime.sendMessage({
                type: 'LOG_OVERRIDE',
                url: _blockContext.url,
                title: _blockContext.title,
                reason: _blockContext.reason,
            });
            if (_blockContext.focusMode) {
                chrome.runtime.sendMessage({ type: 'FOCUS_OVERRIDE_LOGGED' });
            }
        }
        const overlay = document.getElementById('lifeos-block-overlay');
        overlay.remove();
        document.body.style.overflow = 'auto';
    });
}
