const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.API_KEY || "AQ.Ab8RN6IpE5hMupPrv6NJfbKinI8wINhLJTAxjUINcPRw6el-zA";
const project = 'gen-lang-client-0836312291';
const location = 'us-central1';

async function testConfig(name, config) {
    try {
        const ai = new GoogleGenAI(config);
        const res = await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: 'Hi' });
        console.log(`[SUCCESS] ${name}`);
    } catch (e) {
        console.log(`[FAILED] ${name}: ${e.message.split('\n')[0].substring(0, 150)}`);
    }
}

async function main() {
    console.log("Testing with API Key:", apiKey.substring(0, 5) + "...");

    // 1. apiKey only
    await testConfig("Just apiKey", { apiKey });

    // 2. httpOptions approach for Express Mode
    await testConfig("httpOptions", {
        apiKey,
        httpOptions: { baseUrl: `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}` }
    });

    // 3. vertexai object + apiKey
    await testConfig("vertexai object + apiKey", { vertexai: { project, location }, apiKey });

    // 4. vertexai=true, project, location + apiKey
    await testConfig("vertexai=true + project/location + apiKey", { vertexai: true, project, location, apiKey });
}

main();
