/* Декоративные эффекты. Учёт времени, авторизация и действия не затрагиваются. */
(() => {
  'use strict';

  const initialize = () => {
    const labelSelector = '.nav-link, .button, .text-button';

    // Заменяем только собственные текстовые узлы кнопки: SVG и вложенные элементы остаются на месте.
    const enhanceLabel = element => {
      if (!element.isConnected || !element.matches(labelSelector)) return;
      [...element.childNodes].forEach(node => {
        if (node.nodeType !== Node.TEXT_NODE || !/\S/.test(node.data)) return;
        const wrapper = document.createElement('span');
        const line = document.createElement('span');
        const clone = document.createElement('span');
        wrapper.className = 'roll-label';
        line.className = 'roll-line';
        clone.className = 'roll-clone';
        clone.setAttribute('aria-hidden', 'true');
        line.textContent = node.data;
        clone.textContent = node.data;
        wrapper.append(line, clone);
        node.replaceWith(wrapper);
      });
    };
    document.querySelectorAll(labelSelector).forEach(enhanceLabel);

    // Наблюдаем только места, где приложение заново создаёт подписи или кнопки строк.
    // На время собственного оформления наблюдение выключено: цепочки самоповторов нет.
    if (window.MutationObserver) {
      const roots = [...document.querySelectorAll('#auth-submit, #confirm-button, #history-table, #recent-shifts, #employees-table')];
      const observeRoots = () => roots.forEach(root => observer.observe(root, { childList: true, subtree: true }));
      const observer = new MutationObserver(records => {
        const candidates = new Set();
        records.forEach(record => {
          if (record.target instanceof Element && record.target.matches(labelSelector)) candidates.add(record.target);
          record.addedNodes.forEach(node => {
            if (!(node instanceof Element) || node.closest('.roll-label')) return;
            if (node.matches(labelSelector)) candidates.add(node);
            node.querySelectorAll(labelSelector).forEach(element => candidates.add(element));
          });
        });
        if (!candidates.size) return;
        observer.disconnect();
        candidates.forEach(enhanceLabel);
        observeRoots();
      });
      observeRoots();
    }

    // На старых браузерах и сенсорных устройствах сохраняется обычная статичная страница.
    if (!window.matchMedia || !window.requestAnimationFrame || !('PointerEvent' in window)) return;
    const precisePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const enabled = () => precisePointer.matches && !reducedMotion.matches && !document.hidden;
    const cards = [...document.querySelectorAll('.auth-story, .timer-card')];
    document.querySelectorAll('.kinetic-word').forEach(word => {
      if (!cards.some(card => card.contains(word))) cards.push(word);
    });
    const state = cards.map(card => ({
      card,
      frame: null,
      point: null,
      letters: card.matches('.kinetic-word') ? [...card.children].filter(child => child.tagName === 'SPAN') : [...card.querySelectorAll('.kinetic-word > span')]
    }));

    const reset = item => {
      if (item.frame !== null) window.cancelAnimationFrame(item.frame);
      item.frame = null;
      item.point = null;
      item.card.style.removeProperty('--spot-x');
      item.card.style.removeProperty('--spot-y');
      item.card.style.removeProperty('--spot-active');
      item.letters.forEach(letter => letter.style.removeProperty('--letter-weight'));
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
          // Сначала читаем все размеры, затем меняем стили — не чередуем запись и измерения.
          const weights = item.letters.map(letter => {
            const rect = letter.getBoundingClientRect();
            const radius = Math.max(160, rect.height * 1.7);
            const distance = Math.hypot(item.point.x - rect.left - rect.width / 2, item.point.y - rect.top - rect.height / 2);
            const proximity = Math.max(0, 1 - distance / radius);
            return Math.round(450 + proximity * 300);
          });
          item.card.style.setProperty('--spot-x', `${x.toFixed(2)}%`);
          item.card.style.setProperty('--spot-y', `${y.toFixed(2)}%`);
          item.card.style.setProperty('--spot-active', '1');
          item.letters.forEach((letter, index) => letter.style.setProperty('--letter-weight', String(weights[index])));
        });
      }, { passive: true });

      ['pointerleave', 'pointercancel'].forEach(type => {
        item.card.addEventListener(type, () => reset(item), { passive: true });
      });
      item.card.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse') reset(item);
      }, { passive: true });
    });

    const sweep = document.createElement('div');
    sweep.className = 'view-sweep';
    sweep.setAttribute('aria-hidden', 'true');
    sweep.setAttribute('inert', '');
    sweep.style.pointerEvents = 'none';
    for (let index = 0; index < 7; index += 1) {
      const bar = document.createElement('i');
      bar.style.setProperty('--sweep-index', String(index));
      sweep.append(bar);
    }
    document.body.append(sweep);
    let sweepTimer = null;
    const stopSweep = () => {
      if (sweepTimer !== null) window.clearTimeout(sweepTimer);
      sweepTimer = null;
      document.body.classList.remove('view-transition');
    };
    document.addEventListener('smena:viewchange', () => {
      stopSweep();
      if (!enabled()) return;
      // Однократное измерение позволяет перезапустить переход при быстром выборе другого раздела.
      void sweep.offsetWidth;
      document.body.classList.add('view-transition');
      sweepTimer = window.setTimeout(stopSweep, 350);
    });

    const resetAll = () => { state.forEach(reset); stopSweep(); };
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
