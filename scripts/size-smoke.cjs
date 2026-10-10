const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const packagedOnly = process.argv.includes('--packaged');
const directory = path.join(root, 'artifacts', `size-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const dataDirectory = path.join(directory, 'data');
const packageInfo = packagedOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8')) : null;
const environment = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
delete environment.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dataDirectory, { recursive: true });
const checks = [];
const errors = [];
const screenshots = [];
const sequences = [];
const animations = [];
const details = {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let application;
let mainPage;
let petPage;
let nativeCursor;
let originalCursor;

function record(name) { checks.push(name); console.log(`PASS ${name}`); }
async function waitUntil(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(70); }
  throw new Error(`Timed out waiting for ${label}`);
}

class NativeCursor {
  constructor() {
    this.pending = [];
    this.stderr = '';
    const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BuddySizeCursorSmoke {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    if ($request.command -eq 'quit') { break }
    if ($request.command -eq 'set' -and -not [BuddySizeCursorSmoke]::SetCursorPos([int]$request.x, [int]$request.y)) { throw 'SetCursorPos failed' }
    $point = New-Object BuddySizeCursorSmoke+Point
    if (-not [BuddySizeCursorSmoke]::GetCursorPos([ref]$point)) { throw 'GetCursorPos failed' }
    [Console]::WriteLine((@{ ok = $true; x = $point.X; y = $point.Y } | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
}`;
    this.process = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    readline.createInterface({ input: this.process.stdout }).on('line', line => {
      const pending = this.pending.shift();
      if (!pending) return;
      clearTimeout(pending.timer);
      try { const response = JSON.parse(line); response.ok ? pending.resolve(response) : pending.reject(new Error(response.error)); }
      catch (error) { pending.reject(error); }
    });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', code => this.fail(new Error(`Native cursor helper exited (${code}): ${this.stderr}`)));
  }
  fail(error) { for (const pending of this.pending.splice(0)) { clearTimeout(pending.timer); pending.reject(error); } }
  request(command) {
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: setTimeout(() => reject(new Error(`Native cursor request timed out: ${this.stderr}`)), 15000) };
      this.pending.push(pending);
      this.process.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }
  async close() { this.process.stdin.end(`${JSON.stringify({ command: 'quit' })}\n`); }
}

