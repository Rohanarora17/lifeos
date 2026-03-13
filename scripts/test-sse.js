async function testSSE() {
    console.log("Connecting to SSE stream at http://localhost:3000/api/sse...");

    // Start SSE connection in background
    let sseOk = false;
    let focusStartedOk = false;
    let activitiesUpdatedOk = false;

    fetch('http://localhost:3000/api/sse').then(async res => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            console.log("[SSE Raw Chunk]:\\n", chunk);

            if (chunk.includes('event: ping')) {
                sseOk = true;
            }
            if (chunk.includes('event: focus_session_started')) {
                focusStartedOk = true;
                setTimeout(pushMockActivity, 500);
            }
            if (chunk.includes('event: activities_updated')) {
                activitiesUpdatedOk = true;
                console.log("\\n✅ All SSE verifications passed!");
                await stopFocusSession();
                process.exit(0);
            }
        }
    }).catch(err => {
        console.error("SSE Fetch Error:", err);
    });

    // Give it a second to connect, then start the test flow
    setTimeout(async () => {
        if (!sseOk) {
            console.error("❌ Failed to receive initial SSE ping.");
            process.exit(1);
        }
        await startFocusSession();
    }, 1500);
}

async function startFocusSession() {
    console.log("\\n[Test] Starting focus session...");
    const res = await fetch('http://localhost:3000/api/focus-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'start',
            goalTitle: 'Test SSE Goal',
            durationMinutes: 60
        })
    });
    const data = await res.json();
    console.log("Start response:", data);
}

async function pushMockActivity() {
    console.log("\\n[Test] Pushing mock productive activity...");
    const res = await fetch('http://localhost:3000/api/activity/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            activities: [{
                url: 'https://github.com/test/repo',
                title: 'Coding the SSE feature',
                started_at: new Date().toISOString(),
                duration_seconds: 45
            }]
        })
    });
    const data = await res.json();
    console.log("Batch response:", data);
}

async function stopFocusSession() {
    console.log("\\n[Test] Stopping focus session cleanup...");
    // Just blindly run the completion to clean up the DB
    try {
        const dbRes = await fetch('http://localhost:3000/api/focus-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'complete',
                sessionId: 1, // It might fail if ID varies, but we just want to stop active sessions
                productiveSeconds: 45,
                distractionSeconds: 0,
                activities: [],
            })
        });
    } catch (e) { }
}

testSSE();
