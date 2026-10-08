import { useCallback, useEffect, useState } from 'react';

import type { ProjectSession } from '@/shared/types';
import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';

export type SessionTab = {
  id: string;
  title: string;
};

function readStoredTabs(): SessionTab[] {
  const parsed = readUserPreference<unknown>('sessionTabs', []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (tab): tab is SessionTab => typeof tab?.id === 'string' && typeof tab?.title === 'string',
  );
}

function sessionTitle(session: ProjectSession): string {
  return String(session.summary || session.title || session.name || '').trim() || 'Session';
}

/**
 * Keeps the list of open session tabs (VS Code style). A tab is added whenever a
 * session becomes the selected one, whatever opened it (sidebar, URL, new chat),
 * and the list is persisted in the user's server-side preferences.
 */
export function useSessionTabs(selectedSession: ProjectSession | null) {
  const [tabs, setTabs] = useState<SessionTab[]>(readStoredTabs);

  // Les onglets vivent côté serveur : ils suivent l'utilisateur d'un navigateur à l'autre.
  useEffect(() => {
    writeUserPreference('sessionTabs', tabs);
  }, [tabs]);

  // Adopte la copie du serveur quand elle arrive (hydratation) ou change.
  useEffect(() => subscribeToUserPreferences(() => {
    const stored = readStoredTabs();
    setTabs((previous) => (JSON.stringify(previous) === JSON.stringify(stored) ? previous : stored));
  }), []);

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
