'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/theme-0.3.0/package-audit.json');
const checkpointRoot = path.join(root, 'artifacts/checkpoints/0.2.0-2026-10-10T14-40-00Z');
const checkpoint = JSON.parse(fs.readFileSync(path.join(checkpointRoot, 'checkpoint.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name); return entry.isDirectory() ? walk(file) : [file];
});
const allowedRuntime = new Set(['src/main/main.cjs', 'src/renderer/index.html', 'src/renderer/styles.css',
  'src/renderer/appearance.css', 'src/renderer/extensions.css', 'src/renderer/settings.css',
  'src/renderer/pet.css', 'src/renderer/extensions.js', 'src/renderer/settings.js', 'src/renderer/study.js']);
const results = { version: '0.3.0', passed: false, package: info.directory, checkpoint: checkpoint.checkpointId,
  archives: [], runtime: [], packageSource: [], manifest: [], errors: [] };
try {
  assert.equal(checkpoint.status, 'verified');
  for (const [name, archive] of Object.entries(checkpoint.archives)) {
    const file = path.join(checkpointRoot, archive.path), hash = sha(file);
    assert.equal(hash, archive.sha256, `${name}: immutable checkpoint archive`);
    results.archives.push({ name, path: file, bytes: fs.statSync(file).size, sha256: hash });
  }
  const oldEntries = new Map(checkpoint.archives.project.entries.map(entry => [entry.path, entry]));
  for (const folder of ['src', 'vendor', 'server/src']) {
    for (const file of walk(path.join(root, folder))) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      const old = oldEntries.get(relative); assert.ok(old, `${relative}: no unexpected runtime additions`);
      const hash = sha(file), unchanged = hash === old.sha256;
      assert.ok(unchanged || allowedRuntime.has(relative), `${relative}: protected business file changed`);
      results.runtime.push({ path: relative, unchanged, current: hash, checkpoint: old.sha256 });
      const packageFile = folder === 'server/src' ? path.join(info.directory, 'study-server', path.relative(path.join(root, 'server'), file))
        : path.join(info.directory, 'resources/app', relative);
      assert.equal(sha(packageFile), hash, `${relative}: package must match source`);
      results.packageSource.push({ path: relative, sha256: hash, matched: true });
    }
  }
  const appFiles = walk(path.join(info.directory, 'resources/app')).map(file => path.relative(path.join(info.directory, 'resources/app'), file).replaceAll('\\', '/'));
  assert.ok(appFiles.every(file => file === 'package.json' || file.startsWith('src/') || file.startsWith('vendor/')), 'Only runtime source and vendor in packaged app');
  assert.ok(!walk(info.directory).some(file => /(?:^|[\\/])(?:\.env[^\\/]*|state\.json|ai\.json|chat\.json|study\.json|fonts|artifacts|\.impeccable)(?:$|[\\/])/i.test(path.relative(info.directory, file))), 'No private data or development artifact in portable package');
  const manifest = JSON.parse(fs.readFileSync(path.join(info.directory, 'manifest.sha256.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  for (const entry of manifest.files) {
    const file = path.join(info.directory, entry.path);
    assert.equal(sha(file), entry.sha256, `${entry.path}: package manifest hash`);
    assert.equal(fs.statSync(file).size, entry.bytes);
    results.manifest.push({ path: entry.path, matched: true });
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(info.directory, 'resources/app/package.json'), 'utf8')).version, '0.3.0');
  for (const file of ['README.md', 'docs/VALIDATION.md']) assert.equal(sha(path.join(root, file)), sha(path.join(info.directory, file)), `${file}: delivered documentation is current`);
  results.changedRuntime = results.runtime.filter(file => !file.unchanged).map(file => file.path);
  results.unchangedProtectedFiles = results.runtime.filter(file => file.unchanged).length;
  results.passed = true;
} catch (error) { results.errors.push(error.stack || error.message); process.exitCode = 1; console.error(error.message); }
fs.writeFileSync(output, JSON.stringify(results, null, 2));
console.log(`Package audit: ${output} (${results.passed ? 'PASS' : 'FAIL'})`);
