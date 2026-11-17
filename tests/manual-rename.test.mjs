import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import activate from '../main.js';

const ENGINE = 'pi';
const SESSION_ID = 'session-1';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitForSignal(promise, maxTurns = 30) {
  for (let i = 0; i < maxTurns; i++) {
    const signaled = await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => setImmediate(() => resolve(false))),
    ]);
    if (signaled) return true;
  }
  return false;
}

function createDatabase(dbPath, { customTitle, workspacePath = '' }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      engine TEXT,
      session_id TEXT,
      title TEXT,
      custom_title TEXT,
      message_count INTEGER,
      workspace_path TEXT,
      updated_at TEXT
    );
    CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY,
      engine TEXT,
      session_id TEXT,
      role TEXT,
      text TEXT
    );
  `);
  db.prepare(`INSERT INTO sessions
    (engine, session_id, title, custom_title, message_count, workspace_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(ENGINE, SESSION_ID, '默认标题', customTitle ?? null, 1, workspacePath, '2026-11-17');
  db.prepare(`INSERT INTO session_messages (engine, session_id, role, text)
    VALUES (?, ?, 'user', ?)`)
    .run(ENGINE, SESSION_ID, '请帮我优化会话命名插件');
  db.close();
}

function readCustomTitle(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT custom_title FROM sessions WHERE engine = ? AND session_id = ?')
    .get(ENGINE, SESSION_ID);
  db.close();
  return row.custom_title;
}

function writeCustomTitle(dbPath, title) {
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE sessions SET custom_title = ? WHERE engine = ? AND session_id = ?')
    .run(title, ENGINE, SESSION_ID);
  db.close();
}

function makeHost({ dbPath, dataDir, config, runAi }) {
  const ready = deferred();
  const firstRead = deferred();
  const secondWorker = deferred();
  const refreshed = deferred();
  let refreshCount = 0;
  const refreshWaiters = [];
  const menuItems = new Map();
  const stored = { config };
  const eventHandlers = new Map();

  const ctx = {
    react: {
      createElement: () => null,
      useState: () => [null, () => {}],
      useEffect: () => {},
    },
    events: {
      on: (name, handler) => { eventHandlers.set(name, handler); return () => eventHandlers.delete(name); },
    },
    storage: {
      get: async (key) => stored[key],
      set: async (key, value) => { stored[key] = value; },
    },
    documentStorage: {
      getLocation: async () => { ready.resolve(); return { path: dataDir }; },
      readText: async () => null,
      writeTextAtomic: async () => {},
    },
    bridge: {
      invoke: async (command, payload) => {
        if (command === 'plugin_exec_kill') return { killed: 0 };
        if (command !== 'plugin_exec_run') throw new Error('Unexpected bridge call: ' + command);

        if (payload.bin === 'node') {
          const result = spawnSync(process.execPath, payload.args, {
            encoding: 'utf8',
            env: { ...process.env, CCGUI_TITLE_DB: dbPath },
          });
          if (result.error) throw result.error;
          const parsed = JSON.parse(result.stdout);
          const scriptPayload = JSON.parse(payload.args[1].match(/\nrun\((.+)\);$/s)[1]);
          if (scriptPayload.cmd === 'read') firstRead.resolve(parsed);
          if (scriptPayload.cmd === 'write') secondWorker.resolve(parsed);
          return { code: result.status, stdout: result.stdout, stderr: result.stderr };
        }

        if (runAi) return runAi(payload);
        throw new Error('Unexpected naming engine: ' + payload.bin);
      },
    },
    sessions: { refresh: async () => {
      refreshCount++;
      refreshed.resolve();
      for (let i = refreshWaiters.length - 1; i >= 0; i--) {
        if (refreshCount >= refreshWaiters[i].count) {
          refreshWaiters[i].waiter.resolve();
          refreshWaiters.splice(i, 1);
        }
      }
    } },
    ui: {
      registerStatusBarItem: () => () => {},
      registerSessionMenuItem: (item) => { menuItems.set(item.key, item); return () => {}; },
      registerCommand: () => () => {},
      registerSettingsSection: () => () => {},
      openSettings: () => {},
    },
  };

  const dispose = activate(ctx);
  const host = {
    ready: ready.promise, firstRead: firstRead.promise, secondWorker: secondWorker.promise,
    refreshed: refreshed.promise, rename: menuItems.get('smart-session-title.rename').run,
    clear: (target) => {
      const before = refreshCount;
      menuItems.get('smart-session-title.clear').run(target);
      return host.waitForRefreshes(before + 1);
    },
    waitForRefreshes: (count) => {
      if (refreshCount >= count) return Promise.resolve();
      const waiter = deferred();
      refreshWaiters.push({ count, waiter });
      return waiter.promise;
    },
    emit: (name, event) => eventHandlers.get(name)?.(event),
    hasNamedState: () => Object.hasOwn(stored, 'named'),
    dispose };
  return host;
}

