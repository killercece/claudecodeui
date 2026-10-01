import express from 'express';

import { UsageError, type createUsageService } from './usage.service.js';

/** Creates the thin usage routes: they only delegate to the service and map its errors. */
export function createUsageRouter(usageService: ReturnType<typeof createUsageService>): express.Router {
  const router = express.Router();

  router.get('/live', async (_request, response) => {
    try {
      response.json(await usageService.getLiveUsage());
    } catch (error) {
      const status = error instanceof UsageError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Internal error';
      response.status(status).json({ error: message });
    }
  });

  return router;
}
