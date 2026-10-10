(function () {
  'use strict';

  const EVENT_LIFETIME = 6500;
  const INTERACTION_LIFETIME = 3200;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CELEBRATIONS = new Set(['task-completed', 'focus-completed', 'study-completed', 'decoration-unlocked']);
  const COLOR_PALETTE = ['#F3F0EA', '#F2CFCB', '#CDE3D5', '#CDDFF0', '#DED2EE'];
  const CURSOR_RADIUS = 350;

  function smoothStep(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }

  function colorChannels(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function colorHex(channels) {
    return '#' + channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
  }

  function paletteColor(phase) {
    const position = phase * COLOR_PALETTE.length;
    const index = Math.floor(position) % COLOR_PALETTE.length;
    const from = colorChannels(COLOR_PALETTE[index]);
    const to = colorChannels(COLOR_PALETTE[(index + 1) % COLOR_PALETTE.length]);
    const blend = smoothStep(position - Math.floor(position));
    return colorHex(from.map((channel, channelIndex) => channel + (to[channelIndex] - channel) * blend));
  }

  function shadeColor(hex, amount) {
    const destination = amount < 0 ? 0 : 255;
    return colorHex(colorChannels(hex).map(channel => channel + (destination - channel) * Math.abs(amount)));
  }

  function remaining(state, now = Date.now()) {
    const round = state?.app?.study?.room?.round;
    if (!state?.session && round && ['running', 'paused'].includes(round.status)) return round.status === 'running'
      ? Math.max(0, round.endAt - now - (state.app.study.serverOffsetMs || 0)) : Math.max(0, round.remainingMs);
    if (!state || !state.session) return (state?.settings?.focusMinutes || 25) * 60000;
    const session = state.session;
    return session.status === 'running' ? Math.max(0, session.endAt - now) : Math.max(0, session.remainingMs);
  }

  function formatTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }

  function activeTask(state) {
    const taskId = state?.session ? state.session.taskId : state?.selectedTaskId;
    return state?.tasks?.find(task => task.id === taskId && (state?.session || task.completedAt === null)) || null;
  }

  function currentEvent(state, now = Date.now()) {
    const event = state?.lastEvent;
    return event && now - event.at < EVENT_LIFETIME && now >= event.at ? event : null;
  }

  function currentInteraction(state, now = Date.now()) {
    const interaction = state?.interaction;
    return interaction && now - interaction.at < INTERACTION_LIFETIME && now >= interaction.at ? interaction : null;
  }

  function motionMode(state) {
    const mode = state?.settings?.motionMode;
    return mode === 'gentle' || mode === 'static' ? mode : 'full';
  }

  function mood(state) {
    const event = currentEvent(state);
    if (event && CELEBRATIONS.has(event.kind)) return 4;
    const interaction = currentInteraction(state);
    if (interaction?.effect === 'spin' || interaction?.emotion === '30') return 5;
    if (interaction?.effect === 'drop' || interaction?.emotion === '03') return 2;
    if (interaction?.emotion === '13') return 6;
    if (interaction?.emotion === '14') return 7;
    if (interaction?.emotion) return 3;
    if (state?.app?.aiPresence?.busy) return 7;
    if (state?.app?.study?.room?.round?.status === 'running') return 1;
    if (state?.app?.study?.room?.round?.status === 'paused') return 2;
    if (state?.session?.status === 'running') return 1;
    if (state?.session?.status === 'paused') return 2;
    return 0;
  }

  function message(state) {
    const event = currentEvent(state);
    if (event?.kind === 'task-completed') return '又完成了一件事，为你撒花！';
    if (event?.kind === 'focus-completed') return '这一轮结束啦，伸个懒腰吧。';
    if (event?.kind === 'study-completed') return '一起完成了这一轮，给你们撒花！';
    if (event?.kind === 'decoration-unlocked') return '书桌又多了一点你的喜欢。';
    const interaction = currentInteraction(state);
    if (interaction?.message) return interaction.message;
    if (state?.app?.aiPresence?.busy) return '正在想办法，思路马上来。';
    if (state?.app?.study?.room?.round?.status === 'running') return '你和同桌一起专注，我也陪着。';
    if (state?.app?.study?.room?.round?.status === 'paused') return '共学暂停了，等大家准备好。';
    if (state?.session?.status === 'running') return '你忙你的，我在这里陪你。';
    if (state?.session?.status === 'paused') return '先歇一会儿，准备好再继续。';
    if (state?.tasks?.some(task => task.completedAt === null)) return '选一件小事，我们一起开始。';
    if (state?.tasks?.length) return '做得很好，现在可以慢一点。';
    return '写下一件想做的事吧。';
  }

  // Project-owned poses consume the upstream registration API. Vendor source stays intact.
  function registerPoses() {
    const presets = [
      { name: '同桌待机', pool: [0, 8, 21, 19], breathe: 0.036, lift: 7, tilt: 1.8, period: 4100 },
      { name: '陪你专注', pool: [7, 16, 11, 10], breathe: 0.024, lift: 2.4, tilt: 0.6, period: 4800,
        eyes: { left: { x: 3 }, right: { x: -3 } } },
      { name: '清醒休息', pool: [3, 21, 0, 15], breathe: 0.032, lift: 5.8, tilt: 2.4, period: 4400 },
      { name: '碰一碰', pool: [2, 11, 17, 19], breathe: 0.034, lift: 5.5, tilt: 2.2, period: 2400,
        color: '#F6EFE4', eyes: { both: { y: -2 } } },
      { name: '一起庆祝', pool: [2, 8, 17], breathe: 0.036, lift: 5.5, tilt: 2, period: 2200,
        color: '#F6EFE4', eyes: { both: { y: -3 } } },
      { name: '转圈招呼', pool: [3, 21, 2, 17], breathe: 0.034, lift: 5, tilt: 2.2, period: 2500 },
      { name: '惊喜', pool: [3, 21], breathe: 0.032, lift: 5, tilt: 1.2, period: 2800,
        eyes: { both: { scaleX: 1.12, scaleY: 1.12, y: -2 } } },
      { name: '害羞', pool: [0, 24, 13], breathe: 0.030, lift: 4, tilt: 3, period: 3800,
        color: '#F4D3D0', eyes: { both: { lookX: 5, lookY: 2 } } }
    ];
    for (const [modeIndex, mode] of ['full', 'gentle', 'static'].entries()) {
      presets.forEach((preset, index) => {
        const full = mode === 'full';
        const moving = mode !== 'static';
        const config = {
          id: String(50 + modeIndex * 10 + index), name: `${preset.name} · ${mode}`, group: 'custom',
          transition: full ? 380 : 460,
          gaze: moving,
          pool: moving ? preset.pool : [preset.pool[0]],
          poolMs: [2200, 4300], poolSpeed: 6,
          blinkMs: moving ? [2600, 4800] : null, openness: 1, antics: false,
          // Celebrations are keyed to event IDs below, rather than pose changes.
          body: { color: preset.color || '#F3F0EA', breathe: full ? preset.breathe : (moving ? 0.011 : 0),
            ribbons: 0, confetti: 0, orbit: 0, zzz: 0 },
          eyes: preset.eyes || {},
          anims: moving ? [
            { target: 'body', prop: 'y', type: 'sine', amp: full ? preset.lift : 0.5, period: preset.period },
            { target: 'body', prop: 'rotate', type: 'sine', amp: full ? preset.tilt : 0.25, period: preset.period + 900, phase: 0.8 },
            { target: 'eyes', prop: 'lookX', type: 'sine', amp: index === 1 ? 1.2 : 2.8, period: 3900 },
            { target: 'eyes', prop: 'lookY', type: 'sine', amp: 1.1, period: 4400, phase: 1.2 }
          ] : []
        };
        const result = window.EmotionBall.config.register(config);
        if (!result.ok) throw new Error(result.errors.join('；'));
      });
    }
  }

  function svgElement(name, attributes) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function create(target, onMessage) {
    let state = null;
    let engine = null;
    let character = null;
    let overlay = null;
    let lastMood = null;
    let mode = 'full';
    let transientMood = null;
    let transientUntil = 0;
    let expirationTimer = null;
    let isIntersecting = true;
    let suspended = false;
    let destroyed = false;
    let gestureAnimation = null;
    let gestureTransform = 'translate(0px, 0px) rotate(0deg) scale(1, 1)';
    let interactionCount = 0;
    let effectCount = 0;
    let colorPhase = 0;
    let colorLastTick = 0;
    let colorFrame = 0;
    let colorStops = [];
    let lastRenderedColor = null;
    let unsubscribeCursor = null;
    const nativeCursor = target.id === 'pet-ball' && typeof window.buddy?.onCursor === 'function';
    const seenInteractions = new Set();
    const seenEvents = new Set();
    const effects = new Set();
    target.classList.add('buddy-motion');
    target.dataset.motionMode = mode;
    target.dataset.motionActive = 'false';
    target.dataset.interactionCount = '0';
    target.dataset.effectCount = '0';
    target.dataset.colorActive = 'false';
    target.dataset.gazeX = '0.000';
    target.dataset.gazeY = '0.000';
    target.dataset.gazeSource = nativeCursor ? 'native' : 'local';

    function visible() {
      const nativeVisible = target.id === 'pet-ball' ? state?.app?.petVisible :
        target.id === 'main-ball' ? state?.app?.panelVisible : undefined;
      return nativeVisible !== false && !document.hidden && isIntersecting;
    }

    function emotionId() {
      const base = mode === 'full' ? 50 : mode === 'gentle' ? 60 : 70;
      return String(base + (Date.now() < transientUntil ? transientMood : mood(state)));
    }

    function createEngine() {
      engine = window.EmotionBall.create(target, { emotion: emotionId(), idle: false, lite: false,
        eyeScale: 1.3, label: '小球同桌的伙伴', autostart: false });
      character = engine.ball.svg;
      character.classList.add('buddy-character');
      // ball.svg is part of the public renderer return value. Change its existing
      // gradient, retaining the original highlight/shadow without private engine state.
      colorStops = Array.from(character.querySelector('radialGradient')?.querySelectorAll('stop') || []);
      lastRenderedColor = null;
      applyColor();
      const body = Array.from(character.children).find(node => node.tagName.toLowerCase() === 'g' &&
        node.children.length === 3 && node.firstElementChild?.tagName.toLowerCase() === 'path');
      body?.setAttribute('data-buddy-body', '');
      body?.children[1]?.setAttribute('data-buddy-eye', 'left');
      body?.children[2]?.setAttribute('data-buddy-eye', 'right');
      overlay = svgElement('svg', { class: 'buddy-fx', viewBox: '-15 -15 259 259',
        'aria-hidden': 'true', 'pointer-events': 'none' });
      target.appendChild(overlay);
      lastMood = emotionId();
    }

    function applyColor() {
      const color = paletteColor(colorPhase);
      target.dataset.buddyColor = color;
      target.dataset.colorPhase = colorPhase.toFixed(6);
      if (colorStops.length < 3) return;
      // A pose transition may refresh the upstream gradient; check its actual value
      // so the autonomous palette is restored in that same animation frame.
      if (color === lastRenderedColor && colorStops[1].getAttribute('stop-color') === color) return;
      colorStops[0].setAttribute('stop-color', shadeColor(color, 0.22));
      colorStops[1].setAttribute('stop-color', color);
      colorStops[2].setAttribute('stop-color', shadeColor(color, -0.12));
      lastRenderedColor = color;
    }

    function colorTick(now) {
      colorFrame = 0;
      if (destroyed || !visible() || mode === 'static') { colorLastTick = 0; return; }
      if (colorLastTick) {
        // Advance by rendered active time only; hidden windows keep their phase.
        colorPhase = (colorPhase + Math.min(now - colorLastTick, 100) / (mode === 'gentle' ? 72000 : 36000)) % 1;
      }
      colorLastTick = now;
      applyColor();
      colorFrame = requestAnimationFrame(colorTick);
    }

    function syncColor(active) {
      target.dataset.colorActive = String(active);
      if (active) {
        if (!colorFrame) {
          colorLastTick = 0;
          colorFrame = requestAnimationFrame(colorTick);
        }
      } else {
        cancelAnimationFrame(colorFrame);
        colorFrame = 0;
        colorLastTick = 0;
      }
    }

    function endEffect(effect) {
      clearTimeout(effect.timer);
      for (const animation of effect.animations) animation.cancel();
      effect.group.remove();
      effects.delete(effect);
    }

    function clearEffects() {
      for (const effect of [...effects]) endEffect(effect);
    }

    function resetGesture() {
      gestureAnimation?.cancel();
      gestureAnimation = null;
      gestureTransform = 'translate(0px, 0px) rotate(0deg) scale(1, 1)';
      target.style.setProperty('--buddy-gesture', gestureTransform);
      target.dataset.gesture = 'rest';
    }

    function syncActive() {
      if (!engine || destroyed) return;
      const active = visible() && mode !== 'static';
      if (!visible()) {
        engine.setActive(false);
        suspended = true;
        clearEffects();
        resetGesture();
        clearGaze();
      } else {
        // Resume with clean public engine resources so hidden particles never replay later.
        if (suspended) {
          engine.destroy();
          overlay?.remove();
          createEngine();
          suspended = false;
        }
        engine.setActive(active);
        const nextMood = emotionId();
        if (nextMood !== lastMood) {
          engine.setEmotion(nextMood);
          lastMood = nextMood;
        }
      }
      target.dataset.motionActive = String(active);
      // setEmotion renders immediately while static; restore the frozen palette
      // after that one render without starting a new animation frame loop.
      if (visible()) applyColor();
      syncColor(active);
    }

    function remember(ids, id) {
      if (!id || ids.has(id)) return false;
      ids.add(id);
      if (ids.size > 64) ids.delete(ids.values().next().value);
      return true;
    }

    function animate(node, frames, duration, record, easing = 'cubic-bezier(.2,.65,.25,1)') {
      const animation = node.animate(frames, { duration, easing, fill: 'forwards' });
      record.animations.push(animation);
    }

    function showEffect(kind) {
      if (!engine || !visible() || mode === 'static') return;
      effectCount += 1;
      target.dataset.effectCount = String(effectCount);
      while (effects.size >= 3) endEffect(effects.values().next().value);
      const group = svgElement('g', { 'data-buddy-effect': kind });
      const record = { group, animations: [], timer: null };
      effects.add(record);
      overlay.appendChild(group);
      const gentle = mode === 'gentle';
      if (gentle) {
        const glow = svgElement('circle', { cx: 114.5, cy: 114.5, r: 91,
          fill: '#93A987', stroke: 'none', opacity: 0 });
        group.appendChild(glow);
        animate(glow, [{ opacity: 0 }, { opacity: 0.10, offset: 0.3 }, { opacity: 0 }], 460, record);
      }
      if (!gentle) {
        const particleCount = kind === 'tap' ? 6 : 9;
        const colors = ['#C58B55', '#79966E', '#B9A053', '#C78572'];
        for (let index = 0; index < particleCount; index += 1) {
          const angle = index * Math.PI * 2 / particleCount - Math.PI / 2;
          const radius = 92;
          const x = 114.5 + Math.cos(angle) * radius;
          const y = 114.5 + Math.sin(angle) * radius;
          const node = svgElement(index % 3 ? 'circle' : 'path', index % 3 ?
            { cx: x, cy: y, r: 2.4, fill: colors[index % colors.length] } :
            { d: `M ${x - 4} ${y} H ${x + 4} M ${x} ${y - 4} V ${y + 4}`,
              fill: 'none', stroke: colors[index % colors.length], 'stroke-width': 1.8, 'stroke-linecap': 'round' });
          group.appendChild(node);
          animate(node, [{ opacity: 0.85, transform: 'translate(0px, 0px)' },
            { opacity: 0, transform: `translate(${(Math.cos(angle) * 25).toFixed(2)}px, ${(Math.sin(angle) * 25 - 8).toFixed(2)}px)` }],
          700 + index * 12, record);
        }
        if (kind === 'spin' || kind === 'celebrate') {
          engine.spin(1);
          engine.burst(kind === 'celebrate' ? 18 : 12);
        } else {
          engine.bounce();
          if (kind === 'tap') engine.burst(5);
        }
      }
      record.timer = setTimeout(() => endEffect(record), 850);
    }

    function update(nextState) {
      if (destroyed) return;
      state = nextState;
      const nextMode = motionMode(state);
      if (mode !== nextMode && engine) {
        // Requeue colour after the replacement engine's frame, keeping the phase.
        syncColor(false);
        mode = nextMode;
        clearEffects();
        resetGesture();
        engine.destroy();
        overlay?.remove();
        createEngine();
      } else {
        mode = nextMode;
      }
      target.dataset.motionMode = mode;
      syncActive();
      const interaction = currentInteraction(state);
      if (remember(seenInteractions, state?.interaction?.id)) {
        interactionCount += 1;
        target.dataset.interactionCount = String(interactionCount);
        if (interaction) showEffect(interaction.effect || (interaction.emotion === '30' ? 'spin' : 'tap'));
      }
      const event = currentEvent(state);
      if (remember(seenEvents, state?.lastEvent?.id) && event && CELEBRATIONS.has(event.kind)) showEffect('celebrate');
      if (onMessage) onMessage(message(state));
      clearTimeout(expirationTimer);
      const now = Date.now();
      const deadlines = [transientUntil, event ? event.at + EVENT_LIFETIME : 0,
        interaction ? interaction.at + INTERACTION_LIFETIME : 0].filter(deadline => deadline > now);
      if (deadlines.length) expirationTimer = setTimeout(() => update(state), Math.min(...deadlines) - now + 30);
    }

    function gaze(nx, ny) {
      if (engine && visible() && mode !== 'static') {
        const x = Math.max(-1, Math.min(1, nx));
        const y = Math.max(-1, Math.min(1, ny));
        engine.setGaze(x, y);
        target.dataset.gazeX = x.toFixed(3);
        target.dataset.gazeY = y.toFixed(3);
      }
    }

    function clearGaze() {
      engine?.clearGaze();
      target.dataset.gazeX = '0.000';
      target.dataset.gazeY = '0.000';
      target.dataset.cursorNear = 'false';
    }

    function cursorPosition(x, y) {
      if (!visible() || mode === 'static') return;
      const bounds = target.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const dx = x - bounds.left - bounds.width / 2;
      const dy = y - bounds.top - bounds.height / 2;
      const distance = Math.hypot(dx, dy);
      const strength = 1 - smoothStep((distance - 220) / (CURSOR_RADIUS - 220));
      const horizontal = Math.max(-1, Math.min(1, dx / (bounds.width * 0.65)));
      const vertical = Math.max(-1, Math.min(1, dy / (bounds.height * 0.8)));
      gaze(horizontal * strength, vertical * strength);
      target.dataset.cursorNear = String(distance < CURSOR_RADIUS);
    }

    function pointerMove(event) {
      if (!nativeCursor) cursorPosition(event.clientX, event.clientY);
    }

    function nativeCursorPosition(point) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      cursorPosition(point.x, point.y);
    }

    function cursorLeave() {
      // The native bridge still reports nearby positions outside the pet window.
      // Window blur/leave must not race that stream and force the eyes to centre.
      if (!nativeCursor) clearGaze();
    }

    function press() {
      if (!visible() || mode !== 'full') return;
      gestureAnimation?.cancel();
      gestureAnimation = null;
      gestureTransform = 'translate(0px, 3px) rotate(0deg) scale(1.07, .9)';
      target.style.setProperty('--buddy-gesture', gestureTransform);
      target.dataset.gesture = 'pressed';
    }

    function drag(dx, dy) {
      if (!visible() || mode !== 'full') return;
      const x = 8 * Math.tanh(Number(dx) / 48 || 0);
      const y = 5 * Math.tanh(Number(dy) / 48 || 0);
      const tilt = 7 * Math.tanh(Number(dx) / 48 || 0);
      gestureTransform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${tilt.toFixed(2)}deg) scale(1.04, .94)`;
      target.style.setProperty('--buddy-gesture', gestureTransform);
      target.dataset.gesture = 'dragging';
    }

    function release() {
      if (!character || mode !== 'full' || !visible()) { resetGesture(); return; }
      gestureAnimation?.cancel();
      const from = gestureTransform;
      gestureTransform = 'translate(0px, 0px) rotate(0deg) scale(1, 1)';
      target.style.setProperty('--buddy-gesture', gestureTransform);
      target.dataset.gesture = 'releasing';
      const animation = character.animate([
        { transform: from },
        { transform: 'translate(0px, -4px) rotate(0deg) scale(.97, 1.05)', offset: 0.4 },
        { transform: 'translate(0px, 1px) rotate(0deg) scale(1.02, .98)', offset: 0.7 },
        { transform: gestureTransform }
      ], { duration: 430, easing: 'cubic-bezier(.2,.7,.3,1)' });
      gestureAnimation = animation;
      animation.onfinish = () => {
        animation.cancel();
        if (gestureAnimation === animation) {
          gestureAnimation = null;
          target.dataset.gesture = 'rest';
        }
      };
    }

    try {
      if (!window.EmotionBall?.create) throw new Error('角色资源未加载');
      registerPoses();
      createEngine();
    } catch (error) {
      target.textContent = '小球正在休息';
      target.classList.add('ball-unavailable');
      console.error('无法载入小球动画：', error.message);
    }

    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      isIntersecting = entries[0]?.isIntersecting !== false;
      syncActive();
    }) : null;
    observer?.observe(target);
    if (nativeCursor) unsubscribeCursor = window.buddy.onCursor(nativeCursorPosition);
    document.addEventListener('visibilitychange', syncActive);
    document.addEventListener('pointermove', pointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', cursorLeave);
    window.addEventListener('blur', cursorLeave);
    syncActive();

    return {
      update,
      greet() {
        if (state?.session || currentEvent(state)) return;
        transientMood = 3;
        transientUntil = Date.now() + 1600;
        update(state);
        if (engine && visible() && mode === 'full') engine.bounce();
      },
      gaze,
      clearGaze,
      press,
      drag,
      release,
      destroy() {
        destroyed = true;
        syncColor(false);
        clearTimeout(expirationTimer);
        clearEffects();
        resetGesture();
        observer?.disconnect();
        unsubscribeCursor?.();
        document.removeEventListener('visibilitychange', syncActive);
        document.removeEventListener('pointermove', pointerMove);
        document.documentElement.removeEventListener('pointerleave', cursorLeave);
        window.removeEventListener('blur', cursorLeave);
        engine?.destroy();
        overlay?.remove();
        target.dataset.motionActive = 'false';
      }
    };
  }

  window.BuddyCompanion = Object.freeze({ create, remaining, formatTime, activeTask, currentEvent, message });
})();
