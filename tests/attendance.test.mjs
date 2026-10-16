import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttendanceMonth, monthBounds } from '../src/server/attendance.mjs';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = value => Date.parse(value + '+05:00');
const schedule = { startTime: '09:00', endTime: '18:00', breakMinutes: 60, weekdays: [1, 2, 3, 4, 5], timezone: 'Asia/Qyzylorda' };
const shift = (id, start, end, breaks = []) => ({ id, startedAt: at(start), endedAt: end === null ? null : at(end), breaks });
const pause = (start, end) => ({ startedAt: at(start), endedAt: end === null ? null : at(end) });
const build = overrides => buildAttendanceMonth({ month: '2026-10', schedule, now: at('2026-10-16T20:00:00'), shifts: [], absences: [], ...overrides });
const find = (days, date) => days.find(day => day.date === date);

test('month boundaries are strict UTC+5 instants, including leap years and December', () => {
  assert.deepEqual(monthBounds('2026-10'), { from: at('2026-10-01T00:00:00'), to: at('2026-11-01T00:00:00') });
  assert.equal((monthBounds('2024-02').to - monthBounds('2024-02').from) / DAY, 29);
  assert.equal((monthBounds('2025-02').to - monthBounds('2025-02').from) / DAY, 28);
  assert.equal(monthBounds('2026-12').to, at('2027-01-01T00:00:00'));
  assert.equal(monthBounds('0099-01').from, at('0099-01-01T00:00:00'));
  for (const value of ['2026-00', '2026-13', '2026-1', '2026-10-01', '0000-01', '2026-02x', ' 2026-02', '', null, 202610]) {
    assert.throws(() => monthBounds(value), RangeError, String(value));
  }
});

test('regular shift subtracts breaks and calculates lateness against local schedule', () => {
  const days = build({ shifts: [shift('regular', '2026-10-15T09:20:00', '2026-10-15T18:00:00', [pause('2026-10-15T13:00:00', '2026-10-15T14:00:00')])] });
  assert.equal(days.length, 31);
  const day = find(days, '2026-10-15');
  assert.equal(day.plannedStart, at('2026-10-15T09:00:00'));
  assert.equal(day.plannedEnd, at('2026-10-15T18:00:00'));
  assert.equal(day.plannedMs, 8 * HOUR);
  assert.equal(day.workMs, 7 * HOUR + 40 * MINUTE);
  assert.equal(day.breakMs, HOUR);
  assert.equal(day.lateMs, 20 * MINUTE);
  assert.equal(day.overtimeMs, 0);
  assert.equal(day.state, 'finished');
  assert.equal(day.kind, 'workday');
  assert.deepEqual(day.shiftIds, ['regular']);
});

test('multiple shifts aggregate by start date and use the earliest arrival', () => {
  const inputs = [
    shift('second', '2026-10-15T14:00:00', '2026-10-15T20:00:00', [pause('2026-10-15T17:00:00', '2026-10-15T17:30:00')]),
    shift('first', '2026-10-15T08:45:00', '2026-10-15T12:00:00'),
  ];
  const copy = structuredClone(inputs);
  const day = find(build({ shifts: inputs }), '2026-10-15');
  assert.equal(day.workMs, 8 * HOUR + 45 * MINUTE);
  assert.equal(day.overtimeMs, 45 * MINUTE);
  assert.equal(day.breakMs, 30 * MINUTE);
  assert.equal(day.lateMs, 0);
  assert.equal(day.firstStart, at('2026-10-15T08:45:00'));
  assert.equal(day.lastEnd, at('2026-10-15T20:00:00'));
  assert.deepEqual(day.shiftIds, ['first', 'second']);
  assert.deepEqual(inputs, copy, 'calculation does not mutate input arrays');
});

test('night schedule and its midnight-crossing break stay on the start date', () => {
  const nightSchedule = { ...schedule, startTime: '22:00', endTime: '06:00', breakMinutes: 30 };
  const days = build({ schedule: nightSchedule, shifts: [shift('night', '2026-10-15T22:10:00', '2026-10-16T06:30:00', [pause('2026-10-15T23:50:00', '2026-10-16T00:20:00')])] });
  const day = find(days, '2026-10-15');
  assert.equal(day.plannedEnd, at('2026-10-16T06:00:00'));
  assert.equal(day.plannedMs, 7.5 * HOUR);
  assert.equal(day.workMs, 7 * HOUR + 50 * MINUTE);
  assert.equal(day.lateMs, 10 * MINUTE);
  assert.equal(day.overtimeMs, 20 * MINUTE);
  assert.equal(find(days, '2026-10-16').workMs, 0);
  assert.equal(find(build({ schedule: nightSchedule, now: at('2026-10-16T02:00:00') }), '2026-10-15').state, 'not_started');
  assert.equal(find(build({ schedule: nightSchedule, now: at('2026-10-16T06:00:00') }), '2026-10-15').state, 'missed');
});

