const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.API_KEY || "AQ.Ab8RN6IpE5hMupPrv6NJfbKinI8wINhLJTAxjUINcPRw6el-zA";
const project = 'gen-lang-client-0836312291';
const location = 'us-central1';

async function testModel(modelName) {
    try {
        const ai = new GoogleGenAI({ vertexai: { project, location }, apiKey });
        const res = await ai.models.generateContent({ model: modelName, contents: 'Hi' });
        console.log(`[SUCCESS] ${modelName}:`, res.text.substring(0, 20).replace(/\n/g, ""));
    } catch (e) {
        console.log(`[FAILED] ${modelName}:`, e.message.split('\n')[0].substring(0, 200));
    }
}

async function main() {
    console.log("Testing Vertex AI Express Auth with different model names...");
    await testModel('gemini-1.5-flash');
    await testModel('gemini-1.5-flash-002');
    await testModel('gemini-1.5-pro');
    await testModel('gemini-2.5-pro-exp');
    await testModel('gemini-2.5-pro');
    await testModel('gemini-flash-latest');
    await testModel('gemini-pro-latest');
    await testModel('gemini-1.5-flash-latest');
    await testModel('gemini-1.5-pro-latest');
}

main();
