import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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
