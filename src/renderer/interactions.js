(function () {
  'use strict';

  // Pointer coordinates remain in screen space while the transparent window moves.
  function bind(control, companion, options = {}) {
    let gesture = null;
    let suppressedUntil = 0;
    let queuedPosition = null;
    let moveWork = null;
    let finishing = false;
    let disposed = false;
    const handlers = [];

    function listen(name, listener) {
      control.addEventListener(name, listener);
      handlers.push([name, listener]);
    }

    function reportError() {
      options.onError?.('暂时没接住这一下，请再试一次。');
    }

    async function act(action) {
      if (disposed) return;
      try {
        const result = await window.buddy.command({ type: 'pet.play', action });
        if (!result?.ok) throw new Error(result?.error);
        options.onState?.(result.state);
      } catch { reportError(); }
    }

    function queueMove(position) {
      queuedPosition = position;
      if (moveWork) return moveWork;
      moveWork = Promise.resolve().then(async () => {
        try {
          while (queuedPosition && !disposed) {
            const next = queuedPosition;
            queuedPosition = null;
            await window.buddy.movePet(next);
          }
        } catch {
          queuedPosition = null;
          reportError();
        } finally {
          // Clear before this worker resolves so a newly queued last move starts a fresh worker.
          moveWork = null;
        }
      });
      return moveWork;
    }

    function moveGesture(current) {
      if (!current.dragged || !current.position) return;
      queueMove({ x: current.position.x + current.dx, y: current.position.y + current.dy });
    }

    listen('pointerdown', event => {
      if (event.button !== 0 || gesture || finishing) return;
      control.focus({ preventScroll: true });
      companion.press();
      if (!options.draggable) return;
      event.preventDefault();
      const current = { pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY,
        dx: 0, dy: 0, dragged: false, position: null };
      gesture = current;
      control.setPointerCapture(event.pointerId);
      current.ready = window.buddy.getPetPosition().then(position => {
        current.position = position;
        if (gesture === current) moveGesture(current);
      }).catch(reportError);
    });

    listen('pointermove', event => {
      const current = gesture;
      if (!current || event.pointerId !== current.pointerId) return;
      current.dx = event.screenX - current.screenX;
      current.dy = event.screenY - current.screenY;
      if (!current.dragged && Math.hypot(current.dx, current.dy) > 5) {
        current.dragged = true;
        control.dataset.dragging = 'true';
      }
      if (current.dragged) {
        companion.drag(current.dx, current.dy);
        moveGesture(current);
      }
    });

    async function finish(event) {
      const current = gesture;
      if (!current) { companion.release(); return; }
      if (event.pointerId !== current.pointerId) return;
      if (event.type === 'pointerup') {
        current.dx = event.screenX - current.screenX;
        current.dy = event.screenY - current.screenY;
        current.dragged ||= Math.hypot(current.dx, current.dy) > 5;
      }
      if (!current.dragged) {
        gesture = null;
        control.dataset.dragging = 'false';
        if (control.hasPointerCapture(current.pointerId)) control.releasePointerCapture(current.pointerId);
        companion.release();
        return;
      }
      finishing = true;
      gesture = null;
      control.dataset.dragging = 'false';
      if (current.dragged) {
        suppressedUntil = Date.now() + 400;
        event.preventDefault();
      }
      if (control.hasPointerCapture(current.pointerId)) control.releasePointerCapture(current.pointerId);
      try {
        await current.ready;
        if (disposed) return;
        if (current.dragged && current.position) {
          await queueMove({ x: current.position.x + current.dx, y: current.position.y + current.dy });
        }
        if (disposed) return;
        companion.release();
        if (current.dragged) await act('drop');
      } finally {
        finishing = false;
      }
    }

    listen('pointerup', finish);
    listen('pointercancel', finish);
    listen('lostpointercapture', finish);
    listen('pointerleave', () => { if (!gesture) companion.release(); });
    listen('click', event => {
      if (finishing || Date.now() < suppressedUntil || event.detail > 1) {
        event.preventDefault();
        return;
      }
      companion.release();
      act('tap');
    });
    listen('dblclick', event => {
      event.preventDefault();
      if (Date.now() >= suppressedUntil) act('spin');
    });

    return () => {
      disposed = true;
      queuedPosition = null;
      const current = gesture;
      gesture = null;
      if (current && control.hasPointerCapture(current.pointerId)) control.releasePointerCapture(current.pointerId);
      for (const [name, listener] of handlers) control.removeEventListener(name, listener);
      companion.release();
    };
  }

  window.BuddyInteractions = Object.freeze({ bind });
})();
