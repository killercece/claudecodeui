import { useCallback, useEffect, useState } from 'react';

import type { ProjectSession } from '@/shared/types';

export type SessionTab = {
  id: string;
  title: string;
};

const STORAGE_KEY = 'cloudcli:sessionTabs';

function readStoredTabs(): SessionTab[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (tab): tab is SessionTab => typeof tab?.id === 'string' && typeof tab?.title === 'string',
    );
  } catch {
    return [];
  }
}

function sessionTitle(session: ProjectSession): string {
  return String(session.summary || session.title || session.name || '').trim() || 'Session';
}

/**
 * Keeps the list of open session tabs (VS Code style). A tab is added whenever a
 * session becomes the selected one, whatever opened it (sidebar, URL, new chat),
 * and the list is persisted in localStorage across reloads.
 */
export function useSessionTabs(selectedSession: ProjectSession | null) {
  const [tabs, setTabs] = useState<SessionTab[]>(readStoredTabs);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // Stockage indisponible (mode privé, quota) : les onglets restent en mémoire.
    }
  }, [tabs]);

  const selectedId = selectedSession?.id ?? null;
  const selectedTitle = selectedSession ? sessionTitle(selectedSession) : '';

  useEffect(() => {
    if (!selectedId) return;
    setTabs((previous) => {
      const existing = previous.find((tab) => tab.id === selectedId);
      if (!existing) return [...previous, { id: selectedId, title: selectedTitle }];
      if (existing.title === selectedTitle) return previous;
      return previous.map((tab) => (tab.id === selectedId ? { ...tab, title: selectedTitle } : tab));
    });
  }, [selectedId, selectedTitle]);

  /** Removes a tab and returns the tab to activate when the closed one was the active tab. */
  const closeTab = useCallback((id: string, activeId: string | null): SessionTab | null => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return null;
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    return id === activeId ? (next[index] ?? next[index - 1] ?? null) : null;
  }, [tabs]);

  /** Moves the dragged tab to the position of the target tab. */
  const moveTab = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setTabs((previous) => {
      const from = previous.findIndex((tab) => tab.id === fromId);
      const to = previous.findIndex((tab) => tab.id === toId);
      if (from === -1 || to === -1) return previous;
      const next = [...previous];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  return { tabs, closeTab, moveTab };
}
