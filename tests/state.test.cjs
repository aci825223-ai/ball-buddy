'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialState, normalizeState, applyCommand, applyImportedFont, reconcileState,
  DECORATIONS, SETTINGS_DEFAULTS } = require('../src/shared/state.cjs');

const BASE = 1_800_000_000_000;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function command(state, type, payload = {}, now = BASE) {
  return applyCommand(deepFreeze(state), { type, ...payload }, now);
}

function addTask(state, title = '整理简历', now = BASE) {
  return command(state, 'task.add', { title }, now).state;
}

function started(minutes = 1, now = BASE) {
  return command(createInitialState(now), 'focus.start', { minutes, taskId: null }, now).state;
}

function rejectsWithoutMutation(state, type, payload, code, now = BASE) {
  const before = JSON.stringify(state);
  assert.throws(() => command(state, type, payload, now), (error) => error.code === code);
  assert.equal(JSON.stringify(state), before);
}

test('initial state has no sample tasks, rewards or shared mutable collections', () => {
  const first = createInitialState(BASE);
  const second = createInitialState(BASE);
  assert.deepEqual(first.tasks, []);
  assert.deepEqual(first.stats, { energy: 0, completedTasks: 0, focusSessions: 0, totalFocusMs: 0 });
  assert.deepEqual(first.settings, { ...SETTINGS_DEFAULTS });
  assert.equal(first.session, null);
  assert.notEqual(first.tasks, second.tasks);
  assert.notEqual(first.stats, second.stats);
  assert.ok(Object.isFrozen(DECORATIONS));
});

test('task creation trims text, preserves distinct IDs and selects the first task', () => {
  const initial = createInitialState(BASE);
  const first = addTask(initial, '  整理简历  ');
  const second = addTask(first, '整理简历');
  assert.equal(first.tasks[0].title, '整理简历');
  assert.equal(first.selectedTaskId, first.tasks[0].id);
  assert.notEqual(second.tasks[0].id, second.tasks[1].id);
  assert.equal(second.selectedTaskId, first.tasks[0].id);
  assert.equal(initial.tasks.length, 0);
  assert.equal(first.tasks.length, 1);
  const selected = command(second, 'task.select', { taskId: second.tasks[1].id }).state;
  assert.equal(selected.selectedTaskId, second.tasks[1].id);
  assert.equal(command(selected, 'task.select', { taskId: null }).state.selectedTaskId, null);
});

test('titles are validated by characters, including supplementary Unicode', () => {
  const state = createInitialState(BASE);
  for (const title of ['', '   ', 123, null, 'a\nb', 'x'.repeat(141), '😀'.repeat(141)]) {
    rejectsWithoutMutation(state, 'task.add', { title }, 'INVALID_TITLE');
  }
  assert.equal(addTask(state, '😀'.repeat(140)).tasks[0].title, '😀'.repeat(140));
});

test('completing a task rewards it once and preserves its active focus session', () => {
  const state = addTask(createInitialState(BASE));
  const taskId = state.tasks[0].id;
  const active = command(state, 'focus.start', { taskId, minutes: 1 }).state;
  const result = command(active, 'task.complete', { taskId }, BASE + 1_000);
  assert.equal(result.state.tasks[0].completedAt, BASE + 1_000);
  assert.equal(result.state.stats.energy, 10);
  assert.equal(result.state.stats.completedTasks, 1);
  assert.equal(result.state.session.id, active.session.id);
  assert.equal(result.state.lastEvent.kind, 'task-completed');
  assert.equal(result.effects[0].type, 'celebrate');
  rejectsWithoutMutation(result.state, 'task.complete', { taskId }, 'TASK_ALREADY_COMPLETED', BASE + 2_000);
  rejectsWithoutMutation(state, 'task.complete', { taskId: 'missing' }, 'TASK_NOT_FOUND');
});

