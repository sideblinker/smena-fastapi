import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteDatabase } from '../src/server/sqlite.mjs';
import { handleApi } from '../src/server/service.mjs';

const ORIGIN = 'http://localhost:8787';
const PASSWORD = 'Strong-pass-2026!';
const HOUR = 3600000;
function pauseFirstRead(db, predicate) {
  let resolveReached; let resolveRelease; let intercepted = false;
  const reached = new Promise((resolve) => { resolveReached = resolve; });
  const released = new Promise((resolve) => { resolveRelease = resolve; });
  const originalPrepare = db.prepare;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    const decorate = (s) => {
      const originalFirst = s.first;
      s.first = async (...args) => {
        const row = await originalFirst.call(s,...args);
        if (!intercepted && predicate(sql,row)) { intercepted = true; resolveReached(); await released; }
        return row;
      };
      return s;
    };
    const originalBind = statement.bind;
    statement.bind = (...args) => decorate(originalBind.call(statement,...args));
    return decorate(statement);
  };
  return { reached, release: resolveRelease, restore: () => { db.prepare = originalPrepare; } };
}
async function fixture(t) {
  const db = createSqliteDatabase(':memory:'); t.after(() => db.close());
  let now = Date.parse('2026-10-15T10:00:00Z');
  const ctx = { db, allowSetup: true, secureCookies: false, now: () => now };
  function client() {
    let cookie = ''; let csrf = '';
    return {
      async call(path, method = 'GET', body, headers = {}) {
        const request = new Request(ORIGIN + path, { method, headers: {
          ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}), ...headers,
        }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        const result = await handleApi(request, ctx);
        const setCookie = result.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const data = result.headers.get('content-type')?.includes('json') ? await result.json() : await result.text();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: result.status, data, headers: result.headers };
      },
      get cookie() { return cookie; }, get csrf() { return csrf; },
    };
  }
  const admin = client();
  const setup = await admin.call('/api/setup', 'POST', { password: PASSWORD });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));
  async function employee(username = 'employee', permissions) {
    const added = await admin.call('/api/users', 'POST', { username, name: 'Сотрудник ' + username, password: PASSWORD, permissions });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    const c = client(); assert.equal((await c.call('/api/login', 'POST', { username, password: PASSWORD })).status, 200);
    return { ...c, call: c.call, user: added.data.user };
  }
  return { db, ctx, admin, client, employee, adminUser: setup.data.user, setNow: (n) => { now = n; }, get now() { return now; } };
}

test('first-run setup creates fixed master account, hashed password and private cookie', async (t) => {
  const f = await fixture(t);
  assert.equal(f.adminUser.username, 'Adilium'); assert.equal(f.adminUser.name, 'Адиль Кубентаев'); assert.equal(f.adminUser.role, 'admin');
  assert.equal(f.adminUser.passwordHash, undefined);
  const row = await f.db.prepare('SELECT * FROM users').first();
  assert.match(row.password_hash, /^scrypt\$/); assert.ok(!row.password_hash.includes(PASSWORD));
  const session = await f.db.prepare('SELECT * FROM sessions').first(); assert.ok(!f.admin.cookie.includes(session.token_hash));
  const other = f.client(); assert.equal((await other.call('/api/setup', 'POST', { password: PASSWORD })).status, 409);
  assert.equal((await other.call('/api/dashboard')).status, 401);
  assert.equal((await f.admin.call('/api/session')).data.setupRequired, false);
  const login = await other.call('/api/login','POST',{username:'Adilium',password:PASSWORD});
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\//);
});

