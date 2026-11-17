'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real client script against a small DOM adapter. No server or user data.
function page() {
  const nodes = new Map(), formatters = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', textContent: '', method: 'get', submissions: 0, handlers: {},
      elements: { namedItem: () => null },
      addEventListener(type, callback) { this.handlers[type] = callback; },
      closest() { return this.form; },
      requestSubmit() { this.submissions++; },
    });
    return nodes.get(id);
  };
  node('smena-bootstrap').textContent = JSON.stringify({ session: { user: null }, view: 'history' });
  for (const prefix of ['history', 'report']) {
    for (const suffix of ['from', 'to', 'status']) node(`${prefix}-${suffix}`).form = node(`${prefix}-filter-form`);
  }
  const document = { querySelector: selector => node(selector.slice(1)), querySelectorAll: () => [], addEventListener() {} };
  const context = { document, window: { addEventListener() {} }, location: { hash: '', search: '', pathname: '/', href: 'http://localhost/' },
    Intl: { DateTimeFormat: function (...args) { const formatter = new Intl.DateTimeFormat(...args); formatters.push(formatter); return formatter; } },
    URL, URLSearchParams, setInterval() {}, setTimeout() {}, clearTimeout() {}, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
  const emit = async (id, type) => {
    const element = node(id), event = { target: element, currentTarget: element, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await element.handlers[type](event);
    return event;
  };
  return { node, emit, formatters };
}

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