test('start uses selected task and chosen duration; a second start cannot replace a live or paused session', () => {
  let state = addTask(createInitialState(BASE));
  state = command(state, 'settings.update', { focusMinutes: 45 }).state;
  const active = command(state, 'focus.start').state;
  assert.equal(active.session.taskId, state.selectedTaskId);
  assert.equal(active.session.durationMs, 45 * 60_000);
  assert.equal(active.session.endAt, BASE + 45 * 60_000);
  rejectsWithoutMutation(active, 'focus.start', { minutes: 15 }, 'SESSION_ACTIVE', BASE + 1_000);
  const paused = command(active, 'focus.pause', {}, BASE + 1_000).state;
  rejectsWithoutMutation(paused, 'focus.start', { minutes: 15 }, 'SESSION_ACTIVE', BASE + 2_000);
});

test('pause/resume excludes idle time and stop counts each active segment exactly once', () => {
  const active = started();
  const paused = command(active, 'focus.pause', {}, BASE + 12_000).state;
  assert.equal(paused.session.status, 'paused');
  assert.equal(paused.session.remainingMs, 48_000);
  assert.equal(paused.session.endAt, null);
  assert.equal(paused.stats.totalFocusMs, 12_000);
  assert.equal(reconcileState(paused, BASE + 600_000).state, paused);
  const resumed = command(paused, 'focus.resume', {}, BASE + 612_000).state;
  assert.equal(resumed.session.endAt, BASE + 660_000);
  const pausedAgain = command(resumed, 'focus.pause', {}, BASE + 632_000).state;
  assert.equal(pausedAgain.session.remainingMs, 28_000);
  assert.equal(pausedAgain.stats.totalFocusMs, 32_000);
  const resumedAgain = command(pausedAgain, 'focus.resume', {}, BASE + 900_000).state;
  const stopped = command(resumedAgain, 'focus.stop', {}, BASE + 907_000).state;
  assert.equal(stopped.stats.totalFocusMs, 39_000);
  assert.equal(stopped.session, null);
  assert.equal(stopped.stats.energy, 0);
  assert.equal(stopped.stats.focusSessions, 0);
  rejectsWithoutMutation(stopped, 'focus.stop', {}, 'NO_SESSION', BASE + 908_000);
});

test('stopping while paused never counts the pause or grants completion energy', () => {
  const paused = command(started(), 'focus.pause', {}, BASE + 13_000).state;
  const stopped = command(paused, 'focus.stop', {}, BASE + 50_000_000).state;
  assert.equal(stopped.stats.totalFocusMs, 13_000);
  assert.equal(stopped.stats.energy, 0);
  assert.equal(stopped.stats.focusSessions, 0);
});

test('natural completion is timestamp based and delayed reconciliation does not count overtime', () => {
  const active = started();
  assert.equal(reconcileState(active, BASE + 59_999).state, active);
  const result = reconcileState(deepFreeze(active), BASE + 10_000_000);
  assert.equal(result.state.session, null);
  assert.equal(result.state.stats.totalFocusMs, 60_000);
  assert.equal(result.state.stats.energy, 5);
  assert.equal(result.state.stats.focusSessions, 1);
  assert.equal(result.state.lastEvent.kind, 'focus-completed');
  assert.equal(result.effects[0].type, 'focus-finished');
  assert.deepEqual(reconcileState(result.state, BASE + 20_000_000), { state: result.state, effects: [] });
});

test('completion after several pauses accounts for a full duration once', () => {
  let state = started();
  state = command(state, 'focus.pause', {}, BASE + 15_000).state;
  state = command(state, 'focus.resume', {}, BASE + 90_000).state;
  state = command(state, 'focus.pause', {}, BASE + 100_000).state;
  state = command(state, 'focus.resume', {}, BASE + 120_000).state;
  const result = reconcileState(state, BASE + 155_000);
  assert.equal(result.state.stats.totalFocusMs, 60_000);
  assert.equal(result.state.stats.energy, 5);
  assert.equal(result.state.stats.focusSessions, 1);
});

test('pause and stop at the exact deadline complete the round; a next start keeps that reward', () => {
  for (const type of ['focus.pause', 'focus.stop']) {
    const result = command(started(), type, {}, BASE + 60_000);
    assert.equal(result.state.session, null);
    assert.equal(result.state.stats.energy, 5);
    assert.equal(result.state.stats.totalFocusMs, 60_000);
  }
  const result = command(started(), 'focus.start', { minutes: 2, taskId: null }, BASE + 60_000);
  assert.equal(result.state.session.durationMs, 120_000);
  assert.equal(result.state.stats.energy, 5);
  assert.equal(result.effects[0].type, 'focus-finished');
});

