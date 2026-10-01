import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  listClaudeSDKBackgroundWork,
  listTasksStoppedByTurn,
  pickIdleToRelease,
  queryClaudeSDK,
  stopClaudeSDKTask,
  backgroundClaudeSDKTasks,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

// Les tests historiques décrivent le comportement sans maintien du processus au repos ; ceux du
// maintien le réactivent explicitement (voir withKeepAlive).
process.env.CLAUDE_IDLE_KEEP_ALIVE_MS = '0';

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  /** The tool_use ids the runtime asked the CLI to send to the background. */
  backgrounded: Array<string | undefined>;
  /** Every user message the CLI read on its stdin, across all processes. */
  prompts: unknown[];
  /** How many CLI processes the runtime started. */
  queries: () => number;
  /** The options the runtime handed to the SDK for the latest process it started. */
  lastOptions: () => Record<string, any> | null;
  /** What the CLI answers to the initialization request (its remote_control_* flags). */
  initResult: Record<string, unknown>;
  /** The enableRemoteControl calls the runtime made, as [enabled, name]. */
  remoteControlCalls: Array<[boolean, string | undefined]>;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  const wakers: Array<() => void> = [];
  let released = false;
  let queries = 0;
  const stopped: string[] = [];
  const backgrounded: Array<string | undefined> = [];
  const remoteControlCalls: Array<[boolean, string | undefined]> = [];
  const prompts: unknown[] = [];
  const wakeAll = () => { for (const wake of wakers.splice(0)) wake(); };

  const script: Scripted = {
    emit: (message) => { queue.push(message); wakeAll(); },
    end: () => { queue.push(null); wakeAll(); },
    released: () => released,
    stopped,
    backgrounded,
    prompts,
    queries: () => queries,
    lastOptions: () => lastOptions,
    initResult: {},
    remoteControlCalls,
  };

  let lastOptions: Record<string, any> | null = null;
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    lastOptions = options as Record<string, any>;
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
      initializationResult: async () => script.initResult,
      enableRemoteControl: async (enabled: boolean, name?: string) => { remoteControlCalls.push([enabled, name]); return {}; },
      backgroundTasks: async (toolUseId?: string) => { backgrounded.push(toolUseId); return toolUseId !== 'gone'; },
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
    cwd: string;
    /** Sends another message to the same session, with a writer of its own like a new chat run has. */
    ask: (command: string, extraOptions?: Record<string, unknown>) => AskedTurn;
  }) => Promise<void>,
  startOptions: Record<string, unknown> = {},
  prepare?: (script: Scripted) => void,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  prepare?.(script);
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
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, ...startOptions }, writer as never, context);
    const ask = (command: string, extraOptions: Record<string, unknown> = {}): AskedTurn => {
      const askedSent: NormalizedMessage[] = [];
      const askedWriter = { send: (message: NormalizedMessage) => { askedSent.push(message); }, userId: null };
      return {
        done: queryClaudeSDK(command, { sessionId: SESSION_ID, cwd, ...extraOptions }, askedWriter as never, context),
        sent: askedSent,
      };
    };
    await runTest({ script, sent, done, ask, cwd });
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

test('a turn that would replace the held process is refused until the user confirms', async () => {
  await withRun(async ({ script, ask, cwd }) => {
    launchHeldWorkflow(script);
    await settle();

    // The check the client runs before sending: a model change cannot join the live process.
    assert.deepEqual(listTasksStoppedByTurn(SESSION_ID, { cwd, model: 'another-model' }).map((task) => task.taskId), ['wf1']);
    assert.deepEqual(listTasksStoppedByTurn(SESSION_ID, { cwd }), [], 'the same settings stop nothing');

    const turn = ask('switch model', { model: 'another-model' });
    await turn.done;

    assert.equal(script.queries(), 1, 'nothing was started');
    assert.equal(script.released(), false, 'the workflow keeps running');
    assert.ok(turn.sent.some((message) => message.kind === 'error'), 'the user is told why');
    assert.ok(turn.sent.some((message) => message.kind === 'complete'), 'and the run ends instead of hanging');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['wf1']]);
  });
});

test('a confirmed turn replaces the held process', async () => {
  await withRun(async ({ script, ask }) => {
    launchHeldWorkflow(script);
    await settle();

    const turn = ask('switch model', { model: 'another-model', confirmBackgroundStop: true });
    await settle();
    assert.equal(script.queries(), 2, 'the live process cannot change model, so a new one is started');
    assert.equal(script.released(), true, 'and the old one is let go');
    script.end();
    script.end();
    await turn.done;
  });
});

