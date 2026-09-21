import { Router } from 'express';
import type { Request, Response } from 'express';
import { AmapProviderError } from '../services/amap-http-client';
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
import {
  emptyNearbyChoiceSummary,
  HEURISTIC_CLARIFY_INTENT,
  refineTripChangeIntent,
} from '../services/trip-change-intent-refine';
import { searchNearbyChangeOptions } from '../services/trip-change-nearby-options';
import type { PlaceSearchService } from '../services/trip-place-resolver';

const INVALID_REQUEST_MESSAGE = '行程修改请求无效，请调整后重试。';
const UNSUPPORTED_TYPE_MESSAGE = '请使用 JSON 提交行程修改意图。';
const METHOD_MESSAGE = '仅支持理解行程修改意图。';
const INTERNAL_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';
const PLACE_UNAVAILABLE_MESSAGE = '地点服务尚未配置。';
const PLACE_PROVIDER_ERROR_MESSAGE = '地点与路线服务暂时不可用，请稍后重试。';

type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AI_INVALID_REQUEST'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_PROVIDER_ERROR'
  | 'AI_INVALID_RESPONSE'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR'
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
  placeSearch?: PlaceSearchService,
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
      let aiIntent = HEURISTIC_CLARIFY_INTENT;
      try {
        aiIntent = await extractor.interpret(parsed.input, parsed.context);
      } catch (error) {
        if (
          !(error instanceof AiProviderError)
          || error.code === 'AI_PROVIDER_UNAVAILABLE'
          || error.code === 'AI_PROVIDER_ERROR'
        ) {
          throw error;
        }
        const fallback = refineTripChangeIntent(
          parsed.input,
          parsed.context,
          HEURISTIC_CLARIFY_INTENT,
          parsed.focus,
        );
        if (
          fallback.intentType !== 'REPLACE_WITH_CATEGORY'
          && fallback.intentType !== 'DISCOVER_NEARBY_OPTIONS'
          && !(
            fallback.intentType === 'CLARIFY'
            && (
              fallback.sourceGrounding === 'AMBIGUOUS'
              || fallback.sourceGrounding === 'NOT_IN_CURRENT_DAY'
              || fallback.sourceGrounding === 'NOT_IN_TRIP'
            )
          )
        ) {
          throw error;
        }
        aiIntent = HEURISTIC_CLARIFY_INTENT;
      }
      const refined = refineTripChangeIntent(
        parsed.input,
        parsed.context,
        aiIntent,
        parsed.focus,
      );
      if (
        refined.intentType === 'REPLACE_WITH_CATEGORY'
        || refined.intentType === 'DISCOVER_NEARBY_OPTIONS'
      ) {
        if (!refined.sourceStop || !refined.targetCategory || !refined.searchQuery) {
          response.status(200).json({ data: { intent: refined.publicIntent } });
          return;
        }
        if (!placeSearch) {
          sendError(response, 503, 'PROVIDER_UNAVAILABLE', PLACE_UNAVAILABLE_MESSAGE);
          return;
        }
        const candidates = await searchNearbyChangeOptions({
          city: parsed.context.destination,
          sourceName: refined.sourceStop.placeName,
          nextName: refined.nextStopName,
          category: refined.targetCategory,
          query: refined.searchQuery,
          excludePlaceNames: [refined.sourceStop.placeName],
          placeSearch,
        });
        const intent = candidates.length === 0
          ? {
            status: 'needs_clarification' as const,
            summary: emptyNearbyChoiceSummary(
              refined.sourceStop.placeName,
              refined.searchQuery,
            ),
            operations: [],
          }
          : {
            ...refined.publicIntent,
            candidates,
          };
        response.status(200).json({ data: { intent } });
        return;
      }
      response.status(200).json({ data: { intent: refined.publicIntent } });
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
      if (error instanceof AmapProviderError) {
        if (error.code === 'PROVIDER_UNAVAILABLE') {
          sendError(response, 503, 'PROVIDER_UNAVAILABLE', PLACE_UNAVAILABLE_MESSAGE);
          return;
        }
        sendError(response, 502, 'PROVIDER_ERROR', PLACE_PROVIDER_ERROR_MESSAGE);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
    }
  });

  return router;
}
