import { GoogleGenAI } from '@google/genai';

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';

if (!project) {
    throw new Error(
        'Vertex-only test requires GOOGLE_CLOUD_PROJECT and ADC (for example, gcloud auth application-default login).'
    );
}

const ai = new GoogleGenAI({ vertexai: true, project, location });
async function run() {
    try {
        const result = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: 'Say hi'
        });
        console.log(result.text);
    } catch (e: any) {
        console.log("Error:", e.message);
    }
}
run();
