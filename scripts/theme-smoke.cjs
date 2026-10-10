'use strict';

// Real Electron visual integration checks. All records use this isolated run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'artifacts', `theme-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const dataDirectory = path.join(directory, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });
const packaged = process.argv.includes('--packaged');
const packageInfo = packaged ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8')) : null;
const env = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], screenshots = [], layouts = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let application, page;
function record(name) { checks.push(name); console.log(`PASS ${name}`); }
async function command(value) {
  const result = await page.evaluate(value => window.buddy.command(value), value);
  assert.equal(result.ok, true, result.error);
}
async function changePage(name) {
  if (name === 'settings') await page.locator('#settings-open').click();
  else if (name === 'decompose') {
    await page.getByTestId('nav-desk').click();
    await page.locator('#decompose-open').click();
  } else await page.getByTestId(`nav-${name}`).click();
  await page.locator(`#${name}-page`).waitFor({ state: 'visible' });
  await page.waitForFunction(name => document.body.dataset.page === name, name);
}
async function settingsGroup(name) {
  await page.locator(`[data-settings-section="${name}"]`).click();
  await page.locator(`#settings-section-${name}`).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.settings-section:visible').count(), 1);
}
async function capture(name) {
  const file = path.join(directory, `${name}.png`);
  await page.screenshot({ path: file });
  screenshots.push({ name, path: file });
}
async function geometry(name, critical) {
  const result = await page.evaluate(selectors => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const unclipped = node => {
      const r = node.getBoundingClientRect();
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const s = getComputedStyle(parent), p = parent.getBoundingClientRect();
        if (/auto|hidden|scroll|clip/.test(s.overflowY) && (r.top < p.top - 1 || r.bottom > p.bottom + 1)) return false;
        if (/auto|hidden|scroll|clip/.test(s.overflowX) && (r.left < p.left - 1 || r.right > p.right + 1)) return false;
      }
      return true;
    };
    const main = [...document.querySelectorAll('.app-content > main, .app-content > .extension-page')].find(node => !node.hidden);
    const controls = [...main.querySelectorAll('button,input,select,textarea')].filter(visible).map(node => ({ id: node.id, ...rect(node) }));
    return { viewport: { width: innerWidth, height: innerHeight },
      theme: document.documentElement.dataset.theme, font: document.documentElement.dataset.fontFamily,
      rootOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      sidebar: rect(document.querySelector('.app-sidebar')), header: rect(document.querySelector('.app-header')),
      main: rect(main), controls, critical: selectors.map(selector => { const node = document.querySelector(selector); return { selector, visible: Boolean(node && visible(node)), unclipped: Boolean(node && unclipped(node)), ...(node ? rect(node) : {}) }; }),
      balls: document.querySelectorAll('#main-ball').length,
      fontSize: parseFloat(getComputedStyle(document.body).fontSize) };
  }, critical);
  layouts.push({ name, ...result });
  assert.equal(result.rootOverflow, false, `${name}: document width`);
  assert.equal(result.balls, 1, `${name}: exactly one main ball`);
  assert.ok(Math.abs(result.header.height - 64) <= 1 && result.header.left >= result.sidebar.right - 1, `${name}: persistent shell`);
  assert.ok(result.main.bottom <= result.viewport.height + 1, `${name}: content fits actual client height`);
  assert.ok(result.controls.every(r => r.left >= result.sidebar.right - 1 && r.right <= result.viewport.width + 1 && r.width > 0), `${name}: visible controls fit horizontally`);
  for (const r of result.critical) assert.ok(r.visible && r.unclipped && r.width > 0 && r.height > 0 && r.top >= result.header.bottom - 1 && r.bottom <= result.viewport.height + 1, `${name}: ${r.selector} is fully visible without ancestor clipping`);
  record(`${name}: shell, single ball and controls fit the real client area`);
}
async function sampleBall() {
  return page.locator('#main-ball').evaluate(node => ({ phase: node.dataset.colorPhase, color: node.dataset.buddyColor,
    motion: node.dataset.motionActive, svg: node.querySelector('svg').innerHTML }));
}
async function run() {
  application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 45000 });
  const attached = new WeakSet();
  const listen = p => { if (attached.has(p)) return; attached.add(p); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); };
  application.on('window', listen);
  await application.firstWindow();
  for (const p of application.windows()) listen(p);
  page = application.windows().find(p => p.url().endsWith('/index.html'));
  assert.ok(page);
  await page.waitForFunction(() => document.querySelector('#desk-page').getAttribute('aria-busy') === 'false');
  await page.waitForSelector('#main-ball svg');
  const runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron, userData: app.getPath('userData') }));
  assert.equal(path.resolve(runtime.userData).toLowerCase(), dataDirectory.toLowerCase());
  assert.equal(runtime.version, '0.3.0');
  for (const title of ['复习一小节，再写下三个要点', '整理一份较长的学习笔记，让真实任务内容完整换行而不会挡住右侧完成按钮。'.repeat(2)]) {
    await page.getByTestId('task-input').fill(title);
    await page.getByTestId('task-add').click();
  }
  await page.locator('#main-ball').evaluate(node => { window.__themeSmokeBall = node; });
  const matrix = [
    ['desk', ['#task-input', '#task-add', '#focus-start', '#pet-scale', '.desk-store']],
    ['chat', ['#chat-input', '#chat-send', '#chat-configure', '#focus-start']],
    ['study', ['#study-nickname', '#study-server', '#study-create', '#study-join']],
    ['decompose', ['#decompose-goal', '#decompose-generate']],
    ['settings', ['#settings-back', '#settings-save-status']]
  ];
  for (const [size, width, height] of [['default', 1040, 780], ['minimum', 880, 680]]) {
    await application.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).setSize(...dimensions), [width, height]);
    for (const theme of ['light', 'dark']) {
      await command({ type: 'settings.update', themeMode: theme, textSize: 'normal' });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      for (const [name, critical] of matrix) {
        await changePage(name);
        if (name === 'settings') await settingsGroup('appearance');
        await delay(140);
        const label = `${size}-${theme}-${name}`;
        await geometry(label, critical); await capture(label);
        if (name === 'chat') {
          assert.equal(await page.locator('#main-ball').evaluate(node => node === window.__themeSmokeBall && node.closest('#chat-companion-slot') !== null), true);
          await page.locator('#chat-history-toggle').click();
          await geometry(`${label}-history`, ['#chat-input', '#chat-send']); await capture(`${label}-history`);
          await page.locator('#chat-history-toggle').click();
        }
      }
      for (const group of ['window', 'pet', 'focus', 'ai']) {
        await settingsGroup(group);
        await geometry(`${size}-${theme}-settings-${group}`, ['#settings-back', '#settings-save-status']);
        if (size === 'minimum') await capture(`${size}-${theme}-settings-${group}`);
      }
    }
  }
  // Use an existing local font through the actual import/FontFace/save pipeline.
  const fontSource = ['C:\\Windows\\Fonts\\SourceHanSansCN-Heavy.otf', 'C:\\Windows\\Fonts\\simhei.ttf'].find(fs.existsSync);
  assert.ok(fontSource, 'An existing local font is required; no font installation');
  await settingsGroup('appearance');
  await application.evaluate(({ dialog }, file) => { globalThis.__themeSmokeDialog = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, fontSource);
  try { await page.locator('#settings-font-import').click(); await page.waitForFunction(() => document.documentElement.dataset.fontFamily === 'custom' && document.documentElement.dataset.fontStatus === 'ready' && document.querySelector('#settings-page').getAttribute('aria-busy') === 'false' && !document.querySelector('#settings-font-import').disabled); }
  finally { await application.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__themeSmokeDialog; delete globalThis.__themeSmokeDialog; }); }
  await command({ type: 'settings.update', textSize: 'large' });
  await page.waitForFunction(() => document.documentElement.dataset.textSize === 'large');
  for (const [name, critical] of matrix) {
    await changePage(name); if (name === 'settings') await settingsGroup('appearance');
    await geometry(`minimum-dark-wide-large-${name}`, critical.filter(selector => selector !== '#pet-scale')); await capture(`minimum-dark-wide-large-${name}`);
    if (name === 'desk') {
      await page.locator('#pet-scale').scrollIntoViewIfNeeded();
      await geometry('minimum-dark-wide-large-desk-preferences', ['#pet-scale']);
      await capture('minimum-dark-wide-large-desk-preferences');
    }
  }
  await changePage('chat'); await page.locator('#chat-configure').click(); await settingsGroup('ai');
  await page.locator('#settings-back').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'chat-configure');
  record('return from AI settings restores the chat entry keyboard focus');
  await command({ type: 'settings.update', textSize: 'normal', fontFamily: 'system', motionMode: 'full' });
  await changePage('desk');
  const frames = [];
  for (let i = 0; i < 12; i++) { const frame = await sampleBall(); frames.push({ ...frame, svg: crypto.createHash('sha256').update(frame.svg).digest('hex') }); await delay(100); }
  assert.ok(new Set(frames.map(f => f.svg)).size >= 8 && new Set(frames.map(f => f.phase)).size >= 8);
  await page.locator('#main-ball').click();
  assert.ok(Number(await page.locator('#main-ball').getAttribute('data-effect-count')) > 0);
  await changePage('chat');
  assert.equal(await page.locator('#main-ball').evaluate(node => node === window.__themeSmokeBall), true);
  const chatA = await sampleBall(); await delay(220); const chatB = await sampleBall(); assert.notEqual(chatA.phase, chatB.phase);
  await changePage('study'); await delay(300);
  const hiddenA = await sampleBall(); await delay(260); const hiddenB = await sampleBall(); assert.equal(hiddenA.phase, hiddenB.phase); assert.equal(hiddenB.motion, 'false');
  record('12 real continuous frames, autonomous colour, click effect, same-instance chat motion and hidden-page freeze');
  assert.deepEqual(errors, []);
  return { runtime, fontFixture: { source: fontSource, sha256: crypto.createHash('sha256').update(fs.readFileSync(fontSource)).digest('hex') }, frames };
}
(async () => {
  let result;
  try { result = await run(); }
  catch (error) { errors.push(error.stack || error.message); console.error(error); process.exitCode = 1; }
  finally {
    if (application) await application.close().catch(error => errors.push(error.message));
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ passed: !errors.length, packaged, checks, errors, layouts, screenshots, ...result }, null, 2));
    console.log(`Theme report: ${directory}`);
  }
})();