test('public empty database stays closed without explicit setup authorization and has no self signup', async (t) => {
  const db = createSqliteDatabase(':memory:'); t.after(() => db.close());
  const base = {db,allowSetup:false,secureCookies:true};
  const request = (path, body) => new Request('https://smena.example'+path, body ? {method:'POST',
    headers:{Origin:'https://smena.example','Content-Type':'application/json'},body:JSON.stringify(body)} : {});
  const session = await handleApi(request('/api/session'),base);
  assert.equal((await session.json()).setupRequired,false);
  assert.equal((await handleApi(request('/api/setup',{password:PASSWORD}),base)).status,409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM users').first()).count,0);
  assert.equal((await handleApi(request('/api/users',{username:'attacker',name:'Attacker',password:PASSWORD}),base)).status,401);
  const setup = await handleApi(request('/api/setup',{password:PASSWORD}),{...base,allowSetup:true});
  assert.equal(setup.status,201); assert.match(setup.headers.get('set-cookie'),/; Secure/);
  assert.equal((await handleApi(request('/api/setup',{password:PASSWORD}),{...base,allowSetup:true})).status,409);
});

test('SQL injection login, repeated wrong passwords and login rate limiting', async (t) => {
  const f = await fixture(t); const c = f.client();
  assert.equal((await c.call('/api/login', 'POST', { username: "' OR 1=1 --", password: PASSWORD })).status, 400);
  for (let i=0;i<5;i++) assert.equal((await c.call('/api/login', 'POST', { username: 'Adilium', password: 'wrong' })).status, 401);
  assert.equal((await c.call('/api/login', 'POST', { username: 'Adilium', password: PASSWORD })).status, 429);
  f.setNow(f.now + 15*60000 + 1);
  assert.equal((await c.call('/api/login', 'POST', { username: 'adilium', password: PASSWORD })).status, 200);
});

test('mutations require exact origin and CSRF token including malformed unicode', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.admin.call('/api/shifts/start', 'POST', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.admin.call('/api/shifts/start', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.admin.call('/api/shifts/start', 'POST', {}, { 'X-CSRF-Token': 'a'.repeat(42) })).status, 403);
  const foreign = new Request(ORIGIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({username:'Adilium',password:PASSWORD}) });
  assert.equal((await handleApi(foreign, f.ctx)).status, 403);
});

test('employees cannot read or change other accounts, schedules, rights or admin data', async (t) => {
  const f = await fixture(t); const a = await f.employee('alice'); const b = await f.employee('boris');
  for (const path of ['/api/users', '/api/audit', '/api/dashboard?userId='+b.user.id, '/api/schedules/'+b.user.id, '/api/reports?userId='+b.user.id])
    assert.equal((await a.call(path)).status, 403, path);
  assert.equal((await a.call('/api/users/'+a.user.id, 'PATCH', {permissions:['edit_own_shifts']})).status, 403);
  assert.equal((await a.call('/api/profile', 'PATCH', {role:'admin'})).status, 400);
  assert.equal((await a.call('/api/shifts/start','POST',{userId:b.user.id})).status,403);
  assert.equal((await a.call('/api/schedules/'+a.user.id,'PUT',{startTime:'09:00',endTime:'18:00',breakMinutes:60,weekdays:[1]})).status,403);
  assert.equal((await a.call('/api/profile','PATCH',{name:'Новое имя'})).data.user.name,'Новое имя');
});

test('admin manages rights, profiles, schedules, archive and login reset', async (t) => {
  const f = await fixture(t); const e = await f.employee(); const id = e.user.id;
  let result = await f.admin.call('/api/users/'+id,'PATCH',{name:'Новое имя',department:'IT',position:'Разработчик',permissions:[]});
  assert.equal(result.status,200); assert.deepEqual(result.data.user.permissions,[]);
  assert.equal((await e.call('/api/shifts/start','POST',{})).status,403);
  assert.equal((await e.call('/api/reports')).status,403);
  result = await f.admin.call('/api/schedules/'+id,'PUT',{startTime:'22:00',endTime:'06:00',breakMinutes:30,weekdays:[1,2,3,7],timezone:'Asia/Qyzylorda'});
  assert.equal(result.status,200); assert.equal(result.data.schedule.startTime,'22:00');
  assert.deepEqual(result.data.schedule.weekdays,[1,2,3,7]);
  assert.equal((await f.admin.call('/api/users/'+id,'PATCH',{password:'Another-good-password!'})).status,200);
  assert.equal((await e.call('/api/dashboard')).status,401);
  const c = f.client(); assert.equal((await c.call('/api/login','POST',{username:'employee',password:PASSWORD})).status,401);
  assert.equal((await c.call('/api/login','POST',{username:'employee',password:'Another-good-password!'})).status,200);
  assert.equal((await f.admin.call('/api/users/'+id,'DELETE')).status,200);
  assert.equal((await c.call('/api/dashboard')).status,401);
  assert.equal((await f.admin.call('/api/users')).data.users.length,1);
  assert.equal((await f.admin.call('/api/users?includeArchived=1')).data.users.length,2);
  assert.equal((await f.admin.call('/api/users/'+id,'PATCH',{archived:false,active:true})).status,200);
});

