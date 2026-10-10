const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, Notification, nativeTheme, dialog, safeStorage, net } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createInitialState, normalizeState, applyCommand, applyImportedFont, applyStudyReceipt, reconcileState } = require('../shared/state.cjs');
const { createStorage } = require('./storage.cjs');
const { createFontManager } = require('./fonts.cjs');
const { createAiService } = require('./ai-service.cjs');
const { createStudyClient } = require('./study-client.cjs');

const root = path.resolve(__dirname, '../..');
const smoke = process.env.BALL_BUDDY_SMOKE === '1';
if (smoke && process.env.BALL_BUDDY_DATA_DIR) app.setPath('userData', process.env.BALL_BUDDY_DATA_DIR);
app.setName('小球同桌');
app.setAppUserModelId('local.ballbuddy.desktop');
let panel;
let pet;
let tray;
let state;
let storage;
let storageNotice = null;
let interaction = null;
let quitting = false;
let petVisible = true;
let heartbeat;
let moveTimer;
let cursorTimer;
let petResizeCenter;
let expectedPetBounds;
let fonts;
let fontDialogOpen = false;
let fontRevision = 0;
let ai;
let study;
let aiPresence = null;
const activeAiRequests = new Set();

const singleInstance = smoke || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => showPanel());
  app.whenReady().then(start).catch(() => { app.exit(1); });
}

function snapshot() {
  return { ...state, app: { petVisible,
    panelVisible: Boolean(panel && !panel.isDestroyed() && panel.isVisible()), storageNotice,
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', version: app.getVersion(),
    notificationsSupported: Notification.isSupported(), fontRevision, aiPresence,
    study: petStudyState() }, interaction };
}

function petStudyState() {
  const value = study?.getStudyState();
  if (!value) return null;
  const room = value.room;
  return { connection: value.connection, selfId: value.selfId, serverOffsetMs: value.serverOffsetMs,
    room: room ? { code: room.code, hostId: room.hostId, members: room.members,
      round: room.round, greeting: room.greeting } : null };
}

function activeStudyRound() {
  const value = study?.getStudyState();
  return ['running', 'paused'].includes(value?.room?.round?.status)
    || Boolean(value?.room?.members?.find(member => member.id === value.selfId)?.ready);
}

function extensionInteraction(message, emotion = '10') {
  interaction = { id: `extension_${randomUUID()}`, at: Date.now(), emotion, message };
  broadcast();
}

function panelBackground() { return nativeTheme.shouldUseDarkColors ? '#171719' : '#f5f5f7'; }

function applyNativePreferences() {
  if (nativeTheme.themeSource !== state.settings.themeMode) nativeTheme.themeSource = state.settings.themeMode;
  if (panel && !panel.isDestroyed()) panel.setBackgroundColor(panelBackground());
  if (pet && !pet.isDestroyed() && pet.isAlwaysOnTop() !== state.settings.petAlwaysOnTop) {
    pet.setAlwaysOnTop(state.settings.petAlwaysOnTop);
    // Windows floating windows are placed behind the taskbar by Electron. A
    // non-topmost taskbar can demote them; use the supported higher level only
    // when the requested preference did not actually take effect.
    if (process.platform === 'win32' && state.settings.petAlwaysOnTop && !pet.isAlwaysOnTop()) {
      pet.setAlwaysOnTop(true, 'pop-up-menu');
    }
  }
}

function broadcast() {
  for (const window of [panel, pet]) {
    if (window && !window.isDestroyed()) window.webContents.send('buddy:state', snapshot());
  }
}

