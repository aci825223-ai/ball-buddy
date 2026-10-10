'use strict';

// This script exercises a real isolated Electron application. It does not
// install fonts, change Windows preferences, or touch the user's own data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { _electron } = require('playwright');
const { createInitialState, SETTINGS_DEFAULTS } = require('../src/shared/state.cjs');

const root = path.resolve(__dirname, '..');
const packagedOnly = process.argv.includes('--packaged');
const directory = path.join(root, 'artifacts', `settings-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const dataDirectory = path.join(directory, 'data');
const fixturesDirectory = path.join(directory, 'fixtures');
const packageInfo = packagedOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'package.json'), 'utf8')) : null;
const environment = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
delete environment.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dataDirectory, { recursive: true });
fs.mkdirSync(fixturesDirectory, { recursive: true });

const checks = [];
const errors = [];
const expectedErrors = [];
const screenshots = [];
const details = { limitations: [
  'System theme following is tested through nativeTheme in the isolated process; Windows appearance settings are never changed.',
  'Native dialog selections are supplied by a temporary showOpenDialog stub; the original OS file-picker interaction is not claimed.',
  'The real app tray MenuItem handlers are invoked from its captured setContextMenu Menu; the Windows notification-area UI is not clicked.',
  'Notification.show calls are recorded through a temporary prototype stub; Windows notification visibility is not claimed.',
] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let application;
let mainPage;
let petPage;
let expectedDecodeError = false;
const renamesToRestore = [];

function record(name) { checks.push(name); console.log(`PASS ${name}`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function checkedIsolatedPath(file) {
  const resolved = path.resolve(file);
  const prefix = `${path.resolve(directory)}${path.sep}`.toLowerCase();
  assert.ok(resolved.toLowerCase().startsWith(prefix), 'Test file mutation must stay within this exact isolated run directory');
  return resolved;
}
function renameForTest(file, suffix) {
  const from = checkedIsolatedPath(file);
  const to = checkedIsolatedPath(`${file}.${suffix}`);
  assert.equal(fs.lstatSync(from).isFile(), true, 'Only a regular isolated test file can be moved');
  assert.equal(fs.existsSync(to), false, 'A test move must never replace another file');
  fs.renameSync(from, to);
  const moved = { from, to };
  renamesToRestore.push(moved);
  return moved;
}
function restoreRename(recorded) {
  if (!fs.existsSync(recorded.to)) return;
  checkedIsolatedPath(recorded.from); checkedIsolatedPath(recorded.to);
  if (recorded.allowExistingReplacement && fs.existsSync(recorded.from)) {
    assert.equal(fs.lstatSync(recorded.from).isFile(), true);
    assert.equal(sha256(fs.readFileSync(recorded.from)), sha256(fs.readFileSync(recorded.to)), 'A repaired asset must match its preserved isolated backup');
    recorded.retainedBackup = recorded.to;
    return;
  }
  assert.equal(fs.existsSync(recorded.from), false, 'Restoration must not replace a new file');
  fs.renameSync(recorded.to, recorded.from);
}
function assetFiles() {
  const fonts = path.join(dataDirectory, 'fonts');
  return fs.existsSync(fonts) ? fs.readdirSync(fonts).filter(name => /^[a-f0-9]{64}\.(ttf|otf|woff|woff2)$/u.test(name)).sort()
    .map(name => { const bytes = fs.readFileSync(path.join(fonts, name)); return { name, bytes: bytes.length, sha256: sha256(bytes) }; }) : [];
}
async function waitUntil(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(80); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function current() { return mainPage.evaluate(() => window.buddy.getState()); }
async function command(value) {
  const result = await mainPage.evaluate(value => window.buddy.command(value), value);
  assert.equal(result.ok, true, result.error);
  return result.state;
}
async function waitForSettingsIdle() {
  if (!await mainPage.getByTestId('settings-page').isVisible()) return;
  await mainPage.waitForFunction(() => {
    const page = document.querySelector('#settings-page');
    const status = document.querySelector('#settings-save-status');
    return page.getAttribute('aria-busy') === 'false' && status.dataset.status !== 'saving'
      && status.textContent.trim().length > 0 && document.documentElement.dataset.fontStatus !== 'loading'
      && !document.querySelector('#settings-font-import').disabled
      && !document.querySelector('#settings-theme [data-theme-mode="light"]').disabled;
  });
}
async function assertPersistentSettingsControls(label) {
  await waitForSettingsIdle();
  const value = await mainPage.evaluate(() => {
    const measure = id => { const node = document.getElementById(id); const r = node.getBoundingClientRect();
      return { id, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        visible: !node.hidden && getComputedStyle(node).display !== 'none', text: node.textContent.trim() }; };
    return { viewport: { width: innerWidth, height: innerHeight }, back: measure('settings-back'),
      status: measure('settings-save-status'), error: measure('settings-error') };
  });
  for (const part of ['back', 'status', ...(value.error.visible ? ['error'] : [])]) {
    const r = value[part];
    assert.ok(r.visible && r.width > 0 && r.height > 0 && r.text, `${label}: ${part} must be visible and meaningful`);
    assert.ok(r.x >= -1 && r.y >= -1 && r.right <= value.viewport.width + 1 && r.bottom <= value.viewport.height + 1, `${label}: ${part} must remain inside the viewport while navigating setting groups`);
  }
  details.persistentControls ??= [];
  details.persistentControls.push({ label, value });
  return value;
}
async function capture(name, page = mainPage) {
  if (page === mainPage) await waitForSettingsIdle();
  const file = path.join(directory, `${name}.png`);
  await page.screenshot({ path: file, omitBackground: page === petPage });
  screenshots.push({ name, path: file });
}
async function nativeWindows() {
  return application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    page: window.webContents.getURL().split('/').pop(), bounds: window.getBounds(), visible: window.isVisible(),
    alwaysOnTop: window.isAlwaysOnTop(), backgroundColor: window.getBackgroundColor(),
    preferences: { nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
      contextIsolation: window.webContents.getLastWebPreferences().contextIsolation,
      sandbox: window.webContents.getLastWebPreferences().sandbox },
  })));
}
async function appearance(page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    fontStatus: document.documentElement.dataset.fontStatus,
    fontFamily: document.documentElement.dataset.fontFamily,
    textSize: document.documentElement.dataset.textSize,
    appliedFont: getComputedStyle(document.documentElement).getPropertyValue('--app-font').trim(),
    bodyFont: getComputedStyle(document.body).fontFamily,
    bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize),
    background: getComputedStyle(document.body).backgroundColor,
    loadedFonts: [...document.fonts].map(font => ({ family: font.family, status: font.status })),
    rootBackground: getComputedStyle(document.documentElement).backgroundColor,
  }));
}
async function launch() {
  application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'),
    args: packagedOnly ? [] : [root], cwd: root, env: environment, timeout: 45000 });
  const attached = new WeakSet();
  const listen = page => {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      const text = message.text();
      if (expectedDecodeError && /(?:OTS parsing error|Failed to decode downloaded font|Invalid sfntVersion|not a valid sfnt)/iu.test(text)) {
        expectedErrors.push({ page: page.url().split('/').pop(), kind: 'intentional malformed-font decoding', message: text });
      } else if (message.type() === 'error') errors.push(text);
    });
  };
  application.on('window', listen);
  await application.firstWindow();
  await waitUntil(() => application.windows().length === 2, 'both real application windows');
  for (const page of application.windows()) { listen(page); await page.waitForLoadState('domcontentloaded'); }
  mainPage = application.windows().find(page => page.url().endsWith('/index.html'));
  petPage = application.windows().find(page => page.url().endsWith('/pet.html'));
  assert.ok(mainPage && petPage, 'Both local renderer pages must load');
  await mainPage.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false');
  await mainPage.getByTestId('settings-open').waitFor({ state: 'attached' });
  await petPage.waitForSelector('#pet-ball svg.buddy-character [data-buddy-body]');
  await mainPage.waitForFunction(() => ['ready', 'fallback'].includes(document.documentElement.dataset.fontStatus));
  await petPage.waitForFunction(() => ['ready', 'fallback'].includes(document.documentElement.dataset.fontStatus));
  details.executable = packageInfo?.executable || require('electron');
  details.runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron,
    chrome: process.versions.chrome, userData: app.getPath('userData') }));
  assert.equal(path.resolve(details.runtime.userData).toLowerCase(), path.resolve(dataDirectory).toLowerCase());
}
async function closeApplication() {
  if (!application) return;
  const active = application; application = null;
  await active.close();
}
async function openSettings(keyboard = false) {
  if (await mainPage.getByTestId('settings-page').isVisible()) return;
  const entry = mainPage.getByTestId('settings-open');
  if (keyboard) { await entry.focus(); await entry.press('Enter'); } else await entry.click();
  await mainPage.getByTestId('settings-page').waitFor({ state: 'visible' });
}
async function settingsSection(name) {
  await mainPage.locator(`[data-settings-section="${name}"]`).click();
  await mainPage.locator(`#settings-section-${name}`).scrollIntoViewIfNeeded();
}
async function captureSettingsTop(prefix) {
  await mainPage.evaluate(() => window.scrollTo(0, 0));
  await waitForSettingsIdle();
  const heading = await mainPage.locator('#settings-heading').boundingBox();
  assert.ok(heading && heading.y >= 0 && heading.y + heading.height <= await mainPage.evaluate(() => innerHeight), 'Initial settings view must actually show its heading');
  await assertPersistentSettingsControls(`${prefix} initial view`);
  await capture(`${prefix}-top`);
}
async function selectSetting(id, value, field = null) {
  await mainPage.getByTestId(id).selectOption(value);
  if (field) await waitUntil(async () => (await current()).settings[field] === value, `${field} saved from the real select`);
}
async function switchSetting(id, value, field) {
  await mainPage.getByTestId(id).setChecked(value);
  await waitUntil(async () => (await current()).settings[field] === value, `${field} saved from the real switch`);
}
async function setTheme(mode) {
  await mainPage.locator(`#settings-theme [data-theme-mode="${mode}"]`).click();
  await waitUntil(async () => (await current()).settings.themeMode === mode, `${mode} theme preference persisted`);
  const resolved = (await current()).app.resolvedTheme;
  await mainPage.waitForFunction(value => document.documentElement.dataset.theme === value, resolved);
  await petPage.waitForFunction(value => document.documentElement.dataset.theme === value, resolved);
  assert.equal(await mainPage.locator(`[data-theme-mode="${mode}"]`).getAttribute('aria-pressed'), 'true');
  return resolved;
}
async function setTextSize(size) {
  await mainPage.locator(`#settings-text-size [data-text-size="${size}"]`).click();
  await waitUntil(async () => (await current()).settings.textSize === size, `${size} text preference saved`);
  await mainPage.waitForFunction(value => document.documentElement.dataset.textSize === value, size);
  await petPage.waitForFunction(value => document.documentElement.dataset.textSize === value, size);
}
async function installDialogStub(file, cancelled = false) {
  await application.evaluate(({ dialog }, value) => {
    globalThis.__settingsSmokeDialogOriginal ??= dialog.showOpenDialog;
    globalThis.__settingsSmokeDialogCalls = [];
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      globalThis.__settingsSmokeDialogCalls.push({ filters: options.filters, properties: options.properties });
      return { canceled: value.cancelled, filePaths: value.cancelled ? [] : [value.file] };
    };
  }, { file, cancelled });
}
async function restoreDialog() {
  if (!application) return;
  await application.evaluate(({ dialog }) => {
    if (globalThis.__settingsSmokeDialogOriginal) dialog.showOpenDialog = globalThis.__settingsSmokeDialogOriginal;
    delete globalThis.__settingsSmokeDialogOriginal;
  });
}
async function clickFontImport(file, cancelled = false) {
  await installDialogStub(file, cancelled);
  try {
    await mainPage.getByTestId('settings-font-import').click();
    await waitUntil(() => application.evaluate(() => globalThis.__settingsSmokeDialogCalls.length === 1), 'native dialog invoked by real import button');
    await waitUntil(async () => !(await mainPage.getByTestId('settings-font-import').isDisabled()), 'font import UI settles', 30000);
    await delay(200);
    const calls = await application.evaluate(() => globalThis.__settingsSmokeDialogCalls);
    assert.ok(calls[0].properties.includes('openFile'));
    assert.ok(calls[0].filters.some(filter => ['ttf', 'otf', 'woff', 'woff2'].every(extension => filter.extensions.includes(extension))));
    return { calls, state: await current(), error: await mainPage.locator('#settings-error').textContent(), appearance: await appearance(mainPage) };
  } finally { await restoreDialog(); }
}
async function importCandidate(file) {
  await installDialogStub(file);
  try { return await mainPage.evaluate(() => window.buddy.importFont()); }
  finally { await restoreDialog(); }
}
async function captureSettingsGroups(prefix) {
  for (const group of ['appearance', 'window', 'pet', 'focus']) {
    await settingsSection(group);
    await assertPersistentSettingsControls(`${prefix} ${group}`);
    await capture(`${prefix}-${group}`);
  }
}
async function assertNoHorizontalOverflow(label) {
  const value = await mainPage.evaluate(() => ({ width: innerWidth, height: innerHeight,
    root: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
    settings: { scroll: document.querySelector('#settings-page').scrollWidth, client: document.querySelector('#settings-page').clientWidth },
    controls: [...document.querySelectorAll('#settings-page input, #settings-page select, #settings-page button')].filter(node => node.getClientRects().length && !node.hidden && getComputedStyle(node).display !== 'none').map(node => {
      const r = node.getBoundingClientRect(); return { id: node.id, right: r.right, left: r.left, width: r.width };
    }) }));
  assert.ok(value.root.scroll <= value.root.client + 1, `${label}: document must not overflow horizontally`);
  assert.ok(value.settings.scroll <= value.settings.client + 1, `${label}: settings must not overflow horizontally`);
  assert.ok(value.controls.every(control => control.left >= -1 && control.right <= value.width + 1 && control.width > 0), `${label}: all settings controls must fit the real window width`);
  return value;
}
async function captureTrayMenu() {
  await application.evaluate(({ Tray }) => {
    if (globalThis.__settingsSmokeTrayOriginal) return;
    globalThis.__settingsSmokeTrayOriginal = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.__settingsSmokeTray = this;
      globalThis.__settingsSmokeTrayMenu = menu;
      return globalThis.__settingsSmokeTrayOriginal.call(this, menu);
    };
  });
  await mainPage.evaluate(() => window.buddy.setPetVisible(true));
  return application.evaluate(() => globalThis.__settingsSmokeTrayMenu.items.map(item => ({ label: item.label, type: item.type, enabled: item.enabled })));
}
async function clickTrayOpen() {
  await captureTrayMenu();
  await application.evaluate(({ BrowserWindow }) => {
    const menu = globalThis.__settingsSmokeTrayMenu;
    const item = menu.items.find(item => /打开/u.test(item.label));
    if (!item || typeof item.click !== 'function') throw new Error('Actual tray open MenuItem missing');
    item.click(item, BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')), {});
  });
  await waitUntil(async () => (await nativeWindows()).find(window => window.page === 'index.html').visible, 'actual tray open handler shows the native panel');
}
async function quitThrough(kind) {
  const active = application;
  const nativeProcess = active.process();
  const closed = active.waitForEvent('close', { timeout: 15000 });
  if (kind === 'tray') {
    await captureTrayMenu();
    await active.evaluate(() => {
      const item = globalThis.__settingsSmokeTrayMenu.items.find(item => /退出/u.test(item.label));
      if (!item || typeof item.click !== 'function') throw new Error('Actual tray quit MenuItem missing');
      setTimeout(() => item.click(item, undefined, {}), 50);
    });
  } else {
    await active.evaluate(({ BrowserWindow }) => {
      setTimeout(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).close(), 50);
    });
  }
  await closed;
  application = null;
  await waitUntil(() => nativeProcess.exitCode !== null, `${kind} exits the isolated native main process`);
  assert.equal(nativeProcess.exitCode, 0, `${kind} must exit normally`);
}