test('master administrator cannot be removed, renamed, disabled or demoted', async (t) => {
  const f = await fixture(t); const path = '/api/users/'+f.adminUser.id;
  assert.equal((await f.admin.call(path,'DELETE')).status,403);
  for (const data of [{active:false},{archived:true},{permissions:[]},{username:'different'},{name:'Different'}])
    assert.equal((await f.admin.call(path,'PATCH',data)).status,403);
  assert.equal((await f.admin.call(path,'PATCH',{role:'employee'})).status,400);
});

test('timers survive sessions, calculate breaks and prevent duplicate actions', async (t) => {
  const f = await fixture(t); const e = await f.employee(); const start = f.now;
  let result = await e.call('/api/shifts/start','POST',{}); assert.equal(result.status,201); const id = result.data.shift.id;
  assert.equal(result.data.shift.startedAt,start);
  assert.equal((await e.call('/api/shifts/start','POST',{})).status,409);
  f.setNow(start+HOUR); result = await e.call('/api/shifts/'+id+'/pause','POST',{}); assert.equal(result.status,200);
  assert.equal((await e.call('/api/shifts/'+id+'/pause','POST',{})).status,409);
  f.setNow(start+1.5*HOUR); result = await e.call('/api/shifts/'+id+'/resume','POST',{}); assert.equal(result.status,200);
  assert.equal(result.data.shift.breaks[0].endedAt,start+1.5*HOUR);
  assert.equal((await e.call('/api/shifts/'+id+'/resume','POST',{})).status,409);
  f.setNow(start+2*HOUR); result = await e.call('/api/shifts/'+id+'/pause','POST',{}); assert.equal(result.status,200);
  f.setNow(start+2.5*HOUR); result = await e.call('/api/shifts/'+id+'/finish','POST',{}); assert.equal(result.status,200);
  assert.equal(result.data.shift.breaks[1].endedAt,start+2.5*HOUR);
  assert.equal((await e.call('/api/shifts/'+id+'/finish','POST',{})).status,409);
  result = await e.call('/api/reports?from=2026-10-15&to=2026-10-15');
  assert.equal(result.data.totals.workMs,1.5*HOUR); assert.equal(result.data.totals.breakMs,HOUR); assert.equal(result.data.totals.completedShifts,1);
  const otherSession = f.client(); await otherSession.call('/api/login','POST',{username:'employee',password:PASSWORD});
  assert.equal((await otherSession.call('/api/dashboard')).data.shifts[0].id,id);
});

test('manual editing validates all break boundaries, overlaps and future times', async (t) => {
  const f = await fixture(t); const userId = f.adminUser.id; const start = f.now-10*HOUR;
  const base = {userId,startedAt:start,endedAt:start+3*HOUR,breaks:[],note:'Смена'};
  for (const data of [
    {...base,endedAt:start}, {...base,startedAt:f.now+1,endedAt:null},
    {...base,breaks:[{startedAt:start-HOUR,endedAt:start}]},
    {...base,breaks:[{startedAt:start+HOUR,endedAt:null}]},
    {...base,breaks:[{startedAt:start+HOUR,endedAt:start+2*HOUR},{startedAt:start+1.5*HOUR,endedAt:start+2.5*HOUR}]},
  ]) assert.equal((await f.admin.call('/api/shifts','POST',data)).status,400);
  const valid = await f.admin.call('/api/shifts','POST',base); assert.equal(valid.status,201);
  assert.equal((await f.admin.call('/api/shifts','POST',{...base,startedAt:start+2*HOUR,endedAt:start+4*HOUR})).status,409);
  assert.equal((await f.admin.call('/api/shifts','POST',{...base,startedAt:start+3*HOUR,endedAt:start+4*HOUR})).status,201);
});

