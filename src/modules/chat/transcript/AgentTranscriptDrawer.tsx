import { memo, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, Bot, CornerDownLeft, X } from 'lucide-react';

import type { ChatMessage, DiffLine, Project } from '@/shared/types';
import { SubagentTimeline } from '@/modules/chat/tools/SubagentTimeline';
import { readResultText } from '@/modules/chat/tools/SubagentPanel';
import { MarkdownContent } from '@/modules/chat/tools/ContentRenderers/MarkdownContent';
import { resolveSubagentStatus } from '@/modules/chat/utils/backgroundTasks';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';

/** How close to the bottom, in pixels, still counts as "following" the live run. */
const FOLLOW_THRESHOLD_PX = 80;

type AgentTranscriptDrawerProps = {
  /** The agent's row, read fresh from the transcript on every render so the drawer stays live. */
  agent: ChatMessage;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  selectedProject?: Project | null;
  /** Closes the drawer. */
  onClose: () => void;
  /** Closes the drawer and brings the agent's block into view in the conversation. */
  onLocate: (message: ChatMessage) => void;
  /** Sends the agent to the background; only given while the agent is blocking the turn. */
  onSendToBackground?: () => void;
};

/**
 * Rendered by RunningAgentsPanel over the conversation, on its right edge: the
 * transcript of one subagent — its task, every step it took through the same
 * tool renderers as the main thread, and its answer — updating live while it
 * runs. It follows the newest step unless the reader has scrolled up. Drawn in
 * a portal so the conversation's own scrolling and sticky layout never clip it.
 */
export const AgentTranscriptDrawer = memo(({
  agent,
  createDiff,
  onFileOpen,
  selectedProject,
  onClose,
  onLocate,
  onSendToBackground,
}: AgentTranscriptDrawerProps) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFollowing = useRef(true);

  const activity = agent.subagentActivity ?? [];
  const status = resolveSubagentStatus(agent.subagent, agent.taskStatus, agent.toolResult);
  const label = agent.subagent?.type || agent.subagent?.name || 'Agent';
  const description = agent.subagent?.description || agent.taskStatus?.description || '';
  const input = parseToolPayload(agent.toolInput);
  const prompt = input && typeof input === 'object' && typeof (input as { prompt?: unknown }).prompt === 'string'
    ? (input as { prompt: string }).prompt
    : '';
  const resultText = readResultText(agent.toolResult?.content);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    isFollowing.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
  }, []);

  // Suit le direct : un nouveau pas fait descendre la vue, sauf si le lecteur a remonté pour relire.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && isFollowing.current) element.scrollTop = element.scrollHeight;
  }, [activity.length, resultText]);

  return createPortal(
    <aside
      role="dialog"
      aria-label={t('workflow.agentTranscript', 'Agent transcript')}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col border-l border-border bg-background shadow-2xl"
    >
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Bot className="h-4 w-4 flex-shrink-0 text-purple-500 dark:text-purple-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-medium text-foreground">{label}</span>
            {status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />}
            <span className="text-[11px] text-muted-foreground">{status}</span>
          </div>
          {description && <div className="truncate text-xs text-muted-foreground">{description}</div>}
        </div>
        {onSendToBackground && status === 'running' && (
          <button
            type="button"
            onClick={onSendToBackground}
            title={t('workflow.sendToBackgroundHint', 'Run in background: the conversation is free again while it works, and the result comes back when it finishes')}
            className="flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            {t('workflow.sendToBackground', 'Run in background')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onLocate(agent)}
          aria-label={t('workflow.locateAgent', 'Show in conversation')}
          title={t('workflow.locateAgent', 'Show in conversation')}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <CornerDownLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('workflow.closeAgentTranscript', 'Close')}
          title={t('workflow.closeAgentTranscript', 'Close')}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {agent.subagent?.model && (
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/50">{agent.subagent.model}</div>
        )}

        {prompt && (
          <div className="rounded border border-border/40 bg-muted/40 p-2 text-xs text-muted-foreground">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">Task</div>
            <div className="line-clamp-6 whitespace-pre-wrap break-words">{prompt}</div>
          </div>
        )}

        <SubagentTimeline
          fromEnd
          activity={activity}
          activityCount={agent.subagent?.activityCount}
          onFileOpen={onFileOpen}
          createDiff={createDiff}
          selectedProject={selectedProject}
        />

        {resultText && (
          <div className="rounded border border-border/40 bg-muted/30 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">Result</div>
            <MarkdownContent content={resultText} className="prose prose-sm max-w-none dark:prose-invert" />
          </div>
        )}
      </div>
    </aside>,
    document.body,
  );
});
AgentTranscriptDrawer.displayName = 'AgentTranscriptDrawer';