test('task and focus completion are separate rewards even at the same timestamp', () => {
  const pending = addTask(createInitialState(BASE));
  const active = command(pending, 'focus.start', { minutes: 1 }).state;
  const result = command(active, 'task.complete', { taskId: pending.tasks[0].id }, BASE + 60_000);
  assert.equal(result.state.stats.energy, 15);
  assert.equal(result.state.stats.completedTasks, 1);
  assert.equal(result.state.stats.focusSessions, 1);
  assert.deepEqual(result.effects.map((effect) => effect.type), ['focus-finished', 'celebrate']);
});

test('saved running and paused sessions recover without losing time or granting a phantom reward', () => {
  const active = started();
  const recovered = normalizeState(JSON.parse(JSON.stringify(active)), BASE + 20_000);
  const paused = command(recovered, 'focus.pause', {}, BASE + 25_000).state;
  assert.equal(paused.stats.totalFocusMs, 25_000);
  assert.equal(paused.session.remainingMs, 35_000);
  const pausedRecovery = normalizeState(JSON.parse(JSON.stringify(paused)), BASE + 5_000_000);
  assert.equal(pausedRecovery.stats.energy, 0);
  assert.equal(pausedRecovery.session.remainingMs, 35_000);
  const resumed = command(pausedRecovery, 'focus.resume', {}, BASE + 5_000_000).state;
  const done = reconcileState(resumed, BASE + 5_035_000).state;
  assert.equal(done.stats.totalFocusMs, 60_000);
  assert.equal(done.stats.energy, 5);
  const doneRecovery = normalizeState(done, BASE + 8_000_000);
  assert.equal(reconcileState(doneRecovery, BASE + 8_000_000).state.stats.energy, 5);
});

test('an already expired saved session completes once during reconciliation, not normalization', () => {
  const recovered = normalizeState(started(), BASE + 120_000);
  assert.equal(recovered.stats.energy, 0);
  assert.notEqual(recovered.session, null);
  const completed = reconcileState(recovered, BASE + 120_000).state;
  assert.equal(completed.stats.energy, 5);
  assert.equal(completed.stats.totalFocusMs, 60_000);
  assert.equal(reconcileState(normalizeState(completed, BASE + 200_000), BASE + 200_000).state.stats.energy, 5);
});

test('decorations charge exactly their cost and cannot be repurchased', () => {
  let state = createInitialState(BASE);
  state = { ...state, stats: { ...state.stats, energy: 90 } };
  for (const [id, decoration] of Object.entries(DECORATIONS)) {
    const before = state.stats.energy;
    const result = command(state, 'decoration.buy', { decorationId: id });
    state = result.state;
    assert.equal(state.stats.energy, before - decoration.cost);
    assert.ok(state.decorations.includes(id));
    assert.equal(state.lastEvent.kind, 'decoration-unlocked');
    rejectsWithoutMutation(state, 'decoration.buy', { decorationId: id }, 'DECORATION_ALREADY_UNLOCKED');
  }
  assert.equal(state.stats.energy, 0);
  rejectsWithoutMutation(createInitialState(BASE), 'decoration.buy', { decorationId: 'lamp' }, 'INSUFFICIENT_ENERGY');
  for (const decorationId of ['constructor', '__proto__', 'unknown', null, 1]) {
    rejectsWithoutMutation(state, 'decoration.buy', { decorationId }, 'INVALID_DECORATION');
  }
});

test('invalid commands, task references and duration input leave frozen state unchanged', () => {
  const state = createInitialState(BASE);
  for (const minutes of [0, 181, -1, 1.5, '25', NaN, Infinity, null]) {
    rejectsWithoutMutation(state, 'focus.start', { minutes, taskId: null }, 'INVALID_MINUTES');
    rejectsWithoutMutation(state, 'settings.update', { focusMinutes: minutes }, 'INVALID_MINUTES');
  }
  rejectsWithoutMutation(state, 'task.select', { taskId: 'missing' }, 'TASK_NOT_FOUND');
  rejectsWithoutMutation(state, 'focus.start', { taskId: 'missing' }, 'TASK_NOT_FOUND');
  rejectsWithoutMutation(state, 'task.remove', {}, 'INVALID_COMMAND');
  for (const input of [null, [], 'focus.start', {}, { type: 1 }]) {
    assert.throws(() => applyCommand(state, input, BASE), (error) => error.code === 'INVALID_COMMAND');
  }
  for (const now of [-1, NaN, Infinity, 1.5, '100']) {
    assert.throws(() => createInitialState(now), (error) => error.code === 'INVALID_TIME');
  }
});

