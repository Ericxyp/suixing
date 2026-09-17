export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AiCompletionInput {
  messages: readonly AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  jsonSchema?: AiJsonSchema;
  enableThinking?: boolean;
}

export interface AiCompletionResult {
  content: string;
}

export interface AiProvider {
  complete(
    input: AiCompletionInput,
    options?: { signal?: AbortSignal },
  ): Promise<AiCompletionResult>;
}

export type AiProviderErrorCode =
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_INVALID_REQUEST'
  | 'AI_PROVIDER_ERROR'
  | 'AI_INVALID_RESPONSE';

export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export const AI_UNAVAILABLE_MESSAGE = '智能服务尚未配置。';
export const AI_INVALID_REQUEST_MESSAGE = '智能请求无效，请调整后重试。';
export const AI_PROVIDER_ERROR_MESSAGE = '智能服务暂时不可用，请稍后重试。';
export const AI_INVALID_RESPONSE_MESSAGE = '智能服务返回结果无效。';

const ROLES = new Set<AiMessageRole>(['system', 'user', 'assistant']);
const MAX_MESSAGES = 32;
const MAX_CONTENT_LENGTH = 8_000;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const MIN_OUTPUT_TOKENS = 1;
const MAX_OUTPUT_TOKENS = 8_192;
const JSON_SCHEMA_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_JSON_SCHEMA_TEXT = 8_000;
const MAX_JSON_SCHEMA_DEPTH = 12;
const MAX_JSON_SCHEMA_NODES = 120;
const MAX_JSON_SCHEMA_STRING = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateJsonSchemaValue(
  value: unknown,
  depth: number,
  stats: { nodes: number },
): void {
  stats.nodes += 1;
  if (
    depth > MAX_JSON_SCHEMA_DEPTH
    || stats.nodes > MAX_JSON_SCHEMA_NODES
    || typeof value === 'function'
    || typeof value === 'undefined'
    || typeof value === 'bigint'
    || typeof value === 'symbol'
  ) {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }
  if (typeof value === 'string') {
    if (
      value.length > MAX_JSON_SCHEMA_STRING
      || /https?:\/\//i.test(value)
    ) {
      throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonSchemaValue(item, depth + 1, stats);
    }
    return;
  }
  if (!isRecord(value)) {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      key === 'tools'
      || key === 'functions'
      || key === 'headers'
      || key.length > MAX_JSON_SCHEMA_STRING
    ) {
      throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
    }
    validateJsonSchemaValue(nested, depth + 1, stats);
  }
}

function validateJsonSchema(schema: AiJsonSchema): AiJsonSchema {
  if (
    typeof schema.name !== 'string'
    || !JSON_SCHEMA_NAME_PATTERN.test(schema.name)
    || (schema.strict !== undefined && typeof schema.strict !== 'boolean')
    || !isRecord(schema.schema)
  ) {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(schema.schema);
  } catch {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }
  if (
    serialized.length > MAX_JSON_SCHEMA_TEXT
    || /https?:\/\//i.test(serialized)
  ) {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }

  validateJsonSchemaValue(schema.schema, 0, { nodes: 0 });
  return {
    name: schema.name,
    strict: schema.strict,
    schema: structuredClone(schema.schema),
  };
}

export function validateAiCompletionInput(
  input: AiCompletionInput,
): AiCompletionInput {
  if (!input || !Array.isArray(input.messages) || input.messages.length === 0) {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }
  if (input.messages.length > MAX_MESSAGES) {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }

  const messages = input.messages.map((message) => {
    if (
      !message
      || !ROLES.has(message.role)
      || typeof message.content !== 'string'
      || message.content.trim() === ''
      || message.content.length > MAX_CONTENT_LENGTH
    ) {
      throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
    }
    return {
      role: message.role,
      content: message.content,
    };
  });

  if (input.temperature !== undefined) {
    if (
      typeof input.temperature !== 'number'
      || !Number.isFinite(input.temperature)
      || input.temperature < MIN_TEMPERATURE
      || input.temperature > MAX_TEMPERATURE
    ) {
      throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
    }
  }

  if (input.maxOutputTokens !== undefined) {
    if (
      typeof input.maxOutputTokens !== 'number'
      || !Number.isInteger(input.maxOutputTokens)
      || input.maxOutputTokens < MIN_OUTPUT_TOKENS
      || input.maxOutputTokens > MAX_OUTPUT_TOKENS
    ) {
      throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
    }
  }

  if (input.enableThinking !== undefined && typeof input.enableThinking !== 'boolean') {
    throw new AiProviderError('AI_INVALID_REQUEST', AI_INVALID_REQUEST_MESSAGE);
  }

  return {
    messages,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    jsonSchema: input.jsonSchema === undefined
      ? undefined
      : validateJsonSchema(input.jsonSchema),
    enableThinking: input.enableThinking,
  };
}
