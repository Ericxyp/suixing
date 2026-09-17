import { createApp } from './app';
import { getServerConfig } from './config';
import { AmapWebServiceHttpClient } from './services/amap-http-client';
import { AmapWebServicePlaceService } from './services/amap-place-service';
import { AmapWebServiceRouteService } from './services/amap-route-service';
import { createAiProvider } from './services/create-ai-provider';
import { createConsoleGenerationLogger } from './services/generation-logger';
import { ConfirmedTripBuilder } from './services/trip-builder';
import { ServerTripGenerationOrchestrator } from './services/trip-generation-orchestrator';
import { AmapTripPlaceResolver } from './services/trip-place-resolver';
import { AmapTripRouteEnricher } from './services/trip-route-enricher';
import { QwenTripChangeIntentExtractor } from './services/trip-change-intent-extractor';
import { AmapTripChangeExecutor } from './services/trip-change-executor';
import { QwenTripPlanGenerator } from './services/trip-plan-generator';
import { QwenTripRequirementExtractor } from './services/trip-requirement-extractor';

const config = getServerConfig();
const amapClient = config.amapWebServiceKey
  ? new AmapWebServiceHttpClient(config.amapWebServiceKey, fetch)
  : undefined;
const placeSearchService = amapClient
  ? new AmapWebServicePlaceService(amapClient)
  : undefined;
const routeService = amapClient
  ? new AmapWebServiceRouteService(amapClient)
  : undefined;
const amapProxyTransport = config.amapSecurityJsCode ? fetch : undefined;
const aiProvider = createAiProvider(config);
const tripRequirementExtractor = aiProvider
  ? new QwenTripRequirementExtractor(aiProvider)
  : undefined;
const tripChangeIntentExtractor = aiProvider
  ? new QwenTripChangeIntentExtractor(aiProvider, createConsoleGenerationLogger())
  : undefined;
const tripPlanGenerator = aiProvider
  ? new QwenTripPlanGenerator(aiProvider)
  : undefined;
const tripPlaceResolver = placeSearchService
  ? new AmapTripPlaceResolver(placeSearchService)
  : undefined;
const tripRouteEnricher = routeService
  ? new AmapTripRouteEnricher(routeService)
  : undefined;
const tripBuilder = new ConfirmedTripBuilder();
const tripGenerationOrchestrator = (
  tripPlanGenerator
  && tripPlaceResolver
  && tripRouteEnricher
)
  ? new ServerTripGenerationOrchestrator({
    planGenerator: tripPlanGenerator,
    placeResolver: tripPlaceResolver,
    routeEnricher: tripRouteEnricher,
    tripBuilder,
    placeSearch: placeSearchService,
    userId: 'user-demo-001',
    logger: createConsoleGenerationLogger(),
  })
  : undefined;
const tripChangeExecutor = (
  placeSearchService
  && tripRouteEnricher
)
  ? new AmapTripChangeExecutor(placeSearchService, tripRouteEnricher)
  : undefined;

createApp(config, {
  placeSearchService,
  routeService,
  amapProxyTransport,
  tripRequirementExtractor,
  tripChangeIntentExtractor,
  tripPlanGenerator,
  tripGenerationOrchestrator,
  tripChangeExecutor,
  tripChangeClock: {
    nowIso() {
      return new Date().toISOString();
    },
  },
  generationLogger: createConsoleGenerationLogger(),
}).listen(config.port, () =>
  console.log(`随行 BFF 已启动：http://localhost:${config.port}`),
);
