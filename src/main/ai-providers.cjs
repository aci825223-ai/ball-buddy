const { AiError } = require('../shared/ai-validation.cjs');

function apiRoot(profile) {
  let root = profile.baseUrl.replace(/\/+$/, '');
  if (profile.provider === 'openai') root = root.replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
  if (profile.provider === 'anthropic') { root = root.replace(/\/messages$/, '').replace(/\/models$/, ''); if (!/\/v\d+$/.test(root)) root += '/v1'; }
  if (profile.provider === 'gemini') { root = root.replace(/\/models(?:\/[^/]+(?::(?:streamGenerateContent|generateContent))?)?$/, ''); if (!/\/v\d+(?:beta\d*)?$/.test(root)) root += '/v1beta'; }
  return root;
}
function headers(profile, key) {
  const result = { 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
  if (profile.provider === 'openai' && key) result.authorization = `Bearer ${key}`;
  if (profile.provider === 'anthropic') { result['anthropic-version'] = '2023-06-01'; if (key) result['x-api-key'] = key; }
  if (profile.provider === 'gemini' && key) result['x-goog-api-key'] = key;
  return result;
}
function request(profile, key, messages, system) {
  const root = apiRoot(profile);
  if (profile.provider === 'openai') return { url: `${root}/chat/completions`, headers: headers(profile, key), body: { model: profile.model, stream: true, messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.text }))] } };
  if (profile.provider === 'anthropic') return { url: `${root}/messages`, headers: headers(profile, key), body: { model: profile.model, max_tokens: 4096, stream: true, system, messages: messages.map(m => ({ role: m.role, content: m.text })) } };
  return { url: `${root}/models/${encodeURIComponent(profile.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`, headers: headers(profile, key), body: { systemInstruction: { parts: [{ text: system }] }, contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })), generationConfig: { maxOutputTokens: 4096 } } };
}
function modelRequest(profile, key) { return { url: `${apiRoot(profile)}/models`, headers: headers(profile, key) }; }
function safeError(error, key) {
  let message = typeof error === 'string' ? error : error?.message || 'AI 请求失败。';
  if (key) message = message.split(key).join('[已隐藏密钥]');
  message = message.replace(/\b(?:Bearer\s+)[^\s,;"'}]+/gi, 'Bearer [已隐藏密钥]').replace(/(?:[?&](?:key|api[_-]?key|token)=)[^\s&#"']*/gi, '[已隐藏密钥]').replace(/https?:\/\/[^\s"']+/gi, '[服务地址]').replace(/[\r\n]+/g, ' ');
  return message.slice(0, 500);
}
function createTextRedactor(key, onText) {
  // Keep only a suffix that could still become a credential across stream frames.
  let pending = '';
  function write(chunk, final = false) {
    if (!key) { if (chunk) onText(chunk); return; }
    let value = pending + chunk;
    value = value.split(key).join('[已隐藏密钥]');
    let held = 0;
    if (!final) {
      const maximum = Math.min(key.length - 1, value.length);
      for (let length = maximum; length > 0; length--) {
        if (value.endsWith(key.slice(0, length))) { held = length; break; }
      }
    }
    pending = held ? value.slice(-held) : '';
    const output = held ? value.slice(0, -held) : value;
    if (output) onText(output);
  }
  return { write: chunk => write(chunk), flush: () => write('', true) };
}
async function checkResponse(response, key) {
  if (response.ok) return;
  const code = response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 300 && response.status < 400 ? 'REDIRECT_BLOCKED' : 'HTTP_ERROR';
  const label = { AUTH_FAILED: '鉴权失败，请检查密钥和服务权限。', RATE_LIMITED: '服务请求过多或额度不足，请稍后再试。', REDIRECT_BLOCKED: '服务发生重定向，为保护密钥已停止请求。', HTTP_ERROR: `服务返回错误（${response.status}）。` }[code];
  // Vendor error bodies may echo credentials, prompts or upstream URLs. Never relay them.
  try { await response.body?.cancel(); } catch { /* Error text is intentionally not read. */ }
  throw new AiError(code, safeError(label, key));
}
async function readLimitedJson(response, maximum = 2 * 1024 * 1024) {
  if (!response.body?.getReader) throw new AiError('INVALID_RESPONSE', '服务没有返回可读取的数据。');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > maximum) throw new AiError('INVALID_RESPONSE', '服务返回的数据过大。'); chunks.push(item.value); }
  } finally { try { await reader.cancel(); } catch { /* Release a failed response. */ } }
  try { return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')); }
  catch { throw new AiError('INVALID_RESPONSE', '服务返回了无法解析的数据。'); }
}
async function streamText(response, provider, onText, signal) {
  if (!response.body?.getReader) throw new AiError('INVALID_RESPONSE', '服务没有返回文字流。');
  const reader = response.body.getReader();
  let buffer = ''; let event = ''; let data = []; let finished = false; let hadText = false; let total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function consume() {
    if (!data.length) { event = ''; return; }
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') { if (provider !== 'openai') throw new AiError('INVALID_RESPONSE', 'AI 文字流格式不正确。'); finished = true; event = ''; return; }
    let item;
    try { item = JSON.parse(raw); } catch { throw new AiError('INVALID_RESPONSE', 'AI 返回的文字流损坏，请重试。'); }
    if (item.error || event === 'error' || item.type === 'error') throw new AiError('PROVIDER_ERROR', 'AI 服务在生成时返回错误，请稍后重试。');
    let chunk = ''; let terminalError = null;
    if (provider === 'openai') {
      if (!Array.isArray(item.choices)) throw new AiError('INVALID_RESPONSE', 'AI 返回的文字流格式不正确。');
      const choice = item.choices.find(c => c.index === 0) || item.choices[0];
      if (choice && typeof choice.delta?.content === 'string') chunk = choice.delta.content;
      if (choice && typeof choice.delta?.refusal === 'string') chunk += choice.delta.refusal;
      if (choice?.finish_reason === 'length') terminalError = new AiError('OUTPUT_LIMIT', '回复达到模型长度限制，已保留收到的文字。');
      if (choice?.finish_reason === 'content_filter') terminalError = new AiError('CONTENT_FILTERED', '服务限制了本次回复。');
      // A terminal choice still requires [DONE] or a clean final frame; see end checks below.
      if (choice?.finish_reason && choice.finish_reason !== 'length') finished = true;
    } else if (provider === 'anthropic') {
      if (item.type === 'content_block_delta' && item.delta?.type === 'text_delta') chunk = item.delta.text;
      if (item.type === 'content_block_start' && item.content_block?.type === 'text') chunk = item.content_block.text;
      if (item.type === 'message_delta' && item.delta?.stop_reason === 'max_tokens') terminalError = new AiError('OUTPUT_LIMIT', '回复达到模型长度限制，已保留收到的文字。');
      if (item.type === 'message_stop') finished = true;
    } else {
      if (item.promptFeedback?.blockReason) throw new AiError('CONTENT_FILTERED', '服务限制了本次输入。');
      const candidate = item.candidates?.[0];
      chunk = (candidate?.content?.parts || []).filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') terminalError = new AiError(candidate.finishReason === 'MAX_TOKENS' ? 'OUTPUT_LIMIT' : 'CONTENT_FILTERED', '服务中断了回复，已保留收到的文字。');
      if (candidate?.finishReason === 'STOP') finished = true;
      if (!candidate && !item.usageMetadata && !item.modelVersion) throw new AiError('INVALID_RESPONSE', 'AI 返回的文字流格式不正确。');
    }
    if (typeof chunk !== 'string') throw new AiError('INVALID_RESPONSE', 'AI 文字片段格式不正确。');
    if (chunk) { total += chunk.length; if (total > 200000) throw new AiError('OUTPUT_LIMIT', '回复超过本地长度限制，已停止生成。'); hadText = true; onText(chunk); }
    if (terminalError) throw terminalError;
    event = '';
  }
  function lines(final = false) {
    let index;
    while ((index = buffer.search(/\r\n|\n|\r/)) >= 0) {
      if (!final && buffer[index] === '\r' && index === buffer.length - 1) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + (buffer.slice(index, index + 2) === '\r\n' ? 2 : 1));
      if (!line) consume();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (!line.startsWith(':') && !/^(?:id|retry):/.test(line)) throw new AiError('INVALID_RESPONSE', 'AI 返回的文字流格式不正确。');
    }
    if (buffer.length > 1024 * 1024 || data.reduce((n, part) => n + part.length, 0) > 1024 * 1024) throw new AiError('INVALID_RESPONSE', 'AI 文字流片段过大。');
    if (final) { if (buffer.trim()) { if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '')); else throw new AiError('INVALID_RESPONSE', 'AI 文字流结尾损坏。'); buffer = ''; } consume(); }
  }
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
      const item = await reader.read(); if (item.done) break;
      try { buffer += decoder.decode(item.value, { stream: true }); } catch { throw new AiError('INVALID_RESPONSE', 'AI 文字流编码损坏。'); }
      lines();
    }
    try { buffer += decoder.decode(); } catch { throw new AiError('INVALID_RESPONSE', 'AI 文字流编码损坏。'); }
    lines(true);
    if (!finished) throw new AiError('STREAM_INTERRUPTED', '连接提前中断，已保留收到的文字，可以重试。');
    if (!hadText) throw new AiError('EMPTY_RESPONSE', '模型没有返回可显示的文字，请检查模型是否支持文本聊天。');
  } finally { try { await reader.cancel(); } catch { /* Keep the original error. */ } }
}
module.exports = { apiRoot, headers, request, modelRequest, safeError, createTextRedactor, checkResponse, readLimitedJson, streamText };
