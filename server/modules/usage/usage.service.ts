import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 30_000;

export type UsageLimit = {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  model: string | null;
};

export type LiveUsage = {
  plan: string | null;
  tier: string | null;
  limits: UsageLimit[];
};

/** Error carrying the HTTP status the route should answer with. */
export class UsageError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type UsageServiceOptions = {
  claudeDirectory?: string;
  now?: () => number;
  fetchUsage?: (accessToken: string) => Promise<unknown>;
};

const KIND_LABELS: Record<string, string> = {
  session: 'Session (5h)',
  weekly_all: 'Weekly (all models)',
  weekly_scoped: 'Weekly',
};

async function fetchUsageFromAnthropic(accessToken: string): Promise<unknown> {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new UsageError(`Usage endpoint returned HTTP ${response.status}.`, 502);
  }
  return response.json();
}

/**
 * Maps the (unofficial, undocumented) usage endpoint response defensively:
 * entries that do not look like a limit are skipped rather than failing.
 */
export function normalizeUsage(raw: unknown, plan: string | null, tier: string | null): LiveUsage {
  const rawLimits = (raw as { limits?: unknown } | null)?.limits;
  const limits: UsageLimit[] = [];
  if (Array.isArray(rawLimits)) {
    for (const entry of rawLimits) {
      if (typeof entry?.kind !== 'string' || typeof entry?.percent !== 'number') continue;
      const rawModel = entry.scope?.model?.display_name;
      const model = typeof rawModel === 'string' && rawModel !== '' ? rawModel : null;
      const base = KIND_LABELS[entry.kind] ?? entry.kind;
      limits.push({
        kind: entry.kind,
        label: model ? `${base} — ${model}` : base,
        percent: entry.percent,
        severity: typeof entry.severity === 'string' ? entry.severity : 'normal',
        resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null,
        model,
      });
    }
  }
  return { plan, tier, limits };
}

/**
 * Reads the Claude Code OAuth credentials and returns the plan limits (5 h session,
 * weekly). Only the access token is read, never the refresh token, and results are
 * cached so several open tabs do not multiply calls to Anthropic.
 */
export function createUsageService(options: UsageServiceOptions = {}) {
  const claudeDirectory =
    options.claudeDirectory ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const now = options.now ?? Date.now;
  const fetchUsage = options.fetchUsage ?? fetchUsageFromAnthropic;
  let cache: { at: number; data: LiveUsage } | null = null;

  async function getLiveUsage(): Promise<LiveUsage> {
    if (cache && now() - cache.at < CACHE_MS) return cache.data;

    let credentials: { claudeAiOauth?: Record<string, unknown> };
    try {
      credentials = JSON.parse(fs.readFileSync(path.join(claudeDirectory, '.credentials.json'), 'utf-8'));
    } catch {
      throw new UsageError('No Claude Code credentials found: sign in with the claude CLI first.', 404);
    }

    const oauth = credentials.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string') {
      throw new UsageError('Unrecognized credentials file format.', 500);
    }
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < now()) {
      throw new UsageError('OAuth token expired: run claude to refresh it, then retry.', 401);
    }

    const plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;
    const tier = typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null;
    const data = normalizeUsage(await fetchUsage(oauth.accessToken), plan, tier);
    cache = { at: now(), data };
    return data;
  }

  return { getLiveUsage };
}
