// Listener from background script telling us to block this tab
let _blockContext = null; // Store context for override logging

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'BLOCK_PAGE') {
        _blockContext = { reason: request.reason, goals: request.goals, url: window.location.href, title: document.title };
        injectBlockOverlay(request.reason, request.goals);
    }
});

function injectBlockOverlay(reason, goals) {
    // Prevent multiple overlays
    if (document.getElementById('lifeos-block-overlay')) return;

    // Freeze page interaction
    document.body.style.overflow = 'hidden';

    const goalList = goals.map(g => `<li><strong>${g.title}</strong></li>`).join('');

    const overlayHTML = `
        <div id="lifeos-block-overlay" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(10, 10, 12, 0.98); z-index: 2147483647; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; color: #fff; backdrop-filter: blur(10px);">
            
            <div style="max-width: 500px; text-align: center; padding: 40px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 100, 0, 0.3); border-radius: 20px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
                
                <div style="font-size: 48px; margin-bottom: 20px;">🛑</div>
                
                <h1 style="font-size: 24px; font-weight: 900; margin: 0 0 10px 0; letter-spacing: -0.5px; color: #ff6e27;">
                    Context Violation Detected
                </h1>
                
                <p style="font-size: 16px; color: #aaa; margin-bottom: 30px; line-height: 1.5;">
                    ${reason}
                </p>

                <div style="background: rgba(0,0,0,0.5); padding: 15px; border-radius: 10px; margin-bottom: 30px; text-align: left;">
                    <p style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin: 0 0 10px 0;">Your Active Goals</p>
                    <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #ddd; line-height: 1.6;">
                        ${goalList}
                    </ul>
                </div>

                <div style="display: flex; gap: 15px; justify-content: center;">
                    <button id="lifeos-btn-close" style="padding: 12px 24px; background: #ff6e27; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; transition: transform 0.1s;">
                        Close Tab
                    </button>
                    <button id="lifeos-btn-override" style="padding: 12px 24px; background: transparent; color: #888; border: 1px solid #444; border-radius: 8px; font-size: 14px; cursor: pointer; transition: color 0.2s;">
                        Override Block
                    </button>
                </div>
                
            </div>
            
            <p style="margin-top: 40px; font-size: 12px; color: #555;">LifeOS Context Engine</p>
        </div>
    `;

    // Inject into the DOM
    const div = document.createElement('div');
    div.innerHTML = overlayHTML;
    document.body.appendChild(div.firstElementChild);

    // Event Listeners
    document.getElementById('lifeos-btn-close').addEventListener('click', () => {
        // Ask background script to close this tab
        chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
    });

    document.getElementById('lifeos-btn-override').addEventListener('click', () => {
        // Log override to LifeOS backend for AI learning
        if (_blockContext) {
            chrome.runtime.sendMessage({
                type: 'LOG_OVERRIDE',
                url: _blockContext.url,
                title: _blockContext.title,
                reason: _blockContext.reason
            });
        }
        const overlay = document.getElementById('lifeos-block-overlay');
        overlay.remove();
        document.body.style.overflow = 'auto'; // Restore scrolling
    });
}
