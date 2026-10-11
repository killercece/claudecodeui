import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useProcessingSessions } from '@/shared/context/SessionProtectionContext';
import { cn } from '@/shared/utils';
import type { SessionTab } from '@/modules/project-workspace/hooks/useSessionTabs';

type SessionTabsBarProps = {
  tabs: SessionTab[];
  /** Id of the session shown in the chat, or null while a new session is being drafted. */
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (fromId: string, toId: string) => void;
  onNew: () => void;
};

const TAB_BASE =
  'group relative flex h-8 min-w-[8rem] max-w-[15rem] flex-shrink-0 select-none items-center gap-2 rounded-t-lg border border-b-0 px-3 text-[13px] outline-none transition-colors';
const TAB_ACTIVE = '-mb-px border-border/70 bg-background font-medium text-foreground';
const TAB_INACTIVE =
  'cursor-pointer border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground';

/** Rendered by WorkspaceMain under the header: one closable, draggable tab per open session. */
export default function SessionTabsBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onMove,
  onNew,
}: SessionTabsBarProps) {
  const { t } = useTranslation();
  const processingSessions = useProcessingSessions();
  const draggedId = useRef<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const newLabel = t('sessionTabs.new', { defaultValue: 'New session' });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Les onglets qui dépassent restent atteignables : flèches, molette, et
  // l'onglet actif est toujours ramené dans la zone visible.
  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabs.length, updateOverflow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || activeId === null) return;
    const active = Array.from(el.children).find(
      (child) => (child as HTMLElement).dataset.tabId === activeId,
    ) as HTMLElement | undefined;
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    updateOverflow();
  }, [activeId, tabs.length, updateOverflow]);

  const scrollByPage = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.7, behavior: 'smooth' });
  };

  return (
    <div
      role="tablist"
      aria-label={t('sessionTabs.label', { defaultValue: 'Open sessions' })}
      className="flex flex-shrink-0 items-end gap-1 border-b border-border/70 bg-muted/20 px-2 pt-1.5"
    >
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scrollByPage(-1)}
          aria-label={t('sessionTabs.scrollLeft', { defaultValue: 'Scroll tabs left' })}
          className="mb-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={updateOverflow}
        onWheel={(event) => {
          // La molette verticale fait défiler la barre horizontalement.
          if (event.deltaX === 0 && scrollRef.current) scrollRef.current.scrollLeft += event.deltaY;
        }}
        className="scrollbar-hide flex min-w-0 items-end gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          const isRunning = processingSessions.has(tab.id);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              draggable
              title={tab.title}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(tab.id);
                }
              }}
              onAuxClick={(event) => {
                // Clic molette : ferme l'onglet, comme dans VS Code.
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab.id);
                }
              }}
              onDragStart={(event) => {
                draggedId.current = tab.id;
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (!draggedId.current) return;
                event.preventDefault();
                setDropTargetId(tab.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedId.current) onMove(draggedId.current, tab.id);
                draggedId.current = null;
                setDropTargetId(null);
              }}
              onDragEnd={() => {
                draggedId.current = null;
                setDropTargetId(null);
              }}
              className={cn(
                TAB_BASE,
                isActive ? TAB_ACTIVE : TAB_INACTIVE,
                dropTargetId === tab.id && draggedId.current !== tab.id && 'ring-2 ring-primary/50',
              )}
            >
              {isActive && (
                <span className="absolute inset-x-2 top-0 h-0.5 rounded-b bg-primary" aria-hidden="true" />
              )}
              {isRunning && (
                <span
                  className="relative flex h-2 w-2 flex-shrink-0"
                  aria-label={t('sessionTabs.running', { defaultValue: 'Running' })}
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={t('sessionTabs.close', { defaultValue: 'Close tab' })}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground',
                  isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {activeId === null && (
          <div role="tab" aria-selected className={cn(TAB_BASE, TAB_ACTIVE, 'italic')}>
            <span className="absolute inset-x-2 top-0 h-0.5 rounded-b bg-primary" aria-hidden="true" />
            <span className="truncate">{newLabel}</span>
          </div>
        )}
      </div>

      {canScrollRight && (
        <button
          type="button"
          onClick={() => scrollByPage(1)}
          aria-label={t('sessionTabs.scrollRight', { defaultValue: 'Scroll tabs right' })}
          className="mb-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      <button
        type="button"
        onClick={onNew}
        aria-label={newLabel}
        title={newLabel}
        className="mb-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