test('pause and resume reject invalid transitions without changing elapsed accounting', () => {
  const active = started();
  rejectsWithoutMutation(active, 'focus.resume', {}, 'SESSION_NOT_PAUSED');
  const paused = command(active, 'focus.pause', {}, BASE + 10_000).state;
  rejectsWithoutMutation(paused, 'focus.pause', {}, 'SESSION_NOT_RUNNING', BASE + 20_000);
  rejectsWithoutMutation(createInitialState(BASE), 'focus.pause', {}, 'NO_SESSION');
  rejectsWithoutMutation(createInitialState(BASE), 'focus.resume', {}, 'NO_SESSION');
});

test('normalization preserves valid user data and JSON extensions without retaining references', () => {
  const state = addTask(createInitialState(BASE));
  const raw = { ...state, extension: { favoriteColor: 'blue', tags: ['study'] },
    settings: { focusMinutes: 15, soundEnabled: false }, stats: { ...state.stats, customCounter: 3 } };
  const result = normalizeState(raw, BASE);
  assert.deepEqual(result.extension, raw.extension);
  assert.notEqual(result.extension, raw.extension);
  assert.notEqual(result.extension.tags, raw.extension.tags);
  assert.equal(result.settings.soundEnabled, false);
  assert.equal(result.stats.customCounter, 3);
  assert.equal(result.tasks[0].id, raw.tasks[0].id);
  assert.notEqual(result.tasks[0], raw.tasks[0]);
  assert.equal(result.settings.focusMinutes, 15);
});

test('animation preference defaults to full and survives recovery without losing extensions', () => {
  assert.equal(createInitialState(BASE).settings.motionMode, 'full');
  for (const motionMode of ['full', 'gentle', 'static']) {
    const recovered = normalizeState({ ...createInitialState(BASE),
      settings: { focusMinutes: 15, motionMode, custom: { theme: 'paper' } } }, BASE);
    assert.equal(recovered.settings.motionMode, motionMode);
    assert.equal(recovered.settings.focusMinutes, 15);
    assert.deepEqual(recovered.settings.custom, { theme: 'paper' });
  }
  for (const motionMode of [undefined, null, 'fast', 1, [], {}]) {
    const recovered = normalizeState({ settings: { focusMinutes: 15, motionMode } }, BASE);
    assert.equal(recovered.settings.motionMode, 'full');
    assert.equal(recovered.settings.focusMinutes, 15);
  }
});

test('settings update changes individual or combined preferences and leaves focus and reward data intact', () => {
  const initial = { ...started(), settings: { focusMinutes: 25, motionMode: 'full', petScale: 100, custom: { theme: 'paper' } } };
  const gentle = command(initial, 'settings.update', { motionMode: 'gentle' }, BASE + 1_000).state;
  assert.deepEqual(gentle.settings, { focusMinutes: 25, motionMode: 'gentle', petScale: 100, custom: { theme: 'paper' } });
  assert.deepEqual(gentle.session, initial.session);
  assert.deepEqual(gentle.stats, initial.stats);
  const duration = command(gentle, 'settings.update', { focusMinutes: 45 }, BASE + 2_000).state;
  assert.equal(duration.settings.motionMode, 'gentle');
  assert.equal(duration.settings.focusMinutes, 45);
  const combined = command(duration, 'settings.update', { focusMinutes: 15, motionMode: 'static', petScale: 150 }, BASE + 3_000).state;
  assert.equal(combined.settings.motionMode, 'static');
  assert.equal(combined.settings.focusMinutes, 15);
  assert.equal(combined.settings.petScale, 150);
  assert.deepEqual(combined.session, initial.session);
  for (const motionMode of [undefined, null, 'fast', 1, [], {}]) {
    rejectsWithoutMutation(combined, 'settings.update', { focusMinutes: 10, motionMode }, 'INVALID_MOTION_MODE', BASE + 4_000);
  }
  rejectsWithoutMutation(combined, 'settings.update', { focusMinutes: undefined }, 'INVALID_MINUTES', BASE + 4_000);
  rejectsWithoutMutation(combined, 'settings.update', {}, 'INVALID_SETTINGS', BASE + 4_000);
  rejectsWithoutMutation(combined, 'settings.update', { unknownPreference: true }, 'INVALID_SETTINGS', BASE + 4_000);
});

