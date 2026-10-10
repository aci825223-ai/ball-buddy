'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFontManager, validateFontBytes, descriptorFor, MAX_FONT_BYTES } = require('../src/main/fonts.cjs');

const artifactRoot = path.join(__dirname, '../artifacts/font-unit');
fs.mkdirSync(artifactRoot, { recursive: true });
function workspace() { return fs.mkdtempSync(path.join(artifactRoot, 'case-')); }
function fixture(directory, name = '字体.ttf', bytes = fontBytes('ttf')) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  return file;
}
function fontBytes(extension) {
  const bytes = Buffer.alloc(64);
  if (extension === 'ttf') bytes.writeUInt32BE(0x00010000);
  else bytes.write({ otf: 'OTTO', woff: 'wOFF', woff2: 'wOF2' }[extension], 0, 'ascii');
  return bytes;
}
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('font formats require matching extension, signature and minimum size', () => {
  for (const extension of ['ttf', 'otf', 'woff', 'woff2']) {
    assert.equal(validateFontBytes(fontBytes(extension), extension), true);
    assert.throws(() => validateFontBytes(fontBytes(extension).subarray(0, 4), extension), /不完整/);
  }
  assert.throws(() => validateFontBytes(fontBytes('ttf'), 'otf'), /格式/);
  assert.throws(() => validateFontBytes(fontBytes('ttf'), 'exe'), /TTF/);
  assert.throws(() => validateFontBytes(Buffer.alloc(MAX_FONT_BYTES + 1), 'ttf'), /32 MB/);
  const maximum = Buffer.alloc(MAX_FONT_BYTES);
  maximum.writeUInt32BE(0x00010000);
  assert.equal(validateFontBytes(maximum, 'ttf'), true);
});

test('candidate names and IDs contain no selected paths and uppercase extensions normalize', () => {
  const bytes = fontBytes('ttf');
  const descriptor = descriptorFor(bytes, 'C:\\private\\文\n字.TTF');
  assert.equal(descriptor.name, '文字.TTF');
  assert.equal(descriptor.id, `${createHash('sha256').update(bytes).digest('hex')}.ttf`);
  assert.equal(/private|[\\/\n]/u.test(descriptor.name), false);
});

test('prepare only reads a bounded native-selected candidate; cancel preserves the active selection and no files are written', async () => {
  const directory = workspace();
  const manager = createFontManager(directory);
  const selected = await manager.prepare(fixture(directory));
  assert.equal(selected.ok, true);
  assert.ok(selected.bytes instanceof Uint8Array);
  assert.equal(fs.existsSync(path.join(directory, 'fonts')), false);
  assert.deepEqual(manager.cancel(selected.pendingId), { ok: true });
  let committed = false;
  await assert.rejects(manager.confirm(selected.pendingId, () => { committed = true; }), /失效/);
  assert.equal(committed, false);
  assert.deepEqual(await manager.getActive(null), { ok: true, font: null });
});

test('overlarge, missing, malformed or disguised selected files fail before any managed copy exists', async () => {
  const directory = workspace();
  const manager = createFontManager(directory);
  const large = fixture(directory, 'large.ttf');
  const descriptor = fs.openSync(large, 'r+');
  fs.ftruncateSync(descriptor, MAX_FONT_BYTES + 1);
  fs.closeSync(descriptor);
  await assert.rejects(manager.prepare(large), /32 MB/);
  await assert.rejects(manager.prepare(path.join(directory, 'missing.ttf')), /无法读取/);
  await assert.rejects(manager.prepare(fixture(directory, 'broken.ttf', Buffer.alloc(64))), /损坏/);
  await assert.rejects(manager.prepare(fixture(directory, 'disguised.otf')), /格式/);
  assert.equal(fs.existsSync(path.join(directory, 'fonts')), false);
});

test('confirmed imports persist a restricted content-addressed copy and duplicates reuse it', async () => {
  const directory = workspace();
  const manager = createFontManager(directory);
  const source = fixture(directory);
  const selected = await manager.prepare(source);
  let saved;
  const result = await manager.confirm(selected.pendingId, font => { saved = font; return { ok: true, state: { settings: { importedFont: font } } }; });
  assert.equal(result.ok, true);
  const target = path.join(directory, 'fonts', saved.id);
  const firstStat = fs.statSync(target);
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
  const duplicate = await manager.prepare(source);
  await manager.confirm(duplicate.pendingId, () => ({ ok: true }));
  assert.equal(fs.statSync(target).mtimeMs, firstStat.mtimeMs);
  assert.equal(fs.readdirSync(path.dirname(target)).length, 1);
  const active = await manager.getActive(saved);
  assert.deepEqual(active.font, saved);
  assert.deepEqual(Buffer.from(active.bytes), fs.readFileSync(source));
});

