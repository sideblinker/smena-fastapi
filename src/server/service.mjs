import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { buildAttendanceMonth, monthBounds } from './attendance.mjs';

const ALL_PERMISSIONS = ['track_time', 'edit_own_profile', 'edit_own_shifts', 'view_reports', 'export_reports'];
const DEFAULT_PERMISSIONS = ['track_time', 'edit_own_profile', 'view_reports'];
const SESSION_MS = 12 * 60 * 60 * 1000;
const DAY = 86400000;
const MAX_TIME = 8640000000000000;
const ADMIN_LOGIN = 'Adilium';
const ADMIN_NAME = 'Адиль Кубентаев';
const COOKIE = 'smena_session';

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const sha = (text) => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const first = (db, sql, ...args) => stmt(db, sql, ...args).first();
const rows = async (db, sql, ...args) => (await stmt(db, sql, ...args).all()).results;
const run = (db, sql, ...args) => stmt(db, sql, ...args).run();
const changed = (result) => Number(result?.meta?.changes ?? 0) > 0;
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const cookieHeader = (value, secure, maxAge = SESSION_MS / 1000) =>
  `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
function cookieToken(request) {
  const match = (request.headers.get('cookie') || '').match(/(?:^|;\s*)smena_session=([A-Za-z0-9_-]{43})(?:;|$)/);
  return match?.[1] || null;
}
function textField(value, label, max, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.trim().length > max || (!optional && !value.trim()))
    fail(400, 'VALIDATION', `${label}: укажите ${optional ? 'не более' : 'от 1 до'} ${max} символов.`);
  return value.trim();
}
function usernameField(value) {
  const username = textField(value, 'Логин', 40);
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) fail(400, 'VALIDATION', 'Логин: 3–40 латинских букв, цифр, точек, дефисов или подчёркиваний.');
  return username;
}
function passwordField(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128)
    fail(400, 'VALIDATION', 'Пароль должен содержать от 10 до 128 символов.');
  return value;
}
function permissionsField(value = DEFAULT_PERMISSIONS) {
  if (!Array.isArray(value) || value.length > ALL_PERMISSIONS.length || value.some((p) => !ALL_PERMISSIONS.includes(p)))
    fail(400, 'VALIDATION', 'Неизвестные права сотрудника.');
  return [...new Set(value)];
}
function rejectUnknown(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail(400, 'VALIDATION', 'Запрос содержит недопустимые поля.');
}
function idField(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) fail(400, 'VALIDATION', 'Некорректный идентификатор.');
  return value;
}
function boolField(value, label) {
  if (typeof value !== 'boolean') fail(400, 'VALIDATION', `${label}: ожидается true или false.`);
  return value ? 1 : 0;
}
function timestamp(value, label, nullable = false) {
  if (value === null && nullable) return null;
  const n = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : value;
  if (!Number.isSafeInteger(n) || n < 0 || n >= MAX_TIME) fail(400, 'VALIDATION', `${label}: некорректные дата или время.`);
  return n;
}
async function bodyJson(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json'))
    fail(415, 'CONTENT_TYPE', 'Отправьте данные в формате JSON.');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 102400) { await reader.cancel(); fail(413, 'TOO_LARGE', 'Слишком большой запрос.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes) || '{}'); } catch { fail(400, 'INVALID_JSON', 'Некорректный JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_JSON', 'Ожидается объект JSON.');
  return value;
}
const derive = (password, salt, cost = 32768) => new Promise((resolve, reject) => scrypt(password, salt, 64,
  { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const parts = (encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || !['16384','32768'].includes(parts[1]) || parts[2] !== '8' || parts[3] !== '1') return false;
  const candidate = await derive(password, parts[4], Number(parts[1]));
  const expected = Buffer.from(parts[5], 'hex');
  return expected.length === candidate.length && timingSafeEqual(candidate, expected);
}
function exactOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin)
    fail(403, 'ORIGIN', 'Запрос отклонён: источник не совпадает с адресом сайта.');
}
async function publicUser(db, user) {
  const permissions = user.role === 'admin' ? ALL_PERMISSIONS : (await rows(db, 'SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission', user.id)).map((p) => p.permission);
  return userPublic(user, permissions);
}
function userPublic(user, permissions) {
  return {
    id: user.id, username: user.username, name: user.name, position: user.position, department: user.department,
    role: user.role, active: !!user.active, archived: !!user.archived,
    permissions: user.role === 'admin' ? ALL_PERMISSIONS : permissions,
    createdAt: user.created_at,
  };
}
async function publicUsers(db, list) {
  if (list.length === 1) return [await publicUser(db, list[0])];
  const assigned = await rows(db, 'SELECT user_id,permission FROM user_permissions ORDER BY permission');
  const permissions = new Map();
  for (const p of assigned) {
    if (!permissions.has(p.user_id)) permissions.set(p.user_id, []);
    permissions.get(p.user_id).push(p.permission);
  }
  return list.map((u) => userPublic(u, permissions.get(u.id) || []));
}
async function userRow(db, id) {
  const user = await first(db, 'SELECT * FROM users WHERE id = ?', idField(id));
  if (!user) fail(404, 'NOT_FOUND', 'Сотрудник не найден.');
  return user;
}
async function auth(request, db, now) {
  const raw = cookieToken(request);
  if (!raw) return null;
  const session = await first(db, `SELECT s.token_hash, s.csrf_token, s.expires_at, u.* FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1 AND u.archived = 0`, sha(raw), now);
  if (!session) return null;
  return { row: session, user: await publicUser(db, session), csrf: session.csrf_token, tokenHash: session.token_hash };
}
function requireAdmin(actor) {
  if (actor.user.role !== 'admin') fail(403, 'FORBIDDEN', 'Действие доступно только администратору.');
}
function requirePermission(actor, permission) {
  if (actor.user.role !== 'admin' && !actor.user.permissions.includes(permission)) fail(403, 'FORBIDDEN', 'Администратор не предоставил право на это действие.');
}
function requireOwn(actor, userId) {
  if (actor.user.role !== 'admin' && actor.user.id !== userId) fail(403, 'FORBIDDEN', 'Доступ к данным другого сотрудника запрещён.');
}
function requireCsrf(request, actor) {
  exactOrigin(request);
  const supplied = request.headers.get('x-csrf-token') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(actor.csrf)))
    fail(403, 'CSRF', 'Защитный токен устарел. Обновите страницу.');
}
function auditStatement(db, actor, action, targetType, targetId, details, now, guard) {
  const sql = `INSERT INTO audit_log (id,actor_id,actor_name,action,target_type,target_id,details,created_at)
    SELECT ?,?,?,?,?,?,?,?${guard ? ' WHERE ' + guard.sql : ''}`;
  return stmt(db, sql, randomUUID(), actor.user.id, actor.user.name, action, targetType, targetId, JSON.stringify(details), now, ...(guard?.args || []));
}
async function audit(db, actor, action, type, id, details, now) {
  await auditStatement(db, actor, action, type, id, details, now).run();
}
function sessionParts(userId, now) {
  const raw = token(); const csrf = token();
  return { raw, csrf, hash: sha(raw), userId, now };
}
function sessionStatement(db, s, expectedPasswordHash) {
  return stmt(db, `INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at) SELECT ?,?,?,?,?
    ${expectedPasswordHash ? 'WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=? AND active=1 AND archived=0)' : ''}`,
  s.hash, s.userId, s.csrf, s.now + SESSION_MS, s.now, ...(expectedPasswordHash ? [s.userId, expectedPasswordHash] : []));
}
async function sessionPayload(db, user, csrf, now) {
  return { setupRequired: false, adminLogin: ADMIN_LOGIN, user: await publicUser(db, user), csrfToken: csrf, serverNow: now };
}
async function getSchedule(db, userId) {
  const s = await first(db, 'SELECT * FROM schedules WHERE user_id = ?', userId);
  return schedulePublic(s, userId);
}
function schedulePublic(s, userId) {
  return s ? { userId, startTime: s.start_time, endTime: s.end_time, breakMinutes: s.break_minutes, weekdays: JSON.parse(s.weekdays), timezone: s.timezone }
    : { userId, startTime: '09:00', endTime: '18:00', breakMinutes: 60, weekdays: [1,2,3,4,5], timezone: 'Asia/Qyzylorda' };
}
// Shifts and their breaks are read in one SQL snapshot. Two separate SELECTs could
// otherwise mix the old shift duration with breaks from a concurrent correction.
const SHIFT_SELECT = `SELECT s.*, COALESCE((SELECT json_group_array(json_object('startedAt',ordered.started_at,'endedAt',ordered.ended_at))
  FROM (SELECT b.started_at,b.ended_at FROM breaks b WHERE b.shift_id=s.id ORDER BY b.started_at,b.id) AS ordered),'[]') AS break_data FROM shifts s`;
function shiftPublic(s) {
  return { id: s.id, userId: s.user_id, startedAt: s.started_at, endedAt: s.ended_at, note: s.note, version: s.version,
    breaks: JSON.parse(s.break_data) };
}
async function publicShift(db, s) {
  const current = await first(db, SHIFT_SELECT + ' WHERE s.id=?', s.id);
  if (!current) fail(404, 'NOT_FOUND', 'Смена не найдена.');
  return shiftPublic(current);
}
async function shiftRow(db, id) {
  const s = await first(db, 'SELECT * FROM shifts WHERE id = ?', idField(id));
  if (!s) fail(404, 'NOT_FOUND', 'Смена не найдена.');
  return s;
}
function shiftFields(body, now) {
  const startedAt = timestamp(body.startedAt, 'Начало смены');
  const endedAt = timestamp(body.endedAt ?? null, 'Конец смены', true);
  if (startedAt > now || (endedAt !== null && (endedAt <= startedAt || endedAt > now)))
    fail(400, 'VALIDATION', 'Смена должна начинаться раньше окончания. Будущие отметки недопустимы.');
  const end = endedAt ?? now;
  if (!Array.isArray(body.breaks ?? []) || (body.breaks ?? []).length > 100) fail(400, 'VALIDATION', 'Допускается не более 100 перерывов за смену.');
  const breaks = (body.breaks || []).map((b) => {
    if (!b || typeof b !== 'object') fail(400, 'VALIDATION', 'Некорректный перерыв.');
    rejectUnknown(b, ['startedAt','endedAt']);
    return { startedAt: timestamp(b.startedAt, 'Начало перерыва'), endedAt: timestamp(b.endedAt ?? null, 'Конец перерыва', true) };
  }).sort((a,b) => a.startedAt - b.startedAt);
  let previousEnd = startedAt;
  breaks.forEach((b, i) => {
    if (b.startedAt < startedAt || b.startedAt > end || (b.endedAt !== null && (b.endedAt < b.startedAt || b.endedAt > end)) ||
      b.startedAt < previousEnd || (b.endedAt === null && (endedAt !== null || i !== breaks.length - 1)))
      fail(400, 'VALIDATION', 'Перерывы должны находиться внутри смены и не пересекаться. Открытым может быть только последний перерыв активной смены.');
    previousEnd = b.endedAt ?? MAX_TIME;
  });
  return { startedAt, endedAt, breaks, note: textField(body.note ?? '', 'Примечание', 2000, true) };
}
function versionField(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'VALIDATION', 'Укажите актуальную версию смены.');
  return value;
}
const revisionGuard = (id, revision) => ({ sql: 'EXISTS(SELECT 1 FROM shifts WHERE id = ? AND revision_token = ?)', args: [id, revision] });
function breakInserts(db, id, revision, breaks) {
  return breaks.map((b) => stmt(db, `INSERT INTO breaks (id,shift_id,started_at,ended_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM shifts WHERE id = ? AND revision_token = ?)`, randomUUID(), id, b.startedAt, b.endedAt, id, revision));
}

export async function handleApi(request, context) {
  try { return await route(request, context); }
  catch (error) {
    if (error instanceof ApiError) return response({ error: error.message, code: error.code }, error.status);
    if (/UNIQUE constraint failed:.*users|users_username_unique/i.test(String(error?.message)))
      return response({ error: 'Этот логин уже занят.', code: 'USERNAME_EXISTS' }, 409);
    if (/constraint failed|SQLITE_CONSTRAINT/i.test(String(error?.message)))
      return response({ error: 'Данные изменились или нарушают ограничения. Обновите страницу.', code: 'CONFLICT' }, 409);
    // Never send SQL bindings, password hashes or session tokens to the client.
    return response({ error: 'Не удалось выполнить операцию. Попробуйте ещё раз.', code: 'INTERNAL' }, 500);
  }
}

async function route(request, context) {
  const { db } = context;
  if (!db) fail(503, 'DATABASE_UNAVAILABLE', 'База данных пока не подключена.');
  const now = context.now ? context.now() : Date.now();
  const url = new URL(request.url); const path = url.pathname.replace(/\/$/, ''); const method = request.method.toUpperCase();
  const actor = await auth(request, db, now);
  if (method === 'GET' && path === '/api/session') {
    const count = await first(db, 'SELECT COUNT(*) AS count FROM users');
    return response({ setupRequired: Number(count.count) === 0 && !!context.allowSetup, adminLogin: ADMIN_LOGIN,
      user: actor?.user || null, csrfToken: actor?.csrf || null, serverNow: now });
  }
  if (method === 'POST' && path === '/api/setup') {
    exactOrigin(request);
    if (!context.allowSetup || (await first(db, 'SELECT id FROM users LIMIT 1'))) fail(409, 'SETUP_COMPLETE', 'Первоначальная настройка уже выполнена или недоступна.');
    const body = await bodyJson(request); rejectUnknown(body, ['password']);
    const hash = await hashPassword(passwordField(body.password));
    const id = randomUUID(); const s = sessionParts(id, now);
    // A guarded insert and the FK-backed batch make concurrent first-run setup atomic.
    await db.batch([
      stmt(db, `INSERT INTO users (id,username,name,password_hash,position,department,role,active,archived,master,created_at)
        SELECT ?,?,?,?,'Администратор','Управление','admin',1,0,1,? WHERE NOT EXISTS(SELECT 1 FROM users)`, id, ADMIN_LOGIN, ADMIN_NAME, hash, now),
      stmt(db, 'INSERT INTO schedules (user_id) VALUES (?)', id), sessionStatement(db, s),
      stmt(db, 'INSERT INTO audit_log (id,actor_id,actor_name,action,target_type,target_id,details,created_at) VALUES (?,?,?,?,?,?,?,?)',
        randomUUID(), id, ADMIN_NAME, 'setup', 'user', id, '{}', now),
    ]);
    return response(await sessionPayload(db, await userRow(db, id), s.csrf, now), 201, { 'Set-Cookie': cookieHeader(s.raw, context.secureCookies) });
  }
  if (method === 'POST' && path === '/api/login') {
    exactOrigin(request);
    const body = await bodyJson(request); rejectUnknown(body, ['username','password']);
    const username = usernameField(body.username);
    if (typeof body.password !== 'string' || body.password.length > 128) fail(400, 'VALIDATION', 'Некорректный пароль.');
    const bucket = sha(username.toLowerCase()); const cutoff = now - 15 * 60 * 1000;
    const attempt = await run(db, `INSERT INTO login_attempts (id,bucket,attempted_at) SELECT ?,?,?
      WHERE (SELECT COUNT(*) FROM login_attempts WHERE bucket = ? AND attempted_at > ?) < 5`, randomUUID(), bucket, now, bucket, cutoff);
    if (!changed(attempt)) fail(429, 'RATE_LIMIT', 'Слишком много попыток входа. Попробуйте через 15 минут.');
    const user = await first(db, 'SELECT * FROM users WHERE lower(username) = lower(?)', username);
    const dummy = 'scrypt$32768$8$1$00000000000000000000000000000000$' + '00'.repeat(64);
    const valid = await verifyPassword(body.password, user?.password_hash || dummy);
    if (!valid || !user?.active || user.archived) fail(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль, либо аккаунт отключён.');
    const s = sessionParts(user.id, now);
    const results = await db.batch([sessionStatement(db, s, user.password_hash), stmt(db, 'DELETE FROM login_attempts WHERE bucket = ? OR attempted_at < ?', bucket, cutoff),
      stmt(db, 'DELETE FROM sessions WHERE expires_at <= ?', now)]);
    if (!changed(results[0])) fail(401, 'INVALID_CREDENTIALS', 'Учётные данные изменились. Войдите с актуальным паролем.');
    return response(await sessionPayload(db, user, s.csrf, now), 200, { 'Set-Cookie': cookieHeader(s.raw, context.secureCookies) });
  }
  if (!actor) fail(401, 'UNAUTHENTICATED', 'Войдите в аккаунт.');
  if (!['GET','HEAD'].includes(method)) requireCsrf(request, actor);
  if (method === 'POST' && path === '/api/logout') {
    await run(db, 'DELETE FROM sessions WHERE token_hash = ?', actor.tokenHash);
    return response({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', context.secureCookies, 0) });
  }
  if (method === 'POST' && path === '/api/change-password') {
    const body = await bodyJson(request); rejectUnknown(body, ['currentPassword','newPassword']);
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 128 || !await verifyPassword(body.currentPassword, actor.row.password_hash))
      fail(403, 'INVALID_PASSWORD', 'Текущий пароль неверен.');
    const hash = await hashPassword(passwordField(body.newPassword));
    const results = await db.batch([stmt(db, 'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?', hash, actor.user.id, actor.row.password_hash),
      auditStatement(db, actor, 'password_changed', 'user', actor.user.id, {}, now, {sql:'changes() > 0',args:[]}),
      stmt(db, 'DELETE FROM sessions WHERE user_id = ? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password_hash=?)', actor.user.id, actor.user.id, hash)]);
    if (!changed(results[0])) fail(409, 'PASSWORD_CONFLICT', 'Пароль уже изменён. Войдите заново.');
    return response({ ok: true, reauthenticate: true }, 200, { 'Set-Cookie': cookieHeader('', context.secureCookies, 0) });
  }
  if (path === '/api/users' && method === 'GET') {
    requireAdmin(actor);
    const list = await rows(db, `SELECT * FROM users ${url.searchParams.get('includeArchived') === '1' ? '' : 'WHERE archived = 0'} ORDER BY master DESC,name`);
    return response({ users: await publicUsers(db, list) });
  }
  if (path === '/api/users' && method === 'POST') {
    requireAdmin(actor);
    const body = await bodyJson(request); rejectUnknown(body, ['username','name','position','department','password','permissions']);
    const username = usernameField(body.username); const name = textField(body.name, 'Имя', 100);
    const position = textField(body.position, 'Должность', 100, true); const department = textField(body.department, 'Отдел', 100, true);
    const permissions = permissionsField(body.permissions); const hash = await hashPassword(passwordField(body.password)); const id = randomUUID();
    await db.batch([
      stmt(db, 'INSERT INTO users (id,username,name,password_hash,position,department,role,created_at) VALUES (?,?,?,?,?,?,?,?)', id, username, name, hash, position, department, 'employee', now),
      stmt(db, 'INSERT INTO schedules (user_id) VALUES (?)', id),
      ...permissions.map((p) => stmt(db, 'INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', id, p)),
      auditStatement(db, actor, 'user_created', 'user', id, { name, username, permissions }, now),
    ]);
    return response({ user: await publicUser(db, await userRow(db, id)) }, 201);
  }
  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && ['PATCH','DELETE'].includes(method)) {
    requireAdmin(actor); const user = await userRow(db, userMatch[1]);
    if (method === 'DELETE') {
      if (user.master) fail(403, 'MASTER_ADMIN', 'Главного администратора нельзя удалить.');
      await db.batch([stmt(db, 'UPDATE users SET archived = 1, active = 0 WHERE id = ?', user.id),
        stmt(db, 'DELETE FROM sessions WHERE user_id = ?', user.id), auditStatement(db, actor, 'user_archived', 'user', user.id, { name: user.name }, now)]);
      return response({ ok: true });
    }
    const body = await bodyJson(request); rejectUnknown(body, ['username','name','position','department','active','archived','permissions','password']);
    const username = body.username === undefined ? user.username : usernameField(body.username);
    const name = body.name === undefined ? user.name : textField(body.name, 'Имя', 100);
    const position = body.position === undefined ? user.position : textField(body.position, 'Должность', 100, true);
    const department = body.department === undefined ? user.department : textField(body.department, 'Отдел', 100, true);
    const archived = body.archived === undefined ? user.archived : boolField(body.archived, 'Архив');
    const active = archived ? 0 : body.active === undefined ? user.active : boolField(body.active, 'Активность');
    if (user.master && (username !== ADMIN_LOGIN || name !== ADMIN_NAME || !active || archived || body.permissions !== undefined))
      fail(403, 'MASTER_ADMIN', 'Логин, имя, статус и полные права главного администратора защищены.');
    const permissions = body.permissions === undefined ? null : permissionsField(body.permissions);
    const hash = body.password === undefined ? null : await hashPassword(passwordField(body.password));
    // Omitted fields must stay untouched: a concurrent name/title edit must never
    // restore an old password or reactivate an account disabled by another request.
    const mutations = [stmt(db, `UPDATE users SET username=COALESCE(?,username),name=COALESCE(?,name),
      position=COALESCE(?,position),department=COALESCE(?,department),
      active=CASE WHEN COALESCE(?,archived)=1 THEN 0 ELSE COALESCE(?,active) END,
      archived=COALESCE(?,archived),password_hash=COALESCE(?,password_hash) WHERE id=?`,
    body.username === undefined ? null : username, body.name === undefined ? null : name,
    body.position === undefined ? null : position, body.department === undefined ? null : department,
    body.archived === undefined ? null : archived, body.active === undefined ? null : boolField(body.active, 'Активность'),
    body.archived === undefined ? null : archived, hash, user.id)];
    if (permissions) mutations.push(stmt(db, 'DELETE FROM user_permissions WHERE user_id = ?', user.id),
      ...permissions.map((p) => stmt(db, 'INSERT INTO user_permissions (user_id,permission) VALUES (?,?)', user.id, p)));
    if (body.password !== undefined || body.active === false || body.archived === true) mutations.push(stmt(db, 'DELETE FROM sessions WHERE user_id = ?', user.id));
    const details = { passwordReset: body.password !== undefined };
    for (const [key, value] of Object.entries({ username, name, position, department, active: !!active, archived: !!archived, permissions }))
      if (body[key] !== undefined) details[key] = value;
    mutations.push(auditStatement(db, actor, 'user_updated', 'user', user.id,
      details, now));
    await db.batch(mutations);
    return response({ user: await publicUser(db, await userRow(db, user.id)) });
  }
  if (path === '/api/profile' && method === 'PATCH') {
    requirePermission(actor, 'edit_own_profile');
    const body = await bodyJson(request); rejectUnknown(body, ['name','position','department']);
    const name = body.name === undefined ? actor.user.name : textField(body.name, 'Имя', 100);
    if (actor.row.master && name !== ADMIN_NAME) fail(403, 'MASTER_ADMIN', 'Имя главного администратора защищено.');
    const position = body.position === undefined ? actor.user.position : textField(body.position, 'Должность', 100, true);
    const department = body.department === undefined ? actor.user.department : textField(body.department, 'Отдел', 100, true);
    await db.batch([stmt(db, 'UPDATE users SET name=COALESCE(?,name),position=COALESCE(?,position),department=COALESCE(?,department) WHERE id=?',
      body.name === undefined ? null : name, body.position === undefined ? null : position, body.department === undefined ? null : department, actor.user.id),
      auditStatement(db, actor, 'profile_updated', 'user', actor.user.id,
        Object.fromEntries(Object.entries({name,position,department}).filter(([key]) => body[key] !== undefined)), now)]);
    return response({ user: await publicUser(db, await userRow(db, actor.user.id)) });
  }
  const scheduleMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch && ['GET','PUT'].includes(method)) {
    const userId = idField(scheduleMatch[1]); requireOwn(actor, userId); await userRow(db, userId);
    if (method === 'GET') return response({ schedule: await getSchedule(db, userId) });
    requireAdmin(actor);
    const body = await bodyJson(request); rejectUnknown(body, ['startTime','endTime','breakMinutes','weekdays','timezone']);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.endTime) || body.startTime === body.endTime)
      fail(400, 'VALIDATION', 'Укажите разное время начала и окончания рабочего дня в формате ЧЧ:ММ.');
    if (!Number.isInteger(body.breakMinutes) || body.breakMinutes < 0 || body.breakMinutes > 720) fail(400, 'VALIDATION', 'Перерыв: от 0 до 720 минут.');
    const [sh,sm] = body.startTime.split(':').map(Number); const [eh,em] = body.endTime.split(':').map(Number);
    if (body.breakMinutes >= ((eh*60+em-sh*60-sm+1440)%1440)) fail(400, 'VALIDATION', 'Перерыв должен быть короче рабочего дня.');
    if (!Array.isArray(body.weekdays) || body.weekdays.length > 7 || body.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
      fail(400, 'VALIDATION', 'Укажите дни недели числами от 1 (понедельник) до 7 (воскресенье).');
    const timezone = body.timezone ?? 'Asia/Qyzylorda';
    if (timezone !== 'Asia/Qyzylorda') fail(400, 'VALIDATION', 'В этой версии используется часовой пояс Asia/Qyzylorda.');
    const weekdays = [...new Set(body.weekdays)].sort();
    await db.batch([stmt(db, `INSERT INTO schedules (user_id,start_time,end_time,break_minutes,weekdays,timezone) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,break_minutes=excluded.break_minutes,weekdays=excluded.weekdays,timezone=excluded.timezone`,
      userId, body.startTime, body.endTime, body.breakMinutes, JSON.stringify(weekdays), timezone),
      auditStatement(db, actor, 'schedule_updated', 'user', userId, { ...body, weekdays, timezone }, now)]);
    return response({ schedule: await getSchedule(db, userId) });
  }
  if (method === 'GET' && path === '/api/dashboard') {
    const userId = url.searchParams.get('userId') || actor.user.id; requireOwn(actor, userId); const user = await userRow(db, userId);
    const list = await rows(db, SHIFT_SELECT + ' WHERE user_id = ? ORDER BY started_at DESC LIMIT 2000', userId);
    return response({ user: await publicUser(db, user), schedule: await getSchedule(db, userId), shifts: list.map(shiftPublic), serverNow: now });
  }
  if (method === 'GET' && path === '/api/audit') {
    requireAdmin(actor);
    const entries = await rows(db, 'SELECT * FROM audit_log ORDER BY created_at DESC,id DESC LIMIT 300');
    return response({ entries: entries.map((e) => ({ id: e.id, actorName: e.actor_name, action: e.action, targetType: e.target_type, targetId: e.target_id, details: JSON.parse(e.details), createdAt: e.created_at })) });
  }
  if (path === '/api/absence-requests' || /^\/api\/absence-requests\/[^/]+(?:\/cancel)?$/.test(path))
    return routeAbsenceRequests(request, context, actor, url, path, method, now);
  if (['/api/calendar','/api/team-status','/api/timesheet','/api/absences'].includes(path) || /^\/api\/absences\/[^/]+$/.test(path))
    return routeAttendance(request, context, actor, url, path, method, now);
  return routeTime(request, context, actor, url, path, method, now);
}

async function routeTime(request, context, actor, url, path, method, now) {
  const { db } = context;
  if (method === 'POST' && path === '/api/shifts/start') {
    requirePermission(actor, 'track_time');
    const body = await bodyJson(request); rejectUnknown(body, ['userId']);
    const userId = body.userId || actor.user.id; requireOwn(actor, userId);
    const user = await userRow(db, userId);
    if (!user.active || user.archived) fail(409, 'INACTIVE_USER', 'Для отключённого или архивного сотрудника нельзя начать смену.');
    const id = randomUUID(); const revision = token();
    const result = await db.batch([
      stmt(db, `INSERT INTO shifts (id,user_id,started_at,ended_at,note,version,revision_token)
        SELECT ?,?,?,NULL,'',1,? WHERE NOT EXISTS(SELECT 1 FROM shifts WHERE user_id = ? AND COALESCE(ended_at,?) > ?)`,
      id, userId, now, revision, userId, MAX_TIME, now),
      auditStatement(db, actor, 'shift_started', 'shift', id, { userId }, now, revisionGuard(id, revision)),
    ]);
    if (!changed(result[0])) fail(409, 'ACTIVE_SHIFT', 'У сотрудника уже есть незавершённая или пересекающаяся смена.');
    return response({ shift: await publicShift(db, await shiftRow(db, id)) }, 201);
  }
  const actionMatch = path.match(/^\/api\/shifts\/([^/]+)\/(pause|resume|finish)$/);
  if (method === 'POST' && actionMatch) {
    requirePermission(actor, 'track_time');
    const body = await bodyJson(request); rejectUnknown(body, []);
    const s = await shiftRow(db, actionMatch[1]); requireOwn(actor, s.user_id);
    if (s.ended_at !== null) fail(409, 'SHIFT_FINISHED', 'Эта смена уже завершена.');
    const currentBreak = await first(db, 'SELECT * FROM breaks WHERE shift_id = ? AND ended_at IS NULL', s.id);
    const action = actionMatch[2];
    if (action === 'pause' && currentBreak) fail(409, 'ALREADY_PAUSED', 'Перерыв уже начат.');
    if (action === 'resume' && !currentBreak) fail(409, 'NOT_PAUSED', 'Нет открытого перерыва.');
    if (now < s.started_at || (currentBreak && now < currentBreak.started_at) || (action === 'finish' && now <= s.started_at))
      fail(409, 'CLOCK_CONFLICT', 'Время сервера изменилось. Повторите действие позже.');
    if (action === 'pause' && Number((await first(db, 'SELECT COUNT(*) AS count FROM breaks WHERE shift_id = ?', s.id)).count) >= 100)
      fail(409, 'BREAK_LIMIT', 'В смене допускается не более 100 перерывов.');
    const revision = token();
    const mutations = [stmt(db, `UPDATE shifts SET ended_at=?,version=version+1,revision_token=?
      WHERE id=? AND version=? AND ended_at IS NULL`, action === 'finish' ? now : null, revision, s.id, s.version)];
    if (action === 'pause') mutations.push(...breakInserts(db, s.id, revision, [{ startedAt: now, endedAt: null }]));
    if (currentBreak && ['resume','finish'].includes(action)) mutations.push(stmt(db, `UPDATE breaks SET ended_at=? WHERE id=?
      AND EXISTS(SELECT 1 FROM shifts WHERE id=? AND revision_token=?)`, now, currentBreak.id, s.id, revision));
    mutations.push(auditStatement(db, actor, { pause: 'break_started', resume: 'break_finished', finish: 'shift_finished' }[action],
      'shift', s.id, { userId: s.user_id }, now, revisionGuard(s.id, revision)));
    const result = await db.batch(mutations);
    if (!changed(result[0])) fail(409, 'VERSION_CONFLICT', 'Смена уже изменена в другом окне. Обновите данные.');
    return response({ shift: await publicShift(db, await shiftRow(db, s.id)) });
  }
  if (method === 'POST' && path === '/api/shifts') {
    requirePermission(actor, 'edit_own_shifts');
    const body = await bodyJson(request); rejectUnknown(body, ['userId','startedAt','endedAt','breaks','note']);
    const userId = body.userId || actor.user.id; requireOwn(actor, userId); await userRow(db, userId);
    const values = shiftFields(body, now); const id = randomUUID(); const revision = token();
    const result = await db.batch([
      stmt(db, `INSERT INTO shifts (id,user_id,started_at,ended_at,note,version,revision_token)
        SELECT ?,?,?,?,?,1,? WHERE NOT EXISTS(SELECT 1 FROM shifts WHERE user_id=? AND started_at < ? AND COALESCE(ended_at,?) > ?)`,
      id, userId, values.startedAt, values.endedAt, values.note, revision, userId, values.endedAt ?? MAX_TIME, MAX_TIME, values.startedAt),
      ...breakInserts(db, id, revision, values.breaks),
      auditStatement(db, actor, 'shift_created', 'shift', id, { userId, ...values }, now, revisionGuard(id, revision)),
    ]);
    if (!changed(result[0])) fail(409, 'SHIFT_OVERLAP', 'Смена пересекается с другой сменой этого сотрудника.');
    return response({ shift: await publicShift(db, await shiftRow(db, id)) }, 201);
  }
  const shiftMatch = path.match(/^\/api\/shifts\/([^/]+)$/);
  if (shiftMatch && ['PATCH','DELETE'].includes(method)) {
    // Каждый сотрудник может исправлять свои смены; удаление требует отдельного права.
    if (method === 'DELETE') requirePermission(actor, 'edit_own_shifts');
    const s = await shiftRow(db, shiftMatch[1]); requireOwn(actor, s.user_id);
    const body = await bodyJson(request);
    if (method === 'DELETE') {
      rejectUnknown(body, ['version']); const version = versionField(body.version);
      const results = await db.batch([
        stmt(db, 'DELETE FROM shifts WHERE id=? AND version=?', s.id, version),
        auditStatement(db, actor, 'shift_deleted', 'shift', s.id, { userId: s.user_id, startedAt: s.started_at, endedAt: s.ended_at }, now,
          { sql: 'changes() > 0', args: [] }),
      ]);
      if (!changed(results[0])) fail(409, 'VERSION_CONFLICT', 'Смена уже изменена в другом окне. Обновите данные.');
      return response({ ok: true });
    }
    rejectUnknown(body, ['startedAt','endedAt','breaks','note','version','reason']);
    const reason = textField(body.reason, 'Причина изменения', 500);
    if (reason.length < 3) fail(400, 'VALIDATION', 'Укажите причину изменения: от 3 до 500 символов.');
    const version = versionField(body.version);
    if (version !== s.version) fail(409, 'VERSION_CONFLICT', 'Смена уже изменена в другом окне. Обновите данные.');
    const current = await publicShift(db, s);
    if (current.version !== version) fail(409, 'VERSION_CONFLICT', 'Смена уже изменена в другом окне. Обновите данные.');
    const values = shiftFields({ ...current, ...body }, now); const revision = token();
    const results = await db.batch([
      stmt(db, `UPDATE shifts SET started_at=?,ended_at=?,note=?,version=version+1,revision_token=?
        WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM shifts other WHERE other.user_id=? AND other.id<>?
          AND other.started_at < ? AND COALESCE(other.ended_at,?) > ?)`,
      values.startedAt, values.endedAt, values.note, revision, s.id, version, s.user_id, s.id, values.endedAt ?? MAX_TIME, MAX_TIME, values.startedAt),
      stmt(db, 'DELETE FROM breaks WHERE shift_id=? AND EXISTS(SELECT 1 FROM shifts WHERE id=? AND revision_token=?)', s.id, s.id, revision),
      ...breakInserts(db, s.id, revision, values.breaks),
      auditStatement(db, actor, 'shift_updated', 'shift', s.id, { userId: s.user_id, reason,
        before: { startedAt: current.startedAt, endedAt: current.endedAt, breaks: current.breaks, note: current.note },
        after: values, previousVersion: version }, now, revisionGuard(s.id, revision)),
    ]);
    if (!changed(results[0])) fail(409, 'SHIFT_CONFLICT', 'Смена изменена в другом окне или пересекается с другой сменой. Обновите данные.');
    return response({ shift: await publicShift(db, await shiftRow(db, s.id)) });
  }
  if (method === 'GET' && ['/api/reports','/api/export'].includes(path)) {
    requirePermission(actor, path === '/api/export' ? 'export_reports' : 'view_reports');
    const userId = url.searchParams.get('userId') || actor.user.id; requireOwn(actor, userId);
    const user = await userRow(db, userId); const schedule = await getSchedule(db, userId);
    const report = await buildReport(db, userId, url.searchParams, now, schedule.timezone);
    if (path === '/api/reports') return response(report);
    const quote = (value) => {
      let result = String(value);
      if (/^[\s\uFEFF]*[=+\-@]/.test(result) || /^[\t\r\n]/.test(result)) result = "'" + result;
      return '"' + result.replace(/"/g, '""') + '"';
    };
    const csv = '\uFEFF' + [['Сотрудник','Дата','Рабочее время (часы)','Перерывы (часы)'],
      ...report.days.map((d) => [user.name,d.date,(d.workMs/3600000).toFixed(2),(d.breakMs/3600000).toFixed(2)]),
      ['Итого','',(report.totals.workMs/3600000).toFixed(2),(report.totals.breakMs/3600000).toFixed(2)]]
      .map((line) => line.map(quote).join(';')).join('\r\n');
    await audit(db, actor, 'report_exported', 'user', userId, { from: report.days[0]?.date, to: report.days.at(-1)?.date }, now);
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="smena-report.csv"', 'Cache-Control': 'no-store' } });
  }
  fail(404, 'NOT_FOUND', 'Адрес API не найден.');
}

function attendanceMonth(value, now) {
  const month = value || localDay(now, 'Asia/Qyzylorda').slice(0,7);
  let bounds;
  try { bounds = monthBounds(month); } catch { fail(400, 'VALIDATION', 'Месяц должен быть в формате ГГГГ-ММ.'); }
  return { month, ...bounds, firstDate: month + '-01', lastDate: localDay(bounds.to - 1, 'Asia/Qyzylorda') };
}
function absencePublic(a) {
  return { id: a.id, userId: a.user_id, startDate: a.start_date, endDate: a.end_date, type: a.type,
    note: a.note, createdAt: a.created_at, version: a.version };
}
const REQUEST_SELECT = `SELECT ar.*,u.name AS owner_name,u.department AS owner_department,u.position AS owner_position,
  u.active AS owner_active,u.archived AS owner_archived,d.name AS decider_name FROM absence_requests ar
  JOIN users u ON u.id=ar.user_id LEFT JOIN users d ON d.id=ar.decided_by`;
function absenceRequestPublic(r) {
  return { id: r.id, userId: r.user_id, user: { id: r.user_id, name: r.owner_name, department: r.owner_department, position: r.owner_position },
    startDate: r.start_date, endDate: r.end_date, type: r.type, note: r.note, status: r.status, createdAt: r.created_at,
    decidedAt: r.decided_at, decidedBy: r.decided_by ? { id: r.decided_by, name: r.decider_name } : null,
    decisionNote: r.decision_note, absenceId: r.absence_id, version: r.version };
}
async function absenceRequestRow(db, id) {
  const current = await first(db, REQUEST_SELECT + ' WHERE ar.id=?', idField(id));
  if (!current) fail(404, 'NOT_FOUND', 'Заявка не найдена.');
  return current;
}
async function routeAbsenceRequests(request, context, actor, url, path, method, now) {
  const { db } = context;
  if (path === '/api/absence-requests' && method === 'GET') {
    const status = url.searchParams.get('status') || 'all';
    if (!['all','pending','approved','rejected','cancelled'].includes(status)) fail(400, 'VALIDATION', 'Неизвестный статус заявки.');
    // One read keeps the filter-independent counts and displayed requests coherent.
    const selected = await rows(db, REQUEST_SELECT + (actor.user.role === 'admin' ? '' : ' WHERE ar.user_id=?')
      + ' ORDER BY ar.created_at DESC,ar.id DESC', ...(actor.user.role === 'admin' ? [] : [actor.user.id]));
    const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const row of selected) counts[row.status]++;
    return response({ requests: selected.filter((r) => status === 'all' || r.status === status).map(absenceRequestPublic), counts, serverNow: now });
  }
  if (path === '/api/absence-requests' && method === 'POST') {
    const body = await bodyJson(request); rejectUnknown(body, ['startDate','endDate','type','note']);
    const range = absenceRange(body.startDate, body.endDate);
    if (!['vacation','day_off'].includes(body.type)) fail(400, 'VALIDATION', 'В заявке можно выбрать только отпуск или отгул.');
    const note = textField(body.note ?? '', 'Примечание', 2000, true); const id = randomUUID();
    const result = await db.batch([
      stmt(db, `INSERT INTO absence_requests (id,user_id,start_date,end_date,type,note,status,created_at,version)
        SELECT ?,?,?,?,?,?,'pending',?,1 WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND archived=0)
        AND NOT EXISTS(SELECT 1 FROM absence_requests WHERE user_id=? AND status='pending' AND start_date<=? AND end_date>=?)
        AND NOT EXISTS(SELECT 1 FROM absences WHERE user_id=? AND start_date<=? AND end_date>=?)`,
      id, actor.user.id, range.startDate, range.endDate, body.type, note, now, actor.user.id,
      actor.user.id, range.endDate, range.startDate, actor.user.id, range.endDate, range.startDate),
      auditStatement(db, actor, 'absence_request_created', 'absence_request', id,
        { userId: actor.user.id, ...range, type: body.type, note }, now, { sql: 'EXISTS(SELECT 1 FROM absence_requests WHERE id=?)', args: [id] }),
    ]);
    if (!changed(result[0])) fail(409, 'REQUEST_OVERLAP', 'Период пересекается с ожидающей заявкой или отсутствием, либо аккаунт недоступен.');
    return response({ request: absenceRequestPublic(await absenceRequestRow(db, id)) }, 201);
  }
  const decision = path.match(/^\/api\/absence-requests\/([^/]+)$/);
  if (decision && method === 'PATCH') {
    requireAdmin(actor);
    const body = await bodyJson(request); rejectUnknown(body, ['version','status','decisionNote']);
    const version = versionField(body.version);
    if (!['approved','rejected'].includes(body.status)) fail(400, 'VALIDATION', 'Администратор может одобрить или отклонить заявку.');
    const decisionNote = textField(body.decisionNote ?? '', 'Комментарий к решению', 500, true);
    if (body.status === 'rejected' && decisionNote.length < 3) fail(400, 'VALIDATION', 'Укажите причину отказа: от 3 до 500 символов.');
    const current = await absenceRequestRow(db, decision[1]);
    if (current.status !== 'pending' || current.version !== version) fail(409, 'REQUEST_CONFLICT', 'Заявка уже рассмотрена, отменена или изменена. Обновите данные.');
    if (body.status === 'approved') {
      if (!current.owner_active || current.owner_archived) fail(409, 'INACTIVE_USER', 'Нельзя одобрить заявку отключённого или архивного сотрудника.');
      const absenceId = randomUUID();
      // The guarded insert is the approval's gate. Every later statement depends
      // on this exact new absence, so a failed overlap/CAS check resolves nothing.
      const results = await db.batch([
        stmt(db, `INSERT INTO absences (id,user_id,start_date,end_date,type,note,created_at,version)
          SELECT ?,ar.user_id,ar.start_date,ar.end_date,ar.type,ar.note,?,1 FROM absence_requests ar JOIN users u ON u.id=ar.user_id
          WHERE ar.id=? AND ar.status='pending' AND ar.version=? AND u.active=1 AND u.archived=0
          AND NOT EXISTS(SELECT 1 FROM absences a WHERE a.user_id=ar.user_id AND a.start_date<=ar.end_date AND a.end_date>=ar.start_date)`,
        absenceId, now, current.id, version),
        stmt(db, `UPDATE absence_requests SET status='approved',decided_at=?,decided_by=?,decision_note=?,absence_id=?,version=version+1
          WHERE id=? AND status='pending' AND version=? AND EXISTS(SELECT 1 FROM absences WHERE id=?)`,
        now, actor.user.id, decisionNote, absenceId, current.id, version, absenceId),
        auditStatement(db, actor, 'absence_request_approved', 'absence_request', current.id,
          { userId: current.user_id, startDate: current.start_date, endDate: current.end_date, type: current.type, decisionNote, absenceId, previousVersion: version }, now,
          { sql: "EXISTS(SELECT 1 FROM absence_requests WHERE id=? AND status='approved' AND absence_id=?)", args: [current.id, absenceId] }),
      ]);
      if (!changed(results[0]) || !changed(results[1])) fail(409, 'REQUEST_CONFLICT', 'Заявка уже изменена, сотрудник отключён или даты пересекаются с существующим отсутствием.');
    } else {
      const results = await db.batch([
        stmt(db, `UPDATE absence_requests SET status='rejected',decided_at=?,decided_by=?,decision_note=?,version=version+1
          WHERE id=? AND status='pending' AND version=?`, now, actor.user.id, decisionNote, current.id, version),
        auditStatement(db, actor, 'absence_request_rejected', 'absence_request', current.id,
          { userId: current.user_id, decisionNote, previousVersion: version }, now, { sql: 'changes() > 0', args: [] }),
      ]);
      if (!changed(results[0])) fail(409, 'REQUEST_CONFLICT', 'Заявка уже рассмотрена, отменена или изменена. Обновите данные.');
    }
    return response({ request: absenceRequestPublic(await absenceRequestRow(db, current.id)) });
  }
  const cancellation = path.match(/^\/api\/absence-requests\/([^/]+)\/cancel$/);
  if (cancellation && method === 'POST') {
    const current = await absenceRequestRow(db, cancellation[1]);
    if (current.user_id !== actor.user.id) fail(403, 'FORBIDDEN', 'Отменить заявку может только её автор.');
    const body = await bodyJson(request); rejectUnknown(body, ['version']); const version = versionField(body.version);
    const results = await db.batch([
      stmt(db, `UPDATE absence_requests SET status='cancelled',decided_at=?,decided_by=?,decision_note='',version=version+1
        WHERE id=? AND user_id=? AND status='pending' AND version=?`, now, actor.user.id, current.id, actor.user.id, version),
      auditStatement(db, actor, 'absence_request_cancelled', 'absence_request', current.id,
        { userId: current.user_id, previousVersion: version }, now, { sql: 'changes() > 0', args: [] }),
    ]);
    if (!changed(results[0])) fail(409, 'REQUEST_CONFLICT', 'Отменить можно только свою ожидающую заявку актуальной версии.');
    return response({ request: absenceRequestPublic(await absenceRequestRow(db, current.id)) });
  }
  fail(404, 'NOT_FOUND', 'Адрес API не найден.');
}
function groupByUser(list, key) {
  const map = new Map();
  for (const entry of list) {
    const userId = entry[key];
    if (!map.has(userId)) map.set(userId, []);
    map.get(userId).push(entry);
  }
  return map;
}
async function attendanceInputs(db, period, userId, includeActive = false) {
  const params = userId ? [userId] : [];
  const [scheduleRows, shiftRows, absenceRows] = await Promise.all([
    rows(db, 'SELECT * FROM schedules' + (userId ? ' WHERE user_id=?' : ''), ...params),
    rows(db, SHIFT_SELECT + ` WHERE ((started_at>=? AND started_at<?)${includeActive ? ' OR ended_at IS NULL' : ''})`
      + (userId ? ' AND user_id=?' : '') + ' ORDER BY started_at', period.from, period.to, ...params),
    rows(db, 'SELECT * FROM absences WHERE start_date<=? AND end_date>=?' + (userId ? ' AND user_id=?' : '') + ' ORDER BY start_date,id',
      period.lastDate, period.firstDate, ...params),
  ]);
  const schedules = new Map(scheduleRows.map((s) => [s.user_id, s]));
  const shifts = groupByUser(shiftRows.map(shiftPublic), 'userId');
  const absences = groupByUser(absenceRows.map(absencePublic), 'userId');
  return (id) => ({ schedule: schedulePublic(schedules.get(id), id), shifts: shifts.get(id) || [], absences: absences.get(id) || [] });
}
function absenceRange(from, to) {
  const startDate = validDate(from); const endDate = validDate(to);
  const count = (Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / DAY + 1;
  if (count < 1 || count > 366) fail(400, 'VALIDATION', 'Период отсутствия должен составлять от 1 до 366 дней.');
  return { startDate, endDate };
}
async function routeAttendance(request, context, actor, url, path, method, now) {
  const { db } = context;
  if (method === 'GET' && path === '/api/calendar') {
    const userId = url.searchParams.get('userId') || actor.user.id; requireOwn(actor, userId);
    const user = await userRow(db, userId); const period = attendanceMonth(url.searchParams.get('month'), now);
    const inputs = (await attendanceInputs(db, period, userId))(userId);
    const days = buildAttendanceMonth({ month: period.month, ...inputs, now, createdAt: user.created_at });
    return response({ user: await publicUser(db, user), schedule: inputs.schedule, month: period.month, days,
      shifts: inputs.shifts, absences: inputs.absences, serverNow: now });
  }
  if (method === 'GET' && path === '/api/team-status') {
    requireAdmin(actor);
    const period = attendanceMonth(null, now); const today = localDay(now, 'Asia/Qyzylorda');
    const list = await rows(db, 'SELECT * FROM users WHERE active=1 AND archived=0 ORDER BY master DESC,name');
    const [getInputs, users] = await Promise.all([attendanceInputs(db, period, null, true), publicUsers(db, list)]);
    const members = users.map((user) => {
      const inputs = getInputs(user.id);
      const day = buildAttendanceMonth({ month: period.month, ...inputs, now, createdAt: user.createdAt }).find((d) => d.date === today);
      const activeShift = inputs.shifts.find((s) => s.endedAt === null) || null;
      const status = activeShift ? activeShift.breaks.some((b) => b.endedAt === null) ? 'break' : 'working'
        : day.shiftIds.length ? 'finished' : day.kind === 'absence' ? 'absence' : day.kind === 'day_off' ? 'day_off' : 'not_started';
      return { user, status, activeShift, day };
    });
    return response({ members, serverNow: now });
  }
  if (method === 'GET' && path === '/api/timesheet') {
    requirePermission(actor, 'view_reports');
    const userId = url.searchParams.get('userId') || actor.user.id;
    const period = attendanceMonth(url.searchParams.get('month'), now);
    let list;
    if (userId === 'all') {
      requireAdmin(actor);
      list = await rows(db, `SELECT * FROM users u WHERE archived=0
        OR EXISTS(SELECT 1 FROM shifts s WHERE s.user_id=u.id AND s.started_at>=? AND s.started_at<?)
        OR EXISTS(SELECT 1 FROM absences a WHERE a.user_id=u.id AND a.start_date<=? AND a.end_date>=?) ORDER BY master DESC,name`,
      period.from, period.to, period.lastDate, period.firstDate);
    } else { requireOwn(actor, userId); list = [await userRow(db, userId)]; }
    const [getInputs, users] = await Promise.all([attendanceInputs(db, period, userId === 'all' ? null : userId), publicUsers(db, list)]);
    const reportRows = users.map((user) => {
      const days = buildAttendanceMonth({ month: period.month, ...getInputs(user.id), now, createdAt: user.createdAt });
      const totals = Object.fromEntries(['plannedMs','workMs','breakMs','lateMs','overtimeMs'].map((key) => [key, days.reduce((sum,day) => sum + day[key], 0)]));
      return { user, days, ...totals };
    });
    const dates = reportRows[0]?.days.map((day) => day.date) || buildAttendanceMonth({ month: period.month,
      schedule: schedulePublic(null, ''), shifts: [], absences: [], now }).map((day) => day.date);
    return response({ month: period.month, days: dates, rows: reportRows, serverNow: now });
  }
  if (method === 'GET' && path === '/api/absences') {
    const userId = url.searchParams.get('userId') || actor.user.id; requireOwn(actor, userId); await userRow(db, userId);
    const period = attendanceMonth(null, now);
    const range = absenceRange(url.searchParams.get('from') || period.firstDate, url.searchParams.get('to') || period.lastDate);
    const selected = await rows(db, 'SELECT * FROM absences WHERE user_id=? AND start_date<=? AND end_date>=? ORDER BY start_date,id',
      userId, range.endDate, range.startDate);
    return response({ absences: selected.map(absencePublic), serverNow: now });
  }
  if (method === 'POST' && path === '/api/absences') {
    requireAdmin(actor);
    const body = await bodyJson(request); rejectUnknown(body, ['userId','startDate','endDate','type','note']);
    const userId = idField(body.userId); await userRow(db, userId);
    const range = absenceRange(body.startDate, body.endDate);
    if (!['vacation','day_off','other'].includes(body.type)) fail(400, 'VALIDATION', 'Выберите тип отсутствия: отпуск, выходной или другое.');
    const note = textField(body.note ?? '', 'Примечание', 2000, true); const id = randomUUID();
    const result = await db.batch([
      stmt(db, `INSERT INTO absences (id,user_id,start_date,end_date,type,note,created_at,version)
        SELECT ?,?,?,?,?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM absences WHERE user_id=? AND start_date<=? AND end_date>=?)`,
      id, userId, range.startDate, range.endDate, body.type, note, now, userId, range.endDate, range.startDate),
      auditStatement(db, actor, 'absence_created', 'absence', id, { userId, ...range, type: body.type, note }, now,
        { sql: 'EXISTS(SELECT 1 FROM absences WHERE id=?)', args: [id] }),
    ]);
    if (!changed(result[0])) fail(409, 'ABSENCE_OVERLAP', 'Выбранный период пересекается с другим отсутствием сотрудника.');
    return response({ absence: absencePublic(await first(db, 'SELECT * FROM absences WHERE id=?', id)) }, 201);
  }
  const absenceMatch = path.match(/^\/api\/absences\/([^/]+)$/);
  if (method === 'DELETE' && absenceMatch) {
    requireAdmin(actor); const id = idField(absenceMatch[1]);
    const current = await first(db, 'SELECT * FROM absences WHERE id=?', id);
    if (!current) fail(404, 'NOT_FOUND', 'Отсутствие не найдено.');
    const body = await bodyJson(request); rejectUnknown(body, ['version']); const version = versionField(body.version);
    const results = await db.batch([stmt(db, 'DELETE FROM absences WHERE id=? AND version=?', id, version),
      auditStatement(db, actor, 'absence_deleted', 'absence', id, absencePublic(current), now, { sql: 'changes() > 0', args: [] })]);
    if (!changed(results[0])) fail(409, 'VERSION_CONFLICT', 'Отсутствие уже изменено. Обновите данные.');
    return response({ ok: true });
  }
  fail(404, 'NOT_FOUND', 'Адрес API не найден.');
}

function dateParts(timestampValue, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(timestampValue);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}
function localDay(timestampValue, timezone) {
  const p = dateParts(timestampValue, timezone); return `${p.year}-${p.month}-${p.day}`;
}
function midnight(date, timezone) {
  const target = Date.parse(date + 'T00:00:00Z'); let candidate = target;
  for (let i = 0; i < 3; i++) {
    const p = dateParts(candidate, timezone);
    const localAsUTC = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    candidate += target - localAsUTC;
  }
  return candidate;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value)
    fail(400, 'VALIDATION', 'Дата должна быть в формате ГГГГ-ММ-ДД.');
  return value;
}
async function buildReport(db, userId, params, now, timezone) {
  const today = localDay(now, timezone);
  const from = validDate(params.get('from') || today.slice(0,7) + '-01'); const to = validDate(params.get('to') || today);
  const fromUTC = Date.parse(from + 'T00:00:00Z'); const toUTC = Date.parse(to + 'T00:00:00Z');
  const dayCount = (toUTC-fromUTC)/DAY+1;
  if (dayCount < 1 || dayCount > 366) fail(400, 'VALIDATION', 'Выберите период от 1 до 366 дней.');
  const bounds = Array.from({ length: dayCount+1 }, (_, i) => {
    const date = new Date(fromUTC + i*DAY).toISOString().slice(0,10);
    return { date, time: midnight(date, timezone) };
  });
  const selected = await rows(db, SHIFT_SELECT + ' WHERE user_id=? AND started_at < ? AND COALESCE(ended_at,?) > ? ORDER BY started_at',
    userId, bounds.at(-1).time, now, bounds[0].time);
  const list = selected.map(shiftPublic);
  let completedWork = 0;
  const overlap = (a,b,c,d) => Math.max(0, Math.min(b,d)-Math.max(a,c));
  const days = bounds.slice(0,-1).map((bound,i) => {
    const end = bounds[i+1].time; let workMs = 0; let breakMs = 0;
    for (const shift of list) {
      const finish = shift.endedAt ?? now;
      const duration = overlap(shift.startedAt,finish,bound.time,end);
      let breaks = 0;
      for (const pause of shift.breaks) breaks += overlap(pause.startedAt,pause.endedAt ?? finish,bound.time,end);
      workMs += duration-breaks; breakMs += breaks;
      if (shift.endedAt !== null) completedWork += duration-breaks;
    }
    return { date: bound.date, workMs, breakMs };
  });
  const completedShifts = list.filter((s) => s.endedAt !== null).length;
  return { days, totals: { workMs: days.reduce((sum,d) => sum+d.workMs,0), breakMs: days.reduce((sum,d) => sum+d.breakMs,0),
    completedShifts, averageMs: completedShifts ? Math.round(completedWork/completedShifts) : 0 }, serverNow: now };
}
