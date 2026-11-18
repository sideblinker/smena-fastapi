'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/frontend-page.cjs');

const HOUR = 3_600_000;
const midnight = Date.parse('2026-11-18T00:00:00+05:00');

function dashboard(shifts, serverNow, selected = { active: true }) {
  let now = serverNow;
  const initial = {
    session: { user: { id: 'admin', role: 'admin' } }, view: 'overview',
    dashboard: { serverNow, user: selected, shifts },
  };
  const { node, intervals } = page(initial, ({ context }) => {
    context.Date = class extends Date { static now() { return now; } };
  });
  return { node, advance(hours) { now += hours * HOUR; intervals.get(1000)(); } };
}

test('daily progress retains completed hours alongside a live shift', () => {
  const first = { id: 'first', startedAt: midnight + 8 * HOUR, endedAt: midnight + 12 * HOUR, breaks: [] };
  const atNoon = dashboard([first], first.endedAt);
  assert.equal(atNoon.node('progress-fill').style.width, '50%');
  assert.equal(atNoon.node('timer').textContent, '00:00:00');

  const second = { id: 'second', startedAt: midnight + 13 * HOUR, endedAt: null, breaks: [] };
  const afternoon = dashboard([second, first], second.startedAt);
  afternoon.advance(1);
  assert.equal(afternoon.node('progress-caption').textContent, '5 из 8 часов');
  assert.equal(afternoon.node('progress-fill').style.width, '62.5%');
  assert.equal(afternoon.node('shift-progress').getAttribute('aria-valuenow'), '63');
  assert.equal(afternoon.node('timer').textContent, '01:00:00');

  afternoon.advance(4);
  assert.equal(afternoon.node('progress-caption').textContent, '9 из 8 часов');
  assert.equal(afternoon.node('progress-fill').style.width, '100%');
});

test('timer tick at UTC+5 midnight counts only work performed in the new day', () => {
  const shift = { id: 'night', startedAt: midnight - 3 * HOUR, endedAt: null, breaks: [] };
  const night = dashboard([shift], midnight - HOUR);
  night.advance(1);
  assert.equal(night.node('progress-caption').textContent, '0 из 8 часов');
  night.advance(1);
  assert.equal(night.node('progress-caption').textContent, '1 из 8 часов');
  assert.equal(night.node('timer').textContent, '04:00:00');

  shift.breaks = [{ startedAt: midnight - HOUR, endedAt: null }];
  const paused = dashboard([shift], midnight + HOUR);
  paused.advance(1);
  assert.equal(paused.node('progress-caption').textContent, '0 из 8 часов');
  assert.equal(paused.node('timer').textContent, '02:00:00');
});

test('admin can finish a legacy open shift for a disabled or archived employee', () => {
  const shift = { id: 'legacy', startedAt: midnight, endedAt: null, breaks: [] };
  for (const archived of [false, true]) {
    const { node } = dashboard([shift], midnight + HOUR, { active: false, archived });
    assert.equal(node('finish-button').disabled, false);
    for (const action of ['start', 'pause', 'resume']) assert.equal(node(`${action}-button`).disabled, true);
  }
});