test('editing a message never joins the held process, whatever the settings', async () => {
  await withRun(async ({ script, ask, cwd }) => {
    launchHeldWorkflow(script);
    await settle();

    assert.deepEqual(listTasksStoppedByTurn(SESSION_ID, { cwd, resumeAnchorId: 'uuid-1' }).map((task) => task.taskId), ['wf1']);
    const refused = ask('edited text', { resumeAnchorId: 'uuid-1' });
    await refused.done;
    assert.equal(script.queries(), 1, 'a rewind is not delivered to the running process');
    assert.ok(refused.sent.some((message) => message.kind === 'error'));
    assert.equal(script.prompts.length, 1, 'the edited text never reached stdin');
  });
});

test('artifact tools are switched on for SDK sessions unless the environment says otherwise', async () => {
  const previous = process.env.CLAUDE_CODE_ARTIFACT;
  try {
    delete process.env.CLAUDE_CODE_ARTIFACT;
    await withRun(async ({ script }) => {
      await settle();
      // Without this the CLI withholds the Artifact tools from SDK-driven sessions (`sdk_default_off`).
      assert.equal(script.lastOptions()?.env?.CLAUDE_CODE_ARTIFACT, '1');
    });

    process.env.CLAUDE_CODE_ARTIFACT = '0';
    await withRun(async ({ script }) => {
      await settle();
      assert.equal(script.lastOptions()?.env?.CLAUDE_CODE_ARTIFACT, '0', 'an explicit setting is respected');
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_ARTIFACT;
    } else {
      process.env.CLAUDE_CODE_ARTIFACT = previous;
    }
  }
});

test('a foreground task of the live turn is sent to the background through the CLI', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_fg', 'Agent', { prompt: 'long job', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_fg', 'local_agent'));
    await settle();

    assert.equal(await backgroundClaudeSDKTasks(SESSION_ID, 'toolu_fg'), true);
    assert.deepEqual(script.backgrounded, ['toolu_fg'], 'the id of the blocking call reaches the CLI');
    assert.equal(await backgroundClaudeSDKTasks(SESSION_ID), true, 'without an id every foreground task goes');
    assert.equal(await backgroundClaudeSDKTasks(SESSION_ID, 'gone'), false, 'the CLI says when nothing matched');
  });
});

test('a session without a live process has nothing to send to the background', async () => {
  assert.equal(await backgroundClaudeSDKTasks('no-such-session', 'toolu_fg'), false);
});

test('thinking summaries are requested so reasoning has text to show, except for models without adaptive thinking', async () => {
  const previous = process.env.CLAUDE_THINKING_DISPLAY;
  try {
    delete process.env.CLAUDE_THINKING_DISPLAY;
    await withRun(async ({ script }) => {
      await settle();
      // Without it the API returns empty thinking blocks, for the main thread and for subagents alike.
      assert.deepEqual(script.lastOptions()?.thinking, { type: 'adaptive', display: 'summarized' });
    });

    await withRun(async ({ script }) => {
      await settle();
      assert.equal(script.lastOptions()?.thinking, undefined, 'a model that predates adaptive thinking keeps the CLI default');
    }, { model: 'claude-haiku-4-5-20251001' });

    process.env.CLAUDE_THINKING_DISPLAY = 'omitted';
    await withRun(async ({ script }) => {
      await settle();
      assert.equal(script.lastOptions()?.thinking, undefined, 'the environment can switch it off');
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_THINKING_DISPLAY;
    } else {
      process.env.CLAUDE_THINKING_DISPLAY = previous;
    }
  }
});

/** Runs `body` with the idle keep-alive set to `ms`, then puts the environment back. */
async function withKeepAlive(ms: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env.CLAUDE_IDLE_KEEP_ALIVE_MS;
  const previousRc = process.env.CLOUDCLI_REMOTE_CONTROL;
  process.env.CLAUDE_IDLE_KEEP_ALIVE_MS = ms;
  delete process.env.CLOUDCLI_REMOTE_CONTROL;
  try {
    await body();
  } finally {
    process.env.CLAUDE_IDLE_KEEP_ALIVE_MS = previous;
    if (previousRc === undefined) delete process.env.CLOUDCLI_REMOTE_CONTROL;
    else process.env.CLOUDCLI_REMOTE_CONTROL = previousRc;
  }
}

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a process whose turn left nothing running stays for the next message, which joins it', async () => {
  await withKeepAlive('60000', async () => {
    await withRun(async ({ script, sent, ask }) => {
      script.emit(init());
      script.emit(result());
      await settle();
      assert.ok(sent.some((message) => message.kind === 'complete'), 'the turn is over for the client');
      assert.equal(script.released(), false, 'the process is kept for the session\'s next message');

      const turn = ask('and then?');
      await settle();
      assert.equal(script.queries(), 1, 'the next message does not start another process');
      assert.equal(script.prompts.length, 2, 'it reached the live process');

      script.emit(result());
      await turn.done;
      assert.ok(turn.sent.some((message) => message.kind === 'complete'), 'and completes on its own writer');
      assert.equal(script.released(), false, 'the process is kept again');
    });
  });
});

