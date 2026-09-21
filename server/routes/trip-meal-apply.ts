import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  TRIP_CHANGE_INVALID_REQUEST_MESSAGE,
  TRIP_CHANGE_PROVIDER_ERROR_MESSAGE,
  TripChangeExecutionError,
  type TripChangeClock,
  type TripChangeExecutor,
} from '../services/trip-change-executor';
import { parseTripMealApplyBody } from '../services/trip-meal-apply-request';
import {
  safeGenerationErrorCode,
  safeGenerationValidationReason,
  type GenerationStageLogger,
} from '../services/generation-logger';

const METHOD_MESSAGE = '仅支持执行餐饮选择。';
const UNSUPPORTED_TYPE_MESSAGE = '请使用 JSON 提交餐饮选择。';
const INTERNAL_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';
const PROVIDER_UNAVAILABLE_MESSAGE = '地点与路线服务尚未配置，请稍后再试。';
const TRIP_CHANGE_INCOMPLETE_HTTP_MESSAGE = '暂时找不到合适的餐饮地点，请稍后再试。';

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

export function createTripMealApplyRouter(
  executor?: TripChangeExecutor,
  clock: TripChangeClock = { nowIso: () => new Date().toISOString() },
  logger?: GenerationStageLogger,
): Router {
  const router = Router();
  router.all('/trips/meal/apply', async (request: Request, response: Response) => {
    const started = Date.now();
    const log = (outcome: 'success' | 'failed', error?: unknown) => {
      const errorCode = error === undefined ? undefined : safeGenerationErrorCode(error);
      const validationReason = error === undefined ? undefined : safeGenerationValidationReason(error);
      logger?.logStage({
        requestId: 'omitted',
        stage: 'meal_apply',
        outcome,
        durationMs: Date.now() - started,
        ...(errorCode ? { errorCode } : {}),
        ...(validationReason ? { validationReason } : {}),
      });
    };
    if (request.method !== 'POST') {
      sendError(response, 405, 'INVALID_REQUEST', METHOD_MESSAGE);
      return;
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      sendError(response, 415, 'INVALID_REQUEST', UNSUPPORTED_TYPE_MESSAGE);
      return;
    }
    const parsed = parseTripMealApplyBody(request.body);
    if (!parsed) {
      sendError(response, 400, 'INVALID_REQUEST', TRIP_CHANGE_INVALID_REQUEST_MESSAGE);
      return;
    }
    if (!executor) {
      log('failed', { code: 'PROVIDER_UNAVAILABLE' });
      sendError(response, 503, 'PROVIDER_UNAVAILABLE', PROVIDER_UNAVAILABLE_MESSAGE);
      return;
    }
    try {
      const result = await executor.selectMealPlace({
        trip: parsed.trip,
        places: parsed.places,
        operation: parsed.operation,
        updatedAt: clock.nowIso(),
      });
      log('success');
      response.status(200).json({
        data: {
          trip: result.trip,
          places: result.places,
          summary: result.summary,
        },
      });
    } catch (error) {
      log('failed', error);
      if (error instanceof TripChangeExecutionError) {
        if (error.code === 'INVALID_REQUEST') {
          sendError(response, 400, 'INVALID_REQUEST', TRIP_CHANGE_INVALID_REQUEST_MESSAGE);
          return;
        }
        if (error.code === 'TRIP_CHANGE_INCOMPLETE') {
          sendError(response, 422, 'TRIP_CHANGE_INCOMPLETE', TRIP_CHANGE_INCOMPLETE_HTTP_MESSAGE);
          return;
        }
        if (error.code === 'PROVIDER_UNAVAILABLE') {
          sendError(response, 503, 'PROVIDER_UNAVAILABLE', PROVIDER_UNAVAILABLE_MESSAGE);
          return;
        }
        sendError(response, 502, 'PROVIDER_ERROR', TRIP_CHANGE_PROVIDER_ERROR_MESSAGE);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
    }
  });
  return router;
}
