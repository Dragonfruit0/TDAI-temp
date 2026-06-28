import { GoogleGenAI, Type } from '@google/genai';

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

export async function callOpenRouter(systemInstruction: string, prompt: string, isJson: boolean) {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    throw new Error('Both GEMINI_API_KEY and OPENROUTER_API_KEY fallback are missing.');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openRouterKey}`,
      'X-Title': 'TheDesignAI'
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt }
      ],
      temperature: isJson ? 0.7 : 0.2,
      response_format: isJson ? { type: 'json_object' } : undefined
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  const usage: UsageMetadata = {
    promptTokenCount: data.usage?.prompt_tokens || 0,
    candidatesTokenCount: data.usage?.completion_tokens || 0,
    totalTokenCount: data.usage?.total_tokens || 0
  };

  return { text, usage };
}

export function cleanJsonString(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  }
  return cleaned.trim();
}

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

export { Type };