test('ongoing break and all actual intervals are clamped to now', () => {
  const current = shift('active', '2026-10-16T09:00:00', null, [pause('2026-10-16T12:00:00', null)]);
  const day = find(build({ shifts: [current], now: at('2026-10-16T13:15:00') }), '2026-10-16');
  assert.equal(day.workMs, 3 * HOUR);
  assert.equal(day.breakMs, 75 * MINUTE);
  assert.equal(day.state, 'break');
  assert.equal(day.lastEnd, null);
  const working = find(build({ shifts: [shift('active', '2026-10-16T09:00:00', null)], now: at('2026-10-16T10:30:00') }), '2026-10-16');
  assert.equal(working.workMs, 90 * MINUTE);
  assert.equal(working.state, 'working');
  const futureEnd = find(build({ shifts: [shift('future-end', '2026-10-16T09:00:00', '2026-10-16T18:00:00', [pause('2026-10-16T10:00:00', '2026-10-16T11:00:00')])], now: at('2026-10-16T10:15:00') }), '2026-10-16');
  assert.equal(futureEnd.workMs, HOUR);
  assert.equal(futureEnd.breakMs, 15 * MINUTE);
  assert.equal(futureEnd.state, 'break');
});

test('monthly assignment excludes shifts begun in another month and includes a night ending next month', () => {
  const days = build({ now: at('2026-11-02T10:00:00'), shifts: [
    shift('previous', '2026-09-30T22:00:00', '2026-10-01T06:00:00'),
    shift('last-night', '2026-10-31T22:00:00', '2026-11-01T06:00:00'),
    shift('next', '2026-11-01T22:00:00', '2026-11-02T06:00:00'),
  ] });
  assert.equal(find(days, '2026-10-01').workMs, 0);
  assert.equal(find(days, '2026-10-31').workMs, 8 * HOUR);
  assert.equal(days.reduce((sum, day) => sum + day.workMs, 0), 8 * HOUR);
  assert.deepEqual(find(days, '2026-10-31').shiftIds, ['last-night']);
});

test('absence range is inclusive, excuses planned hours and never records a missed day', () => {
  const absence = { id: 'absence-1', userId: 'u1', startDate: '2026-10-14', endDate: '2026-10-16', type: 'vacation', note: 'Отпуск' };
  const days = build({ absences: [absence] });
  for (const date of ['2026-10-14', '2026-10-15', '2026-10-16']) {
    const day = find(days, date);
    assert.equal(day.kind, 'absence');
    assert.equal(day.plannedMs, 0);
    assert.equal(day.plannedStart, null);
    assert.equal(day.plannedEnd, null);
    assert.equal(day.state, 'finished');
    assert.deepEqual(day.absence, absence);
  }
  assert.equal(find(days, '2026-10-13').state, 'missed');
  const actual = find(build({ absences: [absence], shifts: [shift('during-absence', '2026-10-15T10:00:00', '2026-10-15T11:00:00')] }), '2026-10-15');
  assert.equal(actual.overtimeMs, HOUR);
  assert.equal(actual.lateMs, 0);
});

test('days off retain actual hours but no planned hours or lateness', () => {
  const days = build({ shifts: [shift('sunday', '2026-10-11T14:00:00', '2026-10-11T16:00:00')] });
  const day = find(days, '2026-10-11');
  assert.equal(day.kind, 'day_off');
  assert.equal(day.plannedMs, 0);
  assert.equal(day.workMs, 2 * HOUR);
  assert.equal(day.overtimeMs, 2 * HOUR);
  assert.equal(day.lateMs, 0);
  assert.equal(find(days, '2026-10-10').state, 'finished');
  assert.equal(find(days, '2026-10-17').state, 'upcoming');
});

test('future dates and future records have no actual work or absence penalty', () => {
  const now = at('2026-10-16T08:30:00');
  const days = build({ now, shifts: [shift('future', '2026-10-19T09:20:00', '2026-10-19T18:00:00')] });
  for (const date of ['2026-10-16', '2026-10-19', '2026-10-30']) {
    const day = find(days, date);
    assert.equal(day.state, 'upcoming');
    assert.equal(day.workMs, 0);
    assert.equal(day.lateMs, 0);
    assert.equal(day.firstStart, null);
    assert.deepEqual(day.shiftIds, []);
  }
  assert.equal(find(build({ now: at('2026-10-16T10:00:00') }), '2026-10-16').state, 'not_started');
  assert.equal(find(build({ now: at('2026-10-16T18:00:00') }), '2026-10-16').state, 'missed');
});

test('account creation uses its local date and never marks earlier days as missed', () => {
  const days = build({ createdAt: at('2026-10-15T00:15:00') });
  const before = find(days, '2026-10-14');
  assert.equal(before.plannedMs, 0);
  assert.equal(before.kind, 'day_off');
  assert.equal(before.state, 'finished');
  assert.equal(before.plannedStart, null);
  assert.equal(find(days, '2026-10-15').plannedMs, 8 * HOUR);
  assert.equal(find(days, '2026-10-15').state, 'missed');
});

test('calendar contains exactly all dates of a leap February and respects weekday numbering', () => {
  const days = build({ month: '2024-02', now: at('2024-03-01T12:00:00') });
  assert.equal(days.length, 29);
  assert.equal(days[0].date, '2024-02-01');
  assert.equal(days.at(-1).date, '2024-02-29');
  assert.equal(find(days, '2024-02-05').kind, 'workday'); // Понедельник = 1.
  assert.equal(find(days, '2024-02-04').kind, 'day_off'); // Воскресенье = 7.
  const sunday = find(build({ month: '2024-02', schedule: { ...schedule, weekdays: [7] } }), '2024-02-04');
  assert.equal(sunday.kind, 'workday');
});