function prepareFixtures() {
  const fontSources = {
    ttf: ['C:\\Windows\\Fonts\\simhei.ttf', 'C:\\Windows\\Fonts\\arial.ttf'].find(file => fs.existsSync(file)),
    wide: ['C:\\Windows\\Fonts\\SourceHanSansCN-Heavy.otf', 'C:\\Windows\\Fonts\\simhei.ttf'].find(file => fs.existsSync(file)),
  };
  assert.ok(fontSources.ttf && fontSources.wide, 'Existing local fonts are required; this script installs no font');
  const fonts = {};
  for (const [kind, source] of Object.entries(fontSources)) {
    const bytes = fs.readFileSync(source);
    assert.ok(bytes.length <= 32 * 1024 * 1024);
    const file = path.join(fixturesDirectory, `${kind}-source${path.extname(source).toLowerCase()}`);
    fs.writeFileSync(file, bytes);
    fonts[kind] = { source, file, bytes: bytes.length, sha256: sha256(bytes), extension: path.extname(source).toLowerCase() };
  }
  fonts.badSignature = path.join(fixturesDirectory, 'bad-signature.ttf');
  fs.writeFileSync(fonts.badSignature, Buffer.from('Ball Buddy intentional invalid font fixture'));
  fonts.badDecoded = path.join(fixturesDirectory, 'valid-signature-damaged.ttf');
  const damaged = Buffer.alloc(256); damaged.writeUInt32BE(0x00010000, 0); damaged.writeUInt16BE(1, 4); damaged.write('BAD!', 12); fs.writeFileSync(fonts.badDecoded, damaged);
  fonts.oversized = path.join(fixturesDirectory, 'over-32mib.ttf');
  const descriptor = fs.openSync(fonts.oversized, 'w');
  try { fs.writeSync(descriptor, Buffer.from([0, 1, 0, 0])); fs.ftruncateSync(descriptor, 32 * 1024 * 1024 + 1); }
  finally { fs.closeSync(descriptor); }
  details.fontSources = fonts;
  return fonts;
}
function prepareState() {
  const now = Date.now() - 60_000;
  const initial = createInitialState(now);
  initial.tasks = [
    { id: 'settings-open-task', title: '整理今天想做的小事，保留进度再调整外观', createdAt: now, completedAt: null, extension: { preserved: true } },
    { id: 'settings-done-task', title: '已经完成的任务不会因恢复设置而消失', createdAt: now, completedAt: now + 1000 },
  ];
  initial.selectedTaskId = 'settings-open-task';
  initial.stats = { energy: 37, completedTasks: 1, focusSessions: 2, totalFocusMs: 120000, extraStats: { preserve: 7 } };
  initial.decorations = ['lamp'];
  initial.settings.futurePreference = { keep: true, value: 'unknown setting preserved' };
  initial.futureData = { keep: 'unknown root data preserved' };
  fs.writeFileSync(path.join(dataDirectory, 'state.json'), JSON.stringify(initial, null, 2));
}

