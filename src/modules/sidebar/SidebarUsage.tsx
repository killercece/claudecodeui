import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import { useClaudeUsage, type ClaudeUsageLimit } from '@/modules/sidebar/hooks/useClaudeUsage';

/** Formats the time left before a limit resets, e.g. "4 h 05" or "2 j 19 h". */
function formatTimeLeft(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const minutes = Math.max(0, Math.round((new Date(resetsAt).getTime() - Date.now()) / 60_000));
  if (Number.isNaN(minutes)) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${String(rest).padStart(2, '0')}`;
  return `${rest} min`;
}

function barColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-green-500';
}

function limitLabel(limit: ClaudeUsageLimit, t: TFunction): string {
  if (limit.kind === 'session') return t('usage.session');
  if (limit.kind === 'weekly_all') return t('usage.weekly');
  return limit.model ?? limit.label;
}

type SidebarUsageProps = {
  t: TFunction;
};

/** Used by SidebarFooter to keep the Claude plan limits (5 h session, weekly) always visible. */
export default function SidebarUsage({ t }: SidebarUsageProps) {
  const { limits, failed } = useClaudeUsage();

  if (!limits) {
    return failed ? (
      <div className="px-4 py-2 text-[11px] text-muted-foreground/60">{t('usage.unavailable')}</div>
    ) : null;
  }

  // Les limites par modèle à 0 % n'apportent rien : on les masque pour garder le bloc compact.
  const visible = limits.filter((limit) => limit.kind !== 'weekly_scoped' || limit.percent > 0);
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2 px-4 py-2.5">
      {visible.map((limit) => {
        const percent = Math.min(100, Math.max(0, Math.round(limit.percent)));
        const timeLeft = formatTimeLeft(limit.resetsAt);
        const resetText = timeLeft ? t('usage.resetsIn', { time: timeLeft }) : '';
        return (
          <div key={`${limit.kind}-${limit.model ?? ''}`} title={resetText ? `${limit.label} · ${resetText}` : limit.label}>
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate text-muted-foreground">{limitLabel(limit, t)}</span>
              <span className="flex-shrink-0 tabular-nums text-foreground/80">
                {percent}%
                {timeLeft && <span className="ml-1.5 text-muted-foreground/60">· {timeLeft}</span>}
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full transition-[width]', barColor(percent))}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
