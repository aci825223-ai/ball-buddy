(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const companion = window.BuddyCompanion.create(byId('main-ball'), text => { byId('buddy-speech').textContent = text; });
  const store = { lamp: { name: '桌灯', cost: 20 }, plant: { name: '盆栽', cost: 30 }, books: { name: '书本', cost: 40 } };
  let state = null;
  let pending = false;
  let petVisible = true;
  let petPending = false;
  let taskSignature = '';
  let toastTimer = null;
  let lastEventId = null;
  let lastStorageNotice = null;
  let scaleDraft = null;
  let settingsController = null;
  let extensions = null;
  let settingsBusy = false;
  const appearance = window.BuddyAppearance.create({
    onNotice: text => showMessage(text, true),
    onFontStatus: () => settingsController?.render(state)
  });

  function showMessage(text, error = false) {
    clearTimeout(toastTimer);
    const toast = byId('app-message');
    toast.textContent = text;
    toast.dataset.error = String(error);
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 7000 : 5000);
  }

  function setError(id, text) {
    const element = byId(id);
    element.textContent = text || '';
    element.hidden = !text;
    if (id === 'task-error') byId('task-input').setAttribute('aria-invalid', String(Boolean(text)));
  }

  async function runCommand(command, errorTarget) {
    if (pending || settingsBusy || !state) return false;
    const initialFocus = document.activeElement;
    const focusTaskId = initialFocus?.closest('.task-row')?.dataset.taskId;
    const focusClass = initialFocus?.classList.contains('task-complete') ? 'task-complete' : 'task-select';
    pending = true;
    setError(errorTarget || 'focus-error', '');
    renderControls();
    try {
      const result = await window.buddy.command(command);
      if (!result?.ok) throw new Error(result?.error || '操作没有完成，请再试一次。');
      render(result.state);
      return true;
    } catch (error) {
      if (errorTarget) setError(errorTarget, error.message);
      else showMessage(error.message, true);
      return false;
    } finally {
      pending = false;
      renderControls();
      if (focusTaskId && !initialFocus.isConnected) {
        const row = [...byId('task-list').children].find(item => item.dataset.taskId === focusTaskId);
        const control = row?.querySelector(`.${focusClass}`) || byId('task-list').querySelector(`.${focusClass}`) || byId('task-input');
        control.focus({ preventScroll: true });
      }
    }
  }

  function checkIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm4 10 4 4 8-8');
    svg.append(path);
    return svg;
  }

  function renderTasks() {
    const signature = JSON.stringify([state.tasks, state.selectedTaskId]);
    if (signature === taskSignature) return;
    taskSignature = signature;
    const openTasks = state.tasks.filter(task => task.completedAt === null);
    const completedTasks = state.tasks.filter(task => task.completedAt !== null);
    const list = byId('task-list');
    const focusedRow = document.activeElement?.closest('.task-row');
    const focusedTaskId = focusedRow?.dataset.taskId;
    const focusedControl = document.activeElement?.classList.contains('task-complete') ? 'task-complete' : 'task-select';
    list.replaceChildren();
    for (const task of openTasks) {
      const row = document.createElement('div');
      row.className = 'task-row';
      row.dataset.taskId = task.id;
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'task-select';
      select.setAttribute('aria-pressed', String(state.selectedTaskId === task.id));
      select.setAttribute('aria-label', `选择任务：${task.title}`);
      const indicator = document.createElement('span');
      indicator.className = 'select-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'task-title';
      title.textContent = task.title;
      select.append(indicator, title);
      select.addEventListener('click', () => runCommand({ type: 'task.select', taskId: state.selectedTaskId === task.id ? null : task.id }));
      const complete = document.createElement('button');
      complete.type = 'button';
      complete.className = 'task-complete';
      complete.dataset.testid = 'task-complete';
      complete.setAttribute('aria-label', `完成任务：${task.title}`);
      complete.append(checkIcon(), document.createTextNode('完成'));
      complete.addEventListener('click', () => runCommand({ type: 'task.complete', taskId: task.id }));
      row.append(select, complete);
      list.append(row);
    }
    if (focusedTaskId) {
      const replacementRow = [...list.children].find(row => row.dataset.taskId === focusedTaskId);
      const replacementControl = replacementRow?.querySelector(`.${focusedControl}`) || list.querySelector(`.${focusedControl}`) || byId('task-input');
      replacementControl.focus({ preventScroll: true });
    }
    byId('task-count').textContent = `${openTasks.length} 件待办`;
    byId('empty-state').hidden = state.tasks.length > 0;
    byId('all-done').hidden = !state.tasks.length || openTasks.length > 0;
    byId('completed-section').hidden = !completedTasks.length;
    byId('completed-label').textContent = `已完成 ${completedTasks.length} 件`;
    const completed = byId('completed-list');
    completed.replaceChildren();
    for (const task of completedTasks.slice().reverse()) {
      const item = document.createElement('li');
      const title = document.createElement('span');
      title.textContent = task.title;
      item.append(checkIcon(), title);
      completed.append(item);
    }
  }

  function renderTimer() {
    if (!state) return;
    byId('focus-timer').textContent = window.BuddyCompanion.formatTime(window.BuddyCompanion.remaining(state));
  }

  function renderControls() {
    const session = state?.session;
    const disabled = pending || settingsBusy || !state;
    const studyActive = ['running', 'paused'].includes(state?.app?.study?.room?.round?.status);
    byId('focus-start').hidden = Boolean(session) || studyActive;
    byId('focus-pause').hidden = session?.status !== 'running';
    byId('focus-resume').hidden = session?.status !== 'paused';
    byId('focus-stop').hidden = !session;
    for (const id of ['focus-start', 'focus-pause', 'focus-resume', 'focus-stop', 'task-add', 'pet-scale', 'pet-scale-reset']) byId(id).disabled = disabled;
    document.querySelectorAll('[data-motion]').forEach(button => { button.disabled = disabled; });
    byId('focus-start').disabled = disabled || studyActive || !byId('focus-minutes').value || !byId('focus-minutes').checkValidity();
    byId('focus-minutes').disabled = disabled || Boolean(session) || studyActive;
    byId('duration-presets').hidden = Boolean(session) || studyActive;
    document.querySelectorAll('[data-minutes]').forEach(button => {
      button.disabled = disabled || Boolean(session);
      button.setAttribute('aria-pressed', String(button.dataset.minutes === byId('focus-minutes').value));
      button.setAttribute('aria-label', `专注 ${button.dataset.minutes} 分钟`);
    });
    document.querySelectorAll('.task-complete, .task-select').forEach(button => { button.disabled = disabled; });
    for (const [id, item] of Object.entries(store)) {
      const button = document.querySelector(`[data-decoration="${id}"]`);
      const owned = state?.decorations?.includes(id) || false;
      const enough = (state?.stats?.energy || 0) >= item.cost;
      button.disabled = disabled || owned || !enough;
      button.dataset.owned = String(owned);
      button.querySelector('.shop-action').textContent = owned ? '已布置' : '解锁';
      button.querySelector('.shop-cost').textContent = owned ? '留在书桌上' : `${item.cost} 能量`;
      button.title = owned ? `${item.name}已经摆在书桌上` : enough ? `用 ${item.cost} 能量解锁${item.name}` : `再收集 ${item.cost - (state?.stats?.energy || 0)} 能量即可解锁${item.name}`;
      button.setAttribute('aria-label', owned ? `${item.name}，已布置` : `解锁${item.name}，需要 ${item.cost} 能量`);
    }
    settingsController?.setBusy(disabled);
  }

  function render(nextState) {
    if (!nextState) return;
    state = nextState;
    appearance.apply(state);
    document.querySelector('.workspace').setAttribute('aria-busy', 'false');
    renderTasks();
    renderTimer();
    const session = state.session;
    const studyRound = state.app?.study?.room?.round;
    const studyActive = ['running', 'paused'].includes(studyRound?.status);
    const task = window.BuddyCompanion.activeTask(state);
    const status = byId('focus-status');
    status.textContent = studyActive ? (studyRound.status === 'running' ? '共学专注' : '共学暂停') : session?.status === 'running' ? '正在专注' : session?.status === 'paused' ? '休息一下' : '准备开始';
    status.dataset.status = studyActive ? studyRound.status : session?.status || 'idle';
    byId('focus-task-name').textContent = studyActive ? '正在和伙伴共学' : task?.title || '自由专注';
    byId('focus-caption').textContent = studyActive ? '计时由共学房间同步。' : session?.status === 'running' ? '专心做眼前这一件事。' : session?.status === 'paused' ? '这一轮会等你回来。' : task ? '准备好，就从这件事开始。' : '选一件事，或直接开始。';
    byId('focus-note').textContent = studyActive ? '请到“双人共学”控制本轮，结束后可开始个人专注。' : session ? '完整专注一轮 +5 能量；提前结束本轮不计奖励。' : '小球会安静陪着你，到时间再提醒。';
    if (!session && document.activeElement !== byId('focus-minutes')) byId('focus-minutes').value = String(state.settings.focusMinutes);
    if (session) byId('focus-minutes').value = String(Math.round(session.durationMs / 60000));
    if (studyActive) byId('focus-minutes').value = String(Math.round(studyRound.durationMs / 60000));
    byId('energy-count').textContent = String(state.stats.energy);
    for (const id of Object.keys(store)) byId(`scene-${id}`).toggleAttribute('hidden', !state.decorations.includes(id));
    byId('footer-progress').textContent = state.stats.completedTasks ? `已经一起完成 ${state.stats.completedTasks} 件事。` : '今天，从一件小事开始。';
    companion.update(state);
    document.querySelectorAll('[data-motion]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.motion === (state.settings.motionMode || 'full')));
    });
    const scale = scaleDraft ?? state.settings.petScale ?? 100;
    byId('pet-scale').value = String(scale);
    byId('pet-scale').setAttribute('aria-valuetext', `${scale}%`);
    byId('pet-scale-value').textContent = `${scale}%`;
    if (typeof state.app?.petVisible === 'boolean') {
      petVisible = state.app.petVisible;
      byId('pet-toggle').setAttribute('aria-pressed', String(petVisible));
      byId('pet-toggle-label').textContent = petVisible ? '收起桌面小球' : '唤回桌面小球';
    }
    renderControls();
    settingsController?.render(state);
    extensions?.render(state);
    const event = window.BuddyCompanion.currentEvent(state);
    if (event && event.id !== lastEventId) {
      lastEventId = event.id;
      showMessage(event.message || window.BuddyCompanion.message(state));
    }
    if (state.app?.storageNotice && state.app.storageNotice !== lastStorageNotice) showMessage(state.app.storageNotice, true);
    lastStorageNotice = state.app?.storageNotice || null;
  }

  const unbindInteractions = window.BuddyInteractions.bind(byId('main-ball'), companion, {
    onState: render, onError: text => showMessage(text, true)
  });
  document.querySelectorAll('[data-motion]').forEach(button => button.addEventListener('click', () =>
    runCommand({ type: 'settings.update', motionMode: button.dataset.motion })));
  byId('pet-scale').addEventListener('input', () => {
    scaleDraft = Number(byId('pet-scale').value);
    byId('pet-scale-value').textContent = `${scaleDraft}%`;
    byId('pet-scale').setAttribute('aria-valuetext', `${scaleDraft}%`);
  });
  byId('pet-scale').addEventListener('change', async () => {
    const petScale = Number(byId('pet-scale').value);
    scaleDraft = null;
    if (!await runCommand({ type: 'settings.update', petScale })) render(state);
  });
  byId('pet-scale-reset').addEventListener('click', async () => {
    scaleDraft = null;
    if (!await runCommand({ type: 'settings.update', petScale: 100 })) render(state);
  });

  byId('task-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = byId('task-input');
    const title = input.value.trim();
    if (!title) { setError('task-error', '先写下一件想做的事。'); input.focus(); return; }
    if (await runCommand({ type: 'task.add', title }, 'task-error')) {
      input.value = '';
      input.focus();
      companion.greet();
    }
  });
  byId('task-input').addEventListener('input', () => setError('task-error', ''));
  byId('empty-add').addEventListener('click', () => byId('task-input').focus());
  byId('focus-start').addEventListener('click', () => runCommand({ type: 'focus.start', taskId: window.BuddyCompanion.activeTask(state)?.id || null, minutes: Number(byId('focus-minutes').value) }, 'focus-error'));
  byId('focus-pause').addEventListener('click', () => runCommand({ type: 'focus.pause' }, 'focus-error'));
  byId('focus-resume').addEventListener('click', () => runCommand({ type: 'focus.resume' }, 'focus-error'));
  byId('focus-stop').addEventListener('click', () => runCommand({ type: 'focus.stop' }, 'focus-error'));
  byId('focus-minutes').addEventListener('input', () => { setError('focus-error', ''); renderControls(); });
  byId('focus-minutes').addEventListener('change', async () => {
    if (!byId('focus-minutes').value || !byId('focus-minutes').checkValidity()) {
      setError('focus-error', '填写 1–180 之间的整数分钟数。');
      renderControls();
      return;
    }
    try {
      const result = await window.buddy.command({ type: 'settings.update', focusMinutes: Number(byId('focus-minutes').value) });
      if (!result?.ok) throw new Error(result?.error || '时长没有保存，请再试一次。');
      render(result.state);
    } catch (error) { setError('focus-error', error.message); }
  });
  document.querySelectorAll('[data-minutes]').forEach(button => button.addEventListener('click', () => {
    byId('focus-minutes').value = button.dataset.minutes;
    runCommand({ type: 'settings.update', focusMinutes: Number(button.dataset.minutes) }, 'focus-error');
  }));
  document.querySelectorAll('[data-decoration]').forEach(button => button.addEventListener('click', () => runCommand({ type: 'decoration.buy', decorationId: button.dataset.decoration })));
  byId('pet-toggle').addEventListener('click', async () => {
    if (petPending) return;
    petPending = true;
    byId('pet-toggle').disabled = true;
    try {
      await window.buddy.setPetVisible(!petVisible);
    } catch (error) { showMessage(error.message || '暂时无法调整桌面小球，请再试一次。', true); }
    finally { petPending = false; byId('pet-toggle').disabled = false; }
  });
  byId('hide-panel').addEventListener('click', async () => {
    try { await window.buddy.setPetVisible(true); await window.buddy.hidePanel(); }
    catch (error) { showMessage(error.message, true); }
  });
  settingsController = window.BuddySettings.create({
    getState: () => state,
    runCommand,
    onState: render,
    appearance,
    setNativeBusy: busy => { settingsBusy = busy; renderControls(); },
    onOpen: () => extensions?.settingsOpen(),
    onBack: () => extensions?.settingsBack()
  });
  extensions = window.BuddyExtensions.create({
    getState: () => state, runCommand, showMessage, companion,
    openSettings: section => settingsController.open(section)
  });
  renderControls();
  let receivedState = false;
  const unsubscribe = window.buddy.onState(nextState => { receivedState = true; render(nextState); });
  window.buddy.getState().then(nextState => { if (!receivedState) render(nextState); }).catch(() => showMessage('没有读到这张书桌的进展，请重开应用再试一次。', true));
  const ticker = setInterval(renderTimer, 250);
  window.addEventListener('beforeunload', () => { unsubscribe(); clearInterval(ticker); clearTimeout(toastTimer); unbindInteractions(); extensions.destroy(); companion.destroy(); settingsController.destroy(); appearance.destroy(); });
})();