async function themesAndNavigation() {
  await launch();
  details.initialWindows = await nativeWindows();
  assert.ok(details.initialWindows.every(window => !window.preferences.nodeIntegration && window.preferences.contextIsolation && window.preferences.sandbox));
  assert.equal((await current()).app.version, details.runtime.version);
  assert.equal(typeof (await current()).app.notificationsSupported, 'boolean');
  await mainPage.getByTestId('focus-start').click();
  const session = (await current()).session;
  assert.equal(session.status, 'running');
  await openSettings(true);
  await mainPage.getByTestId('settings-back').focus();
  await mainPage.getByTestId('settings-back').press('Enter');
  await mainPage.getByTestId('settings-page').waitFor({ state: 'hidden' });
  assert.equal(await mainPage.evaluate(() => document.activeElement.id), 'settings-open', 'Keyboard return must restore focus to the settings entry');
  assert.equal((await current()).session.id, session.id, 'Settings navigation must preserve the running timestamp session');
  await openSettings(true);
  details.sessionNavigation = { original: session, after: (await current()).session };
  record('real keyboard entry/return restores focus and preserves a running task session');
  await command({ type: 'focus.stop' });

  details.themes = {};
  for (const mode of ['light', 'dark']) {
    assert.equal(await setTheme(mode), mode);
    details.themes[mode] = { main: await appearance(mainPage), pet: await appearance(petPage), native: await nativeWindows() };
    const colors = [details.themes[mode].main.background, details.themes[mode].pet.background, details.themes[mode].pet.rootBackground];
    assert.ok(colors[1] === 'rgba(0, 0, 0, 0)' && colors[2] === 'rgba(0, 0, 0, 0)', 'Transparent desktop pet must retain a transparent root and body');
    await captureSettingsTop(`settings-${mode}`);
    await captureSettingsGroups(`settings-${mode}`);
    await mainPage.getByTestId('settings-back').click();
    await capture(`workspace-${mode}`);
    await openSettings();
  }
  assert.notEqual(details.themes.light.main.rootBackground, details.themes.dark.main.rootBackground, 'Dark theme must actually change panel background');
  record('stable light/dark initial settings views show the heading; return and save feedback remain visible across all four groups');
  await settingsSection('appearance');
  await setTheme('system');
  details.systemThemes = [];
  for (const mode of ['dark', 'light']) {
    await application.evaluate(({ nativeTheme }, mode) => { nativeTheme.themeSource = mode; }, mode);
    await waitUntil(async () => (await current()).app.resolvedTheme === mode, `${mode} isolated nativeTheme update broadcasts`);
    await mainPage.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode);
    await petPage.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode);
    assert.equal((await current()).settings.themeMode, 'system', 'Simulated OS update must not overwrite saved system preference');
    details.systemThemes.push({ mode, main: await appearance(mainPage), pet: await appearance(petPage) });
  }
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
  record('light/dark/system UI choices update both real pages; isolated nativeTheme changes propagate without changing Windows');

  const saved = await current();
  const nativeBefore = await application.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
  await application.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('fs'); const path = process.getBuiltinModule('path');
    globalThis.__settingsSmokeRenameOriginal = fs.renameSync;
    const target = path.resolve(app.getPath('userData'), 'state.json').toLowerCase();
    fs.renameSync = function (from, to) {
      if (path.resolve(String(to)).toLowerCase() === target) { const error = new Error('Intentional isolated persistence failure'); error.code = 'EACCES'; throw error; }
      return globalThis.__settingsSmokeRenameOriginal.call(fs, from, to);
    };
  });
  try {
    await mainPage.locator('#settings-theme [data-theme-mode="dark"]').click();
    await waitUntil(async () => (await mainPage.locator('#settings-save-status').getAttribute('data-status')) === 'error', 'real UI reports failed settings save');
    assert.deepEqual((await current()).settings, saved.settings);
    assert.deepEqual(await application.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors })), nativeBefore, 'Native theme side effects must not precede persistence');
    assert.equal(await mainPage.locator('[data-theme-mode="system"]').getAttribute('aria-pressed'), 'true', 'Failed save must restore the UI to its persisted selection');
    assert.match(await mainPage.locator('#settings-error').textContent(), /保存|原来|重试/u);
    details.preferenceSaveFailure = { settings: (await current()).settings, native: nativeBefore, message: await mainPage.locator('#settings-error').textContent() };
  } finally { await application.evaluate(() => { const fs = process.getBuiltinModule('fs'); fs.renameSync = globalThis.__settingsSmokeRenameOriginal; delete globalThis.__settingsSmokeRenameOriginal; }); }
  record('real settings UI reports a storage failure and restores saved selection before any native theme side effect');
}