async function launch() {
  application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'), args: packagedOnly ? [] : [root], cwd: root, env: environment, timeout: 45000 });
  const attached = new WeakSet();
  const listen = page => {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  application.on('window', listen);
  await application.firstWindow();
  await waitUntil(() => application.windows().length === 2, 'both Electron windows');
  for (const page of application.windows()) { listen(page); await page.waitForLoadState('domcontentloaded'); }
  mainPage = application.windows().find(page => page.url().endsWith('/index.html'));
  petPage = application.windows().find(page => page.url().endsWith('/pet.html'));
  assert.ok(mainPage && petPage);
  await mainPage.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false');
  await mainPage.getByTestId('pet-scale').waitFor();
  await petPage.waitForSelector('#pet-ball svg.buddy-character [data-buddy-body]');
  await petPage.evaluate(() => { window.sizeSmokeCursor = null; window.sizeSmokeCursorOff = window.buddy.onCursor(point => { window.sizeSmokeCursor = point; }); });
}
async function current() { return mainPage.evaluate(() => window.buddy.getState()); }
async function bounds() {
  return application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
}
async function centerPet() {
  return application.evaluate(({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    const live = pet.getBounds(); const display = screen.getPrimaryDisplay(); const area = display.workArea;
    pet.setPosition(Math.round(area.x + (area.width - live.width) / 2), Math.round(area.y + (area.height - live.height) / 2));
    return { area, scaleFactor: display.scaleFactor, bounds: pet.getBounds() };
  });
}
async function capture(name, page = petPage, options = {}) {
  const file = path.join(directory, `${name}.png`);
  await page.screenshot({ path: file, omitBackground: page === petPage, ...options });
  screenshots.push({ name, path: file });
  return file;
}
async function revealPet() {
  const ball = await petPage.locator('#pet-ball').boundingBox();
  await petPage.mouse.move(ball.x + ball.width / 2, ball.y + ball.height / 2);
  await petPage.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector('.pet-controls'));
    return style.visibility === 'visible' && Number(style.opacity) > 0.95;
  });
}
async function geometry() {
  return petPage.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector); const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
    };
    return { viewport: { width: innerWidth, height: innerHeight }, ball: rect('#pet-ball'), speech: rect('#pet-speech'), speechText: rect('#pet-speech-text'),
      controls: rect('.pet-controls'), timer: rect('#pet-timer'), open: rect('#pet-open-panel') };
  });
}
async function assertScale(percent) {
  await waitUntil(async () => (await current()).settings.petScale === percent, `persisted ${percent}% preference`);
  await waitUntil(async () => {
    const live = await bounds(); const g = await geometry();
    return live.width === Math.round(220 * percent / 100) && live.height === Math.round(280 * percent / 100)
      && Math.abs(g.ball.width - 160 * percent / 100) < 0.1;
  }, `native and visible ${percent}% size`);
  const output = await mainPage.locator('#pet-scale-value').textContent();
  assert.ok(output.includes(String(percent)), `Size output must visibly show ${percent}`);
  assert.equal(Number(await mainPage.getByTestId('pet-scale').inputValue()), percent);
  return { native: await bounds(), renderer: await geometry(), output };
}
async function setScale(percent) {
  const slider = mainPage.getByTestId('pet-scale');
  await slider.focus();
  await slider.press(percent === 150 ? 'End' : 'Home');
  if (percent !== 150) {
    await waitUntil(async () => (await current()).settings.petScale === 70, 'Home selects 70%');
    for (let value = 70; value < percent; value++) {
      await slider.press('ArrowRight');
      await waitUntil(async () => (await current()).settings.petScale === value + 1, 'keyboard scale step');
    }
  }
  return assertScale(percent);
}
function assertContained(g, label) {
  for (const part of ['speech', 'speechText', 'controls', 'timer', 'open']) {
    const rect = g[part];
    assert.ok(rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= g.viewport.width + 0.5 && rect.bottom <= g.viewport.height + 0.5, `${label}: ${part} must stay inside native content bounds`);
    if (part !== 'speech') assert.ok(rect.scrollWidth <= rect.clientWidth + 1 && rect.scrollHeight <= rect.clientHeight + 1, `${label}: ${part} must not clip its own content`);
  }
}

