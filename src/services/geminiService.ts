import { UIVariant, UsageMetadata, DesignSuggestion } from "../types.ts";

export interface GenerationResult<T> {
  data: T;
  usage: UsageMetadata;
}

const EMPTY_USAGE: UsageMetadata = {
  promptTokenCount: 0,
  candidatesTokenCount: 0,
  totalTokenCount: 0,
};

async function callApi<T>(
  path: string,
  body: Record<string, unknown>
): Promise<GenerationResult<T>> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Request failed with status ${res.status}`);
  }
  const json = await res.json();
  return { data: json.data, usage: json.usage ?? EMPTY_USAGE };
}

export async function generateFollowUpQuestions(
  prompt: string
): Promise<GenerationResult<string[]>> {
  return callApi<string[]>("/api/ai/follow-up-questions", { prompt });
}

export async function generateUIVariants(
  prompt: string,
  questions: string[] = [],
  answers: string[] = []
): Promise<GenerationResult<UIVariant[]>> {
  return callApi<UIVariant[]>("/api/ai/generate-variants", {
    prompt,
    questions,
    answers,
  });
}

export const modifyUI = async (
  currentHtml: string,
  prompt: string
): Promise<GenerationResult<string>> => {
  return callApi<string>("/api/ai/modify-ui", { currentHtml, prompt });
};

export async function generateDesignSuggestions(
  currentHtml: string
): Promise<GenerationResult<DesignSuggestion[]>> {
  return callApi<DesignSuggestion[]>("/api/ai/design-suggestions", {
    currentHtml,
  });
}

export async function generateVectorAsset(
  prompt: string
): Promise<GenerationResult<string>> {
  return callApi<string>("/api/ai/generate-vector", { prompt });
}
