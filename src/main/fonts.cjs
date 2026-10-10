'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isFontDescriptor } = require('../shared/state.cjs');

const MAX_FONT_BYTES = 32 * 1024 * 1024;
const EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const CANDIDATE_LIFETIME_MS = 10 * 60 * 1000;

function fontError(message) { return new Error(message); }

function validateFontBytes(bytes, extension) {
  if (!EXTENSIONS.has(extension)) throw fontError('请选择 TTF、OTF、WOFF 或 WOFF2 字体文件。');
  if (!bytes || bytes.length > MAX_FONT_BYTES) throw fontError('字体文件不能超过 32 MB。');
  const minimum = { ttf: 12, otf: 12, woff: 44, woff2: 48 }[extension];
  if (bytes.length < minimum) throw fontError('字体文件不完整，请选择可用的字体文件。');
  const signature = Buffer.from(bytes.subarray(0, 4));
  const valid = extension === 'ttf' ? (signature.equals(Buffer.from([0, 1, 0, 0])) || signature.toString('ascii') === 'true')
    : signature.toString('ascii') === { otf: 'OTTO', woff: 'wOFF', woff2: 'wOF2' }[extension];
  if (!valid) throw fontError('字体格式与文件扩展名不符，或文件已经损坏。');
  return true;
}

function descriptorFor(bytes, filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  validateFontBytes(bytes, extension);
  const name = Array.from(path.basename(filePath).replace(/[\\/\u0000-\u001f\u007f]/gu, '')).slice(0, 160).join('').trim() || '导入字体';
  return { id: `${createHash('sha256').update(bytes).digest('hex')}.${extension}`, name };
}

function createFontManager(userData, { io = fs.promises, now = Date.now } = {}) {
  const directory = path.join(userData, 'fonts');
  let candidate = null;

  async function readBounded(filePath, managed = false) {
    if (managed) {
      const entry = await io.lstat(filePath);
      if (entry.isSymbolicLink() || !entry.isFile()) throw fontError('保存的字体副本无法读取，请重新导入字体。');
    }
    const handle = await io.open(filePath, 'r');
    try {
      const entry = await handle.stat();
      if (!entry.isFile()) throw fontError('请选择一个字体文件。');
      if (entry.size > MAX_FONT_BYTES) throw fontError('字体文件不能超过 32 MB。');
      const buffer = Buffer.alloc(Math.min(MAX_FONT_BYTES + 1, entry.size + 1));
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_FONT_BYTES || total !== entry.size) throw fontError('字体文件在读取时发生变化，请重新选择。');
      return buffer.subarray(0, total);
    } finally { await handle.close(); }
  }

  async function ensureDirectory() {
    await io.mkdir(directory, { recursive: true });
    const entry = await io.lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw fontError('字体保存目录不可用，请检查目录权限。');
  }

  async function saveAsset(font, bytes) {
    await ensureDirectory();
    const target = path.join(directory, font.id);
    let handle;
    try { handle = await io.open(target, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readBounded(target, true);
      validateFontBytes(existing, font.id.split('.').pop());
      if (createHash('sha256').update(existing).digest('hex') !== font.id.split('.')[0]) {
        throw fontError('同名字体副本已损坏，请检查字体保存目录后重试。');
      }
      return;
    }
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }

  function activeCandidate(id) {
    if (typeof id !== 'string' || !candidate || candidate.id !== id || now() - candidate.at > CANDIDATE_LIFETIME_MS) {
      throw fontError('本次字体选择已失效，请重新导入。');
    }
    return candidate;
  }

  return {
    async prepare(filePath) {
      let bytes;
      try { bytes = await readBounded(filePath); }
      catch (error) {
        if (error.message && !error.code) throw error;
        throw fontError('无法读取所选字体，请检查文件是否存在以及读取权限。');
      }
      const font = descriptorFor(bytes, filePath);
      candidate = { id: randomUUID(), font, bytes, at: now(), confirmation: null };
      return { ok: true, pendingId: candidate.id, font: { ...font }, bytes: new Uint8Array(bytes) };
    },
    async confirm(id, commitFont) {
      const selected = activeCandidate(id);
      if (selected.confirmation) return selected.confirmation;
      selected.confirmation = (async () => {
        try {
          await saveAsset(selected.font, selected.bytes);
          if (activeCandidate(id) !== selected) throw fontError('本次字体选择已取消，请重新导入。');
          // No await between reading the latest main-process state and committing it.
          const result = commitFont({ ...selected.font });
          candidate = null;
          return result;
        } catch (error) {
          selected.confirmation = null;
          if (error.message && !error.code) throw error;
          throw fontError('字体暂时无法保存，请检查磁盘空间或目录权限后重试。');
        }
      })();
      return selected.confirmation;
    },
    cancel(id) {
      if (typeof id !== 'string') throw fontError('本次字体选择无效。');
      if (candidate?.id === id) candidate = null;
      return { ok: true };
    },
    async getActive(font) {
      if (!font) return { ok: true, font: null };
      if (!isFontDescriptor(font)) throw fontError('保存的字体信息无效，请重新导入。');
      try {
        const directoryEntry = await io.lstat(directory);
        if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) throw fontError('字体目录不可用。');
        const bytes = await readBounded(path.join(directory, font.id), true);
        validateFontBytes(bytes, font.id.split('.').pop());
        if (createHash('sha256').update(bytes).digest('hex') !== font.id.split('.')[0]) throw fontError('字体副本已损坏。');
        return { ok: true, font: { id: font.id, name: font.name }, bytes: new Uint8Array(bytes) };
      } catch { throw fontError('导入字体的副本缺失或无法读取，已回退系统字体；请重新导入。'); }
    },
  };
}

module.exports = { createFontManager, validateFontBytes, descriptorFor, MAX_FONT_BYTES };
