import {
  AI_INVALID_RESPONSE_MESSAGE,
  AI_PROVIDER_ERROR_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiProviderError,
  validateAiCompletionInput,
  type AiCompletionInput,
  type AiCompletionResult,
  type AiProvider,
} from './ai-provider';

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 60_000;
const CHAT_COMPLETIONS_PATH = '/chat/completions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCompletionContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return null;
  }
  for (const choice of payload.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) {
      continue;
    }
    const content = choice.message.content;
    if (typeof content === 'string' && content.trim() !== '') {
      return content;
    }
  }
  return null;
}

export class QwenAiProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async complete(
    input: AiCompletionInput,
    options?: { signal?: AbortSignal },
  ): Promise<AiCompletionResult> {
    const validated = validateAiCompletionInput(input);
    if (this.apiKey.trim() === '' || this.baseUrl.trim() === '' || this.model.trim() === '') {
      throw new AiProviderError('AI_PROVIDER_UNAVAILABLE', AI_UNAVAILABLE_MESSAGE);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: validated.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
    };
    if (validated.temperature !== undefined) {
      body.temperature = validated.temperature;
    }
    if (validated.maxOutputTokens !== undefined) {
      body.max_tokens = validated.maxOutputTokens;
    }
    if (validated.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: validated.jsonSchema.name,
          strict: validated.jsonSchema.strict ?? true,
          schema: validated.jsonSchema.schema,
        },
      };
    }
    if (validated.enableThinking !== undefined) {
      body.enable_thinking = validated.enableThinking;
    }

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onParentAbort, { once: true });
    if (options?.signal?.aborted) {
      throw new AiProviderError('AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE);
    }
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch {
        throw new AiProviderError('AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE);
      }

      const status = response.status;
      if (status >= 300 && status < 400) {
        throw new AiProviderError('AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE);
      }
      if (!response.ok) {
        throw new AiProviderError('AI_PROVIDER_ERROR', AI_PROVIDER_ERROR_MESSAGE);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AiProviderError('AI_INVALID_RESPONSE', AI_INVALID_RESPONSE_MESSAGE);
      }

      const content = readCompletionContent(payload);
      if (content === null) {
        throw new AiProviderError('AI_INVALID_RESPONSE', AI_INVALID_RESPONSE_MESSAGE);
      }
      return { content };
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onParentAbort);
    }
  }
}
