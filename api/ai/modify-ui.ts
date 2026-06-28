import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getGeminiClient, callOpenRouter } from '../_lib/ai';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { currentHtml, prompt: userPrompt } = req.body;
  if (!currentHtml || !userPrompt) { res.status(400).json({ error: 'Missing currentHtml or prompt' }); return; }

  const sysInstruction = `You are an expert UI/UX developer and design master.`;
  const promptContent = `CURRENT HTML (Inner content of <body>):
${currentHtml}

USER REQUEST:
${userPrompt}

Task: Update the HTML based on the user request while maintaining high-fidelity design standards.
Rules:
1. Return ONLY the updated inner HTML that should go inside the <body> tag.
2. Do NOT include <html>, <head>, or <body> tags.
3. Use Tailwind CSS classes for all styling.
4. **IP SAFEGUARD**: Do not use brand or artist names.
5. **Material Logic**: Maintain the physical metaphors already present in the design or requested.
6. Return the raw HTML string only without markdown fences.`;

  const ai = getGeminiClient();
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `${sysInstruction}\n\n${promptContent}`,
        config: { temperature: 0.2 }
      });

      let html = response.text || '';
      html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '');
      const usage = {
        promptTokenCount: response.usageMetadata?.promptTokenCount || 0,
        candidatesTokenCount: response.usageMetadata?.candidatesTokenCount || 0,
        totalTokenCount: response.usageMetadata?.totalTokenCount || 0
      };
      res.json({ data: html, usage });
      return;
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(sysInstruction, promptContent, false);
    let html = text || '';
    html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '');
    res.json({ data: html, usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
