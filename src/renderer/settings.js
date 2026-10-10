(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const FONT_NAMES = { system: '系统默认', yahei: '微软雅黑', segoe: 'Segoe UI' };
  const DEFAULT_SAVE_HINT = '外观等偏好自动保存；AI 连接需手动保存';

  function create(options) {
    const page = byId('settings-page');
    const workspace = document.querySelector('.workspace');
    const navButtons = [...page.querySelectorAll('[data-settings-section]')];
    const controls = [...page.querySelectorAll('.settings-content button, .settings-content input, .settings-content select')].filter(control => !control.hasAttribute('data-ai-control'));
    const removers = [];
    let externalBusy = true;
    let localBusy = false;
    let fontImporting = false;
    let pendingFontId = null;
    let scaleDraft = null;
    let destroyed = false;
    let returnFocusElement = null;

    function listen(element, type, callback) {
      element.addEventListener(type, callback);
      removers.push(() => element.removeEventListener(type, callback));
    }

    function status(text, kind = '') {
      const element = byId('settings-save-status');
      element.textContent = text;
      element.dataset.status = kind;
    }

    function showError(text) {
      const element = byId('settings-error');
      element.textContent = text || '';
      element.hidden = !text;
    }

    function updateDisabled() {
      for (const control of controls) control.disabled = externalBusy || localBusy;
      const supported = options.getState()?.app?.notificationsSupported !== false;
      byId('settings-notifications').disabled ||= !supported;
      byId('settings-font-custom-option').disabled = !options.getState()?.settings?.importedFont;
    }

    function setBusy(busy) {
      externalBusy = Boolean(busy);
      updateDisabled();
    }

    function render(state) {
      if (!state || destroyed) return;
      const settings = state.settings || {};
      page.setAttribute('aria-busy', 'false');
      page.querySelectorAll('[data-theme-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeMode === (settings.themeMode || 'system'))));
      page.querySelectorAll('[data-text-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.textSize === (settings.textSize || 'normal'))));
      page.querySelectorAll('[data-settings-motion]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.settingsMotion === (settings.motionMode || 'full'))));
      byId('settings-font-family').value = settings.fontFamily || 'system';
      const customOption = byId('settings-font-custom-option');
      customOption.textContent = settings.importedFont ? `已导入：${settings.importedFont.name}` : '已导入字体';
      byId('settings-close-behavior').value = settings.closeBehavior || 'tray';
      byId('settings-pet-hints').value = settings.petHints || 'hover';
      for (const [id, key, labelId] of [
        ['settings-open-panel-launch', 'openPanelOnLaunch', 'settings-launch-state'],
        ['settings-pet-always-on-top', 'petAlwaysOnTop', 'settings-top-state'],
        ['settings-notifications', 'notificationsEnabled', 'settings-notifications-state']
      ]) {
        byId(id).checked = settings[key] !== false;
        byId(labelId).textContent = settings[key] !== false ? '开启' : '关闭';
      }
      const scale = scaleDraft ?? settings.petScale ?? 100;
      byId('settings-pet-scale').value = String(scale);
      byId('settings-pet-scale').setAttribute('aria-valuetext', `${scale}%`);
      byId('settings-pet-scale-value').textContent = `${scale}%`;
      if (document.activeElement !== byId('settings-focus-minutes')) byId('settings-focus-minutes').value = String(settings.focusMinutes || 25);
      byId('settings-notifications-note').textContent = state.app?.notificationsSupported === false
        ? '当前系统不支持通知，小球和书桌仍会显示专注完成结果。'
        : '完成时发送静音系统通知，小球和书桌也会显示结果。';
      byId('settings-version').textContent = state.app?.version ? `小球同桌 ${state.app.version} · 设置保存在本机` : '设置保存在本机';
      if (!fontImporting) {
        byId('settings-font-preview').style.removeProperty('font-family');
        const fontName = settings.fontFamily === 'custom' ? settings.importedFont?.name || '导入字体' : FONT_NAMES[settings.fontFamily] || FONT_NAMES.system;
        const fallback = settings.fontFamily === 'custom' && document.documentElement.dataset.fontStatus === 'fallback';
        byId('settings-font-name').textContent = `当前：${fontName}${fallback ? '（暂用系统字体）' : ''}`;
        byId('settings-font-note').dataset.fallback = String(fallback);
        byId('settings-font-note').textContent = fallback
          ? '已导入的字体无法读取，已回退系统字体。重新导入字体即可恢复。'
          : '支持 TTF、OTF、WOFF、WOFF2，单个文件至多 32 MB。';
      }
      updateDisabled();
    }

    function restoreValues() {
      // A focused draft also needs to return to the saved value when a write fails.
      byId('settings-focus-minutes').value = String(options.getState()?.settings?.focusMinutes || 25);
      render(options.getState());
    }

    async function save(command, savedText = '已保存') {
      if (localBusy || externalBusy || !options.getState()) { restoreValues(); return false; }
      localBusy = true;
      showError('');
      status('正在保存…', 'saving');
      updateDisabled();
      try {
        const ok = await options.runCommand(command);
        if (!ok) {
          restoreValues();
          showError('设置没有保存，仍使用原来的值。请再试一次。');
          status('没有保存', 'error');
          return false;
        }
        byId('settings-focus-minutes').removeAttribute('aria-invalid');
        status(savedText, 'saved');
        return true;
      } catch (error) {
        restoreValues();
        showError(error.message || '设置没有保存，仍使用原来的值。');
        status('没有保存', 'error');
        return false;
      } finally {
        localBusy = false;
        updateDisabled();
      }
    }

    async function nativeAction(action, savedText) {
      if (localBusy || externalBusy || !options.getState()) return;
      localBusy = true;
      options.setNativeBusy(true);
      showError('');
      status('正在保存…', 'saving');
      updateDisabled();
      try {
        const result = await action();
        if (!result?.ok) throw new Error(result?.error || '没有完成操作，请再试一次。');
        if (result.state) options.onState(result.state);
        status(savedText, 'saved');
      } catch (error) {
        restoreValues();
        showError(error.message);
        status('没有保存', 'error');
      } finally {
        localBusy = false;
        options.setNativeBusy(false);
        updateDisabled();
      }
    }

    async function importFont() {
      if (localBusy || externalBusy || !options.getState()) return;
      localBusy = true;
      fontImporting = true;
      options.setNativeBusy(true);
      showError('');
      status('请选择字体文件…', 'saving');
      updateDisabled();
      try {
        const result = await window.buddy.importFont();
        if (!result?.ok) throw new Error(result?.error || '字体没有导入，请再试一次。');
        if (result.cancelled) { status('未选择字体，保持原设置'); return; }
        pendingFontId = result.pendingId;
        if (!pendingFontId || !result.font) throw new Error('没有读到字体文件，请再试一次。');
        status('正在读取字体…', 'saving');
        const family = await options.appearance.previewFont(result.font, result.bytes);
        byId('settings-font-preview').style.fontFamily = family;
        byId('settings-font-name').textContent = `预览：${result.font.name}`;
        status('字体已读取，正在保存…', 'saving');
        const confirmed = await window.buddy.confirmFontImport(pendingFontId);
        if (!confirmed?.ok) throw new Error(confirmed?.error || '字体没有保存，仍使用原字体。');
        pendingFontId = null;
        options.onState(confirmed.state);
        status('字体已导入并保存', 'saved');
      } catch (error) {
        showError(error.message || '字体无法读取，仍使用原字体。');
        status('没有导入，保持原字体', 'error');
      } finally {
        if (pendingFontId) {
          const id = pendingFontId;
          pendingFontId = null;
          try { await window.buddy.cancelFontImport(id); } catch { /* The saved font is unchanged. */ }
        }
        fontImporting = false;
        localBusy = false;
        options.setNativeBusy(false);
        render(options.getState());
      }
    }

    function open(section) {
      if (page.hidden) returnFocusElement = document.activeElement;
      options.onOpen?.();
      workspace.hidden = true;
      page.hidden = false;
      byId('settings-open').setAttribute('aria-expanded', 'true');
      page.querySelector('.settings-content').scrollTo(0, 0);
      byId('settings-heading').focus({ preventScroll: true });
      if (typeof section === 'string') {
        const target = navButtons.find(button => button.dataset.settingsSection === section);
        if (target) navigate(target);
      } else {
        navigate(navButtons.find(button => button.dataset.settingsSection === 'appearance'));
        if (!byId('settings-save-status').dataset.status) byId('settings-save-status').textContent = DEFAULT_SAVE_HINT;
      }
    }

    function back() {
      page.hidden = true;
      workspace.hidden = false;
      options.onBack?.();
      byId('settings-open').setAttribute('aria-expanded', 'false');
      window.scrollTo(0, 0);
      const canRestore = returnFocusElement?.isConnected && !returnFocusElement.disabled
        && returnFocusElement.matches('button, input, select, textarea, a[href], [tabindex]')
        && !returnFocusElement.closest('[hidden]') && returnFocusElement.getClientRects().length > 0
        && getComputedStyle(returnFocusElement).visibility !== 'hidden';
      (canRestore ? returnFocusElement : byId('settings-open')).focus({ preventScroll: true });
      returnFocusElement = null;
    }

    function navigate(button) {
      for (const item of navButtons) item.setAttribute('aria-current', String(item === button));
      const aiSection = button.dataset.settingsSection === 'ai';
      const feedback = byId('settings-save-status');
      if (aiSection || !feedback.dataset.status) {
        feedback.textContent = aiSection ? 'AI 连接需手动保存；外观等偏好自动保存' : DEFAULT_SAVE_HINT;
        feedback.dataset.status = '';
      }
      for (const section of page.querySelectorAll('.settings-section')) {
        section.hidden = section.id !== `settings-section-${button.dataset.settingsSection}`;
      }
      page.querySelector('.settings-content').scrollTo(0, 0);
    }

    listen(byId('settings-open'), 'click', () => open());
    listen(byId('settings-back'), 'click', back);
    listen(document, 'keydown', event => {
      if (event.key === 'Escape' && !page.hidden && !localBusy) { event.preventDefault(); back(); }
    });
    navButtons.forEach((button, index) => {
      listen(button, 'click', () => navigate(button));
      listen(button, 'keydown', event => {
        let nextIndex;
        if (event.key === 'ArrowDown') nextIndex = (index + 1) % navButtons.length;
        if (event.key === 'ArrowUp') nextIndex = (index + navButtons.length - 1) % navButtons.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = navButtons.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        navButtons[nextIndex].focus({ preventScroll: true });
        navigate(navButtons[nextIndex]);
      });
    });
    page.querySelectorAll('[data-theme-mode]').forEach(button => listen(button, 'click', () => save({ type: 'settings.update', themeMode: button.dataset.themeMode })));
    page.querySelectorAll('[data-text-size]').forEach(button => listen(button, 'click', () => save({ type: 'settings.update', textSize: button.dataset.textSize })));
    page.querySelectorAll('[data-settings-motion]').forEach(button => listen(button, 'click', () => save({ type: 'settings.update', motionMode: button.dataset.settingsMotion })));
    for (const [id, key] of [
      ['settings-font-family', 'fontFamily'], ['settings-close-behavior', 'closeBehavior'], ['settings-pet-hints', 'petHints']
    ]) listen(byId(id), 'change', () => save({ type: 'settings.update', [key]: byId(id).value }));
    for (const [id, key] of [
      ['settings-open-panel-launch', 'openPanelOnLaunch'], ['settings-pet-always-on-top', 'petAlwaysOnTop'], ['settings-notifications', 'notificationsEnabled']
    ]) listen(byId(id), 'change', () => save({ type: 'settings.update', [key]: byId(id).checked }));
    listen(byId('settings-font-reset'), 'click', () => save({ type: 'settings.update', fontFamily: 'system' }, '已恢复系统字体'));
    listen(byId('settings-font-import'), 'click', importFont);
    listen(byId('settings-pet-scale'), 'input', () => {
      scaleDraft = Number(byId('settings-pet-scale').value);
      byId('settings-pet-scale-value').textContent = `${scaleDraft}%`;
      byId('settings-pet-scale').setAttribute('aria-valuetext', `${scaleDraft}%`);
    });
    listen(byId('settings-pet-scale'), 'change', () => {
      const petScale = Number(byId('settings-pet-scale').value);
      scaleDraft = null;
      save({ type: 'settings.update', petScale });
    });
    listen(byId('settings-pet-position-reset'), 'click', () => nativeAction(() => window.buddy.resetPetPosition(), '小球已回到当前屏幕右下角'));
    listen(byId('settings-focus-minutes'), 'input', () => {
      byId('settings-focus-minutes').removeAttribute('aria-invalid');
      showError('');
    });
    listen(byId('settings-focus-minutes'), 'change', () => {
      const input = byId('settings-focus-minutes');
      if (!input.value || !input.checkValidity()) {
        input.setAttribute('aria-invalid', 'true');
        showError('填写 1–180 之间的整数分钟数。');
        status('时长没有保存', 'error');
        return;
      }
      save({ type: 'settings.update', focusMinutes: Number(input.value) });
    });
    listen(byId('settings-reset'), 'click', () => {
      scaleDraft = null;
      save({ type: 'settings.reset' }, '已恢复默认偏好，任务与奖励已保留');
    });

    return Object.freeze({
      render, setBusy, open, back,
      destroy() {
        destroyed = true;
        for (const remove of removers) remove();
        if (pendingFontId) window.buddy.cancelFontImport(pendingFontId).catch(() => {});
      }
    });
  }

  window.BuddySettings = Object.freeze({ create });
})();
