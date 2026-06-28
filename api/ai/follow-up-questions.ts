import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getGeminiClient, callOpenRouter, cleanJsonString, Type } from '../_lib/ai';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { prompt: userPrompt } = req.body;
  if (!userPrompt) { res.status(400).json({ error: 'Missing prompt' }); return; }

  const systemInstruction = `
    You are an expert product manager and UX researcher.
    The user wants to build a design based on their prompt.
    Ask exactly 5 clarifying questions covering target audience, color scheme, features, typography, animations.
    Return a JSON array of exactly 5 strings.
  `.trim();

  const ai = getGeminiClient();
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `User prompt: ${userPrompt}`,
        config: {
          systemInstruction,
          temperature: 0.7,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      });

      const jsonText = response.text;
      if (jsonText) {
        const usage = {
          promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokenCount: response.usageMetadata?.totalTokenCount || 0
        };
        res.json({ data: JSON.parse(jsonText.trim()), usage });
        return;
      }
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, `User prompt: ${userPrompt}`, true);
    const cleaned = cleanJsonString(text);
    res.json({ data: JSON.parse(cleaned), usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
