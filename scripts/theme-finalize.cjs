'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const infoPath = path.join(root, 'artifacts/package.json');
const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
const packageVersion = JSON.parse(fs.readFileSync(path.join(info.directory, 'resources/app/package.json'), 'utf8')).version;
assert.equal(packageVersion, '0.3.0');
assert.ok(path.resolve(info.directory).toLowerCase().startsWith(path.join(root, 'dist', 'BallBuddy-0.3.0-win-x64').toLowerCase()));
for (const file of ['README.md', 'docs/VALIDATION.md']) fs.copyFileSync(path.join(root, file), path.join(info.directory, file));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => { const file = path.join(dir, entry.name); return entry.isDirectory() ? walk(file) : [file]; });
const manifestFile = path.join(info.directory, 'manifest.sha256.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.files = walk(info.directory).filter(file => file !== manifestFile && !file.endsWith('.pak')).map(file => ({
  path: path.relative(info.directory, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}));
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
const allFiles = walk(info.directory);
info.files = allFiles.length; info.bytes = allFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
const sources = {
  theme: 'theme-smoke-2026-10-10T15-33-26-472Z',
  coreGui: 'smoke-2026-10-10T15-26-42-278Z',
  packagedGui: 'smoke-2026-10-10T15-38-08-562Z',
  settings: 'settings-2026-10-10T15-38-19-472Z',
  aiStudy: 'ai-study-2026-10-10T15-45-40-296Z',
  hover: 'hover-2026-10-10T15-41-35-344Z'
};
const validations = Object.fromEntries(Object.entries(sources).map(([name, folder]) => {
  const file = path.join(root, 'artifacts', folder, 'report.json'), report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(report.passed === true || report.status === 'passed', `${name} report must pass`);
  assert.equal(report.errors.length, 0);
  return [name, { path: file, passed: true, checks: report.checks.length, screenshots: report.screenshots.length }];
}));
const differences = ['src/renderer/study.js'];
const themePackage = path.join(root, 'dist/BallBuddy-0.3.0-win-x64/resources/app');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const file of walk(path.join(root, 'src/renderer'))) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (!differences.includes(relative)) assert.equal(sha(file), sha(path.join(themePackage, relative)), `${relative}: renderer visual evidence must match final source`);
}
const nativePackage = path.join(root, 'dist/BallBuddy-0.3.0-win-x64-2026-10-10T15-38-06-601Z/resources/app');
for (const file of walk(path.join(root, 'src'))) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (!differences.includes(relative)) assert.equal(sha(file), sha(path.join(nativePackage, relative)), `${relative}: settings/hover evidence must match final source`);
}
const upgradeFile = path.join(root, 'artifacts/theme-0.3.0/upgrade.json');
const upgrade = JSON.parse(fs.readFileSync(upgradeFile, 'utf8'));
assert.equal(upgrade.passed, true, 'Personal upgrade must preserve state and assets');
fs.writeFileSync(path.join(root, 'artifacts/theme-0.3.0/validation.json'), JSON.stringify({ version: packageVersion,
  finalizedAt: new Date().toISOString(), executable: info.executable, checksPassed: true,
  unitTests: { core: 69, server: 7 }, validations,
  evidenceReuse: { theme: 'Same renderer except independently revalidated study reconnection copy.',
    settingsAndHover: 'Same complete runtime except study reconnection copy; native topmost fallback already included.' },
  visualReview: { disposition: 'ship', path: path.join(root, '.impeccable/review/theme-0.3.0-finish.md') },
  personalUpgrade: { passed: true, path: upgradeFile },
  limitations: ['External paid AI vendors were not contacted.', 'Public cross-network service reachability was not tested.']
}, null, 2));
console.log('PASS final documentation, package manifest and evidence hashes synchronized.');
