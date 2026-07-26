document.addEventListener('DOMContentLoaded', () => {
    // Load existing key and url
    chrome.storage.local.get([
        'apiKey',
        'apiUrl',
        'deviceName',
        'trackingWakeHour',
        'trackingSleepHour',
    ], (data) => {
        if (data.apiKey) {
            document.getElementById('apiKey').value = data.apiKey;
        }
        if (data.apiUrl) {
            document.getElementById('apiUrl').value = data.apiUrl;
        } else {
            // Default value
            document.getElementById('apiUrl').value = 'http://localhost:3000/api';
        }
        if (data.deviceName) {
            document.getElementById('deviceName').value = data.deviceName;
        } else {
            document.getElementById('deviceName').value = 'MacBook';
        }
        document.getElementById('trackingWakeHour').value = data.trackingWakeHour ?? 7;
        document.getElementById('trackingSleepHour').value = data.trackingSleepHour ?? 1;
    });

    // Save settings
    document.getElementById('saveBtn').addEventListener('click', () => {
        const key = document.getElementById('apiKey').value.trim();
        let url = document.getElementById('apiUrl').value.trim() || 'http://localhost:3000/api';
        let device = document.getElementById('deviceName').value.trim() || 'MacBook';
        const trackingWakeHour = Math.min(
            23,
            Math.max(0, Number(document.getElementById('trackingWakeHour').value) || 0),
        );
        const trackingSleepHour = Math.min(
            23,
            Math.max(0, Number(document.getElementById('trackingSleepHour').value) || 0),
        );

        // Strip trailing slash if present to prevent double slashes
        if (url.endsWith('/')) url = url.slice(0, -1);
        if (url.endsWith('/api') === false && url.endsWith(':3000')) {
            url = url + '/api';
        }

        chrome.storage.local.set({
            apiKey: key,
            apiUrl: url,
            deviceName: device,
            trackingWakeHour,
            trackingSleepHour,
        }, () => {
            const status = document.getElementById('status');
            status.style.display = 'block';
            setTimeout(() => {
                status.style.display = 'none';
            }, 2000);
        });
    });
});
