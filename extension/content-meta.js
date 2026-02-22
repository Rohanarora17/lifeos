(function () {
    // Only run on standard web pages
    if (!window.location.protocol.startsWith('http')) return;

    function extractMeta() {
        let metaDesc = '';
        const metaTag = document.querySelector('meta[name="description"]');
        if (metaTag) {
            metaDesc = metaTag.getAttribute('content') || '';
        }

        let h1Text = '';
        const h1Tag = document.querySelector('h1');
        if (h1Tag) {
            h1Text = h1Tag.innerText || h1Tag.textContent || '';
        }

        if (metaDesc || h1Text) {
            try {
                chrome.runtime.sendMessage({
                    type: 'PAGE_META_INFO',
                    url: window.location.href,
                    metaDescription: metaDesc.substring(0, 500), // Cap length
                    h1Text: h1Text.substring(0, 200)
                });
            } catch (e) {
                // Ignore context invalidated
            }
        }
    }

    // Run on script load
    extractMeta();

    // Watch for SPA URL changes
    let lastUrl = window.location.href;
    new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            // Wait 1 second for the SPA to actually render the new page content/title
            setTimeout(extractMeta, 1000);
        }
    }).observe(document.body, { childList: true, subtree: true });
})();
