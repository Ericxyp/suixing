import { Router } from 'express';
import type { ServerConfig } from '../config';

export function createHealthRouter(
  config: ServerConfig,
  options: { tripGenerationConfigured?: boolean } = {},
) {
  const router = Router();
  router.get('/health', (_request, response) =>
    response.status(200).json({
      data: {
        status: 'ok',
        providers: {
          amapWebService: config.hasAmapWebServiceKey ? 'configured' : 'not-configured',
          amapJsSecurityProxy: config.hasAmapSecurityJsCode ? 'configured' : 'not-configured',
          qwenAi: config.hasQwenAiProvider ? 'configured' : 'not-configured',
          tripGeneration: options.tripGenerationConfigured ? 'configured' : 'not-configured',
        },
      },
    }));
  return router;
}
