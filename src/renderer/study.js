(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  function create(options) {
    let snapshot = { connection: 'disconnected', room: null, serverOffsetMs: 0 };
    let busy = false;
    let destroyed = false;
    let messageSignature = '';
    let lastGreetingId = null;
    let greetingUntil = 0;
    let greetingText = '';
    const removers = [];
    const selfCompanion = window.BuddyCompanion.create(byId('study-self-ball'));
    const peerCompanion = window.BuddyCompanion.create(byId('study-peer-ball'));

    function listen(element, type, listener) { element.addEventListener(type, listener); removers.push(() => element.removeEventListener(type, listener)); }
    function showError(text) { byId('study-error').textContent = text || ''; byId('study-error').hidden = !text; }
    async function call(method, payload) {
      const result = await window.buddy[method](payload);
      if (!result?.ok) throw new Error(result?.error || '共学操作没有完成，请再试一次。');
      return result.data;
    }
    function members() {
      const list = snapshot.room?.members || [];
      return { self: list.find(item => item.id === snapshot.selfId), peer: list.find(item => item.id !== snapshot.selfId) };
    }
    function statusOf(member) {
      if (!member) return '等待伙伴加入';
      if (!member.online) return '暂时离线，等待重连';
      if (snapshot.room?.round?.status === 'running') return '一起专注中';
      if (snapshot.room?.round?.status === 'paused') return member.ready ? '已准备，等待继续' : '暂停中，准备好再继续';
      return member.ready ? '准备好了' : '在线，尚未准备';
    }

    function updateTimer() {
      const round = snapshot.room?.round;
      const milliseconds = round?.status === 'running'
        ? Math.max(0, round.endAt - Date.now() - (snapshot.serverOffsetMs || 0))
        : round?.remainingMs ?? Number(byId('study-minutes').value || 25) * 60000;
      byId('study-timer').textContent = window.BuddyCompanion.formatTime(milliseconds);
      if (Date.now() >= greetingUntil && byId('study-greeting').textContent) byId('study-greeting').textContent = '';
    }

    function renderMessages() {
      const list = snapshot.room?.messages || [];
      const signature = JSON.stringify(list);
      if (signature === messageSignature) return;
      messageSignature = signature;
      const container = byId('study-messages');
      const nearBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 75;
      container.replaceChildren();
      if (!list.length) { const empty = document.createElement('p'); empty.className = 'extension-note'; empty.textContent = '可以说声你好，再各自安静学习。'; container.append(empty); }
      for (const message of list) {
        const article = document.createElement('article'); article.className = 'room-message'; article.dataset.messageId = message.id;
        const heading = document.createElement('strong'); heading.textContent = snapshot.room.members.find(item => item.id === message.memberId)?.nickname || '已离开的伙伴';
        const text = document.createElement('p'); text.textContent = message.text; article.append(heading, text); container.append(article);
      }
      if (nearBottom) container.scrollTop = container.scrollHeight;
    }

    function renderControls() {
      const connected = snapshot.connection === 'connected';
      const room = snapshot.room;
      const host = room?.hostId === snapshot.selfId;
      const round = room?.round;
      const active = round && ['running', 'paused'].includes(round.status);
      const { self, peer } = members();
      const conflict = Boolean(options.getState()?.session);
      const allReady = room?.members?.length === 2 && room.members.every(item => item.online && item.ready);
      for (const id of ['study-config-save', 'study-create', 'study-join', 'study-nickname', 'study-server', 'study-code', 'study-goal']) byId(id).disabled = busy || snapshot.connection === 'connecting' || snapshot.connection === 'reconnecting' || Boolean(room);
      byId('study-create').disabled ||= !byId('study-nickname').value.trim() || !byId('study-server').value.trim();
      byId('study-join').disabled ||= !byId('study-code').value.trim() || !byId('study-nickname').value.trim() || !byId('study-server').value.trim();
      byId('study-ready').textContent = self?.ready ? '取消准备' : '我准备好了';
      byId('study-ready').setAttribute('aria-pressed', String(Boolean(self?.ready)));
      byId('study-ready').disabled = busy || !connected || conflict || round?.status === 'running';
      byId('study-ready').hidden = round?.status === 'running';
      byId('study-start').hidden = !host || Boolean(active);
      byId('study-start').disabled = busy || !connected || !allReady || conflict || !byId('study-minutes').checkValidity() || !byId('study-minutes').value;
      byId('study-duration-wrap').hidden = !host || Boolean(active);
      byId('study-minutes').disabled = busy || Boolean(active);
      byId('study-pause').hidden = !host || round?.status !== 'running';
      byId('study-pause').disabled = busy || !connected;
      byId('study-resume').hidden = !host || round?.status !== 'paused';
      byId('study-resume').disabled = busy || !connected || !allReady || conflict;
      byId('study-stop').hidden = !host || !active;
      byId('study-stop').disabled = busy || !connected;
      byId('study-leave').disabled = busy;
      byId('study-peer-ball').disabled = busy || !connected || !peer?.online;
      byId('study-message-send').disabled = busy || !connected || !byId('study-message-input').value.trim();
      byId('study-message-input').disabled = !connected;
      byId('study-round-note').textContent = conflict
        ? '你的个人专注还在进行。请回书桌结束本轮，之后才能准备共学。'
        : !host ? '双方准备后由主持人控制计时。完整一轮各获得 5 能量。'
        : round?.status === 'paused' ? '双方重新准备后可继续；离线时暂停，已学时间会保留。'
        : !peer ? '等伙伴加入并双方准备后，一起开始。'
        : '双方准备后由你开始，完整一轮各获得 5 能量。';
    }

    function render(next) {
      if (destroyed) return;
      if (next) { snapshot = next; showError(snapshot.error || ''); }
      const connectionLabels = { disconnected: '尚未连接', connecting: '正在连接…', connected: '已连接', reconnecting: '连接中断，正在重连…', error: '连接失败' };
      byId('study-connection').textContent = connectionLabels[snapshot.connection] || '尚未连接';
      byId('study-connection').dataset.status = snapshot.connection === 'connected' ? 'running' : 'idle';
      if (snapshot.error) showError(snapshot.error);
      byId('study-lobby').hidden = Boolean(snapshot.room);
      byId('study-room').hidden = !snapshot.room;
      if (snapshot.room) {
        byId('study-room-code').textContent = snapshot.room.code;
        const { self, peer } = members();
        byId('study-self-name').textContent = `${self?.nickname || '你'}${snapshot.room.hostId === snapshot.selfId ? ' · 主持人' : ' · 你'}`;
        byId('study-self-status').textContent = statusOf(self);
        byId('study-self-goal').textContent = self?.goal || '';
        byId('study-peer-name').textContent = peer ? `${peer.nickname}${snapshot.room.hostId === peer.id ? ' · 主持人' : ''}` : '等待伙伴加入';
        byId('study-peer-status').textContent = peer ? statusOf(peer) : '分享房间码，让对方加入。';
        byId('study-peer-goal').textContent = peer?.goal || '';
        byId('study-peer-ball').hidden = !peer;
        byId('study-waiting').hidden = Boolean(peer);
        const round = snapshot.room.round;
        byId('study-round-status').textContent = snapshot.connection !== 'connected'
          ? snapshot.connection === 'connecting' ? '正在连接房间，等待连接完成' : '连接中断，等待重新连接'
          : ({ running: '把注意力留给眼前，一起专注中', paused: '这一轮已暂停，等双方准备好', completed: '本轮完成，歇一会儿再开始', stopped: '本轮提前结束，已学时间保留' })[round?.status] || '准备好了再一起开始';
        const baseState = options.getState() || { settings: { motionMode: 'full' }, tasks: [], session: null };
        const visual = { ...baseState, interaction: null, app: { ...baseState.app, aiPresence: null }, session: round && ['running', 'paused'].includes(round.status) ? { ...round, taskId: null } : null };
        selfCompanion.update(visual);
        peerCompanion.update(visual);
        const greeting = snapshot.room.greeting;
        if (greeting?.id && greeting.id !== lastGreetingId) {
          lastGreetingId = greeting.id;
          const sender = snapshot.room.members.find(item => item.id === greeting.memberId);
          greetingText = greeting.memberId === snapshot.selfId ? '你向同桌打了个招呼。' : `${sender?.nickname || '同桌'}向你打了个招呼。`;
          greetingUntil = Date.now() + 4000;
          byId('study-greeting').textContent = greetingText;
          // Feed the same confirmed room event into both project-owned animated characters.
          const interaction = { id: greeting.id, at: Date.now(), effect: 'tap', emotion: '17', message: greetingText };
          selfCompanion.update({ ...visual, interaction }); peerCompanion.update({ ...visual, interaction });
        }
        renderMessages();
      }
      updateTimer(); renderControls();
    }

    async function saveConfig() {
      const data = await call('saveStudyConfig', { nickname: byId('study-nickname').value.trim(), serverUrl: byId('study-server').value.trim() });
      byId('study-nickname').value = data.nickname;
      byId('study-server').value = data.serverUrl;
      byId('study-config-status').textContent = '连接设置已保存；创建或加入时才连接服务。';
      return data;
    }
    async function action(operation) {
      if (busy) return;
      busy = true; showError(''); renderControls();
      try { await operation(); }
      catch (err) { showError(err.message); }
      finally { busy = false; renderControls(); }
    }
    function connect(mode) {
      return action(async () => {
        await saveConfig();
        await call('connectStudy', { mode, ...(mode === 'join' ? { code: byId('study-code').value.trim().toUpperCase() } : {}), ...(byId('study-goal').value.trim() ? { goal: byId('study-goal').value.trim() } : {}) });
        render(await call('getStudyState'));
      });
    }
    function command(input) { return action(async () => { await call('studyCommand', input); render(await call('getStudyState')); }); }

    listen(byId('study-config-form'), 'submit', event => { event.preventDefault(); action(saveConfig); });
    listen(byId('study-create'), 'click', () => connect('create'));
    listen(byId('study-join'), 'click', () => connect('join'));
    for (const id of ['study-nickname', 'study-server', 'study-code', 'study-message-input', 'study-minutes']) listen(byId(id), 'input', renderControls);
    listen(byId('study-copy-code'), 'click', () => options.copy(snapshot.room?.code || '', '房间码已复制，将它和共学服务地址发给伙伴。'));
    listen(byId('study-leave'), 'click', () => action(async () => { await call('leaveStudy'); render(await call('getStudyState')); }));
    listen(byId('study-ready'), 'click', () => command({ type: 'ready', ready: !members().self?.ready }));
    listen(byId('study-start'), 'click', () => command({ type: 'start', minutes: Number(byId('study-minutes').value) }));
    for (const type of ['pause', 'resume', 'stop']) listen(byId(`study-${type}`), 'click', () => command({ type }));
    listen(byId('study-peer-ball'), 'click', () => command({ type: 'greet' }));
    listen(byId('study-self-ball'), 'click', () => selfCompanion.greet());
    function sendRoomMessage(event) {
      event?.preventDefault();
      const text = byId('study-message-input').value.trim(); if (!text) return;
      action(async () => { await call('studyCommand', { type: 'message', text }); byId('study-message-input').value = ''; render(await call('getStudyState')); });
    }
    listen(byId('study-message-form'), 'submit', sendRoomMessage);
    listen(byId('study-message-input'), 'keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendRoomMessage(event); });
    const unsubscribe = window.buddy.onStudyState(render);
    const ticker = setInterval(updateTimer, 250);
    const ready = Promise.all([call('getStudyConfig'), call('getStudyState')]).then(([config, next]) => {
      if (destroyed) return;
      byId('study-nickname').value = config.nickname || '';
      byId('study-server').value = config.serverUrl || '';
      render(next);
    }).catch(err => showError(err.message));
    renderControls();
    return Object.freeze({ ready, render: () => render(), destroy() { destroyed = true; unsubscribe(); clearInterval(ticker); for (const remove of removers) remove(); selfCompanion.destroy(); peerCompanion.destroy(); } });
  }
  window.BuddyStudy = Object.freeze({ create });
})();
