'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { WebSocket } = require('../server/node_modules/ws');
const { createStudyServer } = require('../server/src/index.cjs');
const { createStudyClient } = require('../src/main/study-client.cjs');
const { createInitialState, applyStudyReceipt } = require('../src/shared/state.cjs');
const BASE = 1_800_000_000_000;
function directory(label) { const value = path.resolve(__dirname, '../artifacts', `study-client-${label}-${randomUUID()}`); fs.mkdirSync(value, { recursive: true }); return value; }
async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for study client state');
}
function encryption() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const result = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), result]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); } };
}
function person(url, nickname, overrides = {}) {
  const root = directory(nickname); let state = createInitialState(BASE); const events = []; const greetings = [];
  const security = encryption(); let settlements = 0;
  const settings = { directory: root, WebSocket, getState: () => state, ...security,
    settle(receipt) { const result = applyStudyReceipt(state, receipt, BASE); fs.writeFileSync(path.join(root, 'local-state.json'), JSON.stringify(result.state)); state = result.state; settlements++; },
    onUpdate(value) { events.push(value); }, onGreeting(value) { greetings.push(value); }, ...overrides };
  const client = createStudyClient(settings); client.saveStudyConfig({ serverUrl: url, nickname });
  return { client, root, settings, events, greetings, state: () => state, setState(value) { state = value; }, settlements: () => settlements,
    recreate() { return createStudyClient(settings); } };
}

test('two main-process clients communicate, store encrypted credentials and settle a completed round once across restart', async (t) => {
  let clock = BASE; const server = createStudyServer({ port: 0, dataDirectory: directory('server'), now: () => clock });
  const { url } = await server.start(); const first = person(url, '甲'); const second = person(url, '乙'); const third = person(url, '丙');
  let restarted;
  t.after(async () => { first.client.close(); second.client.close(); third.client.close(); restarted?.close(); await server.close(); });
  const created = await first.client.connectStudy({ mode: 'create', goal: '读完第一章' });
  const code = created.room.code; await second.client.connectStudy({ mode: 'join', code, goal: '写读书笔记' });
  await assert.rejects(third.client.connectStudy({ mode: 'join', code }), { code: 'ROOM_FULL' });
  await first.client.studyCommand({ type: 'message', text: '一起开始吧' });
  await until(() => second.client.getStudyState().room.messages.length === 1);
  await second.client.studyCommand({ type: 'greet' }); await until(() => first.greetings.length === 1);
  await first.client.studyCommand({ type: 'ready', ready: true }); await second.client.studyCommand({ type: 'ready', ready: true });
  await first.client.studyCommand({ type: 'start', minutes: 1 }); clock += 60_000; server.tick();
  await until(() => first.state().stats.energy === 5 && second.state().stats.energy === 5);
  await until(() => !JSON.parse(fs.readFileSync(path.join(first.root, 'local-state.json'))).session);
  assert.equal(first.state().studyReceipts.length, 1); assert.equal(second.state().studyReceipts.length, 1);
  assert.equal(first.client.getStudyConfig().credentialStorage, 'encrypted');
  const encoded = JSON.parse(fs.readFileSync(path.join(first.root, 'identity.json')));
  assert.equal(typeof encoded.encrypted, 'string');
  const decoded = JSON.parse(first.settings.decryptString(Buffer.from(encoded.encrypted, 'base64')));
  assert.ok(!JSON.stringify(first.events).includes(decoded.token));
  assert.ok(!fs.readFileSync(path.join(first.root, 'identity.json'), 'utf8').includes(decoded.token));
  first.client.close(); restarted = first.recreate(); await restarted.connectStudy({ mode: 'join', code });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(first.state().stats.energy, 5); assert.equal(first.state().stats.totalFocusMs, 60_000);
  await second.client.leaveStudy(); await until(() => restarted.getStudyState().room.members.length === 1);
});

test('pending receipt survives local save failure and is retried after encrypted reconnect without double reward', async (t) => {
  let clock = BASE; let failures = 1;
  const server = createStudyServer({ port: 0, dataDirectory: directory('save-retry'), now: () => clock }); const { url } = await server.start();
  const first = person(url, '甲'); const originalSettle = first.settings.settle;
  first.client.close(); first.settings.settle = (receipt) => { if (failures-- > 0) throw new Error('fixture disk failure'); return originalSettle(receipt); };
  first.client = first.recreate(); const second = person(url, '乙'); let retry;
  t.after(async () => { first.client.close(); second.client.close(); retry?.close(); await server.close(); });
  const code = (await first.client.connectStudy({ mode: 'create' })).room.code;
  await second.client.connectStudy({ mode: 'join', code });
  await first.client.studyCommand({ type: 'ready', ready: true }); await second.client.studyCommand({ type: 'ready', ready: true });
  await first.client.studyCommand({ type: 'start', minutes: 1 }); clock += 60_000; server.tick();
  await until(() => first.client.getStudyState().error?.includes('尚未保存'));
  assert.equal(first.state().stats.energy, 0);
  first.client.close(); retry = first.recreate(); await retry.connectStudy({ mode: 'join', code });
  await until(() => first.state().stats.energy === 5);
  assert.equal(first.state().studyReceipts.length, 1); assert.equal(first.state().stats.totalFocusMs, 60_000);
});