async function fontsAndSizes(fonts) {
  await settingsSection('appearance');
  details.builtInFonts = {};
  for (const family of ['yahei', 'segoe', 'system']) {
    await selectSetting('settings-font-family', family, 'fontFamily');
    await waitUntil(async () => (await appearance(mainPage)).fontFamily === family && (await appearance(petPage)).fontFamily === family, `${family} font applies to both windows`);
    details.builtInFonts[family] = { main: await appearance(mainPage), pet: await appearance(petPage) };
  }
  assert.notEqual(details.builtInFonts.yahei.main.appliedFont, details.builtInFonts.segoe.main.appliedFont);
  details.textSizes = {};
  for (const size of ['small', 'normal', 'large']) {
    await setTextSize(size);
    details.textSizes[size] = { main: await appearance(mainPage), pet: await appearance(petPage) };
  }
  assert.ok(details.textSizes.small.main.bodyFontSize < details.textSizes.normal.main.bodyFontSize && details.textSizes.normal.main.bodyFontSize < details.textSizes.large.main.bodyFontSize, 'Text sizes must actually change rendered panel font sizes');
  record('native font choices and all three text sizes save and change actual renderer typography in both windows');

  const valid = await clickFontImport(fonts.ttf.file);
  assert.equal(valid.state.settings.fontFamily, 'custom');
  assert.equal(valid.state.settings.importedFont.id, `${fonts.ttf.sha256}${fonts.ttf.extension}`);
  const imported = valid.state.settings.importedFont;
  await waitUntil(async () => (await appearance(mainPage)).fontStatus === 'ready' && (await appearance(petPage)).fontStatus === 'ready', 'actual imported FontFace ready in both renderers', 30000);
  for (const page of [mainPage, petPage]) {
    const value = await appearance(page);
    assert.equal(value.fontFamily, 'custom');
    assert.ok(value.loadedFonts.some(font => font.status === 'loaded'), 'An actual loaded FontFace must be present in each renderer');
  }
  const active = await mainPage.evaluate(async () => { const result = await window.buddy.getActiveFont(); return { ok: result.ok, font: result.font, bytes: result.bytes?.length }; });
  assert.equal(active.ok, true); assert.deepEqual(active.font, imported); assert.equal(active.bytes, fonts.ttf.bytes);
  const asset = checkedIsolatedPath(path.join(dataDirectory, 'fonts', imported.id));
  assert.equal(sha256(fs.readFileSync(asset)), fonts.ttf.sha256);
  const duplicate = await clickFontImport(fonts.ttf.file);
  assert.deepEqual(duplicate.state.settings.importedFont, imported);
  assert.equal(assetFiles().filter(file => file.name === imported.id).length, 1);
  details.importedTtf = { imported, active, assets: assetFiles(), appearance: { main: await appearance(mainPage), pet: await appearance(petPage) } };
  record('real import UI uses native-dialog bridge, decodes FontFace, confirms a SHA-256 managed copy, and reuses duplicate content');

  const beforeFailure = (await current()).settings;
  const cancel = await clickFontImport(null, true);
  assert.deepEqual(cancel.state.settings, beforeFailure, 'Cancel must preserve all current settings');
  const invalid = await importCandidate(fonts.badSignature);
  assert.equal(invalid.ok, false); assert.match(invalid.error, /字体|格式|文件/u);
  const oversized = await importCandidate(fonts.oversized);
  assert.equal(oversized.ok, false); assert.match(oversized.error, /32|大小|字体/u);
  const pending = await mainPage.evaluate(() => window.buddy.confirmFontImport('not-a-current-pending-id'));
  assert.equal(pending.ok, false);
  expectedDecodeError = true;
  let decoded;
  try { decoded = await clickFontImport(fonts.badDecoded); await delay(400); }
  finally { expectedDecodeError = false; }
  assert.deepEqual(decoded.state.settings, beforeFailure, 'Actual FontFace decoding failure must retain the prior font');
  assert.match(decoded.error, /字体|损坏|读取|无法/u, 'Actual decoding failure must have understandable visible feedback');
  details.fontErrors = { cancel, invalid, oversized, pending, decoded };
  record('cancel, bad signature, over-32MiB, invalid pending token and actual damaged-FontFace errors preserve the existing font');

  await installDialogStub(fonts.wide.file);
  let candidate;
  try {
    candidate = await mainPage.evaluate(async () => {
      const result = await window.buddy.importFont();
      if (!result.ok || result.cancelled) return result;
      const font = new FontFace('SettingsSmokeCandidate', new Uint8Array(result.bytes).buffer);
      await font.load(); return { ok: true, pendingId: result.pendingId, font: result.font, bytes: result.bytes.length, decoded: font.status };
    });
  } finally { await restoreDialog(); }
  assert.equal(candidate.ok, true); assert.ok(candidate.pendingId && candidate.bytes > 0); assert.equal(candidate.decoded, 'loaded');
  await application.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('fs'); const path = process.getBuiltinModule('path');
    globalThis.__settingsSmokeRenameOriginal = fs.renameSync;
    const target = path.resolve(app.getPath('userData'), 'state.json').toLowerCase();
    fs.renameSync = function (from, to) {
      if (path.resolve(String(to)).toLowerCase() === target) { const error = new Error('Intentional isolated persistence failure'); error.code = 'EACCES'; throw error; }
      return globalThis.__settingsSmokeRenameOriginal.call(fs, from, to);
    };
  });
  let saveFailure;
  try { saveFailure = await mainPage.evaluate(id => window.buddy.confirmFontImport(id), candidate.pendingId); }
  finally { await application.evaluate(() => { const fs = process.getBuiltinModule('fs'); fs.renameSync = globalThis.__settingsSmokeRenameOriginal; delete globalThis.__settingsSmokeRenameOriginal; }); }
  assert.equal(saveFailure.ok, false);
  assert.deepEqual((await current()).settings, beforeFailure, 'Font preference must remain unchanged after failed persistence');
  details.fontErrors.saveFailure = saveFailure;
  const cancelledPending = await mainPage.evaluate(async id => {
    const cancellation = await window.buddy.cancelFontImport(id);
    const confirmation = await window.buddy.confirmFontImport(id);
    return { cancellation, confirmation };
  }, candidate.pendingId);
  assert.equal(cancelledPending.cancellation.ok, true); assert.equal(cancelledPending.confirmation.ok, false);
  details.fontErrors.cancelledPending = cancelledPending;
  record('decoded font candidate cannot replace the current preference when the real isolated state save fails');

  const sourceMove = renameForTest(fonts.ttf.file, 'source-unavailable');
  await closeApplication(); await launch();
  assert.deepEqual((await current()).settings.importedFont, imported);
  assert.equal((await appearance(mainPage)).fontStatus, 'ready');
  assert.equal((await appearance(petPage)).fontStatus, 'ready');
  restoreRename(sourceMove);
  record('relaunch uses the saved imported-font copy even when the original selected source has moved');

  const missingMove = renameForTest(asset, 'temporarily-missing');
  missingMove.allowExistingReplacement = true;
  await closeApplication(); await launch();
  assert.deepEqual((await current()).settings.importedFont, imported, 'A missing file must preserve the saved descriptor');
  assert.equal((await appearance(mainPage)).fontStatus, 'fallback');
  assert.equal((await appearance(petPage)).fontStatus, 'fallback');
  await openSettings(); await settingsSection('appearance');
  assert.match(await mainPage.locator('#settings-font-note').textContent(), /找不到|无法|系统|默认|回退/u);
  details.missingFont = { main: await appearance(mainPage), pet: await appearance(petPage), notice: await mainPage.locator('#settings-font-note').textContent() };
  await capture('settings-font-missing-fallback');
  const recovered = await clickFontImport(fonts.ttf.file);
  assert.deepEqual(recovered.state.settings.importedFont, imported);
  await waitUntil(async () => (await appearance(mainPage)).fontStatus === 'ready' && (await appearance(petPage)).fontStatus === 'ready', 'same-ID reimport repairs both pages without restart', 30000);
  details.fontRecoveredWithoutRestart = { main: await appearance(mainPage), pet: await appearance(petPage), revision: (await current()).app.fontRevision };
  for (const page of ['main', 'pet']) {
    assert.equal(details.fontRecoveredWithoutRestart[page].fontFamily, 'custom');
    assert.ok(details.fontRecoveredWithoutRestart[page].appliedFont.includes('BuddyLocal_'), 'Reimport must apply the custom font CSS in each actual page');
  }
  await capture('settings-font-recovered-without-restart');
  restoreRename(missingMove);
  details.fontRecoveredWithoutRestart.retainedBackup = missingMove.retainedBackup;
  await closeApplication(); await launch();
  assert.equal((await appearance(mainPage)).fontStatus, 'ready');
  await openSettings(); await settingsSection('appearance');
  await mainPage.getByTestId('settings-font-reset').click();
  await waitUntil(async () => (await current()).settings.fontFamily === 'system', 'font reset saved');
  assert.deepEqual((await current()).settings.importedFont, imported);
  assert.ok(fs.existsSync(asset));
  record('missing managed font falls back visibly; same-ID reimport repairs both real pages without restart; reset retains its asset and backup');

  const wide = await clickFontImport(fonts.wide.file);
  assert.equal(wide.state.settings.importedFont.id, `${fonts.wide.sha256}${fonts.wide.extension}`);
  assert.equal((await appearance(mainPage)).fontStatus, 'ready');
  details.wideFont = { font: wide.state.settings.importedFont, source: fonts.wide.source };
  await setTextSize('large');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(880, 680));
  await mainPage.waitForFunction(() => innerWidth <= 880);
  details.minimumSettings = await assertNoHorizontalOverflow('880×680 window with large text and custom font');
  for (const theme of ['light', 'dark']) {
    await settingsSection('appearance'); await setTheme(theme);
    await captureSettingsTop(`minimum-large-custom-${theme}`);
    await captureSettingsGroups(`minimum-large-custom-${theme}`);
  }
  await mainPage.getByTestId('settings-back').click();
  const longTitle = 'MW 全角中文宽字体下也要能完整阅读任务，不遮住完成按钮与专注控制。'.repeat(3);
  assert.ok(Array.from(longTitle).length <= 140);
  await mainPage.getByTestId('task-input').fill(longTitle); await mainPage.getByTestId('task-add').click();
  await waitUntil(async () => (await current()).tasks.some(task => task.title === longTitle), 'long task UI saved');
  const workspace = await mainPage.evaluate(() => {
    const label = document.querySelector('#task-add > span'); const node = label.firstChild;
    const characters = [...label.textContent].map((_, index) => { const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1); const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    return { horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      addLabel: { text: label.textContent, characters, clipped: label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1 },
      titles: [...document.querySelectorAll('.task-title')].map(node => ({ text: node.textContent, clippedWidth: node.scrollWidth > node.clientWidth + 1,
        clippedHeight: node.scrollHeight > node.clientHeight + 1 })) };
  });
  assert.equal(workspace.horizontal, false);
  assert.ok(workspace.titles.every(title => !title.clippedWidth && !title.clippedHeight), 'Large custom-font long task must be readable without inner clipping');
  assert.equal(workspace.addLabel.clipped, false, 'Large custom-font Add label must not clip');
  assert.ok(workspace.addLabel.characters.every(character => Math.abs(character.y - workspace.addLabel.characters[0].y) <= 1), 'Large custom-font Add label must keep its characters on one readable line');
  details.largeWorkspace = workspace;
  await capture('workspace-minimum-large-custom-dark');
  await openSettings();
  record('large custom Chinese font stays readable in the minimum native window; all four groups and long-task workspace are captured');
}

