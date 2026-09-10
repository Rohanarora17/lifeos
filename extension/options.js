document.addEventListener('DOMContentLoaded', async () => {
    const apiBase = await LifeOSServerConfig.loadApiBase(chrome.storage.local);
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
        document.getElementById('apiUrl').value = apiBase;
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
        let url = LifeOSServerConfig.normalizeApiBase(document.getElementById('apiUrl').value);
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
