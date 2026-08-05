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
	
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function injectBlockOverlay(data) {
    if (document.getElementById('lifeos-guardian-block-overlay')) return;

    document.body.style.overflow = 'hidden';

    const target = data.targetDisplay || 'Focus Session';
    const reason = data.reason || 'Context Violation Detected';
    const policy = data.interventionPolicy || {};
    const headline = policy.headline || 'Intervention';
    const contextLine = policy.contextLine || 'This page does not currently fit the protected session.';
    const overridePrompt = policy.overridePrompt || 'If this site is actually needed, explain why and request a short override.';
    const minReasonChars = Number(policy.minReasonChars || 10);
    const frictionSeconds = Math.max(0, Number(policy.frictionSeconds || 0));
    const tone = policy.tone || 'firm';
    const accentColor = tone === 'gentle' ? '#60a5fa' : tone === 'urgent' ? '#f97316' : '#ef4444';
    const overrideOptions = Array.isArray(policy.overrideOptions) && policy.overrideOptions.length > 0
        ? policy.overrideOptions
        : [
            { minutes: 5, label: '5 min override' },
            { minutes: 10, label: '10 min override', default: true },
            { minutes: 15, label: '15 min override' },
        ];
    const optionsHtml = overrideOptions.map(option => {
        const minutes = Number(option.minutes || 5);
        const label = escapeHtml(option.label || `${minutes} min override`);
        const selected = option.default ? ' selected' : '';
        return `<option value="${minutes}"${selected}>${label}</option>`;
    }).join('');
    const safeHeadline = escapeHtml(headline);
    const safeReason = escapeHtml(reason);
    const safeTarget = escapeHtml(target);
    const safeContextLine = escapeHtml(contextLine);
    const safeExplainability = escapeHtml(data.explainability || reason);
    const safeOverridePrompt = escapeHtml(overridePrompt);

    const overlayHTML = `
        <div id="lifeos-guardian-block-overlay" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(10, 10, 12, 0.98); z-index: 2147483647; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; color: #fff; backdrop-filter: blur(10px);">
            <div style="max-width: 520px; width: 100%; text-align: center; padding: 40px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 20px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
                <div style="font-size: 48px; margin-bottom: 20px;">🛑</div>
                <h1 style="font-size: 24px; font-weight: 900; margin: 0 0 10px 0; letter-spacing: 0; color: ${accentColor};">${safeHeadline}</h1>
                <p style="font-size: 16px; color: #aaa; margin-bottom: 30px; line-height: 1.5;">${safeReason}</p>
                
                <div style="background: rgba(0,0,0,0.5); padding: 15px; border-radius: 10px; margin-bottom: 30px; text-align: center;">
                    <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin: 0 0 8px 0;">Currently Focused On</p>
                    <p style="font-size: 16px; font-weight: 700; color: #3b82f6; margin: 0;">${safeTarget}</p>
                </div>
                <div style="background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.18); padding: 12px; border-radius: 10px; margin-bottom: 14px; text-align: left;">
                    <p style="font-size: 11px; color: #93c5fd; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 1px;">Today-aware policy</p>
                    <p style="font-size: 13px; color: #dbeafe; margin: 0;">${safeContextLine}</p>
                </div>
                <div style="background: rgba(255,255,255,0.03); padding: 12px; border-radius: 10px; margin-bottom: 18px; text-align: left;">
                    <p style="font-size: 11px; color: #9ca3af; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 1px;">Why this block happened</p>
                    <p style="font-size: 13px; color: #e5e7eb; margin: 0;">${safeExplainability}</p>
                </div>
                <textarea id="lifeos-override-reason" placeholder="${safeOverridePrompt}" style="width: 100%; min-height: 90px; background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; color: #fff; padding: 12px; resize: vertical; font-size: 13px; margin-bottom: 12px;"></textarea>
                <div style="display: flex; gap: 12px; margin-bottom: 16px;">
                    <select id="lifeos-override-minutes" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.45); color: #fff; border: 1px solid rgba(255,255,255,0.08);">
                        ${optionsHtml}
                    </select>
                    <button id="lifeos-btn-request-override" style="flex: 1; padding: 12px 16px; background: rgba(59,130,246,0.12); color: #93c5fd; border: 1px solid rgba(59,130,246,0.35); border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer;">${frictionSeconds > 0 ? `Wait ${frictionSeconds}s` : 'Ask For Override'}</button>
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
    const overrideButton = document.getElementById('lifeos-btn-request-override');
    if (frictionSeconds > 0) {
        overrideButton.disabled = true;
        overrideButton.style.opacity = '0.65';
        overrideButton.style.cursor = 'not-allowed';
        let remaining = frictionSeconds;
        const timer = setInterval(() => {
            remaining -= 1;
            if (remaining > 0) {
                overrideButton.textContent = `Wait ${remaining}s`;
                return;
            }
            clearInterval(timer);
            overrideButton.disabled = false;
            overrideButton.style.opacity = '1';
            overrideButton.style.cursor = 'pointer';
            overrideButton.textContent = 'Ask For Override';
        }, 1000);
    }
    overrideButton.addEventListener('click', () => {
        if (overrideButton.disabled) return;
        const reasonText = document.getElementById('lifeos-override-reason').value.trim();
        const requestedMinutes = parseInt(document.getElementById('lifeos-override-minutes').value, 10);
        const status = document.getElementById('lifeos-override-status');
        if (reasonText.length < minReasonChars) {
            status.textContent = `Explain why this target is needed in at least ${minReasonChars} characters.`;
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

let pttTimerInterval = null;
let pttTimerSeconds  = 0;

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
                transform: translateX(-50%) translateY(120px);
                z-index: 2147483647;
                display: flex;
                align-items: center;
                gap: 14px;
                background: rgba(12, 12, 16, 0.94);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 56px;
                padding: 12px 22px 12px 14px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.03);
                font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
                backdrop-filter: blur(24px);
                transition: transform 0.4s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease;
                opacity: 0;
                pointer-events: none;
            }
            #lifeos-ptt-overlay.lifeos-ptt-visible {
                transform: translateX(-50%) translateY(0);
                opacity: 1;
            }

            /* ── Icon circle ── */
            #lifeos-ptt-icon-wrap {
                width: 40px; height: 40px;
                border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
                background: rgba(255,255,255,0.07);
                transition: background 0.25s;
            }
            #lifeos-ptt-overlay.lifeos-ptt-recording #lifeos-ptt-icon-wrap {
                background: #dc2626;
                animation: lifeos-ptt-ring-pulse 1.2s ease-in-out infinite;
            }
            #lifeos-ptt-overlay.lifeos-ptt-processing #lifeos-ptt-icon-wrap {
                background: rgba(99,102,241,0.25);
            }
            #lifeos-ptt-overlay.lifeos-ptt-speaking #lifeos-ptt-icon-wrap {
                background: rgba(34,197,94,0.2);
            }
            @keyframes lifeos-ptt-ring-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); }
                50%       { box-shadow: 0 0 0 10px rgba(220,38,38,0); }
            }

            /* ── Icons ── */
            .lifeos-ptt-svg { display: none; }
            #lifeos-ptt-overlay.lifeos-ptt-recording  .lifeos-ptt-svg-mic      { display: block; }
            #lifeos-ptt-overlay.lifeos-ptt-processing .lifeos-ptt-svg-spinner  { display: block; animation: lifeos-ptt-spin 0.8s linear infinite; }
            #lifeos-ptt-overlay.lifeos-ptt-speaking   .lifeos-ptt-svg-wave-ico { display: block; }
            @keyframes lifeos-ptt-spin { to { transform: rotate(360deg); } }

            /* ── Waveform bars (recording + speaking) ── */
            #lifeos-ptt-bars {
                display: none;
                align-items: center;
                gap: 3px;
                height: 24px;
            }
            #lifeos-ptt-overlay.lifeos-ptt-recording #lifeos-ptt-bars,
            #lifeos-ptt-overlay.lifeos-ptt-speaking  #lifeos-ptt-bars {
                display: flex;
            }
            .lifeos-ptt-bar {
                width: 3px; border-radius: 3px;
                animation: lifeos-bar-bounce 0.7s ease-in-out infinite alternate;
            }
            #lifeos-ptt-overlay.lifeos-ptt-recording .lifeos-ptt-bar { background: rgba(255,255,255,0.7); }
            #lifeos-ptt-overlay.lifeos-ptt-speaking  .lifeos-ptt-bar { background: #22c55e; }
            .lifeos-ptt-bar:nth-child(1) { height: 6px;  animation-delay: 0s;    animation-duration: 0.6s; }
            .lifeos-ptt-bar:nth-child(2) { height: 14px; animation-delay: 0.1s;  animation-duration: 0.5s; }
            .lifeos-ptt-bar:nth-child(3) { height: 22px; animation-delay: 0.2s;  animation-duration: 0.7s; }
            .lifeos-ptt-bar:nth-child(4) { height: 14px; animation-delay: 0.15s; animation-duration: 0.55s; }
            .lifeos-ptt-bar:nth-child(5) { height: 6px;  animation-delay: 0.05s; animation-duration: 0.65s; }
            @keyframes lifeos-bar-bounce {
                from { transform: scaleY(0.3); opacity: 0.6; }
                to   { transform: scaleY(1);   opacity: 1; }
            }

            /* ── Labels ── */
            #lifeos-ptt-label {
                font-size: 13px; font-weight: 500; color: #f3f4f6; line-height: 1.3;
            }
            #lifeos-ptt-timer {
                font-size: 12px; color: #9ca3af; margin-top: 2px; font-variant-numeric: tabular-nums;
            }
        </style>

        <div id="lifeos-ptt-icon-wrap">
            <svg class="lifeos-ptt-svg lifeos-ptt-svg-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3"/>
                <path d="M5 10a7 7 0 0 0 14 0"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
                <line x1="8" y1="22" x2="16" y2="22"/>
            </svg>
            <svg class="lifeos-ptt-svg lifeos-ptt-svg-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2.5" stroke-linecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <svg class="lifeos-ptt-svg lifeos-ptt-svg-wave-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round">
                <path d="M2 12h3M7 6v12M12 3v18M17 6v12M22 12h-3"/>
            </svg>
        </div>

        <div>
            <div id="lifeos-ptt-bars">
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
                <div class="lifeos-ptt-bar"></div>
            </div>
            <div id="lifeos-ptt-label">Listening...</div>
            <div id="lifeos-ptt-timer"></div>
        </div>
    `;
    document.documentElement.appendChild(el);
}