function samplePetCursor() {
  if (quitting || !pet || pet.isDestroyed() || !petVisible || !pet.isVisible()
      || state.settings.motionMode === 'static' || pet.webContents.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = pet.getBounds();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (Number.isFinite(x) && Number.isFinite(y)) pet.webContents.send('buddy:cursor', { x, y });
}

function persist(nextState) {
  try {
    storage.save(nextState);
    storageNotice = null;
    return true;
  } catch {
    storageNotice = '记录暂时无法保存，请检查磁盘空间或目录权限后重试。';
    return false;
  }
}

function commit(result, { keepPetPosition = false, refreshFont = false } = {}) {
  let nextState = result.state;
  let resizedBounds = null;
  let resizedCenter = null;
  if (nextState.settings.petScale !== state.settings.petScale && pet && !pet.isDestroyed()) {
    const currentBounds = pet.getBounds();
    // Retain the unrounded center so repeated 1% steps cannot accumulate pixel shifts.
    const center = petResizeCenter && sameBounds(currentBounds, expectedPetBounds)
      ? petResizeCenter : boundsCenter(currentBounds);
    const dimensions = getPetDimensions(nextState.settings);
    const desiredPosition = keepPetPosition ? { x: currentBounds.x, y: currentBounds.y }
      : { x: center.x - dimensions.width / 2, y: center.y - dimensions.height / 2 };
    const position = constrainPosition(desiredPosition, dimensions);
    resizedBounds = { ...position, ...dimensions };
    const clamped = Math.abs(position.x - desiredPosition.x) > 0.5 || Math.abs(position.y - desiredPosition.y) > 0.5;
    resizedCenter = keepPetPosition || clamped ? boundsCenter(resizedBounds) : center;
    nextState = { ...nextState, settings: { ...nextState.settings, petPosition: position } };
  }
  if (nextState !== state && !persist(nextState)) throw new Error(storageNotice);
  state = nextState;
  if (refreshFont) fontRevision += 1;
  if (resizedBounds) {
    clearTimeout(moveTimer);
    petResizeCenter = resizedCenter;
    expectedPetBounds = resizedBounds;
    pet.setBounds(resizedBounds);
  }
  applyNativePreferences();
  broadcast();
  for (const effect of result.effects || []) {
    if (effect.type === 'focus-finished' && state.settings.notificationsEnabled && Notification.isSupported()) {
      new Notification({ title: '这一轮完成了', body: effect.message || '辛苦了，和小球一起休息一下。', silent: true }).show();
    }
  }
}

function trusted(event) {
  return [panel, pet].some(window => window && !window.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
}

function registerIpc() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Unavailable sender');
    return callback(...args);
  });
  handle('buddy:get-state', () => snapshot());
  handle('buddy:command', command => {
    try {
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('操作格式不正确。');
      if (command.type === 'pet.play') {
        const action = command.action === undefined ? 'tap' : command.action;
        const reactions = {
          tap: { emotion: '10', message: '好啦，我陪着你。' },
          spin: { emotion: '30', message: '转一圈，和你打个招呼。' },
          drop: { emotion: '03', message: '稳稳落地，继续陪着你。' }
        };
        if (typeof action !== 'string' || !Object.hasOwn(reactions, action)) throw new Error('不支持这个互动动作。');
        interaction = { ...reactions[action], effect: action, id: `interaction_${randomUUID()}`, at: Date.now() };
        broadcast();
      } else {
        if (['focus.start', 'focus.resume'].includes(command.type) && activeStudyRound()) {
          throw new Error('你正在双人共学或已经准备，请先结束这一轮或取消准备，再开启个人专注。');
        }
        const reconciled = reconcileState(state, Date.now());
        if (reconciled.state !== state) commit(reconciled);
        commit(applyCommand(state, command, Date.now()), { keepPetPosition: command.type === 'settings.reset' });
      }
      return { ok: true, state: snapshot() };
    } catch (error) { return { ok: false, error: error.message || '操作暂时没有完成，请重试。' }; }
  });
  const handlePanel = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!panel || panel.isDestroyed() || event.sender !== panel.webContents
        || event.senderFrame !== panel.webContents.mainFrame) throw new Error('Unavailable sender');
    return callback(...args);
  });
  const extensionResult = async callback => {
    try { return { ok: true, data: await callback() }; }
    catch (error) { return { ok: false, error: error.message || '操作暂时没有完成，请重试。', code: error.code || 'EXTENSION_ERROR' }; }
  };
  const aiMethods = new Set(['getAiConfig', 'saveAiProfile', 'testAiConnection', 'listAiModels', 'listChats',
    'createChat', 'getChat', 'archiveChat', 'sendChat', 'stopChat', 'decomposeTask']);
  const studyMethods = new Set(['getStudyConfig', 'saveStudyConfig', 'getStudyState', 'connectStudy', 'studyCommand', 'leaveStudy']);
  handlePanel('buddy:ai', (method, value) => extensionResult(() => {
    if (typeof method !== 'string' || !aiMethods.has(method)) throw new Error('不支持这个 AI 操作。');
    return ai[method](value);
  }));
  handlePanel('buddy:study', (method, value) => extensionResult(() => {
    if (typeof method !== 'string' || !studyMethods.has(method)) throw new Error('不支持这个共学操作。');
    return study[method](value);
  }));
  const fontResult = async callback => {
    try { return await callback(); }
    catch (error) { return { ok: false, error: error.message || '字体操作暂时没有完成，请重试。' }; }
  };
  handlePanel('buddy:import-font', () => fontResult(async () => {
    if (fontDialogOpen) throw new Error('字体选择框已经打开，请先完成当前选择。');
    fontDialogOpen = true;
    try {
      const selected = await dialog.showOpenDialog(panel, { title: '选择本地字体', properties: ['openFile'],
        filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] });
      if (selected.canceled || !selected.filePaths?.length) return { ok: true, cancelled: true };
      if (selected.filePaths.length !== 1) throw new Error('请一次选择一个字体文件。');
      return await fonts.prepare(selected.filePaths[0]);
    } finally { fontDialogOpen = false; }
  }));
  handlePanel('buddy:confirm-font-import', pendingId => fontResult(() => fonts.confirm(pendingId, font => {
    commit(applyImportedFont(state, font, Date.now()), { refreshFont: true });
    return { ok: true, state: snapshot() };
  })));
  handlePanel('buddy:cancel-font-import', pendingId => fontResult(() => fonts.cancel(pendingId)));
  handle('buddy:get-active-font', () => fontResult(() => fonts.getActive(state.settings.importedFont)));
  handlePanel('buddy:reset-pet-position', () => {
    try {
      if (!pet || pet.isDestroyed()) throw new Error('小球窗口暂时不可用，请重启软件后重试。');
      const bounds = pet.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const position = { x: Math.round(Math.max(area.x, area.x + area.width - bounds.width - 30)),
        y: Math.round(Math.max(area.y, area.y + area.height - bounds.height - 30)) };
      commit({ state: { ...state, settings: { ...state.settings, petPosition: position } }, effects: [] });
      clearTimeout(moveTimer);
      pet.setPosition(position.x, position.y);
      expectedPetBounds = pet.getBounds();
      petResizeCenter = boundsCenter(expectedPetBounds);
      return { ok: true, state: snapshot() };
    } catch (error) { return { ok: false, error: error.message || '位置暂时无法恢复，请重试。' }; }
  });
  handle('buddy:open-panel', () => { showPanel(); });
  handle('buddy:set-pet-visible', visible => {
    if (typeof visible !== 'boolean') throw new Error('Invalid visibility');
    setPetVisible(visible);
  });
  const handlePet = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!pet || pet.isDestroyed() || event.sender !== pet.webContents
        || event.senderFrame !== pet.webContents.mainFrame) throw new Error('Unavailable sender');
    return callback(...args);
  });
  handlePet('buddy:get-pet-position', () => {
    const [x, y] = pet.getPosition();
    return { x, y };
  });
  handlePet('buddy:move-pet', position => {
    if (!position || typeof position !== 'object' || Array.isArray(position)
        || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Invalid position');
    const next = constrainPosition(position);
    pet.setPosition(next.x, next.y);
    const [x, y] = pet.getPosition();
    return { x, y };
  });
  handle('buddy:hide-panel', () => { panel.hide(); });
  handle('buddy:quit', () => { quitting = true; app.quit(); });
}

