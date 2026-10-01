import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown, CircleAlert, CircleCheck, CircleDashed, X } from 'lucide-react';

import type { ChatMessage, DiffLine, Project, SubagentActivity } from '@/shared/types';
import { cn } from '@/shared/utils';
import { AgentTranscriptDrawer } from '@/modules/chat/transcript/AgentTranscriptDrawer';
import { readBackgroundTaskId, resolveSubagentStatus } from '@/modules/chat/utils/backgroundTasks';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';

/** How many finished agents stay listed under the running ones; older ones drop off. */
const MAX_FINISHED_AGENTS = 5;

type RunningAgentsPanelProps = {
  /** Every loaded row of the session: an agent launched pages ago can still be running. */
  messages: ChatMessage[];
  /** The session the agents belong to, which `chat.stop-task` names; null before one exists. */
  sessionId: string | null;
  /** The chat websocket's send, for stopping an agent. */
  sendMessage: (message: unknown) => void;
  /** Brings an agent's block into view in the transcript. */
  onReveal: (message: ChatMessage) => void;
  /** What the agent's transcript drawer needs to render its tool calls like the main thread does. */
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  selectedProject?: Project | null;
};

/** The input field that best says what a tool call is working on, in reading order. */
const TARGET_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description'] as const;

/** "Read foo.py", "Bash npm test": the agent's latest entry, short enough for one line. */
function describeActivity(entry: SubagentActivity | undefined): string {
  if (!entry) return '';
  if (entry.kind === 'thinking') return 'thinking…';
  if (entry.kind === 'text') return 'writing…';

  const input = parseToolPayload(entry.toolInput);
  let target = '';
  if (input && typeof input === 'object') {
    for (const key of TARGET_KEYS) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) {
        target = value;
        break;
      }
    }
  }
  // Un chemin long est tronqué par la gauche : c'est le nom du fichier qui compte.
  const shortTarget = target.length > 60 ? `…${target.slice(-59)}` : target;
  return [entry.toolName, shortTarget].filter(Boolean).join(' ');
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (Number.isNaN(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes} min ${String(seconds % 60).padStart(2, '0')}`
    : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** Time since the agent's first entry, for a running agent whose clock keeps ticking. */
function formatElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '';
  return formatDuration((now - new Date(startedAt).getTime()) / 1000);
}

/** Time between the agent's first and last entry, for a finished one; empty when either is missing. */
function formatRunTime(activity: SubagentActivity[]): string {
  const first = activity[0]?.timestamp;
  const last = activity[activity.length - 1]?.timestamp;
  if (!first || !last) return '';
  return formatDuration((new Date(last).getTime() - new Date(first).getTime()) / 1000);
}

function countTools(activity: SubagentActivity[]): string {
  const count = activity.filter((entry) => entry.kind === 'tool').length;
  return count > 0 ? `${count} ${count === 1 ? 'tool' : 'tools'}` : '';
}

function FinishedIcon({ status }: { status: string }) {
  if (status === 'failed') return <CircleAlert className="h-3 w-3 flex-shrink-0 text-red-500 dark:text-red-400" />;
  if (status === 'stopped') return <CircleDashed className="h-3 w-3 flex-shrink-0" />;
  return <CircleCheck className="h-3 w-3 flex-shrink-0 text-green-600 dark:text-green-400" />;
}

/**
 * Rendered by chat's ChatMessagesPane in the sticky area above the transcript:
 * one row per subagent that is still running — what it is for, what it is doing
 * right now, how long it has run and how many tools it has used — followed by
 * the last few that finished, dimmed, so a run's outcome can still be read once
 * it is over. A row scrolls to the agent's block when clicked; a running
 * background agent can be stopped from its ✕. Only agents seen running since
 * the conversation was opened are kept, so old agents from the history never
 * resurface. Renders nothing while there is nothing to show.
 */
export const RunningAgentsPanel = memo(({ messages, sessionId, sendMessage, onReveal, createDiff, onFileOpen, selectedProject }: RunningAgentsPanelProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [seenRunning, setSeenRunning] = useState<ReadonlySet<string>>(() => new Set());
  const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set());
  // L'agent dont le transcript est ouvert dans le tiroir, retrouvé à chaque rendu pour rester en direct.
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setOpenAgentId(null), []);

  const agents = messages.filter((message) => message.isSubagentContainer && message.toolId);
  const statusOf = (message: ChatMessage) =>
    resolveSubagentStatus(message.subagent, message.taskStatus, message.toolResult);

  const running = agents.filter((message) => statusOf(message) === 'running');
  const finished = agents
    .filter((message) => statusOf(message) !== 'running'
      && seenRunning.has(message.toolId as string)
      && !cleared.has(message.toolId as string))
    .slice(-MAX_FINISHED_AGENTS);

  // On retient les agents vus en cours : seuls ceux-là restent listés une fois terminés.
  const runningIds = running.map((message) => message.toolId as string).join('|');
  useEffect(() => {
    if (!runningIds) return;
    setSeenRunning((previous) => {
      const ids = runningIds.split('|');
      if (ids.every((id) => previous.has(id))) return previous;
      return new Set([...previous, ...ids]);
    });
  }, [runningIds]);

  // Tick seulement tant qu'un agent tourne : la durée affichée avance sans nouvelle donnée.
  const hasRunning = running.length > 0;
  useEffect(() => {
    if (!hasRunning) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasRunning]);

  const openAgent = openAgentId ? agents.find((message) => message.toolId === openAgentId) : undefined;

  if (!hasRunning && finished.length === 0 && !openAgent) return null;

  const clearFinished = () => {
    setCleared((previous) => new Set([...previous, ...finished.map((message) => message.toolId as string)]));
  };

  const title = hasRunning
    ? t('workflow.agentsRunningCount', { count: running.length, defaultValue_one: '{{count}} agent running', defaultValue_other: '{{count}} agents running' })
    : t('workflow.agentsFinishedCount', { count: finished.length, defaultValue_one: '{{count}} agent finished', defaultValue_other: '{{count}} agents finished' });

  const showList = hasRunning || finished.length > 0;

  return (
    <>
      {showList && (
      <div
        role="status"
        aria-label={t('workflow.runningAgents', 'Running agents')}
        className="max-w-full rounded-md border border-border/60 bg-background/95 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
      >
        <div className="flex items-center">
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={() => setIsOpen((previous) => !previous)}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left hover:text-foreground"
          >
            <Bot className="h-3.5 w-3.5 text-purple-500 dark:text-purple-400" />
            <span className="font-medium text-foreground">{title}</span>
            {hasRunning && finished.length > 0 && (
              <span className="text-muted-foreground/70">· {t('workflow.agentsFinishedShort', { count: finished.length, defaultValue: '{{count}} finished' })}</span>
            )}
            <ChevronDown className={cn('ml-auto h-3 w-3 flex-shrink-0 transition-transform', !isOpen && '-rotate-90')} />
          </button>
          {finished.length > 0 && (
            <button
              type="button"
              onClick={clearFinished}
              aria-label={t('workflow.clearFinishedAgents', 'Clear finished agents')}
              title={t('workflow.clearFinishedAgents', 'Clear finished agents')}
              className="mr-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {isOpen && (
          <ul className="divide-y divide-border/40 border-t border-border/40">
            {running.map((message) => {
              const activity = message.subagentActivity ?? [];
              const label = message.subagent?.type || message.subagent?.name || 'Agent';
              const description = message.subagent?.description || message.taskStatus?.description || '';
              const current = describeActivity(activity[activity.length - 1]);
              const taskId = readBackgroundTaskId(message);
              return (
                <li key={message.toolId} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => setOpenAgentId(message.toolId as string)}
                    title={[label, description, current].filter(Boolean).join(' · ')}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1 text-left hover:bg-muted/60"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
                      <span className="flex-shrink-0 font-medium text-foreground">{label}</span>
                      {description && <span className="min-w-0 truncate">{description}</span>}
                      <span className="ml-auto flex-shrink-0 tabular-nums text-muted-foreground/70">
                        {[formatElapsed(activity[0]?.timestamp, now), countTools(activity)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {current && (
                      <span className="truncate pl-3 font-mono text-[10px] text-muted-foreground/70">{current}</span>
                    )}
                  </button>
                  {sessionId && taskId && (
                    <button
                      type="button"
                      onClick={() => sendMessage({ type: 'chat.stop-task', sessionId, taskId })}
                      aria-label={t('workflow.stopTask', 'Stop')}
                      title={t('workflow.stopTask', 'Stop')}
                      className="mr-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}

            {finished.map((message) => {
              const activity = message.subagentActivity ?? [];
              const label = message.subagent?.type || message.subagent?.name || 'Agent';
              const description = message.subagent?.description || message.taskStatus?.description || '';
              const status = statusOf(message);
              return (
                <li key={message.toolId} className="opacity-70">
                  <button
                    type="button"
                    onClick={() => setOpenAgentId(message.toolId as string)}
                    title={[label, description].filter(Boolean).join(' · ')}
                    className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/60 hover:opacity-100"
                  >
                    <FinishedIcon status={status} />
                    <span className="flex-shrink-0 font-medium text-foreground">{label}</span>
                    {description && <span className="min-w-0 truncate">{description}</span>}
                    <span className="ml-auto flex-shrink-0 tabular-nums text-muted-foreground/70">
                      {[formatRunTime(activity), countTools(activity)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      )}
      {openAgent && (
        <AgentTranscriptDrawer
          agent={openAgent}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          selectedProject={selectedProject}
          onClose={closeDrawer}
          onLocate={(message) => {
            closeDrawer();
            onReveal(message);
          }}
        />
      )}
    </>
  );
});
RunningAgentsPanel.displayName = 'RunningAgentsPanel';
