'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/frontend-page.cjs');

const at = time => Date.parse(`2026-11-17T${time}+05:00`);
const employee = { id: 'employee', role: 'employee', permissions: ['edit_own_shifts'] };

function shiftEditor(shift) {
  const rows = [], requests = [];
  let clickListener;
  const initial = { session: { user: employee }, view: 'history', history: { shifts: [shift] } };
  const { node, emit } = page(initial, ({ context, document, node }) => {
    document.addEventListener = (name, listener) => { if (name === 'click') clickListener = listener; };
    document.createElement = () => {
      const fields = { '[data-break-start]': { dataset: {} }, '[data-break-end]': { dataset: {} } };
      return { querySelector: selector => fields[selector], remove() { rows.splice(rows.indexOf(this), 1); } };
    };
    document.querySelectorAll = selector => selector === '#shift-breaks .break-row' ? rows : [];
    Object.assign(node('shift-breaks'), { append(row) { rows.push(row); }, replaceChildren() { rows.length = 0; } });
    node('shift-form').reset = () => {};
    Object.assign(node('shift-dialog'), { showModal() { this.open = true; }, close() { this.open = false; } });
    context.fetch = async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({}) };
    };
  });
  async function click(action, row) {
    const button = { dataset: { action, id: shift.id }, closest: () => row };
    const target = { closest: selector => selector === '[data-action]' ? button : null };
    await clickListener({ target });
  }
  async function save() {
    node('shift-reason').value = 'Исправление записи';
    await emit('shift-form', 'submit');
    assert.equal(node('shift-error').textContent, '');
    assert.equal(requests.length, 1);
    return requests[0];
  }
  return { node, rows, click, save };
}

function record(overrides = {}) {
  return {
    id: 'second-shift', userId: employee.id, version: 3, note: '',
    startedAt: at('12:00:00.825'), endedAt: at('17:00:00.958'),
    breaks: [
      { startedAt: at('13:00:00.027'), endedAt: at('13:10:10.310') },
      { startedAt: at('15:00:01.123'), endedAt: at('15:10:11.850') }
    ],
    ...overrides
  };
}

test('a note-only edit keeps every millisecond, even next to another shift', async () => {
  const shift = record();
  const { node, click, save } = shiftEditor(shift);
  await click('edit-shift');
  // Browsers can normalize a datetime-local value ending in :00 to HH:mm.
  node('shift-start').value = '2026-11-17T12:00';
  node('shift-note').value = 'Обновлён комментарий';
  const { url, method, body } = await save();
  assert.equal(url, '/api/shifts/second-shift');
  assert.equal(method, 'PATCH');
  assert.equal(body.note, 'Обновлён комментарий');
  assert.equal(body.version, shift.version);
  assert.equal(body.startedAt, shift.startedAt);
  assert.ok(body.startedAt > at('12:00:00.540')); // Previous shift ended in the same second.
  assert.equal(body.endedAt, shift.endedAt);
  assert.deepEqual(body.breaks, shift.breaks);
});

test('editing and removing breaks preserves the timestamps of surviving fields', async () => {
  const shift = record({ endedAt: null });
  const { node, rows, click, save } = shiftEditor(shift);
  await click('edit-shift');
  await click('remove-break', rows[0]);
  rows[0].querySelector('[data-break-end]').value = '2026-11-17T15:15:17';
  await click('add-break');
  rows[1].querySelector('[data-break-start]').value = '2026-11-17T16:00';
  node('shift-start').value = '2026-11-17T12:01';
  const { body } = await save();
  assert.equal(body.startedAt, at('12:01:00'));
  assert.equal(body.endedAt, null);
  assert.deepEqual(body.breaks, [
    { startedAt: shift.breaks[1].startedAt, endedAt: at('15:15:17') },
    { startedAt: at('16:00:00'), endedAt: null }
  ]);
});

test('creating a shift after editing one uses the newly entered times', async () => {
  const { node, click, save } = shiftEditor(record());
  await click('edit-shift');
  node('shift-dialog').close();
  await click('add-shift');
  node('shift-start').value = '2026-11-17T12:00';
  node('shift-end').value = '2026-11-17T17:00';
  const { url, method, body } = await save();
  assert.equal(url, '/api/shifts');
  assert.equal(method, 'POST');
  assert.deepEqual(body, {
    userId: employee.id, startedAt: at('12:00:00'), endedAt: at('17:00:00'), note: '', breaks: []
  });
});