test('offline client is inert and personal focus blocks join and preparation without silently overwriting it', async (t) => {
  const server = createStudyServer({ port: 0, dataDirectory: directory('mutual') }); const { url } = await server.start();
  const first = person(url, '甲'); const second = person(url, '乙', { isEncryptionAvailable: () => false });
  t.after(async () => { first.client.close(); second.client.close(); await server.close(); });
  assert.equal(first.client.getStudyState().connection, 'disconnected'); assert.equal(first.client.getStudyState().room, null);
  first.setState({ ...createInitialState(BASE), session: { status: 'paused' } });
  await assert.rejects(first.client.connectStudy({ mode: 'create' }), { code: 'PERSONAL_FOCUS_ACTIVE' });
  first.setState(createInitialState(BASE)); const code = (await first.client.connectStudy({ mode: 'create' })).room.code;
  await second.client.connectStudy({ mode: 'join', code });
  assert.equal(second.client.getStudyConfig().credentialStorage, 'session');
  assert.equal(fs.existsSync(path.join(second.root, 'identity.json')), false);
  second.setState({ ...createInitialState(BASE), session: { status: 'running' } });
  await assert.rejects(second.client.studyCommand({ type: 'ready', ready: true }), { code: 'PERSONAL_FOCUS_ACTIVE' });
  assert.equal(second.state().session.status, 'running');
  await assert.rejects(first.client.studyCommand({ type: 'start', minutes: 1 }), { code: 'NOT_READY' });
});

test('explicit leave ends active round with effective time and frees the seat', async (t) => {
  let clock = BASE; const server = createStudyServer({ port: 0, dataDirectory: directory('leave'), now: () => clock }); const { url } = await server.start();
  const first = person(url, '甲'); const second = person(url, '乙');
  t.after(async () => { first.client.close(); second.client.close(); await server.close(); });
  const code = (await first.client.connectStudy({ mode: 'create' })).room.code; await second.client.connectStudy({ mode: 'join', code });
  await first.client.studyCommand({ type: 'ready', ready: true }); await second.client.studyCommand({ type: 'ready', ready: true }); await first.client.studyCommand({ type: 'start', minutes: 1 });
  clock += 17_000; await first.client.leaveStudy();
  await until(() => second.state().stats.totalFocusMs === 17_000);
  assert.equal(first.state().stats.totalFocusMs, 17_000); assert.equal(first.state().stats.energy, 0); assert.equal(second.state().stats.energy, 0);
  assert.equal(second.client.getStudyState().room.hostId, second.client.getStudyState().selfId);
  assert.equal(first.client.getStudyState().room, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.root, 'identity.json'))).encrypted, null);
});

test('two clients automatically reconnect after service restart and the shared timer remains paused', async (t) => {
  let clock = BASE; const dataDirectory = directory('auto-reconnect');
  let server = createStudyServer({ port: 0, dataDirectory, now: () => clock });
  const address = await server.start(); const first = person(address.url, '甲'); const second = person(address.url, '乙');
  t.after(async () => { first.client.close(); second.client.close(); await server.close(); });
  const code = (await first.client.connectStudy({ mode: 'create' })).room.code; await second.client.connectStudy({ mode: 'join', code });
  await first.client.studyCommand({ type: 'ready', ready: true }); await second.client.studyCommand({ type: 'ready', ready: true }); await first.client.studyCommand({ type: 'start', minutes: 1 });
  clock += 15_000; await server.close();
  await until(() => first.client.getStudyState().connection === 'reconnecting' && second.client.getStudyState().connection === 'reconnecting');
  clock += 30_000; server = createStudyServer({ port: address.port, dataDirectory, now: () => clock }); await server.start();
  await until(() => first.client.getStudyState().connection === 'connected' && second.client.getStudyState().connection === 'connected', 5000);
  assert.equal(first.client.getStudyState().room.round.status, 'paused');
  assert.equal(second.client.getStudyState().room.round.remainingMs, 45_000);
  assert.ok(first.client.getStudyState().room.members.every((member) => member.online && !member.ready));
  await assert.rejects(first.client.studyCommand({ type: 'resume' }), { code: 'NOT_READY' });
});

test('a save-failed authenticated receipt survives explicit leave and recovers locally without a connection', async (t) => {
  let clock = BASE; const server = createStudyServer({ port: 0, dataDirectory: directory('offline-receipt'), now: () => clock });
  const { url } = await server.start(); const first = person(url, '甲'); const second = person(url, '乙');
  const originalSettle = first.settings.settle; first.client.close(); first.settings.settle = () => { throw new Error('fixture disk failure'); };
  first.client = first.recreate(); let recovered;
  t.after(async () => { first.client.close(); second.client.close(); recovered?.close(); await server.close(); });
  const code = (await first.client.connectStudy({ mode: 'create' })).room.code; await second.client.connectStudy({ mode: 'join', code });
  await first.client.studyCommand({ type: 'ready', ready: true }); await second.client.studyCommand({ type: 'ready', ready: true }); await first.client.studyCommand({ type: 'start', minutes: 1 });
  clock += 60_000; server.tick(); await until(() => first.client.getStudyState().error?.includes('尚未保存'));
  await first.client.leaveStudy(); first.client.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.root, 'receipts.json'))).pending.length, 1);
  first.settings.settle = originalSettle; recovered = first.recreate(); await until(() => first.state().stats.energy === 5);
  assert.equal(recovered.getStudyState().connection, 'disconnected'); assert.equal(recovered.getStudyState().room, null);
  assert.equal(first.state().studyReceipts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.root, 'receipts.json'))).pending.length, 0);
});
