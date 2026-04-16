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

    const isFocus = data.focusMode;
    const target = data.focusTaskTitle || data.focusGoalTitle || '';

    // --- 🚀 Auto-Unblock Logic: Smart Context Detection ---
    if (isFocus && target) {
        const pageText = document.title.toLowerCase();
        const targetWords = target.toLowerCase().split(/\s+/).filter(w => w.length > 3);

        // If the page title matches any significant words from the goal, auto-unblock it!
        if (targetWords.length > 0 && targetWords.some(w => pageText.includes(w))) {
            console.log("LifeOS: Auto-unblocking because topic matches study subject.");
            chrome.runtime.sendMessage({
                type: 'LOG_OVERRIDE',
                url: window.location.href,
                title: document.title,
                reason: "Auto-unblocked: Topic matches study subject (" + target + ")"
            });
            chrome.runtime.sendMessage({ type: 'FOCUS_OVERRIDE_LOGGED' });
            return; // Skip rendering the block overlay entirely
        }
    }

    document.body.style.overflow = 'hidden';

    const accentColor = isFocus ? '#3b82f6' : '#ff6e27';
    const borderColor = isFocus ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 100, 0, 0.3)';
    const icon = isFocus ? '🎯' : '🛑';
    const headline = isFocus ? 'Focus Session Active' : 'Context Violation Detected';

    let contextBlock = '';
    if (isFocus && target) {
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

    // Friction: Calculate delay based on whether it's a focus session and how long is left
    let delaySeconds = 5; // Default 5s delay
    if (isFocus) {
        if (data.remainingMinutes > 30) delaySeconds = 15;
        else if (data.remainingMinutes > 10) delaySeconds = 10;
        else delaySeconds = 5;
    }

    const overlayHTML = `
        <div id="lifeos-block-overlay" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(10, 10, 12, 0.98); z-index: 2147483647; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; color: #fff; backdrop-filter: blur(10px);">
            <div style="max-width: 500px; width: 100%; text-align: center; padding: 40px; background: rgba(255, 255, 255, 0.05); border: 1px solid ${borderColor}; border-radius: 20px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
                <div style="font-size: 48px; margin-bottom: 20px;">${icon}</div>
                <h1 style="font-size: 24px; font-weight: 900; margin: 0 0 10px 0; letter-spacing: -0.5px; color: ${accentColor};">${headline}</h1>
                <p style="font-size: 16px; color: #aaa; margin-bottom: 30px; line-height: 1.5;">${data.reason}</p>
                ${contextBlock}
                
                <div id="lifeos-override-section" style="margin-bottom: 25px; text-align: left; display: none;">
                    <label style="display: block; font-size: 12px; text-transform: uppercase; color: #888; margin-bottom: 8px;">Why do you need to override? (Required)</label>
                    <input type="text" id="lifeos-override-reason" placeholder="Type reason here (min 10 chars)..." style="width: 100%; padding: 12px; background: rgba(0,0,0,0.3); border: 1px solid #444; border-radius: 8px; color: #fff; font-size: 14px; box-sizing: border-box;">
                </div>

                <div style="display: flex; gap: 15px; justify-content: center;">
                    <button id="lifeos-btn-close" style="padding: 12px 24px; background: ${accentColor}; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; flex: 1;">Close Tab</button>
                    <button id="lifeos-btn-override" disabled style="padding: 12px 24px; background: rgba(255,255,255,0.05); color: #555; border: 1px solid #333; border-radius: 8px; font-size: 14px; cursor: not-allowed; flex: 1; transition: all 0.3s ease;">Wait ${delaySeconds}s...</button>
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

    const overrideBtn = document.getElementById('lifeos-btn-override');
    const overrideSection = document.getElementById('lifeos-override-section');
    const reasonInput = document.getElementById('lifeos-override-reason');

    // Countdown logic
    let remaining = delaySeconds;
    const timer = setInterval(() => {
        remaining--;
        if (remaining > 0) {
            overrideBtn.innerText = "Wait " + remaining + "s...";
        } else {
            clearInterval(timer);
            overrideSection.style.display = 'block';
            overrideBtn.innerText = overrideLabel;

            // Check input to enable button
            const checkInput = () => {
                if (reasonInput.value.trim().length >= 10) {
                    overrideBtn.disabled = false;
                    overrideBtn.style.cursor = 'pointer';
                    overrideBtn.style.color = '#fff';
                    overrideBtn.style.borderColor = '#666';
                    overrideBtn.style.background = 'transparent';
                } else {
                    overrideBtn.disabled = true;
                    overrideBtn.style.cursor = 'not-allowed';
                    overrideBtn.style.color = '#555';
                    overrideBtn.style.borderColor = '#333';
                    overrideBtn.style.background = 'rgba(255,255,255,0.05)';
                }
            };

            reasonInput.addEventListener('input', checkInput);
            checkInput(); // Initial check
        }
    }, 1000);

    overrideBtn.addEventListener('click', () => {
        if (overrideBtn.disabled) return;

        const userReason = reasonInput.value.trim();
        if (_blockContext) {
            chrome.runtime.sendMessage({
                type: 'LOG_OVERRIDE',
                url: _blockContext.url,
                title: _blockContext.title,
                reason: _blockContext.reason + ' | User Reason: ' + userReason,
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

// ─── Guidance: text selection + Option+D hotkey ───────────────────────────────
// Stores the last selected text so the hotkey can pick it up without
// a second selection event. Clears on mousedown (new click starts fresh).

let _lastSelectedText = '';

document.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
        _lastSelectedText = sel.toString().trim();
    }
});

document.addEventListener('mousedown', () => {
    _lastSelectedText = '';
});

// Option+D (Mac: Alt+D) — send guidance request with selected text + page title
document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyD' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const selectedText = _lastSelectedText || window.getSelection()?.toString().trim() || '';
        chrome.runtime.sendMessage({
            type: 'GUIDANCE_REQUEST',
            selectedText,
            question: selectedText
                ? `Explain the following and how it relates to my session goal: "${selectedText.slice(0, 300)}"`
                : 'Explain what I am looking at in the context of my session goal.',
            windowTitle: document.title,
        });
    }
});
