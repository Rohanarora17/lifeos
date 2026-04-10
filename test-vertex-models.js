const { GoogleGenAI } = require('@google/genai');

const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GCP_LOCATION || 'us-central1';
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

async function testModel(modelName) {
    try {
        const ai = new GoogleGenAI({ vertexai: true, project, location });
        const res = await ai.models.generateContent({ model: modelName, contents: 'Hi' });
        console.log(`[SUCCESS] ${modelName}:`, res.text.substring(0, 20).replace(/\n/g, ""));
    } catch (e) {
        console.log(`[FAILED] ${modelName}:`, e.message.split('\n')[0].substring(0, 200));
    }
}

async function main() {
    if (!project || !credentialsPath) {
        throw new Error(
            'Vertex-only test requires GOOGLE_CLOUD_PROJECT (or GCP_PROJECT_ID) and GOOGLE_APPLICATION_CREDENTIALS.'
        );
    }

    console.log("Testing Vertex AI OAuth auth with different model names...");
    await testModel('gemini-2.5-flash');
    await testModel('gemini-2.5-pro');
}

main();
