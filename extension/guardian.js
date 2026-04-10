// LifeOS Guardian Content Script
// Handles UI interventions (block overlay, classify toast) when commanded by the agent loop.
// Completely inert unless a message is received from background.js.

// Guard against double-injection (pre-existing tabs re-injected via chrome.scripting.executeScript)
if (window.__lifeosGuardianLoaded) { /* already loaded */ } else {
window.__lifeosGuardianLoaded = true;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'BLOCK_TAB') {
        injectBlockOverlay(request);
    } else if (request.type === 'UNBLOCK_TAB') {
        removeBlockOverlay(request);
    } else if (request.type === 'OVERRIDE_DECISION') {
        showOverrideDecision(request.decision);
    } else if (request.type === 'CLASSIFY_TOAST') {
        injectClassifyToast(request);
    } else if (request.type === 'PTT_STATE') {
        updatePttOverlay(request.state, request.transcript);
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
                <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 10px; margin-bottom: 18px; text-align: left;">
                    <p style="font-size: 11px; color: #9ca3af; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 1px;">Why this block happened</p>
                    <p style="font-size: 13px; color: #e5e7eb; margin: 0;">${data.explainability || reason}</p>
                </div>
                <textarea id="lifeos-override-reason" placeholder="If this site is actually needed, explain why and request a short override." style="width: 100%; min-height: 90px; background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; color: #fff; padding: 12px; resize: vertical; font-size: 13px; margin-bottom: 12px;"></textarea>
                <div style="display: flex; gap: 12px; margin-bottom: 16px;">
                    <select id="lifeos-override-minutes" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.45); color: #fff; border: 1px solid rgba(255,255,255,0.08);">
                        <option value="5">5 min override</option>
                        <option value="10" selected>10 min override</option>
                        <option value="15">15 min override</option>
                    </select>
                    <button id="lifeos-btn-request-override" style="flex: 1; padding: 12px 16px; background: rgba(59,130,246,0.12); color: #93c5fd; border: 1px solid rgba(59,130,246,0.35); border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer;">Ask For Override</button>
                </div>
                <div id="lifeos-override-status" style="min-height: 18px; font-size: 12px; color: #9ca3af; margin-bottom: 16px;"></div>
                
                <div style="display: flex; gap: 15px; justify-content: center;">
                    <button id="lifeos-btn-close-guardian" style="padding: 12px 24px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; flex: 1;">Close Tab</button>
                    <button id="lifeos-btn-stay-locked" style="padding: 12px 24px; background: transparent; color: #9ca3af; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; flex: 1;">Back To Work</button>
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
    document.getElementById('lifeos-btn-stay-locked').addEventListener('click', () => {
        window.history.back();
    });
    document.getElementById('lifeos-btn-request-override').addEventListener('click', () => {
        const reasonText = document.getElementById('lifeos-override-reason').value.trim();
        const requestedMinutes = parseInt(document.getElementById('lifeos-override-minutes').value, 10);
        const status = document.getElementById('lifeos-override-status');
        if (!reasonText) {
            status.textContent = 'Explain why this target is needed before requesting an override.';
            return;
        }

        status.textContent = 'Reviewing override request...';
        chrome.runtime.sendMessage({
            type: 'REQUEST_OVERRIDE',
            url: location.href,
            title: document.title,
            reason: reasonText,
            requestedMinutes,
        }, (response) => {
            const decision = response?.decision;
            if (!decision) {
                status.textContent = 'Override review failed.';
                return;
            }
            status.textContent = decision.approved
                ? `Override approved for ${decision.ttlMinutes} minutes.`
                : decision.explainability;
        });
    });
}

function removeBlockOverlay(data = {}) {
    const overlay = document.getElementById('lifeos-guardian-block-overlay');
    if (overlay) overlay.remove();
    document.body.style.overflow = '';
    if (data.reason) {
        injectClassifyToast({ conceptTitle: data.reason });
    }
}

