const test = require('node:test');
const assert = require('node:assert/strict');
const { streamText, request, createTextRedactor } = require('../src/main/ai-providers.cjs');
const { plan } = require('../src/shared/ai-validation.cjs');
function response(text) { const bytes = Buffer.from(text); return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); controller.close(); } })); }

test('SSE accepts comment heartbeats, mixed line endings and multiline JSON data', async () => {
  const text = ': heartbeat\r\nid: fixture\r\nretry: 3000\r\nevent: completion\r\ndata: {"choices":[\r\ndata: {"index":0,"delta":{"content":"中文😀"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  let result = ''; await streamText(response(text), 'openai', chunk => { result += chunk; }); assert.equal(result, '中文😀');
});
test('provider finish limit retains the final text frame and refuses tool-only or broken encoding output', async () => {
  let result = '';
  await assert.rejects(streamText(response('data: {"candidates":[{"content":{"parts":[{"text":"最后一句"}]},"finishReason":"MAX_TOKENS"}]}\n\n'), 'gemini', chunk => { result += chunk; }), { code: 'OUTPUT_LIMIT' }); assert.equal(result, '最后一句');
  await assert.rejects(streamText(response('data: {"choices":[{"index":0,"delta":{"tool_calls":[]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'), 'openai', () => {}), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(streamText(new Response(new Uint8Array([255])), 'openai', () => {}), { code: 'INVALID_RESPONSE' });
});
test('request bodies use protocol-native roles, systems and headers without putting keys into URLs', () => {
  const messages = [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi' }];
  const gemini = request({ provider: 'gemini', baseUrl: 'https://example.com/v1beta', model: 'models/flash' }, 'fixture-key', messages, 'system'); assert.equal(gemini.url, 'https://example.com/v1beta/models/flash:streamGenerateContent?alt=sse'); assert.equal(gemini.body.contents[1].role, 'model'); assert.ok(!gemini.url.includes('fixture-key'));
  const anthropic = request({ provider: 'anthropic', baseUrl: 'https://example.com', model: 'model' }, '', messages, 'system'); assert.equal(anthropic.url, 'https://example.com/v1/messages'); assert.equal(anthropic.body.system, 'system'); assert.equal(anthropic.body.max_tokens, 4096);
  const openai = request({ provider: 'openai', baseUrl: 'https://example.com/v1/chat/completions', model: 'model' }, 'fixture-key', messages, 'system'); assert.equal(openai.url, 'https://example.com/v1/chat/completions'); assert.equal(openai.body.messages[0].role, 'system'); assert.ok(!('max_tokens' in openai.body));
});
test('structured plans reject unbounded or invalid step titles, descriptions and durations', () => {
  for (const steps of [[], Array.from({ length: 13 }, () => ({ title: 'a', minutes: 1 })), [{ title: 'a', minutes: 0 }], [{ title: 'a', minutes: 181 }], [{ title: 'a', minutes: 1.5 }], [{ title: '', minutes: 10 }], [{ title: 'a'.repeat(141), minutes: 10 }], [{ title: 'a', description: 'a'.repeat(1001), minutes: 10 }]]) assert.throws(() => plan({ steps }, 'goal'));
  assert.deepEqual(plan({ steps: [{ title: '完成练习', minutes: 10, command: 'unsafe' }] }, 'goal').steps, [{ title: '完成练习', description: '', minutes: 10 }]);
});
test('redactor retains only a possible credential suffix and flushes incomplete ordinary text', () => {
  let output = ''; const redact = createTextRedactor('secret-key', chunk => { output += chunk; }); redact.write('se'); assert.equal(output, ''); redact.write('cret-'); assert.equal(output, ''); redact.write('key abc s'); assert.equal(output, '[已隐藏密钥] abc '); redact.flush(); assert.equal(output, '[已隐藏密钥] abc s');
});
