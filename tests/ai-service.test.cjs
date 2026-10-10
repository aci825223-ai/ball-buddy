const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAiService } = require('../src/main/ai-service.cjs');
const { createAiFixture } = require('../scripts/ai-fixture.cjs');

function temporary() { const base = path.resolve(__dirname, '../artifacts/ai-tests'); fs.mkdirSync(base, { recursive: true }); return fs.mkdtempSync(path.join(base, 'run-')); }
function context(fixture, overrides = {}) {
  const events = []; const watchers = [];
  const service = createAiService({ directory: overrides.directory || temporary(), fetch: globalThis.fetch, encryptString: value => Buffer.from(value).map(byte => byte ^ 93), decryptString: value => Buffer.from(value).map(byte => byte ^ 93).toString(), isEncryptionAvailable: () => true, emit(event) { events.push(event); for (const watch of [...watchers]) watch(event); }, ...overrides });
  function eventFor(requestId, kinds = ['finished', 'error', 'stopped', 'plan']) {
    const previous = events.find(event => event.requestId === requestId && kinds.includes(event.kind)); if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Fixture event timeout')), 6000); const watch = event => { if (event.requestId === requestId && kinds.includes(event.kind)) { clearTimeout(timer); watchers.splice(watchers.indexOf(watch), 1); resolve(event); } }; watchers.push(watch); });
  }
  function configure(provider = 'openai', model = 'fixture-model', key = 'fixture-key-value') { const suffix = provider === 'openai' ? '/openai/v1' : provider === 'anthropic' ? '/anthropic/v1' : '/gemini/v1beta'; return service.saveAiProfile({ name: '本地验收连接', provider, baseUrl: fixture.url + suffix, model, key }); }
  return { service, events, eventFor, configure };
}

test('three provider protocols stream UTF-8 fragments, list models and test selected model using real local HTTP', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close());
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const ctx = context(fixture); t.after(() => ctx.service.close()); const config = ctx.configure(provider); const profileId = config.activeProfileId;
    assert.deepEqual(await ctx.service.listAiModels({ profileId }), [{ id: 'fixture-model', name: '本地验收模型' }]);
    assert.equal((await ctx.service.testAiConnection({ profileId })).connected, true);
    const chat = ctx.service.createChat({ profileId }); const operation = ctx.service.sendChat({ chatId: chat.id, text: '帮我理解这个概念', taskTitle: '复习基础' });
    assert.equal((await ctx.eventFor(operation.requestId)).kind, 'finished');
    const restored = ctx.service.getChat({ chatId: chat.id }); assert.equal(restored.messages[1].text, '你好，这是本地流式验收。\n一起学习！'); assert.equal(restored.messages[1].status, 'complete');
    assert.ok(ctx.events.filter(event => event.kind === 'delta').length > 2);
    const request = fixture.requests.at(-1);
    assert.equal(request.headers[provider === 'openai' ? 'authorization' : provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key'], provider === 'openai' ? 'Bearer fixture-key-value' : 'fixture-key-value');
    assert.ok(JSON.stringify(request.body).includes('用户明确附带的任务标题'));
    assert.ok(!JSON.stringify(ctx.service.getAiConfig()).includes('fixture-key-value')); assert.ok(!JSON.stringify(ctx.events).includes('fixture-key-value'));
  }
});

test('encrypted profile keys persist separately, omitted keys retain and explicit empty keys clear', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close()); const directory = temporary(); const ctx = context(fixture, { directory });
  const config = ctx.configure(); const p = config.profiles[0]; assert.equal(p.keyStorage, 'encrypted'); assert.equal(p.hasKey, true);
  const stored = fs.readFileSync(path.join(directory, 'config.json'), 'utf8'); assert.ok(!stored.includes('fixture-key-value'));
  ctx.service.saveAiProfile({ ...p, name: '更名', key: undefined }); assert.equal(ctx.service.getAiConfig().profiles[0].hasKey, true);
  ctx.service.close(); const reopened = context(fixture, { directory }); t.after(() => reopened.service.close()); assert.equal(reopened.service.getAiConfig().profiles[0].hasKey, true);
  assert.equal((await reopened.service.testAiConnection({ profileId: p.id })).connected, true);
  reopened.service.saveAiProfile({ ...p, key: '' }); assert.equal(reopened.service.getAiConfig().profiles[0].hasKey, false);
  assert.equal(reopened.service.getAiConfig().profiles[0].keyStorage, 'none');
});

