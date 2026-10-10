const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const packagedOnly = process.argv.includes('--packaged');
const directory = path.join(root, 'artifacts', `hover-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const dataDirectory = path.join(directory, 'data');
const packageInfo = packagedOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8')) : null;
const environment = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
delete environment.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dataDirectory, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const errors = [];
const screenshots = [];
const sequences = [];
const animations = [];
const details = {};
let application;
let mainPage;
let petPage;
let cursor;
let originalCursor;
let farPoint;

function record(name) { checks.push(name); console.log(`PASS ${name}`); }
async function waitUntil(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
class NativeCursor {
  constructor() {
    this.pending = []; this.stderr = '';
    const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BuddyHoverCursorSmoke {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  public static void LeftClick() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    if ($request.command -eq 'quit') { break }
    if ($request.command -eq 'set' -and -not [BuddyHoverCursorSmoke]::SetCursorPos([int]$request.x, [int]$request.y)) { throw 'SetCursorPos failed' }
    if ($request.command -eq 'click') { [BuddyHoverCursorSmoke]::LeftClick() }
    $point = New-Object BuddyHoverCursorSmoke+Point
    if (-not [BuddyHoverCursorSmoke]::GetCursorPos([ref]$point)) { throw 'GetCursorPos failed' }
    [Console]::WriteLine((@{ ok = $true; x = $point.X; y = $point.Y } | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
}`;
    this.process = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', data => { this.stderr += data.toString(); });
    readline.createInterface({ input: this.process.stdout }).on('line', line => {
      const pending = this.pending.shift(); if (!pending) return; clearTimeout(pending.timer);
      try { const value = JSON.parse(line); value.ok ? pending.resolve(value) : pending.reject(new Error(value.error)); } catch (error) { pending.reject(error); }
    });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', code => this.fail(new Error(`Native cursor helper exited (${code}): ${this.stderr}`)));
  }
  fail(error) { for (const pending of this.pending.splice(0)) { clearTimeout(pending.timer); pending.reject(error); } }
  request(command) {
    return new Promise((resolve, reject) => { const pending = { resolve, reject, timer: setTimeout(() => reject(new Error(`Cursor helper timed out: ${this.stderr}`)), 15000) }; this.pending.push(pending); this.process.stdin.write(`${JSON.stringify(command)}\n`); });
  }
  close() { this.process.stdin.end(`${JSON.stringify({ command: 'quit' })}\n`); }
}
async function moveNative(point) {
  const physical = await application.evaluate(({ screen }, value) => screen.dipToScreenPoint(value), point);
  for (let attempt = 0; attempt < 8; attempt++) {
    await cursor.request({ command: 'set', x: physical.x, y: physical.y });
    const actual = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());
    if (Math.hypot(actual.x - point.x, actual.y - point.y) <= 3) return actual;
    details.externalPointerMoves ??= []; details.externalPointerMoves.push({ requested: point, actual }); await delay(30);
  }
  throw new Error('External desktop pointer movement prevented a stable real cursor placement after eight attempts');
}
async function petBounds() {
  return application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds());
}
async function localPoint(selector, fx = 0.5, fy = 0.5) {
  const rect = await petPage.locator(selector).boundingBox(); const bounds = await petBounds();
  assert.ok(rect, `${selector} must have a real layout box`);
  return { x: Math.round(bounds.x + rect.x + rect.width * fx), y: Math.round(bounds.y + rect.y + rect.height * fy) };
}
async function hoverBall() {
  const point = await localPoint('#pet-ball');
  await moveNative(point);
  await waitUntil(async () => {
    const value = await snapshot();
    if (!value.hovered) { await moveNative(point); return false; }
    return value.speech.opacity > 0.95 && value.controls.opacity > 0.95;
  }, 'real desktop mouse reveals both pet labels');
  return point;
}
async function leavePet() {
  const bounds = await petBounds();
  await petPage.mouse.move(farPoint.x - bounds.x, farPoint.y - bounds.y);
  await moveNative(farPoint);
  await waitUntil(async () => {
    const value = await snapshot();
    if (value.hovered) { await moveNative(farPoint); return false; }
    return true;
  }, 'real desktop mouse leaves the pet');
}
async function capture(name) {
  const file = path.join(directory, `${name}.png`); await petPage.screenshot({ path: file, omitBackground: true }); screenshots.push({ name, path: file }); return file;
}
async function snapshot() {
  const data = await petPage.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const visual = selector => { const node = document.querySelector(selector); const style = getComputedStyle(node); return { ...rect(node), opacity: Number(style.opacity), visibility: style.visibility, pointerEvents: style.pointerEvents, overflow: style.overflow, transitionDelay: style.transitionDelay, transitionDuration: style.transitionDuration, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; };
    const speech = document.querySelector('#pet-speech'); const text = document.querySelector('#pet-speech-text');
    const tail = pseudo => { const style = getComputedStyle(speech, pseudo); return { pseudo, content: style.content, width: style.width, height: style.height, left: style.left, top: style.top, bottom: style.bottom, transform: style.transform, background: style.backgroundColor, border: style.border, opacity: style.opacity }; };
    const ball = document.querySelector('#pet-ball'); const svg = ball.querySelector('svg.buddy-character'); const body = svg.querySelector('[data-buddy-body]');
    const eyes = [...body.querySelectorAll('[data-buddy-eye]')].map(eye => ({ transform: eye.getAttribute('transform'), d: eye.getAttribute('d'), display: getComputedStyle(eye).display }));
    const fx = [...ball.querySelectorAll('.buddy-fx circle, .buddy-fx path')].map(node => { const style = getComputedStyle(node); return { opacity: Number(style.opacity), transform: style.transform, d: node.getAttribute('d'), radius: node.getAttribute('r') }; });
    return { at: performance.now(), hovered: document.querySelector('.pet').matches(':hover'), keyboardReveal: Boolean(document.querySelector('.pet :focus-visible')), activeId: document.activeElement?.id, documentFocused: document.hasFocus(), viewport: { width: innerWidth, height: innerHeight },
      speech: visual('#pet-speech'), controls: visual('.pet-controls'), text: { ...visual('#pet-speech-text'), content: text.textContent, clamp: getComputedStyle(text).webkitLineClamp, lineHeight: getComputedStyle(text).lineHeight },
      tails: [tail('::before'), tail('::after')], ball: visual('#pet-ball'), open: visual('#pet-open-panel'), timer: visual('#pet-timer'),
      title: speech.title, bodyTransform: body.getAttribute('transform'), bodyCenterY: rect(body).y + rect(body).height / 2, eyes, fx, interactionCount: Number(ball.dataset.interactionCount || 0), color: ball.dataset.buddyColor };
  });
  data.nativeBounds = await petBounds();
  data.actualPoint = await application.evaluate(({ screen }) => screen.getCursorScreenPoint());
  return data;
}
function assertHidden(value, label) {
  for (const name of ['speech', 'controls']) {
    assert.equal(value[name].opacity, 0, `${label}: ${name} must be transparent`);
    assert.equal(value[name].visibility, 'hidden', `${label}: ${name} must be hidden`);
    assert.equal(value[name].pointerEvents, 'none', `${label}: ${name} must not intercept mouse input`);
  }
  assert.ok(value.ball.width > 0 && value.ball.visibility === 'visible' && value.ball.opacity > 0.95, `${label}: the real SVG ball stays visible`);
}
function assertRevealed(value, label) {
  for (const name of ['speech', 'controls']) {
    assert.ok(value[name].opacity > 0.95 && value[name].visibility === 'visible' && value[name].pointerEvents !== 'none', `${label}: ${name} must be visible and usable`);
  }
}
async function hiddenAfterLeave(label) {
  await leavePet();
  await waitUntil(async () => { const value = await snapshot(); if (value.hovered) { await moveNative(farPoint); return false; } return value.speech.visibility === 'hidden' && value.controls.visibility === 'hidden'; }, label);
  const value = await snapshot(); assertHidden(value, label); return value;
}
async function sequence(name, { count = 16, interval = 70, action = null, actionAt = 2, keepFar = false } = {}) {
  const result = { name, samples: [], frames: [] }; sequences.push(result); let work; let actionError;
  for (let index = 0; index < count; index++) {
    const tick = Date.now();
    if (action && index === actionAt) work = Promise.resolve().then(action).catch(error => { actionError = error; });
    if (keepFar && index >= actionAt) await moveNative(farPoint);
    const value = await snapshot(); result.samples.push(value);
    const file = path.join(directory, `${name}-${String(index).padStart(3, '0')}.png`); await petPage.screenshot({ path: file, omitBackground: true }); result.frames.push({ path: file, at: Date.now() });
    if (index < count - 1) await delay(Math.max(0, interval - (Date.now() - tick)));
  }
  if (work) await work; if (actionError) throw actionError;
  result.summary = { elapsed: result.samples.at(-1).at - result.samples[0].at, interactionDelta: result.samples.at(-1).interactionCount - result.samples[0].interactionCount,
    bodyUnique: new Set(result.samples.map(value => value.bodyTransform)).size, eyeHidden: result.samples.filter(value => value.eyes.some(eye => eye.display === 'none')).length,
    fxVisible: Math.max(...result.samples.map(value => value.fx.filter(fx => fx.opacity > 0.02).length)), fxUnique: new Set(result.samples.filter(value => value.fx.length).map(value => JSON.stringify(value.fx))).size,
    bounce: (result.samples[0].bodyCenterY + result.samples[1].bodyCenterY) / 2 - Math.min(...result.samples.slice(2).map(value => value.bodyCenterY)) };
  return result;
}
async function command(values) {
  const result = await mainPage.evaluate(values => window.buddy.command(values), values); assert.equal(result.ok, true, result.error); return result.state;
}
async function dragBody() {
  const before = await petBounds(); const rect = await petPage.locator('#pet-ball').boundingBox(); const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await petPage.mouse.move(start.x, start.y); await petPage.mouse.down();
  try { for (const displacement of [-18, -36, -54, -72]) { const live = await petBounds(); await petPage.mouse.move(before.x + start.x + displacement - live.x, before.y + start.y + displacement / 3 - live.y); await delay(60); } }
  finally { await petPage.mouse.up(); }
  await delay(150); const after = await petBounds(); assert.ok(Math.abs(after.x - before.x) > 15 || Math.abs(after.y - before.y) > 15, 'Dragging the real ball must still move native window bounds'); details.drag = { before, after };
}
async function launch() {
  application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'), args: packagedOnly ? [] : [root], cwd: root, env: environment, timeout: 45000 });
  const attached = new WeakSet(); const listen = page => { if (attached.has(page)) return; attached.add(page); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); };
  application.on('window', listen); await application.firstWindow(); await waitUntil(() => application.windows().length === 2, 'both application windows');
  for (const page of application.windows()) { listen(page); await page.waitForLoadState('domcontentloaded'); }
  mainPage = application.windows().find(page => page.url().endsWith('/index.html')); petPage = application.windows().find(page => page.url().endsWith('/pet.html')); assert.ok(mainPage && petPage);
  await mainPage.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false'); await petPage.waitForSelector('#pet-ball svg.buddy-character [data-buddy-body]'); await petPage.locator('#pet-speech-text').waitFor({ state: 'attached' });
  details.executable = packageInfo?.executable || require('electron'); details.runtime = await application.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
  details.desktop = await application.evaluate(({ BrowserWindow, screen }) => { const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')); const b = pet.getBounds(); const area = screen.getPrimaryDisplay().workArea; pet.setPosition(Math.round(area.x + (area.width - b.width) / 2), Math.round(area.y + (area.height - b.height) / 2)); return { area, bounds: pet.getBounds() }; });
  farPoint = { x: details.desktop.area.x + 12, y: details.desktop.area.y + 12 };
}
async function run() {
  cursor = new NativeCursor(); originalCursor = await cursor.request({ command: 'get' });
  await launch(); details.initial = await hiddenAfterLeave('first-load labels hidden'); await capture('initial-ball-only');
  record('real desktop initially shows only the live ball; both labels are hidden and do not intercept pointer input');
  const reveal = await sequence('hover-reveal', { count: 12, action: hoverBall }); assertRevealed(reveal.samples.at(-1), 'native hover reveal'); await capture('hover-bubble-controls');
  record('moving the actual OS pointer onto the ball reveals the rounded speech bubble and controls');
  details.connectedPath = [];
  for (const selector of ['#pet-speech-text', '#pet-ball', '#pet-open-panel']) {
    const point = await localPoint(selector); await moveNative(point); await delay(120); const value = await snapshot(); assert.ok(value.hovered, 'Actual pointer stays over the pet through the bubble/ball/controls path'); assertRevealed(value, selector); details.connectedPath.push({ selector, point, value });
  }
  record('actual pointer can move ball → speech → ball → controls without the two labels disappearing');
  const leave = await sequence('hover-leave', { count: 14, action: leavePet, keepFar: true });
  const outside = leave.samples.filter(value => !value.hovered && !value.keyboardReveal);
  assert.ok(outside.length >= 5, 'Leave recording must contain actual pointer samples outside the pet');
  const firstOutside = outside[0]; const vanished = outside.find(value => value.speech.opacity === 0 && value.controls.visibility === 'hidden');
  assert.ok(firstOutside.speech.opacity > 0.2, 'Labels must remain briefly visible after the actual pointer leaves');
  assert.ok(vanished && vanished.at - firstOutside.at >= 60 && vanished.at - firstOutside.at <= 1100, 'Labels should delay then finish hiding promptly after mouseout');
  assertHidden(leave.samples.at(-1), 'recorded mouseout'); await capture('leave-ball-only'); record('continuous real frames show delayed mouseout fade followed by ball-only display');

  await hoverBall(); await petPage.locator('#pet-ball-button').click();
  details.cdpMouseFocus = await snapshot();
  // Confirm mouse modality through an actual Win32 button click because CDP
  // dispatch can leave a transparent native window unfocused on Windows.
  await hoverBall(); await cursor.request({ command: 'click' }); await delay(100);
  details.nativeMouseFocus = await snapshot();
  await waitUntil(async () => (await snapshot()).activeId === 'pet-ball-button', 'native ordinary mouse click focus');
  details.mouseFocus = await hiddenAfterLeave('ordinary mouse click does not lock labels'); await capture('mouse-focus-leave');
  record('ordinary mouse click focus does not leave the bubble or toolbar permanently visible');

  await leavePet();
  await petPage.locator('#pet-ball-button').focus();
  await petPage.keyboard.press('Tab');
  await waitUntil(async () => { const value = await snapshot(); if (value.hovered) await moveNative(farPoint); return !value.hovered && value.keyboardReveal && value.activeId === 'pet-open-panel' && value.controls.opacity > 0.95; }, 'real keyboard focus reveals controls independently of hover');
  details.keyboardFocus = await snapshot(); assertRevealed(details.keyboardFocus, 'keyboard-only reveal'); assert.equal(details.keyboardFocus.hovered, false); await capture('keyboard-focus-controls');
  await petPage.keyboard.press('Shift+Tab');
  await waitUntil(async () => (await snapshot()).activeId === 'pet-ball-button', 'keyboard returns to ball');
  await hoverBall(); await petPage.locator('#pet-ball-button').click(); await hiddenAfterLeave('mouse modality clears keyboard-only reveal');
  record('actual Tab focus reveals hidden controls with the cursor away and CSS hover cleared; returning to mouse allows hiding');

  await command({ type: 'settings.update', motionMode: 'static' }); await hiddenAfterLeave('static default hidden'); await hoverBall(); assertRevealed(await snapshot(), 'static hover');
  await petPage.emulateMedia({ reducedMotion: 'reduce' }); await hiddenAfterLeave('reduced-motion labels hide'); await hoverBall(); details.reducedMotion = await snapshot(); assertRevealed(details.reducedMotion, 'reduced-motion hover'); await capture('static-reduced-motion-hover');
  await petPage.emulateMedia({ reducedMotion: 'no-preference' }); await command({ type: 'settings.update', motionMode: 'full' });
  record('static and reduced-motion preferences retain usable hover reveal and hide behavior');

  await command({ type: 'focus.start' }); await command({ type: 'focus.pause' });
  await petPage.waitForFunction(() => document.querySelector('#pet-timer').textContent.startsWith('暂停') && !document.querySelector('#pet-timer').hidden);
  details.layouts = {};
  for (const percent of [70, 100, 150]) {
    await command({ type: 'settings.update', petScale: percent }); await waitUntil(async () => (await petBounds()).width === Math.round(220 * percent / 100), `${percent}% native scaled size`);
    await petPage.evaluate(() => { const message = '把眼前这一件小事做好，慢慢来，我会一直在这里陪着你。'; document.querySelector('#pet-speech-text').textContent = message; document.querySelector('#pet-speech').title = message; });
    await hoverBall(); const value = await snapshot(); assertRevealed(value, `${percent}% layout`);
    for (const name of ['speech', 'text', 'controls', 'open', 'timer']) { const r = value[name]; assert.ok(r.x >= -0.5 && r.y >= -0.5 && r.right <= value.viewport.width + 0.5 && r.bottom <= value.viewport.height + 0.5, `${percent}%: ${name} must fit native window`); }
    assert.equal(value.text.clamp, '2', 'Only the inner message is limited to two lines'); assert.equal(value.speech.overflow, 'visible', 'Bubble outer layer must retain its visible tail');
    assert.ok(value.text.scrollHeight <= value.text.clientHeight + 1, 'Representative two-line message must fit without losing text');
    assert.ok(value.speech.bottom + 12 * percent / 100 <= value.ball.y, 'Bubble and tail must reserve space above the live ball');
    assert.ok(value.tails.some(tail => tail.content !== 'none' && tail.content !== 'normal' && (parseFloat(tail.width) > 0 || parseFloat(tail.height) > 0 || tail.border !== '0px none rgb(0, 0, 0)')), 'Visible bubble must expose a real drawn tail');
    details.layouts[percent] = value; await capture(`hover-${percent}-long-speech-paused`);
  }
  await command({ type: 'focus.stop' }); await command({ type: 'settings.update', petScale: 100 });
  record('70/100/150% actual long-message bubble, separate tail and paused toolbar fit without clipping or covering the live ball');

  await mainPage.evaluate(() => window.buddy.hidePanel());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible()), false);
  await hoverBall(); await petPage.getByTestId('pet-open-panel').click();
  await waitUntil(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible()), 'real toolbar opens the native panel');
  record('hovering reveals the usable toolbar and its actual button recalls the hidden native task panel');

  const tap = await sequence('tap-hover', { count: 22, interval: 85, action: () => petPage.locator('#pet-ball-button').click() });
  assert.ok(tap.summary.interactionDelta > 0 && tap.summary.bounce > 15 && tap.summary.fxUnique >= 3, 'Real click must preserve the visible body bounce and moving particles');
  const spin = await sequence('spin-hover', { count: 34, interval: 85, action: () => petPage.locator('#pet-ball-button').dblclick({ delay: 65 }) });
  assert.ok(spin.summary.interactionDelta > 0 && spin.summary.eyeHidden > 0 && spin.summary.fxUnique >= 5, 'Real double click must preserve spherical face rotation and particles');
  const drag = await sequence('drag-hover', { count: 22, interval: 85, action: dragBody }); assert.ok(drag.summary.interactionDelta > 0 && drag.summary.fxUnique >= 3);
  assert.ok(tap.summary.bodyUnique > 5 && spin.summary.bodyUnique > 5, 'Continuous actual SVG frames must remain live through the new hover treatment');
  await hiddenAfterLeave('final hover labels hidden'); await capture('final-ball-only'); record('actual click, double click and native body drag retain continuous SVG motion and effects');
}
function makeAnimations() {
  const candidates = [process.env.BALL_BUDDY_PYTHON, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'), 'python'].filter(Boolean);
  const python = candidates.find(value => spawnSync(value, ['-c', 'import PIL'], { encoding: 'utf8', windowsHide: true }).status === 0); if (!python) throw new Error('An existing Pillow runtime is needed; this script installs no dependency.');
  const records = sequences.filter(value => value.frames.length > 1).map(value => ({ name: value.name, frames: value.frames, gif: path.join(directory, `${value.name}.gif`) }));
  const manifest = path.join(directory, 'recordings.json'); fs.writeFileSync(manifest, JSON.stringify(records, null, 2));
  const program = `import json,sys\nfrom pathlib import Path\nfrom PIL import Image,ImageDraw\nrecords=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'));preview=[];timing=[]\nfor item in records:\n frames=[];durations=[]\n for index,frame in enumerate(item['frames']):\n  with Image.open(frame['path']) as source:\n   image=Image.new('RGBA',source.size,'#eef6f5');image.alpha_composite(source.convert('RGBA'));image=image.convert('RGB')\n  duration=max(60,min(500,item['frames'][min(index+1,len(item['frames'])-1)]['at']-frame['at'])) if index+1<len(item['frames']) else 150\n  frames.append(image);durations.append(duration);canvas=Image.new('RGB',(image.width,image.height+28),'#eef6f5');canvas.paste(image,(0,28));ImageDraw.Draw(canvas).text((8,8),item['name'],fill='#183836');preview.append(canvas);timing.append(duration)\n frames[0].save(item['gif'],save_all=True,append_images=frames[1:],duration=durations,loop=0,disposal=2,optimize=False)\nif preview:preview[0].save(str(Path(sys.argv[1]).parent/'hover-preview.gif'),save_all=True,append_images=preview[1:],duration=timing,loop=0,disposal=2,optimize=False)\nprint(json.dumps({'recordings':len(records),'preview_frames':len(preview)}))\n`;
  const result = spawnSync(python, ['-c', program, manifest], { windowsHide: true, encoding: 'utf8', timeout: 90000 }); if (result.status !== 0) throw new Error(`GIF compilation failed: ${result.stderr || result.error?.message}`);
  records.forEach(value => animations.push({ name: value.name, path: value.gif, frames: value.frames.length })); if (fs.existsSync(path.join(directory, 'hover-preview.gif'))) animations.push({ name: 'hover-preview', path: path.join(directory, 'hover-preview.gif') }); details.recording = JSON.parse(result.stdout.trim()); record('actual reveal, delayed fade and interaction frames are saved as timed GIFs');
}
(async () => {
  let status = 'passed'; let failure = null;
  try { await run(); if (errors.length) throw new Error(`Renderer errors: ${[...new Set(errors)].join('; ')}`); }
  catch (error) { status = 'failed'; failure = error.stack; process.exitCode = 1; console.error(failure); }
  finally {
    if (cursor) { try { if (originalCursor) await cursor.request({ command: 'set', x: originalCursor.x, y: originalCursor.y }); details.originalCursorRestored = true; } catch (error) { errors.push(error.message); status = 'failed'; process.exitCode = 1; } cursor.close(); }
    if (application) { try { await application.close(); } catch (error) { errors.push(error.message); status = 'failed'; process.exitCode = 1; } }
    if (sequences.length) { try { makeAnimations(); } catch (error) { errors.push(error.message); failure ??= error.stack; status = 'failed'; process.exitCode = 1; } }
    const report = { status, packagedOnly, directory, dataDirectory, checks, errors: [...new Set(errors)], screenshots, sequences, animations, details, failure };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(root, 'artifacts', packagedOnly ? 'packaged-hover-smoke.json' : 'hover-smoke.json'), JSON.stringify(report, null, 2)); console.log(`Hover smoke report: ${path.join(directory, 'report.json')}`);
  }
})();
