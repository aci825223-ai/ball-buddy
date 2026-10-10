'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { createStudyServer } = require('../src/index.cjs');
const BASE = 1_800_000_000_000;

function directory(label) { const value = path.resolve(__dirname, '../../artifacts', `study-${label}-${randomUUID()}`); fs.mkdirSync(value, { recursive: true }); return value; }
async function until(check, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = check(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for protocol event');
}
async function peer(url) {
  const socket = new WebSocket(url); const events = []; const pending = new Map();
  socket.on('message', (buffer) => {
    const event = JSON.parse(buffer); events.push(event);
    if (event.type === 'result') {
      const task = pending.get(event.requestId); if (!task) return;
      pending.delete(event.requestId); clearTimeout(task.timer);
      if (event.ok) task.resolve(event.data); else task.reject(Object.assign(new Error(event.error), { code: event.code }));
    }
  });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  function request(type, fields = {}) {
    const requestId = `req_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Request timeout')), 2000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ version: 1, type, requestId, ...fields }));
    });
  }
  return { socket, events, request,
    auth(payload) { return request('auth', { payload }); },
    command(payload, commandId = `cmd_${randomUUID()}`) { return request('command', { payload, commandId }); },
    latest() { return [...events].reverse().find((event) => event.type === 'snapshot'); },
    async close() { if (socket.readyState === 3) return; await new Promise((resolve) => { socket.once('close', resolve); socket.terminate(); }); },
  };
}
async function setup(t, label) {
  let clock = BASE;
  const dataDirectory = directory(label);
  const server = createStudyServer({ host: '127.0.0.1', port: 0, dataDirectory, now: () => clock, tickMs: 1000 });
  const address = await server.start(); const peers = [];
  t.after(async () => { for (const person of peers) await person.close(); await server.close(); });
  async function createPeer() { const result = await peer(address.url); peers.push(result); return result; }
  return { server, address, dataDirectory, createPeer, setTime(value) { clock = value; server.tick(); } };
}
async function two(t, label) {
  const context = await setup(t, label);
  const first = await context.createPeer(); const created = await first.auth({ mode: 'create', nickname: '甲', goal: '阅读' });
  const second = await context.createPeer(); const joined = await second.auth({ mode: 'join', code: created.room.code, nickname: '乙', goal: '写作' });
  await until(() => first.latest()?.room.members.length === 2);
  return { ...context, first, second, created, joined };
}

test('packaged standalone and client share identical versioned protocol', () => {
  assert.equal(fs.readFileSync(path.resolve(__dirname, '../../src/shared/study-protocol.cjs'), 'utf8'),
    fs.readFileSync(path.resolve(__dirname, '../src/protocol.cjs'), 'utf8'));
});

test('room capacity, authentication, readiness, host permissions and credentials never enter snapshots', async (t) => {
  const { first, second, created, joined, createPeer, dataDirectory } = await two(t, 'auth');
  const third = await createPeer();
  await assert.rejects(third.command({ type: 'message', text: 'unauth' }), { code: 'NOT_AUTHENTICATED' });
  await assert.rejects(third.auth({ mode: 'join', code: created.room.code, nickname: '丙' }), { code: 'ROOM_FULL' });
  await assert.rejects(third.auth({ mode: 'resume', token: `${'a'.repeat(43)}` }), { code: 'AUTH_FAILED' });
  await assert.rejects(first.command({ type: 'start', minutes: 1 }), { code: 'NOT_READY' });
  await first.command({ type: 'ready', ready: true }); await second.command({ type: 'ready', ready: true });
  await assert.rejects(second.command({ type: 'start', minutes: 1 }), { code: 'HOST_REQUIRED' });
  await first.command({ type: 'start', minutes: 1 });
  await until(() => second.latest()?.room.round?.status === 'running');
  assert.equal(first.latest().room.round.endAt, second.latest().room.round.endAt);
  const snapshots = JSON.stringify([...first.events, ...second.events].filter((event) => event.type === 'snapshot'));
  assert.ok(!snapshots.includes(created.token)); assert.ok(!snapshots.includes(joined.token)); assert.ok(!snapshots.includes('tokenHash'));
  const stored = fs.readFileSync(path.join(dataDirectory, 'rooms.json'), 'utf8');
  assert.ok(!stored.includes(created.token)); assert.ok(stored.includes('tokenHash'));
});

test('message and greeting have server ids, deduplication and separate rate gates', async (t) => {
  const { first, second } = await two(t, 'messages');
  const commandId = `cmd_${randomUUID()}`;
  await first.command({ type: 'message', text: '<b>只是文本</b>' }, commandId);
  await first.command({ type: 'message', text: 'duplicate ignored' }, commandId);
  await until(() => second.latest()?.room.messages.length === 1);
  assert.equal(second.latest().room.messages[0].text, '<b>只是文本</b>');
  await first.command({ type: 'greet' });
  await until(() => second.events.some((event) => event.greeting));
  await assert.rejects(first.command({ type: 'greet' }), { code: 'RATE_LIMITED' });
  for (let index = 0; index < 4; index++) await first.command({ type: 'message', text: `消息 ${index}` });
  await assert.rejects(first.command({ type: 'message', text: 'too fast' }), { code: 'RATE_LIMITED' });
  assert.equal(first.latest().room.messages.length, 5);
  await assert.rejects(second.command({ type: 'message', text: '\0坏消息' }), { code: 'INVALID_INPUT' });
});

test('disconnect pauses at actual active time; reconnect requires fresh preparation; terminal receipts are durable and per member', async (t) => {
  const { first, second, joined, createPeer, setTime, server, dataDirectory } = await two(t, 'reconnect');
  await first.command({ type: 'ready', ready: true }); await second.command({ type: 'ready', ready: true }); await first.command({ type: 'start', minutes: 1 });
  setTime(BASE + 12_000); await second.close();
  await until(() => first.latest()?.room.round?.status === 'paused');
  assert.equal(first.latest().room.round.activeMs, 12_000); assert.equal(first.latest().room.round.remainingMs, 48_000);
  setTime(BASE + 70_000);
  const resumed = await createPeer(); const auth = await resumed.auth({ mode: 'resume', token: joined.token });
  assert.equal(auth.selfId, joined.selfId);
  await assert.rejects(first.command({ type: 'resume' }), { code: 'NOT_READY' });
  await first.command({ type: 'ready', ready: true }); await resumed.command({ type: 'ready', ready: true }); await first.command({ type: 'resume' });
  setTime(BASE + 118_000);
  await until(() => first.events.some((event) => event.type === 'receipt'));
  await until(() => resumed.events.some((event) => event.type === 'receipt'));
  const firstReceipt = first.events.find((event) => event.type === 'receipt').receipt;
  const secondReceipt = resumed.events.find((event) => event.type === 'receipt').receipt;
  assert.equal(firstReceipt.status, 'completed'); assert.equal(firstReceipt.activeMs, 60_000);
  assert.equal(firstReceipt.roundId, secondReceipt.roundId); assert.notEqual(firstReceipt.memberId, secondReceipt.memberId);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'rooms.json')));
  assert.equal(stored.rooms[0].round.status, 'completed');
  server.tick(); assert.equal(first.latest().room.round.activeMs, 60_000);
});

test('seat timeout stops the shared round and remaining member takes host without rewarding completion', async (t) => {
  const { first, second, joined, setTime } = await two(t, 'expiry');
  await first.command({ type: 'ready', ready: true }); await second.command({ type: 'ready', ready: true }); await first.command({ type: 'start', minutes: 1 });
  setTime(BASE + 8000); await first.close();
  await until(() => second.latest()?.room.round?.status === 'paused');
  setTime(BASE + 98_000);
  await until(() => second.latest()?.room.round?.status === 'stopped');
  assert.equal(second.latest().room.hostId, joined.selfId); assert.equal(second.latest().room.members.length, 1);
  const receipt = second.events.find((event) => event.type === 'receipt').receipt;
  assert.equal(receipt.activeMs, 8000); assert.equal(receipt.status, 'stopped');
});

test('service restart resumes paused and never charges downtime; pending settlement remains retrievable', async (t) => {
  let clock = BASE; const dataDirectory = directory('restart');
  let server = createStudyServer({ port: 0, dataDirectory, now: () => clock }); let address = await server.start();
  let first = await peer(address.url); const created = await first.auth({ mode: 'create', nickname: '甲' });
  let second = await peer(address.url); const joined = await second.auth({ mode: 'join', code: created.room.code, nickname: '乙' });
  await first.command({ type: 'ready', ready: true }); await second.command({ type: 'ready', ready: true }); await first.command({ type: 'start', minutes: 1 });
  clock += 9000; await server.close(); await first.close(); await second.close(); clock += 600_000;
  server = createStudyServer({ port: 0, dataDirectory, now: () => clock }); address = await server.start();
  first = await peer(address.url); second = await peer(address.url);
  t.after(async () => { await first.close(); await second.close(); await server.close(); });
  const restored = await first.auth({ mode: 'resume', token: created.token }); await second.auth({ mode: 'resume', token: joined.token });
  assert.equal(restored.room.round.status, 'paused'); assert.equal(restored.room.round.activeMs, 9000);
  assert.equal(restored.room.round.remainingMs, 51_000);
  await first.command({ type: 'ready', ready: true }); await second.command({ type: 'ready', ready: true }); await first.command({ type: 'resume' });
  clock += 51_000; server.tick(); await until(() => first.events.some((event) => event.type === 'receipt'));
  await first.close(); first = await peer(address.url);
  const recovered = await first.auth({ mode: 'resume', token: created.token });
  assert.equal(recovered.receipts.length, 1); assert.equal(recovered.receipts[0].status, 'completed');
});

test('failed durable command leaves no message or readiness side effect', async (t) => {
  const { first, second, dataDirectory } = await two(t, 'disk');
  // Create an isolated directory at the temporary file path; no permissions or
  // existing files are modified, and the failure fixture remains for evidence.
  fs.renameSync(path.join(dataDirectory, 'rooms.json'), path.join(dataDirectory, 'rooms.before-failure.json'));
  fs.mkdirSync(path.join(dataDirectory, 'rooms.json.next'));
  await assert.rejects(first.command({ type: 'message', text: 'must not appear' }), { code: 'SERVER_ERROR' });
  assert.equal(first.latest().room.messages.length, 0); assert.equal(second.latest().room.messages.length, 0);
  // Move the fixture aside (preserve it), then verify retry succeeds once.
  fs.renameSync(path.join(dataDirectory, 'rooms.json.next'), path.join(dataDirectory, 'blocked-temporary-file'));
  await first.command({ type: 'message', text: 'retry works' });
  await until(() => second.latest()?.room.messages.length === 1);
  assert.equal(second.latest().room.messages[0].text, 'retry works');
});

module.exports = { peer, until, directory };
