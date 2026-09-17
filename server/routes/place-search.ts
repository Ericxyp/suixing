import { Router } from 'express';
import type { Request, Response } from 'express';
import { AmapProviderError } from '../services/amap-http-client';
import type { AmapPlaceService, PlaceSearchInput } from '../services/amap-place-service';

const MAX_TEXT_LENGTH = 100;
const DEFAULT_LIMIT = 10;

const INVALID_REQUEST_MESSAGE = '搜索条件无效，请调整后重试。';
const UNAVAILABLE_MESSAGE = '地点服务尚未配置。';
const PROVIDER_ERROR_MESSAGE = '地点服务暂时不可用，请稍后重试。';

function sendError(
  response: Response,
  status: number,
  code: 'INVALID_REQUEST' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR',
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

function readSingleText(
  query: Request['query'],
  name: string,
): string | undefined | 'invalid' {
  if (!(name in query)) {
    return undefined;
  }
  const value = query[name];
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    return 'invalid';
  }
  return value;
}

function parseLimit(query: Request['query']): number | 'invalid' {
  if (!('limit' in query)) {
    return DEFAULT_LIMIT;
  }
  const value = query.limit;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return 'invalid';
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return 'invalid';
  }
  return limit;
}

function parseSearchInput(query: Request['query']): PlaceSearchInput | 'invalid' {
  const queryText = readSingleText(query, 'query');
  if (queryText === 'invalid' || queryText === undefined || queryText.trim() === '') {
    return 'invalid';
  }

  const cityText = readSingleText(query, 'city');
  if (cityText === 'invalid') {
    return 'invalid';
  }

  const limit = parseLimit(query);
  if (limit === 'invalid') {
    return 'invalid';
  }

  const input: PlaceSearchInput = {
    query: queryText.trim(),
    limit,
  };
  const city = cityText?.trim();
  if (city) {
    input.city = city;
  }
  return input;
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

export function createPlaceSearchRouter(placeSearchService?: AmapPlaceService) {
  const router = Router();

  router.all('/places/search', async (request, response) => {
    if (request.method !== 'GET') {
      sendError(response, 405, 'INVALID_REQUEST', '仅支持搜索地点。');
      return;
    }

    if (!placeSearchService) {
      sendError(response, 503, 'PROVIDER_UNAVAILABLE', UNAVAILABLE_MESSAGE);
      return;
    }

    const input = parseSearchInput(request.query);
    if (input === 'invalid') {
      sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      return;
    }

    try {
      const places = await placeSearchService.search(input);
      response.status(200).json({ data: { places } });
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
