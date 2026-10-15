/* Смена: сервер — единственный источник данных. Пароли и смены не хранятся в localStorage. */
(() => {
  'use strict';
  // Одноразовый ключ первого запуска приходит только во фрагменте ссылки.
  // Он не попадает в URL запросов и остаётся исключительно в памяти вкладки.
  let setupToken = (() => /^#setup=([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1] || '')();
  if (location.hash.startsWith('#setup=')) history.replaceState(null, '', `${location.pathname}${location.search}`);
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const HOUR = 3600000, MINUTE = 60000, DAY = 24 * HOUR, ZONE = 'Asia/Qyzylorda';
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const permissions = {
    track_time: ['Учёт рабочего времени', 'Начинать и завершать свою смену, отмечать перерывы'],
    edit_own_profile: ['Изменение профиля', 'Редактировать своё имя, должность и отдел'],
    edit_own_shifts: ['Исправление своих смен', 'Добавлять, изменять и удалять собственные записи'],
    view_reports: ['Просмотр отчётов', 'Видеть итоги своего рабочего времени'],
    export_reports: ['Экспорт CSV', 'Скачивать отчёты о своём времени']
  };
  const viewNames = { overview: 'Обзор', history: 'История смен', employees: 'Сотрудники', reports: 'Отчёты', audit: 'Журнал действий' };
  const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: ZONE });
  const timeFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: ZONE });
  const fullFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: ZONE });
  let session = { user: null, csrfToken: '', setupRequired: false };
  let users = [], dashboard = { user: null, schedule: null, shifts: [] }, selectedUserId = null;
  let view = 'overview', offset = 0, mutationBusy = false, refreshBusy = false, connected = true;
  let toastTimeout, editingEmployeeId = null, editingShift = null, scheduleUserId = null, confirmCallback = null;
  let reportRequest = 0, dashboardRequest = 0, breakSequence = 0;

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const isAdmin = () => session.user?.role === 'admin';
  const can = permission => isAdmin() || !!session.user?.permissions?.includes(permission);
  const now = () => Date.now() + offset;
  const pad = value => String(value).padStart(2, '0');
  const numericTime = value => typeof value === 'number' ? value : Date.parse(value);
  const zonedDate = value => new Date(numericTime(value) + 5 * HOUR);
  const dateKey = value => { const date = zonedDate(value); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; };
  const dateInput = value => { const date = zonedDate(value); return `${dateKey(value)}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`; };
  const parseInput = value => value ? Date.parse(`${value}+05:00`) : null;
  const dayStart = value => Date.parse(`${dateKey(value)}T00:00:00+05:00`);
  const dayFromKey = value => Date.parse(`${value}T00:00:00+05:00`);
  const weekStart = value => dayStart(value) - ((zonedDate(value).getUTCDay() + 6) % 7) * DAY;
  const monthStart = value => dayFromKey(`${dateKey(value).slice(0, 7)}-01`);
  const readable = ms => `${Math.floor(Math.max(0, ms) / HOUR)} ч ${pad(Math.floor(Math.max(0, ms) / MINUTE) % 60)} мин`;
  const duration = ms => `${pad(Math.floor(Math.max(0, ms) / HOUR))}:${pad(Math.floor(Math.max(0, ms) / MINUTE) % 60)}:${pad(Math.floor(Math.max(0, ms) / 1000) % 60)}`;
  const statTime = ms => `${Math.floor(Math.max(0, ms) / HOUR)} ч <span>${pad(Math.floor(Math.max(0, ms) / MINUTE) % 60)} мин</span>`;
  const sortedShifts = () => [...dashboard.shifts].sort((a, b) => b.startedAt - a.startedAt);
  const activeShift = () => dashboard.shifts.find(shift => shift.endedAt == null);
  const breakBetween = (shift, from, to, current = now()) => shift.breaks.reduce((sum, pause) => sum + Math.max(0, Math.min(pause.endedAt ?? shift.endedAt ?? current, to, current) - Math.max(pause.startedAt, from)), 0);
  const workBetween = (shift, from, to, current = now()) => Math.max(0, Math.min(shift.endedAt ?? current, to, current) - Math.max(shift.startedAt, from) - breakBetween(shift, from, to, current));
  const totalBetween = (from, to, current = now()) => dashboard.shifts.reduce((sum, shift) => sum + workBetween(shift, from, to, current), 0);
  const metrics = (shift, current = now()) => ({ workMs: workBetween(shift, -Infinity, Infinity, current), breakMs: breakBetween(shift, -Infinity, Infinity, current), status: shift.endedAt != null ? 'finished' : shift.breaks.some(pause => pause.endedAt == null) ? 'break' : 'working' });
  const queryForUser = extra => new URLSearchParams({ userId: String(selectedUserId), ...extra }).toString();

  function syncClock(data) { if (data.serverNow != null) offset = numericTime(data.serverNow) - Date.now(); }
  function notify(message, error = false) {
    clearTimeout(toastTimeout);
    $('#toast').textContent = message;
    $('#toast').className = `toast visible${error ? ' error' : ''}`;
    toastTimeout = setTimeout(() => { $('#toast').className = 'toast'; }, 5500);
  }
  function connectionStatus(ok, message = '') {
    connected = ok;
    $('#connection-alert').hidden = ok;
    $('#connection-alert').textContent = message || 'Нет связи с сервером. Данные могут быть устаревшими. Восстановите соединение: сохранённые смены остаются в базе.';
    $('#storage-status').textContent = ok ? 'Данные на сервере' : 'Нет связи с сервером';
  }
  async function api(path, { method = 'GET', body, binary = false, allowUnauthorized = false } = {}) {
    const requestSessionToken = session.csrfToken;
    const headers = { Accept: binary ? 'text/csv' : 'application/json' };
    if (setupToken && (path === '/api/session' || path === '/api/setup')) headers['X-Setup-Token'] = setupToken;
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = session.csrfToken || ''; }
    let response;
    try { response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { connectionStatus(false); throw new Error('Не удалось связаться с сервером. Проверьте, запущена ли Смена.'); }
    const data = binary && response.ok ? await response.blob() : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && !allowUnauthorized && session.user && requestSessionToken === session.csrfToken) {
        session.user = null; dashboardRequest += 1;
        $$('dialog[open]').forEach(dialog => dialog.close());
        showAuth();
        void initialize();
      }
      const error = new Error(data.error || (response.status === 404 ? 'Сервер учёта не найден. Откройте Смену через файл запуска сервера.' : 'Не удалось выполнить запрос. Повторите попытку.'));
      error.code = data.code; error.status = response.status; throw error;
    }
    if (!binary) syncClock(data);
    if (path === '/api/setup' && response.ok) setupToken = '';
    connectionStatus(true);
    return data;
  }
  function showAuth() {
    $('#app').hidden = true; $('#auth-screen').hidden = false;
    const setup = session.setupRequired;
    $('#auth-eyebrow').textContent = setup ? 'ПЕРВЫЙ ЗАПУСК' : 'ВАШ ЛИЧНЫЙ КАБИНЕТ';
    $('#auth-title').textContent = setup ? 'Добро пожаловать, Адиль' : 'С возвращением';
    $('#auth-description').textContent = setup ? 'Создайте пароль администратора Адиля Кубентаева. После этого вы сможете добавить сотрудников и назначить им права.' : 'Войдите, чтобы продолжить свой рабочий день.';
    $('#auth-form').hidden = false; $('#server-help').hidden = true; $('#auth-retry').hidden = true;
    $('#auth-username').readOnly = setup;
    if (setup) $('#auth-username').value = session.adminLogin || 'Adilium';
    $('#auth-password').minLength = setup ? 10 : 1;
    $('#auth-password').autocomplete = setup ? 'new-password' : 'current-password';
    $('#auth-password-label').textContent = setup ? 'Придумайте пароль — от 10 символов' : 'Пароль';
    $('#auth-confirm-field').hidden = !setup; $('#auth-confirm').required = setup;
    $('#auth-submit').innerHTML = `${setup ? 'Создать аккаунт администратора' : 'Войти в кабинет'} ${icon('arrow')}`;
    $('#auth-footnote').textContent = setup ? 'Логин администратора: Adilium. Пароль задаёте только вы.' : 'Доступ сотрудникам предоставляет администратор.';
  }
  async function initialize() {
    if (location.protocol === 'file:') {
      $('#auth-title').textContent = 'Запустите сервер Смены';
      $('#auth-description').textContent = 'Аккаунты и общая база данных работают через сервер. Открытия HTML-файла для входа недостаточно.';
      $('#server-help').hidden = false; $('#auth-form').hidden = true; return;
    }
    try {
      session = await api('/api/session', { allowUnauthorized: true });
      if (!session.user) { showAuth(); return; }
      await enterApp();
    } catch (error) {
      $('#app').hidden = true; $('#auth-screen').hidden = false;
      $('#auth-title').textContent = 'Сервер недоступен'; $('#auth-description').textContent = error.message;
      $('#auth-form').hidden = true; $('#server-help').hidden = false; $('#auth-retry').hidden = false;
    }
  }
  async function enterApp() {
    selectedUserId = session.user.id;
    $('#auth-form').reset(); $('#auth-error').textContent = '';
    if (isAdmin()) await loadUsers(); else users = [session.user];
    $('#report-from').value = dateKey(monthStart(now())); $('#report-to').value = dateKey(now());
    await loadDashboard();
    $('#auth-screen').hidden = true; $('#app').hidden = false;
    renderAccount();
    await setView(location.hash.slice(1) || 'overview');
  }
  async function loadUsers() {
    if (!isAdmin()) return;
    const data = await api('/api/users?includeArchived=1'); users = data.users;
    if (!users.some(user => String(user.id) === String(selectedUserId))) selectedUserId = session.user.id;
    $('#selected-user').innerHTML = users.map(user => `<option value="${escapeHTML(user.id)}">${escapeHTML(user.name)}${user.role === 'admin' ? ' · администратор' : user.archived ? ' · архив' : !user.active ? ' · заблокирован' : ''}</option>`).join('');
    $('#selected-user').value = String(selectedUserId);
    renderEmployees();
  }
  async function loadDashboard() {
    if (!session.user || selectedUserId == null) return;
    const token = ++dashboardRequest;
    const result = await api(`/api/dashboard?${queryForUser({})}`);
    if (token !== dashboardRequest || !session.user) return;
    dashboard = result;
    dashboard.shifts = (result.shifts || []).map(shift => ({ ...shift, startedAt: numericTime(shift.startedAt), endedAt: shift.endedAt == null ? null : numericTime(shift.endedAt), breaks: (shift.breaks || []).map(pause => ({ startedAt: numericTime(pause.startedAt), endedAt: pause.endedAt == null ? null : numericTime(pause.endedAt) })) }));
    renderDashboard();
  }
  function renderAccount() {
    if (!session.user) return;
    const name = session.user.name, role = isAdmin() ? 'Администратор' : (session.user.position || 'Сотрудник');
    $$('[data-account-name]').forEach(element => { element.textContent = name; });
    $$('[data-account-role]').forEach(element => { element.textContent = role; });
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    $$('[data-avatar]').forEach(element => { element.textContent = initials; });
    $('#nav-role').textContent = isAdmin() ? 'ПАНЕЛЬ АДМИНИСТРАТОРА' : 'ЛИЧНЫЙ КАБИНЕТ';
    $('#breadcrumb-role').textContent = isAdmin() ? 'Администрирование' : 'Личный кабинет';
    $$('[data-admin]').forEach(element => { element.hidden = !isAdmin(); });
    $$('[data-permission]').forEach(element => { element.hidden = !can(element.dataset.permission); });
    $('#team-context').hidden = !isAdmin() || ['employees', 'audit'].includes(view);
  }
  function plannedHours() {
    const schedule = dashboard.schedule;
    if (!schedule) return 8;
    const minutes = value => { const [hours, mins] = value.split(':').map(Number); return hours * 60 + mins; };
    let span = minutes(schedule.endTime) - minutes(schedule.startTime);
    if (span <= 0) span += 1440;
    return Math.max(0, span - Number(schedule.breakMinutes)) / 60;
  }
  function renderTimer() {
    if (!session.user || !dashboard.user) return;
    const current = now(), active = activeShift();
    const metric = active ? metrics(active, current) : { workMs: 0, breakMs: 0, status: 'idle' };
    const paused = metric.status === 'break';
    const trackingAllowed = can('track_time') && !dashboard.user.archived && dashboard.user.active;
    $('#timer').textContent = duration(metric.workMs);
    $('#shift-status').className = `status-badge ${active ? paused ? 'paused' : 'working' : 'idle'}`;
    $('#shift-status').innerHTML = `<span class="status-dot"></span><span>${active ? paused ? 'На перерыве' : 'В работе' : 'Не начата'}</span>`;
    $('#timer-subtitle').textContent = !trackingAllowed ? 'Учёт смен недоступен. Обратитесь к администратору.' : active ? paused ? `Перерыв: ${duration(current - active.breaks.at(-1).startedAt)}` : `Начало в ${timeFormatter.format(active.startedAt)} · Перерывы: ${readable(metric.breakMs)}` : 'Готовы начать? Ваше время начинается здесь.';
    $('#start-button').hidden = !!active; $('#pause-button').hidden = !active || paused; $('#resume-button').hidden = !active || !paused;
    ['start', 'pause', 'resume', 'finish'].forEach(action => { $(`#${action}-button`).disabled = mutationBusy || !connected || !trackingAllowed || (action !== 'start' && !active); });
    const hours = plannedHours(), progress = hours > 0 ? Math.min(metric.workMs / (hours * HOUR) * 100, 100) : 0;
    $('#progress-fill').style.width = `${progress}%`; $('#shift-progress').setAttribute('aria-valuenow', String(Math.round(progress)));
    $('#progress-caption').textContent = `${(metric.workMs / HOUR).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} из ${hours.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} часов`;
    $('#current-date').textContent = dateFormatter.format(current); $('#today-label').textContent = dateFormatter.format(current);
    const today = dayStart(current), todayWork = totalBetween(today, today + DAY, current);
    $('#stat-today').innerHTML = statTime(todayWork); $('#stat-week').innerHTML = statTime(totalBetween(weekStart(current), current, current)); $('#stat-month').innerHTML = statTime(totalBetween(monthStart(current), current, current));
    $('#stat-breaks').innerHTML = `${Math.floor(dashboard.shifts.reduce((sum, shift) => sum + breakBetween(shift, today, today + DAY, current), 0) / MINUTE)} <span>мин</span>`;
    $('#stat-today-note').textContent = active ? paused ? 'Сейчас идёт перерыв' : 'Рабочее время идёт' : todayWork > 0 ? 'Время сохранено в истории' : 'Рабочий день ещё впереди';
  }
  function renderTimeline() {
    const current = now(), today = dayStart(current), events = [];
    const add = (time, title, description, symbol) => { if (time != null && time >= today && time <= current) events.push({ time, title, description, symbol }); };
    dashboard.shifts.forEach(shift => {
      add(shift.startedAt, 'Начало работы', 'Хорошего рабочего дня!', 'play');
      shift.breaks.forEach(pause => { add(pause.startedAt, 'Начало перерыва', 'Немного времени для себя', 'coffee'); if (pause.endedAt !== shift.endedAt) add(pause.endedAt, 'Снова за работу', 'Перерыв завершён', 'play'); });
      add(shift.endedAt, 'Смена завершена', 'Время сохранено в базе', 'check');
    });
    events.sort((a, b) => b.time - a.time);
    $('#timeline').innerHTML = events.length ? events.slice(0, 5).map(event => `<div class="timeline-item"><span class="timeline-marker">${icon(event.symbol)}</span><div class="timeline-content"><strong>${event.title}</strong><span>${event.description}</span></div><time class="timeline-time">${timeFormatter.format(event.time)}</time></div>`).join('') : '<div class="timeline-empty"><span class="empty-icon">' + icon('sun') + '</span><strong>Новый день — чистый лист</strong><p>Начните смену, и здесь появятся<br>события рабочего дня.</p></div>';
  }
  function renderWeek() {
    const current = now(), monday = weekStart(current);
    const days = weekdays.map((label, index) => ({ label, date: monday + index * DAY, work: totalBetween(monday + index * DAY, monday + (index + 1) * DAY, current) }));
    const maximum = Math.max(8 * HOUR, ...days.map(day => day.work));
    $('#week-chart').innerHTML = days.map(day => `<div class="chart-column${dateKey(day.date) === dateKey(current) ? ' today' : ''}"><span class="chart-value">${day.work ? `${(day.work / HOUR).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ч` : '—'}</span><div class="chart-bar-space"><div class="chart-bar${day.work ? '' : ' empty'}" style="height:${Math.max(day.work / maximum * 100, 3)}%" title="${dateFormatter.format(day.date)}: ${readable(day.work)}"></div></div><span class="chart-label">${day.label}</span></div>`).join('');
    $('#week-range').textContent = `${dateFormatter.format(monday)} — ${dateFormatter.format(monday + 6 * DAY)}`;
    $('#week-total').textContent = readable(days.reduce((sum, day) => sum + day.work, 0));
  }
  function emptyState(title, description) { return `<div class="empty-state"><span class="empty-icon">${icon('history')}</span><strong>${escapeHTML(title)}</strong><p>${escapeHTML(description)}</p></div>`; }
  function shiftTable(shifts, compact = false) {
    if (!shifts.length) return emptyState('Смен пока нет', 'Начните работу — первая запись появится здесь.');
    const editable = !compact && can('edit_own_shifts');
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Дата</th><th>${compact ? 'Отработано' : 'Начало / конец'}</th>${compact ? '' : '<th>Перерывы</th><th>Отработано</th>'}<th>Статус</th>${editable ? '<th>Действия</th>' : ''}</tr></thead><tbody>${shifts.map(shift => {
      const metric = metrics(shift), label = metric.status === 'finished' ? 'Завершена' : metric.status === 'break' ? 'Перерыв' : 'В работе';
      const ending = shift.endedAt == null ? '—' : timeFormatter.format(shift.endedAt) + (dateKey(shift.endedAt) !== dateKey(shift.startedAt) ? ` · ${dateFormatter.format(shift.endedAt)}` : '');
      return `<tr><td><span class="table-date">${dateFormatter.format(shift.startedAt)}</span><span class="table-secondary">${zonedDate(shift.startedAt).getUTCFullYear()}</span>${shift.note ? `<span class="shift-note" title="${escapeHTML(shift.note)}">${escapeHTML(shift.note)}</span>` : ''}</td><td${compact ? ' class="table-duration"' : ''}>${compact ? readable(metric.workMs) : `${timeFormatter.format(shift.startedAt)} <span class="table-secondary inline">/ ${ending}</span>`}</td>${compact ? '' : `<td>${readable(metric.breakMs)}</td><td class="table-duration">${readable(metric.workMs)}</td>`}<td><span class="pill ${metric.status === 'working' ? 'active' : metric.status === 'break' ? 'paused' : ''}">${label}</span></td>${editable ? `<td><div class="row-actions"><button class="button small" data-action="edit-shift" data-id="${escapeHTML(shift.id)}">Изменить</button><button class="button small danger" data-action="delete-shift" data-id="${escapeHTML(shift.id)}" aria-label="Удалить смену от ${dateFormatter.format(shift.startedAt)}">Удалить</button></div></td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
  }
  function renderHistory() {
    const from = $('#history-from').value, to = $('#history-to').value, status = $('#history-status').value;
    if (from && to && from > to) { $('#history-summary').textContent = 'Дата начала должна быть не позже даты окончания.'; $('#history-table').innerHTML = ''; return; }
    const shifts = sortedShifts().filter(shift => (!from || dateKey(shift.startedAt) >= from) && (!to || dateKey(shift.startedAt) <= to) && (status === 'all' || (status === 'finished' ? shift.endedAt != null : shift.endedAt == null)));
    $('#history-summary').textContent = `Найдено смен: ${shifts.length}. Фильтр по дате начала. Время Казахстана, UTC+5.`;
    $('#history-table').innerHTML = shifts.length ? shiftTable(shifts) : emptyState('Подходящих смен пока нет', 'Измените фильтры или добавьте первую смену.');
  }
  function renderDashboard() {
    if (!dashboard.user) return;
    $('#selected-name').textContent = dashboard.user.name; $('#selected-meta').textContent = [dashboard.user.position, dashboard.user.department].filter(Boolean).join(' · ') || 'Профиль сотрудника';
    $('#overview-description').textContent = isAdmin() ? `Рабочее время: ${dashboard.user.name}. Управляйте сменами и перерывами.` : 'Время для хорошей работы. А подсчёты — на нас.';
    const schedule = dashboard.schedule;
    $('#schedule-summary').textContent = schedule ? `${schedule.startTime}–${schedule.endTime} · ${schedule.weekdays.map(day => weekdays[day - 1]).join(', ') || 'Без рабочих дней'}` : 'График не задан';
    renderAccount(); renderTimer(); renderTimeline(); renderWeek(); renderHistory();
    $('#recent-shifts').innerHTML = shiftTable(sortedShifts().slice(0, 3), true);
  }
  function renderEmployees() {
    if (!isAdmin()) return;
    const search = $('#employee-search').value.trim().toLocaleLowerCase('ru-RU'), includeArchived = $('#show-archived').checked;
    const team = users.filter(user => user.role !== 'admin');
    $('#team-stats').innerHTML = `<div><strong>${team.filter(user => !user.archived).length}</strong><span>сотрудников</span></div><div><strong>${team.filter(user => !user.archived && user.active).length}</strong><span>с доступом</span></div><div><strong>${team.filter(user => !user.archived && !user.active).length}</strong><span>заблокировано</span></div><div><strong>${team.filter(user => user.archived).length}</strong><span>в архиве</span></div>`;
    const rows = users.filter(user => (includeArchived || !user.archived) && `${user.name} ${user.username} ${user.department} ${user.position}`.toLocaleLowerCase('ru-RU').includes(search));
    $('#employees-table').innerHTML = rows.length ? `<div class="table-wrap"><table class="data-table employee-table"><thead><tr><th>Сотрудник</th><th>Должность / отдел</th><th>Доступ</th><th>Действия</th></tr></thead><tbody>${rows.map(user => `<tr><td><span class="table-date">${escapeHTML(user.name)}</span><span class="table-secondary">${escapeHTML(user.username)}</span></td><td>${escapeHTML(user.position || '—')}<span class="table-secondary">${escapeHTML(user.department || 'Без отдела')}</span></td><td><span class="pill ${user.active ? 'active' : 'paused'}">${user.role === 'admin' ? 'Администратор' : user.archived ? 'Архив' : user.active ? 'Разрешён' : 'Заблокирован'}</span><span class="table-secondary">${user.role === 'admin' ? 'Все права' : `Прав: ${user.permissions.length} из ${Object.keys(permissions).length}`}</span></td><td><div class="row-actions"><button class="button small" data-action="view-user" data-id="${escapeHTML(user.id)}">Смены</button><button class="button small" data-action="user-schedule" data-id="${escapeHTML(user.id)}">График</button>${user.role === 'admin' ? '<button class="button small" data-action="profile">Профиль</button>' : `<button class="button small" data-action="edit-user" data-id="${escapeHTML(user.id)}">Профиль и права</button>${user.archived ? `<button class="button small" data-action="restore-user" data-id="${escapeHTML(user.id)}">Восстановить</button>` : `<button class="button small ${user.active ? '' : 'dark'}" data-action="toggle-user" data-id="${escapeHTML(user.id)}">${user.active ? 'Заблокировать' : 'Разблокировать'}</button><button class="button small danger" data-action="archive-user" data-id="${escapeHTML(user.id)}">В архив</button>`}`}</div></td></tr>`).join('')}</tbody></table></div>` : emptyState('Сотрудников не найдено', 'Измените поиск или добавьте сотрудника в команду.');
  }
  function validateRange(from, to) {
    if (!from || !to || from > to) throw new Error('Укажите даты: начало периода должно быть не позже окончания.');
    if ((dayFromKey(to) - dayFromKey(from)) / DAY >= 366) throw new Error('Выберите период не длиннее 366 дней.');
  }
  async function loadReport() {
    if (!can('view_reports')) return;
    const from = $('#report-from').value, to = $('#report-to').value; validateRange(from, to);
    const request = ++reportRequest;
    const report = await api(`/api/reports?${queryForUser({ from, to })}`);
    if (request !== reportRequest || !session.user) return;
    $('#report-hours').textContent = readable(report.totals.workMs); $('#report-count').textContent = report.totals.completedShifts; $('#report-average').textContent = readable(report.totals.averageMs);
    $('#report-caption').textContent = `${dateFormatter.format(dayFromKey(from))} — ${dateFormatter.format(dayFromKey(to))} · UTC+5`;
    const days = report.days.filter(day => day.workMs > 0 || day.breakMs > 0);
    $('#report-table').innerHTML = days.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Дата</th><th>Отработано</th><th>Перерывы</th></tr></thead><tbody>${days.map(day => `<tr><td>${escapeHTML(day.date)}</td><td class="table-duration">${readable(day.workMs)}</td><td>${readable(day.breakMs)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('В этом периоде пока тихо', 'Выберите другие даты или начните первую смену.');
  }
  async function exportReport(historyExport = false) {
    const shifts = sortedShifts();
    const from = historyExport ? ($('#history-from').value || (shifts.length ? dateKey(Math.max(shifts.at(-1).startedAt, dayStart(now()) - 365 * DAY)) : dateKey(monthStart(now())))) : $('#report-from').value;
    const to = historyExport ? ($('#history-to').value || dateKey(now())) : $('#report-to').value;
    validateRange(from, to);
    const blob = await api(`/api/export?${queryForUser({ from, to })}`, { binary: true });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `smena-${from}-${to}.csv`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notify('CSV-отчёт скачан.');
  }
  function auditDetails(entry) {
    let details = entry.details || {};
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return escapeHTML(details); } }
    const labels = { name: 'Имя', username: 'Логин', position: 'Должность', department: 'Отдел', active: 'Вход разрешён', archived: 'В архиве', passwordReset: 'Пароль сброшен', permissions: 'Права доступа', userId: 'Сотрудник', startedAt: 'Начало смены', endedAt: 'Конец смены', breaks: 'Перерывы', note: 'Комментарий', startTime: 'Начало рабочего дня', endTime: 'Конец рабочего дня', breakMinutes: 'Плановый перерыв, мин', weekdays: 'Рабочие дни', timezone: 'Часовой пояс', from: 'С даты', to: 'По дату' };
    const format = (key, value) => {
      if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
      if (value == null) return key === 'endedAt' ? 'Продолжается' : '—';
      if (key === 'userId') return users.find(user => String(user.id) === String(value))?.name || 'Сотрудник';
      if (key === 'permissions') return value.map(permission => permissions[permission]?.[0] || permission).join(', ') || 'Нет дополнительных прав';
      if (key === 'weekdays') return value.map(day => weekdays[day - 1]).join(', ') || 'Не заданы';
      if (['startedAt', 'endedAt'].includes(key)) return fullFormatter.format(numericTime(value));
      if (key === 'breaks') return value.map(pause => `${fullFormatter.format(numericTime(pause.startedAt))} — ${pause.endedAt == null ? 'продолжается' : fullFormatter.format(numericTime(pause.endedAt))}`).join('; ') || 'Без перерывов';
      return String(value);
    };
    const lines = Object.entries(details).filter(([key]) => labels[key]).map(([key, value]) => `${labels[key]}: ${format(key, value)}`);
    return escapeHTML(lines.join('\n') || 'Действие выполнено успешно.');
  }
  async function loadAudit() {
    if (!isAdmin()) return;
    const data = await api('/api/audit');
    const actions = { 'setup': 'Создание администратора', 'auth.setup': 'Создание администратора', 'login': 'Вход в систему', 'auth.login': 'Вход в систему', 'logout': 'Выход из системы', 'auth.logout': 'Выход из системы', 'user.create': 'Создан сотрудник', 'user.update': 'Изменён сотрудник', 'user.archive': 'Сотрудник отправлен в архив', 'profile.update': 'Обновлён профиль', 'password.change': 'Изменён пароль', 'auth.password_change': 'Изменён пароль', 'schedule.update': 'Изменён график', 'shift.start': 'Начата смена', 'shift.pause': 'Начат перерыв', 'shift.resume': 'Завершён перерыв', 'shift.finish': 'Завершена смена', 'shift.create': 'Добавлена смена', 'shift.update': 'Изменена смена', 'shift.delete': 'Удалена смена' };
    Object.assign(actions, { admin_created: 'Создан аккаунт администратора', user_created: 'Создан сотрудник', user_updated: 'Изменён сотрудник', user_archived: 'Сотрудник отправлен в архив', profile_updated: 'Обновлён профиль', password_changed: 'Изменён пароль', schedule_updated: 'Изменён график', shift_started: 'Начата смена', break_started: 'Начат перерыв', break_finished: 'Завершён перерыв', shift_finished: 'Завершена смена', shift_created: 'Добавлена смена', shift_updated: 'Изменена смена', shift_deleted: 'Удалена смена', report_exported: 'Скачан отчёт CSV' });
    $('#audit-table').innerHTML = data.entries.length ? `<div class="table-wrap"><table class="data-table audit-table"><thead><tr><th>Дата и время</th><th>Пользователь</th><th>Действие</th><th>Подробности</th></tr></thead><tbody>${data.entries.map(entry => `<tr><td>${fullFormatter.format(numericTime(entry.createdAt))}</td><td>${escapeHTML(entry.actorName || 'Система')}</td><td>${escapeHTML(actions[entry.action] || entry.action)}</td><td><details><summary>${escapeHTML(entry.targetType === 'user' ? (users.find(user => String(user.id) === String(entry.targetId))?.name || 'Сотрудник') : entry.targetType === 'shift' ? 'Изменения смены' : 'Подробнее')}</summary><pre>${auditDetails(entry)}</pre></details></td></tr>`).join('')}</tbody></table></div>` : emptyState('Журнал пока пуст', 'Изменения появятся здесь автоматически.');
  }
  async function setView(name) {
    if (!viewNames[name] || (!isAdmin() && ['employees', 'audit'].includes(name)) || (name === 'reports' && !can('view_reports'))) name = 'overview';
    const previousView = view;
    view = name;
    $$('.section-view').forEach(element => { element.hidden = element.id !== `view-${name}`; });
    $$('.nav-link').forEach(element => { const active = element.dataset.view === name; element.classList.toggle('active', active); if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current'); });
    $('#breadcrumb-current').textContent = viewNames[name];
    if (previousView !== name) document.dispatchEvent(new CustomEvent('smena:viewchange', { detail: { view: name } }));
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    renderAccount();
    if (name === 'employees') await loadUsers();
    if (name === 'reports') await loadReport();
    if (name === 'audit') await loadAudit();
  }
  async function refresh() {
    if (!session.user || refreshBusy || mutationBusy || document.hidden) return;
    refreshBusy = true;
    const refreshToken = session.csrfToken;
    try {
      const latest = await api('/api/session');
      if (!session.user || session.csrfToken !== refreshToken) return;
      if (!latest.user) { session = latest; showAuth(); return; }
      session = latest; renderAccount();
      if ((!isAdmin() && ['employees', 'audit'].includes(view)) || (view === 'reports' && !can('view_reports'))) await setView('overview');
      if (isAdmin()) await loadUsers();
      await loadDashboard();
      if (view === 'reports' && !$('dialog[open]') && !$('#report-filter-form').contains(document.activeElement) && $('#report-from').value && $('#report-to').value && $('#report-from').value <= $('#report-to').value && dayFromKey($('#report-to').value) - dayFromKey($('#report-from').value) < 366 * DAY) await loadReport();
      if (view === 'audit') await loadAudit();
    } catch (error) {
      if (session.user) connectionStatus(false, error.message);
    } finally { refreshBusy = false; }
  }
  async function mutate(task, message) {
    if (mutationBusy) return false;
    mutationBusy = true; renderTimer();
    $$('dialog[open] button, #auth-submit').forEach(button => { button.disabled = true; });
    try { await task(); if (message) notify(message); return true; }
    finally { mutationBusy = false; $$('dialog button, #auth-submit').forEach(button => { button.disabled = false; }); renderTimer(); }
  }
  function confirmAction(title, description, label, callback, danger = false) {
    $('#confirm-title').textContent = title; $('#confirm-text').textContent = description;
    $('#confirm-button').textContent = label; $('#confirm-button').className = `button ${danger ? 'danger' : 'dark'}`;
    $('#confirm-error').textContent = ''; confirmCallback = callback; $('#confirm-dialog').showModal();
  }
  function openProfile() {
    $('#profile-form').reset(); $('#password-form').reset();
    $('#profile-login').textContent = session.user.username; $('#profile-role').textContent = isAdmin() ? 'Администратор · все права' : 'Сотрудник';
    $('#profile-name').value = session.user.name; $('#profile-position').value = session.user.position || ''; $('#profile-department').value = session.user.department || '';
    $('#profile-error').textContent = ''; $('#password-error').textContent = '';
    const editable = can('edit_own_profile');
    $$('#profile-form input').forEach(input => { input.disabled = !editable; });
    if (isAdmin()) $('#profile-name').disabled = true;
    $('#profile-submit').hidden = !editable; $('#profile-permission-note').hidden = editable;
    $('#profile-dialog').showModal();
  }
  function openEmployee(id = null) {
    const employee = id == null ? null : users.find(user => String(user.id) === String(id));
    if (employee?.role === 'admin') { openProfile(); return; }
    editingEmployeeId = employee?.id ?? null; $('#employee-form').reset();
    $('#employee-title').textContent = employee ? 'Профиль и права' : 'Новый сотрудник';
    $('#edit-name').value = employee?.name || ''; $('#edit-username').value = employee?.username || ''; $('#edit-position').value = employee?.position || ''; $('#edit-department').value = employee?.department || '';
    $('#edit-password').required = !employee; $('#edit-password-label').textContent = employee ? 'Новый пароль — оставьте пустым, чтобы сохранить' : 'Пароль — от 10 символов';
    $('#edit-active').checked = employee ? employee.active : true; $('#employee-active-label').hidden = !employee;
    $('#permission-options').innerHTML = Object.entries(permissions).map(([key, [title, description]]) => `<label class="permission-option"><input type="checkbox" name="permission" value="${key}"${(employee ? employee.permissions : ['track_time', 'edit_own_profile', 'view_reports', 'export_reports']).includes(key) ? ' checked' : ''}><span><strong>${title}</strong><small>${description}</small></span></label>`).join('');
    $('#employee-error').textContent = ''; $('#employee-dialog').showModal();
  }
  async function openSchedule(id = selectedUserId) {
    scheduleUserId = id;
    const data = await api(`/api/schedules/${encodeURIComponent(id)}`), schedule = data.schedule || data;
    const employee = users.find(user => String(user.id) === String(id));
    $('#schedule-person').textContent = employee?.name || dashboard.user.name;
    $('#schedule-start').value = schedule.startTime || '09:00'; $('#schedule-end').value = schedule.endTime || '18:00'; $('#schedule-break').value = schedule.breakMinutes ?? 60;
    $('#schedule-weekdays').innerHTML = weekdays.map((label, index) => `<label class="weekday-option"><input type="checkbox" value="${index + 1}"${(schedule.weekdays || [1, 2, 3, 4, 5]).includes(index + 1) ? ' checked' : ''}><span>${label}</span></label>`).join('');
    $('#schedule-error').textContent = ''; $('#schedule-dialog').showModal();
  }
  function addBreakRow(pause = {}) {
    breakSequence += 1;
    const row = document.createElement('div'); row.className = 'break-row';
    row.innerHTML = `<div class="field"><label for="break-start-${breakSequence}">Начало перерыва</label><input type="datetime-local" id="break-start-${breakSequence}" data-break-start required step="1" value="${pause.startedAt != null ? dateInput(pause.startedAt) : ''}"></div><div class="field"><label for="break-end-${breakSequence}">Конец перерыва</label><input type="datetime-local" id="break-end-${breakSequence}" data-break-end step="1" value="${pause.endedAt != null ? dateInput(pause.endedAt) : ''}"></div><button type="button" class="close-button" data-action="remove-break" aria-label="Удалить перерыв">×</button>`;
    $('#shift-breaks').append(row);
  }
  function openShift(id = null) {
    const shift = id == null ? null : dashboard.shifts.find(item => String(item.id) === String(id));
    editingShift = shift ? { ...shift } : null; $('#shift-form').reset();
    $('#shift-title').textContent = shift ? 'Изменить смену' : 'Добавить смену';
    $('#shift-start').value = dateInput(shift?.startedAt ?? now()); $('#shift-end').value = shift?.endedAt != null ? dateInput(shift.endedAt) : '';
    $('#shift-note').value = shift?.note || ''; $('#shift-breaks').replaceChildren(); (shift?.breaks || []).forEach(addBreakRow);
    $('#shift-error').textContent = ''; $('#shift-dialog').showModal();
  }
  async function selectUser(id, targetView = null) {
    selectedUserId = id; $('#selected-user').value = String(id); reportRequest += 1;
    await loadDashboard();
    if (targetView) await setView(targetView); else if (view === 'reports') await loadReport();
  }
  async function afterUserChange() { await loadUsers(); await loadDashboard(); }

  document.addEventListener('click', async event => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) { try { await setView(viewButton.dataset.view); } catch (error) { notify(error.message, true); } return; }
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    const { action, id } = button.dataset;
    try {
      if (action === 'close-dialog') { button.closest('dialog').close(); return; }
      if (action === 'retry') { await initialize(); return; }
      if (!session.user) return;
      if (action === 'profile') openProfile();
      if (action === 'logout') await mutate(async () => { await api('/api/logout', { method: 'POST', body: {} }); session.user = null; selectedUserId = null; dashboardRequest += 1; reportRequest += 1; $$('dialog[open]').forEach(dialog => dialog.close()); await initialize(); });
      if (action === 'start') await mutate(async () => { await api('/api/shifts/start', { method: 'POST', body: { userId: selectedUserId } }); await loadDashboard(); }, 'Смена началась. Хорошего рабочего дня!');
      if (action === 'pause' || action === 'resume') { const active = activeShift(); if (active) await mutate(async () => { await api(`/api/shifts/${encodeURIComponent(active.id)}/${action}`, { method: 'POST', body: {} }); await loadDashboard(); }, action === 'pause' ? 'Перерыв начался. Рабочий таймер приостановлен.' : 'Перерыв завершён. Продолжаем работу.'); }
      if (action === 'finish') {
        const active = activeShift(); if (!active) return;
        confirmAction('Завершить рабочий день?', `Отработано: ${readable(metrics(active).workMs)}. Открытый перерыв завершится вместе со сменой.`, 'Завершить смену', async () => { await api(`/api/shifts/${encodeURIComponent(active.id)}/finish`, { method: 'POST', body: {} }); await loadDashboard(); notify('Смена завершена и сохранена.'); });
      }
      if (action === 'confirm' && confirmCallback) {
        try { const done = await mutate(confirmCallback); if (done) $('#confirm-dialog').close(); } catch (error) { $('#confirm-error').textContent = error.message; }
      }
      if (action === 'reset-filters') { $('#history-from').value = ''; $('#history-to').value = ''; $('#history-status').value = 'all'; renderHistory(); }
      if (action === 'export-history') await exportReport(true);
      if (action === 'export-report') await exportReport();
      if (action === 'refresh-audit') await loadAudit();
      if (action === 'add-user') openEmployee();
      if (action === 'edit-user') openEmployee(id);
      if (action === 'view-user') await selectUser(id, 'history');
      if (action === 'schedule') await openSchedule();
      if (action === 'user-schedule') await openSchedule(id);
      if (action === 'toggle-user') {
        const user = users.find(item => String(item.id) === String(id));
        confirmAction(user.active ? 'Заблокировать вход?' : 'Разрешить вход?', `${user.name}: ${user.active ? 'действующие сеансы будут закрыты. Смены останутся в базе.' : 'сотрудник снова сможет войти в свой аккаунт.'}`, user.active ? 'Заблокировать' : 'Разблокировать', async () => { await api(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { active: !user.active } }); await afterUserChange(); notify('Доступ сотрудника обновлён.'); });
      }
      if (action === 'archive-user') {
        const user = users.find(item => String(item.id) === String(id));
        confirmAction('Отправить сотрудника в архив?', `${user.name} больше не сможет войти. Его смены и история сохранятся; аккаунт можно восстановить из архива.`, 'В архив', async () => { await api(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }); await afterUserChange(); notify('Сотрудник перемещён в архив.'); }, true);
      }
      if (action === 'restore-user') await mutate(async () => { await api(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { archived: false, active: true } }); await afterUserChange(); }, 'Сотрудник восстановлен, вход разрешён.');
      if (action === 'add-shift') openShift();
      if (action === 'edit-shift') openShift(id);
      if (action === 'delete-shift') {
        const shift = dashboard.shifts.find(item => String(item.id) === String(id));
        confirmAction('Удалить запись смены?', `Смена от ${fullFormatter.format(shift.startedAt)} будет удалена из учёта. Действие останется в журнале.`, 'Удалить смену', async () => { await api(`/api/shifts/${encodeURIComponent(id)}`, { method: 'DELETE', body: { version: shift.version } }); await loadDashboard(); notify('Смена удалена.'); }, true);
      }
      if (action === 'add-break') addBreakRow();
      if (action === 'remove-break') button.closest('.break-row').remove();
    } catch (error) { notify(error.message, true); }
  });

  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#auth-error').textContent = '';
    const password = $('#auth-password').value;
    if (session.setupRequired && password !== $('#auth-confirm').value) { $('#auth-error').textContent = 'Пароли не совпадают.'; return; }
    try {
      await mutate(async () => {
        session = await api(session.setupRequired ? '/api/setup' : '/api/login', { method: 'POST', body: session.setupRequired ? { password } : { username: $('#auth-username').value.trim(), password }, allowUnauthorized: true });
        await enterApp();
      });
    } catch (error) { $('#auth-error').textContent = error.message; }
  });
  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#profile-error').textContent = '';
    try { await mutate(async () => { const result = await api('/api/profile', { method: 'PATCH', body: { name: $('#profile-name').value.trim(), position: $('#profile-position').value.trim(), department: $('#profile-department').value.trim() } }); session.user = result.user; renderAccount(); if (isAdmin()) await loadUsers(); await loadDashboard(); $('#profile-dialog').close(); }, 'Профиль сохранён.'); }
    catch (error) { $('#profile-error').textContent = error.message; }
  });
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#password-error').textContent = '';
    if ($('#new-password').value !== $('#confirm-password').value) { $('#password-error').textContent = 'Новые пароли не совпадают.'; return; }
    try { await mutate(async () => { await api('/api/change-password', { method: 'POST', body: { currentPassword: $('#current-password').value, newPassword: $('#new-password').value } }); $('#password-form').reset(); $('#profile-dialog').close(); session.user = null; dashboardRequest += 1; await initialize(); }, 'Пароль изменён. Войдите с новым паролем.'); }
    catch (error) { $('#password-error').textContent = error.message; }
  });
  $('#employee-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#employee-error').textContent = '';
    const payload = { name: $('#edit-name').value.trim(), username: $('#edit-username').value.trim(), position: $('#edit-position').value.trim(), department: $('#edit-department').value.trim(), permissions: $$('#permission-options input:checked').map(input => input.value) };
    if ($('#edit-password').value) payload.password = $('#edit-password').value;
    if (editingEmployeeId != null) payload.active = $('#edit-active').checked;
    try { await mutate(async () => { await api(editingEmployeeId == null ? '/api/users' : `/api/users/${encodeURIComponent(editingEmployeeId)}`, { method: editingEmployeeId == null ? 'POST' : 'PATCH', body: payload }); await afterUserChange(); $('#edit-password').value = ''; $('#employee-dialog').close(); }, 'Сотрудник сохранён.'); }
    catch (error) { $('#employee-error').textContent = error.message; }
  });
  $('#schedule-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#schedule-error').textContent = '';
    const payload = { startTime: $('#schedule-start').value, endTime: $('#schedule-end').value, breakMinutes: Number($('#schedule-break').value), weekdays: $$('#schedule-weekdays input:checked').map(input => Number(input.value)), timezone: ZONE };
    try { await mutate(async () => { await api(`/api/schedules/${encodeURIComponent(scheduleUserId)}`, { method: 'PUT', body: payload }); await loadDashboard(); $('#schedule-dialog').close(); }, 'Рабочий график сохранён.'); }
    catch (error) { $('#schedule-error').textContent = error.message; }
  });
  $('#shift-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#shift-error').textContent = '';
    const payload = { startedAt: parseInput($('#shift-start').value), endedAt: parseInput($('#shift-end').value), breaks: $$('#shift-breaks .break-row').map(row => ({ startedAt: parseInput(row.querySelector('[data-break-start]').value), endedAt: parseInput(row.querySelector('[data-break-end]').value) })), note: $('#shift-note').value.trim() };
    if (editingShift) payload.version = editingShift.version; else payload.userId = selectedUserId;
    try {
      if (payload.endedAt != null && payload.endedAt <= payload.startedAt) throw new Error('Конец смены должен быть позже её начала.');
      await mutate(async () => { await api(editingShift ? `/api/shifts/${encodeURIComponent(editingShift.id)}` : '/api/shifts', { method: editingShift ? 'PATCH' : 'POST', body: payload }); await loadDashboard(); $('#shift-dialog').close(); }, 'Смена сохранена.');
    } catch (error) { $('#shift-error').textContent = error.status === 409 ? `${error.message} Закройте форму и откройте смену заново, чтобы получить актуальные данные.` : error.message; if (error.status === 409) await loadDashboard().catch(() => {}); }
  });
  $('#report-filter-form').addEventListener('submit', async event => { event.preventDefault(); try { await loadReport(); } catch (error) { notify(error.message, true); } });
  ['#history-from', '#history-to', '#history-status'].forEach(selector => $(selector).addEventListener('change', renderHistory));
  $('#employee-search').addEventListener('input', renderEmployees); $('#show-archived').addEventListener('change', renderEmployees);
  $('#selected-user').addEventListener('change', async event => { try { await selectUser(event.target.value); } catch (error) { notify(error.message, true); } });
  window.addEventListener('hashchange', () => { if (session.user) void setView(location.hash.slice(1)).catch(error => notify(error.message, true)); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('focus', () => { void refresh(); });
  window.addEventListener('online', () => { void refresh(); });
  window.addEventListener('offline', () => { connectionStatus(false); renderTimer(); });
  setInterval(renderTimer, 1000);
  setInterval(() => { if (session.user && !document.hidden) { renderWeek(); renderTimeline(); } }, 60000);
  setInterval(() => { void refresh(); }, 20000);
  void initialize();
})();
