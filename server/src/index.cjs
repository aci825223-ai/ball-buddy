'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { PROTOCOL_VERSION, MAX_MESSAGE_BYTES, RECONNECT_GRACE_MS, record, id, text, fail,
  validateCommand, validateReceipt, receiptKey } = require('./protocol.cjs');

function uuid(prefix) { return `${prefix}_${randomUUID()}`; }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function activeMembers(room) { return room.members.filter((member) => member.active); }
function activeRound(room) { return room.round && ['running', 'paused'].includes(room.round.status); }

function createStudyServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port === undefined ? 8787 : options.port;
  const dataDirectory = path.resolve(options.dataDirectory || path.join(__dirname, '../data'));
  const now = options.now || Date.now;
  const graceMs = options.reconnectGraceMs || RECONNECT_GRACE_MS;
  const maxRooms = options.maxRooms || 500;
  const rooms = new Map();
  const sockets = new Map();
  const disconnects = new Map();
  const authRates = new Map();
  const rates = new Map();
  const file = path.join(dataDirectory, 'rooms.json');
  let timer; let heartbeat; let started = false; let closing = false;
  let checkpointAt = now();

  function persist() {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const encoded = JSON.stringify({ version: 1, savedAt: now(), rooms: [...rooms.values()] });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.previous`);
    fs.writeFileSync(`${file}.next`, encoded, { mode: 0o600 });
    fs.renameSync(`${file}.next`, file);
  }
  function commitRoom(room, candidate) {
    const old = rooms.get(room.id);
    rooms.set(room.id, candidate);
    try { persist(); } catch (error) {
      if (old) rooms.set(room.id, old); else rooms.delete(room.id);
      throw error;
    }
    // Keep authenticated socket references stable after an atomic commit.
    const previousMembers = new Map(room.members.map((member) => [member.id, member]));
    const committedMembers = candidate.members.map((member) => {
      const existing = previousMembers.get(member.id);
      return existing ? Object.assign(existing, member) : member;
    });
    Object.assign(room, candidate, { members: committedMembers });
    rooms.set(room.id, room);
  }
  function restore() {
    let raw;
    for (const candidate of [file, `${file}.previous`]) {
      try { raw = JSON.parse(fs.readFileSync(candidate, 'utf8')); if (record(raw) && Array.isArray(raw.rooms)) break; } catch { raw = null; }
    }
    if (!raw) return;
    for (const room of raw.rooms.slice(0, maxRooms)) {
      if (!record(room) || !id(room.id) || !/^[A-Z2-9]{6}$/u.test(room.code)
          || !Array.isArray(room.members) || room.members.length > 32 || !Array.isArray(room.messages)) continue;
      try {
        const members = room.members.filter((member) => record(member) && id(member.id)
          && typeof member.tokenHash === 'string' && /^[a-f0-9]{64}$/u.test(member.tokenHash))
          .map((member) => ({ id: member.id, tokenHash: member.tokenHash, nickname: text(member.nickname, 1, 24, '昵称'),
            goal: text(member.goal || '', 0, 140, '目标'), active: member.active === true,
            online: false, ready: false, seatUntil: member.active ? now() + graceMs : null,
            receipts: (Array.isArray(member.receipts) ? member.receipts : []).map(validateReceipt),
            acked: (Array.isArray(member.acked) ? member.acked : []).filter((key) => typeof key === 'string'),
            processed: (Array.isArray(member.processed) ? member.processed : []).filter(id).slice(-1000) }));
        if (members.filter((member) => member.active).length > 2 || !members.length) continue;
        let round = null;
        if (record(room.round) && id(room.round.id) && ['running', 'paused', 'completed', 'stopped'].includes(room.round.status)
            && Number.isInteger(room.round.durationMs) && room.round.durationMs >= 60_000
            && room.round.durationMs <= 180 * 60_000 && Number.isInteger(room.round.activeMs)
            && room.round.activeMs >= 0 && room.round.activeMs <= room.round.durationMs) {
          // Only the segment that reached the last durable checkpoint counts.
          // Downtime must not silently turn into a completed round.
          const checkpointElapsed = room.round.status === 'running' && Number.isSafeInteger(raw.savedAt)
            && Number.isSafeInteger(room.round.startedAt) ? Math.max(0, raw.savedAt - room.round.startedAt) : 0;
          round = { id: room.round.id, status: ['running', 'paused'].includes(room.round.status) ? 'paused' : room.round.status,
            durationMs: room.round.durationMs, activeMs: Math.min(room.round.durationMs - (['running', 'paused'].includes(room.round.status) ? 1 : 0), room.round.activeMs + checkpointElapsed), endAt: null, startedAt: null,
            memberIds: (Array.isArray(room.round.memberIds) ? room.round.memberIds : []).filter(id),
            reason: ['running', 'paused'].includes(room.round.status) ? 'server-restarted' : room.round.reason };
        }
        const recovered = { id: room.id, code: room.code, hostId: room.hostId, createdAt: room.createdAt || now(),
          members, round, messages: room.messages.slice(-200).filter((message) => record(message) && id(message.id)
            && id(message.memberId) && typeof message.text === 'string' && message.text.length <= 4000
            && Number.isSafeInteger(message.at)) };
        if (!members.some((member) => member.id === recovered.hostId && member.active)) recovered.hostId = activeMembers(recovered)[0]?.id || null;
        rooms.set(recovered.id, recovered);
      } catch { /* One malformed room never grants a settlement or blocks the service. */ }
    }
  }
  restore();

  function send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify({ version: PROTOCOL_VERSION, ...message }));
  }
  function view(room, at = now()) {
    const round = room.round ? { id: room.round.id, status: room.round.status, durationMs: room.round.durationMs,
      activeMs: room.round.status === 'running' ? Math.min(room.round.durationMs, room.round.activeMs + Math.max(0, at - room.round.startedAt)) : room.round.activeMs,
      remainingMs: room.round.status === 'running' ? Math.max(0, room.round.endAt - at) : Math.max(0, room.round.durationMs - room.round.activeMs),
      endAt: room.round.endAt, reason: room.round.reason || null } : null;
    return { code: room.code, hostId: room.hostId, members: activeMembers(room).map((member) => ({ id: member.id,
      nickname: member.nickname, goal: member.goal, online: member.online, ready: member.ready })), round,
    messages: room.messages };
  }
  function receiptsTo(socket, member) {
    for (const receipt of member.receipts) {
      if (!member.acked.includes(receiptKey(receipt))) send(socket, { type: 'receipt', receipt });
    }
  }
  function broadcast(room, greeting = null) {
    for (const member of room.members) {
      const socket = sockets.get(member.id);
      if (!socket) continue;
      send(socket, { type: 'snapshot', selfId: member.id, serverNow: now(), room: member.active ? view(room) : null,
        ...(greeting ? { greeting } : {}) });
      receiptsTo(socket, member);
    }
  }
  function finish(room, status, at = now(), reason = null) {
    const round = room.round;
    if (!activeRound(room)) return false;
    if (round.status === 'running') round.activeMs = Math.min(round.durationMs, round.activeMs + Math.max(0, at - round.startedAt));
    if (status === 'completed') round.activeMs = round.durationMs;
    round.status = status; round.endAt = null; round.startedAt = null; round.reason = reason;
    for (const member of room.members) {
      member.ready = false;
      if (round.memberIds.includes(member.id)) {
        const receipt = { roomId: room.id, roundId: round.id, memberId: member.id,
          status, activeMs: round.activeMs, durationMs: round.durationMs };
        if (!member.receipts.some((saved) => saved.roundId === round.id)) member.receipts.push(receipt);
      }
    }
    return true;
  }
  function pause(room, at, reason) {
    if (!room.round || room.round.status !== 'running') return false;
    if (at >= room.round.endAt) return finish(room, 'completed', room.round.endAt);
    room.round.activeMs = Math.min(room.round.durationMs, room.round.activeMs + Math.max(0, at - room.round.startedAt));
    room.round.status = 'paused'; room.round.endAt = null; room.round.startedAt = null; room.round.reason = reason;
    for (const member of activeMembers(room)) member.ready = false;
    return true;
  }
  function expireMember(room, member, reason) {
    finish(room, 'stopped', now(), reason);
    member.active = false; member.online = false; member.ready = false; member.seatUntil = null;
    if (room.hostId === member.id) room.hostId = activeMembers(room)[0]?.id || null;
  }
  function tick() {
    if (closing) return;
    for (const liveRoom of rooms.values()) {
      const at = now();
      const due = (liveRoom.round?.status === 'running' && at >= liveRoom.round.endAt)
        || activeMembers(liveRoom).some((member) => (member.online && disconnects.has(member.id))
          || (!member.online && Number.isSafeInteger(member.seatUntil) && at >= member.seatUntil));
      if (!due) continue;
      const room = JSON.parse(JSON.stringify(liveRoom));
      let changed = false;
      for (const member of activeMembers(room)) {
        if (member.online && disconnects.has(member.id)) {
          const disconnectedAt = disconnects.get(member.id);
          member.online = false; member.ready = false; member.seatUntil = disconnectedAt + graceMs;
          pause(room, disconnectedAt, 'member-disconnected'); changed = true;
        }
      }
      if (room.round?.status === 'running' && now() >= room.round.endAt) changed = finish(room, 'completed', room.round.endAt);
      for (const member of activeMembers(room)) {
        if (!member.online && Number.isSafeInteger(member.seatUntil) && now() >= member.seatUntil) {
          expireMember(room, member, 'reconnect-timeout'); changed = true;
        }
      }
      if (changed) {
        try { commitRoom(liveRoom, room); for (const member of room.members) if (!member.online) disconnects.delete(member.id); broadcast(liveRoom); }
        catch { /* No terminal event or reward is released before durable save. */ }
      }
    }
    if (now() - checkpointAt >= 5000 && [...rooms.values()].some((room) => room.round?.status === 'running')) {
      try { persist(); checkpointAt = now(); } catch { /* Failed checkpoints cannot generate terminal receipts. */ }
    }
  }
  function limit(map, key, count, period, code = 'RATE_LIMITED') {
    const at = now(); let entry = map.get(key);
    if (!entry || at >= entry.start + period) { entry = { start: at, count: 0 }; map.set(key, entry); }
    if (entry.count >= count) throw fail(code, '操作太快了，请稍等再试。');
    entry.count += 1;
    if (map.size > 3000) for (const [oldKey, old] of map) if (at >= old.start + period) map.delete(oldKey);
  }
  function uniqueCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join(''); }
    while ([...rooms.values()].some((room) => room.code === code));
    return code;
  }
  function findToken(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{43}$/u.test(value)) throw fail('AUTH_FAILED', '重连身份无效，请重新创建或加入。');
    const hash = Buffer.from(tokenHash(value), 'hex');
    for (const room of rooms.values()) for (const member of room.members) {
      if (timingSafeEqual(hash, Buffer.from(member.tokenHash, 'hex'))) return { room, member };
    }
    throw fail('AUTH_FAILED', '重连身份无效，请重新创建或加入。');
  }
  function authenticate(socket, payload) {
    if (socket.studyIdentity) throw fail('ALREADY_CONNECTED', '此连接已经加入房间。');
    if (!record(payload) || !['create', 'join', 'resume'].includes(payload.mode)) throw fail('INVALID_INPUT', '房间操作格式无效。');
    limit(authRates, socket.studyIp, 30, 60_000);
    tick();
    let room; let member; let token; let liveRoom; let previousSocket;
    if (payload.mode === 'resume') {
      ({ room, member } = findToken(payload.token));
      if (!member.active) {
        socket.studyIdentity = { room, member };
        sockets.set(member.id, socket);
        return { selfId: member.id, room: null, expired: true, serverNow: now(),
          receipts: member.receipts.filter((receipt) => !member.acked.includes(receiptKey(receipt))) };
      }
      liveRoom = room; room = JSON.parse(JSON.stringify(liveRoom));
      member = room.members.find((candidate) => candidate.id === member.id);
      previousSocket = sockets.get(member.id);
    } else {
      const nickname = text(payload.nickname, 1, 24, '昵称');
      const goal = text(payload.goal || '', 0, 140, '学习目标');
      if (payload.mode === 'create') {
        if (rooms.size >= maxRooms) throw fail('SERVER_FULL', '共学服务房间容量已满，请联系服务管理员。');
        room = { id: uuid('room'), code: uniqueCode(), hostId: null, createdAt: now(), members: [], round: null, messages: [] };
      } else {
        if (typeof payload.code !== 'string' || !/^[A-Z2-9]{6}$/u.test(payload.code)) throw fail('INVALID_ROOM_CODE', '房间码无效。');
        room = [...rooms.values()].find((candidate) => candidate.code === payload.code);
        if (!room) throw fail('ROOM_NOT_FOUND', '找不到这个房间，请检查房间码。');
        if (activeMembers(room).length >= 2) throw fail('ROOM_FULL', '房间已有两位同桌。');
        if (room.members.length >= 32) throw fail('ROOM_EXPIRED', '这个房间已结束使用，请创建新的房间。');
        if (activeRound(room)) throw fail('ROUND_ACTIVE', '这轮共学仍在进行，请稍后加入。');
      }
      liveRoom = room; room = JSON.parse(JSON.stringify(liveRoom));
      token = randomBytes(32).toString('base64url');
      member = { id: uuid('member'), tokenHash: tokenHash(token), nickname, goal, active: true,
        online: true, ready: false, seatUntil: null, receipts: [], acked: [], processed: [] };
      room.members.push(member);
      room.hostId ||= member.id;
    }
    member.online = true; member.seatUntil = null;
    commitRoom(liveRoom, room); room = liveRoom;
    member = liveRoom.members.find((candidate) => candidate.id === member.id);
    if (previousSocket && previousSocket !== socket) { previousSocket.studyIdentity = null; previousSocket.close(4001, 'Replaced by reconnect'); }
    disconnects.delete(member.id);
    socket.studyIdentity = { room, member }; sockets.set(member.id, socket);
    return { selfId: member.id, room: view(room), serverNow: now(), ...(token ? { token } : {}),
      receipts: member.receipts.filter((receipt) => !member.acked.includes(receiptKey(receipt))) };
  }
  function command(socket, payload, commandId) {
    const identity = socket.studyIdentity;
    if (!identity) throw fail('NOT_AUTHENTICATED', '请先加入共学房间。');
    tick();
    const { room: liveRoom, member: liveMember } = identity;
    const room = JSON.parse(JSON.stringify(liveRoom));
    const member = room.members.find((candidate) => candidate.id === liveMember.id);
    if (!member.active) throw fail('ROOM_EXPIRED', '你的房间席位已结束，请重新加入。');
    if (!id(commandId)) throw fail('INVALID_INPUT', '共学操作编号无效。');
    if (member.processed.includes(commandId)) return { duplicate: true };
    const input = validateCommand(payload);
    limit(rates, `${member.id}:command`, 30, 10_000);
    if (['start', 'pause', 'resume', 'stop'].includes(input.type) && room.hostId !== member.id) {
      throw fail('HOST_REQUIRED', '共同计时由房主控制。');
    }
    const bothReady = activeMembers(room).length === 2 && activeMembers(room).every((candidate) => candidate.online && candidate.ready);
    let greeting = null;
    switch (input.type) {
      case 'ready':
        if (room.round?.status === 'running') throw fail('ROUND_RUNNING', '计时中不能更改准备状态。');
        member.ready = input.ready; break;
      case 'start':
        if (activeRound(room)) throw fail('ROUND_ACTIVE', '请先结束上一轮共学。');
        if (!bothReady) throw fail('NOT_READY', '需要两位同桌在线并准备好才能开始。');
        room.round = { id: uuid('round'), status: 'running', durationMs: input.minutes * 60_000,
          activeMs: 0, startedAt: now(), endAt: now() + input.minutes * 60_000,
          memberIds: activeMembers(room).map((candidate) => candidate.id), reason: null }; break;
      case 'pause':
        if (room.round?.status !== 'running') throw fail('ROUND_NOT_RUNNING', '当前没有正在进行的共学。');
        pause(room, now(), 'host-paused'); break;
      case 'resume':
        if (room.round?.status !== 'paused') throw fail('ROUND_NOT_PAUSED', '当前没有暂停的共学。');
        if (!bothReady) throw fail('NOT_READY', '请两位同桌重新准备，再继续这轮共学。');
        room.round.status = 'running'; room.round.startedAt = now();
        room.round.endAt = now() + room.round.durationMs - room.round.activeMs; room.round.reason = null; break;
      case 'stop':
        if (!activeRound(room)) throw fail('NO_ROUND', '当前没有需要结束的共学。');
        finish(room, 'stopped', now(), 'host-stopped'); break;
      case 'message':
        limit(rates, `${member.id}:message`, 5, 10_000);
        room.messages.push({ id: commandId, memberId: member.id, text: input.text, at: now() });
        if (room.messages.length > 200) room.messages = room.messages.slice(-200); break;
      case 'greet':
        limit(rates, `${member.id}:greet`, 1, 2000);
        greeting = { id: commandId, memberId: member.id, at: now() }; break;
      default: throw fail('INVALID_COMMAND', '共学操作无效。');
    }
    member.processed.push(commandId); member.processed = member.processed.slice(-1000);
    commitRoom(liveRoom, room); broadcast(liveRoom, greeting);
    return { accepted: true };
  }

  const httpServer = http.createServer((request, response) => {
    if (request.url !== '/health') { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION }));
  });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  httpServer.on('upgrade', (request, socket, head) => {
    // The desktop client has no browser Origin. An arbitrary website must not
    // use a reader's machine as an unsolicited room-creation client.
    if (request.url !== '/study' || (request.headers.origin && !(options.allowedOrigins || []).includes(request.headers.origin))
        || wsServer.clients.size >= maxRooms * 2 + 20) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wsServer.handleUpgrade(request, socket, head, (webSocket) => wsServer.emit('connection', webSocket, request));
  });
  wsServer.on('connection', (socket, request) => {
    socket.studyIp = request.socket.remoteAddress || 'unknown'; socket.alive = true;
    socket.frameWindow = { start: now(), count: 0 };
    const authDeadline = setTimeout(() => { if (!socket.studyIdentity) socket.close(4003, 'Authentication required'); }, 8000);
    authDeadline.unref();
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => {});
    socket.on('message', (buffer, binary) => {
      let input;
      try {
        if (now() >= socket.frameWindow.start + 10_000) socket.frameWindow = { start: now(), count: 0 };
        if (++socket.frameWindow.count > 120) { socket.close(4008, 'Too many requests'); return; }
        if (binary || buffer.length > MAX_MESSAGE_BYTES) throw fail('INVALID_INPUT', '共学消息格式无效。');
        input = JSON.parse(buffer.toString('utf8'));
        if (!record(input) || input.version !== PROTOCOL_VERSION || !id(input.requestId)) throw fail('INVALID_INPUT', '共学协议版本或消息编号无效。');
        let result;
        if (input.type === 'auth') result = authenticate(socket, input.payload);
        else if (input.type === 'command') result = command(socket, input.payload, input.commandId);
        else if (input.type === 'ack') {
          if (!socket.studyIdentity || typeof input.receiptKey !== 'string') throw fail('INVALID_INPUT', '共学回执确认无效。');
          const { room: liveRoom, member: liveMember } = socket.studyIdentity;
          const candidate = JSON.parse(JSON.stringify(liveRoom));
          const member = candidate.members.find((person) => person.id === liveMember.id);
          if (!member.receipts.some((receipt) => receiptKey(receipt) === input.receiptKey)) throw fail('INVALID_RECEIPT', '找不到这个结算回执。');
          if (!member.acked.includes(input.receiptKey)) { member.acked.push(input.receiptKey); commitRoom(liveRoom, candidate); }
          result = { accepted: true };
        } else if (input.type === 'leave') {
          if (!socket.studyIdentity) throw fail('NOT_AUTHENTICATED', '你尚未加入共学。');
          tick();
          const { room: liveRoom, member: liveMember } = socket.studyIdentity;
          const candidate = JSON.parse(JSON.stringify(liveRoom));
          const member = candidate.members.find((person) => person.id === liveMember.id);
          expireMember(candidate, member, 'member-left'); commitRoom(liveRoom, candidate); broadcast(liveRoom); result = { left: true };
        } else throw fail('INVALID_COMMAND', '不支持这个共学请求。');
        send(socket, { type: 'result', requestId: input.requestId, ok: true, data: result });
        if (input.type === 'auth') { clearTimeout(authDeadline); broadcast(socket.studyIdentity.room); }
      } catch (error) {
        const known = error.public === true && typeof error.code === 'string' && /^[A-Z_]+$/u.test(error.code);
        send(socket, { type: 'result', requestId: id(input?.requestId) ? input.requestId : 'invalid', ok: false,
          code: known ? error.code : 'SERVER_ERROR', error: known ? error.message : '共学服务暂时无法保存，请稍后重试。' });
      }
    });
    socket.on('close', () => {
      clearTimeout(authDeadline);
      if (!socket.studyIdentity) return;
      const { room, member } = socket.studyIdentity;
      if (sockets.get(member.id) !== socket) return;
      sockets.delete(member.id);
      if (!member.active || closing) return;
      disconnects.set(member.id, now());
      tick();
    });
  });

  return {
    async start() {
      if (started) throw fail('ALREADY_STARTED', '共学服务已启动。');
      await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, host, resolve); });
      started = true;
      timer = setInterval(tick, options.tickMs || 250); timer.unref();
      heartbeat = setInterval(() => {
        for (const socket of wsServer.clients) { if (!socket.alive) { socket.terminate(); continue; } socket.alive = false; socket.ping(); }
      }, 15_000); heartbeat.unref();
      const address = httpServer.address();
      return { host, port: address.port, url: `ws://${host.includes(':') ? `[${host}]` : host}:${address.port}/study` };
    },
    async close() {
      closing = true; clearInterval(timer); clearInterval(heartbeat);
      for (const room of rooms.values()) {
        pause(room, now(), 'server-stopped');
        for (const member of activeMembers(room)) { member.online = false; member.ready = false; member.seatUntil = now() + graceMs; }
      }
      persist();
      for (const socket of wsServer.clients) socket.terminate();
      await new Promise((resolve) => wsServer.close(resolve));
      if (started) await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    },
    // Deterministic protocol tests use an injected clock and an explicit tick.
    tick,
    address() { return httpServer.address(); },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const port = Number(option('--port', '8787'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
  const server = createStudyServer({ host: option('--host', '127.0.0.1'), port,
    dataDirectory: option('--data-directory', path.join(__dirname, '../data')) });
  server.start().then((address) => process.stdout.write(`Study server: ${address.url}\n`));
  const stop = async () => { await server.close(); process.exitCode = 0; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

module.exports = { createStudyServer };
