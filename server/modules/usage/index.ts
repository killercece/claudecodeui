import { createUsageRouter } from './usage.routes.js';
import { createUsageService } from './usage.service.js';

// createUsageModule: used by the server entrypoint to mount the protected Claude plan-usage routes.
export function createUsageModule() {
  return createUsageRouter(createUsageService());
}
