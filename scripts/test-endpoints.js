async function testChat() {
    console.log("Testing Jarvis Chat API...");
    try {
        const payload = {
            messages: [
                { role: "user", content: "Can you create a critical priority task called 'Test Jarvis tool calling'?" }
            ]
        };

        console.log("Sending message:", payload.messages[0].content);
        const start = Date.now();
        const res = await fetch('http://localhost:3000/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        console.log(`Response (${Date.now() - start}ms):`, data.text);

        // Test querying the DB
        const payload2 = {
            messages: [
                { role: "user", content: "Can you create a critical priority task called 'Test Jarvis tool calling'?" },
                { role: "assistant", content: data.text },
                { role: "user", content: "Awesome. Can you check my tasks table and tell me the title of the task you just created? Return the raw title." }
            ]
        };
        console.log("\\nSending follow-up message:", payload2.messages[2].content);
        const start2 = Date.now();
        const res2 = await fetch('http://localhost:3000/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload2)
        });
        const data2 = await res2.json();
        console.log(`Response (${Date.now() - start2}ms):`, data2.text);

    } catch (err) {
        console.error("Test failed:", err);
    }
}

async function testLevelAPI() {
    console.log("\\nTesting GET /api/user/level...");
    try {
        const res = await fetch('http://localhost:3000/api/user/level');
        const data = await res.json();
        console.log("Level API response:", data);
    } catch (err) {
        console.error("Level API failed:", err);
    }
}

async function main() {
    // Wait for Next.js to fully start if needed
    console.log("Waiting 2 seconds for server readiness...");
    await new Promise(r => setTimeout(r, 2000));

    await testLevelAPI();
    await testChat();
}

main();
