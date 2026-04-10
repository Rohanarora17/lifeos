import { GoogleGenAI } from '@google/genai';

const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GCP_LOCATION || 'us-central1';
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!project || !credentialsPath) {
    throw new Error(
        'Vertex-only test requires GOOGLE_CLOUD_PROJECT (or GCP_PROJECT_ID) and GOOGLE_APPLICATION_CREDENTIALS.'
    );
}

const ai = new GoogleGenAI({ vertexai: true, project, location });
async function run() {
    try {
        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: 'Say hi'
        });
        console.log(result.text);
    } catch (e: any) {
        console.log("Error:", e.message);
    }
}
run();