test('an idle process is released once the keep-alive has run out', async () => {
  await withKeepAlive('60', async () => {
    await withRun(async ({ script }) => {
      script.emit(init());
      script.emit(result());
      await settle();
      assert.equal(script.released(), false);
      await wait(160);
      assert.equal(script.released(), true, 'nobody came back in time: the process exits');
    });
  });
});

test('with the keep-alive off the process exits as soon as the turn ends', async () => {
  await withKeepAlive('0', async () => {
    await withRun(async ({ script }) => {
      script.emit(init());
      script.emit(result());
      await settle();
      assert.equal(script.released(), true);
    });
  });
});

test('a turn asking for another model replaces the idle process', async () => {
  await withKeepAlive('60000', async () => {
    await withRun(async ({ script, ask }) => {
      script.emit(init());
      script.emit(result());
      await settle();

      const turn = ask('switch model', { model: 'another-model' });
      await settle();
      assert.equal(script.queries(), 2, 'a live process cannot change model: nothing runs, so a new one starts');
      assert.equal(script.released(), true, 'and the idle one is let go');
      script.end();
      script.end();
      await turn.done;
    });
  });
});

test('pickIdleToRelease keeps the cap and gives up the longest idle first', () => {
  const holds = new Map([
    ['recent', { since: 300 }],
    ['oldest', { since: 100 }],
    ['middle', { since: 200 }],
  ]);
  assert.deepEqual(pickIdleToRelease(holds, 3), [], 'within the cap nothing goes');
  assert.deepEqual(pickIdleToRelease(holds, 2), ['oldest']);
  assert.deepEqual(pickIdleToRelease(holds, 1), ['oldest', 'middle']);
});

test('Remote Control is enabled once per process, named after the first prompt, when the CLI asks for it', async () => {
  await withKeepAlive('60000', async () => {
    await withRun(async ({ script, ask }) => {
      await settle();
      assert.deepEqual(script.remoteControlCalls, [[true, 'hello']]);

      script.emit(init());
      script.emit(result());
      await settle();
      const turn = ask('a second message');
      await settle();
      script.emit(result());
      await turn.done;
      assert.equal(script.remoteControlCalls.length, 1, 'the second message joins the process: no second session on claude.ai');
    }, {}, (script) => { script.initResult = { remote_control_auto_enable: true, remote_control_available: true }; });
  });
});

test('Remote Control is left alone when the CLI does not ask for it, policy forbids it, or it is switched off', async () => {
  await withKeepAlive('60000', async () => {
    await withRun(async ({ script }) => {
      await settle();
      assert.deepEqual(script.remoteControlCalls, [], 'the CLI did not ask');
    }, {}, (script) => { script.initResult = { remote_control_auto_enable: false, remote_control_available: true }; });

    await withRun(async ({ script }) => {
      await settle();
      assert.deepEqual(script.remoteControlCalls, [], 'not available under the account\'s policy');
    }, {}, (script) => { script.initResult = { remote_control_auto_enable: true, remote_control_available: false }; });

    process.env.CLOUDCLI_REMOTE_CONTROL = 'off';
    await withRun(async ({ script }) => {
      await settle();
      assert.deepEqual(script.remoteControlCalls, [], 'switched off for CloudCLI');
    }, {}, (script) => { script.initResult = { remote_control_auto_enable: true, remote_control_available: true }; });
  });

  // Sans maintien du processus, un pont par message serait une session claude.ai par message.
  await withKeepAlive('0', async () => {
    await withRun(async ({ script }) => {
      await settle();
      assert.deepEqual(script.remoteControlCalls, []);
    }, {}, (script) => { script.initResult = { remote_control_auto_enable: true, remote_control_available: true }; });
  });
});

test('bridge state events from the CLI do not disturb the run', async () => {
  await withKeepAlive('60000', async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit({ type: 'system', subtype: 'bridge_state', state: 'connected', session_id: NATIVE_ID });
      script.emit(result());
      await settle();
      assert.ok(sent.some((message) => message.kind === 'complete'));
      assert.ok(!sent.some((message) => message.kind === 'error'));
    });
  });
});
