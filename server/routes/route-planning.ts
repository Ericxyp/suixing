import { Router } from 'express';
import type { Request, Response } from 'express';
import { AmapProviderError } from '../services/amap-http-client';
import type {
  AmapRouteService,
  RoutePlanningInput,
} from '../services/amap-route-service';

const INVALID_REQUEST_MESSAGE = '路线参数无效，请调整后重试。';
const UNAVAILABLE_MESSAGE = '路线服务尚未配置。';
const PROVIDER_ERROR_MESSAGE = '路线服务暂时不可用，请稍后重试。';
const PROTECTED_PARAMS = ['key', 'jscode', 'sig', 'callback'] as const;

function sendError(
  response: Response,
  status: number,
  code: AmapProviderError['code'],
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

function readSingleNumber(
  query: Request['query'],
  name: string,
  minimum: number,
  maximum: number,
): number | null {
  const value = query[name];
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseRouteInput(query: Request['query']): RoutePlanningInput | null {
  if (PROTECTED_PARAMS.some((name) => name in query)) {
    return null;
  }

  const originLongitude = readSingleNumber(query, 'originLng', -180, 180);
  const originLatitude = readSingleNumber(query, 'originLat', -90, 90);
  const destinationLongitude = readSingleNumber(
    query,
    'destinationLng',
    -180,
    180,
  );
  const destinationLatitude = readSingleNumber(
    query,
    'destinationLat',
    -90,
    90,
  );
  const mode = query.mode;

  if (
    originLongitude === null
    || originLatitude === null
    || destinationLongitude === null
    || destinationLatitude === null
    || (mode !== 'walk' && mode !== 'taxi')
  ) {
    return null;
  }

  return {
    origin: {
      longitude: originLongitude,
      latitude: originLatitude,
    },
    destination: {
      longitude: destinationLongitude,
      latitude: destinationLatitude,
    },
    mode,
  };
}

function providerErrorResponse(error: AmapProviderError): {
  status: number;
  message: string;
} {
  if (error.code === 'INVALID_REQUEST') {
    return { status: 400, message: INVALID_REQUEST_MESSAGE };
  }
  if (error.code === 'PROVIDER_UNAVAILABLE') {
    return { status: 503, message: UNAVAILABLE_MESSAGE };
  }
  return { status: 502, message: PROVIDER_ERROR_MESSAGE };
}

export function createRoutePlanningRouter(routeService?: AmapRouteService) {
  const router = Router();

  router.all('/routes', async (request, response) => {
    if (request.method !== 'GET') {
      sendError(response, 405, 'INVALID_REQUEST', '仅支持查询路线。');
      return;
    }

    if (!routeService) {
      sendError(
        response,
        503,
        'PROVIDER_UNAVAILABLE',
        UNAVAILABLE_MESSAGE,
      );
      return;
    }

    const input = parseRouteInput(request.query);
    if (!input) {
      sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      return;
    }

    try {
      const route = await routeService.plan(input);
      response.status(200).json({ data: { route } });
    } catch (error) {
      if (error instanceof AmapProviderError) {
        const mapped = providerErrorResponse(error);
        sendError(response, mapped.status, error.code, mapped.message);
        return;
      }
      sendError(response, 502, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }
  });

  return router;
}
