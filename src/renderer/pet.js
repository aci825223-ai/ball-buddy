(function () {
  'use strict';
  const speech = document.getElementById('pet-speech');
  const speechText = document.getElementById('pet-speech-text');
  const timer = document.getElementById('pet-timer');
  const pet = document.querySelector('.pet');
  const clearKeyboardReveal = () => { pet.dataset.keyboardReveal = 'false'; };
  const revealForKeyboard = event => {
    if (!event.altKey && !event.ctrlKey && !event.metaKey) pet.dataset.keyboardReveal = 'true';
  };
  clearKeyboardReveal();
  // Explicit programmatic focus during a drag can otherwise resemble keyboard focus.
  document.addEventListener('pointerdown', clearKeyboardReveal, true);
  document.addEventListener('keydown', revealForKeyboard, true);
  window.addEventListener('blur', clearKeyboardReveal);
  function setSpeech(text) {
    if (speechText.textContent !== text) speechText.textContent = text;
    speech.title = text;
  }
  setSpeech(speech.textContent);
  const appearance = window.BuddyAppearance.create({ onNotice: setSpeech });
  const companion = window.BuddyCompanion.create(document.getElementById('pet-ball'), setSpeech);
  let state = null;
  function renderTimer() {
    const round = state?.app?.study?.room?.round;
    const studyActive = round && ['running', 'paused'].includes(round.status);
    timer.hidden = !state?.session && !studyActive;
    if (state?.session || studyActive) timer.textContent = `${studyActive ? '共学 ' : ''}${(state?.session || round).status === 'paused' ? '暂停 ' : ''}${window.BuddyCompanion.formatTime(window.BuddyCompanion.remaining(state))}`;
  }
  function render(nextState) {
    state = nextState;
    appearance.apply(state);
    pet.dataset.hints = state.settings?.petHints === 'always' ? 'always' : 'hover';
    document.documentElement.style.setProperty('--pet-scale', String((state.settings?.petScale || 100) / 100));
    companion.update(state);
    renderTimer();
  }
  function openPanel() {
    window.buddy.openPanel().catch(() => { setSpeech('暂时打不开书桌，请再点一下。'); });
  }
  document.getElementById('pet-open-panel').addEventListener('click', openPanel);
  const unbindInteractions = window.BuddyInteractions.bind(document.getElementById('pet-ball-button'), companion, {
    draggable: true, onState: render, onError: setSpeech
  });
  let receivedState = false;
  const unsubscribe = window.buddy.onState(nextState => { receivedState = true; render(nextState); });
  window.buddy.getState().then(nextState => { if (!receivedState) render(nextState); }).catch(() => { setSpeech('没有读到进展，请重开应用。'); });
  const ticker = setInterval(renderTimer, 250);
  window.addEventListener('beforeunload', () => {
    document.removeEventListener('pointerdown', clearKeyboardReveal, true);
    document.removeEventListener('keydown', revealForKeyboard, true);
    window.removeEventListener('blur', clearKeyboardReveal);
    unsubscribe(); clearInterval(ticker); unbindInteractions(); companion.destroy(); appearance.destroy();
  });
})();
