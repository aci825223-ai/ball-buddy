'use strict';

const { randomUUID } = require('node:crypto');
const { validateReceipt, receiptKey } = require('./study-protocol.cjs');

const MINUTE_MS = 60_000;
const MAX_MINUTES = 180;
const MIN_PET_SCALE = 70;
const MAX_PET_SCALE = 150;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const EVENT_KINDS = new Set(['task-completed', 'focus-completed', 'study-completed', 'decoration-unlocked']);
const MOTION_MODES = new Set(['full', 'gentle', 'static']);
const SETTINGS_DEFAULTS = Object.freeze({ focusMinutes: 25, motionMode: 'full', petScale: 100,
  themeMode: 'system', closeBehavior: 'tray', fontFamily: 'system', textSize: 'normal',
  importedFont: null, petAlwaysOnTop: true, petHints: 'hover', openPanelOnLaunch: true,
  notificationsEnabled: true });
const SETTING_ENUMS = Object.freeze({
  themeMode: new Set(['light', 'dark', 'system']), closeBehavior: new Set(['tray', 'quit']),
  fontFamily: new Set(['system', 'yahei', 'segoe', 'custom']), textSize: new Set(['small', 'normal', 'large']),
  petHints: new Set(['hover', 'always']),
});
const BOOLEAN_SETTINGS = ['petAlwaysOnTop', 'openPanelOnLaunch', 'notificationsEnabled'];
const DECORATIONS = Object.freeze({
  lamp: Object.freeze({ name: '桌灯', cost: 20 }),
  plant: Object.freeze({ name: '盆栽', cost: 30 }),
  books: Object.freeze({ name: '书本', cost: 40 }),
});

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkNow(now) {
  if (!isTimestamp(now)) throw failure('INVALID_TIME', '计时时间无效。');
  return now;
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES;
}

function isPetScale(value) {
  return Number.isInteger(value) && value >= MIN_PET_SCALE && value <= MAX_PET_SCALE;
}

function isFontDescriptor(value) {
  return isRecord(value) && typeof value.id === 'string' && /^[a-f0-9]{64}\.(ttf|otf|woff|woff2)$/u.test(value.id)
    && typeof value.name === 'string' && Array.from(value.name).length > 0 && Array.from(value.name).length <= 160
    && !/[\\/\u0000-\u001f\u007f]/u.test(value.name);
}

function normalizeSettings(settings) {
  const normalized = { ...copyRecord(settings), ...SETTINGS_DEFAULTS,
    focusMinutes: isMinutes(settings.focusMinutes) ? settings.focusMinutes : SETTINGS_DEFAULTS.focusMinutes,
    motionMode: MOTION_MODES.has(settings.motionMode) ? settings.motionMode : SETTINGS_DEFAULTS.motionMode,
    petScale: isPetScale(settings.petScale) ? settings.petScale : SETTINGS_DEFAULTS.petScale,
    importedFont: isFontDescriptor(settings.importedFont)
      ? { id: settings.importedFont.id, name: settings.importedFont.name } : null };
  for (const [key, allowed] of Object.entries(SETTING_ENUMS)) {
    normalized[key] = allowed.has(settings[key]) ? settings[key] : SETTINGS_DEFAULTS[key];
  }
  if (normalized.fontFamily === 'custom' && !normalized.importedFont) normalized.fontFamily = 'system';
  for (const key of BOOLEAN_SETTINGS) {
    normalized[key] = typeof settings[key] === 'boolean' ? settings[key] : SETTINGS_DEFAULTS[key];
  }
  return normalized;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  if (!title || Array.from(title).length > 140 || /[\u0000-\u001f\u007f]/u.test(title)) return null;
  return title;
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function addCounter(value, amount) {
  return Math.min(MAX_SAFE, value + amount);
}

// Unknown JSON fields belong to the user's saved data. Preserve them without
// retaining object references, unsupported values, or cycles from bad input.
function copyRecord(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const key of Object.keys(value)) {
    try {
      const encoded = JSON.stringify(value[key]);
      if (encoded !== undefined) {
        Object.defineProperty(result, key, {
          value: JSON.parse(encoded), writable: true, enumerable: true, configurable: true,
        });
      }
    } catch {
      // One malformed extension must not prevent recovery of the known state.
    }
  }
  return result;
}

