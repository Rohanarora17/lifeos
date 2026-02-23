// Simple health check mechanism
const iframe = document.getElementById('lifeos-frame');
const errorScreen = document.getElementById('error-screen');

async function checkHealth() {
    try {
        const res = await fetch('http://localhost:3000/api/dashboard');
        if (res.ok) {
            iframe.style.display = 'block';
            errorScreen.classList.remove('visible');
        } else {
            throw new Error('Not ok');
        }
    } catch (e) {
        iframe.style.display = 'none';
        errorScreen.classList.add('visible');
    }
}

// Initial check
checkHealth();

// Refresh frame on focus if there was an error
window.addEventListener('focus', () => {
    if (errorScreen.classList.contains('visible')) {
        checkHealth();
        iframe.src = iframe.src; // Reload
    }
});
