import { Router } from 'express';
import type { Request, Response } from 'express';
import { AmapProviderError } from '../services/amap-http-client';
import type { PlaceSearchService } from '../services/trip-place-resolver';
import { parseMealOptionsBody } from '../services/trip-meal-options-request';
import { searchMealDiningPlaces } from '../services/trip-meal-options';

const INVALID_REQUEST_MESSAGE = '餐饮查询条件无效，请调整后重试。';
const UNAVAILABLE_MESSAGE = '地点服务尚未配置。';
const PROVIDER_ERROR_MESSAGE = '地点服务暂时不可用，请稍后重试。';
const METHOD_MESSAGE = '仅支持查询餐饮选项。';

function sendError(
  response: Response,
  status: number,
  code: 'INVALID_REQUEST' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR',
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

export function createTripMealOptionsRouter(placeSearch?: PlaceSearchService): Router {
  const router = Router();
  router.all('/trips/meal-options', async (request: Request, response: Response) => {
    if (request.method !== 'POST') {
      sendError(response, 405, 'INVALID_REQUEST', METHOD_MESSAGE);
      return;
    }
    const parsed = parseMealOptionsBody(request.body);
    if (!parsed) {
      sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      return;
    }
    if (!placeSearch) {
      sendError(response, 503, 'PROVIDER_UNAVAILABLE', UNAVAILABLE_MESSAGE);
      return;
    }
    try {
      const places = await searchMealDiningPlaces({
        city: parsed.city,
        mealPeriod: parsed.mealPeriod,
        area: {
          id: parsed.area.placeId,
          name: parsed.area.name,
          latitude: parsed.area.latitude,
          longitude: parsed.area.longitude,
        },
        ...(parsed.nextPlace
          ? {
            nextPlace: {
              id: parsed.nextPlace.placeId,
              latitude: parsed.nextPlace.latitude,
              longitude: parsed.nextPlace.longitude,
            },
          }
          : {}),
        ...(parsed.category ? { category: parsed.category } : {}),
        placeSearch,
      });
      response.status(200).json({ data: { places } });
    } catch (error) {
      if (error instanceof AmapProviderError) {
        if (error.code === 'PROVIDER_UNAVAILABLE') {
          sendError(response, 503, 'PROVIDER_UNAVAILABLE', UNAVAILABLE_MESSAGE);
          return;
        }
        if (error.code === 'INVALID_REQUEST') {
          sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
          return;
        }
        sendError(response, 502, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
        return;
      }
      sendError(response, 502, 'PROVIDER_ERROR', PROVIDER_ERROR_MESSAGE);
    }
  });
  return router;
}