test('pet size recovers valid boundaries and defaults for old or damaged settings without losing extensions', () => {
  const legacy = { ...addTask(createInitialState(BASE)), settings: { focusMinutes: 45, motionMode: 'gentle',
    custom: { theme: 'paper', favoriteSizes: [80, 120] } }, extension: { note: 'keep' } };
  const recoveredLegacy = normalizeState(legacy, BASE);
  assert.equal(recoveredLegacy.settings.petScale, 100);
  assert.equal(recoveredLegacy.version, 1);
  assert.deepEqual(recoveredLegacy.tasks, legacy.tasks);
  assert.deepEqual(recoveredLegacy.settings.custom, legacy.settings.custom);
  assert.notEqual(recoveredLegacy.settings.custom, legacy.settings.custom);
  assert.deepEqual(recoveredLegacy.extension, legacy.extension);
  for (const petScale of [70, 100, 150]) {
    const recovered = normalizeState({ ...legacy, settings: { ...legacy.settings, petScale } }, BASE);
    assert.deepEqual(recovered.settings, { ...SETTINGS_DEFAULTS, ...legacy.settings, petScale });
  }
  for (const petScale of [undefined, null, 69, 151, 100.5, '100', NaN, Infinity, true, [], {}]) {
    const recovered = normalizeState({ ...legacy, settings: { ...legacy.settings, petScale } }, BASE);
    assert.deepEqual(recovered.settings, { ...SETTINGS_DEFAULTS, ...legacy.settings, petScale: 100 });
    assert.deepEqual(recovered.tasks, legacy.tasks);
  }
});

test('pet size updates and reset preserve tasks, active session, rewards and unknown saved fields', () => {
  let initial = addTask(createInitialState(BASE), '整理资料');
  initial = command(initial, 'focus.start', { minutes: 25 }).state;
  initial = { ...initial, settings: { ...initial.settings, custom: { theme: 'paper' } },
    stats: { ...initial.stats, energy: 12, customCounter: 7 }, extension: { note: 'keep' } };
  for (const petScale of [70, 150, 100]) {
    const result = command(initial, 'settings.update', { petScale }, BASE + 1_000);
    assert.deepEqual(result.state, { ...initial, settings: { ...initial.settings, petScale } });
    assert.deepEqual(result.effects, []);
    const recovered = normalizeState(JSON.parse(JSON.stringify(result.state)), BASE + 2_000);
    assert.deepEqual(recovered, result.state);
    assert.equal(recovered.version, 1);
  }
});

test('an invalid member rejects a combined settings update atomically', () => {
  const initial = { ...started(), settings: { focusMinutes: 25, motionMode: 'full', petScale: 100,
    custom: { theme: 'paper' } } };
  for (const petScale of [undefined, null, 69, 151, -1, 100.5, '100', NaN, Infinity, true, [], {}]) {
    rejectsWithoutMutation(initial, 'settings.update', { focusMinutes: 45, motionMode: 'gentle', petScale },
      'INVALID_PET_SCALE', BASE + 1_000);
    assert.throws(() => command(initial, 'settings.update', { petScale }, BASE + 1_000),
      (error) => error.code === 'INVALID_PET_SCALE' && /70%–150%/.test(error.message));
  }
  rejectsWithoutMutation(initial, 'settings.update', { focusMinutes: 0, motionMode: 'gentle', petScale: 70 },
    'INVALID_MINUTES', BASE + 1_000);
  rejectsWithoutMutation(initial, 'settings.update', { focusMinutes: 45, motionMode: 'fast', petScale: 70 },
    'INVALID_MOTION_MODE', BASE + 1_000);
});