async function withDatabase(t, initialState, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'smart-session-title-'));
  const dbPath = path.join(dir, 'app.db');
  createDatabase(dbPath, initialState);
  const host = makeHost({
    dbPath,
    dataDir: dir,
    config: options.config ?? { mode: 'local', emoji: false },
    runAi: options.runAi,
  });
  t.after(() => {
    host.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.ready;
  return { dbPath, host };
}

test('manual rename replaces an existing custom title without a per-session record', async (t) => {
  const previousTitle = '之前的标题';
  const { dbPath, host } = await withDatabase(t, { customTitle: previousTitle });

  host.rename({ engine: ENGINE, sessionId: SESSION_ID });
  const write = await Promise.race([
    host.secondWorker,
    new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);

  assert.ok(write, 'manual naming should write a replacement title');
  assert.notEqual(readCustomTitle(dbPath), previousTitle);
  assert.equal(host.hasNamedState(), false);
});

test('automatic naming titles a new session without persisting per-session records', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { dbPath, host } = await withDatabase(t, { customTitle: null });

  host.emit('usage://updated', { engine: ENGINE, sessionId: SESSION_ID });
  t.mock.timers.tick(8000);
  await host.refreshed;
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(readCustomTitle(dbPath));
  assert.equal(host.hasNamedState(), false);
});

test('automatic naming leaves a session with an existing custom title unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const userTitle = '用户设置的标题';
  const { dbPath, host } = await withDatabase(t, { customTitle: userTitle });

  host.emit('usage://updated', { engine: ENGINE, sessionId: SESSION_ID });
  t.mock.timers.tick(8000);
  await host.firstRead;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(readCustomTitle(dbPath), userTitle);
});

test('manual rename overwrites a title changed while AI is generating', async (t) => {
  const aiStarted = deferred();
  const aiResult = deferred();
  const { dbPath, host } = await withDatabase(t,
    { customTitle: null, workspacePath: 'C:\\project' },
    {
      config: { mode: 'ai', emoji: false },
      runAi: async () => { aiStarted.resolve(); return aiResult.promise; },
    });

  host.rename({ engine: ENGINE, sessionId: SESSION_ID });
  await aiStarted.promise;
  writeCustomTitle(dbPath, '生成期间用户改的标题');
  aiResult.resolve({ code: 0, stdout: '新的 AI 标题', stderr: '' });
  await host.secondWorker;
  await host.waitForRefreshes(1);

  // 手动点「AI 重新起名」= 明确要求覆盖，不能因 CAS 未命中而静默丢弃。
  assert.equal(readCustomTitle(dbPath), '新的 AI 标题');
});

