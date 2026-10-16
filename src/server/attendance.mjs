// Календарь использует фиксированное время приложения: Казахстан, UTC+5.
// Смену целиком относим к местной дате её НАЧАЛА, включая часы после полуночи.
// Это единое правило для календаря, план/факта и месячного табеля.
const MINUTE = 60000;
const DAY = 86400000;
const OFFSET = 5 * 60 * MINUTE;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function utcMidnight(year, month, day = 1) {
  // setUTCFullYear, в отличие от Date.UTC, не превращает годы 1–99 в 1901–1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function monthBounds(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new RangeError('Месяц должен быть указан в формате ГГГГ-ММ.');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  if (year < 1) throw new RangeError('Год должен быть от 0001 до 9999.');
  return {
    from: utcMidnight(year, monthNumber - 1) - OFFSET,
    to: utcMidnight(year, monthNumber) - OFFSET,
  };
}

function localDate(timestamp) {
  return new Date(timestamp + OFFSET).toISOString().slice(0, 10);
}

function clockMinutes(value) {
  const match = typeof value === 'string' && CLOCK.exec(value);
  if (!match) throw new RangeError('Время графика должно быть указано в формате ЧЧ:ММ.');
  return Number(match[1]) * 60 + Number(match[2]);
}

function scheduleParts(schedule) {
  if (!schedule || !Array.isArray(schedule.weekdays) ||
      schedule.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new RangeError('Дни графика должны быть числами от 1 до 7.');
  }
  const start = clockMinutes(schedule.startTime);
  const end = clockMinutes(schedule.endTime);
  const duration = (end - start + 1440) % 1440;
  if (!duration || !Number.isInteger(schedule.breakMinutes) || schedule.breakMinutes < 0 || schedule.breakMinutes >= duration) {
    throw new RangeError('Плановый перерыв должен быть короче смены.');
  }
  return { start, duration, workMs: (duration - schedule.breakMinutes) * MINUTE };
}

function shiftMetrics(shift, now) {
  const end = Math.max(shift.startedAt, Math.min(shift.endedAt ?? now, now));
  const breakMs = (shift.breaks ?? []).reduce((sum, pause) => {
    return sum + Math.max(0, Math.min(pause.endedAt ?? end, end) - Math.max(pause.startedAt, shift.startedAt));
  }, 0);
  const ongoing = shift.endedAt === null || shift.endedAt > now;
  const onBreak = ongoing && (shift.breaks ?? []).some(pause =>
    pause.startedAt <= now && (pause.endedAt === null || pause.endedAt > now));
  return { workMs: Math.max(0, end - shift.startedAt - breakMs), breakMs, ongoing, onBreak };
}

/**
 * Возвращает по одной записи на каждый день месяца; не изменяет исходные данные.
 * shifts и absences уже должны быть отфильтрованы вызывающим кодом по сотруднику.
 * Часовой пояс schedule.timezone хранится в графике для интерфейса; расчёт всегда UTC+5.
 * Дата создания включается в график целиком, более ранние даты не считаются пропусками.
 */
export function buildAttendanceMonth({ month, schedule, shifts = [], absences = [], now = Date.now(), createdAt }) {
  const { from, to } = monthBounds(month);
  const plan = scheduleParts(schedule);
  const today = localDate(now);
  const createdDate = createdAt == null ? null : localDate(createdAt);
  const byDate = new Map();

  for (const shift of shifts) {
    // Будущая отметка пока не является фактически начавшейся сменой.
    if (shift.startedAt > now || shift.startedAt < from || shift.startedAt >= to) continue;
    const date = localDate(shift.startedAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(shift);
  }

  const days = [];
  for (let dayStart = from; dayStart < to; dayStart += DAY) {
    const date = localDate(dayStart);
    const weekday = new Date(dayStart + OFFSET).getUTCDay() || 7;
    const absence = absences.find(item => item.startDate <= date && item.endDate >= date) ?? null;
    const employed = createdDate === null || date >= createdDate;
    const kind = absence ? 'absence' : employed && schedule.weekdays.includes(weekday) ? 'workday' : 'day_off';
    const plannedStart = kind === 'workday' ? dayStart + plan.start * MINUTE : null;
    const plannedEnd = plannedStart === null ? null : plannedStart + plan.duration * MINUTE;
    const plannedMs = kind === 'workday' ? plan.workMs : 0;
    const dailyShifts = (byDate.get(date) ?? []).slice().sort((a, b) => a.startedAt - b.startedAt);
    const actual = dailyShifts.map(shift => shiftMetrics(shift, now));
    const workMs = actual.reduce((sum, item) => sum + item.workMs, 0);
    const breakMs = actual.reduce((sum, item) => sum + item.breakMs, 0);
    const firstStart = dailyShifts[0]?.startedAt ?? null;
    const ongoingIndex = actual.findIndex(item => item.ongoing);
    const lastEnd = !dailyShifts.length || ongoingIndex !== -1 ? null : Math.max(...dailyShifts.map(shift => shift.endedAt));
    let state;

    if (ongoingIndex !== -1) state = actual[ongoingIndex].onBreak ? 'break' : 'working';
    else if (dailyShifts.length) state = 'finished';
    else if (date > today || (plannedStart !== null && now < plannedStart)) state = 'upcoming';
    else if (plannedEnd !== null) state = now >= plannedEnd ? 'missed' : 'not_started';
    else state = 'finished';

    days.push({
      date, plannedStart, plannedEnd, plannedMs, workMs, breakMs,
      lateMs: firstStart !== null && plannedStart !== null ? Math.max(0, firstStart - plannedStart) : 0,
      overtimeMs: Math.max(0, workMs - plannedMs),
      kind, state, absence,
      shiftIds: dailyShifts.map(shift => shift.id),
      firstStart, lastEnd,
    });
  }
  return days;
}