// Reconstruct the visible eye location from its actual SVG projection, removing
// expression-ring centroid shifts that otherwise resemble gaze movement.
async function snapshot() {
  return petPage.evaluate(() => {
    const target = document.querySelector('#pet-ball'); const character = target.querySelector('svg.buddy-character');
    const body = character.querySelector('[data-buddy-body]'); const head = body.querySelector('path');
    const silhouette = [...head.getAttribute('d').matchAll(/[ML]\s*([-\d.]+)[,\s]+([-\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    const headMinY = Math.min(...silhouette.map(point => point[1])); const headBounds = head.getBBox(); const headCenterX = headBounds.x + headBounds.width / 2;
    const eyes = [...body.querySelectorAll('[data-buddy-eye]')].map(eye => {
      const transform = eye.getAttribute('transform') || ''; const translations = [...transform.matchAll(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)/g)];
      let gazeX = null;
      if (translations.length > 1) {
        const rowY = headMinY + Math.round((Number(translations[0][2]) - headMinY) / 2) * 2; const intersections = [];
        for (let index = 0; index < silhouette.length; index++) {
          const start = silhouette[index]; const end = silhouette[(index + 1) % silhouette.length];
          if ((start[1] <= rowY && end[1] >= rowY) || (end[1] <= rowY && start[1] >= rowY)) {
            const fraction = start[1] === end[1] ? 0 : (rowY - start[1]) / (end[1] - start[1]);
            intersections.push(start[0] + (end[0] - start[0]) * fraction);
          }
        }
        if (intersections.length) {
          const min = Math.min(...intersections); const max = Math.max(...intersections); const half = Math.max((max - min) / 2, 12);
          const projected = Math.max(-1, Math.min(1, (Number(translations[0][1]) - (min + max) / 2) / (half * 0.985)));
          gazeX = Math.asin(projected) * half + Number(translations.at(-1)[1]) + headCenterX;
        }
      }
      return { transform, d: eye.getAttribute('d'), display: getComputedStyle(eye).display, gazeX };
    });
    const r = body.getBoundingClientRect();
    const fx = [...target.querySelectorAll('.buddy-fx circle, .buddy-fx path')].map(node => {
      const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
      return { tag: node.tagName, r: Number(node.getAttribute('r') || 0), stroke: style.stroke, strokeWidth: parseFloat(style.strokeWidth),
        opacity: Number(style.opacity), transform: style.transform, width: rect.width, height: rect.height };
    });
    return { at: performance.now(), bodyTransform: body.getAttribute('transform'), characterTransform: getComputedStyle(character).transform,
      bodyCenter: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, eyes, fx, fxSignature: JSON.stringify(fx),
      interactionCount: Number(target.dataset.interactionCount || 0), color: target.dataset.buddyColor,
      cursor: window.sizeSmokeCursor, gazeTarget: { x: Number(target.dataset.gazeX), y: Number(target.dataset.gazeY), near: target.dataset.cursorNear, source: target.dataset.gazeSource } };
  });
}
function summarize(samples) {
  const eyes = samples.flatMap(sample => sample.eyes.filter(eye => eye.display !== 'none' && eye.gazeX !== null));
  return { elapsed: samples.at(-1).at - samples[0].at,
    gazeX: eyes.reduce((sum, eye) => sum + eye.gazeX, 0) / eyes.length,
    interactionDelta: samples.at(-1).interactionCount - samples[0].interactionCount,
    upwardBounce: (samples[0].bodyCenter.y + samples[1].bodyCenter.y) / 2 - Math.min(...samples.slice(2).map(sample => sample.bodyCenter.y)),
    bodyUnique: new Set(samples.map(sample => sample.bodyTransform + sample.characterTransform)).size,
    eyeHidden: samples.filter(sample => sample.eyes.some(eye => eye.display === 'none')).length,
    fxVisible: Math.max(...samples.map(sample => sample.fx.filter(node => node.opacity > 0.02 && node.width > 0 && node.height > 0).length)),
    fxUnique: new Set(samples.filter(sample => sample.fx.length).map(sample => sample.fxSignature)).size,
    circularOutlineCount: samples.reduce((sum, sample) => sum + sample.fx.filter(node => node.tag === 'circle' && node.r > 20 && node.stroke !== 'none' && node.strokeWidth > 0).length, 0),
    colors: new Set(samples.map(sample => sample.color)).size };
}
async function sequence(name, { count = 20, interval = 85, action = null, actionAt = 2, beforeSample = null, sampleGuard = null, nativeBounds = null } = {}) {
  const result = { name, samples: [], frames: [] }; sequences.push(result);
  let actionPromise; let actionError;
  for (let index = 0; index < count; index++) {
    const tick = Date.now();
    if (beforeSample) await beforeSample();
    if (action && index === actionAt) actionPromise = Promise.resolve().then(action).catch(error => { actionError = error; });
    const withDesktopPoint = sample => ({ ...sample, ...(nativeBounds ? { nativeBounds, actualPoint: sample.cursor ? { x: nativeBounds.x + sample.cursor.x, y: nativeBounds.y + sample.cursor.y } : null } : {}) });
    let sample = withDesktopPoint(await snapshot());
    if (sampleGuard) {
      for (let retry = 0; !sampleGuard(sample) && retry < 6; retry++) {
        result.externalPointerSamples ??= []; result.externalPointerSamples.push(sample);
        if (beforeSample) await beforeSample();
        sample = withDesktopPoint(await snapshot());
      }
      assert.ok(sampleGuard(sample), 'External desktop pointer interference prevented a stable received cursor sample after six reassertion attempts');
    }
    result.samples.push(sample);
    const file = path.join(directory, `${name}-${String(index).padStart(3, '0')}.png`);
    await petPage.screenshot({ path: file, omitBackground: true }); result.frames.push({ path: file, at: Date.now() });
    if (index < count - 1) await delay(Math.max(0, interval - (Date.now() - tick)));
  }
  if (actionPromise) await actionPromise;
  if (actionError) throw actionError;
  result.summary = summarize(result.samples); return result;
}
async function moveCursor(point) {
  const physical = await application.evaluate(({ screen }, point) => screen.dipToScreenPoint(point), point);
  let actual;
  for (let attempt = 0; attempt < 8; attempt++) {
    await nativeCursor.request({ command: 'set', x: physical.x, y: physical.y });
    actual = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());
    if (Math.hypot(point.x - actual.x, point.y - actual.y) <= 3) return actual;
    details.cursorReadbackRetries ??= []; details.cursorReadbackRetries.push({ requested: point, observed: actual });
    await delay(30);
  }
  throw new Error(`External desktop pointer interference prevented an actual cursor readback at ${JSON.stringify(point)}; last observed ${JSON.stringify(actual)}`);
}
async function holdCursor(point, milliseconds) {
  const deadline = Date.now() + milliseconds;
  const observations = [];
  do {
    const observed = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());
    if (Math.hypot(point.x - observed.x, point.y - observed.y) > 3) observations.push(observed);
    await moveCursor(point); await delay(40);
  } while (Date.now() < deadline);
  details.sharedCursor ??= { reassertions: 0, outsideMoves: [] };
  details.sharedCursor.reassertions += 1;
  details.sharedCursor.outsideMoves.push(...observations.slice(0, 10));
}
async function dragBody() {
  const before = await bounds(); const body = await petPage.locator('#pet-ball svg.buddy-character [data-buddy-body]').boundingBox();
  const start = { x: body.x + body.width / 2, y: body.y + body.height / 2 };
  await petPage.mouse.move(start.x, start.y); await petPage.mouse.down();
  try {
    for (const displacement of [-18, -36, -54, -72]) {
      const live = await bounds();
      await petPage.mouse.move(before.x + start.x + displacement - live.x, before.y + start.y + displacement / 3 - live.y); await delay(75);
    }
  } finally { await petPage.mouse.up(); }
  await waitUntil(async () => { const after = await bounds(); return Math.abs(after.x - before.x) > 15 || Math.abs(after.y - before.y) > 15; }, 'native window movement from body drag');
  return { before, after: await bounds() };
}

async function scaledInteraction(percent) {
  const desktop = await centerPet(); await delay(350);
  await moveCursor({ x: desktop.area.x + 12, y: desktop.area.y + 12 }); await delay(400);
  const ball = await snapshot(); const live = await bounds(); const gaze = {};
  details.interactions ??= {}; details.interactions[percent] = { desktop, live, ballCenter: ball.bodyCenter, gaze };
  for (const [side, x] of [['left', live.x - 45 * percent / 100], ['right', live.x + live.width + 45 * percent / 100]]) {
    const point = { x: Math.round(x), y: Math.round(live.y + ball.bodyCenter.y) };
    assert.ok(point.x < live.x || point.x > live.x + live.width, 'Gaze evidence must use the actual mouse outside the scaled native window');
    const actual = await moveCursor(point); await holdCursor(point, 700);
    const correctSide = sample => sample.cursor && sample.gazeTarget.near === 'true'
      && (side === 'left' ? sample.cursor.x < 0 : sample.cursor.x > live.width);
    const result = await sequence(`scale-${percent}-gaze-${side}`, { count: 5, interval: 80, beforeSample: () => holdCursor(point, 100), nativeBounds: live,
      sampleGuard: correctSide });
    for (const sample of result.samples) {
      assert.ok(correctSide(sample), 'Each SVG eye sample must use the actual cursor near the corresponding side outside the native window');
    }
    gaze[side] = { requested: point, actual, gazeX: result.summary.gazeX, firstCursor: result.samples[0].cursor, firstGazeTarget: result.samples[0].gazeTarget, nativeBounds: await bounds() };
  }
  assert.ok(gaze.right.gazeX - gaze.left.gazeX > 12, `${percent}%: actual SVG eyes must look toward the actual OS pointer outside left and right`);
  const farPoint = { x: desktop.area.x + 12, y: desktop.area.y + 12 };
  await moveCursor(farPoint); await holdCursor(farPoint, 700);
  const far = await sequence(`scale-${percent}-gaze-far`, { count: 5, interval: 80, beforeSample: () => holdCursor(farPoint, 100), nativeBounds: live,
    sampleGuard: sample => sample.cursor && sample.gazeTarget.near === 'false'
      && (sample.cursor.x < 0 || sample.cursor.x > live.width || sample.cursor.y < 0 || sample.cursor.y > live.height) });
  assert.ok(Math.abs(far.summary.gazeX) < 4.5, `${percent}%: moving the actual mouse far away must return SVG gaze to its resting centre`);
  await delay(300);
  const tap = await sequence(`scale-${percent}-tap`, { count: 24, action: () => petPage.locator('#pet-ball-button').click() });
  assert.ok(tap.summary.interactionDelta > 0 && tap.summary.upwardBounce > 10 * percent / 100, `${percent}%: actual click must still dispatch interaction and visibly bounce`);
  assert.ok(tap.summary.fxVisible > 0 && tap.summary.fxUnique >= 3, `${percent}%: click must preserve moving colored particles`);
  assert.equal(tap.summary.circularOutlineCount, 0);
  const spin = await sequence(`scale-${percent}-spin`, { count: 35, action: () => petPage.locator('#pet-ball-button').dblclick({ delay: 65 }) });
  assert.ok(spin.summary.interactionDelta > 0 && spin.summary.eyeHidden > 0, `${percent}%: double click must still rotate the face around the sphere`);
  assert.ok(spin.summary.fxVisible > 2 && spin.summary.fxUnique >= 5); assert.equal(spin.summary.circularOutlineCount, 0);
  let drag;
  const drop = await sequence(`scale-${percent}-drag`, { count: 23, action: async () => { drag = await dragBody(); } });
  assert.ok(drop.summary.interactionDelta > 0 && drop.summary.fxUnique >= 3, `${percent}%: scaled body drag must move native bounds and replay drop feedback`);
  assert.ok(tap.summary.bodyUnique > 5 && spin.summary.bodyUnique > 5 && tap.summary.colors > 2, 'Continuous frame samples must retain motion and autonomous body color');
  Object.assign(details.interactions[percent], { farGaze: far.summary.gazeX, drag });
  record(`${percent}% actual click, spin, body drag, outside-window gaze and continuous color/motion pass with recorded SVG frames`);
}

async function run() {
  nativeCursor = new NativeCursor(); originalCursor = await nativeCursor.request({ command: 'get' });
  await launch(); details.executable = packageInfo?.executable || require('electron');
  details.runtime = await application.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
  assert.equal((await current()).settings.petScale, 100); details.default = await assertScale(100);
  await mainPage.locator('[data-motion="gentle"]').click();
  await waitUntil(async () => (await current()).settings.motionMode === 'gentle', 'gentle segmented action');
  assert.equal(await mainPage.locator('[data-motion="gentle"]').getAttribute('aria-pressed'), 'true');
  await mainPage.locator('[data-motion="static"]').click();
  await waitUntil(async () => (await current()).settings.motionMode === 'static', 'static segmented action');
  await mainPage.locator('[data-motion="full"]').click();
  await waitUntil(async () => (await current()).settings.motionMode === 'full', 'full segmented action');
  assert.equal(await mainPage.locator('#motion-mode select').count(), 0);
  await capture('panel-default', mainPage);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(880, 680));
  await mainPage.waitForFunction(() => innerWidth <= 900);
  await capture('panel-minimum', mainPage);
  await capture('panel-minimum-full', mainPage, { fullPage: true });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(1040, 780));
  await mainPage.waitForFunction(() => innerWidth > 1000);
  record('new profile defaults to 100%; three direct motion buttons update saved preference');

  await centerPet(); await delay(350);
  const initial = await bounds(); const expectedCenter = { x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 };
  const slider = mainPage.getByTestId('pet-scale'); const r = await slider.boundingBox();
  await mainPage.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await waitUntil(async () => (await current()).settings.petScale !== 100, 'actual pointer changes the scale slider');
  const pointerScale = (await current()).settings.petScale;
  assert.ok(pointerScale >= 107 && pointerScale <= 113, 'Actual midpoint click should select approximately 110%');
  details.pointerSlider = { scale: pointerScale, ...await assertScale(pointerScale) };
  details.sizes = {};
  for (const percent of [70, 100, 150]) {
    const measured = await setScale(percent); details.sizes[percent] = measured;
    assert.ok(Math.abs(measured.native.x + measured.native.width / 2 - expectedCenter.x) <= 1 && Math.abs(measured.native.y + measured.native.height / 2 - expectedCenter.y) <= 1, `${percent}%: resizing away from edges must preserve the desktop pet centre`);
    await capture(`pet-${percent}-idle`);
  }
  record('actual slider pointer and keyboard control 70/100/150%; native windows and 112/160/240px characters resize together with a fixed centre');

  const settingsBefore = (await current()).settings; const boundsBefore = await bounds(); details.invalidCommands = [];
  for (const invalid of [69, 151, 100.5, '100', null, true, NaN, Infinity]) {
    const response = await mainPage.evaluate(petScale => window.buddy.command({ type: 'settings.update', focusMinutes: 45, motionMode: 'static', petScale }), invalid);
    assert.equal(response.ok, false, `Invalid scale ${String(invalid)} must be rejected`);
    assert.deepEqual((await current()).settings, settingsBefore, 'Invalid scale must atomically reject accompanying duration and motion updates');
    assert.deepEqual(await bounds(), boundsBefore, 'Rejected scale must leave actual native window bounds unchanged');
    details.invalidCommands.push({ input: String(invalid), response });
  }
  record('invalid, noninteger and nonnumeric scale IPC atomically leaves settings and native bounds unchanged');

  await setScale(70);
  const desktop = await centerPet();
  await petPage.evaluate(({ area, width, height }) => window.buddy.movePet({ x: area.x + area.width - width, y: area.y + area.height - height }), { area: desktop.area, width: 154, height: 196 });
  await delay(350);
  const edgeBefore = await bounds(); await setScale(150); const edgeAfter = await bounds();
  const area = desktop.area;
  assert.equal(edgeAfter.x + edgeAfter.width, area.x + area.width); assert.equal(edgeAfter.y + edgeAfter.height, area.y + area.height);
  assert.ok(edgeAfter.x >= area.x && edgeAfter.y >= area.y); details.edgeClamp = { area, before: edgeBefore, after: edgeAfter };
  await capture('pet-150-edge'); record('growing from 70% at the screen edge clamps the entire 150% native window inside its display work area');

  await application.close(); application = null;
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'state.json'), 'utf8'));
  assert.equal(persisted.settings.petScale, 150);
  await launch(); details.restored = await assertScale(150);
  assert.deepEqual(details.restored.native, edgeAfter, 'Relaunch must restore the same scaled native bounds and saved position');
  await mainPage.getByTestId('pet-scale-reset').click(); details.reset = await assertScale(100);
  assert.equal((await current()).settings.motionMode, 'full');
  record('real relaunch restores 150% and position; visible reset returns the whole pet to 100% without changing motion preference');

  await mainPage.getByTestId('focus-start').click(); await mainPage.getByTestId('focus-pause').click();
  await petPage.waitForFunction(() => !document.querySelector('#pet-timer').hidden && document.querySelector('#pet-timer').textContent.startsWith('暂停'));
  details.pausedLayout = {};
  for (const percent of [70, 150]) {
    await setScale(percent);
    // Stress the real speech element with a representative two-line message.
    await petPage.evaluate(() => { document.querySelector('#pet-speech-text').textContent = '把眼前这一件小事做好，慢慢来，我会一直在这里陪着你。'; });
    await revealPet();
    await delay(60); const g = await geometry(); assertContained(g, `${percent}% long speech and paused timer`);
    details.pausedLayout[percent] = g; await capture(`pet-${percent}-long-speech-paused`);
  }
  await mainPage.getByTestId('focus-stop').click();
  record('70% and 150% long speech plus paused timer/footer fit inside the actual native window without clipped text');
  for (const percent of [70, 150]) { await setScale(percent); await scaledInteraction(percent); }
  await mainPage.getByTestId('pet-scale-reset').click(); await assertScale(100); await capture('panel-final', mainPage);
}

