/* Интерфейс: данные и расчёты находятся в storage.js, оформление — в style.css. */
(() => {
  'use strict';
  const Store = window.ShiftStore;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const HOUR = 3600000;
  const MINUTE = 60000;
  const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  let state = Store.createInitialState();
  let storageBlocked = false;
  let view = 'overview';
  let toastTimeout;
  let lastMinute = '';

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const localDate = (value) => {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayStart = value => { const d = new Date(value); d.setHours(0, 0, 0, 0); return +d; };
  const nextDay = value => { const d = new Date(value); d.setDate(d.getDate() + 1); return +d; };
  const readable = ms => `${Math.floor(Math.max(0, ms) / HOUR)} ч ${String(Math.floor(Math.max(0, ms) / MINUTE) % 60).padStart(2, '0')} мин`;
  const statTime = ms => `${Math.floor(Math.max(0, ms) / HOUR)} ч <span>${String(Math.floor(Math.max(0, ms) / MINUTE) % 60).padStart(2, '0')} мин</span>`;
  const sortedShifts = () => [...state.shifts].sort((a, b) => b.startedAt - a.startedAt);
  const totalBetween = (from, to, now) => state.shifts.reduce((sum, shift) => sum + Store.workBetween(shift, from, to, now), 0);

  function breakBetween(shift, from, to, now) {
    return shift.breaks.reduce((sum, pause) => sum + Math.max(0, Math.min(pause.endedAt ?? shift.endedAt ?? now, to, now) - Math.max(pause.startedAt, from)), 0);
  }
  function notify(message, error = false) {
    clearTimeout(toastTimeout);
    $('#toast').textContent = message;
    $('#toast').className = `toast visible${error ? ' error' : ''}`;
    toastTimeout = setTimeout(() => { $('#toast').className = 'toast'; }, 4500);
  }
  function storageError(error) {
    storageBlocked = true;
    $('#storage-alert').hidden = false;
    $('#storage-alert').textContent = `${error.message} Запись остановлена, чтобы сохранить существующие данные. Проверьте настройки хранения браузера и перезагрузите страницу.`;
    $('#storage-status').textContent = 'Хранилище недоступно';
  }
  function reloadState() {
    try {
      state = Store.load();
      storageBlocked = false;
      $('#storage-alert').hidden = true;
      $('#storage-status').textContent = 'Данные в этом браузере';
    } catch (error) { storageError(error); }
  }

  // Между вкладками изменения выполняются по очереди, если браузер поддерживает Web Locks.
  async function changeState(transform, message) {
    if (storageBlocked) return notify('Сначала восстановите доступ к хранилищу.', true);
    const commit = () => {
      const latest = Store.load();
      const next = transform(latest);
      state = Store.save(next);
      render();
      if (message) notify(message);
    };
    try {
      if (navigator.locks?.request) await navigator.locks.request('smena-state-write', commit);
      else commit();
      return true;
    } catch (error) {
      if (['INVALID_DATA', 'STORAGE_UNAVAILABLE', 'SAVE_FAILED'].includes(error.code)) storageError(error);
      notify(error.message || 'Не удалось сохранить изменение.', true);
      renderTimer();
      return false;
    }
  }

  function renderProfile() {
    const { name, position } = state.employee;
    $$('[data-employee-name]').forEach(el => { el.textContent = name; });
    $$('[data-employee-role]').forEach(el => { el.textContent = position; });
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    $$('[data-avatar]').forEach(el => { el.textContent = initials || 'Я'; });
  }
  function renderTimer(now = Date.now()) {
    const active = Store.getActive(state);
    const metric = active ? Store.metrics(active, now) : { workMs: 0, breakMs: 0, status: 'idle' };
    const paused = metric.status === 'break';
    $('#timer').textContent = Store.formatDuration(metric.workMs, true);
    $('#shift-status').className = `status-badge ${active ? paused ? 'paused' : 'working' : 'idle'}`;
    $('#shift-status').innerHTML = `<span class="status-dot"></span><span>${active ? paused ? 'На перерыве' : 'В работе' : 'Не начата'}</span>`;
    $('#timer-subtitle').textContent = active ? paused ? `Время для паузы. Перерыв: ${Store.formatDuration(now - active.breaks.at(-1).startedAt, true)}` : `Начало в ${timeFormat.format(active.startedAt)} · Перерывы: ${readable(metric.breakMs)}` : 'Готовы начать? Ваше время начинается здесь.';
    $('#start-button').hidden = !!active;
    $('#pause-button').hidden = !active || paused;
    $('#resume-button').hidden = !active || !paused;
    $('#finish-button').disabled = !active || storageBlocked;
    ['start', 'pause', 'resume'].forEach(action => { $(`#${action}-button`).disabled = storageBlocked; });
    const progress = Math.min(metric.workMs / (8 * HOUR) * 100, 100);
    $('#progress-fill').style.width = `${progress}%`;
    $('#shift-progress').setAttribute('aria-valuenow', String(Math.round(progress)));
    $('#progress-caption').textContent = `${(metric.workMs / HOUR).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} из 8 часов`;
    $('#current-date').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(now);
    $('#today-label').textContent = dateFormat.format(now);
    const today = dayStart(now);
    const week = new Date(today); week.setDate(week.getDate() - (week.getDay() + 6) % 7);
    const month = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1);
    const todayWork = totalBetween(today, nextDay(today), now);
    $('#stat-today').innerHTML = statTime(todayWork);
    $('#stat-week').innerHTML = statTime(totalBetween(+week, now, now));
    $('#stat-month').innerHTML = statTime(totalBetween(+month, now, now));
    const breaks = state.shifts.reduce((sum, shift) => sum + breakBetween(shift, today, nextDay(today), now), 0);
    $('#stat-breaks').innerHTML = `${Math.floor(breaks / MINUTE)} <span>мин</span>`;
    $('#stat-today-note').textContent = active ? paused ? 'Сейчас вы на перерыве' : 'Рабочее время идёт' : todayWork > 0 ? 'Время сохранено в истории' : 'Ваш день ещё впереди';
    if ($('#finish-dialog').open && active) $('#finish-duration').textContent = readable(metric.workMs);
  }

  function renderTimeline(now = Date.now()) {
    const today = dayStart(now);
    const events = [];
    const add = (time, title, text, type) => { if (time != null && time >= today && time <= now) events.push({ time, title, text, type }); };
    for (const shift of state.shifts) {
      add(shift.startedAt, 'Начало работы', 'Хорошего рабочего дня!', 'play');
      shift.breaks.forEach(pause => {
        add(pause.startedAt, 'Начало перерыва', 'Немного времени для себя', 'coffee');
        if (pause.endedAt !== shift.endedAt) add(pause.endedAt, 'Снова за работу', 'Перерыв завершён', 'play');
      });
      add(shift.endedAt, 'Смена завершена', 'Всё время сохранено', 'check');
    }
    events.sort((a, b) => b.time - a.time);
    $('#timeline').innerHTML = events.length ? events.slice(0, 5).map(event => `<div class="timeline-item"><span class="timeline-marker">${icon(event.type)}</span><div class="timeline-content"><strong>${event.title}</strong><span>${event.text}</span></div><time class="timeline-time">${timeFormat.format(event.time)}</time></div>`).join('') : `<div class="timeline-empty"><span class="empty-icon">${icon('sun')}</span><strong>Новый день — чистый лист</strong><p>Начните смену, и здесь появится<br>история вашего рабочего дня.</p></div>`;
  }

  function renderWeek(now = Date.now()) {
    const monday = new Date(dayStart(now)); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
    const days = Array.from({ length: 7 }, (_, i) => { const day = new Date(monday); day.setDate(day.getDate() + i); return { date: +day, work: totalBetween(+day, nextDay(day), now) }; });
    const max = Math.max(8 * HOUR, ...days.map(day => day.work));
    const labels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    $('#week-chart').innerHTML = days.map((day, i) => `<div class="chart-column${localDate(day.date) === localDate(now) ? ' today' : ''}"><span class="chart-value">${day.work > 0 ? (day.work / HOUR).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ч' : '—'}</span><div class="chart-bar-space"><div class="chart-bar${day.work === 0 ? ' empty' : ''}" style="height:${Math.max(day.work / max * 100, 3)}%" title="${dateFormat.format(day.date)}: ${readable(day.work)}"></div></div><span class="chart-label">${labels[i]}</span></div>`).join('');
    $('#week-range').textContent = `${dateFormat.format(days[0].date)} — ${dateFormat.format(days[6].date)}`;
    $('#week-total').textContent = readable(days.reduce((sum, day) => sum + day.work, 0));
  }

  function emptyState(title, description) {
    return `<div class="empty-state"><span class="empty-icon">${icon('history')}</span><strong>${title}</strong><p>${description}</p></div>`;
  }
  function shiftTable(shifts, compact = false) {
    if (!shifts.length) return emptyState('Здесь будут ваши смены', 'Начните работу или добавьте демо-данные<br>на странице обзора.');
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Дата</th><th>${compact ? 'Рабочее время' : 'Начало / конец'}</th>${compact ? '' : '<th>Перерывы</th><th>Отработано</th>'}<th>Статус</th></tr></thead><tbody>${shifts.map(shift => {
      const metric = Store.metrics(shift);
      const label = metric.status === 'finished' ? 'Завершена' : metric.status === 'break' ? 'Перерыв' : 'В работе';
      const end = shift.endedAt === null ? '—' : `${timeFormat.format(shift.endedAt)}${localDate(shift.startedAt) !== localDate(shift.endedAt) ? ' · ' + dateFormat.format(shift.endedAt) : ''}`;
      return `<tr><td><span class="table-date">${dateFormat.format(shift.startedAt)}</span><span class="table-secondary">${new Date(shift.startedAt).getFullYear()}${shift.demo ? ' · демо' : ''}</span></td><td class="${compact ? 'table-duration' : ''}">${compact ? Store.formatDuration(metric.workMs) : `${timeFormat.format(shift.startedAt)} <span class="table-secondary inline">/ ${end}</span>`}</td>${compact ? '' : `<td>${Store.formatDuration(metric.breakMs)}</td><td class="table-duration">${Store.formatDuration(metric.workMs)}</td>`}<td><span class="pill ${metric.status === 'working' ? 'active' : metric.status === 'break' ? 'paused' : ''}">${label}</span></td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function historySelection() {
    const fromValue = $('#history-from').value;
    const toValue = $('#history-to').value;
    const from = fromValue ? +new Date(`${fromValue}T00:00:00`) : -Infinity;
    const to = toValue ? nextDay(new Date(`${toValue}T00:00:00`)) : Infinity;
    if (from >= to) return { shifts: [], error: 'Дата начала должна быть не позже даты окончания.' };
    const status = $('#history-status').value;
    return { shifts: sortedShifts().filter(shift => shift.startedAt >= from && shift.startedAt < to && (status === 'all' || (status === 'finished' ? shift.endedAt !== null : shift.endedAt === null))) };
  }
  function renderHistory() {
    const { shifts, error } = historySelection();
    $('#history-summary').textContent = error || `Найдено смен: ${shifts.length}. Фильтр применяется к дате начала смены. Время указано в часах и минутах.`;
    $('#history-summary').classList.toggle('form-error', !!error);
    $('#history-table').innerHTML = error ? '' : shifts.length ? shiftTable(shifts) : emptyState('Пока нет подходящих смен', 'Измените фильтры или начните свою первую смену.');
  }
  function reportData(now = Date.now()) {
    const value = $('#report-month').value || localDate(now).slice(0, 7);
    const [year, month] = value.split('-').map(Number);
    const from = +new Date(year, month - 1, 1), to = +new Date(year, month, 1);
    const completed = state.shifts.filter(shift => shift.endedAt !== null && shift.startedAt >= from && shift.startedAt < to);
    const days = [];
    for (let day = from; day < to; day = nextDay(day)) {
      const work = totalBetween(day, nextDay(day), now);
      const breaks = state.shifts.reduce((sum, shift) => sum + breakBetween(shift, day, nextDay(day), now), 0);
      if (work > 0 || breaks > 0) days.push({ date: day, work, breaks });
    }
    return { from, to, days, completed, work: totalBetween(from, to, now), average: completed.length ? completed.reduce((sum, shift) => sum + Store.metrics(shift, now).workMs, 0) / completed.length : 0 };
  }
  function renderReports() {
    const report = reportData();
    $('#report-hours').textContent = readable(report.work);
    $('#report-count').textContent = report.completed.length;
    $('#report-average').textContent = readable(report.average);
    $('#report-caption').textContent = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(report.from);
    $('#report-table').innerHTML = report.days.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>День</th><th>Рабочее время</th><th>Перерывы</th></tr></thead><tbody>${report.days.map(day => `<tr><td>${dateFormat.format(day.date)}</td><td class="table-duration">${readable(day.work)}</td><td>${readable(day.breaks)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('В этом месяце пока тихо', 'Здесь появится отчёт после вашей первой смены.');
  }
  function render() {
    renderProfile(); renderTimer(); renderTimeline(); renderWeek();
    $('#recent-shifts').innerHTML = shiftTable(sortedShifts().slice(0, 3), true);
    renderHistory(); renderReports();
    $$('[data-action="demo"]').forEach(button => { button.disabled = storageBlocked; });
  }
  function setView(name) {
    if (!['overview', 'history', 'reports'].includes(name)) name = 'overview';
    view = name;
    $$('.section-view').forEach(section => { section.hidden = section.id !== `view-${name}`; });
    $$('.nav-link').forEach(button => { const active = button.dataset.view === name; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    $('#breadcrumb-current').textContent = { overview: 'Обзор', history: 'История смен', reports: 'Отчёты' }[name];
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }

  function downloadCSV(rows, filename) {
    // BOM помогает Excel открыть кириллицу; префикс защищает текстовые ячейки от формул.
    const cell = value => { const text = String(value); return `"${(/^[=+@-]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`; };
    const csv = '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Отчёт CSV готов к скачиванию.');
  }

  document.addEventListener('click', async event => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) { setView(viewButton.dataset.view); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'start') await changeState(current => Store.start(current), 'Смена началась. Хорошего рабочего дня!');
    if (action === 'pause') await changeState(current => Store.pause(current), 'Перерыв начался. Рабочий таймер приостановлен.');
    if (action === 'resume') await changeState(current => Store.resume(current), 'Перерыв завершён. Продолжаем работу.');
    if (action === 'demo') {
      const before = state.shifts.length;
      const ok = await changeState(current => Store.seedDemo(current));
      if (ok) notify(state.shifts.length > before ? 'Добавлены примеры прошлых смен. Они отмечены как демо.' : 'Демо-смены уже добавлены или эти дни заняты.');
    }
    if (action === 'finish') {
      const active = Store.getActive(state);
      if (active) { $('#finish-duration').textContent = readable(Store.metrics(active).workMs); $('#finish-dialog').showModal(); }
    }
    if (action === 'confirm-finish') {
      if (await changeState(current => Store.finish(current), 'Смена завершена и сохранена. Отличная работа!')) $('#finish-dialog').close();
    }
    if (action === 'profile') {
      $('#employee-name').value = state.employee.name; $('#employee-position').value = state.employee.position;
      $('#profile-error').textContent = ''; $('#profile-dialog').showModal();
    }
    if (action === 'close-dialog') event.target.closest('dialog').close();
    if (action === 'reset-filters') { $('#history-from').value = ''; $('#history-to').value = ''; $('#history-status').value = 'all'; renderHistory(); }
    if (action === 'export-history') {
      const { shifts, error } = historySelection();
      if (error || !shifts.length) return notify(error || 'Пока нет смен для экспорта.', true);
      downloadCSV([['Сотрудник', 'Начало', 'Конец', 'Отработано (ч:мин:сек)', 'Перерывы (ч:мин:сек)', 'Статус', 'Демо'], ...shifts.map(shift => { const metric = Store.metrics(shift); return [state.employee.name, new Date(shift.startedAt).toLocaleString('ru-RU'), shift.endedAt ? new Date(shift.endedAt).toLocaleString('ru-RU') : '', Store.formatDuration(metric.workMs, true), Store.formatDuration(metric.breakMs, true), metric.status === 'finished' ? 'Завершена' : metric.status === 'break' ? 'Перерыв' : 'В работе', shift.demo ? 'Да' : 'Нет']; })], `smena-history-${localDate(Date.now())}.csv`);
    }
    if (action === 'export-report') {
      const report = reportData();
      if (!report.days.length) return notify('В выбранном месяце пока нет данных.', true);
      downloadCSV([['Сотрудник', 'Дата', 'Работа (ч:мин:сек)', 'Перерывы (ч:мин:сек)'], ...report.days.map(day => [state.employee.name, localDate(day.date), Store.formatDuration(day.work, true), Store.formatDuration(day.breaks, true)])], `smena-report-${$('#report-month').value}.csv`);
    }
  });
  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('#employee-name').value.trim(), position = $('#employee-position').value.trim();
    if (!name || !position) { $('#profile-error').textContent = 'Укажите имя и должность.'; return; }
    if (await changeState(current => ({ ...current, employee: { name, position } }), 'Профиль сохранён.')) $('#profile-dialog').close();
  });
  ['history-from', 'history-to', 'history-status'].forEach(id => $(`#${id}`).addEventListener('change', renderHistory));
  $('#report-month').addEventListener('change', renderReports);
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
  window.addEventListener('storage', event => { if (event.key === Store.STORAGE_KEY || event.key === null) { reloadState(); render(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { reloadState(); render(); } });
  $('#report-month').value = localDate(Date.now()).slice(0, 7);
  reloadState(); render(); setView(location.hash.slice(1));
  // Счётчик на экране обновляется каждую секунду. В localStorage пишем только события.
  setInterval(() => {
    renderTimer();
    const minute = `${localDate(Date.now())}-${Math.floor(Date.now() / MINUTE)}`;
    if (minute !== lastMinute) {
      lastMinute = minute; renderWeek(); renderTimeline();
      $('#recent-shifts').innerHTML = shiftTable(sortedShifts().slice(0, 3), true);
      if (view === 'reports') renderReports();
      if (view === 'history') renderHistory();
    }
  }, 1000);
})();
