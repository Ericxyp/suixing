import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import { getServerConfig, type ServerConfig } from './config';
import { createAiRequirementsRouter } from './routes/ai-requirements';
import { createAiTripChangeInterpretRouter } from './routes/ai-trip-change-interpret';
import { createAiTripPlanRouter } from './routes/ai-trip-plan';
import { createHealthRouter } from './routes/health';
import { createTripGenerateRouter } from './routes/trip-generate';
import { createTripChangeApplyRouter } from './routes/trip-change-apply';
import { createTripMealApplyRouter } from './routes/trip-meal-apply';
import { createTripMealOptionsRouter } from './routes/trip-meal-options';
import {
  createAmapProxyRouter,
  type AmapProxyTransport,
} from './routes/amap-proxy';
import { createPlaceDetailRouter } from './routes/place-detail';
import { createPlaceSearchRouter } from './routes/place-search';
import { createRoutePlanningRouter } from './routes/route-planning';
import type { AmapPlaceService } from './services/amap-place-service';
import type { AmapRouteService } from './services/amap-route-service';
import type { GenerationStageLogger } from './services/generation-logger';
import type { TripChangeIntentExtractor } from './services/trip-change-intent-extractor';
import type { TripPlanGenerator } from './services/trip-plan-generator';
import type { TripRequirementExtractor } from './services/trip-requirement-extractor';
import type {
  TripChangeClock,
  TripChangeExecutor,
} from './services/trip-change-executor';
import type {
  TripGenerationOrchestrator,
  TripIdentity,
} from './services/trip-generation-orchestrator';

export interface AppOptions {
  amapProxyTransport?: AmapProxyTransport;
  amapProxyTimeoutMs?: number;
  placeSearchService?: AmapPlaceService;
  routeService?: AmapRouteService;
  tripRequirementExtractor?: TripRequirementExtractor;
  tripChangeIntentExtractor?: TripChangeIntentExtractor;
  tripPlanGenerator?: TripPlanGenerator;
  tripGenerationOrchestrator?: TripGenerationOrchestrator;
  tripIdentity?: TripIdentity;
  tripChangeExecutor?: TripChangeExecutor;
  tripChangeClock?: TripChangeClock;
  generationLogger?: GenerationStageLogger;
}

const jsonParseErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  const parseFailed = (
    error instanceof SyntaxError && 'body' in error
  ) || (
    typeof error === 'object'
    && error !== null
    && 'type' in error
    && error.type === 'entity.parse.failed'
  );
  if (parseFailed) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: '旅行需求无效，请调整后重试。' },
    });
    return;
  }
  next(error);
};

export function createApp(config: ServerConfig, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(jsonParseErrorHandler);
  app.use('/api', createHealthRouter(config, {
    tripGenerationConfigured: Boolean(options.tripGenerationOrchestrator),
  }));
  app.use('/api', createPlaceSearchRouter(options.placeSearchService));
  app.use('/api', createPlaceDetailRouter(options.placeSearchService));
  app.use('/api', createRoutePlanningRouter(options.routeService));
  app.use('/api', createAiRequirementsRouter(options.tripRequirementExtractor));
  app.use('/api', createAiTripChangeInterpretRouter(options.tripChangeIntentExtractor));
  app.use('/api', createAiTripPlanRouter(options.tripPlanGenerator));
  app.use('/api', createTripGenerateRouter(
    options.tripGenerationOrchestrator,
    options.tripIdentity,
    {
      hasAiProvider: Boolean(options.tripPlanGenerator),
      hasAmapPlaceAndRoute: Boolean(options.placeSearchService && options.routeService),
    },
  ));
  app.use('/api', createTripChangeApplyRouter(
    options.tripChangeExecutor,
    options.tripChangeClock,
    options.generationLogger,
  ));
  app.use('/api', createTripMealOptionsRouter(options.placeSearchService));
  app.use('/api', createTripMealApplyRouter(
    options.tripChangeExecutor,
    options.tripChangeClock,
    options.generationLogger,
  ));
  app.use('/api', (_request, response) => response.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }));
  app.use('/_AMapService', createAmapProxyRouter(
    config,
    options.amapProxyTransport,
    options.amapProxyTimeoutMs,
  ));
  app.use((_request, response) => response.status(404).json({ error: { code: 'NOT_FOUND', message: '地图服务路径不存在。' } }));
  return app;
}
export const app = createApp(getServerConfig());

