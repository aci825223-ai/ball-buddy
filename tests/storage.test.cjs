const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStorage } = require('../src/main/storage.cjs');

function temporary() { const base = path.resolve(__dirname, '../artifacts/storage-tests'); fs.mkdirSync(base, { recursive: true }); return fs.mkdtempSync(path.join(base, 'run-')); }

test('new data directory starts empty and successful saves survive reopening', () => {
  const directory = temporary();
  const storage = createStorage(directory);
  assert.equal(storage.load().raw, null);
  storage.save({ version: 1, tasks: [{ id: 'a', title: '自己的任务' }], stats: { energy: 10 } });
  const recovered = createStorage(directory).load();
  assert.equal(recovered.raw.tasks[0].title, '自己的任务');
  assert.equal(recovered.raw.stats.energy, 10);
});

test('broken current file recovers valid backup and preserves the malformed source', () => {
  const directory = temporary();
  const storage = createStorage(directory);
  storage.save({ version: 1, stats: { energy: 10 } });
  storage.save({ version: 1, stats: { energy: 20 } });
  fs.writeFileSync(storage.target, '{incomplete');
  const recovered = storage.load();
  assert.equal(recovered.raw.stats.energy, 10);
  assert.match(recovered.notice, /备份/);
  const preserved = fs.readdirSync(directory).find(file => file.startsWith('state.recovery-'));
  assert.ok(preserved);
  assert.equal(fs.readFileSync(path.join(directory, preserved), 'utf8'), '{incomplete');
  storage.save(recovered.raw);
  assert.equal(storage.load().raw.stats.energy, 10);
});

test('unrecoverable corrupt data returns a notice and retains user data', () => {
  const directory = temporary();
  const storage = createStorage(directory);
  fs.writeFileSync(storage.target, '[]');
  const recovered = storage.load();
  assert.equal(recovered.raw, null);
  assert.match(recovered.notice, /保留/);
  assert.equal(fs.readFileSync(storage.target, 'utf8'), '[]');
});

test('missing primary file still restores an existing valid backup', () => {
  const directory = temporary();
  fs.writeFileSync(path.join(directory, 'state.backup.json'), JSON.stringify({ version: 1, stats: { energy: 35 } }));
  const recovered = createStorage(directory).load();
  assert.equal(recovered.raw.stats.energy, 35);
  assert.match(recovered.notice, /主记录缺失/);
});
