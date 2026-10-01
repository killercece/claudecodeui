import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

export type ClaudeUsageLimit = {
  kind: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  model: string | null;
};

type ClaudeUsageResponse = {
  limits: ClaudeUsageLimit[];
};

const REFRESH_MS = 60_000;

/**
 * Polls the plan limits every minute while the tab is visible. Returns null until
 * the first successful response, and keeps the last known limits if a refresh fails.
 */
export function useClaudeUsage(): { limits: ClaudeUsageLimit[] | null; failed: boolean } {
  const [limits, setLimits] = useState<ClaudeUsageLimit[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (document.hidden) return;
      try {
        const data = await readApiJson<ClaudeUsageResponse>(await api.usage.live());
        if (cancelled) return;
        setLimits(data.limits);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return { limits, failed };
}
