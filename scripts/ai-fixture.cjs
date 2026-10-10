const http = require('node:http');

// Local protocol fixture. Its responses are deterministic test data, never model output.
async function createAiFixture(options = {}) {
  const requests = []; const streams = new Set(); const timers = new Set();
  const server = http.createServer(async (incoming, outgoing) => {
    streams.add(outgoing); outgoing.on('close', () => streams.delete(outgoing));
    let bodyText = '';
    for await (const chunk of incoming) bodyText += chunk.toString('utf8');
    let body = {}; try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { outgoing.writeHead(400); outgoing.end(); return; }
    const provider = incoming.url.startsWith('/anthropic') ? 'anthropic' : incoming.url.startsWith('/gemini') ? 'gemini' : 'openai';
    requests.push({ method: incoming.method, path: incoming.url, headers: { ...incoming.headers }, body });
    if (incoming.method === 'GET') {
      outgoing.setHeader('content-type', 'application/json');
      outgoing.end(JSON.stringify(provider === 'gemini' ? { models: [{ name: 'models/fixture-model', displayName: '本地验收模型' }] } : { data: [{ id: 'fixture-model', display_name: '本地验收模型' }] })); return;
    }
    const model = body.model || decodeURIComponent(incoming.url.match(/\/models\/([^:]+):/)?.[1] || 'fixture-model');
    if (/unauthorized/.test(model)) { outgoing.writeHead(401, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: { message: `bad key ${incoming.headers.authorization || incoming.headers['x-api-key'] || incoming.headers['x-goog-api-key']}` } })); return; }
    if (/limited/.test(model)) { outgoing.writeHead(429); outgoing.end('retry'); return; }
    if (/redirect/.test(model)) { outgoing.writeHead(307, { location: 'http://127.0.0.1:1/credentials' }); outgoing.end(); return; }
    outgoing.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    if (/bad/.test(model)) { outgoing.end('data: {broken}\n\n'); return; }
    const prompt = JSON.stringify(body);
    const isPlan = /"steps"|\\"steps\\"/.test(prompt);
    const goal = prompt.includes('INVALID_PLAN') ? 'invalid' : 'valid';
    const reply = isPlan ? JSON.stringify(goal === 'invalid' ? { steps: Array.from({ length: 13 }, (_, i) => ({ title: `步骤${i}`, description: '', minutes: 10 })) } : { steps: [{ title: '复习基础概念', description: '记录三个需要确认的概念', minutes: 10 }, { title: '完成一个练习', description: '独立作答后核对结果', minutes: 20 }] }) : options.reply || '你好，这是本地流式验收。\n一起学习！';
    const frame = (part, end = false) => {
      if (provider === 'openai') return end ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r\n\r\n` : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\r\n\r\n`;
      if (provider === 'anthropic') return end ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } })}\n\n`;
      return `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: part }] }, ...(end ? { finishReason: 'STOP' } : {}) }] })}\n\n`;
    };
    if (/empty/.test(model)) { outgoing.end(frame('', true)); return; }
    const parts = Array.from(reply.matchAll(/[\s\S]{1,5}/gu), match => match[0]);
    let index = 0;
    function later(action, ms) { const timer = setTimeout(() => { timers.delete(timer); action(); }, ms); timers.add(timer); }
    function next() {
      if (outgoing.destroyed) return;
      if (index >= parts.length) { outgoing.end(/truncated/.test(model) ? '' : frame('', true)); return; }
      const bytes = Buffer.from(frame(parts[index++]));
      // Split in the middle of UTF-8 text and CRLF boundaries to exercise the real decoder.
      for (let offset = 0; offset < bytes.length; offset += 7) outgoing.write(bytes.subarray(offset, offset + 7));
      later(next, /slow/.test(model) ? 150 : options.delayMs ?? 8);
    }
    next();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, async close() { for (const timer of timers) clearTimeout(timer); for (const stream of streams) stream.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
if (require.main === module) createAiFixture().then(fixture => { process.stdout.write(`Local AI protocol fixture: ${fixture.url}\n`); process.on('SIGINT', () => fixture.close().then(() => process.exit())); });
module.exports = { createAiFixture };
