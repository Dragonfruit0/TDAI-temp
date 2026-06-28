import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getGeminiClient, callOpenRouter, cleanJsonString, Type } from '../_lib/ai';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { currentHtml } = req.body;
  if (!currentHtml) { res.status(400).json({ error: 'Missing currentHtml' }); return; }

  const systemInstruction = `
    You are an expert design critic and UI/UX consultant.
    Analyze the provided HTML/Tailwind CSS code and suggest 3-4 specific improvements.
    Focus on: visual hierarchy, color harmony, typography, interaction design, consistency, mobile responsiveness.
    For each suggestion provide: title, description (the "why"), action (a specific command for an AI redesigner).
    Return a JSON array of objects.
  `.trim();

  const ai = getGeminiClient();
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Current HTML code:\n\n${currentHtml}`,
        config: {
          systemInstruction,
          temperature: 0.7,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                action: { type: Type.STRING }
              },
              required: ['title', 'description', 'action']
            }
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
        const parsedData = JSON.parse(jsonText.trim());
        const suggestions = parsedData.map((s: any, i: number) => ({ ...s, id: `suggestion-${Date.now()}-${i}` }));
        res.json({ data: suggestions, usage });
        return;
      }
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, `Current HTML code:\n\n${currentHtml}`, true);
    const cleaned = cleanJsonString(text);
    const parsedData = JSON.parse(cleaned);
    const rawSuggestions = Array.isArray(parsedData) ? parsedData : (parsedData.suggestions || parsedData.data || []);
    const suggestions = rawSuggestions.map((s: any, i: number) => ({ ...s, id: `suggestion-${Date.now()}-${i}` }));
    res.json({ data: suggestions, usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