function createInitialState(now = Date.now()) {
  checkNow(now);
  return {
    version: 1,
    tasks: [],
    selectedTaskId: null,
    session: null,
    stats: { energy: 0, completedTasks: 0, focusSessions: 0, totalFocusMs: 0 },
    decorations: [],
    settings: { ...SETTINGS_DEFAULTS },
    lastEvent: null,
    importedPlans: [],
    studyReceipts: [],
  };
}

function normalizeState(raw, now = Date.now()) {
  checkNow(now);
  const initial = createInitialState(now);
  if (!isRecord(raw)) return initial;

  const tasksById = new Map();
  for (const task of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!isRecord(task) || !isId(task.id) || !isTimestamp(task.createdAt)) continue;
    const title = cleanTitle(task.title);
    if (title === null) continue;
    const completedAt = task.completedAt == null ? null : task.completedAt;
    // Turning an invalid completion timestamp into an open task could allow a
    // second reward. Discard that damaged task instead.
    if (completedAt !== null && (!isTimestamp(completedAt) || completedAt < task.createdAt)) continue;
    const normalized = { ...copyRecord(task), id: task.id, title, createdAt: task.createdAt, completedAt };
    const existing = tasksById.get(task.id);
    if (!existing || (existing.completedAt === null && completedAt !== null)) tasksById.set(task.id, normalized);
  }
  const tasks = [...tasksById.values()];
  const stats = isRecord(raw.stats) ? raw.stats : {};
  const settings = isRecord(raw.settings) ? raw.settings : {};
  const decorations = [...new Set((Array.isArray(raw.decorations) ? raw.decorations : [])
    .filter((id) => typeof id === 'string' && Object.hasOwn(DECORATIONS, id)))];

  let session = null;
  const savedSession = raw.session;
  if (isRecord(savedSession) && isId(savedSession.id)
      && ['running', 'paused'].includes(savedSession.status)
      && Number.isSafeInteger(savedSession.durationMs)
      && savedSession.durationMs >= MINUTE_MS && savedSession.durationMs <= MAX_MINUTES * MINUTE_MS
      && Number.isSafeInteger(savedSession.remainingMs)
      && savedSession.remainingMs > 0 && savedSession.remainingMs <= savedSession.durationMs
      && (savedSession.taskId === null || isId(savedSession.taskId))) {
    const running = savedSession.status === 'running';
    const validDeadline = !running || (isTimestamp(savedSession.endAt)
      && savedSession.endAt >= savedSession.remainingMs
      && savedSession.endAt <= now + savedSession.remainingMs);
    if (validDeadline) {
      session = {
        ...copyRecord(savedSession),
        id: savedSession.id,
        taskId: tasksById.has(savedSession.taskId) ? savedSession.taskId : null,
        status: savedSession.status,
        durationMs: savedSession.durationMs,
        // While running this is the balance at the start of this segment;
        // live remaining time is always endAt - now. Pausing freezes it.
        remainingMs: savedSession.remainingMs,
        endAt: running ? savedSession.endAt : null,
      };
    }
  }

  let lastEvent = null;
  const savedEvent = raw.lastEvent;
  if (isRecord(savedEvent) && isId(savedEvent.id) && EVENT_KINDS.has(savedEvent.kind)
      && typeof savedEvent.message === 'string' && savedEvent.message.length <= 500
      && isTimestamp(savedEvent.at)) {
    lastEvent = { ...copyRecord(savedEvent), id: savedEvent.id, kind: savedEvent.kind,
      message: savedEvent.message, at: savedEvent.at };
  }

  return {
    ...copyRecord(raw),
    version: 1,
    tasks,
    selectedTaskId: tasksById.has(raw.selectedTaskId) ? raw.selectedTaskId : null,
    session,
    stats: {
      ...copyRecord(stats),
      energy: nonNegativeInteger(stats.energy),
      completedTasks: Math.max(nonNegativeInteger(stats.completedTasks), tasks.filter((task) => task.completedAt !== null).length),
      focusSessions: nonNegativeInteger(stats.focusSessions),
      totalFocusMs: nonNegativeInteger(stats.totalFocusMs),
    },
    decorations,
    settings: normalizeSettings(settings),
    lastEvent,
    importedPlans: [...new Set((Array.isArray(raw.importedPlans) ? raw.importedPlans : []).filter(isId))],
    studyReceipts: [...new Set((Array.isArray(raw.studyReceipts) ? raw.studyReceipts : [])
      .filter((key) => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}$/u.test(key)))],
  };
}

