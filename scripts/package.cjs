const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const electronBinary = require('electron');
const electronDirectory = path.dirname(electronBinary);
if (!fs.existsSync(electronBinary)) throw new Error('Local Electron runtime is missing. Run npm install first.');
const base = path.join(root, 'dist', `BallBuddy-${manifest.version}-win-${process.arch}`);
const target = fs.existsSync(base) ? `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}` : base;
fs.mkdirSync(target, { recursive: true });
for (const entry of fs.readdirSync(electronDirectory, { withFileTypes: true })) {
  if (entry.name === 'resources') continue;
  const source = path.join(electronDirectory, entry.name);
  const destinationName = entry.name === 'electron.exe' ? 'BallBuddy.exe' : entry.name === 'LICENSE' ? 'LICENSE.electron.txt' : entry.name;
  const destination = path.join(target, destinationName);
  if (entry.isDirectory()) fs.cpSync(source, destination, { recursive: true, force: false });
  else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}
const appDirectory = path.join(target, 'resources', 'app');
fs.mkdirSync(appDirectory, { recursive: true });
for (const directory of ['src', 'vendor']) fs.cpSync(path.join(root, directory), path.join(appDirectory, directory), { recursive: true, force: false });
const packagedManifest = { name: manifest.name, version: manifest.version, description: manifest.description, private: true, license: manifest.license, main: manifest.main };
fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify(packagedManifest, null, 2));
fs.copyFileSync(path.join(root, 'README.md'), path.join(target, 'README.md'));
for (const entry of ['LICENSE', 'NOTICE.md']) {
  fs.copyFileSync(path.join(root, entry), path.join(target, entry));
  fs.copyFileSync(path.join(root, entry), path.join(appDirectory, entry));
}
fs.mkdirSync(path.join(target, 'vendor'), { recursive: true });
fs.cpSync(path.join(root, 'vendor/emotion-ball'), path.join(target, 'vendor/emotion-ball'), { recursive: true, force: false });
fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
for (const entry of ['THIRD_PARTY_NOTICES.md', 'PROJECT_SUMMARY.md', 'GETTING_STARTED.md', 'ARCHITECTURE.md', 'images']) {
  const source = path.join(root, 'docs', entry);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(target, 'docs', entry), { recursive: true, force: false });
}
fs.copyFileSync(path.join(root, 'docs/THIRD_PARTY_NOTICES.md'), path.join(appDirectory, 'THIRD_PARTY_NOTICES.md'));
const validation = path.join(root, 'docs/VALIDATION.md');
if (fs.existsSync(validation)) {
  fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
  fs.copyFileSync(validation, path.join(target, 'docs/VALIDATION.md'));
}
fs.writeFileSync(path.join(target, '使用说明.txt'), `小球同桌 ${manifest.version}\r\n\r\n双击 BallBuddy.exe 启动。整个文件夹需一起保留。\r\n点左侧底部“设置”调整主题、字体、文字大小和桌宠偏好。\r\n关闭小书桌按设置隐藏到系统托盘或退出；托盘“退出小球同桌”始终彻底退出。\r\n任务、奖励、偏好和导入字体保存在本机用户目录，无需联网。\r\n本项目仅供个人学习研究，角色授权见 resources\\app\\vendor\\emotion-ball\\LICENSE 与 NOTICE.md。\r\n`);
fs.appendFileSync(path.join(target, '使用说明.txt'), '\r\n0.3.0：左侧“书桌”“聊天”与“双人共学”切换页面，深浅主题采用统一的桌面工具布局。AI连接在设置中配置，密钥只在本机加密保存。\r\n双人共学需双方填写同一个可达服务地址，再用房间码加入。共学服务源码与独立启动说明在study-server文件夹；公网部署需你自己的服务器。\r\n');
const serverRoot = path.join(root, 'server');
if (fs.existsSync(path.join(serverRoot, 'src'))) {
  const serverTarget = path.join(target, 'study-server');
  fs.mkdirSync(serverTarget, { recursive: true });
  for (const entry of ['src', 'README.md', 'AGENTS.md', 'LICENSE', 'package.json', 'package-lock.json']) {
    const source = path.join(serverRoot, entry);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(serverTarget, entry), { recursive: true, force: false });
  }
  const ws = path.join(serverRoot, 'node_modules', 'ws');
  if (fs.existsSync(ws)) fs.cpSync(ws, path.join(serverTarget, 'node_modules', 'ws'), { recursive: true, force: false });
}
const files = [];
function visit(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) visit(file); else files.push(file); } }
visit(target);
const hashes = files.filter(file => !file.endsWith('.pak')).map(file => ({ path: path.relative(target, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
fs.writeFileSync(path.join(target, 'manifest.sha256.json'), JSON.stringify({ version: manifest.version, electron: require('electron/package.json').version, architecture: process.arch, files: hashes }, null, 2));
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts/package.json'), JSON.stringify({ directory: target, executable: path.join(target, 'BallBuddy.exe'), files: files.length, bytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0) }, null, 2));
console.log(`Portable Windows package: ${target}`);
