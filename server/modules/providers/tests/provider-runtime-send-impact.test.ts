import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';

/**
 * The client asks the server what a send would stop before it sends. The answer is only
 * right if the options compared against the live process are the ones the real send
 * produces, and the real send adds the session's project directory to what the client sent.
 */
function createService(projectPath: string | null) {
  const seen: Array<Record<string, unknown>> = [];
  const service = createProviderRuntimeService({
    resolveProvider: () => ({
      runtime: {
        tasksStoppedByTurn: (_sessionId: string, options: Record<string, unknown>) => {
          seen.push(options);
          return [];
        },
      },
    }) as never,
    getSessionProjectPath: () => projectPath,
  });
  return { service, seen };
}

test('the check completes the options with the session\'s project directory, as the send does', () => {
  const { service, seen } = createService('/projects/demo');
  service.tasksStoppedByTurn('claude', 'session-1', { model: 'm', permissionMode: 'default' });

  assert.equal(seen[0]?.cwd, '/projects/demo');
  assert.equal(seen[0]?.model, 'm', 'the client\'s own options are kept');
});

test('a directory the client sent wins over the session\'s', () => {
  const { service, seen } = createService('/projects/demo');
  service.tasksStoppedByTurn('claude', 'session-1', { cwd: '/projects/other' });

  assert.equal(seen[0]?.cwd, '/projects/other');
});

test('a session without a project path leaves the directory unset', () => {
  const { service, seen } = createService(null);
  service.tasksStoppedByTurn('claude', 'session-1', {});

  assert.equal(seen[0]?.cwd, undefined);
});