test('corrupted state falls back safely and invalid sessions never create rewards', () => {
  for (const raw of [null, [], 42, 'broken']) assert.deepEqual(normalizeState(raw, BASE), createInitialState(BASE));
  for (const patch of [
    { id: '' }, { durationMs: -1 }, { remainingMs: -1 }, { remainingMs: 60_001 },
    { remainingMs: 0 }, { endAt: NaN }, { endAt: -1 }, { endAt: BASE + 70_000 },
    { status: 'finished' }, { taskId: 4 },
  ]) {
    const raw = started();
    const normalized = normalizeState({ ...raw, session: { ...raw.session, ...patch } }, BASE);
    assert.equal(normalized.session, null, JSON.stringify(patch));
    assert.equal(reconcileState(normalized, BASE + 1_000_000).state.stats.energy, 0);
  }
  const cycle = {};
  cycle.self = cycle;
  const normalized = normalizeState({ version: 999, stats: { energy: -1, focusSessions: '5', totalFocusMs: Infinity },
    tasks: [null, { id: 'bad', title: 'bad', createdAt: BASE, completedAt: 'broken' }],
    selectedTaskId: 'bad', settings: { focusMinutes: 200 }, decorations: ['lamp', 'lamp', '__proto__'],
    lastEvent: { id: 'event', kind: 'unknown', message: 'bad', at: BASE }, extension: cycle }, BASE);
  assert.equal(normalized.version, 1);
  assert.deepEqual(normalized.tasks, []);
  assert.equal(normalized.selectedTaskId, null);
  assert.equal(normalized.stats.energy, 0);
  assert.equal(normalized.stats.totalFocusMs, 0);
  assert.equal(normalized.settings.focusMinutes, 25);
  assert.deepEqual(normalized.decorations, ['lamp']);
  assert.equal(normalized.lastEvent, null);
  assert.equal(Object.hasOwn(normalized, 'extension'), false);
});

test('duplicate recovered task IDs favor completed records to prevent a second reward', () => {
  const open = { id: 'same', title: '整理简历', createdAt: BASE, completedAt: null };
  const done = { ...open, completedAt: BASE + 1_000 };
  for (const tasks of [[open, done], [done, open]]) {
    const recovered = normalizeState({ ...createInitialState(BASE), tasks }, BASE + 2_000);
    assert.equal(recovered.tasks.length, 1);
    assert.equal(recovered.tasks[0].completedAt, BASE + 1_000);
    assert.equal(recovered.stats.completedTasks, 1);
    assert.equal(recovered.stats.energy, 0);
    rejectsWithoutMutation(recovered, 'task.complete', { taskId: 'same' }, 'TASK_ALREADY_COMPLETED', BASE + 3_000);
  }
});

test('legacy settings gain supported preferences while saved business and unknown fields survive', () => {
  const legacy = { ...started(), settings: { focusMinutes: 45, motionMode: 'gentle', petScale: 82,
    petPosition: { x: -400, y: 200 }, extension: { setting: 'kept' } } };
  const normalized = normalizeState(legacy, BASE);
  assert.deepEqual(normalized.settings, { ...SETTINGS_DEFAULTS, ...legacy.settings });
  assert.deepEqual(normalized.session, legacy.session);
  assert.equal(normalized.version, 1);
  assert.notEqual(normalized.settings.extension, legacy.settings.extension);
  assert.notEqual(normalized.settings.petPosition, legacy.settings.petPosition);
});

