const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [];
function visit(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) visit(file); else files.push(file); } }
for (const directory of ['src', 'scripts', 'tests']) if (fs.existsSync(path.join(root, directory))) visit(path.join(root, directory));
for (const directory of ['server/src', 'server/tests']) if (fs.existsSync(path.join(root, directory))) visit(path.join(root, directory));
const errors = [];
for (const file of files.filter(file => /\.(cjs|js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) errors.push(`${path.relative(root, file)}: ${result.stderr}`);
}
for (const file of files.filter(file => file.endsWith('.html'))) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('Content-Security-Policy')) errors.push(`${path.relative(root, file)} lacks a CSP`);
  if (/<script\b[^>]*src=["']https?:/i.test(source)) errors.push(`${file} uses network scripts`);
  if (/\son(?:click|submit|load|error)\s*=/i.test(source)) errors.push(`${file} uses inline event code`);
}
for (const file of ['rings.js', 'emotions.js', 'ball.js', 'engine.js', 'LICENSE', 'NOTICE.md', 'SOURCE.md']) {
  if (!fs.existsSync(path.join(root, 'vendor/emotion-ball', file))) errors.push(`Missing upstream file ${file}`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Syntax and local-resource checks passed (${files.length} project files).`);
