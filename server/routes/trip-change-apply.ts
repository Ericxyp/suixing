import { Router } from 'express';
import type { Request, Response } from 'express';
import { parseTripChangeApplyBody } from '../services/trip-change-apply-request';
import {
  TRIP_CHANGE_INVALID_REQUEST_MESSAGE,
  TRIP_CHANGE_PROVIDER_ERROR_MESSAGE,
  TripChangeExecutionError,
  type TripChangeClock,
  type TripChangeExecutor,
} from '../services/trip-change-executor';
import {
  safeGenerationErrorCode,
  type GenerationStageLogger,
} from '../services/generation-logger';

const UNSUPPORTED_TYPE_MESSAGE = '请使用 JSON 提交行程修改。';
const METHOD_MESSAGE = '仅支持执行行程修改。';
const INTERNAL_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';
const PROVIDER_UNAVAILABLE_MESSAGE = '地点与路线服务尚未配置，请稍后再试。';
const TRIP_CHANGE_INCOMPLETE_HTTP_MESSAGE = '暂时找不到合适的替换地点，请换一种说法后重试。';

type ErrorCode =
  | 'INVALID_REQUEST'
  | 'TRIP_CHANGE_INCOMPLETE'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
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

function systemClock(): TripChangeClock {
  return {
    nowIso() {
      return new Date().toISOString();
    },
  };
}

export function createTripChangeApplyRouter(
  executor?: TripChangeExecutor,
  clock: TripChangeClock = systemClock(),
  logger?: GenerationStageLogger,
): Router {
  const router = Router();

  router.all('/trips/change/apply', async (request: Request, response: Response) => {
    const started = Date.now();
    const log = (outcome: 'success' | 'failed', errorCode?: string) => {
      logger?.logStage({
        requestId: 'omitted',
        stage: 'change_apply',
        outcome,
        durationMs: Date.now() - started,
        ...(errorCode ? { errorCode } : {}),
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

    const parsed = parseTripChangeApplyBody(request.body);
    if (!parsed) {
      sendError(response, 400, 'INVALID_REQUEST', TRIP_CHANGE_INVALID_REQUEST_MESSAGE);
      return;
    }

    if (!executor) {
      log('failed', 'PROVIDER_UNAVAILABLE');
      sendError(response, 503, 'PROVIDER_UNAVAILABLE', PROVIDER_UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      const result = await executor.replacePlace({
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
          summary: {
            type: 'REPLACE_PLACE' as const,
            dayNumber: result.summary.dayNumber,
            replacedTripPlaceId: result.summary.replacedTripPlaceId,
            previousPlaceName: result.summary.previousPlaceName,
            nextPlaceName: result.summary.nextPlaceName,
            routeRecalculated: result.summary.routeRecalculated,
          },
        },
      });
    } catch (error) {
      const errorCode = safeGenerationErrorCode(error);
      log('failed', errorCode);
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
