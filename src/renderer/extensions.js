(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  function create(options) {
    let currentPage = 'desk';
    const companionSide = document.querySelector('.companion-side');
    const desk = byId('desk-page');
    const nav = document.querySelector('.page-nav');
    const labels = { desk: '书桌', chat: '聊天', study: '双人共学', decompose: '任务拆解' };
    const removers = [];
    function updatePageChrome(page) {
      byId('app-page-title').textContent = page === 'settings' ? '设置' : labels[page];
      document.body.dataset.page = page;
      const settingsButton = byId('settings-open');
      if (page === 'settings') settingsButton.setAttribute('aria-current', 'page');
      else settingsButton.removeAttribute('aria-current');
    }
    function listen(element, type, listener) { element.addEventListener(type, listener); removers.push(() => element.removeEventListener(type, listener)); }
    function showPage(page, focus = false) {
      if (!labels[page]) return;
      currentPage = page;
      updatePageChrome(page);
      byId('settings-page').hidden = true;
      byId('settings-open').setAttribute('aria-expanded', 'false');
      for (const name of Object.keys(labels)) byId(`${name}-page`).hidden = name !== page;
      if (page === 'desk') desk.insertBefore(companionSide, document.querySelector('.desk-store'));
      else if (page === 'chat') byId('chat-companion-slot').append(companionSide);
      nav.querySelectorAll('[data-page]').forEach(button => {
        if (button.dataset.page === page || page === 'decompose' && button.dataset.page === 'desk') button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      if (focus) {
        const target = byId(page === 'desk' ? 'task-input' : page === 'chat' ? 'chat-input' : page === 'study' ? 'study-nickname' : 'decompose-goal');
        if (!target.disabled && !target.closest('[hidden]')) target.focus({ preventScroll: true });
      }
      options.companion.update(options.getState());
      study.render();
      chat.render();
    }
    function settingsOpen() {
      updatePageChrome('settings');
      for (const name of Object.keys(labels)) byId(`${name}-page`).hidden = true;
      nav.querySelectorAll('[data-page]').forEach(button => button.removeAttribute('aria-current'));
      const backButton = byId('settings-back');
      backButton.lastChild.textContent = `返回${labels[currentPage]}`;
    }
    async function copy(text, done) {
      if (!text) return;
      try { await navigator.clipboard.writeText(text); options.showMessage(done || '已复制'); }
      catch { options.showMessage('复制没有完成，请选中文字后按 Ctrl + C。', true); }
    }
    const chat = window.BuddyChat.create({ ...options, copy });
    const study = window.BuddyStudy.create({ ...options, copy });
    nav.querySelectorAll('[data-page]').forEach(button => listen(button, 'click', () => showPage(button.dataset.page)));
    listen(byId('decompose-open'), 'click', () => { showPage('decompose', true); chat.openDecompose(); });
    listen(byId('decompose-back'), 'click', () => showPage('desk'));
    updatePageChrome(currentPage);
    return Object.freeze({
      ready: Promise.all([chat.ready, study.ready]),
      render() { chat.render(); study.render(); },
      settingsOpen,
      settingsBack() { showPage(currentPage); },
      currentPage: () => currentPage,
      destroy() { chat.destroy(); study.destroy(); for (const remove of removers) remove(); }
    });
  }
  window.BuddyExtensions = Object.freeze({ create });
})();