test('concurrent shift edit uses compare-and-swap and does not overwrite winning breaks', async (t) => {
  const f = await fixture(t); const start = f.now-10*HOUR;
  const added = await f.admin.call('/api/shifts','POST',{userId:f.adminUser.id,startedAt:start,endedAt:start+4*HOUR,breaks:[]});
  const id = added.data.shift.id;
  const results = await Promise.all([
    f.admin.call('/api/shifts/'+id,'PATCH',{version:1,note:'A',breaks:[{startedAt:start+HOUR,endedAt:start+2*HOUR}]}),
    f.admin.call('/api/shifts/'+id,'PATCH',{version:1,note:'B',breaks:[{startedAt:start+2*HOUR,endedAt:start+3*HOUR}]}),
  ]);
  assert.deepEqual(results.map((r)=>r.status).sort(),[200,409]);
  const winner = results.find((r)=>r.status===200).data.shift;
  const read = (await f.admin.call('/api/dashboard')).data.shifts[0];
  assert.equal(read.version,2); assert.equal(read.note,winner.note); assert.deepEqual(read.breaks,winner.breaks);
  assert.equal((await f.admin.call('/api/shifts/'+id,'DELETE',{version:1})).status,409);
  assert.equal((await f.admin.call('/api/shifts/'+id,'DELETE',{version:2})).status,200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM breaks').first()).count,0);
});

test('concurrent starts produce exactly one active shift', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.admin.call('/api/shifts/start','POST',{}), f.admin.call('/api/shifts/start','POST',{})]);
  assert.deepEqual(results.map((r)=>r.status).sort(),[201,409]);
  assert.equal((await f.admin.call('/api/dashboard')).data.shifts.length,1);
});

test('reports split overnight shifts and overnight breaks in Qyzylorda timezone', async (t) => {
  const f = await fixture(t);
  const start = Date.parse('2026-10-13T23:00:00+05:00');
  const result = await f.admin.call('/api/shifts','POST',{userId:f.adminUser.id,startedAt:start,endedAt:start+3*HOUR,
    breaks:[{startedAt:start+0.5*HOUR,endedAt:start+1.5*HOUR}],note:'Ночная смена'});
  assert.equal(result.status,201);
  const report = (await f.admin.call('/api/reports?from=2026-10-13&to=2026-10-14')).data;
  assert.deepEqual(report.days,[{date:'2026-10-13',workMs:0.5*HOUR,breakMs:0.5*HOUR},{date:'2026-10-14',workMs:1.5*HOUR,breakMs:0.5*HOUR}]);
  assert.equal(report.totals.workMs,2*HOUR); assert.equal(report.totals.averageMs,2*HOUR);
  assert.equal((await f.admin.call('/api/reports?from=2026-02-30&to=2026-03-01')).status,400);
  assert.equal((await f.admin.call('/api/reports?from=2024-01-01&to=2026-01-01')).status,400);
});

test('CSV requires explicit export right and escapes spreadsheet formulas', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  assert.equal((await e.call('/api/export')).status,403);
  await f.admin.call('/api/users/'+e.user.id,'PATCH',{name:'=HYPERLINK("bad")',permissions:['export_reports']});
  const result = await e.call('/api/export?from=2026-10-15&to=2026-10-15');
  assert.equal(result.status,200); assert.match(result.data,/'=HYPERLINK/);
  assert.match(result.headers.get('content-type'),/text\/csv/);
});

test('password change revokes every session, logout revokes current session and expiry is enforced', async (t) => {
  const f = await fixture(t); const e = await f.employee(); const second = f.client();
  await second.call('/api/login','POST',{username:'employee',password:PASSWORD});
  assert.equal((await e.call('/api/change-password','POST',{currentPassword:'wrong',newPassword:'Updated-password!'})).status,403);
  assert.equal((await e.call('/api/change-password','POST',{currentPassword:PASSWORD,newPassword:'Updated-password!'})).status,200);
  assert.equal((await second.call('/api/dashboard')).status,401);
  await second.call('/api/login','POST',{username:'employee',password:'Updated-password!'});
  assert.equal((await second.call('/api/logout','POST',{})).status,200);
  assert.equal((await second.call('/api/dashboard')).status,401);
  f.setNow(f.now+12*HOUR+1); assert.equal((await f.admin.call('/api/dashboard')).status,401);
});

