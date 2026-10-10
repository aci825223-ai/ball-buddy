const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(root, 'artifacts', `motion-${runId}`);
const dataDirectory = path.join(directory, 'data');
const packagedOnly = process.argv.includes('--packaged');
const fromModes = process.argv.includes('--from-modes');
const continuation = process.argv.includes('--continue') || fromModes;
const packageInfo = packagedOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8')) : null;
const environment = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
delete environment.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dataDirectory, { recursive: true });

const checks = [];
const errors = [];
const sequences = [];
const animations = [];
const details = {};
let application;
let mainPage;
let petPage;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function record(name) { checks.push(name); console.log(`PASS ${name}`); }
async function waitUntil(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(70);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function launch() {
  application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'),
    args: packagedOnly ? [] : [root], cwd: root, env: environment, timeout: 45000 });
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
  assert.ok(mainPage && petPage, 'Panel and desktop pet must both load');
  await mainPage.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false');
  await Promise.all([
    mainPage.waitForSelector('#main-ball svg.buddy-character [data-buddy-body]'),
    petPage.waitForSelector('#pet-ball svg.buddy-character [data-buddy-body]')
  ]);
  details.runtime = await application.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
  details.executable = packageInfo?.executable || require('electron');
  details.windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    page: window.webContents.getURL().split('/').pop(), bounds: window.getBounds(), visible: window.isVisible(),
    sandbox: window.webContents.getLastWebPreferences().sandbox,
    contextIsolation: window.webContents.getLastWebPreferences().contextIsolation,
    nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration
  })));
  assert.ok(details.windows.every(window => window.sandbox && window.contextIsolation && !window.nodeIntegration));
  record(packagedOnly ? 'portable executable loads both live SVG characters in isolated data directory' : 'real Electron windows load both live SVG characters in isolated data directory');
}

