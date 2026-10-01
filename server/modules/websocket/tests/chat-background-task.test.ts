import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'running-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type BackgroundCall = { provider: string; sessionId: string; toolUseId: string | undefined };

/** A gateway whose runtime has one foreground task, started by the tool_use `toolu_fg`. */
async function withGateway(
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    calls: BackgroundCall[];
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-task-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const calls: BackgroundCall[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          backgroundTasks: async (provider: string, sessionId: string, toolUseId?: string) => {
            calls.push({ provider, sessionId, toolUseId });
            // Sans id : « tout passer en arrière-plan », vrai s'il existe une tâche au premier plan.
            return toolUseId === undefined || toolUseId === 'toolu_fg';
          },
        } as never,
      },
    );

    await runTest({ socket, calls });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.background-task sends the named foreground task to the background through the session\'s provider', async () => {
  await withGateway(async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: SESSION_ID, toolUseId: 'toolu_fg' }));
    await settle();

    // The provider comes from the session row, never from the frame.
    assert.deepEqual(calls, [{ provider: 'claude', sessionId: SESSION_ID, toolUseId: 'toolu_fg' }]);
    // The runtime reports the new state on the session's stream; nothing is echoed here.
    assert.deepEqual(socket.frames, []);
  });
});

test('without a tool use id every foreground task goes to the background', async () => {
  await withGateway(async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(calls, [{ provider: 'claude', sessionId: SESSION_ID, toolUseId: undefined }]);
    assert.deepEqual(socket.frames, []);
  });
});

test('a task that is not in the foreground is refused with NO_FOREGROUND_TASK', async () => {
  await withGateway(async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: SESSION_ID, toolUseId: 'toolu_gone' }));
    await settle();

    assert.equal(calls.length, 1);
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'protocol_error');
    assert.equal(socket.frames[0].code, 'NO_FOREGROUND_TASK');
    assert.equal(socket.frames[0].sessionId, SESSION_ID);
  });
});

test('a request without a session id never reaches the runtime', async () => {
  await withGateway(async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', toolUseId: 'toolu_fg' }));
    await settle();

    assert.equal(calls.length, 0);
    assert.equal(socket.frames[0].code, 'SESSION_ID_REQUIRED');
  });
});

test('an unknown session is refused with SESSION_NOT_FOUND', async () => {
  await withGateway(async ({ socket, calls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.background-task', sessionId: 'nope', toolUseId: 'toolu_fg' }));
    await settle();

    assert.equal(calls.length, 0);
    assert.equal(socket.frames[0].code, 'SESSION_NOT_FOUND');
  });
});
