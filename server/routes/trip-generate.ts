import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AI_INVALID_REQUEST_MESSAGE,
  AI_INVALID_RESPONSE_MESSAGE,
  AI_PROVIDER_ERROR_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiProviderError,
} from '../services/ai-provider';
import { AmapProviderError } from '../services/amap-http-client';
import { TripBuilderError } from '../services/trip-builder';
import {
  TRIP_GENERATION_INCOMPLETE_MESSAGE,
  TRIP_GENERATION_TIMEOUT_MESSAGE,
  TripGenerationIncompleteError,
  TripGenerationTimeoutError,
  createSystemTripIdentity,
  type TripGenerationOrchestrator,
  type TripIdentity,
} from '../services/trip-generation-orchestrator';
import { createGenerationRequestId } from '../services/generation-logger';
import { parseTripRequirementBody } from '../services/trip-plan-generator';

const INVALID_REQUEST_MESSAGE = '行程生成请求无效，请调整后重试。';
const UNSUPPORTED_TYPE_MESSAGE = '请使用 JSON 提交旅行方案。';
const METHOD_MESSAGE = '仅支持生成旅行方案。';
const INTERNAL_ERROR_MESSAGE = '服务暂时不可用，请稍后重试。';
const PLACE_ROUTE_UNAVAILABLE_MESSAGE = '地点与路线服务尚未配置，请稍后再试。';
const PLACE_ROUTE_ERROR_MESSAGE = '地点与路线服务暂时不可用，请稍后重试。';

type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AI_INVALID_REQUEST'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_PROVIDER_ERROR'
  | 'AI_INVALID_RESPONSE'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'TRIP_GENERATION_INCOMPLETE'
  | 'TRIP_GENERATION_TIMEOUT'
  | 'INTERNAL_ERROR';

export interface TripGenerateAvailability {
  hasAiProvider: boolean;
  hasAmapPlaceAndRoute: boolean;
}

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

function unavailableCode(availability: TripGenerateAvailability): {
  code: Extract<ErrorCode, 'AI_PROVIDER_UNAVAILABLE' | 'PROVIDER_UNAVAILABLE'>;
  message: string;
} {
  if (!availability.hasAiProvider) {
    return { code: 'AI_PROVIDER_UNAVAILABLE', message: AI_UNAVAILABLE_MESSAGE };
  }
  return { code: 'PROVIDER_UNAVAILABLE', message: PLACE_ROUTE_UNAVAILABLE_MESSAGE };
}

export function createTripGenerateRouter(
  orchestrator?: TripGenerationOrchestrator,
  identity: TripIdentity = createSystemTripIdentity(),
  availability: TripGenerateAvailability = {
    hasAiProvider: Boolean(orchestrator),
    hasAmapPlaceAndRoute: Boolean(orchestrator),
  },
): Router {
  const router = Router();

  router.all('/trips/generate', async (request: Request, response: Response) => {
    if (request.method !== 'POST') {
      sendError(response, 405, 'INVALID_REQUEST', METHOD_MESSAGE);
      return;
    }

    if (!isJsonContentType(request.headers['content-type'])) {
      sendError(response, 415, 'INVALID_REQUEST', UNSUPPORTED_TYPE_MESSAGE);
      return;
    }

    const requirement = parseTripRequirementBody(request.body);
    if (!requirement) {
      sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
      return;
    }

    if (!orchestrator) {
      const unavailable = unavailableCode(availability);
      sendError(response, 503, unavailable.code, unavailable.message);
      return;
    }

    try {
      const result = await orchestrator.generate({
        requirement,
        tripId: identity.createTripId(),
        createdAt: identity.nowIso(),
        requestId: createGenerationRequestId(),
      });
      response.status(200).json({
        data: {
          trip: result.trip,
          places: result.places,
          diagnostics: {
            unresolvedPlacesCount: result.diagnostics.unresolvedPlacesCount,
            unresolvedRoutesCount: result.diagnostics.unresolvedRoutesCount,
          },
        },
      });
    } catch (error) {
      if (error instanceof TripGenerationTimeoutError) {
        sendError(response, 504, 'TRIP_GENERATION_TIMEOUT', TRIP_GENERATION_TIMEOUT_MESSAGE);
        return;
      }
      if (error instanceof TripGenerationIncompleteError) {
        sendError(response, 422, 'TRIP_GENERATION_INCOMPLETE', TRIP_GENERATION_INCOMPLETE_MESSAGE);
        return;
      }
      if (error instanceof TripBuilderError) {
        sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
        return;
      }
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
        if (error.code === 'INVALID_REQUEST') {
          sendError(response, 400, 'INVALID_REQUEST', INVALID_REQUEST_MESSAGE);
          return;
        }
        if (error.code === 'PROVIDER_UNAVAILABLE') {
          sendError(response, 503, 'PROVIDER_UNAVAILABLE', PLACE_ROUTE_UNAVAILABLE_MESSAGE);
          return;
        }
        sendError(response, 502, 'PROVIDER_ERROR', PLACE_ROUTE_ERROR_MESSAGE);
        return;
      }
      sendError(response, 500, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
    }
  });

  return router;
}