test('saved fonts survive source replacement and restart; damaged and missing copies return recoverable errors', async () => {
  const directory = workspace();
  const source = fixture(directory);
  const manager = createFontManager(directory);
  const selected = await manager.prepare(source);
  await manager.confirm(selected.pendingId, () => ({ ok: true }));
  fs.writeFileSync(source, 'original source moved or changed');
  const restarted = createFontManager(directory);
  assert.deepEqual(Buffer.from((await restarted.getActive(selected.font)).bytes), fontBytes('ttf'));
  await assert.rejects(restarted.getActive({ ...selected.font, id: `${'c'.repeat(64)}.ttf` }), /副本缺失.*系统字体/);
  fs.writeFileSync(path.join(directory, 'fonts', selected.font.id), 'corrupted copy');
  await assert.rejects(restarted.getActive(selected.font), /系统字体/);
  const reselected = await manager.prepare(fixture(directory, 'again.ttf'));
  await assert.rejects(manager.confirm(reselected.pendingId, () => assert.fail('must not commit')), /不完整|损坏/);
  assert.equal(fs.readFileSync(path.join(directory, 'fonts', selected.font.id), 'utf8'), 'corrupted copy');
});

test('asset IDs and descriptors reject arbitrary paths before reading', async () => {
  const directory = workspace();
  const manager = createFontManager(directory);
  for (const font of [{ id: '../state.json', name: 'font' }, { id: 'C:\\secret.ttf', name: 'font' },
    { id: `${'a'.repeat(64)}.ttf`, name: '../secret.ttf' }, { id: `${'a'.repeat(64)}.exe`, name: 'font' }]) {
    await assert.rejects(manager.getActive(font), /信息无效/);
  }
  await assert.rejects(manager.confirm('../file.ttf', () => assert.fail()), /失效/);
});

test('expired or replaced candidates cannot commit the previously selected font', async () => {
  const directory = workspace();
  let now = 1_000;
  const manager = createFontManager(directory, { now: () => now });
  const first = await manager.prepare(fixture(directory));
  const second = await manager.prepare(fixture(directory, 'second.otf', fontBytes('otf')));
  await assert.rejects(manager.confirm(first.pendingId, () => assert.fail()), /失效/);
  now += 10 * 60 * 1000 + 1;
  await assert.rejects(manager.confirm(second.pendingId, () => assert.fail()), /失效/);
  assert.equal(fs.existsSync(path.join(directory, 'fonts')), false);
});

test('font and state write failures preserve selection; retry reuses the saved asset instead of replacing it', async () => {
  const directory = workspace();
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const deniedManager = createFontManager(directory, { io: { ...fs.promises, mkdir: async () => { throw denied; } } });
  const failed = await deniedManager.prepare(fixture(directory));
  let current = 'old-font';
  await assert.rejects(deniedManager.confirm(failed.pendingId, () => { current = 'new-font'; }), /暂时无法保存/);
  assert.equal(current, 'old-font');
  const manager = createFontManager(directory);
  const selected = await manager.prepare(path.join(directory, '字体.ttf'));
  await assert.rejects(manager.confirm(selected.pendingId, () => { throw new Error('记录暂时无法保存'); }), /记录暂时无法保存/);
  assert.equal(current, 'old-font');
  assert.equal(fs.existsSync(path.join(directory, 'fonts', selected.font.id)), true);
  await manager.confirm(selected.pendingId, font => { current = font.id; return { ok: true }; });
  assert.equal(current, selected.font.id);
});

test('cancellation while saving leaves the asset but does not change the active selection', async () => {
  const directory = workspace();
  const entered = gate();
  const release = gate();
  const io = { ...fs.promises, mkdir: async (...args) => {
    entered.resolve(); await release.promise; return fs.promises.mkdir(...args);
  } };
  const manager = createFontManager(directory, { io });
  const selected = await manager.prepare(fixture(directory));
  let committed = false;
  const confirming = manager.confirm(selected.pendingId, () => { committed = true; });
  await entered.promise;
  manager.cancel(selected.pendingId);
  release.resolve();
  await assert.rejects(confirming, /失效|取消/);
  assert.equal(committed, false);
  assert.equal(fs.existsSync(path.join(directory, 'fonts', selected.font.id)), true);
});

test('a confirmation commits once and reads the latest state after asynchronous IO', async () => {
  const directory = workspace();
  const entered = gate();
  const release = gate();
  const manager = createFontManager(directory, { io: { ...fs.promises, mkdir: async (...args) => {
    entered.resolve(); await release.promise; return fs.promises.mkdir(...args);
  } } });
  const selected = await manager.prepare(fixture(directory));
  let live = { theme: 'light', task: 'old' };
  let commits = 0;
  const commit = font => { commits += 1; live = { ...live, font }; return { ok: true, state: live }; };
  const one = manager.confirm(selected.pendingId, commit);
  const two = manager.confirm(selected.pendingId, commit);
  await entered.promise;
  live = { theme: 'dark', task: 'added while IO pending' };
  release.resolve();
  assert.deepEqual(await one, await two);
  assert.equal(commits, 1);
  assert.equal(live.theme, 'dark');
  assert.equal(live.task, 'added while IO pending');
});
