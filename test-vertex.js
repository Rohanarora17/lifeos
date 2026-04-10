const { GoogleGenAI } = require('@google/genai');

const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GCP_LOCATION || 'us-central1';
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

async function testConfig(name, config) {
    try {
        const ai = new GoogleGenAI(config);
        const res = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'Hi' });
        console.log(`[SUCCESS] ${name}`);
    } catch (e) {
        console.log(`[FAILED] ${name}: ${e.message.split('\n')[0].substring(0, 150)}`);
    }
}

async function main() {
    if (!project || !credentialsPath) {
        throw new Error(
            'Vertex-only test requires GOOGLE_CLOUD_PROJECT (or GCP_PROJECT_ID) and GOOGLE_APPLICATION_CREDENTIALS.'
        );
    }

    await testConfig('vertexai=true + project/location', { vertexai: true, project, location });
}

main();
