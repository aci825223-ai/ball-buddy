'use strict';

// Read-only personal-data summaries: never print/store task text or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'artifacts/theme-0.3.0/upgrade.json');
const personalDirectory = path.join(process.env.APPDATA, '小球同桌');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digestTree(directory) {
  const entries = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else entries.push([path.relative(directory, file).replaceAll('\\', '/'), hash(fs.readFileSync(file))]);
  } };
  if (fs.existsSync(directory)) walk(directory);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return { files: entries.length, sha256: hash(JSON.stringify(entries)) };
}
function summarize() {
  const state = JSON.parse(fs.readFileSync(path.join(personalDirectory, 'state.json'), 'utf8'));
  return { capturedAt: new Date().toISOString(), taskCount: state.tasks?.length || 0,
    sessionActive: Boolean(state.session), petScale: state.settings?.petScale,
    stateSections: Object.fromEntries(Object.entries(state).map(([key, value]) => [key, hash(JSON.stringify(canonical(value)))])),
    assets: Object.fromEntries(['fonts', 'ai', 'study'].map(folder => [folder, digestTree(path.join(personalDirectory, folder))])) };
}
const mode = process.argv[2];
if (mode === 'capture') {
  assert.ok(!fs.existsSync(reportPath), 'Do not overwrite an existing personal upgrade record');
  fs.writeFileSync(reportPath, JSON.stringify({ version: '0.3.0', passed: false, before: summarize() }, null, 2));
  console.log('Captured only hashes and non-sensitive counts for the personal upgrade.');
} else if (mode === 'verify') {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); report.after = summarize();
  report.equal = { stateSections: JSON.stringify(canonical(report.before.stateSections)) === JSON.stringify(canonical(report.after.stateSections)),
    assets: JSON.stringify(report.before.assets) === JSON.stringify(report.after.assets),
    taskCount: report.before.taskCount === report.after.taskCount, petScale: report.before.petScale === report.after.petScale };
  report.passed = Object.values(report.equal).every(Boolean);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  assert.equal(report.passed, true, 'Personal state or protected assets changed during upgrade; inspect hashes without printing raw data');
  console.log('PASS personal state, settings, font assets, AI records and study data retained.');
} else throw new Error('Use capture before a normal quit, then verify after opening the final package.');
