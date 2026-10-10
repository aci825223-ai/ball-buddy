'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialState, normalizeState, applyCommand, applyStudyReceipt } = require('../src/shared/state.cjs');
const { normalizeServerUrl } = require('../src/shared/study-protocol.cjs');
const BASE = 1_800_000_000_000;
const receipt = { roomId: 'room_1', roundId: 'round_1', memberId: 'member_1', status: 'completed', activeMs: 60_000, durationMs: 60_000 };

test('AI batch validates all candidates before adding and records plan id with tasks', () => {
  const state = createInitialState(BASE);
  const command = { type: 'task.batch-add', planId: 'plan_1', tasks: [{ title: ' 阅读材料 ', estimatedMinutes: 10 }, { title: '整理要点' }] };
  const result = applyCommand(state, command, BASE);
  assert.equal(state.tasks.length, 0);
  assert.equal(result.state.tasks.length, 2);
  assert.equal(result.state.tasks[0].title, '阅读材料');
  assert.equal(result.state.tasks[0].estimatedMinutes, 10);
  assert.equal(result.state.selectedTaskId, result.state.tasks[0].id);
  assert.equal(result.state.stats.energy, 0);
  assert.deepEqual(result.state.importedPlans, ['plan_1']);
  const recovered = normalizeState(JSON.parse(JSON.stringify(result.state)), BASE + 1000);
  assert.throws(() => applyCommand(recovered, command, BASE + 1000), { code: 'PLAN_ALREADY_IMPORTED' });
  for (const tasks of [[], Array.from({ length: 13 }, () => ({ title: '步骤' })), [{ title: '有效' }, { title: '' }],
    [{ title: '有效' }, { title: '坏时长', estimatedMinutes: 0 }], [{ title: '坏时长', estimatedMinutes: '10' }], [null]]) {
    assert.throws(() => applyCommand(state, { ...command, tasks }, BASE));
    assert.equal(state.tasks.length, 0);
    assert.deepEqual(state.importedPlans, []);
  }
});

test('study settlement grants a completed reward exactly once through reload and preserves unknown fields', () => {
  const state = { ...createInitialState(BASE), extension: { keep: true }, stats: { energy: 10, focusSessions: 2,
    completedTasks: 1, totalFocusMs: 1000, custom: 7 } };
  const completed = applyStudyReceipt(state, receipt, BASE);
  assert.deepEqual(completed.state.stats, { energy: 15, focusSessions: 3, completedTasks: 1, totalFocusMs: 61_000, custom: 7 });
  assert.equal(completed.state.lastEvent.kind, 'study-completed');
  assert.deepEqual(completed.state.extension, state.extension);
  assert.deepEqual(completed.state.studyReceipts, ['room_1/round_1/member_1']);
  const recovered = normalizeState(completed.state, BASE + 1000);
  const duplicate = applyStudyReceipt(recovered, receipt, BASE + 1000);
  assert.equal(duplicate.state, recovered);
  assert.deepEqual(duplicate.effects, []);
  assert.throws(() => applyCommand(state, { type: 'study.settle', receipt }, BASE), { code: 'INVALID_COMMAND' });
});

test('stopped settlement records actual shared time without completion reward and rejects impossible receipts', () => {
  const state = createInitialState(BASE);
  const stopped = applyStudyReceipt(state, { ...receipt, status: 'stopped', activeMs: 13_000 }, BASE).state;
  assert.equal(stopped.stats.energy, 0);
  assert.equal(stopped.stats.focusSessions, 0);
  assert.equal(stopped.stats.totalFocusMs, 13_000);
  for (const patch of [{ status: 'running' }, { durationMs: 1 }, { activeMs: -1 }, { activeMs: 60_001 },
    { activeMs: 59_999 }, { roomId: '../escape' }, { memberId: '' }]) {
    assert.throws(() => applyStudyReceipt(state, { ...receipt, ...patch }, BASE), { code: 'INVALID_RECEIPT' });
    assert.equal(state.stats.energy, 0);
  }
});

test('remote study requires WSS while loopback accepts WS without embedded secrets', () => {
  assert.equal(normalizeServerUrl('ws://127.0.0.1:8787'), 'ws://127.0.0.1:8787/study');
  assert.equal(normalizeServerUrl('wss://study.example.com/study'), 'wss://study.example.com/study');
  for (const url of ['ws://example.com/study', 'ws://192.168.1.1', 'https://example.com', 'wss://user:pass@example.com',
    'wss://example.com?token=secret', 'wss://example.com#secret', 'file:///etc/passwd']) {
    assert.throws(() => normalizeServerUrl(url), { code: 'INVALID_SERVER' });
  }
});
