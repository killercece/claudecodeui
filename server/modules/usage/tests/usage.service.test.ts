import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUsageService, normalizeUsage, UsageError } from '../usage.service.js';

function writeCredentials(oauth: Record<string, unknown>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  fs.writeFileSync(path.join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  return directory;
}

test('normalizeUsage keeps valid limits and labels scoped models', () => {
  const result = normalizeUsage(
    {
      limits: [
        { kind: 'session', percent: 5, resets_at: '2026-10-01T18:00:00Z' },
        { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } },
        { kind: 'broken' },
      ],
    },
    'max',
    'max_20x',
  );
  assert.equal(result.limits.length, 2);
  assert.equal(result.limits[0].label, 'Session (5h)');
  assert.equal(result.limits[1].label, 'Weekly — Fable');
});

test('getLiveUsage caches the response between calls', async () => {
  let calls = 0;
  const service = createUsageService({
    claudeDirectory: writeCredentials({ accessToken: 'token', expiresAt: Date.now() + 60_000 }),
    fetchUsage: async () => {
      calls += 1;
      return { limits: [] };
    },
  });
  await service.getLiveUsage();
  await service.getLiveUsage();
  assert.equal(calls, 1);
});

test('getLiveUsage rejects an expired token without calling Anthropic', async () => {
  const service = createUsageService({
    claudeDirectory: writeCredentials({ accessToken: 'token', expiresAt: 1 }),
    fetchUsage: async () => {
      throw new Error('must not be called');
    },
  });
  await assert.rejects(service.getLiveUsage(), (error: unknown) => error instanceof UsageError && error.status === 401);
});

test('getLiveUsage answers 404 when credentials are missing', async () => {
  const service = createUsageService({ claudeDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 'usage-empty-')) });
  await assert.rejects(service.getLiveUsage(), (error: unknown) => error instanceof UsageError && error.status === 404);
});