test('automatic rename still skips when the title changed during AI generation', async (t) => {
  const aiStarted = deferred();
  const aiResult = deferred();
  const { dbPath, host } = await withDatabase(t,
    { customTitle: null, workspacePath: 'C:\\project' },
    {
      config: { mode: 'ai', emoji: false },
      runAi: async () => { aiStarted.resolve(); return aiResult.promise; },
    });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  host.emit('usage://updated', { engine: ENGINE, sessionId: SESSION_ID });
  t.mock.timers.tick(8000);
  await aiStarted.promise;
  const concurrentUserTitle = '生成期间用户改的标题';
  writeCustomTitle(dbPath, concurrentUserTitle);
  aiResult.resolve({ code: 0, stdout: '新的 AI 标题', stderr: '' });
  await host.secondWorker;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(readCustomTitle(dbPath), concurrentUserTitle);
});

test('restoring the default title cancels a pending manual rename', { timeout: 4000 }, async (t) => {
  const firstAiStarted = deferred();
  const firstAiResult = deferred();
  let aiCalls = 0;
  const { dbPath, host } = await withDatabase(t,
    { customTitle: null, workspacePath: 'C:\\project' },
    {
      config: { mode: 'ai', emoji: false },
      runAi: async () => {
        aiCalls++;
        if (aiCalls === 1) { firstAiStarted.resolve(); return firstAiResult.promise; }
        throw new Error('Manual naming should have been cancelled');
      },
    });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  host.emit('usage://updated', { engine: ENGINE, sessionId: SESSION_ID });
  t.mock.timers.tick(8000);
  await firstAiStarted.promise;

  host.rename({ engine: ENGINE, sessionId: SESSION_ID });  // 排队中的手动重命名
  await host.clear({ engine: ENGINE, sessionId: SESSION_ID });  // 用户改主意
  assert.equal(readCustomTitle(dbPath), null);

  firstAiResult.resolve({ code: 0, stdout: '自动命名结果', stderr: '' });
  // 等自动任务的收尾（不能等真实超时：setTimeout 已被 mock）
  for (let i = 0; i < 50 && aiCalls === 1; i++) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(aiCalls, 1, 'the pending manual rename must not run after restore');
  // 正在进行的那次自动命名可能先写入自己的结果；重点是手动重命名不再跑、不再盖一次。
  assert.equal(readCustomTitle(dbPath), '自动命名结果');
});

test('manual rename requested during automatic naming runs after the automatic job', { timeout: 4000 }, async (t) => {
  const firstAiStarted = deferred();
  const firstAiResult = deferred();
  const secondAiStarted = deferred();
  const secondAiResult = deferred();
  let aiCalls = 0;
  const { dbPath, host } = await withDatabase(t,
    { customTitle: null, workspacePath: 'C:\\project' },
    {
      config: { mode: 'ai', emoji: false },
      runAi: async () => {
        aiCalls++;
        if (aiCalls === 1) { firstAiStarted.resolve(); return firstAiResult.promise; }
        if (aiCalls === 2) { secondAiStarted.resolve(); return secondAiResult.promise; }
        throw new Error('Unexpected duplicate naming call');
      },
    });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  host.emit('usage://updated', { engine: ENGINE, sessionId: SESSION_ID });
  t.mock.timers.tick(8000);
  await firstAiStarted.promise;

  host.rename({ engine: ENGINE, sessionId: SESSION_ID });
  assert.equal(aiCalls, 1, 'manual naming must not start concurrently with the automatic job');
  assert.equal(await waitForSignal(secondAiStarted.promise, 5), false,
    'the second AI call must wait for the automatic job to finish');
  firstAiResult.resolve({ code: 0, stdout: '自动命名结果', stderr: '' });
  await host.waitForRefreshes(1);
  assert.equal(await waitForSignal(secondAiStarted.promise), true,
    'the pending manual rename should start after the automatic job');

  secondAiResult.resolve({ code: 0, stdout: '手动重新命名结果', stderr: '' });
  await host.waitForRefreshes(2);

  assert.equal(aiCalls, 2);
  assert.equal(readCustomTitle(dbPath), '手动重新命名结果');
});