function makeAnimations() {
  const candidates = [process.env.BALL_BUDDY_PYTHON, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'), 'python'].filter(Boolean);
  const python = candidates.find(executable => spawnSync(executable, ['-c', 'import PIL'], { encoding: 'utf8', windowsHide: true }).status === 0);
  if (!python) throw new Error('An existing Pillow runtime is required; this script installs no dependency.');
  const recordings = sequences.filter(sequence => sequence.frames.length > 1).map(sequence => ({ name: sequence.name, frames: sequence.frames, gif: path.join(directory, `${sequence.name}.gif`) }));
  const manifest = path.join(directory, 'recordings.json'); fs.writeFileSync(manifest, JSON.stringify(recordings, null, 2));
  const program = `import json,sys\nfrom pathlib import Path\nfrom PIL import Image,ImageDraw\nrecords=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))\npreview=[];times=[]\nfor item in records:\n frames=[];durations=[]\n for index,frame in enumerate(item['frames']):\n  with Image.open(frame['path']) as source:\n   image=Image.new('RGBA',source.size,'#eef6f5');image.alpha_composite(source.convert('RGBA'));image=image.convert('RGB')\n  duration=max(60,min(500,item['frames'][min(index+1,len(item['frames'])-1)]['at']-frame['at'])) if index+1<len(item['frames']) else 150\n  frames.append(image);durations.append(duration)\n  canvas=Image.new('RGB',(330,448),'#eef6f5');canvas.paste(image,((330-image.width)//2,28));ImageDraw.Draw(canvas).text((8,8),item['name'],fill='#183836');preview.append(canvas);times.append(duration)\n frames[0].save(item['gif'],save_all=True,append_images=frames[1:],duration=durations,loop=0,disposal=2,optimize=False)\nif preview:preview[0].save(str(Path(sys.argv[1]).parent/'size-preview.gif'),save_all=True,append_images=preview[1:],duration=times,loop=0,disposal=2,optimize=False)\nprint(json.dumps({'recordings':len(records),'preview_frames':len(preview)}))\n`;
  const result = spawnSync(python, ['-c', program, manifest], { windowsHide: true, encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) throw new Error(`Animation compilation failed: ${result.stderr || result.error?.message}`);
  recordings.forEach(item => animations.push({ name: item.name, path: item.gif, frames: item.frames.length }));
  if (fs.existsSync(path.join(directory, 'size-preview.gif'))) animations.push({ name: 'size-preview', path: path.join(directory, 'size-preview.gif') });
  details.recording = JSON.parse(result.stdout.trim());
  record('timed GIFs preserve real SVG, interaction and native-size frames at both scale extremes');
}

(async () => {
  let status = 'passed'; let failure = null;
  try { await run(); if (errors.length) throw new Error(`Renderer errors: ${[...new Set(errors)].join('; ')}`); }
  catch (error) { status = 'failed'; failure = error.stack; process.exitCode = 1; console.error(failure); }
  finally {
    if (nativeCursor) {
      try { if (originalCursor) await nativeCursor.request({ command: 'set', x: originalCursor.x, y: originalCursor.y }); details.originalCursorRestored = true; }
      catch (error) { errors.push(`Native cursor restoration failed: ${error.message}`); status = 'failed'; process.exitCode = 1; }
      await nativeCursor.close();
    }
    if (application) { try { await application.close(); } catch (error) { errors.push(error.message); status = 'failed'; process.exitCode = 1; } }
    if (sequences.length) { try { makeAnimations(); } catch (error) { errors.push(error.message); failure ??= error.stack; status = 'failed'; process.exitCode = 1; } }
    const report = { status, packagedOnly, checks, errors: [...new Set(errors)], directory, dataDirectory, screenshots, details, sequences, animations, failure };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, 'artifacts', packagedOnly ? 'packaged-size-smoke.json' : 'size-smoke.json'), JSON.stringify(report, null, 2));
    console.log(`Size smoke report: ${path.join(directory, 'report.json')}`);
  }
})();
