'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../dist/js/storage.js');
const minute = 60 * 1000;
const hour = 60 * minute;
const start = Date.parse('2026-10-15T09:00:00+05:00');

function mockStorage(initial) {
  const values = new Map(initial ? [[store.STORAGE_KEY, initial]] : []);
  global.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value))
  };
  return values;
}

test('сохранение и загрузка сохраняют отметки, сотрудника и активный перерыв', () => {
  mockStorage();
  assert.equal(store.load().shifts.length, 0);
  const state = store.pause(store.start(store.load(), start), start + hour);
  store.save(state);
  assert.deepEqual(store.load(), state);
  assert.equal(store.metrics(store.getActive(store.load()), start + 2 * hour).workMs, hour);
});

test('смена с несколькими перерывами считает только рабочее время и не изменяет старые состояния', () => {
  const empty = store.createInitialState();
  const started = store.start(empty, start);
  const paused = store.pause(started, start + 2 * hour);
  const resumed = store.resume(paused, start + 2.5 * hour);
  const pausedAgain = store.pause(resumed, start + 5 * hour);
  const resumedAgain = store.resume(pausedAgain, start + 5.25 * hour);
  const finished = store.finish(resumedAgain, start + 8 * hour);
  assert.deepEqual(store.metrics(finished.shifts[0]), {
    workMs: 7.25 * hour, breakMs: 0.75 * hour, totalMs: 8 * hour, status: 'finished'
  });
  assert.equal(empty.shifts.length, 0);
  assert.equal(started.shifts[0].breaks.length, 0);
  assert.equal(paused.shifts[0].breaks[0].endedAt, null);
  assert.equal(resumedAgain.shifts[0].endedAt, null);
  assert.equal(store.getActive(finished), null);
});

test('завершение во время перерыва закрывает перерыв', () => {
  const paused = store.pause(store.start(store.createInitialState(), start), start + hour);
  assert.equal(store.metrics(paused.shifts[0], start + 2 * hour).status, 'break');
  const finished = store.finish(paused, start + 2 * hour);
  assert.equal(finished.shifts[0].breaks[0].endedAt, start + 2 * hour);
  assert.equal(store.metrics(finished.shifts[0]).workMs, hour);
});

test('повторная смена и невозможные переходы отклоняются', () => {
  const initial = store.createInitialState();
  assert.throws(() => store.pause(initial, start), { code: 'NO_ACTIVE_SHIFT' });
  const active = store.start(initial, start);
  assert.throws(() => store.start(active, start), { code: 'ALREADY_ACTIVE' });
  assert.throws(() => store.resume(active, start), { code: 'NOT_PAUSED' });
  const paused = store.pause(active, start + hour);
  assert.throws(() => store.pause(paused, start + hour), { code: 'ALREADY_PAUSED' });
  assert.throws(() => store.finish(paused, start), { code: 'INVALID_TIME' });
});

test('ночная смена и перерыв обрезаются по границе суток', () => {
  const midnight = Date.parse('2026-10-16T00:00:00+05:00');
  const shift = {
    id: 'night', startedAt: midnight - 2 * hour, endedAt: midnight + 3 * hour,
    breaks: [{ startedAt: midnight - 30 * minute, endedAt: midnight + 30 * minute }]
  };
  assert.equal(store.workBetween(shift, midnight - 24 * hour, midnight), 1.5 * hour);
  assert.equal(store.workBetween(shift, midnight, midnight + 24 * hour), 2.5 * hour);
  assert.equal(store.workBetween(shift, midnight + 4 * hour, midnight + 5 * hour), 0);
  assert.equal(store.workBetween(shift, midnight - 10 * minute, midnight + 10 * minute), 0);
  const active = { ...shift, endedAt: null, breaks: [{ startedAt: midnight - 30 * minute, endedAt: null }] };
  assert.equal(store.workBetween(active, midnight, midnight + 24 * hour, midnight + hour), 0);
  assert.equal(store.workBetween(active, midnight - 24 * hour, midnight, midnight + hour), 1.5 * hour);
});

test('интервальные итоги корректны вне смены, на границах и для незавершённой смены', () => {
  const shift = {
    id: 'bounds', startedAt: start, endedAt: null,
    breaks: [{ startedAt: start + hour, endedAt: start + 2 * hour }]
  };
  const now = start + 4 * hour;
  assert.equal(store.workBetween(shift, start - 2 * hour, start, now), 0);
  assert.equal(store.workBetween(shift, now, now + hour, now), 0);
  assert.equal(store.workBetween(shift, start, start, now), 0);
  assert.equal(store.workBetween(shift, now, start, now), 0);
  assert.equal(store.workBetween(shift, start + hour, start + 2 * hour, now), 0);
  assert.equal(store.workBetween(shift, start - hour, now + hour, now), 3 * hour);
  const partitions = [[start, start + 90 * minute], [start + 90 * minute, start + 150 * minute], [start + 150 * minute, now]];
  assert.equal(partitions.reduce((sum, [from, to]) => sum + store.workBetween(shift, from, to, now), 0), store.metrics(shift, now).workMs);
});

test('повреждённое хранилище сообщает ошибку и сохраняет исходную строку', () => {
  const raw = '{broken json';
  const values = mockStorage(raw);
  assert.throws(() => store.load(), { code: 'INVALID_DATA' });
  assert.equal(values.get(store.STORAGE_KEY), raw);
  const broken = store.start(store.createInitialState(), start);
  broken.shifts.push({ ...broken.shifts[0], id: 'another' });
  mockStorage(JSON.stringify(broken));
  assert.throws(() => store.load(), { code: 'INVALID_DATA' });
  mockStorage(JSON.stringify({ ...store.createInitialState(), version: 99 }));
  assert.throws(() => store.load(), { code: 'INVALID_DATA' });
});

test('ошибка записи не маскируется успешным сохранением', () => {
  global.localStorage = { setItem() { throw new Error('QuotaExceededError'); } };
  assert.throws(() => store.save(store.createInitialState()), { code: 'SAVE_FAILED' });
  global.localStorage = { getItem() { const error = new Error('SecurityError'); error.code = 18; throw error; } };
  assert.throws(() => store.load(), { code: 'STORAGE_UNAVAILABLE' });
  Object.defineProperty(global, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  assert.throws(() => store.load(), { code: 'STORAGE_UNAVAILABLE' });
  delete global.localStorage;
});

test('демо заполняется только по вызову и не дублирует существующие записи', () => {
  const initial = store.start(store.createInitialState(), start);
  const seeded = store.seedDemo(initial, start + hour);
  assert.equal(initial.shifts.length, 1);
  assert.equal(seeded.shifts.length, 6);
  assert.deepEqual(store.getActive(seeded), store.getActive(initial));
  assert.deepEqual(store.seedDemo(seeded, start + hour), seeded);
  seeded.shifts.filter(shift => shift.endedAt !== null).forEach(shift => {
    assert.ok(![0, 6].includes(new Date(shift.startedAt).getDay()));
    assert.equal(shift.demo, true);
  });
  assert.equal(store.getActive(seeded).demo, undefined);
});

test('формат продолжительности поддерживает часы больше суток', () => {
  assert.equal(store.formatDuration(27 * hour + 5 * minute + 9000), '27:05');
  assert.equal(store.formatDuration(27 * hour + 5 * minute + 9000, true), '27:05:09');
  assert.equal(store.formatDuration(-minute, true), '00:00:00');
});