async function petAndWindowSettings() {
  await settingsSection('window');
  await switchSetting('settings-open-panel-launch', false, 'openPanelOnLaunch');
  await selectSetting('settings-close-behavior', 'tray', 'closeBehavior');
  await settingsSection('pet');
  details.topMost = [];
  for (const value of [false, true, false]) {
    await switchSetting('settings-pet-always-on-top', value, 'petAlwaysOnTop');
    const native = (await nativeWindows()).find(window => window.page === 'pet.html');
    assert.equal(native.alwaysOnTop, value); details.topMost.push(native);
  }
  await selectSetting('settings-pet-hints', 'always', 'petHints');
  await petPage.mouse.move(-20, -20);
  await petPage.waitForFunction(() => Number(getComputedStyle(document.querySelector('#pet-speech')).opacity) > 0.95 && getComputedStyle(document.querySelector('.pet-controls')).visibility === 'visible');
  await capture('pet-always-visible-custom-dark', petPage);
  await selectSetting('settings-pet-hints', 'hover', 'petHints');
  await petPage.evaluate(() => document.activeElement?.blur());
  await petPage.mouse.move(-20, -20);
  await petPage.waitForFunction(() => !document.querySelector('.pet').matches(':hover'));
  await petPage.waitForFunction(() => getComputedStyle(document.querySelector('#pet-speech')).visibility === 'hidden');
  record('saved always-on-top switch changes the native window; always/hover hint choices change real bubble visibility');
  await selectSetting('settings-pet-hints', 'always', 'petHints');
  await command({ type: 'focus.start', minutes: 1 }); await command({ type: 'focus.pause' });
  details.petLargeText = [];
  for (const percent of [70, 100, 150]) {
    const slider = mainPage.getByTestId('settings-pet-scale');
    await slider.focus(); await slider.press(percent === 150 ? 'End' : 'Home');
    if (percent === 100) {
      for (let value = 70; value < 100; value++) { await slider.press('ArrowRight'); await waitUntil(async () => (await current()).settings.petScale === value + 1, 'real scale keyboard increment'); }
    }
    await waitUntil(async () => (await current()).settings.petScale === percent, `${percent}% setting scale saved`);
    await waitUntil(async () => (await nativeWindows()).find(window => window.page === 'pet.html').bounds.width === Math.round(220 * percent / 100), `${percent}% native pet bounds`);
    await petPage.waitForFunction(() => Number(getComputedStyle(document.querySelector('#pet-speech')).opacity) > 0.95
      && Number(getComputedStyle(document.querySelector('.pet-controls')).opacity) > 0.95);
    await petPage.evaluate(() => { const text = 'MW 今天也可以慢慢来，先做好眼前这一件小事，我会一直陪着你。'; document.querySelector('#pet-speech-text').textContent = text; document.querySelector('#pet-speech').title = text; });
    const value = await petPage.evaluate(() => {
      const measure = selector => { const node = document.querySelector(selector); const r = node.getBoundingClientRect(); const css = getComputedStyle(node);
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
          scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
          opacity: Number(css.opacity), visibility: css.visibility, overflow: css.overflow, clamp: css.webkitLineClamp }; };
      return { viewport: { width: innerWidth, height: innerHeight }, speech: measure('#pet-speech'), text: measure('#pet-speech-text'),
        ball: measure('#pet-ball'), controls: measure('.pet-controls'), open: measure('#pet-open-panel'), timer: measure('#pet-timer') };
    });
    details.petLargeText.push({ percent, value });
    for (const part of ['speech', 'text', 'controls', 'open', 'timer']) {
      const r = value[part]; assert.ok(r.x >= -0.5 && r.y >= -0.5 && r.right <= value.viewport.width + 0.5 && r.bottom <= value.viewport.height + 0.5, `${percent}% large text: ${part} must fit native bounds`);
      assert.ok(r.opacity > 0.95 && r.visibility === 'visible', `${percent}% large text: ${part} must actually appear`);
      if (!['speech', 'text'].includes(part)) assert.ok(r.scrollWidth <= r.clientWidth + 1 && r.scrollHeight <= r.clientHeight + 1, `${percent}% large text: ${part} must not clip its own controls`);
    }
    assert.equal(value.text.clamp, '2'); assert.equal(value.speech.overflow, 'visible');
    assert.ok(value.speech.bottom + 10 * percent / 100 <= value.ball.y, `${percent}% enlarged bubble leaves space above the animated sphere`);
    assert.equal(Number(await mainPage.getByTestId('pet-scale').inputValue()), percent, 'Workspace shortcut must share the saved scale');
    await capture(`pet-${percent}-large-custom-dark-paused`, petPage);
  }
  await command({ type: 'focus.stop' });
  for (const mode of ['gentle', 'static', 'full']) {
    await mainPage.locator(`[data-settings-motion="${mode}"]`).click();
    await waitUntil(async () => (await current()).settings.motionMode === mode, `${mode} motion setting saved`);
    assert.equal(await mainPage.locator(`[data-motion="${mode}"]`).getAttribute('aria-pressed'), 'true', 'Workspace motion shortcut must share the state');
  }
  await application.evaluate(({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    const area = screen.getDisplayMatching(pet.getBounds()).workArea; pet.setPosition(area.x + 40, area.y + 40);
  });
  await delay(450);
  await mainPage.getByTestId('settings-pet-position-reset').click();
  await waitUntil(async () => {
    const position = await application.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
      return { bounds: pet.getBounds(), area: screen.getDisplayMatching(pet.getBounds()).workArea };
    });
    return (await current()).settings.petPosition?.x === position.bounds.x
      && position.area.x + position.area.width - position.bounds.x - position.bounds.width <= 60;
  }, 'reset native position saved');
  details.resetPosition = await application.evaluate(({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    return { bounds: pet.getBounds(), area: screen.getDisplayMatching(pet.getBounds()).workArea };
  });
  const { bounds, area } = details.resetPosition;
  assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
  assert.ok(area.x + area.width - (bounds.x + bounds.width) <= 60 && area.y + area.height - (bounds.y + bounds.height) <= 60, 'Reset places sphere by its current display bottom-right');
  assert.equal((await current()).settings.petScale, 150, 'Resetting position must preserve size');
  record('real settings scale keyboard, shared workspace shortcuts, motion choices and position reset retain large-text pet geometry at 70/100/150%');

  await settingsSection('focus');
  await mainPage.getByTestId('settings-focus-minutes').fill('45');
  await mainPage.getByTestId('settings-focus-minutes').blur();
  await waitUntil(async () => (await current()).settings.focusMinutes === 45, 'default focus setting saved');
  assert.equal(await mainPage.getByTestId('focus-minutes').inputValue(), '45');
  await mainPage.getByTestId('settings-focus-minutes').fill('0'); await mainPage.getByTestId('settings-focus-minutes').blur();
  await delay(200); assert.equal((await current()).settings.focusMinutes, 45, 'Invalid default duration must not replace saved value');
  assert.match(await mainPage.locator('#settings-error').textContent(), /1|180|分钟|时长/u);
  for (const group of ['appearance', 'window', 'pet', 'focus']) {
    await settingsSection(group);
    await assertPersistentSettingsControls(`invalid duration feedback while viewing ${group}`);
  }
  await capture('settings-invalid-duration-persistent-feedback');
  await mainPage.getByTestId('settings-focus-minutes').fill('45'); await mainPage.getByTestId('settings-focus-minutes').blur();
  record('default focus duration synchronizes workspace and rejects invalid UI input without replacing saved value');

  details.trayMenu = await captureTrayMenu();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).close());
  await waitUntil(async () => !(await nativeWindows()).find(window => window.page === 'index.html').visible, 'tray closing strategy hides panel');
  assert.ok(application.process().exitCode === null && (await nativeWindows()).find(window => window.page === 'pet.html').visible);
  await clickTrayOpen();
  record('native close with tray preference keeps the process/pet alive; actual app tray open handler recalls the panel');
}

