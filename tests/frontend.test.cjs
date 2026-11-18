'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/frontend-page.cjs');

test('reversed history dates stay in the form for changes and manual submit', async () => {
  const { node, emit } = page();
  node('history-from').value = '2026-11-20'; node('history-to').value = '2026-11-01';
  await emit('history-from', 'change');
  assert.equal(node('history-filter-form').submissions, 0);
  assert.match(node('toast').textContent, /Дата начала/);
  assert.equal((await emit('history-filter-form', 'submit')).defaultPrevented, true);
  node('history-to').value = '2026-11-30';
  await emit('history-to', 'change');
  assert.equal(node('history-filter-form').submissions, 1);
  assert.equal((await emit('history-filter-form', 'submit')).defaultPrevented, false);
});

test('reports reject reversed or oversized ranges and allow an inclusive 366 days', async () => {
  const { node, emit } = page();
  node('report-from').value = '2024-01-01'; node('report-to').value = '2025-01-01';
  assert.equal((await emit('report-filter-form', 'submit')).defaultPrevented, true);
  assert.match(node('toast').textContent, /366/);
  node('report-to').value = '2024-12-31';
  assert.equal((await emit('report-filter-form', 'submit')).defaultPrevented, false);
  node('report-from').value = '2025-01-01';
  assert.equal((await emit('report-filter-form', 'submit')).defaultPrevented, true);
});

test('archival date labels use the same UTC+5 as the editor and server', () => {
  const { formatters } = page();
  const instant = Date.parse('2010-01-01T23:30:00+05:00');
  const [date, time, full] = formatters;
  assert.equal(date.format(instant), '1 января');
  assert.equal(time.format(instant), '23:30');
  assert.equal(full.format(instant), '01.01.2010, 23:30');
});
