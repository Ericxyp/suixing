import { Router } from 'express';
import type { Request, Response } from 'express';
import type { RequirementExtractionResult } from '../../src/domain/trip/ai';
import {
  AI_INVALID_REQUEST_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AI_PROVIDER_ERROR_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiProviderError,
} from '../services/ai-provider';
import type { TripRequirementExtractor } from '../services/trip-requirement-extractor';

const MAX_INPUT_LENGTH = 2_000;
const INVALID_REQUEST_MESSAGE = '旅行需求无效，请调整后重试。';
const UNSUPPORTED_TYPE_MESSAGE = '请使用 JSON 提交旅行需求。';
const METHOD_MESSAGE = '仅支持提取旅行需求。';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonContentType(value: string | undefined): boolean {
  const mediaType = value?.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function readExtractInput(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'input' || typeof body.input !== 'string') {
    return null;
  }
  if (body.input.trim() === '' || body.input.length > MAX_INPUT_LENGTH) {
    return null;
  }
  return body.input;
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

export function createAiRequirementsRouter(
  extractor?: TripRequirementExtractor,
): Router {
  const router = Router();

  router.all('/ai/requirements/extract', async (request: Request, response: Response) => {
    if (request.method !== 'POST') {
      sendError(response, 405, 'INVALID_REQUEST', METHOD_MESSAGE);
      return;
    }

    if (!isJsonContentType(request.headers['content-type'])) {
      sendError(response, 415, 'INVALID_REQUEST', UNSUPPORTED_TYPE_MESSAGE);
      return;
    }

    const input = readExtractInput(request.body);
    if (input === null) {
      sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      return;
    }

    if (!extractor) {
      sendError(response, 503, 'AI_PROVIDER_UNAVAILABLE', AI_UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      const data: RequirementExtractionResult = await extractor.extract(input);
      response.status(200).json({ data });
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