async function snapshot(page, selector) {
  return page.evaluate(selector => {
    const target = document.querySelector(selector);
    const svg = target?.querySelector('svg.buddy-character');
    const body = svg?.querySelector('[data-buddy-body]');
    if (!target || !svg || !body) throw new Error(`Live character is missing from ${selector}`);
    const nodes = [...body.querySelectorAll('path')];
    const eyes = [...body.querySelectorAll('[data-buddy-eye]')];
    const geometry = body.getBoundingClientRect();
    const attributes = node => [...node.attributes].filter(attribute => ['d', 'transform', 'opacity', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height', 'style', 'points'].includes(attribute.name)).map(attribute => [attribute.name, attribute.value]);
    const fx = target.querySelector('svg.buddy-fx');
    const fxNodes = fx ? [...fx.querySelectorAll('circle, path, rect, polygon, line, ellipse')].map(node => {
      const style = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      let opacity = Number(style.opacity);
      let visible = style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
      for (let parent = node.parentElement; parent && target.contains(parent); parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent);
        opacity *= Number(parentStyle.opacity);
        visible = visible && parentStyle.display !== 'none' && parentStyle.visibility !== 'hidden';
      }
      return { tag: node.tagName, attributes: attributes(node), opacity: style.opacity,
        transform: style.transform, visible: visible && opacity > 0.01 };
    }) : [];
    const bodySignature = JSON.stringify({ transform: body.getAttribute('transform'),
      svgTransform: svg.style.transform, svgComputedTransform: getComputedStyle(svg).transform,
      targetTransform: target.style.transform, targetComputedTransform: getComputedStyle(target).transform,
      paths: nodes.map(node => node.getAttribute('d')) });
    const silhouette = [...(nodes[0]?.getAttribute('d') || '').matchAll(/[ML]\s*([-\d.]+)[,\s]+([-\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    const headMinY = Math.min(...silhouette.map(point => point[1]));
    const headBounds = nodes[0].getBBox();
    const headCenterX = headBounds.x + headBounds.width / 2;
    const eyeValues = eyes.map(node => {
      const transform = node.getAttribute('transform') || '';
      const translations = [...transform.matchAll(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)/g)];
      const translation = translations[0];
      let gazeX = null;
      if (translation && translations.length > 1 && silhouette.length > 3) {
        // Remove the eye-ring centroid's movement during expression morphing before comparing gaze.
        // All values are read from the actual SVG geometry; no private engine state is consulted.
        const rowY = headMinY + Math.round((Number(translation[2]) - headMinY) / 2) * 2;
        const intersections = [];
        for (let index = 0; index < silhouette.length; index++) {
          const start = silhouette[index]; const end = silhouette[(index + 1) % silhouette.length];
          if ((start[1] <= rowY && end[1] >= rowY) || (end[1] <= rowY && start[1] >= rowY)) {
            const fraction = start[1] === end[1] ? 0 : (rowY - start[1]) / (end[1] - start[1]);
            intersections.push(start[0] + (end[0] - start[0]) * fraction);
          }
        }
        if (intersections.length) {
          const minX = Math.min(...intersections); const maxX = Math.max(...intersections);
          const halfWidth = Math.max((maxX - minX) / 2, 12);
          const projected = Math.max(-1, Math.min(1, (Number(translation[1]) - (minX + maxX) / 2) / (halfWidth * 0.985)));
          const expressionAnchorX = -Number(translations.at(-1)[1]);
          gazeX = Math.asin(projected) * halfWidth - (expressionAnchorX - headCenterX);
        }
      }
      return { transform, d: node.getAttribute('d'), display: getComputedStyle(node).display,
        x: translation ? Number(translation[1]) : null, y: translation ? Number(translation[2]) : null, gazeX };
    });
    return { at: performance.now(), bodySignature, eyeSignature: JSON.stringify(eyeValues), eyes: eyeValues,
      bodyGeometry: { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height },
      fxSignature: JSON.stringify(fxNodes), fxNodeCount: fxNodes.length, fxVisibleCount: fxNodes.filter(node => node.visible).length,
      mode: target.dataset.motionMode, active: target.dataset.motionActive,
      interactions: Number(target.dataset.interactionCount || 0), effects: Number(target.dataset.effectCount || 0),
      documentHidden: document.hidden };
  }, selector);
}

function statistics(samples) {
  const range = key => Math.max(...samples.map(sample => sample.bodyGeometry[key])) - Math.min(...samples.map(sample => sample.bodyGeometry[key]));
  const centerY = sample => sample.bodyGeometry.y + sample.bodyGeometry.height / 2;
  const initialCenterY = samples.slice(0, 2).reduce((sum, sample) => sum + centerY(sample), 0) / Math.min(2, samples.length);
  return { samples: samples.length,
    bodyUnique: new Set(samples.map(sample => sample.bodySignature)).size,
    eyeUnique: new Set(samples.map(sample => sample.eyeSignature)).size,
    bodyChangedPairs: samples.slice(1).filter((sample, index) => sample.bodySignature !== samples[index].bodySignature).length,
    eyeHiddenSamples: samples.filter(sample => sample.eyes.some(eye => eye.display === 'none')).length,
    fxUnique: new Set(samples.filter(sample => sample.fxNodeCount).map(sample => sample.fxSignature)).size,
    fxMaxNodes: Math.max(...samples.map(sample => sample.fxNodeCount)),
    fxMaxVisible: Math.max(...samples.map(sample => sample.fxVisibleCount)),
    motionAmplitude: ['x', 'y', 'width', 'height'].reduce((sum, key) => sum + range(key), 0),
    bodyUpwardDisplacement: initialCenterY - Math.min(...samples.slice(2).map(centerY)),
    interactionStart: samples[0].interactions, interactionEnd: samples.at(-1).interactions,
    effectStart: samples[0].effects, effectEnd: samples.at(-1).effects,
    modes: [...new Set(samples.map(sample => sample.mode))], active: [...new Set(samples.map(sample => sample.active))] };
}

async function sampleSequence(name, { count = 16, interval = 110, capture = true, both = false, action = null } = {}) {
  const sequence = { name, interval, startedAt: new Date().toISOString(), pet: [], main: [], frames: [] };
  sequences.push(sequence);
  let actionPromise = null;
  let actionFailure = null;
  for (let index = 0; index < count; index++) {
    const tickStarted = Date.now();
    if (action && index === 2) actionPromise = Promise.resolve().then(action).catch(error => { actionFailure = error; });
    const samples = await Promise.all([snapshot(petPage, '#pet-ball'), ...(both ? [snapshot(mainPage, '#main-ball')] : [])]);
    sequence.pet.push(samples[0]);
    if (both) sequence.main.push(samples[1]);
    if (capture) {
      const file = path.join(directory, `${name}-${String(index).padStart(3, '0')}.png`);
      const bytes = await petPage.screenshot({ path: file, omitBackground: true });
      sequence.frames.push({ path: file, at: Date.now(), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    if (index < count - 1) await delay(Math.max(0, interval - (Date.now() - tickStarted)));
  }
  if (actionPromise) await actionPromise;
  if (actionFailure) throw actionFailure;
  sequence.summary = { pet: statistics(sequence.pet), ...(both ? { main: statistics(sequence.main) } : {}),
    screenshotUnique: new Set(sequence.frames.map(frame => frame.sha256)).size };
  return sequence;
}

function assertContinuous(sequence, both = false) {
  for (const [window, result] of Object.entries(sequence.summary)) {
    if (window === 'screenshotUnique' || (window === 'main' && !both)) continue;
    assert.ok(result.bodyUnique >= 5, `${sequence.name}: ${window} must show at least 5 distinct live SVG body poses; got ${result.bodyUnique}`);
    assert.ok(result.bodyChangedPairs >= Math.floor((result.samples - 1) * 0.6), `${sequence.name}: ${window} body must keep changing across consecutive frames`);
  }
  if (sequence.frames.length) assert.ok(sequence.summary.screenshotUnique >= 5, `${sequence.name}: actual captured pixels must change`);
}

async function command(type, extra = {}) {
  const result = await mainPage.evaluate(command => window.buddy.command(command), { type, ...extra });
  assert.equal(result.ok, true, result.error || `${type} must succeed`);
  return result.state;
}

async function setMotionMode(mode) {
  await command('settings.update', { motionMode: mode });
  await Promise.all([mainPage.waitForFunction(mode => document.querySelector('#main-ball').dataset.motionMode === mode, mode),
    petPage.waitForFunction(mode => document.querySelector('#pet-ball').dataset.motionMode === mode, mode)]);
  await delay(400);
}

async function testGaze(page, selector) {
  const bounds = await page.locator(selector).boundingBox();
  assert.ok(bounds, 'Character must be visible before moving the pointer around it');
  const means = [];
  for (const side of [0.12, 0.88]) {
    await page.mouse.move(bounds.x + bounds.width * side, bounds.y + bounds.height * 0.48);
    await delay(440);
    const samples = [];
    for (let index = 0; index < 5; index++) { samples.push(await snapshot(page, selector)); await delay(60); }
    const values = samples.flatMap(sample => sample.eyes.filter(eye => eye.display !== 'none' && eye.gazeX !== null).map(eye => eye.gazeX));
    assert.ok(values.length, 'Visible eyes must expose real SVG translation relative to their expression anchor');
    means.push(values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  const difference = means[1] - means[0];
  assert.ok(difference > 1, `${selector}: moving the real pointer right must move visible eyes right; observed ${difference.toFixed(3)}`);
  return { means, difference };
}

async function dragBody() {
  const before = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
  const body = await petPage.locator('#pet-ball svg.buddy-character [data-buddy-body]').boundingBox();
  assert.ok(body, 'Character body must be visible to drag');
  const start = { x: body.x + body.width * 0.5, y: body.y + body.height * 0.5 };
  await petPage.mouse.move(start.x, start.y);
  await petPage.mouse.down();
  try {
    for (const displacement of [-18, -36, -54, -72]) {
      const current = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
      // Keep a consistent physical screen path while the dragged native window moves beneath the pointer.
      await petPage.mouse.move(before.x + start.x + displacement - current.x, before.y + start.y - 28 * (-displacement / 72) - current.y);
      await delay(75);
    }
  } finally { await petPage.mouse.up(); }
  await delay(180);
  const after = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
  assert.ok(Math.abs(after.x - before.x) > 15 || Math.abs(after.y - before.y) > 15, 'Dragging the visible body must move actual native BrowserWindow bounds');
  details.drag = { before, after };
}

async function run() {
  await launch();
  assert.equal((await mainPage.evaluate(() => window.buddy.getState())).settings.motionMode, 'full');
  record('new profile defaults to the requested full animation mode');
  await Promise.all([mainPage.emulateMedia({ reducedMotion: 'no-preference' }), petPage.emulateMedia({ reducedMotion: 'no-preference' })]);
  await delay(450);
  if (!continuation) {
  const idle = await sampleSequence('idle', { count: 23, interval: 140, both: true });
  assertContinuous(idle, true);
  record('idle bodies change continuously in both windows and captured pixels show real motion');
  await mainPage.getByTestId('focus-start').click();
  await mainPage.waitForFunction(() => document.querySelector('#focus-status').textContent === '正在专注');
  await delay(450);
  const focusing = await sampleSequence('focus', { both: true });
  assertContinuous(focusing, true);
  await mainPage.getByTestId('focus-pause').click();
  await mainPage.waitForFunction(() => document.querySelector('#focus-status').textContent === '休息一下');
  await delay(450);
  const paused = await sampleSequence('pause', { both: true });
  assertContinuous(paused, true);
  record('focus and paused states both preserve a continuous live SVG performance');
  await mainPage.getByTestId('focus-stop').click();
  await delay(650);
  details.gaze = { pet: await testGaze(petPage, '#pet-ball'), main: await testGaze(mainPage, '#main-ball') };
  record('real pointer movement in each window shifts the SVG eye translations in the matching direction');

  const tap = await sampleSequence('tap', { count: 22, interval: 90,
    action: () => petPage.locator('#pet-ball-button').click() });
  assert.ok(tap.summary.pet.interactionEnd > tap.summary.pet.interactionStart, 'A real single click must dispatch a fresh interaction');
  assert.ok(tap.summary.pet.bodyUpwardDisplacement > 15, 'A click must visibly bounce the body upward by more than 15 actual window pixels');
  assert.ok(tap.summary.pet.fxMaxVisible > 0 && tap.summary.pet.fxUnique >= 3, 'A click must animate actual visible particle geometry');
  record('a real single click produces a larger body bounce and changing SVG particles');

  const spin = await sampleSequence('spin', { count: 33, interval: 90,
    action: () => petPage.locator('#pet-ball-button').dblclick({ delay: 65 }) });
  assert.ok(spin.summary.pet.interactionEnd > spin.summary.pet.interactionStart, 'A real double click must dispatch a fresh interaction');
  assert.ok(spin.summary.pet.eyeUnique >= 10 && spin.summary.pet.eyeHiddenSamples > 0, 'Double click must rotate the actual face around the sphere, including its back side');
  assert.ok(spin.summary.pet.fxMaxVisible > 2 && spin.summary.pet.fxUnique >= 5, 'Double click must animate visible SVG particles');
  record('a real double click rotates the face around the sphere and animates particles');
  }

  if (!fromModes) {
  for (let index = 1; index <= 2; index++) {
    const repeated = await sampleSequence(`repeat-tap-${index}`, { count: 18, interval: 95,
      action: () => petPage.locator('#pet-ball-button').click() });
    assert.ok(repeated.summary.pet.interactionEnd > repeated.summary.pet.interactionStart, 'Repeated click must dispatch another distinct interaction');
    assert.ok(repeated.summary.pet.fxMaxVisible > 0 && repeated.summary.pet.fxUnique >= 3 && repeated.summary.pet.bodyUpwardDisplacement > 15, 'Repeated click must replay the visible upward body bounce and particle effects');
  }
  record('repeated real clicks replay body bounce and particles instead of leaving a stale pose');
  for (let index = 1; index <= 2; index++) {
    await mainPage.getByTestId('task-input').fill(`动态验证任务 ${index}`);
    await mainPage.getByTestId('task-add').click();
    const completed = await sampleSequence(`task-completed-${index}`, { count: 22, interval: 95, both: true,
      action: () => mainPage.getByTestId('task-complete').first().click() });
    for (const window of ['pet', 'main']) {
      assert.ok(completed.summary[window].effectEnd > completed.summary[window].effectStart, `${window}: each task completion must create a fresh effect`);
      assert.ok(completed.summary[window].fxMaxVisible > 2 && completed.summary[window].fxUnique >= 5, `${window}: task completion must move visible confetti geometry`);
    }
  }
  assert.equal((await mainPage.evaluate(() => window.buddy.getState())).stats.energy, 20);
  record('two real task completions independently replay moving confetti in both windows and grant 20 total energy');

  const dragged = await sampleSequence('drag-drop', { count: 24, interval: 95, action: dragBody });
  assert.ok(dragged.summary.pet.interactionEnd > dragged.summary.pet.interactionStart, 'Releasing a drag must dispatch drop feedback');
  assert.ok(dragged.summary.pet.fxMaxVisible > 0 && dragged.summary.pet.fxUnique >= 3, 'Releasing a drag must display changing visible feedback geometry');
  record('dragging the visible body moves native window bounds and releasing it animates feedback');
  }

  await mainPage.getByTestId('pet-toggle').click();
  const nativePetVisible = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).isVisible());
  await waitUntil(async () => !(await nativePetVisible()), 'native pet window hidden');
  await petPage.waitForFunction(() => document.querySelector('#pet-ball').dataset.motionActive === 'false', null, { polling: 100, timeout: 8000 });
  await delay(250);
  const hidden = await sampleSequence('hidden-freeze', { count: 9, interval: 110, capture: false });
  assert.equal(hidden.summary.pet.bodyUnique, 1, 'Hidden character body must stop rendering new poses');
  assert.equal(hidden.summary.pet.eyeUnique, 1, 'Hidden character eyes must stop rendering new poses');
  assert.equal(await nativePetVisible(), false, 'Native pet window must remain hidden throughout the frozen-frame check');
  details.hiddenVisibility = { nativeVisible: false, documentHidden: hidden.pet[0].documentHidden,
    explanation: 'Native window visibility is verified independently because this Electron/CDP runtime can keep document.hidden false after hide().' };
  await mainPage.getByTestId('pet-toggle').click();
  await waitUntil(nativePetVisible, 'native pet window recalled');
  await petPage.waitForFunction(() => document.querySelector('#pet-ball').dataset.motionActive === 'true', null, { polling: 100, timeout: 8000 });
  await delay(350);
  const recalled = await sampleSequence('recalled', { count: 16, interval: 110 });
  assertContinuous(recalled);
  record('native hide freezes SVG bodies and eyes; recall resumes visible changing frames');

  // Allow completion reactions to expire before comparing the three user-selected motion modes.
  await delay(1900);
  await Promise.all([mainPage.mouse.move(3, 3), petPage.mouse.move(3, 3)]);
  await setMotionMode('full');
  const full = await sampleSequence('full-baseline', { count: 28, interval: 125, both: true });
  assertContinuous(full, true);
  await setMotionMode('gentle');
  const gentle = await sampleSequence('gentle', { count: 28, interval: 125, both: true });
  assertContinuous(gentle, true);
  details.motionAmplitude = { full: full.summary.pet.motionAmplitude, gentle: gentle.summary.pet.motionAmplitude };
  assert.ok(gentle.summary.pet.motionAmplitude < full.summary.pet.motionAmplitude * 0.9, 'Gentle mode must visibly reduce the breathing/body movement amplitude');
  record('gentle preference keeps continuous motion with a measurably smaller body movement amplitude');
  await setMotionMode('static');
  const staticSequence = await sampleSequence('static', { count: 10, interval: 110, both: true });
  for (const window of ['pet', 'main']) {
    assert.equal(staticSequence.summary[window].bodyUnique, 1, `${window}: static preference must freeze body poses`);
    assert.equal(staticSequence.summary[window].eyeUnique, 1, `${window}: static preference must freeze eye poses`);
    assert.deepEqual(staticSequence.summary[window].active, ['false']);
  }
  record('static preference freezes both actual SVG bodies and eye poses');
  await Promise.all([mainPage.emulateMedia({ reducedMotion: 'reduce' }), petPage.emulateMedia({ reducedMotion: 'reduce' })]);
  await setMotionMode('full');
  const explicitFull = await sampleSequence('full-overrides-reduced-motion', { count: 18, interval: 110, both: true });
  assertContinuous(explicitFull, true);
  assert.ok(explicitFull.pet.every(sample => sample.active === 'true'));
  assert.ok(explicitFull.main.every(sample => sample.active === 'true'));
  record('explicit full preference stays continuously animated when the system reduced-motion media query is set');
}

function makeAnimations() {
  const candidates = [process.env.BALL_BUDDY_PYTHON,
    path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'), 'python'].filter(Boolean);
  const python = candidates.find(executable => spawnSync(executable, ['-c', 'import PIL'], { windowsHide: true, encoding: 'utf8' }).status === 0);
  if (!python) throw new Error('Pillow runtime is required to compile the recorded PNG frames; set BALL_BUDDY_PYTHON to an existing project/local Python runtime.');
  const recordingManifest = path.join(directory, 'recordings.json');
  fs.writeFileSync(recordingManifest, JSON.stringify(sequences.filter(sequence => sequence.frames.length > 1).map(sequence => ({
    name: sequence.name, frames: sequence.frames, gif: path.join(directory, `${sequence.name}.gif`)
  })), null, 2));
  const program = `import json, sys\nfrom PIL import Image, ImageDraw\nfrom pathlib import Path\nrecordings = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))\npreview = []\npreview_durations = []\nfor recording in recordings:\n    frames = []\n    durations = []\n    for index, frame in enumerate(recording['frames']):\n        with Image.open(frame['path']) as source:\n            image = Image.new('RGBA', source.size, '#f5f2e9')\n            image.alpha_composite(source.convert('RGBA'))\n            image = image.convert('RGB')\n        frames.append(image)\n        next_at = recording['frames'][min(index + 1, len(recording['frames']) - 1)]['at']\n        duration = max(60, min(500, next_at - frame['at'])) if index + 1 < len(recording['frames']) else 160\n        durations.append(duration)\n        if recording['name'] in ('idle', 'tap', 'spin', 'task-completed-1', 'drag-drop'):\n            canvas = Image.new('RGB', (image.width, image.height + 28), '#f5f2e9')\n            canvas.paste(image, (0, 28))\n            ImageDraw.Draw(canvas).text((8, 7), recording['name'], fill='#393a36')\n            preview.append(canvas)\n            preview_durations.append(duration)\n    frames[0].save(recording['gif'], save_all=True, append_images=frames[1:], duration=durations, loop=0, disposal=2, optimize=False)\nif preview:\n    preview[0].save(str(Path(sys.argv[1]).parent / 'motion-preview.gif'), save_all=True, append_images=preview[1:], duration=preview_durations, loop=0, disposal=2, optimize=False)\nprint(json.dumps({'recordings': len(recordings), 'preview_frames': len(preview)}))\n`;
  const result = spawnSync(python, ['-c', program, recordingManifest], { windowsHide: true, encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) throw new Error(`Could not compile recorded animation frames: ${result.stderr || result.error?.message}`);
  for (const sequence of sequences.filter(sequence => sequence.frames.length > 1)) {
    animations.push({ name: sequence.name, path: path.join(directory, `${sequence.name}.gif`), frames: sequence.frames.length });
  }
  const preview = path.join(directory, 'motion-preview.gif');
  if (fs.existsSync(preview)) animations.push({ name: 'motion-preview', path: preview });
  details.recording = { python, ...JSON.parse(result.stdout.trim()) };
  record('actual screenshot sequences are compiled to animated GIFs with captured frame durations');
}

(async () => {
  let status = 'passed';
  let failure = null;
  try {
    await run();
    if (errors.length) throw new Error(`Renderer errors: ${[...new Set(errors)].join('; ')}`);
  } catch (error) { status = 'failed'; failure = error.stack; console.error(failure); process.exitCode = 1; }
  finally {
    // _electron.close only terminates the isolated test application created by this script.
    if (application) { try { await application.close(); } catch (error) { errors.push(`Test application close failed: ${error.message}`); status = 'failed'; process.exitCode = 1; } }
    try { makeAnimations(); } catch (error) { errors.push(error.message); if (!failure) failure = error.stack; status = 'failed'; process.exitCode = 1; }
    const report = { status, packagedOnly, continuation, fromModes, checks, errors: [...new Set(errors)], directory, dataDirectory, details, sequences, animations, failure };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, 'artifacts', packagedOnly ? 'packaged-motion-smoke.json' : continuation ? 'motion-continuation.json' : 'motion-smoke.json'), JSON.stringify(report, null, 2));
    console.log(`Motion smoke report: ${path.join(directory, 'report.json')}`);
  }
})();
