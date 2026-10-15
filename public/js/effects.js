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

    // Общий фон закреплён за окном: один набор полос для всех разделов и входа.
    const background = document.createElement('div');
    background.className = 'ambient-background';
    background.setAttribute('aria-hidden', 'true');
    background.setAttribute('inert', '');
    const bandCards = [background];
    const bandsByCard = new Map();
    bandCards.forEach(card => {
      const layer = document.createElement('div');
      layer.className = 'light-bands';
      layer.setAttribute('aria-hidden', 'true');
      layer.setAttribute('inert', '');
      const bandCount = 18;
      const bands = Array.from({ length: bandCount }, (_, index) => {
        const band = document.createElement('i');
        band.style.setProperty('--band-rest-scale', (.66 + Math.sin(index * .63 + .4) * .15).toFixed(3));
        band.style.setProperty('--band-rest-opacity', (.2 + index / (bandCount - 1) * .2).toFixed(3));
        layer.append(band);
        return band;
      });
      card.prepend(layer);
      card.classList.add('bands-ready');
      bandsByCard.set(card, bands);
    });
    document.body.prepend(background);
    document.body.classList.add('ambient-ready');

    // На старых браузерах и сенсорных устройствах сохраняется обычная статичная страница.
    if (!window.matchMedia || !window.requestAnimationFrame || !('PointerEvent' in window)) return;
    const precisePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const enabled = () => precisePointer.matches && !reducedMotion.matches && !document.hidden;
    const cards = [...bandCards];
    document.querySelectorAll('.kinetic-word').forEach(word => {
      if (!cards.some(card => card.contains(word))) cards.push(word);
    });
    const state = cards.map(card => ({
      card,
      frame: null,
      point: null,
      bands: bandsByCard.get(card) || [],
      letters: card.matches('.kinetic-word') ? [...card.children].filter(child => child.tagName === 'SPAN') : [...card.querySelectorAll('.kinetic-word > span')]
    }));

    const reset = item => {
      if (item.frame !== null) window.cancelAnimationFrame(item.frame);
      item.frame = null;
      item.point = null;
      item.card.style.removeProperty('--spot-x');
      item.card.style.removeProperty('--spot-y');
      item.card.style.removeProperty('--spot-active');
      item.bands.forEach(band => {
        ['--band-scale', '--band-rise', '--band-drift', '--band-opacity'].forEach(property => band.style.removeProperty(property));
      });
      item.letters.forEach(letter => letter.style.removeProperty('--letter-weight'));
    };

    const move = (item, event) => {
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
          if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.top >= window.innerHeight) {
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
          item.bands.forEach((band, index) => {
            const distance = ((index + .5) / item.bands.length - x / 100) * 4.8;
            const proximity = Math.exp(-distance * distance);
            const lift = 10 + (1 - y / 100) * 24;
            const restScale = .66 + Math.sin(index * .63 + .4) * .15;
            band.style.setProperty('--band-scale', (restScale + proximity * (.24 + (1 - y / 100) * .38)).toFixed(3));
            band.style.setProperty('--band-rise', `${(-proximity * lift).toFixed(2)}px`);
            band.style.setProperty('--band-drift', `${((x / 100 - .5) * 18 * proximity).toFixed(2)}px`);
            band.style.setProperty('--band-opacity', (.2 + index / (item.bands.length - 1) * .2 + proximity * .46).toFixed(3));
          });
          item.letters.forEach((letter, index) => letter.style.setProperty('--letter-weight', String(weights[index])));
        });
    };
    // Свет реагирует на движение по всей странице, даже когда курсор рядом с панелью.
    document.addEventListener('pointermove', event => state.forEach(item => move(item, event)), { passive: true });
    ['pointerleave', 'pointercancel'].forEach(type => {
      document.addEventListener(type, () => state.forEach(reset), { passive: true });
    });
    document.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse') state.forEach(reset);
    }, { passive: true });

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
      state.forEach(reset);
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
