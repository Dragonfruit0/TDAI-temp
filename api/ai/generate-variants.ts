import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getGeminiClient, callOpenRouter, cleanJsonString, Type } from '../_lib/ai';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { prompt, questions, answers } = req.body;
  if (!prompt) { res.status(400).json({ error: 'Missing prompt' }); return; }

  const systemInstruction = `
    You are Flash UI, a master UI/UX designer and world-class frontend engineer.
    Your mission is to generate THREE RADICAL CONCEPTUAL VARIATIONS for the user's prompt.
    The user might request a UI, a poster, a logo, or any other visual layout. Adapt your HTML/Tailwind output to perfectly suit the requested medium.

    **STRICT IP SAFEGUARD:**
    - Never use names of artists, movies, or brands.
    - Instead, describe the "Physicality" and "Material Logic" of the UI.

    **VISUAL EXECUTION RULES:**
    1. **Materiality**: Use physical metaphors to drive every CSS choice.
    2. **Typography**: Use high-quality web fonts (Inter, Geist, or system-ui). Pair a bold sans-serif with a refined monospace for data/labels.
    3. **Motion**: Include subtle, high-performance CSS animations (hover transitions, entry reveals, smooth staggered animations).
    4. **Layout**: Be bold with negative space and hierarchy. **AVOID GENERIC CARDS.** Use asymmetrical grids, suspended kinetic mobile elements, or fluid rectilinear structures.
    5. **Tailwind Only**: Output clean, accessible Tailwind CSS. For posters/logos, use absolute positioning, CSS grid, or SVG elements inline within the HTML. Ensure components are responsive.

    **OUTPUT FORMAT:**
    Return a JSON array of exactly 3 objects.
    Each object must have:
    - 'label': A unique design persona name based on a NEW physical metaphor.
    - 'html': The raw HTML string with Tailwind classes.
    - 'description': A one-sentence explanation describing the material logic and design persona.
  `.trim();

  const contents: string[] = [`Generate 3 design variations for: ${prompt}`];
  if (answers?.length > 0 && questions?.length > 0) {
    contents.push(`\n\nUser's answers to clarifying questions:\n${questions.map((q: string, i: number) => `Q: ${q}\nA: ${answers[i]}`).join('\n\n')}`);
  }
  const promptContent = contents.join('\n');

  const ai = getGeminiClient();
  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [promptContent],
        config: {
          systemInstruction,
          temperature: 1.0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                html: { type: Type.STRING },
                description: { type: Type.STRING }
              },
              required: ['label', 'html', 'description']
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
        const variants = parsedData.map((v: any, i: number) => ({ ...v, id: `variant-${Date.now()}-${i}` }));
        res.json({ data: variants, usage });
        return;
      }
    } catch (error) {
      console.warn('Primary Gemini API failed, attempting OpenRouter fallback...', error);
    }
  }

  try {
    const { text, usage } = await callOpenRouter(systemInstruction, promptContent, true);
    const cleaned = cleanJsonString(text);
    const parsedData = JSON.parse(cleaned);
    const rawVariants = Array.isArray(parsedData) ? parsedData : (parsedData.variants || parsedData.data || []);
    const variants = rawVariants.map((v: any, i: number) => ({ ...v, id: `variant-${Date.now()}-${i}` }));
    res.json({ data: variants, usage });
  } catch (err: any) {
    console.error('AI generation failed:', err);
    res.status(500).json({ error: err.message });
  }
}