function protect(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('did-finish-load', () => {
    if (smoke) console.log(`BALL_BUDDY_LOADED:${path.basename(new URL(window.webContents.getURL()).pathname)}`);
    broadcast();
  });
  window.on('closed', () => { if (window === panel) panel = null; if (window === pet) pet = null; });
}

function getPetDimensions(settings = state?.settings) {
  const percent = Number.isInteger(settings?.petScale) && settings.petScale >= 70 && settings.petScale <= 150
    ? settings.petScale : 100;
  return { width: Math.round(220 * percent / 100), height: Math.round(280 * percent / 100) };
}

function boundsCenter(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function sameBounds(left, right) {
  return right && left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function constrainPosition(position, dimensions = pet && !pet.isDestroyed() ? pet.getBounds() : getPetDimensions()) {
  const { width, height } = dimensions;
  const hasPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y);
  const area = hasPosition
    ? screen.getDisplayNearestPoint({ x: Math.round(position.x + width / 2), y: Math.round(position.y + height / 2) }).workArea
    : screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(Math.max(area.x, Math.min(Number.isFinite(position?.x) ? position.x : area.x + area.width - width - 30,
      area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(Number.isFinite(position?.y) ? position.y : area.y + area.height - height - 30,
      area.y + area.height - height)))
  };
}

function showPanel() {
  if (!panel || panel.isDestroyed()) return;
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.focus();
}

function setPetVisible(visible) {
  petVisible = visible;
  if (visible) pet.showInactive(); else pet.hide();
  updateTray();
  broadcast();
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开小书桌', click: showPanel },
    { label: petVisible ? '让小球休息（隐藏）' : '叫小球回来', click: () => setPetVisible(!petVisible) },
    { type: 'separator' },
    { label: '退出小球同桌', click: () => { quitting = true; app.quit(); } }
  ]));
}