test('unavailable encryption uses session-only credentials and does not write plaintext', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close()); const directory = temporary(); const ctx = context(fixture, { directory, isEncryptionAvailable: () => false });
  const config = ctx.configure(); assert.equal(config.profiles[0].keyStorage, 'session'); assert.match(config.notice, /仅在本次/);
  assert.ok(!fs.readFileSync(path.join(directory, 'config.json'), 'utf8').includes('fixture-key-value'));
  ctx.service.close(); const reopened = context(fixture, { directory, isEncryptionAvailable: () => false }); t.after(() => reopened.service.close()); assert.equal(reopened.service.getAiConfig().profiles[0].hasKey, false);
});

test('endpoint validation blocks remote HTTP, embedded credentials, query secrets, paths and unknown providers', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close()); const ctx = context(fixture); t.after(() => ctx.service.close());
  const source = { name: '测试', provider: 'openai', baseUrl: fixture.url, model: 'test' };
  for (const baseUrl of ['http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'file:///C:/secret']) assert.throws(() => ctx.service.saveAiProfile({ ...source, baseUrl }), { code: 'INVALID_URL' });
  assert.throws(() => ctx.service.saveAiProfile({ ...source, provider: 'unsupported' }), { code: 'INVALID_INPUT' });
  assert.throws(() => ctx.service.getChat({ chatId: '../state' }), { code: 'INVALID_INPUT' });
  assert.equal(fixture.requests.length, 0);
});

test('stop retains partial reply, blocks duplicate generation and supports retry after stop', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close()); const ctx = context(fixture); t.after(() => ctx.service.close()); ctx.configure('openai', 'slow');
  const chat = ctx.service.createChat(); const first = ctx.service.sendChat({ chatId: chat.id, text: '你好' });
  assert.throws(() => ctx.service.sendChat({ chatId: chat.id, text: '再次' }), { code: 'CHAT_BUSY' });
  await ctx.eventFor(first.requestId, ['delta']); assert.equal(ctx.service.stopChat(first).stopped, true);
  assert.equal((await ctx.eventFor(first.requestId)).kind, 'stopped');
  const saved = ctx.service.getChat({ chatId: chat.id }); assert.equal(saved.messages[1].status, 'stopped'); assert.ok(saved.messages[1].text.length > 0);
  ctx.configure(); const retry = ctx.service.sendChat({ chatId: chat.id, text: '你好' }); assert.equal((await ctx.eventFor(retry.requestId)).kind, 'finished');
  assert.equal(ctx.service.stopChat({ requestId: randomUUID() }).stopped, false);
  ctx.service.archiveChat({ chatId: chat.id }); assert.equal(ctx.service.listChats()[0].archived, true);
  assert.throws(() => ctx.service.sendChat({ chatId: chat.id, text: '你好' }), { code: 'CHAT_ARCHIVED' });
});

test('timeout, authentication, rate limits, redirect, damaged and interrupted streams are explicit and credential safe', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close());
  for (const [model, code] of [['slow', 'AI_TIMEOUT'], ['unauthorized', 'AUTH_FAILED'], ['limited', 'RATE_LIMITED'], ['redirect', 'REDIRECT_BLOCKED'], ['bad', 'INVALID_RESPONSE'], ['truncated', 'STREAM_INTERRUPTED'], ['empty', 'EMPTY_RESPONSE']]) {
    const ctx = context(fixture, { requestTimeoutMs: model === 'slow' ? 40 : 3000 }); t.after(() => ctx.service.close()); ctx.configure('openai', model);
    const chat = ctx.service.createChat(); const operation = ctx.service.sendChat({ chatId: chat.id, text: '你好' }); const result = await ctx.eventFor(operation.requestId);
    assert.equal(result.kind, 'error', model); assert.equal(result.code, code, model); assert.ok(!JSON.stringify(result).includes('fixture-key-value')); assert.equal(ctx.service.getChat({ chatId: chat.id }).messages[1].status, 'error');
  }
});

test('JSON decomposition is validated, has bounded steps and never creates tasks', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close());
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const ctx = context(fixture); t.after(() => ctx.service.close()); ctx.configure(provider);
    const operation = ctx.service.decomposeTask({ goal: '学习 Python 基础', minutes: 30 }); const event = await ctx.eventFor(operation.requestId);
    assert.equal(event.kind, 'plan'); assert.equal(event.plan.id, operation.planId); assert.equal(event.plan.steps.length, 2); assert.equal(ctx.service.listChats().length, 0);
    const invalid = ctx.service.decomposeTask({ goal: 'INVALID_PLAN' }); assert.equal((await ctx.eventFor(invalid.requestId)).code, 'INVALID_PLAN');
    assert.throws(() => ctx.service.decomposeTask({ goal: '学习', minutes: 0 }), { code: 'INVALID_INPUT' });
  }
});

