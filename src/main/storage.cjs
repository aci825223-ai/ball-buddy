const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid state file');
  return value;
}

function createStorage(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'state.json');
  const backup = path.join(directory, 'state.backup.json');
  return {
    load() {
      if (!fs.existsSync(target)) {
        try { return { raw: readJson(backup), notice: '主记录缺失，已从本地备份恢复。' }; }
        catch { return { raw: null, notice: null }; }
      }
      try { return { raw: readJson(target), notice: null }; }
      catch {
        // Preserve malformed data before any subsequent save replaces the main file.
        const recovery = path.join(directory, `state.recovery-${Date.now()}.json`);
        try { fs.copyFileSync(target, recovery); } catch { /* Reading can still continue. */ }
        try { return { raw: readJson(backup), notice: '已从本地备份恢复；原文件已保留。' }; }
        catch { return { raw: null, notice: '本地记录无法读取，已保留原文件。新的记录仍会保存。' }; }
      }
    },
    save(state) {
      if (fs.existsSync(target)) {
        try { readJson(target); fs.copyFileSync(target, backup); }
        catch (error) {
          // A bad source must never overwrite the last valid backup.
          if (error.code && error.code !== 'ENOENT') throw error;
        }
      }
      const temporary = `${target}.tmp`;
      const descriptor = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(state, null, 2), 'utf8');
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, target);
    },
    target
  };
}

module.exports = { createStorage };
