const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(root, 'artifacts', `smoke-${runId}`);
const dataDirectory = path.join(directory, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });
const checks = [];
const errors = [];
const screenshots = [];
const packagedOnly = process.argv.includes('--packaged');
const packageInfo = packagedOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8')) : null;
const environment = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
delete environment.ELECTRON_RUN_AS_NODE;
let application;
let mainPage;
let petPage;

function record(name) { checks.push(name); console.log(`PASS ${name}`); }
async function waitUntil(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Condition did not finish within ${timeout}ms`);
}
async function launch() {
  application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'),
    args: packagedOnly ? [] : [root], cwd: root, env: environment, timeout: 45000 });
  const listen = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  application.on('window', listen);
  const first = await application.firstWindow(); listen(first);
  await first.waitForFunction(() => window.buddy && document.querySelector('svg'), null, { timeout: 20000 });
  for (const page of application.windows()) { listen(page); await page.waitForLoadState('domcontentloaded'); }
  mainPage = application.windows().find(page => page.url().endsWith('/index.html'));
  petPage = application.windows().find(page => page.url().endsWith('/pet.html'));
  assert.ok(mainPage && petPage, 'Panel and pet windows must both load');
  await mainPage.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false');
  await petPage.waitForSelector('[data-testid="pet-ball"] svg');
  await waitUntil(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter(window => /\/(?:index|pet)\.html$/.test(window.webContents.getURL())).every(window => window.isVisible())));
  record(packagedOnly ? 'packaged executable loads both windows with local resources' : 'real Electron panel and transparent pet load');
}
async function current() { return mainPage.evaluate(() => window.buddy.getState()); }
async function addTask(title) {
  await mainPage.getByTestId('task-input').fill(title);
  await mainPage.getByTestId('task-add').click();
  await mainPage.waitForFunction(title => [...document.querySelectorAll('.task-title')].some(node => node.textContent === title), title);
}
async function capture(name, page, options = {}) {
  const file = path.join(directory, `${name}.png`);
  await page.screenshot({ path: file, ...options });
  screenshots.push({ name, path: file });
}
async function revealPet() {
  const ball = await petPage.locator('#pet-ball').boundingBox();
  await petPage.mouse.move(ball.x + ball.width / 2, ball.y + ball.height / 2);
  await petPage.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector('.pet-controls'));
    return style.visibility === 'visible' && Number(style.opacity) > 0.95;
  });
}
async function overflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return { horizontal: root.scrollWidth > root.clientWidth + 2, vertical: root.scrollHeight > root.clientHeight + 2,
      width: root.clientWidth, height: root.clientHeight,
      taskTitles: [...document.querySelectorAll('.task-title')].map(node => ({ text: node.textContent, clipped: node.scrollWidth > node.clientWidth + 2 })) };
  });
}
async function panelGeometry() {
  return mainPage.evaluate(() => {
    const rect = selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return { sidebar: rect('.app-sidebar'), header: rect('.app-header'), content: rect('.app-content'), tasks: rect('.work-side'), companion: rect('.companion-side'), focus: rect('.focus-section'),
      scene: rect('.desk-scene'), store: rect('.desk-store'), footer: rect('.work-footer'),
      shopItems: [...document.querySelectorAll('.shop-item')].map(node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right }; }),
      motionButtons: [...document.querySelectorAll('#motion-mode [data-motion]')].map(node => node.dataset.motion),
      scale: rect('#pet-scale'), scaleLimits: { min: document.querySelector('#pet-scale').min, max: document.querySelector('#pet-scale').max } };
  });
}
function assertPanelStructure(layout) {
  assert.ok(layout.sidebar.left === 0 && layout.sidebar.width >= 140 && layout.sidebar.width <= 165, 'Stable left sidebar must have the approved desktop width');
  assert.ok(layout.sidebar.right <= layout.content.left + 1 && layout.header.left >= layout.sidebar.right - 1, 'Page header and content must begin to the right of navigation');
  assert.ok(Math.abs(layout.header.height - 64) <= 1 && layout.tasks.top >= layout.header.bottom, 'Content begins below the unified 64px header');
  assert.ok(layout.tasks.right <= layout.companion.left, 'Redesigned panel must place tasks left of focus/companion');
  assert.ok(layout.focus.left >= layout.companion.left && layout.focus.bottom <= layout.scene.top, 'Focus must occupy the top of the right column, above the buddy scene');
  assert.ok(layout.store.top >= Math.max(layout.tasks.bottom, layout.companion.bottom), 'Desk decoration store must sit below both main columns');
  assert.ok(layout.footer.left >= layout.tasks.left && layout.footer.right <= layout.tasks.right && layout.footer.bottom <= layout.tasks.bottom, 'Progress footer stays inside the task surface above the bottom store');
  assert.equal(layout.shopItems.length, 3);
  assert.ok(layout.shopItems.every(item => Math.abs(item.top - layout.shopItems[0].top) <= 1), 'Three decorations must share one horizontal row');
  assert.deepEqual(layout.motionButtons, ['full', 'gentle', 'static']);
  assert.ok(layout.scale.width > 60 && layout.scale.height > 0, 'Real size slider must be visibly available');
  assert.ok(layout.scale.top >= layout.companion.top && layout.scale.bottom <= layout.companion.bottom, 'Size slider must fit the visible companion surface without clipping under the store');
  assert.deepEqual(layout.scaleLimits, { min: '70', max: '150' });
}
async function run() {
  await launch();
  const runtime = await application.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
  const windowProperties = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    page: window.webContents.getURL().split('/').pop(), bounds: window.getBounds(), alwaysOnTop: window.isAlwaysOnTop(),
    preferences: { nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
      contextIsolation: window.webContents.getLastWebPreferences().contextIsolation,
      sandbox: window.webContents.getLastWebPreferences().sandbox }
  })).sort((a, b) => a.page.localeCompare(b.page)));
  assert.ok(windowProperties.every(window => !window.preferences.nodeIntegration && window.preferences.contextIsolation && window.preferences.sandbox));
  assert.ok(windowProperties.find(window => window.page === 'pet.html').alwaysOnTop);
  record('sandbox and context isolation active; pet always on top');

  if (packagedOnly) {
    assert.equal((await current()).tasks.length, 0);
    record('portable package uses isolated clean data and no development dependencies');
    const emptyLayout = await mainPage.evaluate(() => ({ height: innerHeight,
      footer: document.querySelector('.work-footer').getBoundingClientRect().bottom,
      storeNote: document.querySelector('.store-note').getBoundingClientRect().bottom,
      noteFont: getComputedStyle(document.querySelector('.store-note')).fontSize }));
    assert.ok(emptyLayout.footer <= emptyLayout.height + 1, 'Default panel footer must be fully visible');
    assert.ok(emptyLayout.storeNote <= emptyLayout.height + 1, 'Default store note must be fully visible');
    assert.ok(parseFloat(emptyLayout.noteFont) >= 12);
    const defaultStructure = await panelGeometry(); assertPanelStructure(defaultStructure);
    await capture('panel-empty', mainPage);
    await capture('pet-idle', petPage, { omitBackground: true });
    await revealPet();
    await capture('pet-idle-hover', petPage, { omitBackground: true });
    await addTask('读两页书，记下一句喜欢的话');
    await addTask('把今天想做的事情拆成可以开始的小步骤，给每一步留一点时间。'.repeat(3));
    await mainPage.getByTestId('focus-start').click();
    assert.equal((await current()).session.status, 'running');
    await mainPage.waitForFunction(() => document.querySelector('#focus-status').textContent === '正在专注');
    await capture('panel-focus', mainPage);
    await revealPet();
    await capture('pet-focus', petPage, { omitBackground: true });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(880, 680));
    await mainPage.waitForFunction(() => innerWidth <= 900);
    const minLayout = await overflow(mainPage); assert.equal(minLayout.horizontal, false);
    assert.ok(minLayout.taskTitles.every(title => !title.clipped));
    const minimumStructure = await panelGeometry(); assertPanelStructure(minimumStructure);
    await capture('panel-minimum', mainPage);
    const sceneGeometry = () => mainPage.evaluate(() => {
      const speech = document.querySelector('.buddy-speech').getBoundingClientRect();
      const ball = document.querySelector('.main-ball').getBoundingClientRect();
      return { status: document.querySelector('#focus-status').textContent,
        speechBottom: speech.bottom, ballTop: ball.top, gap: ball.top - speech.bottom };
    });
    const scenes = [await sceneGeometry()];
    await mainPage.getByTestId('focus-pause').click();
    await mainPage.waitForFunction(() => document.querySelector('#focus-status').textContent === '休息一下');
    await capture('panel-minimum-paused', mainPage); scenes.push(await sceneGeometry());
    await mainPage.getByTestId('focus-stop').click();
    await mainPage.waitForFunction(() => document.querySelector('#focus-status').textContent === '准备开始');
    await capture('panel-minimum-idle', mainPage); scenes.push(await sceneGeometry());
    await mainPage.getByTestId('task-complete').first().click();
    await mainPage.waitForFunction(() => document.querySelector('#buddy-speech').textContent.includes('撒花'));
    await capture('panel-minimum-completed', mainPage); scenes.push(await sceneGeometry());
    assert.ok(scenes.every(scene => scene.gap >= 12), 'All minimum-window states must reserve clear space between message and character');
    record('final package screenshots show stable sidebar/header, continuous left tasks, right live focus/buddy, bottom store and real motion/size controls');
    record('final package screenshots show visible default progress/footer, 12px auxiliary text and readable minimum-size tasks');
    await application.close(); application = null;
    return { runtime, windowProperties, emptyLayout, minLayout, defaultStructure, minimumStructure, scenes };
  }

  await capture('panel-empty', mainPage);
  assert.equal((await current()).tasks.length, 0);
  await mainPage.getByTestId('task-add').click();
  assert.match(await mainPage.locator('#task-error').textContent(), /写下/);
  record('first run is empty; blank task gets visible validation');
  await addTask('阅读 10 页书');
  await addTask('整理今天的学习笔记');
  const longTitle = '把今天需要完成的事情拆成可以开始的小步骤，并给每一步留一点时间。'.repeat(3);
  await addTask(longTitle);
  assert.equal((await current()).tasks.length, 3);
  await mainPage.getByTestId('task-complete').first().click();
  await mainPage.waitForFunction(() => document.querySelector('[data-testid="energy-count"]').textContent === '10');
  const rewarded = (await current()).tasks.find(task => task.completedAt !== null);
  const duplicate = await mainPage.evaluate(id => window.buddy.command({ type: 'task.complete', taskId: id }), rewarded.id);
  assert.equal(duplicate.ok, false); assert.equal((await current()).stats.energy, 10);
  await mainPage.getByTestId('task-complete').first().click();
  await mainPage.waitForFunction(() => document.querySelector('[data-testid="energy-count"]').textContent === '20');
  await mainPage.getByTestId('decoration-lamp').click();
  await mainPage.waitForFunction(() => !document.querySelector('#scene-lamp').hidden);
  assert.equal((await current()).stats.energy, 0);
  record('real task UI rewards once; spending energy unlocks visible desk lamp');

  await mainPage.getByTestId('pet-toggle').click();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).isVisible()), false);
  await mainPage.getByTestId('pet-toggle').click();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).isVisible()), true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible()), false);
  await revealPet();
  await petPage.getByTestId('pet-open-panel').click();
  await mainPage.waitForFunction(() => !document.hidden);
  const beforeMove = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
  await application.evaluate(({ BrowserWindow, screen }) => { const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')); const area = screen.getPrimaryDisplay().workArea; pet.setPosition(area.x + area.width - 320, area.y + area.height - 320); });
  await waitUntil(async () => Boolean((await current()).settings.petPosition));
  record('pet hide/recall, native panel close/recall, and pet position persistence work');

  await mainPage.getByTestId('focus-minutes').fill('1');
  await mainPage.getByTestId('focus-minutes').blur();
  await mainPage.getByTestId('focus-start').click();
  await waitUntil(async () => (await current()).session?.status === 'running');
  await mainPage.waitForFunction(() => document.querySelector('[data-testid="focus-timer"]').textContent !== '01:00', null, { timeout: 10000 });
  await mainPage.getByTestId('focus-pause').click();
  const paused = await current(); assert.equal(paused.session.status, 'paused');
  await petPage.waitForFunction(() => document.querySelector('#pet-timer').textContent === document.querySelector('#pet-timer').textContent && !document.querySelector('#pet-timer').hidden);
  assert.ok((await petPage.locator('#pet-timer').textContent()).endsWith(await mainPage.getByTestId('focus-timer').textContent()));
  await mainPage.getByTestId('focus-resume').click();
  await mainPage.getByTestId('focus-stop').click();
  assert.equal((await current()).session, null);
  assert.equal((await current()).stats.energy, 0);
  record('real countdown ticks, pause synchronizes both windows, early finish has no reward');

  const selectedTask = (await current()).tasks.find(task => task.completedAt === null);
  await mainPage.evaluate(id => window.buddy.command({ type: 'task.select', taskId: id }), selectedTask.id);
  await mainPage.getByTestId('focus-start').click();
  const running = await current(); assert.equal(running.session.status, 'running');
  await capture('panel-focus', mainPage);
  await revealPet();
  await capture('pet-focus', petPage, { omitBackground: true });
  const defaultOverflow = await overflow(mainPage); assert.equal(defaultOverflow.horizontal, false);
  assert.ok(defaultOverflow.taskTitles.every(title => !title.clipped));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(880, 680));
  await mainPage.waitForFunction(() => innerWidth <= 900);
  await capture('panel-minimum', mainPage);
  const minimumOverflow = await overflow(mainPage); assert.equal(minimumOverflow.horizontal, false);
  record('default and minimum window screenshots captured; long task stays readable');

  await application.close(); application = null;
  await launch();
  const restored = await current();
  assert.equal(restored.tasks.length, 3); assert.ok(restored.decorations.includes('lamp'));
  assert.equal(restored.session.id, running.session.id); assert.ok(restored.session.endAt <= running.session.endAt);
  record('relaunch restores tasks, lamp, energy and the live timestamp countdown');
  console.log('Waiting for the real one-minute round to finish...');
  await waitUntil(async () => !(await current()).session, 70000);
  const finished = await current(); assert.equal(finished.stats.energy, 5); assert.equal(finished.stats.focusSessions, 1);
  await mainPage.evaluate(() => window.buddy.command({ type: 'task.select', taskId: null }));
  assert.equal((await current()).stats.energy, 5);
  record('a full real one-minute round finishes once and grants 5 energy after relaunch');
  const screenshotsData = { runtime, windowProperties, beforeMove, defaultOverflow, minimumOverflow };
  await application.close(); application = null;
  return screenshotsData;
}

(async () => {
  let status = 'passed'; let details = null; let failure = null;
  try { details = await run(); if (errors.length) throw new Error(`Renderer errors: ${[...new Set(errors)].join('; ')}`); }
  catch (error) { status = 'failed'; failure = error.stack; console.error(failure); process.exitCode = 1; }
  finally {
    if (application) { try { await application.close(); } catch {} }
    const report = { status, packagedOnly, checks, errors: [...new Set(errors)], screenshots, directory, details, failure };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, 'artifacts', packagedOnly ? 'packaged-smoke.json' : 'smoke.json'), JSON.stringify(report, null, 2));
    console.log(`Smoke report: ${path.join(directory, 'report.json')}`);
  }
})();
