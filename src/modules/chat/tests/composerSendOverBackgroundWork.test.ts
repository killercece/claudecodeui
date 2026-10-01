import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { BackgroundTaskSummary, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A session whose turn has ended with background work still running keeps its
 * composer usable. A message sent to it joins the live process and stops
 * nothing; one that needs a new process (another model or permission mode, an
 * edited message) stops that work. The server says which case this is, and the
 * composer only asks the user when the work really would be stopped. Stopping
 * the run asks too, since it takes the background work down with it.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const TASKS: BackgroundTaskSummary[] = [
  { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'frontend-architecture-audit', startedAt: 1 },
  { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true },
  { taskId: 'a1', toolUseId: 'toolu_agent', taskType: 'local_agent', description: 'Survey the repo', startedAt: 3 },
];

const backgroundOnly: SessionActivityMap = new Map([[
  'session-1',
  { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: TASKS },
]]);

type ImpactAnswer = { tasks: BackgroundTaskSummary[] } | 'fail';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** The fetch stub: the send-impact check answers as scripted, every other call gets an empty list. */
const stubFetch = (impact: ImpactAnswer) => {
  const impactCalls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/send-impact')) {
      impactCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (impact === 'fail') {
        throw new Error('network down');
      }
      return jsonResponse({ success: true, data: impact });
    }
    return jsonResponse([]);
  }));
  return impactCalls;
};

const render = (processingSessions: SessionActivityMap, sent: Array<Record<string, unknown>>) =>
  renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      processingSessions,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as Record<string, unknown>); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

const submit = async (processingSessions: SessionActivityMap) => {
  const sent: Array<Record<string, unknown>> = [];
  const view = render(processingSessions, sent);
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  return { sends: sent.filter((message) => message.type === 'chat.send'), view };
};

const confirm = vi.fn<(message?: string) => boolean>();

beforeEach(() => {
  vi.stubGlobal('confirm', confirm);
  confirm.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a send the server says stops nothing goes through without asking', async () => {
  const impactCalls = stubFetch({ tasks: [] });
  const { sends } = await submit(backgroundOnly);

  assert.equal(impactCalls.length, 1, 'the server was asked what this send would do');
  assert.equal(confirm.mock.calls.length, 0, 'joining the live process stops nothing, so nobody is asked');
  assert.equal(sends.length, 1);
  assert.equal((sends[0]?.options as Record<string, unknown>).confirmBackgroundStop, undefined);
});

test('a send that would stop the work asks first, naming the session\'s own tasks', async () => {
  confirm.mockReturnValue(false);
  stubFetch({ tasks: TASKS });
  const { sends, view } = await submit(backgroundOnly);

  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(
    confirm.mock.calls[0]?.[0],
    'This message needs a new process, which stops the background work still running:\n'
    + '• Workflow frontend-architecture-audit\n'
    + '• Agent Survey the repo\n\n'
    + 'Anything it has not reported yet is lost. Send anyway?',
  );
  assert.equal(sends.length, 0, 'declined: nothing is sent');
  assert.equal(view.result.current.input, 'hello', 'and the draft stays in the composer');
});

test('confirming sends the message and tells the server the stop was accepted', async () => {
  confirm.mockReturnValue(true);
  stubFetch({ tasks: TASKS });
  const { sends } = await submit(backgroundOnly);

  assert.equal(sends.length, 1);
  assert.equal((sends[0]?.options as Record<string, unknown>).confirmBackgroundStop, true);
});

test('when the check cannot be made the composer asks anyway', async () => {
  confirm.mockReturnValue(false);
  stubFetch('fail');
  const { sends } = await submit(backgroundOnly);

  assert.equal(confirm.mock.calls.length, 1, 'no answer from the server: assume the work would be stopped');
  assert.equal(sends.length, 0);
});

test('a session with nothing in the background neither checks nor asks', async () => {
  const impactCalls = stubFetch({ tasks: TASKS });
  const { sends } = await submit(new Map());

  assert.equal(impactCalls.length, 0);
  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(sends.length, 1);
});

test('stopping a run with background work asks first, and only aborts once confirmed', async () => {
  stubFetch({ tasks: [] });
  const sent: Array<Record<string, unknown>> = [];
  const view = render(backgroundOnly, sent);

  confirm.mockReturnValue(false);
  act(() => { view.result.current.handleAbortSession(); });
  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(
    confirm.mock.calls[0]?.[0],
    'Stopping also stops the background work still running:\n'
    + '• Workflow frontend-architecture-audit\n'
    + '• Agent Survey the repo\n\n'
    + 'Anything it has not reported yet is lost. Stop anyway?',
  );
  assert.equal(sent.filter((message) => message.type === 'chat.abort').length, 0, 'declined: the run goes on');

  confirm.mockReturnValue(true);
  act(() => { view.result.current.handleAbortSession(); });
  assert.equal(sent.filter((message) => message.type === 'chat.abort').length, 1);
});

test('stopping a run with no background work does not ask', async () => {
  stubFetch({ tasks: [] });
  const sent: Array<Record<string, unknown>> = [];
  const view = render(new Map(), sent);

  act(() => { view.result.current.handleAbortSession(); });
  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(sent.filter((message) => message.type === 'chat.abort').length, 1);
});
