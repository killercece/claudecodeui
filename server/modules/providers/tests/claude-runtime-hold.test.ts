import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  /** Every user message the CLI read on its stdin, across all processes. */
  prompts: unknown[];
  /** How many CLI processes the runtime started. */
  queries: () => number;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  const wakers: Array<() => void> = [];
  let released = false;
  let queries = 0;
  const stopped: string[] = [];
  const prompts: unknown[] = [];
  const wakeAll = () => { for (const wake of wakers.splice(0)) wake(); };

  const script: Scripted = {
    emit: (message) => { queue.push(message); wakeAll(); },
    end: () => { queue.push(null); wakeAll(); },
    released: () => released,
    stopped,
    prompts,
    queries: () => queries,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    queries += 1;
    void (async () => {
      for await (const message of prompt) { prompts.push(message); /* the CLI reads its stdin */ }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wakers.push(resolve); });
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async (taskId: string) => { stopped.push(taskId); },
    });
  };

  return { createQuery, script };
}

type AskedTurn = { done: Promise<unknown>; sent: NormalizedMessage[] };

async function withRun(
  runTest: (context: {
    script: Scripted;
    sent: NormalizedMessage[];
    done: Promise<unknown>;
    /** Sends another message to the same session, with a writer of its own like a new chat run has. */
    ask: (command: string, extraOptions?: Record<string, unknown>) => AskedTurn;
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    const ask = (command: string, extraOptions: Record<string, unknown> = {}): AskedTurn => {
      const askedSent: NormalizedMessage[] = [];
      const askedWriter = { send: (message: NormalizedMessage) => { askedSent.push(message); }, userId: null };
      return {
        done: queryClaudeSDK(command, { sessionId: SESSION_ID, cwd, ...extraOptions }, askedWriter as never, context),
        sent: askedSent,
      };
    };
    await runTest({ script, sent, done, ask });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

/** A turn that leaves a workflow running in the background, so the CLI is held open for it. */
function launchHeldWorkflow(script: Scripted): void {
  script.emit(init());
  script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
  script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
  script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
  script.emit(result());
}

test('a message sent while the process is held joins it instead of killing the background work', async () => {
  await withRun(async ({ script, sent, ask }) => {
    launchHeldWorkflow(script);
    await settle();
    const completesBefore = sent.filter((message) => message.kind === 'complete').length;

    const turn = ask('give me a status report');
    await settle();

    // Same process, message delivered to its stdin, nothing let go.
    assert.equal(script.queries(), 1, 'no second CLI process is started');
    assert.equal(script.prompts.length, 2, 'the message reached the live process');
    assert.equal(script.released(), false, 'stdin stays open: the workflow keeps running');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['wf1']]);

    // The reply of the turn that carried the message is streamed to its own writer.
    script.emit(result());
    await turn.done;
    assert.ok(turn.sent.some((message) => message.kind === 'complete'), 'the new turn is completed on its own writer');
    assert.equal(sent.filter((message) => message.kind === 'complete').length, completesBefore, 'the first writer hears nothing more');
    assert.equal(script.released(), false, 'the workflow is still outstanding after the report');
  });
});

test('once the background work has finished the next message starts a fresh process as before', async () => {
  await withRun(async ({ script, ask }) => {
    launchHeldWorkflow(script);
    await settle();
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the hold ended with the work');

    const turn = ask('and now?');
    await settle();
    assert.equal(script.queries(), 2, 'nothing was held, so a new process serves the message');
    script.end();
    script.end();
    await turn.done;
  });
});

test('a turn asking for different settings does not join the held process', async () => {
  await withRun(async ({ script, ask }) => {
    launchHeldWorkflow(script);
    await settle();

    const turn = ask('switch model', { model: 'another-model' });
    await settle();
    assert.equal(script.queries(), 2, 'the live process cannot change model, so a new one is started');
    script.end();
    script.end();
    await turn.done;
  });
});