test('saved drafts reopen as interrupted without a network request and missing primary recovers backup', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close()); const directory = temporary(); const ctx = context(fixture, { directory }); ctx.configure('openai', 'slow');
  const chat = ctx.service.createChat(); const operation = ctx.service.sendChat({ chatId: chat.id, text: '你好' }); await ctx.eventFor(operation.requestId, ['delta']); ctx.service.close();
  await ctx.eventFor(operation.requestId); const before = fixture.requests.length;
  const reopened = context(fixture, { directory }); t.after(() => reopened.service.close()); const restored = reopened.service.getChat({ chatId: chat.id }); assert.equal(restored.messages[1].status, 'interrupted'); assert.ok(restored.messages[1].text); assert.equal(fixture.requests.length, before);
  const chatId = randomUUID(); fs.writeFileSync(path.join(directory, 'chats', `${chatId}.json.backup`), JSON.stringify({ id: chatId, title: '恢复', updatedAt: 1, messages: [{ id: randomUUID(), role: 'assistant', text: '保留草稿', status: 'generating' }] }));
  const recovered = context(fixture, { directory }); t.after(() => recovered.service.close()); assert.equal(recovered.service.getChat({ chatId }).messages[0].status, 'interrupted');
});

test('config save failure leaves credentials and config unchanged, decryption failure is explicit', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close()); const blocked = temporary(); fs.mkdirSync(path.join(blocked, 'config.json'));
  const ctx = context(fixture, { directory: blocked }); t.after(() => ctx.service.close()); assert.throws(() => ctx.configure(), { code: 'AI_SAVE_FAILED' }); assert.equal(ctx.service.getAiConfig().profiles.length, 0);
  const directory = temporary(); const first = context(fixture, { directory }); const config = first.configure(); first.service.close();
  const second = context(fixture, { directory, decryptString() { throw new Error('fixture-key-value'); } }); t.after(() => second.service.close());
  assert.equal(second.service.getAiConfig().profiles[0].hasKey, false); assert.throws(() => second.service.sendChat({ chatId: second.service.createChat().id, text: '你好', profileId: config.activeProfileId }), { code: 'KEY_UNAVAILABLE' }); assert.ok(!JSON.stringify(second.service.getAiConfig()).includes('fixture-key-value'));
});

test('provider text echoing a credential across SSE frames is redacted before events and persistence', async t => {
  const fixture = await createAiFixture({ reply: '开始 fixture-key-value 结束' }); t.after(() => fixture.close()); const directory = temporary(); const ctx = context(fixture, { directory }); t.after(() => ctx.service.close()); ctx.configure();
  const chat = ctx.service.createChat(); const operation = ctx.service.sendChat({ chatId: chat.id, text: '测试回复' });
  assert.equal((await ctx.eventFor(operation.requestId)).kind, 'finished');
  const reply = ctx.service.getChat({ chatId: chat.id }).messages[1].text;
  assert.equal(reply, '开始 [已隐藏密钥] 结束'); assert.ok(!JSON.stringify(ctx.events).includes('fixture-key-value'));
  assert.ok(!fs.readFileSync(path.join(directory, 'chats', `${chat.id}.json`), 'utf8').includes('fixture-key-value'));
});

test('corrupt primary chat preserves original, recovers valid backup and never retries automatically', async t => {
  const fixture = await createAiFixture(); t.after(() => fixture.close()); const directory = temporary(); const ctx = context(fixture, { directory }); ctx.configure();
  const chat = ctx.service.createChat(); const operation = ctx.service.sendChat({ chatId: chat.id, text: '你好' }); await ctx.eventFor(operation.requestId); ctx.service.close();
  const source = path.join(directory, 'chats', `${chat.id}.json`); fs.writeFileSync(source, '{damaged'); const before = fixture.requests.length;
  const recovered = context(fixture, { directory }); t.after(() => recovered.service.close()); assert.ok(recovered.service.getChat({ chatId: chat.id }).messages.length > 0); assert.equal(fixture.requests.length, before);
  const preservation = fs.readdirSync(path.dirname(source)).find(name => name.startsWith(`${chat.id}.json.recovery-`)); assert.ok(preservation); assert.equal(fs.readFileSync(path.join(path.dirname(source), preservation), 'utf8'), '{damaged');
});