function event(kind, message, now) {
  return { id: `event_${randomUUID()}`, kind, message, at: now };
}

function remainingAt(session, now) {
  return Math.max(0, Math.min(session.remainingMs, session.endAt - now));
}

function reconcileState(state, now = Date.now()) {
  checkNow(now);
  const session = state.session;
  if (!session || session.status !== 'running' || now < session.endAt) {
    return { state, effects: [] };
  }
  const message = '这一轮专注完成了，获得 5 点能量。休息一下吧。';
  return {
    state: {
      ...state,
      session: null,
      stats: {
        ...state.stats,
        energy: addCounter(state.stats.energy, 5),
        focusSessions: addCounter(state.stats.focusSessions, 1),
        totalFocusMs: addCounter(state.stats.totalFocusMs, session.remainingMs),
      },
      lastEvent: event('focus-completed', message, now),
    },
    effects: [{ type: 'focus-finished', message }],
  };
}

function findTask(state, taskId) {
  if (!isId(taskId)) throw failure('INVALID_TASK_ID', '任务编号无效。');
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw failure('TASK_NOT_FOUND', '找不到这个任务。');
  return task;
}

function applyCommand(state, command, now = Date.now()) {
  checkNow(now);
  if (!isRecord(command) || typeof command.type !== 'string') {
    throw failure('INVALID_COMMAND', '操作格式无效。');
  }
  const reconciled = reconcileState(state, now);
  const current = reconciled.state;
  let next = current;
  const effects = [...reconciled.effects];

  switch (command.type) {
    case 'task.batch-add': {
      if (!isId(command.planId)) throw failure('INVALID_PLAN', '任务拆解编号无效。');
      if ((current.importedPlans || []).includes(command.planId)) throw failure('PLAN_ALREADY_IMPORTED', '这份拆解已经加入任务，请查看任务列表。');
      if (!Array.isArray(command.tasks) || command.tasks.length < 1 || command.tasks.length > 12) {
        throw failure('INVALID_BATCH', '请选择 1–12 个步骤加入任务。');
      }
      const candidates = command.tasks.map((candidate) => {
        if (!isRecord(candidate)) throw failure('INVALID_BATCH', '任务步骤格式无效。');
        const title = cleanTitle(candidate.title);
        if (title === null) throw failure('INVALID_TITLE', '每个步骤需填写 1–140 个字的名称。');
        if (candidate.estimatedMinutes !== undefined && !isMinutes(candidate.estimatedMinutes)) {
          throw failure('INVALID_MINUTES', '步骤预计时长需为 1–180 分钟的整数。');
        }
        return { title, ...(candidate.estimatedMinutes === undefined ? {} : { estimatedMinutes: candidate.estimatedMinutes }) };
      });
      const tasks = candidates.map((candidate) => ({ ...candidate, id: `task_${randomUUID()}`, createdAt: now,
        completedAt: null, planId: command.planId }));
      next = { ...current, tasks: [...current.tasks, ...tasks], selectedTaskId: current.selectedTaskId || tasks[0].id,
        importedPlans: [...(current.importedPlans || []), command.planId] };
      break;
    }
    case 'task.add': {
      const title = cleanTitle(command.title);
      if (title === null) throw failure('INVALID_TITLE', '请填写 1–140 个字的任务名称。');
      const task = { id: `task_${randomUUID()}`, title, createdAt: now, completedAt: null };
      next = { ...current, tasks: [...current.tasks, task], selectedTaskId: current.selectedTaskId || task.id };
      break;
    }
    case 'task.select': {
      if (command.taskId !== null) findTask(current, command.taskId);
      next = { ...current, selectedTaskId: command.taskId };
      break;
    }
    case 'task.complete': {
      const task = findTask(current, command.taskId);
      if (task.completedAt !== null) throw failure('TASK_ALREADY_COMPLETED', '这个任务已经完成并获得奖励了。');
      const message = '完成一件小事，获得 10 点能量！';
      next = {
        ...current,
        tasks: current.tasks.map((item) => item.id === task.id ? { ...item, completedAt: now } : item),
        stats: { ...current.stats, energy: addCounter(current.stats.energy, 10),
          completedTasks: addCounter(current.stats.completedTasks, 1) },
        lastEvent: event('task-completed', message, now),
      };
      effects.push({ type: 'celebrate', message });
      break;
    }
    case 'focus.start': {
      if (current.session) throw failure('SESSION_ACTIVE', '当前已有一轮专注，请先结束它。');
      const minutes = command.minutes === undefined ? current.settings.focusMinutes : command.minutes;
      if (!isMinutes(minutes)) throw failure('INVALID_MINUTES', '专注时长需为 1–180 分钟的整数。');
      const taskId = command.taskId === undefined ? current.selectedTaskId : command.taskId;
      if (taskId !== null) findTask(current, taskId);
      const durationMs = minutes * MINUTE_MS;
      if (!Number.isSafeInteger(now + durationMs)) throw failure('INVALID_TIME', '计时结束时间超出有效范围。');
      next = {
        ...current,
        session: { id: `session_${randomUUID()}`, taskId, status: 'running', durationMs,
          remainingMs: durationMs, endAt: now + durationMs },
      };
      break;
    }
    case 'focus.pause': {
      // A pause arriving exactly at the deadline still completes the round.
      if (!current.session && reconciled.effects.length) break;
      if (!current.session) throw failure('NO_SESSION', '当前没有正在进行的专注。');
      if (current.session.status !== 'running') throw failure('SESSION_NOT_RUNNING', '这一轮专注已经暂停了。');
      const remainingMs = remainingAt(current.session, now);
      next = {
        ...current,
        session: { ...current.session, status: 'paused', remainingMs, endAt: null },
        stats: { ...current.stats,
          totalFocusMs: addCounter(current.stats.totalFocusMs, current.session.remainingMs - remainingMs) },
      };
      break;
    }
    case 'focus.resume': {
      if (!current.session) throw failure('NO_SESSION', '当前没有可以继续的专注。');
      if (current.session.status !== 'paused') throw failure('SESSION_NOT_PAUSED', '这一轮专注正在进行。');
      if (!Number.isSafeInteger(now + current.session.remainingMs)) throw failure('INVALID_TIME', '计时结束时间超出有效范围。');
      next = { ...current, session: { ...current.session, status: 'running', endAt: now + current.session.remainingMs } };
      break;
    }
    case 'focus.stop': {
      if (!current.session && reconciled.effects.length) break;
      if (!current.session) throw failure('NO_SESSION', '当前没有需要结束的专注。');
      const elapsed = current.session.status === 'running'
        ? current.session.remainingMs - remainingAt(current.session, now) : 0;
      next = { ...current, session: null,
        stats: { ...current.stats, totalFocusMs: addCounter(current.stats.totalFocusMs, elapsed) } };
      break;
    }
    case 'decoration.buy': {
      const id = command.decorationId;
      if (typeof id !== 'string' || !Object.hasOwn(DECORATIONS, id)) {
        throw failure('INVALID_DECORATION', '找不到这个书桌布置。');
      }
      if (current.decorations.includes(id)) throw failure('DECORATION_ALREADY_UNLOCKED', '你已经拥有这个布置了。');
      const decoration = DECORATIONS[id];
      if (current.stats.energy < decoration.cost) throw failure('INSUFFICIENT_ENERGY', '能量还不够，再完成几件小事吧。');
      const message = `解锁了${decoration.name}，小窝又多了一点温暖。`;
      next = { ...current, decorations: [...current.decorations, id],
        stats: { ...current.stats, energy: current.stats.energy - decoration.cost },
        lastEvent: event('decoration-unlocked', message, now) };
      effects.push({ type: 'celebrate', message });
      break;
    }
    case 'settings.update': {
      const updates = {};
      if (Object.hasOwn(command, 'importedFont')) throw failure('INVALID_FONT_IMPORT', '请通过导入字体选择本地字体文件。');
      if (Object.hasOwn(command, 'focusMinutes')) {
        if (!isMinutes(command.focusMinutes)) throw failure('INVALID_MINUTES', '专注时长需为 1–180 分钟的整数。');
        updates.focusMinutes = command.focusMinutes;
      }
      if (Object.hasOwn(command, 'motionMode')) {
        if (!MOTION_MODES.has(command.motionMode)) throw failure('INVALID_MOTION_MODE', '请选择灵动、轻柔或静止动画。');
        updates.motionMode = command.motionMode;
      }
      if (Object.hasOwn(command, 'petScale')) {
        if (!isPetScale(command.petScale)) throw failure('INVALID_PET_SCALE', '桌面小球大小需为 70%–150% 的整数。');
        updates.petScale = command.petScale;
      }
      for (const [key, allowed] of Object.entries(SETTING_ENUMS)) {
        if (!Object.hasOwn(command, key)) continue;
        if (!allowed.has(command[key])) throw failure('INVALID_SETTINGS', '设置选项无效，请重新选择。');
        updates[key] = command[key];
      }
      for (const key of BOOLEAN_SETTINGS) {
        if (!Object.hasOwn(command, key)) continue;
        if (typeof command[key] !== 'boolean') throw failure('INVALID_SETTINGS', '设置开关需要明确的开启或关闭值。');
        updates[key] = command[key];
      }
      if (updates.fontFamily === 'custom' && !isFontDescriptor(current.settings.importedFont)) {
        throw failure('FONT_NOT_IMPORTED', '请先导入可用的字体文件。');
      }
      if (!Object.keys(updates).length) throw failure('INVALID_SETTINGS', '没有需要更新的设置。');
      next = { ...current, settings: { ...current.settings, ...updates } };
      break;
    }
    case 'settings.reset': {
      next = { ...current, settings: { ...current.settings, ...SETTINGS_DEFAULTS,
        importedFont: isFontDescriptor(current.settings.importedFont) ? current.settings.importedFont : null } };
      break;
    }
    default:
      throw failure('INVALID_COMMAND', '不支持这个操作。');
  }

  return { state: next, effects };
}

