import { Router } from 'express';
import type { Request, Response } from 'express';
import { AmapProviderError } from '../services/amap-http-client';
import {
  parseProviderPlaceId,
  type AmapPlaceService,
} from '../services/amap-place-service';

const INVALID_REQUEST_MESSAGE = '地点编号无效，请调整后重试。';
const UNAVAILABLE_MESSAGE = '地点服务尚未配置。';
const PROVIDER_ERROR_MESSAGE = '地点服务暂时不可用，请稍后重试。';
const PROTECTED_PARAMS = ['key', 'jscode', 'sig', 'callback', 'url', 'target'] as const;

function sendError(
  response: Response,
  status: number,
  code: 'INVALID_REQUEST' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR',
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

function statusForProviderError(code: AmapProviderError['code']): number {
  if (code === 'INVALID_REQUEST') {
    return 400;
  }
  if (code === 'PROVIDER_UNAVAILABLE') {
    return 503;
  }
  return 502;
}

function hasProtectedQuery(query: Request['query']): boolean {
  return PROTECTED_PARAMS.some((name) => name in query);
}

function readPathId(path: string): string | null {
  const match = path.match(/^\/places\/(.+)$/);
  if (!match) {
    return null;
  }
  let raw: string;
  try {
    raw = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return parseProviderPlaceId(raw);
}

export function createPlaceDetailRouter(placeService?: AmapPlaceService) {
  const router = Router();

  router.use(async (request, response, next) => {
    if (
      !request.path.startsWith('/places/')
      || request.path === '/places/search'
      || request.path.startsWith('/places/search/')
    ) {
      next();
      return;
    }

    if (request.method !== 'GET') {
      sendError(response, 405, 'INVALID_REQUEST', '仅支持查询地点详情。');
      return;
    }

    const providerPlaceId = readPathId(request.path);
    if (hasProtectedQuery(request.query) || providerPlaceId === null) {
      sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      return;
    }

    if (!placeService) {
      sendError(response, 503, 'PROVIDER_UNAVAILABLE', UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      const place = await placeService.getByProviderPlaceId(providerPlaceId);
      response.status(200).json({ data: { place } });
    } catch (error) {
      if (error instanceof AmapProviderError) {
        sendError(
          response,
          statusForProviderError(error.code),
          error.code,
          error.message,
        );
        return;
      }
      sendError(response, 502, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }
  });

  return router;
}