test('settings enum and boolean preferences validate strictly and combined changes are atomic', () => {
  const initial = started();
  const options = { themeMode: ['light', 'dark', 'system'], closeBehavior: ['tray', 'quit'],
    fontFamily: ['system', 'yahei', 'segoe'], textSize: ['small', 'normal', 'large'], petHints: ['hover', 'always'] };
  for (const [key, values] of Object.entries(options)) {
    for (const value of values) assert.equal(command(initial, 'settings.update', { [key]: value }).state.settings[key], value);
    for (const value of [undefined, null, true, 1, [], {}, 'invalid']) {
      rejectsWithoutMutation(initial, 'settings.update', { themeMode: 'dark', petScale: 150, [key]: value }, 'INVALID_SETTINGS');
    }
  }
  for (const key of ['petAlwaysOnTop', 'openPanelOnLaunch', 'notificationsEnabled']) {
    for (const value of [true, false]) assert.equal(command(initial, 'settings.update', { [key]: value }).state.settings[key], value);
    for (const value of [undefined, null, 0, 1, 'false', [], {}]) {
      rejectsWithoutMutation(initial, 'settings.update', { petScale: 150, [key]: value }, 'INVALID_SETTINGS');
    }
  }
  const updates = { themeMode: 'dark', closeBehavior: 'quit', fontFamily: 'yahei', textSize: 'large',
    petHints: 'always', petAlwaysOnTop: false, openPanelOnLaunch: false, notificationsEnabled: false };
  const changed = command(initial, 'settings.update', updates).state;
  assert.deepEqual(changed.settings, { ...initial.settings, ...updates });
  assert.deepEqual(changed.session, initial.session);
  assert.deepEqual(changed.stats, initial.stats);
});

test('font descriptor is normalized safely and arbitrary public imports or internal commands are rejected', () => {
  const font = { id: `${'a'.repeat(64)}.woff2`, name: '测试中文字体.woff2' };
  const initial = createInitialState(BASE);
  rejectsWithoutMutation(initial, 'settings.update', { fontFamily: 'custom' }, 'FONT_NOT_IMPORTED');
  rejectsWithoutMutation(initial, 'settings.update', { importedFont: font, themeMode: 'dark' }, 'INVALID_FONT_IMPORT');
  rejectsWithoutMutation(initial, 'settings.font-import', { font }, 'INVALID_COMMAND');
  const imported = applyImportedFont(deepFreeze(initial), font, BASE).state;
  assert.equal(imported.settings.fontFamily, 'custom');
  assert.deepEqual(imported.settings.importedFont, font);
  assert.notEqual(imported.settings.importedFont, font);
  const system = command(imported, 'settings.update', { fontFamily: 'system' }).state;
  assert.deepEqual(system.settings.importedFont, font);
  assert.equal(command(system, 'settings.update', { fontFamily: 'custom' }).state.settings.fontFamily, 'custom');
  for (const importedFont of [null, {}, { ...font, id: '../escape.ttf' }, { ...font, name: 'C:\\a.ttf' },
    { ...font, name: 'a\nfont' }, { ...font, id: `${'a'.repeat(64)}.exe` }]) {
    const normalized = normalizeState({ settings: { fontFamily: 'custom', importedFont } }, BASE);
    assert.equal(normalized.settings.importedFont, null);
    assert.equal(normalized.settings.fontFamily, 'system');
  }
});

test('reset settings retains tasks, rewards, session, extensions, position and the imported asset', () => {
  const font = { id: `${'b'.repeat(64)}.ttf`, name: '中文.ttf' };
  let initial = addTask(createInitialState(BASE));
  initial = command(initial, 'focus.start', { minutes: 25 }).state;
  initial = applyImportedFont(initial, font, BASE).state;
  initial = command(initial, 'settings.update', { themeMode: 'dark', closeBehavior: 'quit', petScale: 150,
    motionMode: 'static', textSize: 'large', petAlwaysOnTop: false, petHints: 'always',
    openPanelOnLaunch: false, notificationsEnabled: false, focusMinutes: 180 }).state;
  initial = { ...initial, decorations: ['plant'], stats: { ...initial.stats, energy: 77 },
    extension: { note: 'keep' }, settings: { ...initial.settings, custom: { accent: 'blue' }, petPosition: { x: 123, y: -20 } } };
  const reset = command(initial, 'settings.reset', {}, BASE + 1_000).state;
  assert.deepEqual(reset, { ...initial, settings: { ...initial.settings, ...SETTINGS_DEFAULTS, importedFont: font } });
  assert.deepEqual(normalizeState(reset, BASE + 2_000), reset);
  assert.equal(reset.settings.fontFamily, 'system');
  assert.equal(command(reset, 'settings.update', { fontFamily: 'custom' }).state.settings.fontFamily, 'custom');
});
