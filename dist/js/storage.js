(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShiftStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var STORAGE_KEY = 'smena.state.v1';

  function fail(message, code) {
    var error = new Error(message);
    error.code = code;
    throw error;
  }

  function createInitialState() {
    return {
      version: 1,
      employee: { name: 'Александр Иванов', position: 'Веб-разработчик' },
      shifts: []
    };
  }

  function isTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  }

  function invalid() {
    fail('Сохранённые данные повреждены или имеют неизвестный формат. Они не были изменены. Сохраните копию данных перед восстановлением.', 'INVALID_DATA');
  }

  // Проверяем записи при чтении: повреждённую историю нельзя молча заменить пустой.
  function validate(state) {
    if (!state || state.version !== 1 || !state.employee ||
        typeof state.employee.name !== 'string' || !state.employee.name.trim() ||
        typeof state.employee.position !== 'string' || !Array.isArray(state.shifts)) invalid();

    var ids = new Set();
    var activeCount = 0;
    state.shifts.forEach(function (shift) {
      if (!shift || typeof shift.id !== 'string' || !shift.id || ids.has(shift.id) ||
          !isTimestamp(shift.startedAt) || !Array.isArray(shift.breaks) ||
          !(shift.endedAt === null || isTimestamp(shift.endedAt)) ||
          (shift.endedAt !== null && shift.endedAt < shift.startedAt)) invalid();
      ids.add(shift.id);
      if (shift.endedAt === null) activeCount += 1;
      var previousEnd = shift.startedAt;
      shift.breaks.forEach(function (pause, index) {
        if (!pause || !isTimestamp(pause.startedAt) || pause.startedAt < previousEnd ||
            !(pause.endedAt === null || isTimestamp(pause.endedAt)) ||
            (pause.endedAt !== null && pause.endedAt < pause.startedAt) ||
            (shift.endedAt !== null && (pause.startedAt > shift.endedAt || pause.endedAt === null || pause.endedAt > shift.endedAt)) ||
            (pause.endedAt === null && index !== shift.breaks.length - 1)) invalid();
        previousEnd = pause.endedAt === null ? Infinity : pause.endedAt;
      });
    });
    if (activeCount > 1) invalid();

    var ordered = state.shifts.slice().sort(function (a, b) { return a.startedAt - b.startedAt; });
    for (var i = 1; i < ordered.length; i += 1) {
      if (ordered[i - 1].endedAt === null || ordered[i - 1].endedAt > ordered[i].startedAt) invalid();
    }
    return state;
  }

  function storage() {
    try {
      if (!root.localStorage) throw new Error('Unavailable');
      return root.localStorage;
    } catch (error) {
      fail('Браузер запретил доступ к хранилищу. Разрешите сохранение данных для этого сайта.', 'STORAGE_UNAVAILABLE');
    }
  }

  function load() {
    var raw;
    try {
      raw = storage().getItem(STORAGE_KEY);
    } catch (error) {
      if (error.code === 'STORAGE_UNAVAILABLE') throw error;
      fail('Не удалось прочитать данные браузера. Проверьте доступ к localStorage.', 'STORAGE_UNAVAILABLE');
    }
    if (raw === null) return createInitialState();
    var state;
    try { state = JSON.parse(raw); } catch (error) { invalid(); }
    return validate(state);
  }

  function save(state) {
    validate(state);
    try {
      // Сохраняем отметки времени, а не значение таймера: перезагрузка не теряет смену.
      storage().setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      if (error.code === 'STORAGE_UNAVAILABLE') throw error;
      fail('Не удалось сохранить изменения. Хранилище браузера недоступно или заполнено. Повторите действие после освобождения места.', 'SAVE_FAILED');
    }
    return state;
  }

  function getActive(state) {
    return state.shifts.find(function (shift) { return shift.endedAt === null; }) || null;
  }

  function requireNow(now, earliest) {
    if (!isTimestamp(now) || now < earliest) {
      fail('Время устройства изменилось. Проверьте дату и время перед продолжением смены.', 'INVALID_TIME');
    }
  }

  function id(now) {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return 'shift-' + now + '-' + Math.random().toString(36).slice(2, 12);
  }

  function replace(state, shift) {
    return Object.assign({}, state, {
      shifts: state.shifts.map(function (item) { return item.id === shift.id ? shift : item; })
    });
  }

  function activeOrFail(state) {
    validate(state);
    var active = getActive(state);
    if (!active) fail('Сначала начните рабочую смену.', 'NO_ACTIVE_SHIFT');
    return active;
  }

  function lastEvent(shift) {
    var lastBreak = shift.breaks[shift.breaks.length - 1];
    return lastBreak ? (lastBreak.endedAt === null ? lastBreak.startedAt : lastBreak.endedAt) : shift.startedAt;
  }

  function start(state, now) {
    if (now === undefined) now = Date.now();
    validate(state);
    if (getActive(state)) fail('У вас уже есть открытая смена. Завершите её перед началом новой.', 'ALREADY_ACTIVE');
    var latest = state.shifts.reduce(function (end, shift) { return Math.max(end, shift.endedAt); }, 0);
    requireNow(now, latest);
    return Object.assign({}, state, {
      shifts: state.shifts.concat({ id: id(now), startedAt: now, endedAt: null, breaks: [] })
    });
  }

  function pause(state, now) {
    if (now === undefined) now = Date.now();
    var active = activeOrFail(state);
    if (active.breaks.some(function (item) { return item.endedAt === null; })) {
      fail('Перерыв уже начат.', 'ALREADY_PAUSED');
    }
    requireNow(now, lastEvent(active));
    return replace(state, Object.assign({}, active, {
      breaks: active.breaks.concat({ startedAt: now, endedAt: null })
    }));
  }

  function resume(state, now) {
    if (now === undefined) now = Date.now();
    var active = activeOrFail(state);
    var last = active.breaks[active.breaks.length - 1];
    if (!last || last.endedAt !== null) fail('Сейчас нет активного перерыва.', 'NOT_PAUSED');
    requireNow(now, last.startedAt);
    return replace(state, Object.assign({}, active, {
      breaks: active.breaks.map(function (item) {
        return item.endedAt === null ? Object.assign({}, item, { endedAt: now }) : item;
      })
    }));
  }

  function finish(state, now) {
    if (now === undefined) now = Date.now();
    var active = activeOrFail(state);
    requireNow(now, lastEvent(active));
    // Завершение смены во время перерыва также закрывает сам перерыв.
    return replace(state, Object.assign({}, active, {
      endedAt: now,
      breaks: active.breaks.map(function (item) {
        return item.endedAt === null ? Object.assign({}, item, { endedAt: now }) : item;
      })
    }));
  }

  function overlap(startedAt, endedAt, from, to) {
    return Math.max(0, Math.min(endedAt, to) - Math.max(startedAt, from));
  }

  function metrics(shift, now) {
    if (now === undefined) now = Date.now();
    var end = shift.endedAt === null ? Math.max(shift.startedAt, now) : shift.endedAt;
    var totalMs = end - shift.startedAt;
    var breakMs = shift.breaks.reduce(function (sum, item) {
      return sum + overlap(item.startedAt, item.endedAt === null ? end : item.endedAt, shift.startedAt, end);
    }, 0);
    return {
      workMs: Math.max(0, totalMs - breakMs),
      breakMs: breakMs,
      totalMs: totalMs,
      status: shift.endedAt !== null ? 'finished' :
        (shift.breaks.some(function (item) { return item.endedAt === null; }) ? 'break' : 'working')
    };
  }

  // Пересечение интервалов корректно считает ночь, неделю и месяц на их границах.
  function workBetween(shift, from, to, now) {
    if (now === undefined) now = Date.now();
    if (to <= from) return 0;
    var end = shift.endedAt === null ? Math.max(shift.startedAt, now) : shift.endedAt;
    var clippedFrom = Math.max(from, shift.startedAt);
    var clippedTo = Math.min(to, end);
    var total = overlap(shift.startedAt, end, from, to);
    var pauses = shift.breaks.reduce(function (sum, item) {
      return sum + overlap(item.startedAt, item.endedAt === null ? end : item.endedAt, clippedFrom, clippedTo);
    }, 0);
    return Math.max(0, total - pauses);
  }

  function formatDuration(ms, seconds) {
    var totalSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor(totalSeconds / 60) % 60;
    var parts = [hours, minutes];
    if (seconds) parts.push(totalSeconds % 60);
    return parts.map(function (part) { return String(part).padStart(2, '0'); }).join(':');
  }

  function seedDemo(state, now) {
    if (now === undefined) now = Date.now();
    validate(state);
    requireNow(now, 0);
    var cursor = new Date(now);
    cursor.setHours(0, 0, 0, 0);
    var shifts = state.shifts.slice();
    var weekdays = 0;
    while (weekdays < 5) {
      cursor.setDate(cursor.getDate() - 1);
      if (cursor.getDay() === 0 || cursor.getDay() === 6) continue;
      weekdays += 1;
      var day = new Date(cursor);
      var from = day.getTime();
      day.setDate(day.getDate() + 1);
      var to = day.getTime();
      var occupied = shifts.some(function (shift) {
        return shift.startedAt < to && (shift.endedAt === null || shift.endedAt > from);
      });
      if (occupied) continue;
      var startDate = new Date(cursor);
      startDate.setHours(9, 0 + (weekdays % 3) * 5, 0, 0);
      var endDate = new Date(cursor);
      endDate.setHours(18, (weekdays % 2) * 10, 0, 0);
      var breakDate = new Date(cursor);
      breakDate.setHours(13, 0, 0, 0);
      shifts.push({
        id: 'demo-' + from,
        demo: true,
        startedAt: startDate.getTime(),
        endedAt: endDate.getTime(),
        breaks: [{ startedAt: breakDate.getTime(), endedAt: breakDate.getTime() + 45 * 60 * 1000 }]
      });
    }
    return validate(Object.assign({}, state, { shifts: shifts }));
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    createInitialState: createInitialState,
    load: load,
    save: save,
    validate: validate,
    getActive: getActive,
    start: start,
    pause: pause,
    resume: resume,
    finish: finish,
    metrics: metrics,
    workBetween: workBetween,
    formatDuration: formatDuration,
    seedDemo: seedDemo
  };
});