function showOverrideDecision(decision) {
    const status = document.getElementById('lifeos-override-status');
    if (status && decision) {
        status.textContent = decision.explainability || decision.reason;
    }
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

// ── PTT Floating Overlay ─────────────────────────────────────────────────────

function injectPttOverlay() {
    if (document.getElementById('lifeos-ptt-overlay')) return;

    const el = document.createElement('div');
    el.id = 'lifeos-ptt-overlay';
    el.innerHTML = `
        <style>
            #lifeos-ptt-overlay {
                position: fixed;
                bottom: 28px;
                left: 50%;
                transform: translateX(-50%) translateY(80px);
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 12px;
                background: rgba(10, 10, 14, 0.92);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 50px;
                padding: 10px 20px 10px 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
                font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
                backdrop-filter: blur(20px);
                transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease;
                opacity: 0;
            }
            #lifeos-ptt-overlay.lifeos-ptt-visible {
                transform: translateX(-50%) translateY(0);
                opacity: 1;
            }
            #lifeos-ptt-mic {
                width: 38px;
                height: 38px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255,255,255,0.08);
                flex-shrink: 0;
                transition: background 0.2s;
            }
            #lifeos-ptt-overlay.lifeos-ptt-recording #lifeos-ptt-mic {
                background: #dc2626;
                animation: lifeos-ptt-pulse 1s ease-in-out infinite;
            }
            #lifeos-ptt-overlay.lifeos-ptt-sending #lifeos-ptt-mic {
                background: rgba(59,130,246,0.3);
            }
            #lifeos-ptt-overlay.lifeos-ptt-done #lifeos-ptt-mic {
                background: rgba(34,197,94,0.3);
            }
            @keyframes lifeos-ptt-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); }
                50% { box-shadow: 0 0 0 8px rgba(220,38,38,0); }
            }
            @keyframes lifeos-ptt-spin {
                to { transform: rotate(360deg); }
            }
            #lifeos-ptt-label {
                font-size: 13px;
                font-weight: 500;
                color: #e5e7eb;
                line-height: 1.3;
                max-width: 220px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #lifeos-ptt-sublabel {
                font-size: 11px;
                color: #6b7280;
                margin-top: 1px;
            }
        </style>
        <div id="lifeos-ptt-mic">
            <svg id="lifeos-ptt-icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>
            <svg id="lifeos-ptt-icon-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round" style="display:none; animation: lifeos-ptt-spin 0.8s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <svg id="lifeos-ptt-icon-done" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div>
            <div id="lifeos-ptt-label">Listening...</div>
            <div id="lifeos-ptt-sublabel">Release Cmd+Shift+Space to send</div>
        </div>
    `;
    document.documentElement.appendChild(el);
}

function updatePttOverlay(state, transcript) {
    injectPttOverlay();
    const el = document.getElementById('lifeos-ptt-overlay');
    if (!el) return;

    const label    = document.getElementById('lifeos-ptt-label');
    const sublabel = document.getElementById('lifeos-ptt-sublabel');
    const iconMic  = document.getElementById('lifeos-ptt-icon-mic');
    const iconSpin = document.getElementById('lifeos-ptt-icon-spin');
    const iconDone = document.getElementById('lifeos-ptt-icon-done');

    // Reset icon visibility
    iconMic.style.display  = 'none';
    iconSpin.style.display = 'none';
    iconDone.style.display = 'none';

    el.classList.remove('lifeos-ptt-recording', 'lifeos-ptt-sending', 'lifeos-ptt-done');

    if (state === 'recording') {
        iconMic.style.display = 'block';
        el.classList.add('lifeos-ptt-recording');
        label.textContent    = 'Listening...';
        sublabel.textContent = 'Press Cmd+Shift+Space again to send';
        el.classList.add('lifeos-ptt-visible');
    } else if (state === 'sending') {
        iconSpin.style.display = 'block';
        el.classList.add('lifeos-ptt-sending');
        label.textContent    = 'Processing...';
        sublabel.textContent = transcript ? `"${transcript.slice(0, 40)}..."` : 'Sending audio';
        el.classList.add('lifeos-ptt-visible');
    } else if (state === 'done') {
        iconDone.style.display = 'block';
        el.classList.add('lifeos-ptt-done');
        if (transcript) {
            label.textContent    = `"${transcript.slice(0, 50)}"`;
            sublabel.textContent = 'Response sent';
        } else {
            label.textContent    = "Didn't catch that";
            sublabel.textContent = 'Speak louder or try again';
        }
        el.classList.add('lifeos-ptt-visible');
        // Auto-hide after 2.5s
        setTimeout(() => {
            el.classList.remove('lifeos-ptt-visible');
            setTimeout(() => el.remove(), 400);
        }, 2500);
    } else if (state === 'permission') {
        // Show mic permission instruction
        iconMic.style.display = 'block';
        el.style.setProperty('--ptt-mic-bg', 'rgba(234,179,8,0.25)');
        label.textContent    = 'Microphone access needed';
        sublabel.textContent = 'Click the LifeOS icon \u2192 Enable Voice';
        el.classList.add('lifeos-ptt-visible');
        // Auto-hide after 4s
        setTimeout(() => {
            el.classList.remove('lifeos-ptt-visible');
            setTimeout(() => el.remove(), 400);
        }, 4000);
    } else {
        // 'idle' or unknown — slide away
        el.classList.remove('lifeos-ptt-visible');
        setTimeout(() => el.remove(), 400);
    }
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

} // end __lifeosGuardianLoaded guard