async function notificationGates() {
  await settingsSection('focus');
  await application.evaluate(({ Notification }) => {
    globalThis.__settingsSmokeNotificationOriginal = { show: Notification.prototype.show, supported: Notification.isSupported, now: Date.now };
    globalThis.__settingsSmokeNotifications = [];
    Notification.prototype.show = function () { globalThis.__settingsSmokeNotifications.push({ title: this.title, body: this.body, silent: this.silent }); };
  });
  details.notifications = [];
  try {
    for (const scenario of [{ enabled: true, supported: true, expected: 1 }, { enabled: false, supported: true, expected: 0 }, { enabled: true, supported: false, expected: 0 }]) {
      await switchSetting('settings-notifications', scenario.enabled, 'notificationsEnabled');
      await application.evaluate(({ Notification }, supported) => { Notification.isSupported = () => supported; globalThis.__settingsSmokeNotifications = []; }, scenario.supported);
      const before = await current();
      await command({ type: 'focus.start', minutes: 1 });
      await application.evaluate(() => { const now = globalThis.__settingsSmokeNotificationOriginal.now; Date.now = () => now() + 70_000; });
      try { await command({ type: 'task.select', taskId: null }); }
      finally { await application.evaluate(() => { Date.now = globalThis.__settingsSmokeNotificationOriginal.now; }); }
      const result = await current();
      const calls = await application.evaluate(() => globalThis.__settingsSmokeNotifications);
      assert.equal(calls.length, scenario.expected, `Notification show gate enabled=${scenario.enabled} supported=${scenario.supported}`);
      assert.equal(result.session, null); assert.equal(result.stats.energy, before.stats.energy + 5); assert.equal(result.stats.focusSessions, before.stats.focusSessions + 1);
      assert.equal(result.lastEvent.kind, 'focus-completed', 'Disabled native notification must retain visual completion event');
      if (calls.length) assert.equal(calls[0].silent, true, 'Focus notifications must be silent');
      details.notifications.push({ ...scenario, calls, energy: result.stats.energy, event: result.lastEvent.kind });
    }
  } finally {
    await application.evaluate(({ Notification }) => { const original = globalThis.__settingsSmokeNotificationOriginal;
      Notification.prototype.show = original.show; Notification.isSupported = original.supported; Date.now = original.now;
      delete globalThis.__settingsSmokeNotificationOriginal; });
  }
  record('real focus-finished commit honors enabled/support notification gates and keeps rewards/visual events; Windows notification display was not invoked');
}