// Main process calls this only after an approved native-dialog candidate has
// decoded in FontFace and its managed copy is saved. It is not a public command.
function applyImportedFont(state, font, now = Date.now()) {
  checkNow(now);
  if (!isFontDescriptor(font)) throw failure('INVALID_FONT_IMPORT', '导入字体信息无效，请重新选择。');
  const result = reconcileState(state, now);
  return { state: { ...result.state, settings: { ...result.state.settings,
    importedFont: { id: font.id, name: font.name }, fontFamily: 'custom' } }, effects: result.effects };
}

// Authenticated study-client receipts only. The receipt marker and all counters
// are returned in one state so main's atomic save cannot split the reward.
function applyStudyReceipt(state, input, now = Date.now()) {
  checkNow(now);
  const receipt = validateReceipt(input);
  const key = receiptKey(receipt);
  if ((state.studyReceipts || []).includes(key)) return { state, effects: [] };
  const result = reconcileState(state, now);
  const completed = receipt.status === 'completed';
  const message = '和同桌完成一轮共学，获得 5 点能量。';
  return { state: { ...result.state, studyReceipts: [...(result.state.studyReceipts || []), key],
    stats: { ...result.state.stats,
      totalFocusMs: addCounter(result.state.stats.totalFocusMs, receipt.activeMs),
      focusSessions: addCounter(result.state.stats.focusSessions, completed ? 1 : 0),
      energy: addCounter(result.state.stats.energy, completed ? 5 : 0) },
    ...(completed ? { lastEvent: event('study-completed', message, now) } : {}) },
  effects: [...result.effects, ...(completed ? [{ type: 'focus-finished', message, study: true }] : [])] };
}

module.exports = { createInitialState, normalizeState, applyCommand, applyImportedFont, applyStudyReceipt, reconcileState,
  DECORATIONS, SETTINGS_DEFAULTS, isFontDescriptor };
