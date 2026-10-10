const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const packagedOnly = process.argv.includes('--packaged');
const quick = process.argv.includes('--quick') || !packagedOnly;
const directory = path.join(root, 'artifacts', `interaction-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const dataDirectory = path.join(directory, 'data');
const packageInfo = packagedOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8')) : null;
const environment = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
delete environment.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dataDirectory, { recursive: true });
const checks = [];
const errors = [];
const sequences = [];
const animations = [];
const details = {};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const colorDistance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
let application;
let mainPage;
let petPage;
let nativeCursor;
let originalCursor;

function record(name) { checks.push(name); console.log(`PASS ${name}`); }
class NativeCursor {
  constructor() {
    this.pending = [];
    this.stderr = '';
    const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BuddyCursorSmoke {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    if ($request.command -eq 'quit') { break }
    if ($request.command -eq 'set' -and -not [BuddyCursorSmoke]::SetCursorPos([int]$request.x, [int]$request.y)) { throw 'SetCursorPos failed' }
    $point = New-Object BuddyCursorSmoke+Point
    if (-not [BuddyCursorSmoke]::GetCursorPos([ref]$point)) { throw 'GetCursorPos failed' }
    [Console]::WriteLine((@{ ok = $true; x = $point.X; y = $point.Y } | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
}`;
    this.process = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    readline.createInterface({ input: this.process.stdout }).on('line', line => {
      const pending = this.pending.shift();
      if (!pending) return;
      clearTimeout(pending.timer);
      try { const result = JSON.parse(line); result.ok ? pending.resolve(result) : pending.reject(new Error(result.error)); }
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

async function waitUntil(predicate, name, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(80); }
  throw new Error(`Timed out waiting for ${name}`);
}

async function snapshot(page = petPage, selector = '#pet-ball') {
  return page.evaluate(selector => {
    const target = document.querySelector(selector);
    const character = target.querySelector('svg.buddy-character');
    const body = character.querySelector('[data-buddy-body]');
    const head = body.querySelector('path');
    const fill = head.getAttribute('fill');
    const gradientId = fill?.match(/url\(["']?#([^)'"\s]+)/)?.[1];
    const gradient = gradientId ? character.querySelector(`[id="${gradientId}"]`) : null;
    if (!gradient || gradient.tagName.toLowerCase() !== 'radialgradient') throw new Error('Visible body path must use the sampled radial gradient');
    const stops = [...gradient.querySelectorAll('stop')].map(stop => getComputedStyle(stop).stopColor);
    if (stops.length !== 3) throw new Error('Expected the actual visible body highlight/base/shadow gradient');
    const rgb = stops[1].match(/[\d.]+/g).slice(0, 3).map(Number);
    const silhouette = [...head.getAttribute('d').matchAll(/[ML]\s*([-\d.]+)[,\s]+([-\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    const headMinY = Math.min(...silhouette.map(point => point[1]));
    const headBounds = head.getBBox();
    const headCenterX = headBounds.x + headBounds.width / 2;
    const eyes = [...body.querySelectorAll('[data-buddy-eye]')].map(eye => {
      const transform = eye.getAttribute('transform') || '';
      const translations = [...transform.matchAll(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)/g)];
      let gazeX = null; let gazeY = null;
      if (translations.length > 1) {
        const rowY = headMinY + Math.round((Number(translations[0][2]) - headMinY) / 2) * 2;
        const intersections = [];
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
          gazeY = Number(translations[0][2]) + Number(translations.at(-1)[2]);
        }
      }
      return { transform, d: eye.getAttribute('d'), display: getComputedStyle(eye).display, gazeX, gazeY };
    });
    const bounds = body.getBoundingClientRect();
    const fx = [...target.querySelectorAll('.buddy-fx circle, .buddy-fx path')].map(node => {
      const style = getComputedStyle(node); const geometry = node.getBoundingClientRect();
      return { tag: node.tagName, r: Number(node.getAttribute('r') || 0), stroke: style.stroke, strokeWidth: parseFloat(style.strokeWidth),
        fill: style.fill, opacity: Number(style.opacity), transform: style.transform, width: geometry.width, height: geometry.height };
    });
    return { at: performance.now(), rgb, stops, fill, gradientId,
      bodyTransform: body.getAttribute('transform'), characterTransform: getComputedStyle(character).transform,
      bodyCenter: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, eyes,
      fx, fxSignature: JSON.stringify(fx), interactionCount: Number(target.dataset.interactionCount || 0),
      mode: target.dataset.motionMode, motionActive: target.dataset.motionActive,
      colorActive: target.dataset.colorActive, documentHidden: document.hidden };
  }, selector);
}

function summarize(samples) {
  const colorSteps = samples.slice(1).map((sample, index) => colorDistance(sample.rgb, samples[index].rgb));
  const visibleEyes = samples.flatMap(sample => sample.eyes.filter(eye => eye.display !== 'none' && eye.gazeX !== null));
  const initialY = (samples[0].bodyCenter.y + samples[1].bodyCenter.y) / 2;
  return { count: samples.length, elapsed: samples.at(-1).at - samples[0].at,
    colors: [...new Set(samples.map(sample => sample.rgb.join(',')))], maxColorStep: Math.max(0, ...colorSteps),
    colorTravel: colorSteps.reduce((sum, step) => sum + step, 0),
    colorRange: Math.max(...samples.map(sample => colorDistance(sample.rgb, samples[0].rgb))),
    gazeX: visibleEyes.reduce((sum, eye) => sum + eye.gazeX, 0) / visibleEyes.length,
    gazeY: visibleEyes.reduce((sum, eye) => sum + eye.gazeY, 0) / visibleEyes.length,
    eyeUnique: new Set(samples.map(sample => JSON.stringify(sample.eyes))).size,
    bodyUnique: new Set(samples.map(sample => sample.bodyTransform + sample.characterTransform)).size,
    upwardBounce: initialY - Math.min(...samples.slice(2).map(sample => sample.bodyCenter.y)),
    interactionDelta: samples.at(-1).interactionCount - samples[0].interactionCount,
    fxVisible: Math.max(...samples.map(sample => sample.fx.filter(node => node.opacity > 0.02 && node.width > 0 && node.height > 0).length)),
    fxUnique: new Set(samples.filter(sample => sample.fx.length).map(sample => sample.fxSignature)).size,
    eyeHidden: samples.filter(sample => sample.eyes.some(eye => eye.display === 'none')).length,
    circularOutlineCount: samples.reduce((sum, sample) => sum + sample.fx.filter(node => node.tag === 'circle' && node.r > 20 && node.stroke !== 'none' && node.strokeWidth > 0).length, 0) };
}

async function sequence(name, { count = 16, interval = 120, capture = true, action = null, actionAt = 2 } = {}) {
  const result = { name, samples: [], frames: [] };
  sequences.push(result);
  let actionPromise; let actionError;
  for (let index = 0; index < count; index++) {
    const tick = Date.now();
    if (action && index === actionAt) actionPromise = Promise.resolve().then(action).catch(error => { actionError = error; });
    result.samples.push(await snapshot());
    if (capture) {
      const file = path.join(directory, `${name}-${String(index).padStart(3, '0')}.png`);
      await petPage.screenshot({ path: file, omitBackground: true });
      result.frames.push({ path: file, at: Date.now() });
    }
    if (index < count - 1) await delay(Math.max(0, interval - (Date.now() - tick)));
  }
  if (actionPromise) await actionPromise;
  if (actionError) throw actionError;
  result.summary = summarize(result.samples);
  return result;
}

async function moveCursor(point) {
  const physical = await application.evaluate(({ screen }, point) => screen.dipToScreenPoint(point), point);
  await nativeCursor.request({ command: 'set', x: physical.x, y: physical.y });
  const actual = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());
  assert.ok(Math.hypot(point.x - actual.x, point.y - actual.y) <= 3, 'Native OS cursor must reach the requested real screen location');
  return actual;
}

async function setMode(mode) {
  const response = await mainPage.evaluate(mode => window.buddy.command({ type: 'settings.update', motionMode: mode }), mode);
  assert.equal(response.ok, true, response.error);
  await petPage.waitForFunction(mode => document.querySelector('#pet-ball').dataset.motionMode === mode, mode, { polling: 100 });
  await delay(300);
}

async function focusEvidence() {
  await petPage.getByTestId('pet-open-panel').focus();
  await petPage.keyboard.press('Shift+Tab');
  const evidence = await petPage.evaluate(() => {
    const button = document.querySelector('#pet-ball-button'); const style = getComputedStyle(button); const marker = getComputedStyle(button, '::after');
    return { focused: document.activeElement === button, keyboardFocus: button.matches(':focus-visible'), outline: style.outlineStyle,
      outlineWidth: style.outlineWidth, boxShadow: style.boxShadow,
      marker: { width: parseFloat(marker.width), height: parseFloat(marker.height), opacity: Number(marker.opacity), color: marker.backgroundColor } };
  });
  assert.ok(evidence.focused && evidence.keyboardFocus, 'Real keyboard traversal must focus the ball button');
  assert.ok(evidence.outline === 'none' || parseFloat(evidence.outlineWidth) === 0, 'Ball keyboard focus must not draw a circular outline');
  assert.equal(evidence.boxShadow, 'none');
  assert.equal(evidence.marker.width, 24); assert.equal(evidence.marker.height, 2); assert.equal(evidence.marker.opacity, 1);
  const screenshot = path.join(directory, 'keyboard-focus.png'); await petPage.screenshot({ path: screenshot, omitBackground: true });
  details.keyboardFocus = { ...evidence, screenshot };
  await petPage.getByTestId('pet-open-panel').focus();
  record('keyboard focus uses a visible 24 by 2 line and no orange circular outline');
}

async function run() {
  nativeCursor = new NativeCursor();
  originalCursor = await nativeCursor.request({ command: 'get' });
  application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'), args: packagedOnly ? [] : [root], cwd: root, env: environment, timeout: 45000 });
  const attached = new WeakSet();
  const listen = page => { if (attached.has(page)) return; attached.add(page); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); };
  application.on('window', listen);
  await application.firstWindow();
  await waitUntil(() => application.windows().length === 2, 'both app windows');
  for (const page of application.windows()) { listen(page); await page.waitForLoadState('domcontentloaded'); }
  mainPage = application.windows().find(page => page.url().endsWith('/index.html'));
  petPage = application.windows().find(page => page.url().endsWith('/pet.html'));
  assert.ok(mainPage && petPage);
  await mainPage.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false');
  await petPage.waitForSelector('#pet-ball svg.buddy-character [data-buddy-body]');
  await petPage.evaluate(() => { window.interactionSmokeCursorEvents = 0; window.interactionSmokeCursorOff = window.buddy.onCursor(() => { window.interactionSmokeCursorEvents += 1; }); });
  details.executable = packageInfo?.executable || require('electron');
  details.runtime = await application.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
  details.desktop = await application.evaluate(({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    const display = screen.getPrimaryDisplay(); const area = display.workArea;
    const bounds = pet.getBounds();
    pet.setPosition(Math.round(area.x + (area.width - bounds.width) / 2), Math.round(area.y + (area.height - bounds.height) / 2));
    return { workArea: area, scaleFactor: display.scaleFactor, petBounds: pet.getBounds() };
  });
  await delay(300);
  record('isolated real Electron app loads and a Win32 cursor helper controls the actual system pointer');
  const bounds = details.desktop.petBounds; const area = details.desktop.workArea;
  const ball = await snapshot();
  const farPoint = { x: area.x + 15, y: area.y + 15 };
  const directions = {
    left: { x: bounds.x - 60, y: Math.round(bounds.y + ball.bodyCenter.y) },
    right: { x: bounds.x + bounds.width + 60, y: Math.round(bounds.y + ball.bodyCenter.y) },
    up: { x: Math.round(bounds.x + ball.bodyCenter.x), y: bounds.y - 50 },
    down: { x: Math.round(bounds.x + ball.bodyCenter.x), y: bounds.y + bounds.height + 50 },
    far: farPoint
  };
  details.nativeGaze = {};
  for (const [name, point] of Object.entries(directions)) {
    assert.ok(point.x < bounds.x || point.x > bounds.x + bounds.width || point.y < bounds.y || point.y > bounds.y + bounds.height, 'Gaze test cursor position must be outside the desktop pet window');
    const actual = await moveCursor(point);
    await delay(600);
    const captured = await sequence(`cursor-${name}`, { count: 6, interval: 80 });
    details.nativeGaze[name] = { actualTestCursor: actual, outsideWindow: true, gazeX: captured.summary.gazeX, gazeY: captured.summary.gazeY };
  }
  assert.ok(details.nativeGaze.right.gazeX - details.nativeGaze.left.gazeX > 12, 'Real cursor outside left/right must move actual SVG eyes in the corresponding horizontal directions');
  assert.ok(details.nativeGaze.down.gazeY - details.nativeGaze.up.gazeY > 10, 'Real cursor outside above/below must move actual SVG eyes in the corresponding vertical directions');
  assert.ok(Math.abs(details.nativeGaze.far.gazeX) < 4.5 && Math.abs(details.nativeGaze.far.gazeY) < 2.5, 'Moving the real cursor far away must return actual SVG gaze near its resting centre');
  record('real system cursor outside all four sides moves actual SVG eyes; moving far away returns gaze near centre');
  await focusEvidence();

  const tap = await sequence('tap-no-ring', { count: 22, interval: 95, action: () => petPage.locator('#pet-ball-button').click() });
  assert.ok(tap.summary.interactionDelta > 0 && tap.summary.upwardBounce > 15, 'Single click must preserve actual upward body bounce');
  assert.ok(tap.summary.fxVisible >= 4 && tap.summary.fxUnique >= 4, 'Single click must retain changing visible colored particles');
  assert.equal(tap.summary.circularOutlineCount, 0, 'Click must not generate a large stroked circular ripple');
  const spin = await sequence('spin-no-ring', { count: 34, interval: 95, action: () => petPage.locator('#pet-ball-button').dblclick({ delay: 65 }) });
  assert.ok(spin.summary.interactionDelta > 0 && spin.summary.eyeHidden > 0, 'Double click must retain actual spherical face rotation');
  assert.ok(spin.summary.fxVisible >= 4 && spin.summary.fxUnique >= 4, 'Double click must retain moving visible particles');
  assert.equal(spin.summary.circularOutlineCount, 0);
  const clickedOutline = await petPage.locator('#pet-ball-button').evaluate(button => ({ outline: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth }));
  assert.ok(clickedOutline.outline === 'none' || parseFloat(clickedOutline.width) === 0);
  record('single-click bounce and double-click rotation/particles remain live without a large circle or mouse-focus outline');

  const fullColor = await sequence('autonomous-color', { count: quick ? 31 : 141, interval: quick ? 200 : 300 });
  const incidentalInteraction = fullColor.samples.find(sample => sample.interactionCount !== fullColor.samples[0].interactionCount);
  details.autonomousColorObservation = { uninterruptedWithoutClicksMs: incidentalInteraction ? incidentalInteraction.at - fullColor.samples[0].at : fullColor.summary.elapsed,
    incidentalInteractionDelta: fullColor.summary.interactionDelta,
    note: 'Shared-desktop interaction, if present, is retained in the recording. Autonomous-color evidence uses the initial interval with no new interaction IDs.' };
  assert.ok(details.autonomousColorObservation.uninterruptedWithoutClicksMs >= 5900, 'Actual color must evolve for at least six sampled seconds without new click interactions');
  assert.ok(fullColor.summary.colors.length >= 10 && fullColor.summary.colorRange > 8, 'Actual visible body gradient must change through many intermediate colors without interaction');
  assert.ok(fullColor.summary.maxColorStep < 12, 'Consecutive actual colors must transition smoothly rather than jump between preset tints');
  if (!quick) {
    const first = fullColor.samples[0];
    const returned = fullColor.samples.find(sample => sample.at - first.at >= 30000 && colorDistance(sample.rgb, first.rgb) < 6);
    assert.ok(returned && returned.at - first.at <= 45000, 'Actual visible color must complete its full cycle in the requested 30 to 45 second range');
    assert.ok(fullColor.summary.colorRange > 25, 'A full cycle must visibly explore different pastel colors');
    details.fullColorCycle = { returnedAfterMs: returned.at - first.at, first: first.rgb, returned: returned.rgb };
    record('actual body gradient travels through a full smooth color cycle and returns within 30 to 45 seconds');
  } else record('actual visible body gradient changes continuously through intermediate pastel colors without clicking');

  await setMode('gentle');
  const gentleColor = await sequence('gentle-color', { count: 26, interval: 200 });
  assert.ok(gentleColor.summary.colors.length >= 5 && gentleColor.summary.maxColorStep < 12);
  details.colorRate = { full: fullColor.summary.colorTravel / (fullColor.summary.elapsed / 1000), gentle: gentleColor.summary.colorTravel / (gentleColor.summary.elapsed / 1000) };
  record('gentle mode continues smooth actual body-color movement');
  await setMode('static');
  await delay(150);
  const cursorBeforeStatic = await petPage.evaluate(() => window.interactionSmokeCursorEvents);
  const staticColor = await sequence('static-color-freeze', { count: 10, interval: 110 });
  assert.equal(staticColor.summary.colors.length, 1, 'Static mode must freeze the actual visible body fill');
  assert.equal(staticColor.summary.eyeUnique, 1, 'Static mode must freeze actual eye geometry');
  assert.equal(await petPage.evaluate(() => window.interactionSmokeCursorEvents), cursorBeforeStatic, 'Static mode must stop native cursor delivery');
  const frozenStaticColor = staticColor.samples.at(-1).rgb;
  await mainPage.getByTestId('task-input').fill('静止颜色验证');
  await mainPage.getByTestId('task-add').click();
  await delay(180);
  assert.deepEqual((await snapshot()).rgb, frozenStaticColor, 'Static greeting/face change must retain the actual frozen body color');
  await mainPage.getByTestId('task-complete').first().click();
  await delay(180);
  assert.deepEqual((await snapshot()).rgb, frozenStaticColor, 'Static task-completion face change must retain the actual frozen body color');
  record('static greeting and task-completion face changes preserve the actual frozen gradient');
  await setMode('full');
  const resumeStatic = await sequence('resume-static-color', { count: 16, interval: 140 });
  assert.ok(resumeStatic.summary.colors.length >= 4, 'Returning to full mode must resume actual color evolution');
  assert.ok(colorDistance(frozenStaticColor, resumeStatic.samples[0].rgb) < 5, 'Resuming must keep the previous color phase instead of resetting to the initial tint');
  record('static freezes visible fill and SVG eyes and stops cursor delivery; full resumes the same color phase');

  await mainPage.getByTestId('pet-toggle').click();
  const nativeVisible = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).isVisible());
  await waitUntil(async () => !(await nativeVisible()), 'native desktop pet hidden');
  await petPage.waitForFunction(() => document.querySelector('#pet-ball').dataset.motionActive === 'false', null, { polling: 100 });
  await delay(150);
  const cursorBeforeHide = await petPage.evaluate(() => window.interactionSmokeCursorEvents);
  const hiddenColor = await sequence('hidden-color-freeze', { count: 10, interval: 110, capture: false });
  assert.equal(await nativeVisible(), false);
  assert.equal(hiddenColor.summary.colors.length, 1, 'Hidden native window must freeze actual body gradient');
  assert.equal(hiddenColor.summary.eyeUnique, 1);
  assert.equal(await petPage.evaluate(() => window.interactionSmokeCursorEvents), cursorBeforeHide, 'Hidden window must stop receiving native cursor samples');
  const frozenHiddenColor = hiddenColor.samples.at(-1).rgb;
  await mainPage.getByTestId('pet-toggle').click();
  await waitUntil(nativeVisible, 'native desktop pet recalled');
  const recall = await sequence('recall-color', { count: 20, interval: 120 });
  assert.ok(recall.summary.colors.length >= 4, 'Recall must resume actual color movement');
  assert.ok(colorDistance(frozenHiddenColor, recall.samples[0].rgb) < 5, 'Recall must retain the frozen color phase');
  record('native hide freezes fill and eyes and stops cursor delivery; recall resumes the same color phase');
}

function makeAnimations() {
  const candidates = [process.env.BALL_BUDDY_PYTHON, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'), 'python'].filter(Boolean);
  const python = candidates.find(executable => spawnSync(executable, ['-c', 'import PIL'], { encoding: 'utf8', windowsHide: true }).status === 0);
  if (!python) throw new Error('An existing Pillow runtime is required; no dependency is installed by this script.');
  const records = sequences.filter(sequence => sequence.frames.length > 1).map(sequence => ({ name: sequence.name, frames: sequence.frames, gif: path.join(directory, `${sequence.name}.gif`) }));
  const manifest = path.join(directory, 'recordings.json'); fs.writeFileSync(manifest, JSON.stringify(records, null, 2));
  const program = `import json, sys\nfrom PIL import Image, ImageDraw\nfrom pathlib import Path\nrecords=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))\npreview=[]; timing=[]\nfor recording in records:\n    frames=[]; durations=[]\n    for index,frame in enumerate(recording['frames']):\n        with Image.open(frame['path']) as source:\n            image=Image.new('RGBA',source.size,'#f5f2e9'); image.alpha_composite(source.convert('RGBA')); image=image.convert('RGB')\n        duration=max(60,min(500,recording['frames'][min(index+1,len(recording['frames'])-1)]['at']-frame['at'])) if index+1<len(recording['frames']) else 160\n        frames.append(image); durations.append(duration)\n        if recording['name'].startswith('cursor-') or recording['name'] in ('tap-no-ring','spin-no-ring','autonomous-color'):\n            canvas=Image.new('RGB',(image.width,image.height+28),'#f5f2e9'); canvas.paste(image,(0,28)); ImageDraw.Draw(canvas).text((8,7),recording['name'],fill='#393a36'); preview.append(canvas); timing.append(duration)\n    frames[0].save(recording['gif'],save_all=True,append_images=frames[1:],duration=durations,loop=0,disposal=2,optimize=False)\nif preview: preview[0].save(str(Path(sys.argv[1]).parent/'interaction-preview.gif'),save_all=True,append_images=preview[1:],duration=timing,loop=0,disposal=2,optimize=False)\nprint(json.dumps({'recordings':len(records),'preview_frames':len(preview)}))\n`;
  const result = spawnSync(python, ['-c', program, manifest], { windowsHide: true, encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) throw new Error(`Animation compilation failed: ${result.stderr || result.error?.message}`);
  for (const record of records) animations.push({ name: record.name, path: record.gif, frames: record.frames.length });
  if (fs.existsSync(path.join(directory, 'interaction-preview.gif'))) animations.push({ name: 'interaction-preview', path: path.join(directory, 'interaction-preview.gif') });
  details.recording = JSON.parse(result.stdout.trim());
  record('actual captured SVG performance and color frames are saved as timed animated GIFs');
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
    try { makeAnimations(); } catch (error) { errors.push(error.message); if (!failure) failure = error.stack; status = 'failed'; process.exitCode = 1; }
    const report = { status, packagedOnly, quick, checks, errors: [...new Set(errors)], directory, dataDirectory, details, sequences, animations, failure };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, 'artifacts', packagedOnly ? 'packaged-interaction-smoke.json' : 'interaction-smoke.json'), JSON.stringify(report, null, 2));
    console.log(`Interaction smoke report: ${path.join(directory, 'report.json')}`);
  }
})();
