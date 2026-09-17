import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AI_INVALID_REQUEST_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AI_PROVIDER_ERROR_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiProviderError,
} from '../services/ai-provider';
import {
  parseTripChangeInterpretBody,
  type TripChangeIntentExtractor,
} from '../services/trip-change-intent-extractor';

const INVALID_REQUEST_MESSAGE = '行程修改请求无效，请调整后重试。';
const UNSUPPORTED_TYPE_MESSAGE = '请使用 JSON 提交行程修改意图。';
const METHOD_MESSAGE = '仅支持理解行程修改意图。';
const INTERNAL_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';

type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AI_INVALID_REQUEST'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_PROVIDER_ERROR'
  | 'AI_INVALID_RESPONSE'
  | 'INTERNAL_ERROR';

function sendError(
  response: Response,
  status: number,
  code: ErrorCode,
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

function isJsonContentType(value: string | undefined): boolean {
  const mediaType = value?.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function statusForAiError(code: AiProviderError['code']): number {
  if (code === 'AI_INVALID_REQUEST') {
    return 400;
  }
  if (code === 'AI_PROVIDER_UNAVAILABLE') {
    return 503;
  }
  return 502;
}

function messageForAiError(code: AiProviderError['code']): string {
  if (code === 'AI_INVALID_REQUEST') {
    return AI_INVALID_REQUEST_MESSAGE;
  }
  if (code === 'AI_PROVIDER_UNAVAILABLE') {
    return AI_UNAVAILABLE_MESSAGE;
  }
  if (code === 'AI_INVALID_RESPONSE') {
    return AI_INVALID_RESPONSE_MESSAGE;
  }
  return AI_PROVIDER_ERROR_MESSAGE;
}

export function createAiTripChangeInterpretRouter(
  extractor?: TripChangeIntentExtractor,
): Router {
  const router = Router();

  router.all('/ai/trips/change/interpret', async (request: Request, response: Response) => {
    if (request.method !== 'POST') {
      sendError(response, 405, 'INVALID_REQUEST', METHOD_MESSAGE);
      return;
    }

    if (!isJsonContentType(request.headers['content-type'])) {
      sendError(response, 415, 'INVALID_REQUEST', UNSUPPORTED_TYPE_MESSAGE);
      return;
    }

    const parsed = parseTripChangeInterpretBody(request.body);
    if (!parsed) {
      sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      return;
    }

    if (!extractor) {
      sendError(response, 503, 'AI_PROVIDER_UNAVAILABLE', AI_UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      const intent = await extractor.interpret(parsed.input, parsed.context);
      response.status(200).json({ data: { intent } });
    } catch (error) {
      if (error instanceof AiProviderError) {
        sendError(
          response,
          statusForAiError(error.code),
          error.code,
          messageForAiError(error.code),
        );
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
    }
  });

  return router;
}
