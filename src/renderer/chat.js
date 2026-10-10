(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  const PRESETS = {
    openai: { name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
    deepseek: { name: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    qwen: { name: '通义千问', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '' },
    anthropic: { name: 'Claude', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '' },
    gemini: { name: 'Gemini', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '' },
    local: { name: '本地模型', provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: '' }
  };
  function create(options) {
    let config = { profiles: [], activeProfileId: null };
    let editingProfileId = null;
    let configBusy = false;
    let configDirty = false;
    let chat = null;
    let history = [];
    let loadingChat = false;
    let sending = false;
    let chatTask = null;
    let plan = null;
    let planRequest = null;
    let planStarting = false;
    let planAdding = false;
    let destroyed = false;
    let chatLoadRevision = 0;
    const requests = new Map();
    const messageNodes = new Map();
    const removers = [];

    function listen(element, type, listener) { element.addEventListener(type, listener); removers.push(() => element.removeEventListener(type, listener)); }
    function readLocal(key) { try { return localStorage.getItem(`buddy.${key}`) || ''; } catch { return ''; } }
    function writeLocal(key, value) { try { localStorage.setItem(`buddy.${key}`, value); } catch { /* Native conversations remain durable when local drafts are unavailable. */ } }
    function error(id, text) { byId(id).textContent = text || ''; byId(id).hidden = !text; }
    async function call(method, payload) {
      const result = await window.buddy[method](payload);
      if (!result?.ok) throw new Error(result?.error || '没有完成操作，请再试一次。');
      return result.data;
    }
    function profile() { return config.profiles.find(item => item.id === byId('chat-profile').value) || null; }
    function chatDraftKey() { return `chat-draft.${chat?.id || 'new'}`; }
    function storeDraft() { writeLocal(chatDraftKey(), byId('chat-input').value); }
    function requestForChat() { return [...requests.entries()].find(([, item]) => item.chatId === chat?.id); }

    function fillProfile(item) {
      editingProfileId = item?.id || null;
      byId('ai-profile-select').value = editingProfileId || '';
      byId('ai-preset').value = 'custom';
      byId('ai-name').value = item?.name || '';
      byId('ai-provider').value = item?.provider || 'openai';
      byId('ai-base-url').value = item?.baseUrl || '';
      byId('ai-model').value = item?.model || '';
      byId('ai-key').value = '';
      byId('ai-clear-key').checked = false;
      byId('ai-model-options').replaceChildren();
      byId('ai-key').placeholder = item?.hasKey ? '已配置；不填写则保留现有密钥' : '填入服务提供的密钥（本地服务可留空）';
      byId('ai-key-note').textContent = item?.keyStorage === 'session'
        ? '系统加密不可用，此连接的密钥只在本次运行中使用。重启后需重新填写。'
        : item?.hasKey ? '密钥已由本机加密保存，界面不会回显。' : '密钥只用于你明确发起的请求，不会发送给共学伙伴。';
      configDirty = false;
      byId('ai-config-status').textContent = item ? `已保存「${item.name}」，尚未执行本次连接测试。` : '填写连接后保存，再主动测试。';
      error('ai-config-error', '');
      updateConfigControls();
    }

    function updateConfigControls() {
      document.querySelectorAll('[data-ai-control]').forEach(control => { control.disabled = configBusy; });
      byId('ai-test').disabled = configBusy || !editingProfileId || configDirty;
      byId('ai-models').disabled = configBusy || !editingProfileId || configDirty;
      byId('settings-section-ai').setAttribute('aria-busy', String(configBusy));
    }

    function populateProfiles() {
      for (const id of ['ai-profile-select', 'chat-profile', 'decompose-profile']) {
        const select = byId(id);
        const previous = select.value;
        select.replaceChildren();
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = id === 'ai-profile-select' ? '新增连接…' : '尚未配置 AI';
        empty.disabled = id !== 'ai-profile-select' && config.profiles.length > 0;
        select.append(empty);
        for (const item of config.profiles) {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = `${item.name} · ${item.model}`;
          select.append(option);
        }
        select.value = config.profiles.some(item => item.id === previous) ? previous : config.activeProfileId || '';
      }
      byId('ai-profile-select').value = editingProfileId || '';
      renderChatControls();
      renderPlanControls();
    }

    function markConfigDirty() {
      configDirty = true;
      byId('ai-config-status').textContent = '连接有未保存的修改，保存后再测试。';
      error('ai-config-error', '');
      updateConfigControls();
    }

    async function saveProfile(event) {
      event.preventDefault();
      if (configBusy) return;
      const input = { name: byId('ai-name').value.trim(), provider: byId('ai-provider').value, baseUrl: byId('ai-base-url').value.trim(), model: byId('ai-model').value.trim(), select: true };
      if (editingProfileId) input.id = editingProfileId;
      if (byId('ai-clear-key').checked) input.key = '';
      else if (byId('ai-key').value) input.key = byId('ai-key').value;
      configBusy = true;
      updateConfigControls();
      error('ai-config-error', '');
      byId('ai-config-status').textContent = '正在保存连接…';
      try {
        config = await call('saveAiProfile', input);
        editingProfileId = config.activeProfileId;
        populateProfiles();
        fillProfile(config.profiles.find(item => item.id === editingProfileId));
        byId('chat-profile').value = config.activeProfileId;
        byId('decompose-profile').value = config.activeProfileId;
        byId('ai-config-status').textContent = '连接已保存并选用；点击测试后才会检查连通性。';
        renderChatControls();
        renderPlanControls();
      } catch (err) {
        byId('ai-config-status').textContent = '连接没有保存';
        error('ai-config-error', err.message);
      } finally {
        byId('ai-key').value = '';
        configBusy = false;
        updateConfigControls();
      }
    }

    async function testConnection(models = false) {
      if (configBusy || !editingProfileId || configDirty) return;
      configBusy = true;
      error('ai-config-error', '');
      byId('ai-config-status').textContent = models ? '正在向服务读取模型列表…' : '正在测试已保存连接，会发起一次模型请求…';
      updateConfigControls();
      try {
        const data = await call(models ? 'listAiModels' : 'testAiConnection', { profileId: editingProfileId });
        if (models) {
          byId('ai-model-options').replaceChildren();
          for (const item of data || []) {
            const option = document.createElement('option'); option.value = item.id; option.textContent = item.name || item.id; byId('ai-model-options').append(option);
          }
          byId('ai-config-status').textContent = data?.length ? `读到 ${data.length} 个模型，可在模型 ID 输入框中选择，再保存。` : '服务返回了空模型列表，也可以手填模型 ID。';
        } else byId('ai-config-status').textContent = `连接测试通过，模型：${data.model || '当前模型'}。`;
      } catch (err) { error('ai-config-error', err.message); byId('ai-config-status').textContent = models ? '模型列表没有读到，可继续手填。' : '连接测试未通过，检查地址、模型和密钥后重试。'; }
      finally { configBusy = false; updateConfigControls(); }
    }

    function renderChatControls() {
      const current = profile();
      const generating = Boolean(requestForChat()) || sending || chat?.messages?.some(message => message.status === 'generating');
      byId('chat-model-note').textContent = current ? current.model ? `${current.name} · ${current.model}，下一次请求使用此连接。` : `「${current.name}」还没有选择模型，请在配置中填写模型 ID 或读取列表后保存。` : '尚未连接 AI；先在设置中填写自己的服务。';
      byId('chat-send').disabled = !current?.model || generating || loadingChat || Boolean(chat?.archived) || !byId('chat-input').value.trim();
      byId('chat-stop').hidden = !generating;
      byId('chat-stop').disabled = !requestForChat();
      byId('chat-new').disabled = sending || loadingChat;
      byId('chat-profile').disabled = sending || loadingChat;
      byId('chat-attach-task').disabled = !window.BuddyCompanion.activeTask(options.getState());
      byId('chat-connect').hidden = Boolean(current);
      byId('chat-task-context').hidden = !chatTask;
      byId('chat-task-context-title').textContent = chatTask ? `将附带任务：${chatTask}` : '';
      byId('chat-task-context-title').title = chatTask || '';
      byId('chat-page').setAttribute('aria-busy', String(loadingChat));
    }

    function setChatStatus(text) { byId('chat-status').textContent = text; }
    function statusLabel(status) { return ({ generating: '正在回复…', stopped: '已停止', error: '回复失败', interrupted: '上次回复中断' })[status] || ''; }
    function messageNode(message, index) {
      const article = document.createElement('article');
      article.className = 'chat-message'; article.dataset.role = message.role; article.dataset.messageId = message.id;
      const heading = document.createElement('div'); heading.className = 'chat-message-heading';
      const name = document.createElement('span'); name.textContent = message.role === 'user' ? '你' : 'AI';
      const status = document.createElement('span'); status.className = 'chat-message-status'; heading.append(name, status);
      const body = document.createElement('div'); body.className = 'chat-message-body';
      const problem = document.createElement('p'); problem.className = 'chat-message-error inline-error'; problem.hidden = true;
      article.append(heading, body, problem);
      if (message.role === 'assistant') {
        const actions = document.createElement('div'); actions.className = 'chat-message-actions';
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button'; copy.textContent = '复制'; copy.dataset.testid = 'chat-copy';
        copy.addEventListener('click', () => options.copy(body.textContent, '已复制回复'));
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重新回答'; retry.dataset.testid = 'chat-retry';
        retry.addEventListener('click', () => {
          const prior = chat?.messages?.slice(0, index).reverse().find(item => item.role === 'user');
          if (prior) send(prior.text);
        });
        actions.append(copy, retry); article.append(actions);
        article._retry = retry; article._copy = copy;
      }
      article._body = body; article._status = status; article._error = problem;
      return article;
    }

    function renderMessages() {
      const container = byId('chat-messages');
      const nearBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 75;
      const messages = chat?.messages || [];
      byId('chat-empty').hidden = messages.length > 0;
      const ids = new Set(messages.map(item => item.id));
      for (const [id, node] of messageNodes) if (!ids.has(id)) { node.remove(); messageNodes.delete(id); }
      messages.forEach((message, index) => {
        let node = messageNodes.get(message.id);
        if (!node) { node = messageNode(message, index); messageNodes.set(message.id, node); container.append(node); }
        node._body.textContent = message.text || (message.status === 'generating' ? '正在思考…' : '');
        node._status.textContent = statusLabel(message.status);
        node._error.textContent = message.error || '';
        node._error.hidden = !message.error;
        if (node._retry) node._retry.disabled = Boolean(requestForChat()) || sending || loadingChat || Boolean(chat?.archived) || !profile()?.model;
        if (node._copy) node._copy.disabled = !message.text;
      });
      if (nearBottom || messages.length < 3) container.scrollTop = container.scrollHeight;
      renderChatControls();
    }

    function renderHistory() {
      const container = byId('chat-history-list'); container.replaceChildren();
      const visible = history.filter(item => !item.archived || byId('chat-show-archived').checked);
      if (!visible.length) { const empty = document.createElement('p'); empty.className = 'extension-note'; empty.textContent = '还没有对话记录。'; container.append(empty); return; }
      for (const item of visible) {
        const row = document.createElement('div'); row.className = 'chat-history-row';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'history-select'; button.textContent = `${item.title || '新对话'}${item.archived ? '（已归档）' : ''}`; button.dataset.chatId = item.id; button.setAttribute('aria-current', String(item.id === chat?.id));
        button.addEventListener('click', () => selectChat(item.id));
        const archive = document.createElement('button'); archive.type = 'button'; archive.className = 'quiet-button'; archive.textContent = '归档'; archive.setAttribute('aria-label', `归档对话：${item.title || '新对话'}`);
        archive.disabled = item.archived || Boolean([...requests.values()].find(value => value.chatId === item.id));
        if (item.archived) archive.textContent = '已归档';
        archive.addEventListener('click', async () => {
          try { await call('archiveChat', { chatId: item.id }); if (chat?.id === item.id) newChat(); await refreshHistory(); }
          catch (err) { error('chat-error', err.message); }
        });
        row.append(button, archive); container.append(row);
      }
    }
    async function refreshHistory() { history = await call('listChats'); if (!destroyed) renderHistory(); }

    async function selectChat(id) {
      if (sending || loadingChat) return;
      storeDraft();
      const revision = ++chatLoadRevision;
      loadingChat = true; error('chat-error', ''); renderChatControls();
      try {
        const next = await call('getChat', { chatId: id });
        if (destroyed || revision !== chatLoadRevision) return;
        chat = next;
        if (config.profiles.some(item => item.id === chat.profileId)) byId('chat-profile').value = chat.profileId;
        byId('chat-input').value = readLocal(chatDraftKey()); writeLocal('last-chat', id);
        renderMessages(); renderHistory();
        setChatStatus(chat.archived ? '这是已归档的对话，仍可阅读和复制。想继续聊，请新建对话。' : chat.messages.some(message => message.status === 'interrupted') ? '上次回复中断；已收到的文字已保留，可主动重新回答。' : '消息保存在本机，切换页面不会停止生成。');
      } catch (err) { error('chat-error', err.message); }
      finally { if (revision === chatLoadRevision) { loadingChat = false; renderChatControls(); } }
    }

    function newChat() {
      if (sending || loadingChat) return;
      storeDraft(); ++chatLoadRevision; chat = null; chatTask = null;
      byId('chat-input').value = readLocal(chatDraftKey()); writeLocal('last-chat', '');
      renderMessages(); renderHistory(); error('chat-error', '');
      setChatStatus('新对话准备好了，发送时才会创建会话并调用 AI。'); byId('chat-input').focus({ preventScroll: true });
    }

    async function send(overrideText) {
      if (sending || loadingChat || requestForChat() || chat?.archived) return;
      const text = typeof overrideText === 'string' ? overrideText : byId('chat-input').value.trim();
      const current = profile();
      if (!current) { options.openSettings('ai'); return; }
      if (!text) return;
      sending = true; error('chat-error', ''); renderChatControls();
      let created = false;
      try {
        if (!chat) {
          chat = await call('createChat', { profileId: current.id }); created = true;
          writeLocal(chatDraftKey(), byId('chat-input').value); writeLocal('last-chat', chat.id);
        }
        const data = await call('sendChat', { chatId: chat.id, text, profileId: current.id, ...(chatTask ? { taskTitle: chatTask } : {}) });
        if (!completedRequests.has(data.requestId)) requests.set(data.requestId, { chatId: data.chatId });
        if (typeof overrideText !== 'string') { byId('chat-input').value = ''; storeDraft(); if (created) writeLocal('chat-draft.new', ''); }
        chatTask = null;
        setChatStatus('AI 正在回复，可随时停止；切换页面后会继续保存。');
        chat = await call('getChat', { chatId: chat.id });
        renderMessages(); await refreshHistory();
      } catch (err) { error('chat-error', err.message); setChatStatus('消息没有完成发送，输入已保留，可检查连接后再试。'); }
      finally { sending = false; renderMessages(); }
    }

    async function stopChat() {
      const request = requestForChat(); if (!request) return;
      byId('chat-stop').disabled = true;
      try { await call('stopChat', { requestId: request[0] }); }
      catch (err) { error('chat-error', err.message); renderChatControls(); }
    }

    function renderPlanControls() {
      const busy = Boolean(planRequest) || planStarting;
      const planProfile = config.profiles.find(item => item.id === byId('decompose-profile').value);
      byId('decompose-generate').disabled = busy || planAdding || !byId('decompose-goal').value.trim() || !planProfile?.model;
      if (planProfile && !planProfile.model && !plan && !busy) byId('decompose-status').textContent = '此连接尚未选择模型，请在 AI 配置中补充模型 ID 并保存。';
      byId('decompose-stop').hidden = !busy;
      byId('decompose-stop').disabled = !planRequest;
      byId('decompose-add').disabled = planAdding || busy || !plan || plan.imported || !byId('decompose-steps').querySelector('input[type="checkbox"]:checked');
    }
    function updatePlanCount() {
      const selected = byId('decompose-steps').querySelectorAll('input[type="checkbox"]:checked').length;
      byId('decompose-count').textContent = `已选 ${selected} / ${plan?.steps?.length || 0} 步`;
      renderPlanControls();
    }
    function renderPlan() {
      byId('decompose-preview').hidden = !plan;
      const list = byId('decompose-steps'); list.replaceChildren();
      if (!plan) return;
      plan.steps.forEach((step, index) => {
        const row = document.createElement('li'); row.className = 'decompose-step'; row.dataset.stepIndex = String(index);
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.setAttribute('aria-label', `选择第 ${index + 1} 步`); check.addEventListener('change', updatePlanCount);
        const content = document.createElement('div');
        const title = document.createElement('input'); title.type = 'text'; title.value = step.title; title.maxLength = 140; title.className = 'step-title'; title.setAttribute('aria-label', `第 ${index + 1} 步任务标题`);
        const description = document.createElement('p'); description.className = 'step-description'; description.textContent = step.description || ''; content.append(title, description);
        const duration = document.createElement('label'); duration.className = 'extension-field'; duration.textContent = '预计分钟';
        const minutes = document.createElement('input'); minutes.type = 'number'; minutes.min = '1'; minutes.max = '180'; minutes.step = '1'; minutes.value = String(step.minutes || 25); minutes.setAttribute('aria-label', `第 ${index + 1} 步预计分钟`); duration.append(minutes);
        row.append(check, content, duration); list.append(row);
      });
      updatePlanCount();
    }

    async function generatePlan(event) {
      event.preventDefault(); if (planRequest || planStarting || planAdding) return;
      const goal = byId('decompose-goal').value.trim(); const profileId = byId('decompose-profile').value;
      if (!profileId) { options.openSettings('ai'); return; }
      planStarting = true; error('decompose-error', ''); byId('decompose-status').textContent = '正在拆开目标，生成可编辑的步骤…'; renderPlanControls();
      try {
        const minutes = byId('decompose-minutes').value ? Number(byId('decompose-minutes').value) : undefined;
        const data = await call('decomposeTask', { goal, profileId, ...(minutes ? { minutes } : {}) });
        // A very short local response may have delivered its terminal event before IPC returns.
        if (!completedRequests.has(data.requestId)) planRequest = data.requestId;
      } catch (err) { error('decompose-error', err.message); byId('decompose-status').textContent = '还没有生成新步骤，请检查连接后重试。'; }
      finally { planStarting = false; renderPlanControls(); }
    }
    async function addPlan() {
      if (!plan || plan.imported || planAdding) return;
      const tasks = [];
      for (const row of byId('decompose-steps').children) {
        if (!row.querySelector('input[type="checkbox"]').checked) continue;
        const title = row.querySelector('.step-title').value.trim(); const input = row.querySelector('input[type="number"]');
        if (!title || !input.value || !input.checkValidity()) { error('decompose-error', '选中的每一步都要有标题和 1–180 之间的整数分钟数。'); (!title ? row.querySelector('.step-title') : input).focus(); return; }
        tasks.push({ title, estimatedMinutes: Number(input.value) });
      }
      if (!tasks.length) return;
      planAdding = true; error('decompose-error', ''); renderPlanControls();
      try {
        if (await options.runCommand({ type: 'task.batch-add', planId: plan.id, tasks })) {
          plan.imported = true; byId('decompose-status').textContent = `已加入 ${tasks.length} 件任务，可回书桌选择一件开始。`;
          byId('decompose-steps').querySelectorAll('input').forEach(input => { input.disabled = true; }); options.companion.greet();
        } else error('decompose-error', '任务没有加入，保留当前编辑内容。请再试一次。');
      } finally { planAdding = false; renderPlanControls(); }
    }

    const completedRequests = new Set();
    async function aiEvent(event) {
      if (destroyed || !event?.requestId) return;
      if (event.kind === 'started' && event.chatId) requests.set(event.requestId, { chatId: event.chatId });
      if (event.chatId && event.chatId === chat?.id) {
        if (event.kind === 'delta') {
          let assistant = chat.messages.slice().reverse().find(item => item.role === 'assistant' && item.status === 'generating');
          if (!assistant) { assistant = { id: `stream-${event.requestId}`, role: 'assistant', text: '', status: 'generating' }; chat.messages.push(assistant); }
          assistant.text += event.text || ''; renderMessages();
        } else if (event.kind === 'started') { setChatStatus('AI 正在回复，可以停止生成。'); renderChatControls(); }
      }
      if (['finished', 'stopped', 'error', 'plan'].includes(event.kind)) {
        completedRequests.add(event.requestId); if (completedRequests.size > 100) completedRequests.delete(completedRequests.values().next().value);
        requests.delete(event.requestId);
        if (!event.chatId && (event.requestId === planRequest || planStarting)) {
          planRequest = null;
          if (event.kind === 'plan' && event.plan) { plan = event.plan; renderPlan(); byId('decompose-status').textContent = `已生成 ${plan.steps.length} 步建议，编辑并选择后再加入。`; }
          else if (event.kind === 'error') { error('decompose-error', event.error || '步骤生成失败，请再试一次。'); byId('decompose-status').textContent = '生成没有完成，原有任务不受影响。'; }
          else if (event.kind === 'stopped') byId('decompose-status').textContent = '已停止生成，原有任务不受影响。';
          renderPlanControls();
        }
        if (event.chatId === chat?.id) {
          const id = chat.id; const revision = chatLoadRevision;
          try {
            const latest = await call('getChat', { chatId: id });
            if (id === chat?.id && revision === chatLoadRevision) {
              chat = latest; renderMessages();
              setChatStatus(event.kind === 'stopped' ? '已停止，已经收到的回复已保留。' : event.kind === 'error' ? '回复没有完成，已收到的文字已保留。' : '回复完成，消息已保存在本机。');
              if (event.kind === 'error') error('chat-error', event.error || '请求失败，请检查连接后重试。');
              else options.companion.greet();
            }
          } catch (err) { error('chat-error', err.message); }
        }
        try { await refreshHistory(); } catch (err) { if (!destroyed) error('chat-error', err.message); }
      }
    }

    listen(byId('ai-profile-form'), 'submit', saveProfile);
    listen(byId('ai-profile-select'), 'change', () => fillProfile(config.profiles.find(item => item.id === byId('ai-profile-select').value)));
    listen(byId('ai-profile-new'), 'click', () => { fillProfile(null); byId('ai-name').focus(); });
    listen(byId('ai-preset'), 'change', () => {
      const preset = PRESETS[byId('ai-preset').value];
      if (preset) for (const [key, id] of [['name', 'ai-name'], ['provider', 'ai-provider'], ['baseUrl', 'ai-base-url'], ['model', 'ai-model']]) byId(id).value = preset[key];
      markConfigDirty();
    });
    for (const id of ['ai-name', 'ai-provider', 'ai-base-url', 'ai-model', 'ai-key', 'ai-clear-key']) listen(byId(id), 'input', markConfigDirty);
    listen(byId('ai-test'), 'click', () => testConnection(false)); listen(byId('ai-models'), 'click', () => testConnection(true));
    for (const id of ['chat-configure', 'chat-connect', 'decompose-configure']) listen(byId(id), 'click', () => options.openSettings('ai'));
    listen(byId('chat-profile'), 'change', () => { renderMessages(); error('chat-error', ''); });
    listen(byId('chat-new'), 'click', newChat);
    listen(byId('chat-show-archived'), 'change', renderHistory);
    listen(byId('chat-history-toggle'), 'click', async () => {
      byId('chat-history').hidden = !byId('chat-history').hidden;
      byId('chat-history-toggle').setAttribute('aria-expanded', String(!byId('chat-history').hidden));
      if (!byId('chat-history').hidden) try { await refreshHistory(); } catch (err) { error('chat-error', err.message); }
    });
    listen(byId('chat-form'), 'submit', event => { event.preventDefault(); send(); });
    listen(byId('chat-stop'), 'click', stopChat);
    listen(byId('chat-input'), 'input', () => { storeDraft(); renderChatControls(); });
    listen(byId('chat-input'), 'keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } });
    listen(byId('chat-attach-task'), 'click', () => { chatTask = window.BuddyCompanion.activeTask(options.getState())?.title || null; renderChatControls(); });
    listen(byId('chat-task-remove'), 'click', () => { chatTask = null; renderChatControls(); });
    listen(byId('decompose-form'), 'submit', generatePlan);
    listen(byId('decompose-goal'), 'input', () => { writeLocal('decompose-goal', byId('decompose-goal').value); renderPlanControls(); });
    listen(byId('decompose-profile'), 'change', renderPlanControls);
    listen(byId('decompose-add'), 'click', addPlan);
    listen(byId('decompose-stop'), 'click', async () => { if (!planRequest) return; try { await call('stopChat', { requestId: planRequest }); } catch (err) { error('decompose-error', err.message); } });
    const unsubscribe = window.buddy.onAiEvent(aiEvent);
    byId('chat-input').value = readLocal(chatDraftKey()); byId('decompose-goal').value = readLocal('decompose-goal');
    renderChatControls(); renderPlanControls();

    const ready = Promise.all([call('getAiConfig'), call('listChats')]).then(async ([savedConfig, savedHistory]) => {
      if (destroyed) return;
      config = savedConfig; history = savedHistory; editingProfileId = config.activeProfileId;
      populateProfiles(); fillProfile(config.profiles.find(item => item.id === editingProfileId)); renderHistory();
      const lastChatId = readLocal('last-chat');
      if (history.some(item => item.id === lastChatId && !item.archived)) await selectChat(lastChatId);
    }).catch(err => { error('ai-config-error', err.message); error('chat-error', err.message); });
    return Object.freeze({
      ready,
      render() { renderChatControls(); },
      openDecompose() {
        const task = window.BuddyCompanion.activeTask(options.getState());
        if (task && !byId('decompose-goal').value.trim()) byId('decompose-goal').value = task.title;
        renderPlanControls();
      },
      destroy() { destroyed = true; storeDraft(); unsubscribe(); for (const remove of removers) remove(); }
    });
  }
  window.BuddyChat = Object.freeze({ create });
})();
