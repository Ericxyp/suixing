import type { ServerConfig } from '../config';
import type { AiProvider } from './ai-provider';
import { QwenAiProvider, type FetchLike } from './qwen-ai-provider';

export function createAiProvider(
  config: ServerConfig,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  timeoutMs?: number,
): AiProvider | undefined {
  if (
    !config.hasQwenAiProvider
    || !config.qwenApiKey
    || !config.qwenBaseUrl
    || !config.qwenModel
  ) {
    return undefined;
  }

  return new QwenAiProvider(
    config.qwenApiKey,
    config.qwenBaseUrl,
    config.qwenModel,
    fetchImpl,
    timeoutMs ?? config.qwenRequestTimeoutMs,
  );
}
