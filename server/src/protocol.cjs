'use strict';

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 16 * 1024;
const RECONNECT_GRACE_MS = 90_000;
const TERMINAL_STATUSES = new Set(['completed', 'stopped']);
const ACTIVE_STATUSES = new Set(['running', 'paused']);
const COMMAND_TYPES = new Set(['ready', 'start', 'pause', 'resume', 'stop', 'message', 'greet']);

function fail(code, message) { const error = new Error(message); error.code = code; error.public = true; return error; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function id(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value); }
function text(value, min, max, label, multiline = false) {
  if (typeof value !== 'string') throw fail('INVALID_INPUT', `${label}格式无效。`);
  const result = value.trim();
  if (Array.from(result).length < min || Array.from(result).length > max
      || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(result)) {
    throw fail('INVALID_INPUT', `${label}需为 ${min}–${max} 个字。`);
  }
  return result;
}
function normalizeServerUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('INVALID_SERVER', '请填写有效的共学服务地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw fail('INVALID_SERVER', '请填写 ws:// 或 wss:// 共学服务地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (!['ws:', 'wss:'].includes(url.protocol) || (url.protocol === 'ws:' && !loopback)
      || url.username || url.password || url.hash || url.search) {
    throw fail('INVALID_SERVER', '远程共学请使用 wss://；本机测试可用 ws://127.0.0.1，地址不能包含密码或参数。');
  }
  if (url.pathname === '/') url.pathname = '/study';
  return url.toString();
}
function validateConfig(input) {
  if (!record(input)) throw fail('INVALID_INPUT', '共学设置格式无效。');
  return { serverUrl: input.serverUrl === '' ? '' : normalizeServerUrl(input.serverUrl),
    nickname: text(input.nickname, 1, 24, '昵称') };
}
function validateConnect(input) {
  if (!record(input) || !['create', 'join'].includes(input.mode)) throw fail('INVALID_INPUT', '请选择创建或加入房间。');
  const goal = input.goal === undefined ? '' : text(input.goal, 0, 140, '学习目标');
  if (input.mode === 'create') return { mode: 'create', goal };
  if (typeof input.code !== 'string' || !/^[A-Z2-9]{6}$/u.test(input.code.trim().toUpperCase())) {
    throw fail('INVALID_ROOM_CODE', '房间码需为 6 位字母或数字。');
  }
  return { mode: 'join', code: input.code.trim().toUpperCase(), goal };
}
function validateCommand(input) {
  if (!record(input) || !COMMAND_TYPES.has(input.type)) throw fail('INVALID_COMMAND', '共学操作无效。');
  const result = { type: input.type };
  if (input.type === 'ready') {
    if (typeof input.ready !== 'boolean') throw fail('INVALID_INPUT', '准备状态需明确开启或取消。');
    result.ready = input.ready;
  }
  if (input.type === 'start') {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 180) {
      throw fail('INVALID_MINUTES', '共学时长需为 1–180 分钟的整数。');
    }
    result.minutes = input.minutes;
  }
  if (input.type === 'message') result.text = text(input.text, 1, 1000, '消息', true);
  return result;
}
function validateReceipt(input) {
  if (!record(input) || !id(input.roomId) || !id(input.roundId) || !id(input.memberId)
      || !TERMINAL_STATUSES.has(input.status) || !Number.isSafeInteger(input.durationMs)
      || input.durationMs < 60_000 || input.durationMs > 180 * 60_000
      || !Number.isSafeInteger(input.activeMs) || input.activeMs < 0 || input.activeMs > input.durationMs
      || (input.status === 'completed' && input.activeMs !== input.durationMs)) {
    throw fail('INVALID_RECEIPT', '共学结算信息无效。');
  }
  return { roomId: input.roomId, roundId: input.roundId, memberId: input.memberId,
    status: input.status, activeMs: input.activeMs, durationMs: input.durationMs };
}
function receiptKey(receipt) { return `${receipt.roomId}/${receipt.roundId}/${receipt.memberId}`; }

module.exports = { PROTOCOL_VERSION, MAX_MESSAGE_BYTES, RECONNECT_GRACE_MS, TERMINAL_STATUSES,
  ACTIVE_STATUSES, COMMAND_TYPES, fail, record, id, text, normalizeServerUrl, validateConfig,
  validateConnect, validateCommand, validateReceipt, receiptKey };
