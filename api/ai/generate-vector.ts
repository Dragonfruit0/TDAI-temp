import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getGeminiClient, callOpenRouter } from '../_lib/ai';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { prompt: userPrompt } = req.body;
  if (!userPrompt) { res.status(400).json({ error: 'Missing prompt' }); return; }

  const systemInstruction = `
    You are an expert SVG artist and visual designer.
    Generate highly polished, modern, responsive raw SVG code based on the user's suggestion.
    Guidelines:
    1. Return ONLY the raw valid SVG string. No markdown blocks. Must start with "<svg" and end with "</svg>".
    2. Use viewBox, do NOT specify fixed width/height.
    3. Use stunning vector art: layered elements, glow effects, smooth paths, gradients.
    4. Safe: No external fonts or images.
  `.trim();

  const ai = getGeminiClient();
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Generate visual vector asset / illustration of: ${userPrompt}`,
        config: { systemInstruction, temperature: 0.8 }
      });

      let svg = response.text || '';
      svg = svg.replace(/```xml\n?/g, '').replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
      const usage = {
        promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
        totalTokenCount: response.usageMetadata?.totalTokenCount || 0
      };
      res.json({ data: svg, usage });
      return;
    } catch (error) {
      console.warn('Primary Gemini API failed for SVG, attempting fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, `Generate visual vector asset / illustration of: ${userPrompt}`, false);
    let svg = text || '';
    svg = svg.replace(/```xml\n?/g, '').replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
    res.json({ data: svg, usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
