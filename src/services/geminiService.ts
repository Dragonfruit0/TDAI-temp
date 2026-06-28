import { UIVariant, UsageMetadata, DesignSuggestion } from "../types.ts";

export interface GenerationResult<T> {
  data: T;
  usage: UsageMetadata;
}

async function apiCall<T>(endpoint: string, body: Record<string, unknown>): Promise<GenerationResult<T>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(err.error || `API request failed: ${response.status}`);
  }

  return response.json();
}

export async function generateFollowUpQuestions(prompt: string): Promise<GenerationResult<string[]>> {
  return apiCall<string[]>('/api/ai/follow-up-questions', { prompt });
}

export async function generateUIVariants(prompt: string, questions: string[] = [], answers: string[] = []): Promise<GenerationResult<UIVariant[]>> {
  return apiCall<UIVariant[]>('/api/ai/generate-variants', { prompt, questions, answers });
}

export const modifyUI = async (currentHtml: string, prompt: string): Promise<GenerationResult<string>> => {
  return apiCall<string>('/api/ai/modify-ui', { currentHtml, prompt });
};

export async function generateDesignSuggestions(currentHtml: string): Promise<GenerationResult<DesignSuggestion[]>> {
  return apiCall<DesignSuggestion[]>('/api/ai/design-suggestions', { currentHtml });
}

export async function generateVectorAsset(prompt: string): Promise<GenerationResult<string>> {
  return apiCall<string>('/api/ai/generate-vector', { prompt });
}
