/* Небольшое свечение следует за мышью внутри декоративных карточек. */
(() => {
  'use strict';

  const initialize = () => {
    if (!window.matchMedia || !window.requestAnimationFrame || !('PointerEvent' in window)) return;

    const precisePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const cards = [...document.querySelectorAll('.auth-story, .timer-card')];
    const state = cards.map(card => ({ card, frame: null, point: null }));
    const enabled = () => precisePointer.matches && !reducedMotion.matches && !document.hidden;

    const reset = item => {
      if (item.frame !== null) window.cancelAnimationFrame(item.frame);
      item.frame = null;
      item.point = null;
      item.card.style.removeProperty('--spot-x');
      item.card.style.removeProperty('--spot-y');
      item.card.style.removeProperty('--spot-active');
    };

    state.forEach(item => {
      item.card.addEventListener('pointermove', event => {
        if (!enabled() || event.pointerType !== 'mouse') {
          reset(item);
          return;
        }
        item.point = { x: event.clientX, y: event.clientY };
        if (item.frame !== null) return;

        item.frame = window.requestAnimationFrame(() => {
          item.frame = null;
          if (!enabled() || !item.point) {
            reset(item);
            return;
          }
          const bounds = item.card.getBoundingClientRect();
          if (!bounds.width || !bounds.height) {
            reset(item);
            return;
          }
          const clamp = value => Math.min(100, Math.max(0, value));
          const x = clamp((item.point.x - bounds.left) / bounds.width * 100);
          const y = clamp((item.point.y - bounds.top) / bounds.height * 100);
          item.card.style.setProperty('--spot-x', `${x.toFixed(2)}%`);
          item.card.style.setProperty('--spot-y', `${y.toFixed(2)}%`);
          item.card.style.setProperty('--spot-active', '1');
        });
      }, { passive: true });

      ['pointerleave', 'pointercancel'].forEach(type => {
        item.card.addEventListener(type, () => reset(item), { passive: true });
      });
      item.card.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse') reset(item);
      }, { passive: true });
    });

    const resetAll = () => state.forEach(reset);
    const observePreference = media => {
      if (media.addEventListener) media.addEventListener('change', resetAll);
      else if (media.addListener) media.addListener(resetAll);
    };
    observePreference(precisePointer);
    observePreference(reducedMotion);
    document.addEventListener('visibilitychange', resetAll);
    window.addEventListener('blur', resetAll);
    window.addEventListener('pagehide', resetAll);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
