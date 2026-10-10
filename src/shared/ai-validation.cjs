const { randomUUID } = require('node:crypto');

class AiError extends Error {
  constructor(code, message) { super(message); this.name = 'AiError'; this.code = code; }
}
function fail(code, message) { throw new AiError(code, message); }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', '请检查输入内容。'); return value; }
function text(value, name, maximum, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') fail('INVALID_INPUT', `${name}格式不正确。`);
  const result = value.trim();
  if ((!optional && !result) || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) fail('INVALID_INPUT', `${name}不能为空或超过 ${maximum} 字。`);
  return result;
}
function id(value, name = '记录') { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('INVALID_INPUT', `${name}无效。`); return value.toLowerCase(); }
function endpoint(value) {
  const raw = text(value, '服务地址', 2048);
  let url;
  try { url = new URL(raw); } catch { fail('INVALID_URL', '服务地址应是完整的 HTTPS 地址；本机服务可用 HTTP。'); }
  if (url.username || url.password || url.search || url.hash) fail('INVALID_URL', '服务地址不能包含账号、密码、查询参数或片段。');
  const hostname = url.hostname.toLowerCase();
  const local = hostname === 'localhost' || hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('INVALID_URL', '远程服务必须使用 HTTPS；HTTP 仅限本机回环地址。');
  return url.href.replace(/\/+$/, '');
}
function profile(value) {
  object(value);
  if (!['openai', 'anthropic', 'gemini'].includes(value.provider)) fail('INVALID_INPUT', '请选择支持的 AI 协议。');
  const result = { name: text(value.name, '连接名称', 80), provider: value.provider, baseUrl: endpoint(value.baseUrl), model: text(value.model, '模型 ID', 200, true), select: value.select !== false };
  if (value.id !== undefined) result.id = id(value.id, '连接');
  if (value.key !== undefined) {
    if (typeof value.key !== 'string' || value.key.length > 8192 || /[\r\n\u0000-\u001f]/.test(value.key)) fail('INVALID_INPUT', 'API Key 格式不正确。');
    result.key = value.key.trim();
  }
  return result;
}
function plan(value, goal, planId = randomUUID()) {
  object(value);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 12) fail('INVALID_PLAN', 'AI 拆解结果需要包含 1–12 个步骤，请重试。');
  return { id: planId, goal, steps: value.steps.map(step => {
    object(step);
    const title = text(step.title, '步骤标题', 140);
    const description = text(step.description, '步骤说明', 1000, true);
    if (!Number.isInteger(step.minutes) || step.minutes < 1 || step.minutes > 180) fail('INVALID_PLAN', 'AI 返回的步骤时长应为 1–180 分钟。');
    return { title, description, minutes: step.minutes };
  }) };
}
module.exports = { AiError, fail, object, text, id, endpoint, profile, plan };
