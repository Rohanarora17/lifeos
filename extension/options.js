document.addEventListener('DOMContentLoaded', () => {
    // Load existing key
    chrome.storage.local.get('apiKey', (data) => {
        if (data.apiKey) {
            document.getElementById('apiKey').value = data.apiKey;
        }
    });

    // Save key
    document.getElementById('saveBtn').addEventListener('click', () => {
        const key = document.getElementById('apiKey').value.trim();
        chrome.storage.local.set({ apiKey: key }, () => {
            const status = document.getElementById('status');
            status.style.display = 'block';
            setTimeout(() => {
                status.style.display = 'none';
            }, 2000);
        });
    });
});
