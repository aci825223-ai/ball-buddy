const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createStudyServer } = require('../server/src/index.cjs');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'artifacts', `ai-study-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(directory, { recursive: true });
const packagedOnly = process.argv.includes('--packaged');
const packageInfo = packagedOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/package.json'), 'utf8')) : null;
const checks = []; const errors = []; const screenshots = []; const details = { limitations: [
  'AI replies come from an explicitly local HTTP/SSE fixture, not a paid vendor request.',
  'Two real isolated Electron clients connect to one real loopback room server; public cross-network reachability was not tested.'
] };
const clients = [];
let fixture; let roomServer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
async function until(predicate, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function bridge(client, method, value) {
  const result = await client.page.evaluate(async ({ method, value }) => window.buddy[method](value), { method, value });
  if (!result?.ok) throw new Error(`${method}: ${result?.error || 'failed'}`);
  return result.data;
}
async function launch(name) {
  const dataDirectory = path.join(directory, name);
  const env = { ...process.env, BALL_BUDDY_SMOKE: '1', BALL_BUDDY_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: packageInfo?.executable || require('electron'),
    args: packagedOnly ? [] : [root], cwd: root, env, timeout: 45000 });
  const listen = page => { page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${name}: ${message.text()}`); }); };
  application.on('window', listen);
  await application.firstWindow();
  await until(async () => application.windows().some(page => page.url().endsWith('/index.html')), 'panel creation');
  const page = application.windows().find(page => page.url().endsWith('/index.html')); listen(page);
  await page.waitForFunction(() => window.buddy && document.querySelector('.workspace')?.getAttribute('aria-busy') === 'false');
  const client = { name, application, page, dataDirectory }; clients.push(client); return client;
}
async function capture(client, name) {
  const file = path.join(directory, `${name}.png`);
  await client.page.screenshot({ path: file, animations: 'disabled' }); screenshots.push({ name, path: file });
}
async function startFixture() {
  const requests = []; details.fixtureRequests = requests;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname });
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(url.pathname.includes('v1beta') ? { models: [{ name: 'models/fixture-model', displayName: '本地接口验证模型' }] }
        : { data: [{ id: 'fixture-model', name: '本地接口验证模型' }] })); return;
    }
    let encoded = ''; for await (const chunk of req) encoded += chunk;
    const body = JSON.parse(encoded);
    if (body.model === 'auth-error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture-secret-not-a-real-key' } })); return; }
    const content = JSON.stringify(body);
    const latestText = body.messages?.filter(message => message.role === 'user').at(-1)?.content
      || body.contents?.at(-1)?.parts?.map(part => part.text || '').join('') || '';
    const isPlan = /steps|步骤|JSON|json/.test(content);
    const answer = isPlan ? JSON.stringify({ steps: [
      { title: '整理要学习的内容', description: '挑选今天的一小节。', minutes: 5 },
      { title: '完成一轮阅读与笔记', description: '记下三个关键点。', minutes: 15 },
      { title: '回顾并安排下一步', description: '确认最想继续的一件事。', minutes: 5 }
    ] }) : '这是本地接口验收回复，用于验证逐字显示。先从一小步开始，我会陪着你。' + (content.includes('long-mode') ? '\n学习记录与长文滚动验证。'.repeat(100) : '');
    const provider = url.pathname.includes('streamGenerateContent') ? 'gemini' : url.pathname.endsWith('/messages') ? 'anthropic' : 'openai';
    const chunks = Array.from(answer).reduce((result, character, index) => { if (index % 5 === 0) result.push(''); result[result.length - 1] += character; return result; }, []);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let closed = false; res.on('close', () => { closed = true; });
    const frame = item => `data: ${JSON.stringify(item)}\n\n`;
    for (const text of chunks) {
      if (closed) break;
      const data = frame(provider === 'openai' ? { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
        : provider === 'anthropic' ? { type: 'content_block_delta', delta: { type: 'text_delta', text } }
        : { candidates: [{ content: { parts: [{ text }] } }] });
      const buffer = Buffer.from(data); res.write(buffer.subarray(0, 12)); res.write(buffer.subarray(12));
      await delay(latestText.includes('slow-mode') ? 120 : content.includes('long-mode') ? 4 : 25);
    }
    if (!closed) {
      res.write(provider === 'openai' ? 'data: [DONE]\n\n' : frame(provider === 'anthropic' ? { type: 'message_stop' }
        : { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

async function run() {
  fixture = await startFixture();
  roomServer = createStudyServer({ host: '127.0.0.1', port: 0, dataDirectory: path.join(directory, 'server-data'), tickMs: 100 });
  const address = await roomServer.start(); details.server = address;
  const first = await launch('alice'); const second = await launch('bob');
  details.executable = packageInfo?.executable || require('electron');
  record('two isolated real Electron clients load the approved application pages');
  await first.page.evaluate(() => { window.__aiSmokeEvents = []; window.buddy.onAiEvent(event => window.__aiSmokeEvents.push(event)); });
  const secret = 'fixture-secret-not-a-real-key';
  let config = await bridge(first, 'saveAiProfile', { name: '本地接口验收', provider: 'openai', baseUrl: `${fixture.baseUrl}/v1`, model: 'fixture-model', key: secret });
  const profileId = config.activeProfileId;
  assert.ok(profileId); assert.equal(config.profiles[0].hasKey, true);
  assert.ok(!JSON.stringify(config).includes(secret));
  assert.ok(!fs.readFileSync(path.join(first.dataDirectory, 'ai', 'config.json'), 'utf8').includes(secret));
  assert.ok(!JSON.stringify(await first.page.evaluate(() => window.buddy.getState())).includes(secret));
  const models = await bridge(first, 'listAiModels', { profileId }); assert.ok(models.some(model => model.id === 'fixture-model'));
  assert.equal((await bridge(first, 'testAiConnection', { profileId })).connected, true);
  record('encrypted credentials stay out of state/IPC snapshots; actual local model listing and test request succeed');
  await exerciseUi(first, profileId);
  for (const provider of ['anthropic', 'gemini']) {
    config = await bridge(first, 'saveAiProfile', { name: `${provider} 本地协议验收`, provider, baseUrl: fixture.baseUrl, model: 'fixture-model', key: secret });
    const chat = await bridge(first, 'createChat', { profileId: config.activeProfileId });
    await bridge(first, 'sendChat', { chatId: chat.id, text: '本地协议验证', profileId: config.activeProfileId });
    await until(async () => (await bridge(first, 'getChat', { chatId: chat.id })).messages.at(-1)?.status === 'complete', `${provider} stream completion`);
  }
  record('all three protocol adapters complete actual HTTP/SSE streams through the Electron main process');
  assert.equal((await bridge(second, 'getAiConfig')).profiles.length, 0);
  assert.equal((await bridge(second, 'listChats')).length, 0);
  record('AI profiles and chat histories remain private to their isolated client');
  await exerciseStudy(first, second, address);
  await first.application.close(); clients.splice(clients.indexOf(first), 1);
  const restarted = await launch('alice');
  assert.ok((await bridge(restarted, 'getAiConfig')).profiles.length >= 3);
  assert.ok((await bridge(restarted, 'listChats')).length >= 3);
  record('AI connection selections, encrypted credential metadata and chats survive a real Electron relaunch');
  assert.deepEqual(errors, []);
}

// UI actions are deliberately kept separate from bridge setup; selectors are
// stable product IDs owned by the renderer implementation.
async function exerciseUi(first, profileId) {
  const page = first.page;
  const saved = (await bridge(first, 'getAiConfig')).profiles.find(item => item.id === profileId);
  await page.locator('#settings-open').click();
  await page.locator('[data-settings-section="ai"]').click();
  await page.locator('#ai-profile-new').click();
  await page.locator('#ai-name').fill('UI连接验收');
  await page.locator('#ai-provider').selectOption('openai');
  await page.locator('#ai-base-url').fill(saved.baseUrl);
  await page.locator('#ai-model').fill('fixture-model');
  await page.locator('#ai-key').fill('fixture-secret-not-a-real-key');
  await page.locator('#ai-profile-save').click();
  await until(async () => (await bridge(first, 'getAiConfig')).profiles.some(item => item.name === 'UI连接验收'), 'profile saved through actual UI');
  assert.equal(await page.locator('#ai-key').inputValue(), '');
  await page.locator('#ai-test').click();
  await until(async () => (await page.locator('#ai-config-status').textContent()).includes('连接测试通过'), 'connection test feedback');
  await capture(first, 'ai-settings-light');
  await page.locator('#settings-back').click();
  record('real AI settings save and test controls clear the key input and show confirmed connection feedback');
  await page.getByTestId('nav-chat').click();
  await page.locator('#chat-input').fill('本地接口验收：给我一句开始学习的建议。');
  await page.locator('#chat-send').click();
  await until(async () => (await bridge(first, 'listChats')).some(chat => chat.id), 'chat created by real send button');
  await until(async () => (await page.locator('#chat-messages').textContent()).includes('这是本地接口验收回复'), 'visible streaming answer');
  const chatId = (await bridge(first, 'listChats'))[0].id;
  await until(async () => (await bridge(first, 'getChat', { chatId })).messages.at(-1)?.status === 'complete', 'chat stream finished');
  await capture(first, 'chat-light');
  const messages = (await bridge(first, 'getChat', { chatId })).messages;
  assert.equal(messages.at(-1).status, 'complete');
  const events = await page.evaluate(() => window.__aiSmokeEvents);
  assert.ok(events.filter(event => event.kind === 'delta').length > 3);
  record('real chat send control shows multiple streamed deltas and the persisted complete reply');
  await page.locator('#chat-input').fill('slow-mode：这是停止生成验收。');
  await page.locator('#chat-send').click();
  await until(async () => await page.locator('#chat-stop').isVisible(), 'stop shown during generation');
  await delay(250); await page.locator('#chat-stop').click();
  await until(async () => (await bridge(first, 'getChat', { chatId })).messages.at(-1)?.status === 'stopped', 'stop preserves partial');
  record('real stop button aborts generation and keeps partial text');
  await page.locator('#chat-input').fill('long-mode：长回复滚动验收。');
  await page.locator('#chat-send').click();
  await until(async () => (await bridge(first, 'getChat', { chatId })).messages.at(-1)?.status === 'complete', 'long reply completes', 20000);
  await until(async () => await page.locator('#chat-messages').evaluate(element => element.scrollHeight > element.clientHeight + 50), 'long reply scrolls inside messages');
  await capture(first, 'chat-long-light');
  record('a long streamed reply scrolls inside the message region');
  await page.getByTestId('nav-desk').click();
  await page.locator('#decompose-open').click();
  await page.locator('#decompose-goal').fill('本地拆解验收：安排25分钟阅读');
  await page.locator('#decompose-generate').click();
  await until(async () => await page.locator('.decompose-step').count() === 3, 'editable task plan');
  await page.locator('.step-title').first().fill('已编辑：先整理阅读材料');
  await page.locator('.decompose-step input[type="checkbox"]').last().uncheck();
  await capture(first, 'plan-light');
  await page.locator('#decompose-add').click();
  await until(async () => (await page.evaluate(() => window.buddy.getState())).tasks.length === 2, 'edited selected plan import');
  assert.ok((await page.evaluate(() => window.buddy.getState())).tasks.some(task => task.title === '已编辑：先整理阅读材料'));
  record('real plan editing and selection import only the two confirmed steps');
  await page.evaluate(() => window.buddy.command({ type: 'settings.update', themeMode: 'dark', textSize: 'large' }));
  await page.getByTestId('nav-chat').click();
  await capture(first, 'chat-dark-large');
  await first.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(880, 680));
  await capture(first, 'chat-minimum-dark-large');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
  details.chatMinimumGeometry = await page.evaluate(() => ({ height: innerHeight, input: document.querySelector('#chat-input').getBoundingClientRect().bottom, send: document.querySelector('#chat-send').getBoundingClientRect().bottom }));
  assert.ok(details.chatMinimumGeometry.send <= details.chatMinimumGeometry.height, 'Minimum-window send button must be visible without page scrolling');
  await page.locator('#chat-history-toggle').click();
  await capture(first, 'chat-history-minimum');
  assert.ok(await page.locator('#chat-send').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), 'History keeps send visible');
  await page.locator('#chat-history-toggle').click();
  await first.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(1040, 780));
  record('chat default/minimum native windows remain horizontally contained with dark theme and large text');
}

async function exerciseStudy(first, second, address) {
  const serverUrl = address.url;
  for (const [client, nickname] of [[first, '同学甲'], [second, '同学乙']]) {
    await client.page.getByTestId('nav-study').click();
    await client.page.locator('#study-nickname').fill(nickname);
    await client.page.locator('#study-server').fill(serverUrl);
    await client.page.locator('#study-config-save').click();
    await until(async () => (await bridge(client, 'getStudyConfig')).nickname === nickname, 'real study config saved');
  }
  await first.page.locator('#study-goal').fill('阅读一小节');
  await first.page.locator('#study-create').click();
  await until(async () => Boolean((await bridge(first, 'getStudyState')).room), 'real room create control');
  const initial = await bridge(first, 'getStudyState'); const code = initial.room.code;
  await second.page.locator('#study-goal').fill('整理笔记');
  await second.page.locator('#study-code').fill(code);
  await second.page.locator('#study-join').click();
  await until(async () => (await bridge(first, 'getStudyState')).room?.members.length === 2, 'two real members');
  await first.page.getByTestId('nav-study').click(); await second.page.getByTestId('nav-study').click();
  await capture(first, 'study-two-members');
  await capture(second, 'study-two-members-light');
  await first.page.locator('#study-message-input').fill('本地共学验收：一起开始吧。');
  await first.page.locator('#study-message-send').click();
  await until(async () => (await bridge(second, 'getStudyState')).room.messages.some(message => message.text.includes('一起开始')), 'room message delivered');
  await second.page.locator('#study-peer-ball').click();
  await until(async () => Boolean((await first.page.evaluate(() => window.buddy.getState())).interaction?.message.includes('同学')), 'greeting in real pet/main state');
  record('real room code connects two clients, delivers shared text and an animated greeting without sharing AI history');
  const frameDirectory = path.join(directory, 'peer-frames'); fs.mkdirSync(frameDirectory);
  const frames = []; const poses = [];
  for (let index = 0; index < 12; index++) {
    const file = path.join(frameDirectory, `${String(index).padStart(3, '0')}.png`);
    const buffer = await first.page.locator('#study-peer-ball').screenshot({ path: file });
    frames.push({ path: file, at: Date.now(), sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    poses.push(await first.page.locator('#study-peer-ball').evaluate(element => [...element.querySelectorAll('path,ellipse,g')].map(node => [node.getAttribute('d'), node.getAttribute('transform'), node.getAttribute('cx'), node.getAttribute('cy')]))) ;
    await delay(70);
  }
  assert.ok(new Set(frames.map(frame => frame.sha256)).size > 3);
  assert.ok(new Set(poses.map(pose => JSON.stringify(pose))).size > 3);
  details.peerAnimation = { frames, distinctPoses: new Set(poses.map(pose => JSON.stringify(pose))).size };
  makePeerAnimation();
  record('twelve real peer-ball PNG/SVG frames prove continuous animation in the two-person room');
  await first.page.locator('#study-ready').click(); await second.page.locator('#study-ready').click();
  await first.page.locator('#study-minutes').fill('1');
  await first.page.locator('#study-start').click();
  await until(async () => (await bridge(second, 'getStudyState')).room?.round?.status === 'running', 'shared round starts');
  const a = await bridge(first, 'getStudyState'); const b = await bridge(second, 'getStudyState');
  assert.equal(a.room.round.id, b.room.round.id); assert.equal(a.room.round.endAt, b.room.round.endAt);
  const personal = await first.page.evaluate(() => window.buddy.command({ type: 'focus.start', minutes: 1, taskId: null }));
  assert.equal(personal.ok, false);
  const forbidden = await second.page.evaluate(() => window.buddy.studyCommand({ type: 'pause' })); assert.equal(forbidden.ok, false);
  await first.page.locator('#study-pause').click();
  await until(async () => (await bridge(second, 'getStudyState')).room.round.status === 'paused', 'shared pause');
  await capture(first, 'study-paused-dark-large');
  await first.page.locator('#study-ready').click(); await second.page.locator('#study-ready').click();
  await first.page.locator('#study-resume').click();
  record('server controls one shared deadline; host authority, preparation and personal-focus mutual exclusion are enforced');
  const bobIdentity = (await bridge(second, 'getStudyState')).selfId;
  await second.application.close(); clients.splice(clients.indexOf(second), 1);
  await until(async () => (await bridge(first, 'getStudyState')).room.round.status === 'paused', 'actual peer process exit pauses round');
  await capture(first, 'study-peer-offline');
  second = await launch('bob');
  await second.page.getByTestId('nav-study').click();
  await second.page.locator('#study-code').fill(code); await second.page.locator('#study-join').click();
  await until(async () => (await bridge(first, 'getStudyState')).room.members.every(member => member.online), 'restarted peer rejoins encrypted identity');
  assert.equal((await bridge(second, 'getStudyState')).selfId, bobIdentity);
  await first.page.locator('#study-ready').click(); await second.page.locator('#study-ready').click(); await first.page.locator('#study-resume').click();
  record('closing and restarting an actual peer process pauses the round and restores its encrypted room identity');
  await delay(250);
  await roomServer.close();
  await until(async () => (await bridge(first, 'getStudyState')).connection === 'reconnecting', 'server stop triggers real reconnect state');
  await first.page.waitForFunction(() => document.querySelector('#study-round-status').textContent === '连接中断，等待重新连接');
  await capture(first, 'study-server-reconnecting');
  await delay(1200);
  roomServer = createStudyServer({ host: address.host, port: address.port, dataDirectory: path.join(directory, 'server-data'), tickMs: 100 });
  await roomServer.start();
  await until(async () => (await bridge(first, 'getStudyState')).connection === 'connected' && (await bridge(second, 'getStudyState')).connection === 'connected', 'two Electron clients automatically reconnect');
  assert.equal((await bridge(first, 'getStudyState')).room.round.status, 'paused');
  assert.equal((await bridge(second, 'getStudyState')).room.round.status, 'paused');
  await first.page.waitForFunction(() => document.querySelector('#study-round-status').textContent.includes('这一轮已暂停'));
  await capture(first, 'study-server-restored-paused');
  await first.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(880, 680));
  await capture(first, 'study-minimum-dark-large');
  details.studyMinimumGeometry = await first.page.evaluate(() => ({ height: innerHeight, ready: document.querySelector('#study-ready').getBoundingClientRect().bottom, resume: document.querySelector('#study-resume').getBoundingClientRect().bottom, send: document.querySelector('#study-message-send').getBoundingClientRect().bottom }));
  assert.ok(details.studyMinimumGeometry.ready <= details.studyMinimumGeometry.height && details.studyMinimumGeometry.resume <= details.studyMinimumGeometry.height, 'Minimum-window shared controls must be visible');
  assert.ok(details.studyMinimumGeometry.send <= details.studyMinimumGeometry.height, 'Minimum-window room message send control must remain visible');
  await first.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(1040, 780));
  await first.page.locator('#study-ready').click(); await second.page.locator('#study-ready').click(); await first.page.locator('#study-resume').click();
  record('a real server restart automatically reconnects both clients and keeps the shared timer paused until both prepare');
  await until(async () => (await first.page.evaluate(() => window.buddy.getState())).stats.focusSessions === 1
    && (await second.page.evaluate(() => window.buddy.getState())).stats.focusSessions === 1, 'one real one-minute shared round completes', 75000);
  for (const client of [first, second]) {
    const state = await client.page.evaluate(() => window.buddy.getState());
    assert.equal(state.stats.energy, 5); assert.equal(state.stats.totalFocusMs, 60000);
  }
  await capture(first, 'study-completed');
  await delay(1000);
  for (const client of [first, second]) assert.equal((await client.page.evaluate(() => window.buddy.getState())).stats.energy, 5);
  record('a real one-minute shared round grants each client exactly one five-energy reward');
  await second.application.close(); clients.splice(clients.indexOf(second), 1); second = await launch('bob');
  await bridge(second, 'connectStudy', { mode: 'join', code });
  await until(async () => (await bridge(first, 'getStudyState')).room.members.every(member => member.online), 'terminal reconnect');
  for (const client of [first, second]) assert.equal((await client.page.evaluate(() => window.buddy.getState())).stats.energy, 5);
  record('terminal receipt replay after a real client restart preserves exactly one reward');
  await first.page.locator('#study-leave').click();
  await until(async () => (await bridge(second, 'getStudyState')).room?.hostId === (await bridge(second, 'getStudyState')).selfId, 'remaining host transfer');
  record('explicit host departure transfers control and leaves personal records intact');
}

function makePeerAnimation() {
  const candidates = [process.env.BALL_BUDDY_PYTHON, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'), 'python'].filter(Boolean);
  const python = candidates.find(candidate => spawnSync(candidate, ['-c', 'import PIL'], { encoding: 'utf8', windowsHide: true }).status === 0);
  if (!python) throw new Error('An existing Pillow runtime is required to encode the actual peer frames.');
  const file = path.join(directory, 'peer-frame-manifest.json'); fs.writeFileSync(file, JSON.stringify(details.peerAnimation.frames));
  const output = path.join(directory, 'study-peer-preview.gif');
  const program = 'import json,sys\nfrom PIL import Image\nfrom pathlib import Path\nr=json.loads(Path(sys.argv[1]).read_text())\nf=[Image.open(x["path"]).convert("RGB") for x in r]\nd=[max(60,min(500,r[i+1]["at"]-x["at"])) if i+1<len(r) else 150 for i,x in enumerate(r)]\nf[0].save(sys.argv[2],save_all=True,append_images=f[1:],duration=d,loop=0,disposal=2,optimize=False)';
  const result = spawnSync(python, ['-c', program, file, output], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) throw new Error(`Peer recording encoding failed: ${result.stderr}`);
  details.peerAnimation.gif = output;
}

(async () => {
  let status = 'passed'; let failure = null;
  try { await run(); } catch (error) { status = 'failed'; failure = error.stack || error.message; console.error(failure); process.exitCode = 1; }
  finally {
    for (const client of clients.splice(0)) try { await client.application.close(); } catch { /* Preserve report. */ }
    if (roomServer) try { await roomServer.close(); } catch (error) { errors.push(error.message); }
    if (fixture) await fixture.close();
    const report = { status, packagedOnly, directory, checks, errors: [...new Set(errors)], screenshots, details, failure };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, 'artifacts', packagedOnly ? 'packaged-ai-study-smoke.json' : 'ai-study-smoke.json'), JSON.stringify(report, null, 2));
    console.log(`AI / study report: ${path.join(directory, 'report.json')}`);
  }
})();