test('archive preserves shifts and audit contains changes without credentials', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  await f.admin.call('/api/shifts','POST',{userId:e.user.id,startedAt:f.now-2*HOUR,endedAt:f.now-HOUR,breaks:[],note:'Архив'});
  await f.admin.call('/api/users/'+e.user.id,'DELETE');
  assert.equal((await f.admin.call('/api/dashboard?userId='+e.user.id)).data.shifts.length,1);
  const result = await f.admin.call('/api/audit'); assert.equal(result.status,200);
  assert.ok(result.data.entries.some((e)=>e.action==='user_archived'));
  const encoded = JSON.stringify(result.data); assert.ok(!encoded.includes(PASSWORD)); assert.ok(!encoded.includes('scrypt$')); assert.ok(!encoded.includes(f.admin.csrf));
});

test('invalid values and oversized JSON fail before database writes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.admin.call('/api/users','POST',{username:'test',name:'Test',password:'short'})).status,400);
  assert.equal((await f.admin.call('/api/users','POST',{username:'test',name:'Test',password:PASSWORD,permissions:['admin']})).status,400);
  assert.equal((await f.admin.call('/api/profile','PATCH',{name:'x'.repeat(103000)})).status,413);
  assert.equal((await f.admin.call('/api/users','POST',{username:'ADILIUM',name:'Test',password:PASSWORD})).status,409);
});

test('in-flight old-password login cannot create a session after an administrator reset', async (t) => {
  const f = await fixture(t); const e = await f.employee(); const c = f.client();
  const gate = pauseFirstRead(f.db,(sql) => sql.includes('WHERE lower(username) = lower(?)'));
  t.after(gate.restore);
  const pending = c.call('/api/login','POST',{username:'employee',password:PASSWORD});
  await gate.reached;
  assert.equal((await f.admin.call('/api/users/'+e.user.id,'PATCH',{password:'Replacement-password-2!'})).status,200);
  gate.release();
  assert.equal((await pending).status,401);
  assert.equal((await c.call('/api/dashboard')).status,401);
  assert.equal((await c.call('/api/login','POST',{username:'employee',password:'Replacement-password-2!'})).status,200);
});

test('stale profile PATCH cannot restore old passwords, names or active status', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const gate = pauseFirstRead(f.db,(sql,row) => sql === 'SELECT * FROM users WHERE id = ?' && row?.id === e.user.id);
  t.after(gate.restore);
  const pending = f.admin.call('/api/users/'+e.user.id,'PATCH',{position:'Обновлённая должность'});
  await gate.reached;
  assert.equal((await f.admin.call('/api/users/'+e.user.id,'PATCH',{password:'Replacement-password-2!',name:'Исправленное имя',active:false})).status,200);
  gate.release();
  const edited = await pending; assert.equal(edited.status,200); assert.equal(edited.data.user.active,false); assert.equal(edited.data.user.name,'Исправленное имя');
  assert.equal(edited.data.user.position,'Обновлённая должность');
  await f.admin.call('/api/users/'+e.user.id,'PATCH',{active:true});
  const c = f.client(); assert.equal((await c.call('/api/login','POST',{username:'employee',password:PASSWORD})).status,401);
  assert.equal((await c.call('/api/login','POST',{username:'employee',password:'Replacement-password-2!'})).status,200);
});

test('stale password change cannot overwrite an admin reset or revoke the replacement session', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const gate = pauseFirstRead(f.db,(sql,row) => sql.startsWith('SELECT s.token_hash') && row?.id === e.user.id);
  t.after(gate.restore);
  const pending = e.call('/api/change-password','POST',{currentPassword:PASSWORD,newPassword:'Employee-replacement-1!'});
  await gate.reached;
  await f.admin.call('/api/users/'+e.user.id,'PATCH',{password:'Admin-replacement-2!'});
  const replacement = f.client(); assert.equal((await replacement.call('/api/login','POST',{username:'employee',password:'Admin-replacement-2!'})).status,200);
  gate.release();
  assert.equal((await pending).status,409);
  assert.equal((await replacement.call('/api/dashboard')).status,200);
});
