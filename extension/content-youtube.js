// LifeOS — YouTube Content Script
// Extracts video info and tracks actual watch time

(function () {
    let lastVideoId = null;
    let watchStartTime = null;
    let isPlaying = false;

    function extractVideoInfo() {
        const videoId = new URLSearchParams(window.location.search).get('v');
        if (!videoId) return null;

        // Get title
        const titleEl = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string')
            || document.querySelector('h1.ytd-watch-metadata yt-formatted-string')
            || document.querySelector('#title h1 yt-formatted-string')
            || document.querySelector('h1.title');
        const title = titleEl?.textContent?.trim() || document.title.replace(' - YouTube', '');

        // Get channel
        const channelEl = document.querySelector('#channel-name a')
            || document.querySelector('ytd-channel-name a')
            || document.querySelector('.ytd-video-owner-renderer #text a');
        const channel = channelEl?.textContent?.trim() || '';

        return { videoId, title, channel };
    }

    function sendVideoInfo(info) {
        if (!info) return;
        try {
            chrome.runtime.sendMessage({
                type: 'YOUTUBE_VIDEO_INFO',
                videoId: info.videoId,
                title: info.title,
                channel: info.channel,
            });
        } catch (e) { }
    }

    function monitorVideo() {
        const video = document.querySelector('video');
        if (!video) return;

        video.addEventListener('play', () => {
            isPlaying = true;
            watchStartTime = Date.now();
            const info = extractVideoInfo();
            if (info && info.videoId !== lastVideoId) {
                lastVideoId = info.videoId;
                sendVideoInfo(info);
            }
        });

        video.addEventListener('pause', () => {
            isPlaying = false;
        });

        video.addEventListener('ended', () => {
            isPlaying = false;
        });
    }

    // Observe DOM changes for SPA navigation
    const observer = new MutationObserver(() => {
        const info = extractVideoInfo();
        if (info && info.videoId !== lastVideoId) {
            lastVideoId = info.videoId;
            sendVideoInfo(info);
        }
    });

    // Wait for page to load
    function init() {
        const info = extractVideoInfo();
        if (info) {
            lastVideoId = info.videoId;
            sendVideoInfo(info);
        }
        monitorVideo();

        // Watch for navigation changes (YouTube is SPA)
        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });

        // Re-check on URL change (YouTube SPA)
        let currentUrl = window.location.href;
        setInterval(() => {
            if (window.location.href !== currentUrl) {
                currentUrl = window.location.href;
                setTimeout(() => {
                    const info = extractVideoInfo();
                    if (info && info.videoId !== lastVideoId) {
                        lastVideoId = info.videoId;
                        sendVideoInfo(info);
                        monitorVideo();
                    }
                }, 1500); // Wait for DOM to update
            }
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 1000);
    }
})();
