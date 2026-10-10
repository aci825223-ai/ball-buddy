const { randomUUID } = require('node:crypto');
const { AiError, fail, object, text, id, profile: validateProfile, plan: validatePlan } = require('../shared/ai-validation.cjs');
const { createAiStorage } = require('./ai-storage.cjs');
const { request, modelRequest, safeError, createTextRedactor, checkResponse, readLimitedJson, streamText } = require('./ai-providers.cjs');

const CHAT_SYSTEM = '你是小球同桌中的学习助手。用用户使用的语言回答，帮助学习、说明概念和规划任务。你只能提供文字建议，不能执行代码、改变软件设置、完成任务或访问用户的其他软件。不要声称已经执行任何动作。';
const PLAN_SYSTEM = '你是学习任务规划助手。只返回一个 JSON 对象，不要 Markdown、代码围栏或解释。格式：{"steps":[{"title":"明确可执行的步骤","description":"简短说明","minutes":20}]}。返回 1 至 12 步，title 非空且不超过 140 字，description 不超过 1000 字，每步 minutes 为 1 至 180 的整数。尊重用户可用总时间，让建议现实可执行。你只能提供建议，不能执行或完成任务。';
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createAiService(options) {
  const { directory, emit = () => {}, encryptString, decryptString, isEncryptionAvailable = () => false } = options;
  const fetch = options.fetch || globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs || 120000;
  const connectionTimeoutMs = options.connectionTimeoutMs || 20000;
  const storage = createAiStorage(directory);
  let config = storage.readConfig() || { version: 1, profiles: [], activeProfileId: null };
  const keys = new Map(); const chats = new Map(); const requests = new Map(); const busyChats = new Map();
  let closed = false; let notice = '';
  function encryptionAvailable() { try { return Boolean(isEncryptionAvailable()) && typeof encryptString === 'function' && typeof decryptString === 'function'; } catch { return false; } }
  config.profiles = Array.isArray(config.profiles) ? config.profiles.filter(value => {
    try {
      const valid = validateProfile(value); if (!valid.id) return false;
      Object.assign(value, { id: valid.id, name: valid.name, provider: valid.provider, baseUrl: valid.baseUrl, model: valid.model });
      // Ignore untrusted/legacy plaintext key fields, and never carry them into subsequent saves.
      delete value.key;
      if (typeof value.encryptedKey === 'string' && value.encryptedKey.length < 32768 && encryptionAvailable()) {
        try { keys.set(value.id, decryptString(Buffer.from(value.encryptedKey, 'base64'))); }
        catch { notice = '部分密钥无法解密，请重新输入；聊天记录仍保留。'; }
      }
      return true;
    } catch { notice = '部分 AI 连接配置无法读取，请重新配置。'; return false; }
  }) : [];
  if (!config.profiles.some(p => p.id === config.activeProfileId)) config.activeProfileId = config.profiles[0]?.id || null;
  for (const raw of storage.readChats()) {
    try {
      id(raw.id, '会话');
      if (!Array.isArray(raw.messages)) continue;
      let changed = false;
      raw.messages = raw.messages.filter(message => {
        if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') return false;
        if (message.status === 'generating') { message.status = 'interrupted'; changed = true; }
        return true;
      });
      if (changed) { raw.updatedAt = Date.now(); storage.writeChat(raw); }
      chats.set(raw.id, raw);
    } catch { notice = '有一条聊天记录无法恢复；原文件仍保留。'; }
  }
  function publish(event) { try { emit(event); } catch { /* UI listeners cannot alter the request lifecycle. */ } }
  function ensureOpen() { if (closed) fail('AI_CLOSED', 'AI 服务正在关闭。'); }
  function getAiConfig() {
    return { profiles: config.profiles.map(p => ({ id: p.id, name: p.name, provider: p.provider, baseUrl: p.baseUrl, model: p.model, hasKey: Boolean(keys.get(p.id)), keyStorage: p.encryptedKey ? 'encrypted' : keys.has(p.id) ? 'session' : 'none' })), activeProfileId: config.activeProfileId, ...(notice ? { notice } : {}) };
  }
  function saveAiProfile(input) {
    ensureOpen();
    const value = validateProfile(input); const next = clone(config);
    const existing = value.id ? next.profiles.find(p => p.id === value.id) : null;
    if (value.id && !existing) fail('PROFILE_NOT_FOUND', '这条 AI 连接不存在，请新建连接。');
    if (!existing && next.profiles.length >= 20) fail('PROFILE_LIMIT', '最多保存 20 条 AI 连接。');
    const target = existing || { id: randomUUID() };
    Object.assign(target, { name: value.name, provider: value.provider, baseUrl: value.baseUrl, model: value.model });
    let nextKey = keys.get(target.id) || '';
    if (value.key !== undefined) {
      nextKey = value.key;
      delete target.encryptedKey;
      if (nextKey && encryptionAvailable()) {
        try { target.encryptedKey = Buffer.from(encryptString(nextKey)).toString('base64'); }
        catch { fail('KEY_STORAGE_FAILED', '密钥加密失败，原连接未改变，请重试。'); }
      }
    }
    if (!existing) next.profiles.push(target);
    if (value.select || !next.activeProfileId) next.activeProfileId = target.id;
    try { storage.writeConfig(next); } catch { fail('AI_SAVE_FAILED', 'AI 连接保存失败，原配置未改变，请检查本地目录权限。'); }
    config = next;
    if (nextKey) keys.set(target.id, nextKey); else keys.delete(target.id);
    notice = nextKey && !target.encryptedKey ? '系统加密不可用，API Key 仅在本次运行中使用，重启后需重新输入。' : '';
    return getAiConfig();
  }
  function selected(profileId, requireModel = true) {
    ensureOpen();
    const selectedId = profileId === undefined ? config.activeProfileId : id(profileId, '连接');
    const found = config.profiles.find(p => p.id === selectedId);
    if (!found) fail('AI_NOT_CONFIGURED', '请先在设置中保存一条 AI 连接。');
    if (requireModel && !found.model) fail('MODEL_REQUIRED', '请先选择或填写模型 ID。');
    if (found.encryptedKey && !keys.get(found.id)) fail('KEY_UNAVAILABLE', '这条连接的密钥无法解密，请重新输入。');
    return { profile: clone(found), key: keys.get(found.id) || '' };
  }
  function begin(kind, chatId = null, timeout = timeoutMs) {
    if (requests.size >= 3) fail('AI_BUSY', '已有多个 AI 请求进行中，请先停止或等待完成。');
    const value = { id: randomUUID(), kind, chatId, controller: new AbortController(), stopReason: null, timer: null, draftTimer: null };
    value.timer = setTimeout(() => { value.stopReason = 'timeout'; value.controller.abort(new AiError('AI_TIMEOUT', 'AI 响应超时，已保留收到的文字，请重试。')); }, timeout);
    requests.set(value.id, value); return value;
  }
  function finish(value) { clearTimeout(value.timer); clearTimeout(value.draftTimer); requests.delete(value.id); if (value.chatId && busyChats.get(value.chatId) === value.id) busyChats.delete(value.chatId); }
  async function fetchReply(connection, messages, system, value, onText) {
    const prepared = request(connection.profile, connection.key, messages, system);
    const response = await fetch(prepared.url, { method: 'POST', headers: prepared.headers, body: JSON.stringify(prepared.body), signal: value.controller.signal, redirect: 'manual' });
    await checkResponse(response, connection.key);
    const redactor = createTextRedactor(connection.key, onText);
    try { await streamText(response, connection.profile.provider, chunk => redactor.write(chunk), value.controller.signal); }
    finally { redactor.flush(); }
  }
  function publicError(error, value, key) {
    if (value?.stopReason === 'timeout') return new AiError('AI_TIMEOUT', 'AI 响应超时，已保留收到的文字，请重试。');
    if (error instanceof AiError) return new AiError(error.code, safeError(error, key));
    return new AiError('AI_NETWORK_ERROR', '无法连接 AI 服务，请检查服务地址、网络或代理后重试。');
  }
  async function listAiModels(input) {
    object(input); const connection = selected(input.profileId, false); const value = begin('models', null, connectionTimeoutMs);
    try {
      const prepared = modelRequest(connection.profile, connection.key);
      const response = await fetch(prepared.url, { method: 'GET', headers: prepared.headers, signal: value.controller.signal, redirect: 'manual' });
      await checkResponse(response, connection.key);
      const body = await readLimitedJson(response);
      const raw = connection.profile.provider === 'gemini' ? body.models : body.data;
      if (!Array.isArray(raw)) fail('MODELS_UNAVAILABLE', '该服务没有提供模型列表，请手动填写模型 ID。');
      const models = raw.filter(m => m && typeof (m.id || m.name) === 'string').slice(0, 1000).map(m => ({ id: String(m.id || m.name).replace(/^models\//, '').slice(0, 200), name: String(m.display_name || m.displayName || m.id || m.name).slice(0, 200) }));
      return [...new Map(models.map(model => [model.id, model])).values()];
    } catch (error) { throw publicError(error, value, connection.key); }
    finally { finish(value); }
  }
  async function testAiConnection(input) {
    object(input); const connection = selected(input.profileId); const value = begin('test', null, connectionTimeoutMs);
    let confirmed = false;
    try {
      await fetchReply(connection, [{ role: 'user', text: '只回复 OK。' }], '这是用户主动发起的连接测试，只需回复 OK。', value, chunk => {
        if (chunk.trim()) { confirmed = true; value.controller.abort(); throw new AiError('TEST_CONFIRMED', '连接成功'); }
      });
      return { connected: true, provider: connection.profile.provider, model: connection.profile.model };
    } catch (error) { if (confirmed && error.code === 'TEST_CONFIRMED') return { connected: true, provider: connection.profile.provider, model: connection.profile.model }; throw publicError(error, value, connection.key); }
    finally { finish(value); }
  }
  function listChats() { return [...chats.values()].map(chat => ({ id: chat.id, title: chat.title, profileId: chat.profileId, archived: Boolean(chat.archived), updatedAt: chat.updatedAt, messageCount: chat.messages.length, lastStatus: chat.messages.at(-1)?.status || 'complete' })).sort((a, b) => b.updatedAt - a.updatedAt); }
  function createChat(input = {}) {
    object(input); ensureOpen();
    const profileId = input.profileId === undefined ? config.activeProfileId : selected(input.profileId, false).profile.id;
    const chat = { id: randomUUID(), title: '新会话', profileId: profileId || null, archived: false, updatedAt: Date.now(), messages: [] };
    try { storage.writeChat(chat); } catch { fail('AI_SAVE_FAILED', '会话保存失败，请检查本地目录权限。'); }
    chats.set(chat.id, chat); return clone(chat);
  }
  function findChat(input) { object(input); const chatId = id(input.chatId, '会话'); const chat = chats.get(chatId); if (!chat) fail('CHAT_NOT_FOUND', '这条会话不存在。'); return chat; }
  function getChat(input) { return clone(findChat(input)); }
  function commitChat(chat) { try { storage.writeChat(chat); } catch { fail('AI_SAVE_FAILED', '聊天记录保存失败，已停止生成，请检查本地目录权限。'); } chats.set(chat.id, clone(chat)); }
  function archiveChat(input) {
    ensureOpen(); const chat = clone(findChat(input));
    if (busyChats.has(chat.id)) fail('CHAT_BUSY', '请先停止这条会话的回复，再归档。');
    chat.archived = true; chat.updatedAt = Date.now(); commitChat(chat); return clone(chat);
  }
  function history(chat) {
    let budget = 48000;
    const messages = [];
    for (let i = chat.messages.length - 1; i >= 0 && messages.length < 60; i--) {
      const m = chat.messages[i]; if (!m.text) continue;
      const attached = m.role === 'user' && m.taskTitle ? `${m.text}\n\n用户明确附带的任务标题：${m.taskTitle}` : m.text;
      if (attached.length > budget && messages.length) break;
      const content = attached.slice(-budget); budget -= content.length;
      messages.unshift({ role: m.role, text: content }); if (budget <= 0) break;
    }
    // Merge adjacent roles for Messages compatibility (for example retry after an empty error).
    const merged = [];
    for (const message of messages) { if (merged.at(-1)?.role === message.role) merged.at(-1).text += `\n\n${message.text}`; else merged.push(message); }
    while (merged[0]?.role === 'assistant') merged.shift();
    return merged;
  }
  function sendChat(input) {
    ensureOpen(); object(input); const source = findChat(input);
    if (source.archived) fail('CHAT_ARCHIVED', '会话已归档，请新建会话。');
    if (busyChats.has(source.id)) fail('CHAT_BUSY', '这条会话正在回复，请先停止或等待完成。');
    if (source.messages.length >= 1000) fail('CHAT_LIMIT', '这条会话过长，请新建会话。');
    const messageText = text(input.text, '消息', 16000);
    const taskTitle = input.taskTitle === undefined ? '' : text(input.taskTitle, '任务标题', 140, true);
    const connection = selected(input.profileId);
    const value = begin('chat', source.id);
    const chat = clone(source); chat.profileId = connection.profile.id; chat.updatedAt = Date.now();
    if (!chat.messages.length) chat.title = messageText.replace(/\s+/g, ' ').slice(0, 38);
    chat.messages.push({ id: randomUUID(), role: 'user', text: messageText, status: 'complete', ...(taskTitle ? { taskTitle } : {}) });
    const reply = { id: randomUUID(), role: 'assistant', text: '', status: 'generating' }; chat.messages.push(reply);
    try { commitChat(chat); } catch (error) { finish(value); throw error; }
    busyChats.set(chat.id, value.id);
    setImmediate(async () => {
      publish({ requestId: value.id, chatId: chat.id, kind: 'started' });
      let finalEvent;
      try {
        if (value.controller.signal.aborted) throw value.controller.signal.reason || new Error('Aborted');
        await fetchReply(connection, history(chat), CHAT_SYSTEM, value, chunk => {
          reply.text += chunk; chat.updatedAt = Date.now(); chats.set(chat.id, clone(chat));
          if (!value.draftTimer) value.draftTimer = setTimeout(() => {
            value.draftTimer = null;
            try { commitChat(chat); } catch (error) { value.storageError = error; value.controller.abort(error); }
          }, 300);
          publish({ requestId: value.id, chatId: chat.id, kind: 'delta', text: chunk });
        });
        reply.status = 'complete'; finalEvent = { kind: 'finished' };
      } catch (error) {
        if (value.stopReason === 'stopped' || value.stopReason === 'closed') { reply.status = value.stopReason === 'closed' ? 'interrupted' : 'stopped'; finalEvent = { kind: 'stopped' }; }
        else { const problem = publicError(value.storageError || error, value, connection.key); reply.status = 'error'; reply.error = problem.message; finalEvent = { kind: 'error', error: problem.message, code: problem.code }; }
      } finally {
        clearTimeout(value.draftTimer); value.draftTimer = null;
        chat.updatedAt = Date.now();
        try { commitChat(chat); } catch (error) { reply.status = 'error'; chats.set(chat.id, clone(chat)); finalEvent = { kind: 'error', error: error.message, code: error.code }; }
        finish(value); publish({ requestId: value.id, chatId: chat.id, ...finalEvent });
      }
    });
    return { requestId: value.id, chatId: chat.id };
  }
  function stopChat(input) {
    object(input); const requestId = id(input.requestId, '请求'); const value = requests.get(requestId);
    if (!value || !['chat', 'plan'].includes(value.kind)) return { stopped: false };
    value.stopReason = 'stopped'; value.controller.abort(); return { stopped: true };
  }
  function decomposeTask(input) {
    ensureOpen(); object(input);
    const goal = text(input.goal, '学习目标', 2000);
    if (input.minutes !== undefined && (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 720)) fail('INVALID_INPUT', '可用时间应为 1–720 分钟。');
    const connection = selected(input.profileId); const value = begin('plan'); const planId = randomUUID();
    setImmediate(async () => {
      publish({ requestId: value.id, chatId: null, kind: 'started' });
      let result = '';
      try {
        if (value.controller.signal.aborted) throw value.controller.signal.reason || new Error('Aborted');
        await fetchReply(connection, [{ role: 'user', text: `学习目标：${goal}${input.minutes ? `\n可用总时间：${input.minutes} 分钟` : ''}` }], PLAN_SYSTEM, value, chunk => { result += chunk; });
        let raw;
        try { raw = JSON.parse(result.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')); }
        catch { fail('INVALID_PLAN', 'AI 没有返回可编辑的任务步骤，请重试或换模型。'); }
        const plan = validatePlan(raw, goal, planId);
        publish({ requestId: value.id, chatId: null, kind: 'plan', plan });
      } catch (error) {
        if (value.stopReason === 'stopped' || value.stopReason === 'closed') publish({ requestId: value.id, chatId: null, kind: 'stopped' });
        else { const problem = publicError(error, value, connection.key); publish({ requestId: value.id, chatId: null, kind: 'error', error: problem.message, code: problem.code }); }
      } finally { finish(value); }
    });
    return { requestId: value.id, planId };
  }
  function close() {
    closed = true;
    for (const value of requests.values()) {
      value.stopReason = 'closed'; clearTimeout(value.timer); clearTimeout(value.draftTimer); value.draftTimer = null; value.controller.abort();
      if (value.chatId) {
        const chat = chats.get(value.chatId);
        if (chat?.messages.at(-1)?.status === 'generating') { chat.messages.at(-1).status = 'interrupted'; chat.updatedAt = Date.now(); try { commitChat(chat); } catch { /* The last valid draft remains recoverable. */ } }
      }
    }
  }
  return { getAiConfig, saveAiProfile, testAiConnection, listAiModels, listChats, createChat, getChat, archiveChat, sendChat, stopChat, decomposeTask, close };
}
module.exports = { createAiService };
