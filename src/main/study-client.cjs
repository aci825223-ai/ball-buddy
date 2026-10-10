'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROTOCOL_VERSION, RECONNECT_GRACE_MS, fail, record, id, text, validateConfig,
  validateConnect, validateCommand, validateReceipt, receiptKey } = require('../shared/study-protocol.cjs');

function atomicWrite(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.previous`);
    fs.writeFileSync(`${file}.next`, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(`${file}.next`, file);
  } catch { throw fail('STUDY_SAVE_FAILED', '共学设置或记录未能保存，请检查磁盘后重试。'); }
}
function readJson(file) {
  for (const candidate of [file, `${file}.previous`]) {
    try { const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')); if (record(raw)) return raw; } catch { /* Isolated fallback, no secrets logged. */ }
  }
  return null;
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function sanitizeRoom(input) {
  if (input === null) return null;
  if (!record(input) || typeof input.code !== 'string' || !/^[A-Z2-9]{6}$/u.test(input.code)
      || (input.hostId !== null && !id(input.hostId)) || !Array.isArray(input.members) || input.members.length > 2
      || !Array.isArray(input.messages) || input.messages.length > 200) throw fail('INVALID_SERVER_DATA', '共学服务返回的数据无效。');
  const members = input.members.map((member) => {
    if (!record(member) || !id(member.id) || typeof member.online !== 'boolean' || typeof member.ready !== 'boolean') {
      throw fail('INVALID_SERVER_DATA', '共学成员数据无效。');
    }
    return { id: member.id, nickname: text(member.nickname, 1, 24, '昵称'), goal: text(member.goal || '', 0, 140, '目标'),
      online: member.online, ready: member.ready };
  });
  let round = null;
  if (input.round !== null) {
    const value = input.round;
    if (!record(value) || !id(value.id) || !['running', 'paused', 'completed', 'stopped'].includes(value.status)
        || !Number.isSafeInteger(value.durationMs) || value.durationMs < 60_000 || value.durationMs > 180 * 60_000
        || !Number.isSafeInteger(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > value.durationMs
        || !Number.isSafeInteger(value.activeMs) || value.activeMs < 0 || value.activeMs > value.durationMs
        || (value.status === 'running' && (!Number.isSafeInteger(value.endAt) || value.endAt < 0))) {
      throw fail('INVALID_SERVER_DATA', '共学计时数据无效。');
    }
    round = { id: value.id, status: value.status, durationMs: value.durationMs, remainingMs: value.remainingMs,
      activeMs: value.activeMs, endAt: value.status === 'running' ? value.endAt : null,
      reason: ['host-paused', 'member-disconnected', 'reconnect-timeout', 'member-left', 'host-stopped', 'server-stopped', 'server-restarted'].includes(value.reason) ? value.reason : null };
  }
  const messageIds = new Set();
  const messages = input.messages.map((message) => {
    if (!record(message) || !id(message.id) || !id(message.memberId) || !Number.isSafeInteger(message.at) || message.at < 0) {
      throw fail('INVALID_SERVER_DATA', '共学消息数据无效。');
    }
    return { id: message.id, memberId: message.memberId, text: text(message.text, 1, 1000, '消息', true), at: message.at };
  }).filter((message) => { if (messageIds.has(message.id)) return false; messageIds.add(message.id); return true; });
  return { code: input.code, hostId: input.hostId, members, round, messages };
}

function createStudyClient(options) {
  if (!options || typeof options.WebSocket !== 'function') throw fail('NO_WEBSOCKET', '当前运行环境无法连接共学服务。');
  const directory = path.resolve(options.directory);
  const configFile = path.join(directory, 'config.json');
  const identityFile = path.join(directory, 'identity.json');
  const receiptFile = path.join(directory, 'receipts.json');
  const WebSocket = options.WebSocket;
  const getState = options.getState || (() => ({ session: null }));
  const settle = options.settle || (() => {});
  let config = { serverUrl: '', nickname: '同桌' };
  try { const raw = readJson(configFile); if (raw) config = validateConfig(raw); } catch { /* Preserve damaged source; allow explicit repair. */ }
  let identity = null;
  const encryptedIdentity = readJson(identityFile);
  if (encryptedIdentity?.encrypted && typeof options.decryptString === 'function') {
    try {
      const decoded = JSON.parse(options.decryptString(Buffer.from(encryptedIdentity.encrypted, 'base64')));
      if (record(decoded) && /^[a-zA-Z0-9_-]{43}$/u.test(decoded.token) && id(decoded.selfId)
          && typeof decoded.serverUrl === 'string' && typeof decoded.code === 'string') identity = decoded;
    } catch { /* Credential unavailable on a different machine; never fall back to plaintext. */ }
  }
  let snapshot = { connection: 'disconnected', selfId: null, serverOffsetMs: 0, room: null };
  let socket = null; let generation = 0; let closed = false; let reconnectTimer = null; let reconnectUntil = 0;
  let reconnectAttempts = 0; let requestSequence = 0; let allowReconnect = false;
  const pending = new Map(); const greetingIds = new Set(); const settledInFlight = new Set();
  const pendingReceipts = new Map();
  const savedReceipts = readJson(receiptFile);
  for (const candidate of Array.isArray(savedReceipts?.pending) ? savedReceipts.pending : []) {
    try { const receipt = validateReceipt(candidate); pendingReceipts.set(receiptKey(receipt), receipt); } catch { /* Preserve file, ignore malformed receipt. */ }
  }
  let receiptChain = Promise.resolve();

  function encryptionAvailable() {
    try { return typeof options.isEncryptionAvailable === 'function' && options.isEncryptionAvailable()
      && typeof options.encryptString === 'function' && typeof options.decryptString === 'function'; } catch { return false; }
  }
  function publish() {
    try { options.onUpdate?.(copy(snapshot)); } catch { /* UI observers cannot corrupt connection lifecycle. */ }
  }
  function update(value) { snapshot = { ...snapshot, ...value }; publish(); }
  function saveIdentity(value) {
    if (value && encryptionAvailable()) {
      const encrypted = options.encryptString(JSON.stringify(value));
      atomicWrite(identityFile, { version: 1, encrypted: Buffer.from(encrypted).toString('base64') });
    } else if (!value || fs.existsSync(identityFile)) atomicWrite(identityFile, { version: 1, encrypted: null });
    // Without OS encryption, credentials live only in this process.
    identity = value;
  }
  function checkPersonal() {
    if (getState()?.session) throw fail('PERSONAL_FOCUS_ACTIVE', '你正在个人专注，请先暂停后结束这一轮，再加入共学。');
  }
  function rejectPending(code, message) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fail(code, message)); }
    pending.clear();
  }
  function request(type, fields = {}, target = socket) {
    if (!target || target.readyState !== 1) return Promise.reject(fail('NOT_CONNECTED', '共学连接尚未准备好。'));
    const requestId = `req_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(fail('REQUEST_TIMEOUT', '共学服务响应超时，请重试。')); }, options.requestTimeoutMs || 8000);
      const item = { resolve, reject, timer, sentAt: Date.now(), sequence: ++requestSequence };
      pending.set(requestId, item);
      try { target.send(JSON.stringify({ version: PROTOCOL_VERSION, requestId, type, ...fields })); }
      catch { clearTimeout(timer); pending.delete(requestId); reject(fail('CONNECTION_LOST', '共学连接已中断。')); }
    });
  }
  function handleSnapshot(input) {
    if (!id(input.selfId) || !Number.isSafeInteger(input.serverNow) || input.serverNow < 0) throw fail('INVALID_SERVER_DATA', '共学服务返回的数据无效。');
    if (snapshot.selfId && input.selfId !== snapshot.selfId) throw fail('INVALID_SERVER_DATA', '共学身份数据不一致。');
    const room = sanitizeRoom(input.room);
    // An active personal timer cannot become a hidden second timer, even when
    // the host starts after this client returned to the personal desk.
    if (room?.round && ['running', 'paused'].includes(room.round.status) && getState()?.session) {
      request('leave').catch(() => {});
      update({ connection: 'error', room: null, error: '个人专注与共学不能同时进行，已离开房间。' });
      return;
    }
    update({ selfId: input.selfId, room, serverOffsetMs: input.serverNow - Date.now() });
    if (input.greeting) {
      const value = input.greeting;
      if (record(value) && id(value.id) && id(value.memberId) && Number.isSafeInteger(value.at)
          && !greetingIds.has(value.id)) {
        greetingIds.add(value.id);
        if (greetingIds.size > 1000) greetingIds.delete(greetingIds.values().next().value);
        const greeting = { id: value.id, memberId: value.memberId, at: value.at };
        snapshot = { ...snapshot, room: snapshot.room ? { ...snapshot.room, greeting } : null }; publish();
        try { options.onGreeting?.(greeting); } catch { /* No observer controls authorization. */ }
      }
    }
  }
  function queueReceipt(receipt, acknowledge) {
    const key = receiptKey(receipt);
    if (settledInFlight.has(key)) return;
    settledInFlight.add(key);
    receiptChain = receiptChain.then(async () => {
      // Server acknowledgement follows the one-save local transaction. A disk
      // failure leaves the receipt pending server-side for the next reconnect.
      await settle(receipt);
      pendingReceipts.delete(key);
      atomicWrite(receiptFile, { version: 1, pending: [...pendingReceipts.values()] });
      if (acknowledge && snapshot.selfId === receipt.memberId) await request('ack', { receiptKey: key });
    }).catch((error) => {
      update({ error: error?.code === 'REQUEST_TIMEOUT' || error?.code === 'NOT_CONNECTED'
        ? '共学结算已保留，重新连接后会再次确认。' : '共学记录尚未保存，请检查磁盘后重新连接。' });
    }).finally(() => settledInFlight.delete(key));
  }
  function handleReceipt(input) {
    const receipt = validateReceipt(input.receipt);
    if (!snapshot.selfId || receipt.memberId !== snapshot.selfId) throw fail('INVALID_RECEIPT', '共学回执身份不一致。');
    const key = receiptKey(receipt);
    if (!pendingReceipts.has(key)) {
      // This small journal retains an authenticated terminal result even if
      // local state saving fails and the user leaves or joins a different room.
      pendingReceipts.set(key, receipt);
      try { atomicWrite(receiptFile, { version: 1, pending: [...pendingReceipts.values()] }); }
      catch (error) { pendingReceipts.delete(key); throw error; }
    }
    queueReceipt(receipt, true);
  }
  function scheduleReconnect() {
    if (closed || !identity || reconnectTimer) return;
    if (!reconnectUntil) reconnectUntil = Date.now() + (options.reconnectGraceMs || RECONNECT_GRACE_MS);
    if (Date.now() >= reconnectUntil) { update({ connection: 'error', error: '重连时间已过，请重新创建或加入房间。' }); return; }
    update({ connection: 'reconnecting', error: '连接中断，正在重连；共同计时已由服务暂停。' });
    const delay = Math.min(5000, 500 * 2 ** Math.min(reconnectAttempts++, 4));
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (closed || !identity) return;
      try { await openConnection({ mode: 'resume', token: identity.token }); }
      catch (error) {
        if (['AUTH_FAILED', 'ROOM_EXPIRED'].includes(error.code)) {
          try { saveIdentity(null); } catch { identity = null; }
          update({ connection: 'error', room: null, error: error.message });
        } else scheduleReconnect();
      }
    }, Math.min(delay, Math.max(1, reconnectUntil - Date.now())));
    reconnectTimer.unref?.();
  }
  async function openConnection(payload) {
    if (closed) throw fail('CLIENT_CLOSED', '共学服务已关闭。');
    const ownGeneration = ++generation;
    const ownSocket = new WebSocket(config.serverUrl);
    socket = ownSocket;
    ownSocket.addEventListener('message', (event) => {
      if (ownGeneration !== generation || closed) return;
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data, 'utf8') > 1024 * 1024) throw fail('INVALID_SERVER_DATA', '共学服务消息过大或格式无效。');
        const input = JSON.parse(event.data);
        if (!record(input) || input.version !== PROTOCOL_VERSION) throw fail('INVALID_SERVER_DATA', '共学服务协议版本无效。');
        if (input.type === 'result') {
          const item = pending.get(input.requestId); if (!item) return;
          clearTimeout(item.timer); pending.delete(input.requestId);
          if (input.ok === true) {
            if (Number.isSafeInteger(input.data?.serverNow)) snapshot.serverOffsetMs = input.data.serverNow - Math.round((item.sentAt + Date.now()) / 2);
            item.resolve(input.data);
          } else item.reject(fail(typeof input.code === 'string' && /^[A-Z_]+$/u.test(input.code) ? input.code : 'SERVER_ERROR',
            typeof input.error === 'string' && input.error.length <= 300 ? input.error : '共学服务拒绝了这次操作。'));
        } else if (input.type === 'snapshot') handleSnapshot(input);
        else if (input.type === 'receipt') handleReceipt(input);
        else throw fail('INVALID_SERVER_DATA', '共学服务消息类型无效。');
      } catch {
        update({ connection: 'error', error: '共学服务返回了无效数据，请检查服务地址。' });
        ownSocket.close();
      }
    });
    ownSocket.addEventListener('close', () => {
      if (ownGeneration !== generation || closed) return;
      socket = null; rejectPending('CONNECTION_LOST', '共学连接已中断。');
      if (allowReconnect && identity) scheduleReconnect(); else if (snapshot.connection !== 'error') update({ connection: 'disconnected', room: null });
    });
    ownSocket.addEventListener('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ownSocket.close(); reject(fail('CONNECT_TIMEOUT', '无法连接共学服务，请检查地址和服务是否运行。')); }, options.connectTimeoutMs || 8000);
        ownSocket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        ownSocket.addEventListener('error', () => { clearTimeout(timer); reject(fail('CONNECT_FAILED', '无法连接共学服务，请检查地址、证书和网络。')); }, { once: true });
        ownSocket.addEventListener('close', () => { clearTimeout(timer); reject(fail('CONNECTION_LOST', '共学连接已关闭。')); }, { once: true });
      });
      const result = await request('auth', { payload }, ownSocket);
      if (!record(result) || !id(result.selfId) || !Number.isSafeInteger(result.serverNow)) throw fail('INVALID_SERVER_DATA', '共学身份数据无效。');
      const room = sanitizeRoom(result.room);
      update({ selfId: result.selfId, room });
      if (Array.isArray(result.receipts)) for (const receipt of result.receipts) handleReceipt({ receipt });
      if (result.expired || !room) {
        await receiptChain;
        saveIdentity(null); ownSocket.close();
        throw fail('ROOM_EXPIRED', '原房间席位已结束；已恢复可用结算，请重新创建或加入。');
      }
      if (payload.mode !== 'resume') {
        if (typeof result.token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/u.test(result.token)) throw fail('INVALID_SERVER_DATA', '共学重连信息无效。');
        saveIdentity({ token: result.token, selfId: result.selfId, serverUrl: config.serverUrl, code: room.code });
      }
      reconnectUntil = 0; reconnectAttempts = 0; allowReconnect = true;
      update({ connection: 'connected', error: null });
      return copy(snapshot);
    } catch (error) {
      if (ownGeneration === generation && ownSocket.readyState < 2) {
        // Explicit auth/config failures free the new seat before disconnecting.
        if (snapshot.room && payload.mode !== 'resume') await request('leave', {}, ownSocket).catch(() => {});
        ownSocket.close();
      }
      throw error;
    }
  }

  // Recover already authenticated local receipts without opening a connection.
  // Main's receipt marker still decides whether any counters need changing.
  for (const receipt of pendingReceipts.values()) queueReceipt(receipt, false);
  return {
    getStudyConfig() { return { ...config, credentialStorage: identity ? (encryptionAvailable() ? 'encrypted' : 'session') : 'none' }; },
    saveStudyConfig(input) {
      const next = validateConfig(input);
      if (snapshot.room || ['connecting', 'reconnecting'].includes(snapshot.connection)) throw fail('ROOM_ACTIVE', '请先离开共学房间，再修改连接设置。');
      atomicWrite(configFile, { version: 1, ...next }); config = next;
      return this.getStudyConfig();
    },
    getStudyState() { return copy(snapshot); },
    async connectStudy(input) {
      checkPersonal();
      const payload = validateConnect(input);
      if (!config.serverUrl) throw fail('SERVER_NOT_CONFIGURED', '请先在设置中填写共学服务地址。');
      if (snapshot.room || ['connecting', 'connected', 'reconnecting'].includes(snapshot.connection)) throw fail('ALREADY_CONNECTED', '你已经在共学房间，请先离开。');
      clearTimeout(reconnectTimer); reconnectTimer = null;
      allowReconnect = false;
      if (socket) { ++generation; socket.close(); socket = null; }
      update({ connection: 'connecting', selfId: null, room: null, error: null });
      try {
        const resume = payload.mode === 'join' && identity?.serverUrl === config.serverUrl && identity?.code === payload.code;
        return await openConnection(resume ? { mode: 'resume', token: identity.token } : { ...payload, nickname: config.nickname });
      } catch (error) {
        if (['AUTH_FAILED', 'ROOM_EXPIRED'].includes(error.code)) { try { saveIdentity(null); } catch { identity = null; } }
        update({ connection: 'error', room: null, error: error.message || '连接共学失败。' });
        throw error;
      }
    },
    async studyCommand(input) {
      const payload = validateCommand(input);
      if (['ready', 'start', 'resume'].includes(payload.type) && (payload.type !== 'ready' || payload.ready)) checkPersonal();
      if (snapshot.connection !== 'connected' || !snapshot.room) throw fail('NOT_CONNECTED', '请先连接共学房间。');
      await request('command', { payload, commandId: `cmd_${randomUUID()}` });
      return copy(snapshot);
    },
    async leaveStudy() {
      allowReconnect = false;
      clearTimeout(reconnectTimer); reconnectTimer = null; reconnectUntil = 0;
      if (socket?.readyState === 1 && snapshot.selfId) await request('leave');
      await receiptChain;
      saveIdentity(null);
      ++generation; socket?.close(); socket = null;
      rejectPending('LEFT_ROOM', '你已离开共学房间。');
      update({ connection: 'disconnected', room: null, selfId: null, error: null });
      return copy(snapshot);
    },
    close() {
      closed = true; ++generation; clearTimeout(reconnectTimer); reconnectTimer = null;
      rejectPending('CLIENT_CLOSED', '共学服务已关闭。'); socket?.close(); socket = null;
    },
  };
}

module.exports = { createStudyClient, sanitizeRoom };