function updatePttOverlay(state, transcript) {
    injectPttOverlay();
    const el       = document.getElementById('lifeos-ptt-overlay');
    const label    = document.getElementById('lifeos-ptt-label');
    const timer    = document.getElementById('lifeos-ptt-timer');
    if (!el || !label || !timer) return;

    // Clear any existing hide timer
    if (el._hideTimeout) { clearTimeout(el._hideTimeout); el._hideTimeout = null; }
    // Clear recording timer
    if (pttTimerInterval) { clearInterval(pttTimerInterval); pttTimerInterval = null; }

    el.classList.remove(
        'lifeos-ptt-visible',
        'lifeos-ptt-recording',
        'lifeos-ptt-processing',
        'lifeos-ptt-speaking'
    );
    timer.textContent = '';

    if (state === 'recording') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-recording');
        label.textContent = 'Listening...';
        timer.textContent = '0:00';
        pttTimerSeconds = 0;
        pttTimerInterval = setInterval(() => {
            pttTimerSeconds++;
            const m = Math.floor(pttTimerSeconds / 60);
            const s = String(pttTimerSeconds % 60).padStart(2, '0');
            const t = document.getElementById('lifeos-ptt-timer');
            if (t) t.textContent = `${m}:${s}`;
        }, 1000);

    } else if (state === 'sending' || state === 'processing') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-processing');
        label.textContent = 'Thinking...';

    } else if (state === 'speaking') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-speaking');
        label.textContent = 'Guardian';

    } else if (state === 'done' || state === 'idle') {
        // Slide out
        el.classList.remove('lifeos-ptt-visible');

    } else if (state === 'permission') {
        el.classList.add('lifeos-ptt-visible', 'lifeos-ptt-processing');
        label.textContent = 'Mic permission needed';
        el._hideTimeout = setTimeout(() => {
            el.classList.remove('lifeos-ptt-visible');
        }, 4000);
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
    if (event.data && event.data.type === 'LIFEOS_WAKE_COPILOT') {
        chrome.runtime.sendMessage({ type: 'WAKE_COPILOT' }, (result) => {
            window.postMessage({
                type: 'LIFEOS_WAKE_COPILOT_RESULT',
                requestId: event.data.requestId || null,
                result: result || { ok: false, error: 'No response from LifeOS extension' },
            }, '*');
        });
    }
});

// Browser support surface. The extension contributes DOM selection and page
// context that the native app cannot see; the native app contributes OS-level
// app, screen, audio, and overlay state that the extension cannot see.
let lastLifeOSSelectedText = '';
document.addEventListener('mouseup', () => {
    const selected = window.getSelection()?.toString().trim() || '';
    if (selected) lastLifeOSSelectedText = selected;
});
document.addEventListener('mousedown', () => {
    lastLifeOSSelectedText = '';
});
document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.code !== 'KeyD' || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const selectedText = lastLifeOSSelectedText || window.getSelection()?.toString().trim() || '';
    chrome.runtime.sendMessage({
        type: 'GUIDANCE_REQUEST',
        selectedText,
        question: selectedText
            ? `Explain the following and how it relates to my session goal: "${selectedText.slice(0, 300)}"`
            : 'Explain what I am looking at in the context of my session goal.',
        windowTitle: document.title,
    });
});

} // end __lifeosGuardianLoaded guard
