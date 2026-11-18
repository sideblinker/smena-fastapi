/* Смена: сервер — единственный источник данных. Пароли и смены не хранятся в localStorage. */
(() => {
  'use strict';
  // Одноразовый ключ первого запуска приходит только во фрагменте ссылки.
  // Он не попадает в URL запросов и остаётся исключительно в памяти вкладки.
  let setupToken = (() => /^#setup=([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1] || '')();
  if (location.hash.startsWith('#setup=')) history.replaceState(null, '', `${location.pathname}${location.search}`);
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  // FastAPI supplies the first page and the state needed by interactive controls.
  // The hosted static edition has no bootstrap and retains its SPA navigation.
  const bootstrapElement = $('#smena-bootstrap');
  const serverRendered = !!bootstrapElement;
  let pageNavigating = false;
  const HOUR = 3600000, MINUTE = 60000, DAY = 24 * HOUR, ZONE = 'Asia/Qyzylorda';
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const permissions = {
    track_time: ['Учёт рабочего времени', 'Начинать и завершать свою смену, отмечать перерывы'],
    edit_own_profile: ['Изменение профиля', 'Редактировать своё имя, должность и отдел'],
    edit_own_shifts: ['Добавление и удаление своих смен', 'Добавлять и удалять собственные записи. Исправлять свои смены можно всегда'],
    view_reports: ['Просмотр отчётов', 'Видеть итоги своего рабочего времени'],
    export_reports: ['Экспорт CSV', 'Скачивать отчёты о своём времени']
  };
  const viewNames = { overview: 'Обзор', history: 'История смен', calendar: 'Календарь', requests: 'Заявки', employees: 'Сотрудники', reports: 'Отчёты', timesheet: 'Табель', audit: 'Журнал действий' };
  const requestLabels = { pending: 'На рассмотрении', approved: 'Одобрена', rejected: 'Отклонена', cancelled: 'Отменена' };
  const absenceLabels = { vacation: 'Отпуск', day_off: 'Отгул', other: 'Другое отсутствие' };
  const dayLabels = { upcoming: 'По графику', not_started: 'Не начата', working: 'В работе', break: 'Перерыв', finished: 'Завершена', missed: 'Не отмечена' };
  const teamLabels = { working: 'На работе', break: 'На перерыве', finished: 'Завершили', not_started: 'Не начали', absence: 'Отсутствуют', day_off: 'Выходной' };
  // Учёт и поля ввода используют UTC+5 даже для архивных дат.
  // Исторические переводы часов Asia/Qyzylorda не должны сдвигать показания.
  const DISPLAY_ZONE = 'Etc/GMT-5';
  const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: DISPLAY_ZONE });
  const timeFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: DISPLAY_ZONE });
  const fullFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: DISPLAY_ZONE });
  let session = { user: null, csrfToken: '', setupRequired: false };
  let users = [], dashboard = { user: null, schedule: null, shifts: [] }, selectedUserId = null;
  let view = 'overview', offset = 0, mutationBusy = false, refreshBusy = false, connected = true;
  let toastTimeout, editingEmployeeId = null, editingShift = null, scheduleUserId = null, confirmCallback = null;
  let reportRequest = 0, dashboardRequest = 0, breakSequence = 0;
  let calendarData = null, calendarRequest = 0, calendarDay = null;
  let teamData = null, teamRequest = 0, teamFilter = 'all';
  let timesheetData = null, timesheetRequest = 0, timesheetReady = false, absenceUserId = null;
  let absenceRequests = null, requestsRequest = 0, requestDecision = null;
  const shiftCache = new Map();

  function navigatePage(name = view, changes = {}, { replace = false } = {}) {
    const url = new URL(location.href);
    if (name !== view) url.search = '';
    url.pathname = '/'; url.hash = '';
    url.searchParams.set('view', name);
    if (selectedUserId != null) url.searchParams.set('userId', String(selectedUserId));
    url.searchParams.delete('page');
    Object.entries(changes).forEach(([key, value]) => {
      if (value == null || value === '') url.searchParams.delete(key);
      else url.searchParams.set(key, String(value));
    });
    pageNavigating = true;
    if (replace) location.replace(url.href); else location.assign(url.href);
  }
  function reloadPage() { pageNavigating = true; location.reload(); }
  function returnToLogin() { pageNavigating = true; location.replace('/'); }
  function submitPageFilter(element, changes = {}) {
    const form = element.closest('form');
    if (form?.method.toLowerCase() === 'get') {
      if (!validatePageFilter(form)) return;
      const pageInput = form.elements.namedItem('page');
      if (pageInput) pageInput.value = '1';
      form.requestSubmit();
    } else navigatePage(view, changes);
  }
  function validatePageFilter(form) {
    try {
      if (form.id === 'history-filter-form') {
        const from = $('#history-from').value, to = $('#history-to').value;
        if (from && to && from > to) throw new Error('Дата начала должна быть не позже даты окончания.');
      }
      if (form.id === 'report-filter-form') validateRange($('#report-from').value, $('#report-to').value);
      return true;
    } catch (error) { notify(error.message, true); return false; }
  }
  function normalizeShifts(shifts = []) {
    return shifts.map(shift => ({ ...shift, startedAt: numericTime(shift.startedAt), endedAt: shift.endedAt == null ? null : numericTime(shift.endedAt), breaks: (shift.breaks || []).map(pause => ({ ...pause, startedAt: numericTime(pause.startedAt), endedAt: pause.endedAt == null ? null : numericTime(pause.endedAt) })) }));
  }
  async function initializeServerPage() {
    try {
      const initial = JSON.parse(bootstrapElement.textContent);
      session = initial.session;
      users = initial.users || (session.user ? [session.user] : []);
      selectedUserId = initial.userId ?? session.user?.id ?? null;
      view = initial.view || 'overview';
      dashboard = initial.dashboard || { user: null, schedule: null, shifts: [] };
      dashboard.shifts = normalizeShifts(dashboard.shifts);
      syncClock(dashboard.serverNow != null ? dashboard : session);
      cacheShifts(dashboard.shifts);
      cacheShifts(normalizeShifts(initial.history?.shifts));
      calendarData = initial.calendar || null;
      if (calendarData) { calendarData.shifts = normalizeShifts(calendarData.shifts); cacheShifts(calendarData.shifts); }
      absenceRequests = initial.requests || null;
      teamData = initial.team || null;
      timesheetData = initial.timesheet || null;
      timesheetReady = !!timesheetData;
      // Initial rows, headings and filters remain exactly as rendered by Jinja2.
      // Only the running clock needs a client-side update.
      if (session.user) {
        renderTimer();
        const oldView = location.hash.slice(1);
        if (viewNames[oldView] && !new URLSearchParams(location.search).has('view') && oldView !== view) navigatePage(oldView, {}, { replace: true });
      } else if (setupToken) await initialize();
    } catch (error) {
      connectionStatus(false, 'Не удалось подготовить страницу. Обновите её, чтобы повторить загрузку.');
    }
  }

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const isAdmin = () => session.user?.role === 'admin';
  const can = permission => isAdmin() || !!session.user?.permissions?.includes(permission);
  const canEditShift = shift => !!session.user && (isAdmin() || String(shift.userId) === String(session.user.id));
  const canDeleteShift = shift => canEditShift(shift) && can('edit_own_shifts');
  const now = () => Date.now() + offset;
  const pad = value => String(value).padStart(2, '0');
  const numericTime = value => typeof value === 'number' ? value : Date.parse(value);
  const zonedDate = value => new Date(numericTime(value) + 5 * HOUR);
  const dateKey = value => { const date = zonedDate(value); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; };
  const dateInput = value => { const date = zonedDate(value); return `${dateKey(value)}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`; };
  function fillShiftTime(input, original, suggested = null) {
    const display = original ?? suggested;
    input.value = display == null ? '' : dateInput(display);
    input.dataset.originalTime = original == null ? '' : String(numericTime(original));
  }
  function readShiftTime(input) {
    if (!input.value) return null;
    const entered = Date.parse(`${input.value}+05:00`);
    // The editor displays whole seconds. Keep the recorded milliseconds when
    // the displayed second is unchanged, including the browser's HH:mm form.
    const original = Number(input.dataset.originalTime);
    if (input.dataset.originalTime && entered === Math.floor(original / 1000) * 1000) return original;
    return entered;
  }
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
  const monthLabel = value => new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: DISPLAY_ZONE }).format(dayFromKey(`${value}-01`));
  const shortHours = ms => `${(Math.max(0, Number(ms) || 0) / HOUR).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ч`;
  const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const lookupShift = id => shiftCache.get(String(id)) || dashboard.shifts.find(shift => String(shift.id) === String(id));
  function cacheShifts(shifts) {
    shifts.forEach(shift => {
      const old = shiftCache.get(String(shift.id));
      if (!old || Number(shift.version) >= Number(old.version)) shiftCache.set(String(shift.id), shift);
    });
  }

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
        if (serverRendered) returnToLogin();
        else { showAuth(); void initialize(); }
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
    $$('dialog[open]').forEach(dialog => dialog.close());
    confirmCallback = null;
    dashboardRequest += 1; reportRequest += 1;
    calendarRequest += 1; teamRequest += 1; timesheetRequest += 1;
    requestsRequest += 1; absenceRequests = null; requestDecision = null;
    calendarData = null; teamData = null; timesheetData = null; calendarDay = null; timesheetReady = false; shiftCache.clear();
    users = []; dashboard = { user: null, schedule: null, shifts: [] }; selectedUserId = null;
    editingShift = null; editingEmployeeId = null; absenceUserId = null; teamFilter = 'all';
    resetCalendarView(); invalidateTimesheet();
    $('#requests-list').replaceChildren(); $('#request-decision-summary').replaceChildren();
    ['#requests-summary', '#request-person', '#request-error', '#request-decision-error', '#request-decision-help'].forEach(selector => { $(selector).textContent = ''; });
    $('#requests-badge').textContent = ''; $('#requests-badge').hidden = true; $('#requests-badge').removeAttribute('aria-label');
    $('#requests-filter').value = 'all'; planningFeedback('#requests-feedback');
    $('#requests-list').setAttribute('aria-busy', 'false');
    ['#employees-table', '#history-table', '#recent-shifts', '#report-table', '#audit-table', '#timeline', '#week-chart', '#team-stats', '#team-live-members', '#team-live-filters', '#selected-user', '#day-detail-body', '#permission-options', '#shift-breaks', '#schedule-weekdays'].forEach(selector => $(selector).replaceChildren());
    ['#selected-name', '#selected-meta', '#profile-login', '#profile-role', '#day-detail-person', '#absence-person', '#schedule-person', '#confirm-title', '#confirm-text', '#confirm-error', '#week-total'].forEach(selector => { $(selector).textContent = ''; });
    $$('[data-account-name], [data-account-role], [data-avatar]').forEach(element => { element.textContent = ''; });
    $$('dialog form').forEach(form => form.reset());
    ['#report-hours', '#report-count', '#report-average'].forEach(selector => { $(selector).textContent = '—'; });
    ['#stat-today', '#stat-week', '#stat-month'].forEach(selector => { $(selector).innerHTML = statTime(0); });
    $('#stat-breaks').textContent = '0 мин'; $('#timer').textContent = '00:00:00';
    $('#calendar-person').textContent = 'План, факт и время для отдыха.';
    $('#day-detail-title').textContent = 'Рабочий день'; $('#history-summary').textContent = '';
    $('#timesheet-title').textContent = 'Месячный табель';
    ['#calendar-feedback', '#timesheet-feedback', '#team-live-feedback'].forEach(selector => planningFeedback(selector));
    document.body.classList.remove('printing-timesheet'); document.body.dataset.view = 'overview';
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
    if (serverRendered && !setupToken) { returnToLogin(); return; }
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
    if (serverRendered) { navigatePage('overview', {}, { replace: true }); return; }
    $('#auth-form').reset(); $('#auth-error').textContent = '';
    if (isAdmin()) await loadUsers(); else users = [session.user];
    $('#report-from').value = dateKey(monthStart(now())); $('#report-to').value = dateKey(now());
    $('#calendar-month').value = dateKey(now()).slice(0, 7); $('#timesheet-month').value = dateKey(now()).slice(0, 7);
    $('#timesheet-scope').value = isAdmin() ? 'all' : 'selected';
    $('#requests-filter').value = isAdmin() ? 'pending' : 'all';
    await loadDashboard();
    $('#auth-screen').hidden = true; $('#app').hidden = false;
    renderAccount();
    await setView(location.hash.slice(1) || 'overview');
    if (view !== 'requests') await loadRequests({ quiet: true });
  }
  async function loadUsers() {
    if (serverRendered && mutationBusy) return;
    if (!isAdmin()) return;
    const token = session.csrfToken;
    const data = await api('/api/users?includeArchived=1');
    if (!isAdmin() || session.csrfToken !== token) return;
    users = data.users;
    if (!users.some(user => String(user.id) === String(selectedUserId))) selectedUserId = session.user.id;
    $('#selected-user').innerHTML = users.map(user => `<option value="${escapeHTML(user.id)}">${escapeHTML(user.name)}${user.role === 'admin' ? ' · администратор' : user.archived ? ' · архив' : !user.active ? ' · заблокирован' : ''}</option>`).join('');
    $('#selected-user').value = String(selectedUserId);
    renderEmployees();
  }
  async function loadDashboard() {
    if (serverRendered && mutationBusy) return;
    if (!session.user || selectedUserId == null) return;
    const token = ++dashboardRequest;
    const result = await api(`/api/dashboard?${queryForUser({})}`);
    if (token !== dashboardRequest || !session.user) return;
    dashboard = result;
    dashboard.shifts = normalizeShifts(result.shifts);
    cacheShifts(dashboard.shifts);
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
    $$('[data-employee]').forEach(element => { element.hidden = isAdmin(); });
    $$('[data-permission]').forEach(element => { element.hidden = !can(element.dataset.permission); });
    $('#team-context').hidden = !isAdmin() || ['employees', 'audit', 'requests'].includes(view) || (view === 'timesheet' && $('#timesheet-scope').value === 'all');
    $('#requests-description').textContent = isAdmin() ? 'Заявки команды на отпуск и отгул. Рассмотрите даты и сообщите решение.' : 'Ваши заявки, решения администратора и история отдыха.';
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
    const subtitle = $('#timer-subtitle');
    if (!trackingAllowed) {
      subtitle.textContent = active && isAdmin() ? 'Учёт отключён. Можно завершить смену или исправить время её окончания.' : 'Учёт смен недоступен. Обратитесь к администратору.';
    } else if (paused) {
      subtitle.textContent = `Перерыв: ${duration(current - active.breaks.at(-1).startedAt)}`;
    } else {
      subtitle.textContent = active ? `Начало в ${timeFormatter.format(active.startedAt)} · Перерывы: ${readable(metric.breakMs)}` : 'Готовы начать? Ваше время начинается здесь.';
    }
    $('#start-button').hidden = !!active; $('#pause-button').hidden = !active || paused; $('#resume-button').hidden = !active || !paused;
    const controlsBusy = mutationBusy || !connected;
    ['start', 'pause', 'resume'].forEach(action => { $(`#${action}-button`).disabled = controlsBusy || !trackingAllowed || (action !== 'start' && !active); });
    $('#finish-button').disabled = controlsBusy || !active || !(trackingAllowed || isAdmin());
    const today = dayStart(current), todayWork = totalBetween(today, today + DAY, current);
    const hours = plannedHours(), progress = hours > 0 ? Math.min(todayWork / (hours * HOUR) * 100, 100) : 0;
    $('#progress-fill').style.width = `${progress}%`; $('#shift-progress').setAttribute('aria-valuenow', String(Math.round(progress)));
    $('#progress-caption').textContent = `${(todayWork / HOUR).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} из ${hours.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} часов`;
    $('#current-date').textContent = dateFormatter.format(current); $('#today-label').textContent = dateFormatter.format(current);
    $('#stat-today').innerHTML = statTime(todayWork); $('#stat-week').innerHTML = statTime(totalBetween(weekStart(current), current, current)); $('#stat-month').innerHTML = statTime(totalBetween(monthStart(current), current, current));
    $('#stat-breaks').innerHTML = `${Math.floor(dashboard.shifts.reduce((sum, shift) => sum + breakBetween(shift, today, today + DAY, current), 0) / MINUTE)} <span>мин</span>`;
    $('#stat-today-note').textContent = active ? paused ? 'Сейчас идёт перерыв' : 'Рабочее время идёт' : todayWork > 0 ? 'Время сохранено в истории' : 'Рабочий день ещё впереди';
  }
  function renderTimeline() {
    const current = now(), today = dayStart(current), events = [];
    dashboard.shifts.forEach(shift => {
      const add = (time, title, description, symbol) => { if (time != null && time >= today && time <= current) events.push({ time, title, description, symbol, shift }); };
      add(shift.startedAt, 'Начало работы', 'Хорошего рабочего дня!', 'play');
      shift.breaks.forEach(pause => { add(pause.startedAt, 'Начало перерыва', 'Немного времени для себя', 'coffee'); if (pause.endedAt !== shift.endedAt) add(pause.endedAt, 'Снова за работу', 'Перерыв завершён', 'play'); });
      add(shift.endedAt, 'Смена завершена', 'Время сохранено в базе', 'check');
    });
    events.sort((a, b) => b.time - a.time);
    const shownShifts = new Set();
    $('#timeline').innerHTML = events.length ? events.slice(0, 5).map(event => {
      const shiftId = String(event.shift.id), manageable = canEditShift(event.shift) && !shownShifts.has(shiftId);
      shownShifts.add(shiftId);
      const actions = manageable ? `<div class="timeline-actions"><button type="button" class="button small" data-action="edit-shift" data-id="${escapeHTML(shiftId)}" aria-label="Изменить смену от ${fullFormatter.format(event.shift.startedAt)}">Изменить смену</button>${canDeleteShift(event.shift) ? `<button type="button" class="button small danger" data-action="delete-shift" data-id="${escapeHTML(shiftId)}" aria-label="Удалить смену от ${fullFormatter.format(event.shift.startedAt)}">Удалить смену</button>` : ''}</div>` : '';
      return `<div class="timeline-item${manageable ? ' has-action' : ''}"><span class="timeline-marker">${icon(event.symbol)}</span><div class="timeline-content"><strong>${event.title}</strong><span>${event.description}</span></div><time class="timeline-time">${timeFormatter.format(event.time)}</time>${actions}</div>`;
    }).join('') : '<div class="timeline-empty"><span class="empty-icon">' + icon('sun') + '</span><strong>Новый день — чистый лист</strong><p>Начните смену, и здесь появятся<br>события рабочего дня.</p></div>';
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
    const editable = !compact && shifts.some(canEditShift);
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Дата</th><th>${compact ? 'Отработано' : 'Начало / конец'}</th>${compact ? '' : '<th>Перерывы</th><th>Отработано</th>'}<th>Статус</th>${editable ? '<th>Действия</th>' : ''}</tr></thead><tbody>${shifts.map(shift => {
      const metric = metrics(shift), label = metric.status === 'finished' ? 'Завершена' : metric.status === 'break' ? 'Перерыв' : 'В работе';
      const ending = shift.endedAt == null ? '—' : timeFormatter.format(shift.endedAt) + (dateKey(shift.endedAt) !== dateKey(shift.startedAt) ? ` · ${dateFormatter.format(shift.endedAt)}` : '');
      return `<tr><td><span class="table-date">${dateFormatter.format(shift.startedAt)}</span><span class="table-secondary">${zonedDate(shift.startedAt).getUTCFullYear()}</span>${shift.note ? `<span class="shift-note" title="${escapeHTML(shift.note)}">${escapeHTML(shift.note)}</span>` : ''}</td><td${compact ? ' class="table-duration"' : ''}>${compact ? readable(metric.workMs) : `${timeFormatter.format(shift.startedAt)} <span class="table-secondary inline">/ ${ending}</span>`}</td>${compact ? '' : `<td>${readable(metric.breakMs)}</td><td class="table-duration">${readable(metric.workMs)}</td>`}<td><span class="pill ${metric.status === 'working' ? 'active' : metric.status === 'break' ? 'paused' : ''}">${label}</span></td>${editable ? `<td><div class="row-actions">${canEditShift(shift) ? `<button class="button small" data-action="edit-shift" data-id="${escapeHTML(shift.id)}">Изменить</button>` : ''}${canDeleteShift(shift) ? `<button class="button small danger" data-action="delete-shift" data-id="${escapeHTML(shift.id)}" aria-label="Удалить смену от ${dateFormatter.format(shift.startedAt)}">Удалить</button>` : ''}</div></td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
  }
  function renderHistory() {
    if (serverRendered) return;
    const from = $('#history-from').value, to = $('#history-to').value, status = $('#history-status').value;
    if (from && to && from > to) { $('#history-summary').textContent = 'Дата начала должна быть не позже даты окончания.'; $('#history-table').innerHTML = ''; return; }
    const shifts = sortedShifts().filter(shift => (!from || dateKey(shift.startedAt) >= from) && (!to || dateKey(shift.startedAt) <= to) && (status === 'all' || (status === 'finished' ? shift.endedAt != null : shift.endedAt == null)));
    $('#history-summary').textContent = `Найдено смен: ${shifts.length}. Фильтр по дате начала. Время Казахстана, UTC+5.`;
    $('#history-table').innerHTML = shifts.length ? shiftTable(shifts) : emptyState('Подходящих смен пока нет', 'Измените фильтры или добавьте первую смену.');
  }
  function renderDashboard() {
    if (serverRendered) { renderTimer(); return; }
    if (!dashboard.user) return;
    $('#selected-name').textContent = dashboard.user.name; $('#selected-meta').textContent = [dashboard.user.position, dashboard.user.department].filter(Boolean).join(' · ') || 'Профиль сотрудника';
    $('#overview-description').textContent = isAdmin() ? `Рабочее время: ${dashboard.user.name}. Управляйте сменами и перерывами.` : 'Время для хорошей работы. А подсчёты — на нас.';
    const schedule = dashboard.schedule;
    $('#schedule-summary').textContent = schedule ? `${schedule.startTime}–${schedule.endTime} · ${schedule.weekdays.map(day => weekdays[day - 1]).join(', ') || 'Без рабочих дней'}` : 'График не задан';
    renderAccount(); renderTimer(); renderTimeline(); renderWeek(); renderHistory();
    $('#recent-shifts').innerHTML = shiftTable(sortedShifts().slice(0, 3), true);
  }
  function renderEmployees() {
    if (serverRendered) return;
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
    const defaultHistoryStart = serverRendered ? dateKey(dayStart(now()) - 365 * DAY) : (shifts.length ? dateKey(Math.max(shifts.at(-1).startedAt, dayStart(now()) - 365 * DAY)) : dateKey(monthStart(now())));
    const from = historyExport ? ($('#history-from').value || defaultHistoryStart) : $('#report-from').value;
    const to = historyExport ? ($('#history-to').value || dateKey(now())) : $('#report-to').value;
    validateRange(from, to);
    const blob = await api(`/api/export?${queryForUser({ from, to })}`, { binary: true });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `smena-${from}-${to}.csv`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notify('CSV-отчёт скачан.');
  }
  function planningFeedback(selector, message = '', error = false) {
    const element = $(selector); element.textContent = message; element.classList.toggle('is-error', error);
  }
  function calendarContextMatches(userId, month, token) {
    return !!session.user && session.csrfToken === token && String(selectedUserId) === String(userId) && $('#calendar-month').value === month;
  }
  function resetCalendarView() {
    calendarRequest += 1; calendarData = null; calendarDay = null;
    $('#calendar-grid').replaceChildren(); $('#calendar-totals').replaceChildren();
    if ($('#calendar-day-dialog').open) $('#calendar-day-dialog').close();
  }
  async function loadCalendar({ quiet = false } = {}) {
    if (!session.user) return false;
    const month = $('#calendar-month').value, userId = selectedUserId, token = session.csrfToken;
    if (!validMonth(month)) { planningFeedback('#calendar-feedback', 'Выберите месяц календаря.', true); return false; }
    const request = ++calendarRequest;
    $('#calendar-grid').setAttribute('aria-busy', 'true');
    if (!quiet) planningFeedback('#calendar-feedback', 'Загружаем календарь…');
    try {
      const result = await api(`/api/calendar?${new URLSearchParams({ month, userId: String(userId) })}`);
      if (request !== calendarRequest || !calendarContextMatches(userId, month, token)) return false;
      calendarData = result; cacheShifts(result.shifts || []);
      planningFeedback('#calendar-feedback'); renderCalendar();
      if ($('#calendar-day-dialog').open && calendarDay) renderDayDetails();
      return true;
    } catch (error) {
      if (request === calendarRequest && calendarContextMatches(userId, month, token)) planningFeedback('#calendar-feedback', error.message + (calendarData ? ' Показаны последние загруженные данные.' : ''), true);
      return false;
    } finally { if (request === calendarRequest) $('#calendar-grid').setAttribute('aria-busy', 'false'); }
  }
  function renderCalendar() {
    if (!calendarData) return;
    const focusedDate = $('#calendar-grid').contains(document.activeElement) ? document.activeElement.dataset.date : null;
    $('#calendar-person').textContent = `${calendarData.user.name} · ${monthLabel(calendarData.month)}`;
    const sums = calendarData.days.reduce((total, day) => { ['plannedMs', 'workMs', 'lateMs', 'overtimeMs'].forEach(key => { total[key] += Number(day[key]) || 0; }); return total; }, { plannedMs: 0, workMs: 0, lateMs: 0, overtimeMs: 0 });
    $('#calendar-totals').innerHTML = [['План месяца', sums.plannedMs, 'plan'], ['Отработано', sums.workMs, 'fact'], ['Опоздания', sums.lateMs, 'late'], ['Сверх плана', sums.overtimeMs, 'extra']].map(([label, value, type]) => `<article class="planning-total ${type}"><span>${label}</span><strong>${readable(value)}</strong></article>`).join('');
    const first = (zonedDate(dayFromKey(`${calendarData.month}-01`)).getUTCDay() + 6) % 7;
    let html = Array.from({ length: first }, () => '<span class="calendar-spacer" aria-hidden="true"></span>').join('');
    html += calendarData.days.map(day => {
      const status = day.kind === 'absence' ? (absenceLabels[day.absence?.type] || 'Отсутствие') : day.kind === 'day_off' ? 'Выходной' : (dayLabels[day.state] || 'Рабочий день');
      const today = day.date === dateKey(now()), active = ['working', 'break'].includes(day.state);
      const label = `${dateFormatter.format(dayFromKey(day.date))}. ${status}. План ${readable(day.plannedMs)}. Факт ${readable(day.workMs)}${day.lateMs ? `. Опоздание ${readable(day.lateMs)}` : ''}${day.overtimeMs ? `. Сверх плана ${readable(day.overtimeMs)}` : ''}`;
      return `<button type="button" class="calendar-day ${day.kind === 'absence' ? 'is-absence' : day.kind === 'day_off' ? 'is-day-off' : ''}${today ? ' is-today' : ''}${Number(day.workMs) > 0 ? ' has-work' : ''}${active ? ' is-active' : ''}" data-action="calendar-day" data-date="${escapeHTML(day.date)}" aria-label="${escapeHTML(label)}"${today ? ' aria-current="date"' : ''}><span class="calendar-day-top"><span class="calendar-day-number">${Number(day.date.slice(-2))}</span>${today ? '<span class="calendar-today-label">Сегодня</span>' : ''}${active ? '<i class="live-dot" aria-hidden="true"></i>' : ''}</span><span class="calendar-day-status">${escapeHTML(status)}</span><span class="calendar-day-fact">${Number(day.workMs) > 0 || active ? shortHours(day.workMs) : '—'}</span><span class="calendar-day-plan">${day.plannedMs > 0 ? `план ${shortHours(day.plannedMs)}` : 'без плана'}</span><span class="calendar-day-flags">${day.lateMs > 0 ? '<i class="day-flag late" title="Опоздание">!</i>' : ''}${day.overtimeMs > 0 ? '<i class="day-flag extra" title="Сверх плана">+</i>' : ''}</span></button>`;
    }).join('');
    const trailing = (7 - (first + calendarData.days.length) % 7) % 7;
    html += Array.from({ length: trailing }, () => '<span class="calendar-spacer" aria-hidden="true"></span>').join('');
    $('#calendar-grid').innerHTML = html;
    if (focusedDate) [...$('#calendar-grid').querySelectorAll('[data-date]')].find(button => button.dataset.date === focusedDate)?.focus({ preventScroll: true });
  }
  function openCalendarDay(date) {
    if (!calendarData || !calendarData.days.some(day => day.date === date)) return;
    calendarDay = date; renderDayDetails();
    if (!$('#calendar-day-dialog').open) $('#calendar-day-dialog').showModal();
  }
  function renderDayDetails() {
    const day = calendarData?.days.find(item => item.date === calendarDay); if (!day) return;
    const body = $('#day-detail-body'), previousFocus = body.contains(document.activeElement) ? document.activeElement.closest('[data-action]') : null;
    const focusedAction = previousFocus ? { action: previousFocus.dataset.action, id: previousFocus.dataset.id } : null;
    const scroll = body.parentElement.scrollTop + body.scrollTop;
    $('#day-detail-title').textContent = dateFormatter.format(dayFromKey(day.date));
    $('#day-detail-person').textContent = calendarData.user.name;
    const shifts = (calendarData.shifts || []).filter(shift => (day.shiftIds || []).map(String).includes(String(shift.id))).sort((a, b) => a.startedAt - b.startedAt);
    const absence = day.absence;
    const plan = day.plannedStart != null && day.plannedEnd != null && day.plannedMs > 0 ? `${timeFormatter.format(day.plannedStart)}–${timeFormatter.format(day.plannedEnd)}${dateKey(day.plannedEnd) !== day.date ? ' · следующий день' : ''}` : day.kind === 'absence' ? 'Отсутствие по плану' : 'Выходной';
    let html = `<div class="day-plan-line"><span>План рабочего дня</span><strong>${plan}</strong></div><div class="day-detail-metrics">${[['План', day.plannedMs], ['Факт', day.workMs], ['Опоздание', day.lateMs], ['Сверх плана', day.overtimeMs]].map(([label, value]) => `<div><span>${label}</span><strong>${readable(value)}</strong></div>`).join('')}</div>`;
    if (absence) html += `<article class="absence-detail"><div><span class="absence-icon">${icon('calendar')}</span><strong>${escapeHTML(absenceLabels[absence.type] || 'Отсутствие')}</strong></div><p>${escapeHTML(absence.startDate)} — ${escapeHTML(absence.endDate)}</p>${absence.note ? `<p>${escapeHTML(absence.note)}</p>` : ''}${isAdmin() ? `<button class="button small danger" data-action="delete-absence" data-id="${escapeHTML(absence.id)}">Удалить отсутствие</button>` : ''}</article>`;
    html += '<div class="day-shifts-heading"><h3>Смены и перерывы</h3><span>' + shifts.length + '</span></div>';
    html += shifts.length ? shifts.map(shift => {
      const metric = metrics(shift);
      return `<article class="day-shift"><div class="day-shift-top"><strong>${timeFormatter.format(shift.startedAt)} — ${shift.endedAt == null ? 'продолжается' : timeFormatter.format(shift.endedAt) + (dateKey(shift.endedAt) !== day.date ? ` · ${dateFormatter.format(shift.endedAt)}` : '')}</strong><span>${readable(metric.workMs)}</span></div><p class="day-shift-state">${shift.endedAt == null ? metric.status === 'break' ? 'Сейчас на перерыве' : 'Рабочее время идёт' : 'Смена завершена'}</p>${shift.breaks.length ? `<ul class="day-break-list">${shift.breaks.map(pause => `<li><span>${icon('coffee')} ${timeFormatter.format(pause.startedAt)} — ${pause.endedAt == null ? 'продолжается' : timeFormatter.format(pause.endedAt)}</span><strong>${readable((pause.endedAt ?? now()) - pause.startedAt)}</strong></li>`).join('')}</ul>` : '<p class="card-subtitle">Без перерывов</p>'}${shift.note ? `<p class="day-shift-note">${escapeHTML(shift.note)}</p>` : ''}<div class="day-shift-actions">${canEditShift(shift) ? `<button class="button small" data-action="edit-shift" data-id="${escapeHTML(shift.id)}">Изменить смену</button>` : ''}${canDeleteShift(shift) ? `<button class="button small danger" data-action="delete-shift" data-id="${escapeHTML(shift.id)}">Удалить</button>` : ''}</div></article>`;
    }).join('') : '<div class="day-empty">Отметок начала смены в этот день пока нет.</div>';
    if (isAdmin() && !absence) html += '<button class="button drawer-absence-button" data-action="add-absence">Добавить отсутствие на этот день</button>';
    if (!isAdmin()) html += '<button class="button drawer-absence-button" data-action="new-request" data-calendar-request>Запросить отпуск / отгул</button>';
    html += '<p class="planning-note drawer-note">План по текущему графику · Ночные смены — по дате начала</p>';
    body.innerHTML = html; body.scrollTop = scroll;
    if (focusedAction && $('#calendar-day-dialog').open) {
      const replacement = [...body.querySelectorAll('[data-action]')].find(button => button.dataset.action === focusedAction.action && button.dataset.id === focusedAction.id);
      (replacement || $('#calendar-day-dialog .close-button')).focus({ preventScroll: true });
    }
  }
  async function changeCalendarMonth(delta = 0, current = false) {
    const value = current ? dateKey(now()).slice(0, 7) : $('#calendar-month').value;
    if (!validMonth(value)) return;
    const date = new Date(`${value}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + delta);
    $('#calendar-month').value = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
    if (serverRendered) { submitPageFilter($('#calendar-month'), { month: $('#calendar-month').value }); return; }
    resetCalendarView(); await loadCalendar();
  }
  function openAbsence() {
    if (!isAdmin()) return;
    absenceUserId = calendarData?.user?.id ?? selectedUserId;
    const employee = users.find(user => String(user.id) === String(absenceUserId)) || dashboard.user;
    const date = calendarDay || ($('#calendar-month').value === dateKey(now()).slice(0, 7) ? dateKey(now()) : `${$('#calendar-month').value}-01`);
    $('#absence-form').reset(); $('#absence-start').value = date; $('#absence-end').value = date;
    $('#absence-person').textContent = employee?.name || 'Сотрудник'; $('#absence-error').textContent = '';
    if ($('#calendar-day-dialog').open) $('#calendar-day-dialog').close();
    $('#absence-dialog').showModal();
  }
  async function loadRequests({ quiet = false } = {}) {
    if (!session.user) return false;
    const sequence = ++requestsRequest, token = session.csrfToken, userId = session.user.id, status = $('#requests-filter').value;
    $('#requests-list').setAttribute('aria-busy', 'true');
    if (!quiet) planningFeedback('#requests-feedback', 'Загружаем заявки…');
    const current = () => sequence === requestsRequest && session.user && String(session.user.id) === String(userId) && session.csrfToken === token && $('#requests-filter').value === status;
    try {
      const params = new URLSearchParams({ status });
      if (serverRendered) {
        const currentQuery = new URLSearchParams(location.search);
        params.set('page', currentQuery.get('page') || '1');
        params.set('pageSize', currentQuery.get('pageSize') || '20');
      }
      const result = await api(`/api/absence-requests?${params}`);
      if (!current()) return false;
      absenceRequests = result; planningFeedback('#requests-feedback'); renderRequests(); return true;
    } catch (error) {
      if (current()) planningFeedback('#requests-feedback', error.message + (absenceRequests ? ' Показаны последние загруженные данные.' : ''), true);
      return false;
    } finally { if (current()) $('#requests-list').setAttribute('aria-busy', 'false'); }
  }
  function requestDates(request) {
    const start = fullFormatter.format(dayFromKey(request.startDate)).split(',')[0], end = fullFormatter.format(dayFromKey(request.endDate)).split(',')[0];
    return request.startDate === request.endDate ? start : `${start} — ${end}`;
  }
  function requestSummary(request) {
    return `<strong>${escapeHTML(request.user?.name || session.user?.name || 'Сотрудник')}</strong><span>${escapeHTML(absenceLabels[request.type] || 'Отсутствие')} · ${escapeHTML(requestDates(request))}</span>${request.note ? `<p>${escapeHTML(request.note)}</p>` : '<p class="request-no-note">Комментарий к заявке не добавлен.</p>'}`;
  }
  function renderRequests() {
    if (serverRendered) return;
    if (!absenceRequests || !session.user) return;
    const list = $('#requests-list'), focused = list.contains(document.activeElement) ? document.activeElement.closest('[data-action]') : null;
    const focusKey = focused ? { action: focused.dataset.action, id: focused.dataset.id } : null;
    const counts = absenceRequests.counts || {}, pending = Number(counts.pending) || 0;
    $('#requests-badge').textContent = pending > 99 ? '99+' : String(pending); $('#requests-badge').hidden = pending === 0;
    $('#requests-badge').setAttribute('aria-label', `На рассмотрении: ${pending}`);
    $('#requests-summary').textContent = `На рассмотрении: ${pending} · Одобрено: ${Number(counts.approved) || 0}`;
    const requests = absenceRequests.requests || [];
    list.innerHTML = requests.length ? requests.map(request => {
      const own = String(request.userId) === String(session.user.id), waiting = request.status === 'pending';
      const days = Math.round((dayFromKey(request.endDate) - dayFromKey(request.startDate)) / DAY) + 1;
      const decided = request.decidedAt ? `${request.status === 'cancelled' ? 'Отменена' : 'Решение'} ${fullFormatter.format(numericTime(request.decidedAt))}${request.decidedBy?.name ? ` · ${request.decidedBy.name}` : ''}` : '';
      return `<article class="absence-request-card"><div class="request-card-main"><div class="request-card-heading"><span class="request-kind-icon">${icon(request.type === 'vacation' ? 'sun' : 'calendar')}</span><div><h2>${escapeHTML(absenceLabels[request.type] || 'Отсутствие')}</h2>${isAdmin() ? `<p>${escapeHTML(request.user?.name || 'Сотрудник')}${request.user?.department ? ` · ${escapeHTML(request.user.department)}` : ''}</p>` : ''}</div><span class="request-status ${escapeHTML(request.status)}">${escapeHTML(requestLabels[request.status] || request.status)}</span></div><div class="request-period"><strong>${escapeHTML(requestDates(request))}</strong><span>Дней: ${days}</span></div>${request.note ? `<p class="request-note">${escapeHTML(request.note)}</p>` : ''}${request.decisionNote ? `<div class="request-decision-note"><span>Комментарий администратора</span><p>${escapeHTML(request.decisionNote)}</p></div>` : ''}${request.status === 'approved' && request.absenceId == null ? '<p class="request-calendar-removed">Запись отсутствия удалена из календаря администратором.</p>' : ''}<div class="request-card-meta"><span>Подана ${fullFormatter.format(numericTime(request.createdAt))}</span>${decided ? `<span>${escapeHTML(decided)}</span>` : ''}</div></div>${waiting ? `<div class="request-card-actions">${isAdmin() ? `<button class="button small dark" data-action="approve-request" data-id="${escapeHTML(request.id)}">Одобрить</button><button class="button small" data-action="reject-request" data-id="${escapeHTML(request.id)}">Отклонить</button>` : ''}${own ? `<button class="text-button request-cancel" data-action="cancel-request" data-id="${escapeHTML(request.id)}">Отменить заявку</button>` : ''}</div>` : ''}</article>`;
    }).join('') : emptyState($('#requests-filter').value === 'pending' ? 'Нет заявок на рассмотрении' : 'Заявок пока нет', isAdmin() ? 'Здесь появятся запросы команды на отпуск и отгул.' : 'Подайте заявку или выберите другой статус, чтобы посмотреть историю.');
    if (focusKey) {
      const next = [...list.querySelectorAll('[data-action]')].find(button => button.dataset.action === focusKey.action && button.dataset.id === focusKey.id);
      (next || $('#requests-filter')).focus({ preventScroll: true });
    }
  }
  function openRequest(fromCalendar = false) {
    if (!session.user) return;
    let date = dateKey(now());
    if (fromCalendar) date = $('#calendar-day-dialog').open && calendarDay ? calendarDay : $('#calendar-month').value === date.slice(0, 7) ? date : `${$('#calendar-month').value}-01`;
    $('#request-form').reset(); $('#request-start').value = date; $('#request-end').value = date;
    $('#request-person').textContent = session.user.name; $('#request-error').textContent = '';
    if ($('#calendar-day-dialog').open) $('#calendar-day-dialog').close();
    $('#request-dialog').showModal(); $('#request-start').focus();
  }
  function openRequestDecision(id, status) {
    if (!isAdmin()) return;
    const request = absenceRequests?.requests.find(item => String(item.id) === String(id));
    if (!request || request.status !== 'pending') { notify('Эта заявка уже изменилась. Обновите список.', true); void loadRequests(); return; }
    requestDecision = { ...request, nextStatus: status };
    $('#request-decision-form').reset(); $('#request-decision-summary').innerHTML = requestSummary(request);
    const reject = status === 'rejected';
    $('#request-decision-title').textContent = reject ? 'Отклонить заявку?' : 'Одобрить заявку?';
    $('#request-decision-label').textContent = reject ? 'Причина отклонения' : 'Комментарий к решению';
    $('#request-decision-note').required = reject; $('#request-decision-note').minLength = reject ? 3 : 0;
    $('#request-decision-help').textContent = reject ? 'Обязательно: от 3 до 500 символов. Сотрудник увидит причину.' : 'Необязательно. После одобрения отсутствие появится в календаре сотрудника.';
    $('#request-decision-submit').textContent = reject ? 'Отклонить заявку' : 'Одобрить заявку';
    $('#request-decision-submit').className = `button ${reject ? 'danger' : 'dark'}`;
    $('#request-decision-error').textContent = ''; $('#request-decision-dialog').showModal(); $('#request-decision-note').focus();
  }
  async function loadTeamStatus({ quiet = false } = {}) {
    if (!isAdmin()) return false;
    const request = ++teamRequest, token = session.csrfToken;
    $('#team-live-members').setAttribute('aria-busy', 'true');
    if (!quiet) planningFeedback('#team-live-feedback', 'Проверяем, кто сейчас на работе…');
    try {
      const result = await api('/api/team-status');
      if (request !== teamRequest || token !== session.csrfToken || !isAdmin()) return false;
      teamData = result; planningFeedback('#team-live-feedback'); renderTeamStatus(); return true;
    } catch (error) {
      if (request === teamRequest && isAdmin()) planningFeedback('#team-live-feedback', error.message, true);
      return false;
    } finally { if (request === teamRequest) $('#team-live-members').setAttribute('aria-busy', 'false'); }
  }
  function renderTeamStatus() {
    if (!teamData || !isAdmin()) return;
    const all = teamData.members || [];
    $('#team-live-filters').innerHTML = [['all', 'Все'], ...Object.entries(teamLabels)].map(([key, label]) => `<button type="button" class="team-status-chip${teamFilter === key ? ' selected' : ''}" data-action="team-filter" data-status="${key}" aria-pressed="${teamFilter === key}"><i class="team-status-dot ${key}" aria-hidden="true"></i><span>${label}</span><strong>${key === 'all' ? all.length : all.filter(member => member.status === key).length}</strong></button>`).join('');
    const members = all.filter(member => teamFilter === 'all' || member.status === teamFilter);
    $('#team-live-members').innerHTML = members.length ? members.map(member => `<article class="team-live-person"><div class="team-live-person-header"><span class="avatar">${escapeHTML(member.user.name.split(/\s+/).slice(0, 2).map(word => word[0]).join(''))}</span><div><strong>${escapeHTML(member.user.name)}</strong><span>${escapeHTML(member.user.department || member.user.position || 'Сотрудник')}</span></div><span class="team-live-status ${escapeHTML(member.status)}">${escapeHTML(teamLabels[member.status] || member.status)}</span></div><div class="team-live-hours"><span>Сегодня <strong>${readable(member.day?.workMs || 0)}</strong></span><span>План <strong>${shortHours(member.day?.plannedMs || 0)}</strong></span></div>${member.activeShift ? `<p class="team-live-caption">Смена с ${fullFormatter.format(member.activeShift.startedAt)}</p>` : member.status === 'absence' ? `<p class="team-live-caption">${escapeHTML(absenceLabels[member.day?.absence?.type] || 'Запланированное отсутствие')}</p>` : '<p class="team-live-caption">По графику сотрудника</p>'}<button class="text-button" data-action="calendar-user" data-id="${escapeHTML(member.user.id)}">Открыть календарь ${icon('arrow')}</button></article>`).join('') : emptyState('Здесь пока никого', 'Выберите другой статус или добавьте сотрудников.');
    $('#team-live-updated').textContent = `Обновлено ${timeFormatter.format(teamData.serverNow || now())} · проверка каждые 20 секунд`;
  }
  function timesheetSelection() { return isAdmin() && $('#timesheet-scope').value === 'all' ? 'all' : String(selectedUserId); }
  function invalidateTimesheet() {
    timesheetRequest += 1; timesheetReady = false; timesheetData = null; $('#print-timesheet').disabled = true;
    $('#timesheet-table').replaceChildren(); $('#timesheet-print-content').replaceChildren(); $('#timesheet-subtitle').textContent = ''; $('#timesheet-generated').textContent = '';
  }
  async function loadTimesheet({ quiet = false } = {}) {
    if (!can('view_reports')) return false;
    const month = $('#timesheet-month').value, userId = timesheetSelection(), token = session.csrfToken;
    if (!validMonth(month)) { planningFeedback('#timesheet-feedback', 'Выберите месяц табеля.', true); return false; }
    const request = ++timesheetRequest; timesheetReady = false; $('#print-timesheet').disabled = true;
    $('#timesheet-document').setAttribute('aria-busy', 'true');
    if (!quiet) planningFeedback('#timesheet-feedback', 'Формируем табель…');
    try {
      const result = await api(`/api/timesheet?${new URLSearchParams({ month, userId })}`);
      if (request !== timesheetRequest || token !== session.csrfToken || !can('view_reports') || $('#timesheet-month').value !== month || timesheetSelection() !== userId) return false;
      timesheetData = result; timesheetReady = true; renderTimesheet(); planningFeedback('#timesheet-feedback'); return true;
    } catch (error) {
      if (request === timesheetRequest && token === session.csrfToken) planningFeedback('#timesheet-feedback', error.message, true);
      return false;
    } finally {
      if (request === timesheetRequest) { $('#timesheet-document').setAttribute('aria-busy', 'false'); $('#print-timesheet').disabled = !timesheetReady; }
    }
  }
  function timesheetCode(day) {
    if (day.kind === 'absence') return { vacation: 'ОТ', day_off: 'ОГ', other: 'О' }[day.absence?.type] || 'О';
    if (day.kind === 'day_off') return 'В';
    return day.state === 'missed' ? 'Н' : '·';
  }
  function renderTimesheet() {
    if (!timesheetData) return;
    const report = timesheetData, dates = report.days.map(day => typeof day === 'string' ? day : day.date);
    $('#timesheet-title').textContent = `Табель · ${monthLabel(report.month)}`;
    $('#timesheet-subtitle').textContent = report.rows.length === 1 ? report.rows[0].user.name : `Сотрудников в табеле: ${report.rows.length}`;
    $('#timesheet-generated').textContent = `Сформирован ${fullFormatter.format(report.serverNow || now())}`;
    if (!report.rows.length) { $('#timesheet-table').innerHTML = emptyState('Нет сотрудников для табеля', 'Выберите сотрудника или другой месяц.'); $('#timesheet-print-content').textContent = 'Нет сотрудников для табеля.'; return; }
    const hoursNumber = value => (Number(value || 0) / HOUR).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    const totals = report.rows.reduce((sum, row) => { ['plannedMs', 'workMs', 'lateMs', 'overtimeMs'].forEach(key => { sum[key] += Number(row[key]) || 0; }); return sum; }, { plannedMs: 0, workMs: 0, lateMs: 0, overtimeMs: 0 });
    $('#timesheet-table').innerHTML = `<table class="timesheet-table"><caption class="visually-hidden">Рабочее время по дате начала смены, часы</caption><thead><tr><th scope="col" class="timesheet-person-col">Сотрудник</th>${dates.map(date => `<th scope="col" class="${[0, 6].includes(zonedDate(dayFromKey(date)).getUTCDay()) ? 'weekend-column' : ''}">${Number(date.slice(-2))}</th>`).join('')}<th scope="col" class="total-column">План</th><th scope="col" class="total-column">Факт</th><th scope="col" class="total-column">Опозд.</th><th scope="col" class="total-column">Сверх</th></tr></thead><tbody>${report.rows.map(row => {
      const days = new Map(row.days.map(day => [day.date, day]));
      return `<tr><th scope="row" class="timesheet-person-col"><strong>${escapeHTML(row.user.name)}</strong><span>${escapeHTML(row.user.position || row.user.department || '')}</span></th>${dates.map(date => {
        const day = days.get(date); if (!day) return '<td>—</td>';
        const code = timesheetCode(day), hasTime = day.workMs > 0 || day.shiftIds?.length > 0 || ['working', 'break'].includes(day.state);
        const title = `${date}: факт ${readable(day.workMs)}, план ${readable(day.plannedMs)}, опоздание ${readable(day.lateMs)}, сверх плана ${readable(day.overtimeMs)}`;
        return `<td title="${escapeHTML(title)}" class="${day.kind === 'absence' ? 'absence-cell' : day.kind === 'day_off' ? 'weekend-column' : ''}${day.lateMs > 0 ? ' late-cell' : ''}"><span>${hasTime ? hoursNumber(day.workMs) : code}</span>${hasTime && day.kind === 'absence' ? `<small>${code}</small>` : ''}${['working', 'break'].includes(day.state) ? '<small>●</small>' : ''}</td>`;
      }).join('')}<td class="total-column">${hoursNumber(row.plannedMs)}</td><td class="total-column fact-total">${hoursNumber(row.workMs)}</td><td class="total-column">${hoursNumber(row.lateMs)}</td><td class="total-column">${hoursNumber(row.overtimeMs)}</td></tr>`;
    }).join('')}</tbody><tfoot><tr><th scope="row" colspan="${dates.length + 1}">Итого, часов</th><td>${hoursNumber(totals.plannedMs)}</td><td>${hoursNumber(totals.workMs)}</td><td>${hoursNumber(totals.lateMs)}</td><td>${hoursNumber(totals.overtimeMs)}</td></tr></tfoot></table>`;
    const printHalves = [dates.slice(0, 15), dates.slice(15)].filter(half => half.length);
    const printDay = day => !day ? '—' : day.workMs > 0 || day.shiftIds?.length > 0 || ['working', 'break'].includes(day.state) ? hoursNumber(day.workMs) + (day.kind === 'absence' ? ` / ${timesheetCode(day)}` : '') : timesheetCode(day);
    $('#timesheet-print-content').innerHTML = printHalves.map(half => `<section class="print-half"><h3>${Number(half[0].slice(-2))}–${Number(half.at(-1).slice(-2))} · ${escapeHTML(monthLabel(report.month))}</h3><table class="timesheet-print-table"><thead><tr><th scope="col" class="print-person">Сотрудник</th>${half.map(date => `<th scope="col">${Number(date.slice(-2))}</th>`).join('')}<th scope="col">Факт, ч</th></tr></thead><tbody>${report.rows.map(row => {
      const dayMap = new Map(row.days.map(day => [day.date, day]));
      return `<tr><th scope="row" class="print-person">${escapeHTML(row.user.name)}</th>${half.map(date => `<td>${printDay(dayMap.get(date))}</td>`).join('')}<td>${hoursNumber(half.reduce((sum, date) => sum + Number(dayMap.get(date)?.workMs || 0), 0))}</td></tr>`;
    }).join('')}</tbody></table></section>`).join('') + `<section class="print-month-totals"><h3>Итоги месяца, часы</h3><table class="timesheet-print-table"><thead><tr><th scope="col" class="print-person">Сотрудник</th><th scope="col">План</th><th scope="col">Факт</th><th scope="col">Перерывы</th><th scope="col">Опоздания</th><th scope="col">Сверх плана</th></tr></thead><tbody>${report.rows.map(row => `<tr><th scope="row" class="print-person">${escapeHTML(row.user.name)}</th><td>${hoursNumber(row.plannedMs)}</td><td>${hoursNumber(row.workMs)}</td><td>${hoursNumber(row.breakMs)}</td><td>${hoursNumber(row.lateMs)}</td><td>${hoursNumber(row.overtimeMs)}</td></tr>`).join('')}</tbody></table></section>`;
  }
  async function refreshPlanning({ forceDetails = false } = {}) {
    if (!session.user) return;
    const tasks = [];
    tasks.push(loadRequests({ quiet: true }));
    if (view === 'calendar' || calendarData) tasks.push(loadCalendar({ quiet: true }));
    if (isAdmin() && (view === 'employees' || teamData)) tasks.push(loadTeamStatus({ quiet: true }));
    if (can('view_reports') && !document.body.classList.contains('printing-timesheet') && (view === 'timesheet' || timesheetData)) tasks.push(loadTimesheet({ quiet: true }));
    await Promise.allSettled(tasks);
    if (forceDetails && $('#calendar-day-dialog').open) renderDayDetails();
  }
  function auditDetails(entry) {
    let details = entry.details || {};
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return escapeHTML(details); } }
    const labels = { name: 'Имя', username: 'Логин', position: 'Должность', department: 'Отдел', active: 'Вход разрешён', archived: 'В архиве', passwordReset: 'Пароль сброшен', permissions: 'Права доступа', userId: 'Сотрудник', startedAt: 'Начало смены', endedAt: 'Конец смены', breaks: 'Перерывы', note: 'Комментарий', startTime: 'Начало рабочего дня', endTime: 'Конец рабочего дня', breakMinutes: 'Плановый перерыв, мин', weekdays: 'Рабочие дни', timezone: 'Часовой пояс', from: 'С даты', to: 'По дату', reason: 'Причина изменения', before: 'До изменения', after: 'После изменения', startDate: 'Первый день', endDate: 'Последний день', type: 'Вид отсутствия', status: 'Статус заявки', decisionNote: 'Комментарий к решению' };
    const format = (key, value) => {
      if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
      if (value == null) return key === 'endedAt' ? 'Продолжается' : '—';
      if (['before', 'after'].includes(key) && typeof value === 'object') return '\n' + Object.entries(value).filter(([field]) => labels[field]).map(([field, content]) => `  ${labels[field]}: ${format(field, content)}`).join('\n');
      if (key === 'type') return absenceLabels[value] || String(value);
      if (key === 'status') return requestLabels[value] || String(value);
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
    if (serverRendered) { reloadPage(); return; }
    if (!isAdmin()) return;
    const token = session.csrfToken;
    const data = await api('/api/audit');
    if (!isAdmin() || session.csrfToken !== token) return;
    const actions = { 'setup': 'Создание администратора', 'auth.setup': 'Создание администратора', 'login': 'Вход в систему', 'auth.login': 'Вход в систему', 'logout': 'Выход из системы', 'auth.logout': 'Выход из системы', 'user.create': 'Создан сотрудник', 'user.update': 'Изменён сотрудник', 'user.archive': 'Сотрудник отправлен в архив', 'profile.update': 'Обновлён профиль', 'password.change': 'Изменён пароль', 'auth.password_change': 'Изменён пароль', 'schedule.update': 'Изменён график', 'shift.start': 'Начата смена', 'shift.pause': 'Начат перерыв', 'shift.resume': 'Завершён перерыв', 'shift.finish': 'Завершена смена', 'shift.create': 'Добавлена смена', 'shift.update': 'Изменена смена', 'shift.delete': 'Удалена смена' };
    Object.assign(actions, { admin_created: 'Создан аккаунт администратора', user_created: 'Создан сотрудник', user_updated: 'Изменён сотрудник', user_archived: 'Сотрудник отправлен в архив', profile_updated: 'Обновлён профиль', password_changed: 'Изменён пароль', schedule_updated: 'Изменён график', shift_started: 'Начата смена', break_started: 'Начат перерыв', break_finished: 'Завершён перерыв', shift_finished: 'Завершена смена', shift_created: 'Добавлена смена', shift_updated: 'Изменена смена', shift_deleted: 'Удалена смена', report_exported: 'Скачан отчёт CSV' });
    Object.assign(actions, { absence_created: 'Добавлено отсутствие', absence_deleted: 'Удалено отсутствие' });
    Object.assign(actions, { absence_request_created: 'Подана заявка на отсутствие', absence_request_approved: 'Заявка одобрена', absence_request_rejected: 'Заявка отклонена', absence_request_cancelled: 'Заявка отменена' });
    $('#audit-table').innerHTML = data.entries.length ? `<div class="table-wrap"><table class="data-table audit-table"><thead><tr><th>Дата и время</th><th>Пользователь</th><th>Действие</th><th>Подробности</th></tr></thead><tbody>${data.entries.map(entry => `<tr><td>${fullFormatter.format(numericTime(entry.createdAt))}</td><td>${escapeHTML(entry.actorName || 'Система')}</td><td>${escapeHTML(actions[entry.action] || entry.action)}</td><td><details><summary>${escapeHTML(entry.targetType === 'user' ? (users.find(user => String(user.id) === String(entry.targetId))?.name || 'Сотрудник') : entry.targetType === 'shift' ? 'Изменения смены' : 'Подробнее')}</summary><pre>${auditDetails(entry)}</pre></details></td></tr>`).join('')}</tbody></table></div>` : emptyState('Журнал пока пуст', 'Изменения появятся здесь автоматически.');
  }
  async function setView(name) {
    if (!viewNames[name] || (!isAdmin() && ['employees', 'audit'].includes(name)) || (['reports', 'timesheet'].includes(name) && !can('view_reports'))) name = 'overview';
    if (serverRendered) { navigatePage(name); return; }
    const previousView = view;
    view = name;
    document.body.dataset.view = name;
    $$('.section-view').forEach(element => { element.hidden = element.id !== `view-${name}`; });
    $$('.nav-link').forEach(element => { const active = element.dataset.view === name; element.classList.toggle('active', active); if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current'); });
    $('#breadcrumb-current').textContent = viewNames[name];
    if (previousView !== name) document.dispatchEvent(new CustomEvent('smena:viewchange', { detail: { view: name } }));
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    renderAccount();
    if (name === 'employees') { await loadUsers(); await loadTeamStatus(); }
    if (name === 'calendar') await loadCalendar();
    if (name === 'requests') await loadRequests();
    if (name === 'timesheet') await loadTimesheet();
    if (name === 'reports') await loadReport();
    if (name === 'audit') await loadAudit();
  }
  async function refresh() {
    if (!session.user || refreshBusy || mutationBusy || document.hidden || pageNavigating) return;
    refreshBusy = true;
    const refreshToken = session.csrfToken;
    try {
      const latest = await api('/api/session');
      if (!session.user || session.csrfToken !== refreshToken) return;
      if (serverRendered) {
        if (!latest.user) { session = latest; returnToLogin(); return; }
        const permissionKey = user => JSON.stringify([user.id, user.role, [...(user.permissions || [])].sort(), user.active, user.archived]);
        if (latest.csrfToken !== refreshToken || permissionKey(latest.user) !== permissionKey(session.user)) { reloadPage(); return; }
        session = latest;
        // Do not replace paged server tables, reset filters, or interrupt an edit.
        if ($('dialog[open]') || document.activeElement?.closest('form') || document.body.classList.contains('printing-timesheet')) return;
        if (view === 'overview') await loadDashboard();
        if (view === 'employees') await loadTeamStatus({ quiet: true });
        if (view === 'calendar') await loadCalendar({ quiet: true });
        if (view === 'timesheet') await loadTimesheet({ quiet: true });
        if (view === 'reports') await loadReport();
        return;
      }
      if (!latest.user) { session = latest; showAuth(); return; }
      if (String(latest.user.id) !== String(session.user.id) || latest.csrfToken !== refreshToken) {
        session = latest; showAuth(); await enterApp(); return;
      }
      session = latest; renderAccount();
      if ((!isAdmin() && ['employees', 'audit'].includes(view)) || (['reports', 'timesheet'].includes(view) && !can('view_reports'))) await setView('overview');
      if (isAdmin()) await loadUsers();
      await loadDashboard();
      if (view === 'reports' && !$('dialog[open]') && !$('#report-filter-form').contains(document.activeElement) && $('#report-from').value && $('#report-to').value && $('#report-from').value <= $('#report-to').value && dayFromKey($('#report-to').value) - dayFromKey($('#report-from').value) < 366 * DAY) await loadReport();
      if (view === 'audit') await loadAudit();
      await refreshPlanning();
    } catch (error) {
      if (session.user) connectionStatus(false, error.message);
    } finally { refreshBusy = false; }
  }
  async function mutate(task, message) {
    if (mutationBusy) return false;
    mutationBusy = true; renderTimer();
    $$('dialog[open] button, #auth-submit').forEach(button => { button.disabled = true; });
    try {
      await task();
      if (serverRendered) {
        if (message) notify(message);
        if (!pageNavigating) reloadPage();
      } else { await refreshPlanning({ forceDetails: true }); if (message) notify(message); }
      return true;
    }
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
    row.innerHTML = `<div class="field"><label for="break-start-${breakSequence}">Начало перерыва</label><input type="datetime-local" id="break-start-${breakSequence}" data-break-start required step="1"></div><div class="field"><label for="break-end-${breakSequence}">Конец перерыва</label><input type="datetime-local" id="break-end-${breakSequence}" data-break-end step="1"></div><button type="button" class="close-button" data-action="remove-break" aria-label="Удалить перерыв">×</button>`;
    fillShiftTime(row.querySelector('[data-break-start]'), pause.startedAt);
    fillShiftTime(row.querySelector('[data-break-end]'), pause.endedAt);
    $('#shift-breaks').append(row);
  }
  function openShift(id = null) {
    const shift = id == null ? null : lookupShift(id);
    if (id != null && !shift) { notify('Эта смена больше недоступна. Обновите список смен.', true); return; }
    if (shift ? !canEditShift(shift) : !(can('edit_own_shifts') && (isAdmin() || String(selectedUserId) === String(session.user.id)))) { notify('Нет доступа к изменению этой смены.', true); return; }
    editingShift = shift ? { ...shift } : null; $('#shift-form').reset();
    $('#shift-title').textContent = shift ? 'Изменить смену' : 'Добавить смену';
    fillShiftTime($('#shift-start'), shift?.startedAt, now());
    fillShiftTime($('#shift-end'), shift?.endedAt);
    $('#shift-note').value = shift?.note || ''; $('#shift-breaks').replaceChildren(); (shift?.breaks || []).forEach(addBreakRow);
    $('#shift-reason').value = ''; $('#shift-reason').required = !!shift; $('#shift-reason-field').hidden = !shift;
    if ($('#calendar-day-dialog').open) $('#calendar-day-dialog').close();
    $('#shift-error').textContent = ''; $('#shift-dialog').showModal();
  }
  async function selectUser(id, targetView = null) {
    if (serverRendered) {
      selectedUserId = id;
      navigatePage(targetView || view, { ...(targetView === 'calendar' ? { month: $('#calendar-month').value } : {}) });
      return;
    }
    selectedUserId = id; $('#selected-user').value = String(id); reportRequest += 1;
    shiftCache.clear(); resetCalendarView(); invalidateTimesheet();
    await loadDashboard();
    if (targetView) await setView(targetView);
    else if (view === 'reports') await loadReport();
    else if (view === 'calendar') await loadCalendar();
    else if (view === 'timesheet') await loadTimesheet();
  }
  async function afterUserChange() { await loadUsers(); await loadDashboard(); }

  document.addEventListener('click', async event => {
    const viewButton = event.target.closest('button[data-view], a[data-view]');
    if (viewButton) {
      if (serverRendered && viewButton.tagName === 'A') return;
      event.preventDefault();
      try { await setView(viewButton.dataset.view); } catch (error) { notify(error.message, true); } return;
    }
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    if (serverRendered && button.tagName === 'BUTTON') event.preventDefault();
    const { action, id } = button.dataset;
    try {
      if (action === 'close-dialog') { button.closest('dialog').close(); return; }
      if (action === 'retry') { await initialize(); return; }
      if (!session.user) return;
      if (serverRendered && ['refresh-team', 'refresh-requests', 'refresh-audit'].includes(action)) { reloadPage(); return; }
      if (action === 'calendar-day') openCalendarDay(button.dataset.date);
      if (action === 'calendar-prev') await changeCalendarMonth(-1);
      if (action === 'calendar-next') await changeCalendarMonth(1);
      if (action === 'calendar-today') await changeCalendarMonth(0, true);
      if (action === 'calendar-user') { $('#calendar-month').value = dateKey(now()).slice(0, 7); await selectUser(id, 'calendar'); }
      if (action === 'add-absence') openAbsence();
      if (action === 'refresh-team') await loadTeamStatus();
      if (action === 'refresh-requests') await loadRequests();
      if (action === 'new-request') openRequest(button.hasAttribute('data-calendar-request'));
      if (action === 'approve-request' || action === 'reject-request') openRequestDecision(id, action === 'approve-request' ? 'approved' : 'rejected');
      if (action === 'cancel-request') {
        const request = absenceRequests?.requests.find(item => String(item.id) === String(id));
        if (!request || request.status !== 'pending' || String(request.userId) !== String(session.user.id)) { notify('Можно отменить только свою заявку на рассмотрении.', true); return; }
        const token = session.csrfToken;
        confirmAction('Отменить заявку?', `${absenceLabels[request.type]}: ${requestDates(request)}. Заявка останется в истории со статусом «Отменена».`, 'Отменить заявку', async () => {
          if (!session.user || session.csrfToken !== token) return;
          try { await api(`/api/absence-requests/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { version: request.version } }); }
          catch (error) { if ([404, 409].includes(error.status) && session.csrfToken === token) await loadRequests({ quiet: true }); throw error; }
          if (!session.user || session.csrfToken !== token) return;
          $('#confirm-dialog').close(); confirmCallback = null; notify('Заявка отменена.');
        }, true);
      }
      if (action === 'team-filter') { teamFilter = button.dataset.status; renderTeamStatus(); }
      if (action === 'print-timesheet') {
        if (!can('view_reports') || !timesheetReady) { notify('Сначала дождитесь загрузки табеля.', true); return; }
        if (serverRendered) renderTimesheet();
        document.body.classList.add('printing-timesheet'); window.print();
      }
      if (action === 'delete-absence') {
        if (!isAdmin()) return;
        const absence = calendarData?.absences?.find(item => String(item.id) === String(id));
        if (!absence) { notify('Запись уже изменилась. Откройте день заново.', true); await loadCalendar(); return; }
        confirmAction('Удалить отсутствие?', `${absenceLabels[absence.type] || 'Отсутствие'}: ${absence.startDate} — ${absence.endDate}. Будет удалён весь указанный период; план пересчитается по текущему графику.`, 'Удалить отсутствие', async () => {
          try { await api(`/api/absences/${encodeURIComponent(id)}`, { method: 'DELETE', body: { version: absence.version } }); }
          catch (error) {
            if (![404, 409].includes(error.status)) throw error;
            $('#confirm-dialog').close(); confirmCallback = null;
            await loadCalendar(); notify('Отсутствие уже изменилось. Проверьте календарь и повторите действие.', true); return;
          }
          $('#confirm-dialog').close(); confirmCallback = null; notify('Отсутствие удалено.');
        }, true);
      }
      if (action === 'profile') openProfile();
      if (action === 'logout') await mutate(async () => { await api('/api/logout', { method: 'POST', body: {} }); session.user = null; selectedUserId = null; dashboardRequest += 1; reportRequest += 1; $$('dialog[open]').forEach(dialog => dialog.close()); await initialize(); });
      if (action === 'start') await mutate(async () => { await api('/api/shifts/start', { method: 'POST', body: { userId: selectedUserId } }); await loadDashboard(); }, 'Смена началась. Хорошего рабочего дня!');
      if (action === 'pause' || action === 'resume') { const active = activeShift(); if (active) await mutate(async () => { await api(`/api/shifts/${encodeURIComponent(active.id)}/${action}`, { method: 'POST', body: {} }); await loadDashboard(); }, action === 'pause' ? 'Перерыв начался. Рабочий таймер приостановлен.' : 'Перерыв завершён. Продолжаем работу.'); }
      if (action === 'finish') {
        const active = activeShift(); if (!active) return;
        confirmAction('Завершить рабочий день?', `Отработано: ${readable(metrics(active).workMs)}. Открытый перерыв завершится вместе со сменой.`, 'Завершить смену', async () => { await api(`/api/shifts/${encodeURIComponent(active.id)}/finish`, { method: 'POST', body: {} }); await loadDashboard(); notify('Смена завершена и сохранена.'); });
      }
      if (action === 'confirm' && confirmCallback) {
        const submittedCallback = confirmCallback;
        try { const done = await mutate(submittedCallback); if (done && confirmCallback === submittedCallback) { $('#confirm-dialog').close(); confirmCallback = null; } }
        catch (error) { if (confirmCallback === submittedCallback) $('#confirm-error').textContent = error.message; }
      }
      if (action === 'reset-filters') {
        $('#history-from').value = ''; $('#history-to').value = ''; $('#history-status').value = 'all';
        if (serverRendered) navigatePage('history', { from: null, to: null, status: null }); else renderHistory();
      }
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
        const shift = lookupShift(id);
        if (!shift) { await loadDashboard(); notify('Список смен обновился. Выберите смену заново.', true); return; }
        if (!canDeleteShift(shift)) { notify('Нет права на удаление этой смены.', true); return; }
        const ownerName = users.find(user => String(user.id) === String(shift.userId))?.name || dashboard.user.name;
        confirmAction('Удалить смену целиком?', `${ownerName}: смена от ${fullFormatter.format(shift.startedAt)} будет удалена вместе со всеми перерывами. Её события исчезнут, рабочее время пересчитается. Действие останется в журнале.`, 'Удалить смену', async () => {
          try { await api(`/api/shifts/${encodeURIComponent(id)}`, { method: 'DELETE', body: { version: shift.version } }); }
          catch (error) {
            if (![404, 409].includes(error.status)) throw error;
            $('#confirm-dialog').close(); confirmCallback = null;
            await loadDashboard().catch(() => {});
            notify(error.status === 404 ? 'Эта смена уже удалена.' : 'Смена изменилась. Обновите данные и подтвердите удаление заново.', true);
            return;
          }
          $('#confirm-dialog').close(); confirmCallback = null;
          shiftCache.delete(String(id));
          dashboard.shifts = dashboard.shifts.filter(item => String(item.id) !== String(id));
          if (calendarData) calendarData.shifts = calendarData.shifts.filter(item => String(item.id) !== String(id));
          renderDashboard();
          notify('Смена удалена.');
          try { await loadDashboard(); }
          catch { notify('Смена удалена, но не удалось обновить остальные данные. Проверьте соединение.', true); }
        }, true);
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
    const payload = {
      startedAt: readShiftTime($('#shift-start')),
      endedAt: readShiftTime($('#shift-end')),
      breaks: $$('#shift-breaks .break-row').map(row => ({
        startedAt: readShiftTime(row.querySelector('[data-break-start]')),
        endedAt: readShiftTime(row.querySelector('[data-break-end]'))
      })),
      note: $('#shift-note').value.trim()
    };
    const submittedShift = editingShift;
    if (submittedShift) { payload.version = submittedShift.version; payload.reason = $('#shift-reason').value.trim(); } else payload.userId = selectedUserId;
    try {
      if (submittedShift && payload.reason.length < 3) throw new Error('Укажите причину изменения — не менее 3 символов.');
      if (payload.endedAt != null && payload.endedAt <= payload.startedAt) throw new Error('Конец смены должен быть позже её начала.');
      await mutate(async () => {
        const result = await api(submittedShift ? `/api/shifts/${encodeURIComponent(submittedShift.id)}` : '/api/shifts', { method: submittedShift ? 'PATCH' : 'POST', body: payload });
        if (result.shift) cacheShifts([result.shift]);
        $('#shift-dialog').close();
        try { await loadDashboard(); } catch { notify('Смена сохранена. Обновление остальных данных пока недоступно.', true); }
      }, 'Смена сохранена.');
    } catch (error) {
      $('#shift-error').textContent = [404, 409].includes(error.status) ? `${error.message} Закройте форму и откройте смену заново, чтобы получить актуальные данные.` : error.message;
      if ([404, 409].includes(error.status)) {
        if (submittedShift) shiftCache.delete(String(submittedShift.id));
        await Promise.allSettled([loadDashboard(), refreshPlanning()]);
      }
    }
  });
  $('#absence-form').addEventListener('submit', async event => {
    event.preventDefault(); $('#absence-error').textContent = '';
    if (!isAdmin()) return;
    const payload = { userId: absenceUserId, startDate: $('#absence-start').value, endDate: $('#absence-end').value, type: $('#absence-type').value, note: $('#absence-note').value.trim() };
    try {
      if (!payload.startDate || !payload.endDate || payload.startDate > payload.endDate) throw new Error('Последний день должен быть не раньше первого.');
      await mutate(async () => { await api('/api/absences', { method: 'POST', body: payload }); $('#absence-dialog').close(); }, 'Отсутствие добавлено в календарь.');
    } catch (error) { $('#absence-error').textContent = error.message; }
  });
  $('#request-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!session.user || mutationBusy) return;
    const token = session.csrfToken, userId = session.user.id;
    const sameUser = () => session.user && session.csrfToken === token && String(session.user.id) === String(userId);
    const payload = { startDate: $('#request-start').value, endDate: $('#request-end').value, type: $('#request-type').value, note: $('#request-note').value.trim() };
    $('#request-error').textContent = '';
    try {
      if (!payload.startDate || !payload.endDate || payload.startDate > payload.endDate) throw new Error('Последний день должен быть не раньше первого.');
      await mutate(async () => {
        await api('/api/absence-requests', { method: 'POST', body: payload });
        if (!sameUser()) return;
        $('#request-dialog').close(); $('#request-form').reset();
        $('#requests-filter').value = isAdmin() ? 'pending' : 'all';
        if (serverRendered) { navigatePage('requests', { status: $('#requests-filter').value }); return; }
        await setView('requests'); notify('Заявка отправлена на рассмотрение.');
      });
    } catch (error) { if (sameUser()) $('#request-error').textContent = error.message; }
  });
  $('#request-decision-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!isAdmin() || !requestDecision || mutationBusy) return;
    const snapshot = requestDecision, token = session.csrfToken, decisionNote = $('#request-decision-note').value.trim();
    const current = () => isAdmin() && session.csrfToken === token && requestDecision === snapshot;
    $('#request-decision-error').textContent = '';
    try {
      if (snapshot.nextStatus === 'rejected' && decisionNote.length < 3) throw new Error('Укажите причину отклонения — не менее 3 символов.');
      await mutate(async () => {
        await api(`/api/absence-requests/${encodeURIComponent(snapshot.id)}`, { method: 'PATCH', body: { version: snapshot.version, status: snapshot.nextStatus, decisionNote } });
        if (!current()) return;
        $('#request-decision-dialog').close(); requestDecision = null;
        notify(snapshot.nextStatus === 'approved' ? 'Заявка одобрена. Отсутствие добавлено в календарь.' : 'Заявка отклонена. Сотрудник увидит причину.');
      });
    } catch (error) {
      if (!current()) return;
      $('#request-decision-error').textContent = error.message;
      if ([404, 409].includes(error.status)) await refreshPlanning();
    }
  });
  $('#requests-filter').addEventListener('change', async event => {
    if (serverRendered) { submitPageFilter(event.target, { status: event.target.value }); return; }
    requestsRequest += 1; absenceRequests = null; $('#requests-list').replaceChildren();
    await loadRequests();
  });
  $('#calendar-month').addEventListener('change', async event => {
    if (serverRendered) { submitPageFilter(event.target, { month: event.target.value }); return; }
    resetCalendarView(); await loadCalendar();
  });
  $('#calendar-grid').addEventListener('keydown', event => {
    const button = event.target.closest('[data-action="calendar-day"]'); if (!button) return;
    const buttons = [...$('#calendar-grid').querySelectorAll('[data-action="calendar-day"]')], index = buttons.indexOf(button);
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (offsets[event.key] != null) { const target = buttons[index + offsets[event.key]]; if (target) { event.preventDefault(); target.focus(); } }
  });
  $('#timesheet-filter-form').addEventListener('submit', async event => { if (serverRendered) return; event.preventDefault(); invalidateTimesheet(); await loadTimesheet(); });
  ['#timesheet-month', '#timesheet-scope'].forEach(selector => $(selector).addEventListener('change', async event => {
    if (serverRendered) { submitPageFilter(event.target, { month: $('#timesheet-month').value, scope: $('#timesheet-scope').value }); return; }
    invalidateTimesheet(); renderAccount(); await loadTimesheet();
  }));
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing-timesheet'); });
  $('#history-filter-form')?.addEventListener('submit', event => {
    if (serverRendered && !validatePageFilter(event.currentTarget)) event.preventDefault();
  });
  $('#report-filter-form').addEventListener('submit', async event => {
    if (serverRendered) { if (!validatePageFilter(event.currentTarget)) event.preventDefault(); return; }
    event.preventDefault(); try { await loadReport(); } catch (error) { notify(error.message, true); }
  });
  ['#history-from', '#history-to', '#history-status'].forEach(selector => $(selector).addEventListener('change', event => {
    if (serverRendered) submitPageFilter(event.target, { from: $('#history-from').value, to: $('#history-to').value, status: $('#history-status').value });
    else renderHistory();
  }));
  $('#employee-search').addEventListener('input', () => { if (!serverRendered) renderEmployees(); });
  $('#show-archived').addEventListener('change', event => {
    if (serverRendered) submitPageFilter(event.target, { search: $('#employee-search').value, includeArchived: event.target.checked ? '1' : '0' });
    else renderEmployees();
  });
  $('#selected-user').addEventListener('change', async event => { try { await selectUser(event.target.value); } catch (error) { notify(error.message, true); } });
  window.addEventListener('hashchange', () => { if (session.user) void setView(location.hash.slice(1)).catch(error => notify(error.message, true)); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('focus', () => { void refresh(); });
  window.addEventListener('online', () => { void refresh(); });
  window.addEventListener('offline', () => { connectionStatus(false); renderTimer(); });
  window.addEventListener('pageshow', event => { if (serverRendered && event.persisted) reloadPage(); });
  setInterval(renderTimer, 1000);
  setInterval(() => { if (session.user && !document.hidden && (!serverRendered || view === 'overview')) { renderWeek(); renderTimeline(); } }, 60000);
  setInterval(() => { void refresh(); }, 20000);
  if (serverRendered) void initializeServerPage(); else void initialize();
})();