async function resetAndRestart() {
  await settingsSection('appearance');
  const before = await current();
  const assetsBefore = assetFiles();
  await mainPage.getByTestId('settings-reset').click();
  await waitUntil(async () => (await current()).settings.fontFamily === 'system' && (await current()).settings.themeMode === 'system', 'real reset settings UI saved');
  const after = await current();
  for (const field of ['tasks', 'stats', 'decorations', 'selectedTaskId', 'session', 'futureData']) assert.deepEqual(after[field], before[field], `${field} preserved by reset`);
  assert.deepEqual(after.settings.futurePreference, before.settings.futurePreference);
  assert.deepEqual(after.settings.importedFont, before.settings.importedFont);
  assert.deepEqual(after.settings.petPosition, before.settings.petPosition);
  for (const [field, value] of Object.entries(SETTINGS_DEFAULTS)) if (field !== 'importedFont') assert.deepEqual(after.settings[field], value, `${field} resets to its known default`);
  assert.deepEqual(assetFiles(), assetsBefore, 'Reset must not delete or replace managed font assets');
  details.reset = { before: before.settings, after: after.settings, assets: assetsBefore, preservedTaskCount: after.tasks.length, preservedEnergy: after.stats.energy };
  record('real reset UI restores only known preferences and preserves tasks, rewards, decorations, unknown fields, position and imported font assets');

  await settingsSection('appearance'); await setTheme('dark'); await setTextSize('large');
  await selectSetting('settings-font-family', 'custom', 'fontFamily');
  await settingsSection('window'); await switchSetting('settings-open-panel-launch', false, 'openPanelOnLaunch');
  await settingsSection('pet'); await switchSetting('settings-pet-always-on-top', false, 'petAlwaysOnTop');
  await selectSetting('settings-pet-hints', 'always', 'petHints');
  const saved = await current();
  await quitThrough('tray');
  await launch();
  const restored = await current();
  assert.deepEqual(restored.settings, saved.settings);
  for (const field of ['tasks', 'stats', 'decorations', 'futureData']) assert.deepEqual(restored[field], saved[field]);
  const native = await nativeWindows();
  assert.equal(native.find(window => window.page === 'index.html').visible, false, 'Pet-only launch hides the native panel');
  assert.equal(native.find(window => window.page === 'pet.html').visible, true);
  assert.equal(native.find(window => window.page === 'pet.html').alwaysOnTop, false);
  assert.equal((await appearance(mainPage)).fontFamily, 'custom');
  assert.equal((await appearance(mainPage)).fontStatus, 'ready');
  assert.equal((await appearance(petPage)).theme, 'dark');
  details.restart = { settings: restored.settings, windows: native, assets: assetFiles() };
  await capture('pet-only-startup-dark-custom', petPage);
  await clickTrayOpen(); await openSettings();
  record('actual tray quit terminates process; relaunch preserves userData settings/font/data and honors pet-only launch plus native topmost');

  await settingsSection('window'); await selectSetting('settings-close-behavior', 'quit', 'closeBehavior');
  await mainPage.evaluate(() => window.buddy.hidePanel());
  await waitUntil(async () => !(await nativeWindows()).find(window => window.page === 'index.html').visible, 'explicit back-to-desktop hides with quit strategy');
  assert.equal(application.process().exitCode, null);
  await clickTrayOpen(); await quitThrough('close');
  record('explicit back-to-desktop always hides; native close with quit preference terminates the actual app process');
}