async function start() {
  storage = createStorage(app.getPath('userData'));
  fonts = createFontManager(app.getPath('userData'));
  const loaded = storage.load();
  storageNotice = loaded.notice;
  state = loaded.raw ? normalizeState(loaded.raw, Date.now()) : createInitialState(Date.now());
  // Expired persisted sessions are reconciled once before windows see the state.
  const initial = reconcileState(state, Date.now());
  state = initial.state;
  const petDimensions = getPetDimensions();
  const position = constrainPosition(state.settings?.petPosition, petDimensions);
  state = { ...state, settings: { ...state.settings, petPosition: position } };
  if (persist(state) && loaded.notice) storageNotice = loaded.notice;
  const credentials = { encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(value), isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() };
  ai = createAiService({ directory: path.join(app.getPath('userData'), 'ai'), ...credentials,
    fetch: (url, options) => net.fetch(url, options), emit: event => {
      if (panel && !panel.isDestroyed()) panel.webContents.send('buddy:ai-event', event);
      if (event.kind === 'started') {
        activeAiRequests.add(event.requestId);
        aiPresence = { requestId: event.requestId, busy: true };
        extensionInteraction('正在想办法，稍等一下。', '14');
      } else if (['finished', 'stopped', 'error', 'plan'].includes(event.kind)) {
        activeAiRequests.delete(event.requestId);
        aiPresence = activeAiRequests.size ? { requestId: [...activeAiRequests].at(-1), busy: true } : null;
        if (event.kind === 'finished' || event.kind === 'plan') extensionInteraction('想法写好了，去书桌看看。');
        else broadcast();
      }
    } });
  study = createStudyClient({ directory: path.join(app.getPath('userData'), 'study'), ...credentials,
    WebSocket: globalThis.WebSocket, getState: () => state,
    settle: receipt => commit(applyStudyReceipt(state, receipt, Date.now())),
    onUpdate: value => {
      if (panel && !panel.isDestroyed()) panel.webContents.send('buddy:study-state', value);
      if (state) broadcast();
    },
    onGreeting: () => extensionInteraction('同学碰了碰你，一起加油。', '30') });
  applyNativePreferences();
  const icon = nativeImage.createFromPath(path.join(root, 'src/assets/icon.png'));
  const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false };
  panel = new BrowserWindow({ width: 1040, height: 780, minWidth: 880, minHeight: 680,
    title: '小球同桌', backgroundColor: panelBackground(), autoHideMenuBar: true, show: false, icon, webPreferences });
  pet = new BrowserWindow({ ...petDimensions, ...position, title: '小球同桌 · 桌面伙伴',
    transparent: true, frame: false, resizable: false, alwaysOnTop: state.settings.petAlwaysOnTop, skipTaskbar: true,
    hasShadow: false, show: false, icon, webPreferences });
  expectedPetBounds = pet.getBounds();
  petResizeCenter = boundsCenter(expectedPetBounds);
  panel.setMenu(null);
  protect(panel);
  protect(pet);
  for (const window of [panel, pet]) {
    window.on('show', broadcast);
    window.on('hide', broadcast);
  }
  panel.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (state.settings.closeBehavior === 'quit') { quitting = true; app.quit(); }
    else panel.hide();
  });
  pet.on('close', event => { if (!quitting) { event.preventDefault(); setPetVisible(false); } });
  pet.on('move', () => {
    const bounds = pet.getBounds();
    if (!sameBounds(bounds, expectedPetBounds)) {
      expectedPetBounds = bounds;
      petResizeCenter = boundsCenter(bounds);
    }
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!pet || pet.isDestroyed()) return;
      const [x, y] = pet.getPosition();
      if (state.settings.petPosition?.x === x && state.settings.petPosition?.y === y) return;
      const next = { ...state, settings: { ...state.settings, petPosition: { x, y } } };
      if (persist(next)) { state = next; broadcast(); }
    }, 300);
  });
  screen.on('display-removed', () => { if (pet && !pet.isDestroyed()) { const next = constrainPosition({ x: pet.getBounds().x, y: pet.getBounds().y }); pet.setPosition(next.x, next.y); } });
  registerIpc();
  nativeTheme.on('updated', () => {
    if (panel && !panel.isDestroyed()) panel.setBackgroundColor(panelBackground());
    broadcast();
  });
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('小球同桌 · 和你一起做点小事');
  tray.on('click', showPanel);
  updateTray();
  await Promise.all([panel.loadFile(path.join(root, 'src/renderer/index.html')), pet.loadFile(path.join(root, 'src/renderer/pet.html'))]);
  if (state.settings.openPanelOnLaunch) panel.show();
  pet.showInactive();
  applyNativePreferences();
  cursorTimer = setInterval(samplePetCursor, 40);
  heartbeat = setInterval(() => {
    try {
      const result = reconcileState(state, Date.now());
      if (result.state !== state) commit(result);
    } catch { broadcast(); }
  }, 500);
  if (smoke) console.log('BALL_BUDDY_READY');
}

app.on('activate', showPanel);
app.on('before-quit', () => {
  quitting = true;
  clearInterval(heartbeat);
  clearInterval(cursorTimer);
  clearTimeout(moveTimer);
  ai?.close();
  study?.close();
  if (state && storage) persist(state);
});
app.on('will-quit', () => { if (tray) tray.destroy(); });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