async function run() {
  prepareState(); const fonts = prepareFixtures();
  await themesAndNavigation();
  await fontsAndSizes(fonts);
  await petAndWindowSettings();
  await notificationGates();
  await resetAndRestart();
  if (errors.length) throw new Error(`Unexpected renderer errors: ${[...new Set(errors)].join('; ')}`);
}
(async () => {
  let status = 'passed'; let failure = null;
  try { await run(); }
  catch (error) { status = 'failed'; failure = error.stack; process.exitCode = 1; console.error(failure); }
  finally {
    if (application) { try { await restoreDialog(); await closeApplication(); } catch (error) { errors.push(error.message); status = 'failed'; process.exitCode = 1; } }
    for (const moved of renamesToRestore.slice().reverse()) {
      try { restoreRename(moved); } catch (error) { errors.push(error.message); status = 'failed'; process.exitCode = 1; }
    }
    details.testFileMoves = renamesToRestore.map(moved => ({ from: moved.from, preservedBackup: moved.retainedBackup || null,
      originalExists: fs.existsSync(moved.from), backupExists: fs.existsSync(moved.to) }));
    details.finalAssets = assetFiles();
    const report = { status, packagedOnly, directory, dataDirectory, checks, errors: [...new Set(errors)], expectedErrors, screenshots, details, failure };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, 'artifacts', packagedOnly ? 'packaged-settings-smoke.json' : 'settings-smoke.json'), JSON.stringify(report, null, 2));
    console.log(`Settings smoke report: ${path.join(directory, 'report.json')}`);
  }
})();
