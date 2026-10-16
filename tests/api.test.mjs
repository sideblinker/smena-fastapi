import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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

test('an employee without optional permissions can edit own shift times and breaks but cannot add or delete shifts', async (t) => {
  const f = await fixture(t); const employee = await f.employee('baseline', []);
  const start = f.now - 10*HOUR;
  const added = await f.admin.call('/api/shifts','POST',{
    userId:employee.user.id,startedAt:start,endedAt:start+4*HOUR,
    breaks:[{startedAt:start+HOUR,endedAt:start+1.5*HOUR}],note:'Исходная смена',
  });
  assert.equal(added.status,201);
  const id = added.data.shift.id;
  const changes = {
    version:added.data.shift.version,startedAt:start-0.5*HOUR,endedAt:start+4.5*HOUR,
    breaks:[{startedAt:start+HOUR,endedAt:start+1.25*HOUR},{startedAt:start+3*HOUR,endedAt:start+3.5*HOUR}],
    note:'Исправлено сотрудником',reason:'Уточнение отметок рабочего дня',
  };
  const edited = await employee.call('/api/shifts/'+id,'PATCH',changes);
  assert.equal(edited.status,200,JSON.stringify(edited.data));
  assert.equal(edited.data.shift.userId,employee.user.id);
  assert.equal(edited.data.shift.startedAt,changes.startedAt);
  assert.equal(edited.data.shift.endedAt,changes.endedAt);
  assert.deepEqual(edited.data.shift.breaks,changes.breaks);
  assert.equal(edited.data.shift.note,changes.note);
  assert.equal(edited.data.shift.version,changes.version+1);
  const dashboard = await employee.call('/api/dashboard');
  assert.deepEqual(dashboard.data.user.permissions,[]);
  assert.deepEqual(dashboard.data.shifts,[edited.data.shift]);
  assert.equal((await employee.call('/api/shifts','POST',{
    userId:employee.user.id,startedAt:start+5*HOUR,endedAt:start+6*HOUR,breaks:[],
  })).status,403);
  assert.equal((await employee.call('/api/shifts/'+id,'DELETE',{version:edited.data.shift.version})).status,403);
  assert.deepEqual((await employee.call('/api/dashboard')).data.shifts,[edited.data.shift]);
  assert.equal((await f.client().call('/api/shifts/'+id,'PATCH',{version:edited.data.shift.version,note:'Anonymous'})).status,401);
  await f.admin.call('/api/users/'+employee.user.id,'PATCH',{active:false});
  assert.equal((await employee.call('/api/shifts/'+id,'PATCH',{version:edited.data.shift.version,note:'Disabled'})).status,401);
});

test('shift editing always uses stored ownership, rejects owner tampering and allows admin edits across employees', async (t) => {
  const f = await fixture(t);
  const alice = await f.employee('alice', []);
  const boris = await f.employee('boris', ['edit_own_shifts']);
  const shifts = new Map();
  for (const user of [alice.user,boris.user,f.adminUser]) {
    const added = await f.admin.call('/api/shifts','POST',{
      userId:user.id,startedAt:f.now-4*HOUR,endedAt:f.now-HOUR,breaks:[],note:'Original',
    });
    assert.equal(added.status,201);
    shifts.set(user.id,added.data.shift);
  }
  for (const [employee,foreignUser] of [[alice,boris.user],[boris,alice.user]]) {
    const own = shifts.get(employee.user.id);
    for (const target of [shifts.get(foreignUser.id),shifts.get(f.adminUser.id)]) {
      assert.equal((await employee.call('/api/shifts/'+target.id,'PATCH',{version:target.version,note:'Foreign change'})).status,403);
      assert.equal((await employee.call('/api/shifts/'+target.id,'PATCH',{version:target.version,userId:employee.user.id,note:'Forged owner'})).status,403);
      assert.equal((await employee.call('/api/shifts/'+target.id+'?userId='+employee.user.id,'PATCH',{version:target.version,note:'Forged query owner'})).status,403);
    }
    for (const forgedOwner of [{userId:foreignUser.id},{user_id:foreignUser.id},{ownerId:foreignUser.id}]) {
      assert.equal((await employee.call('/api/shifts/'+own.id,'PATCH',{version:own.version,...forgedOwner,note:'Transfer'})).status,400);
    }
    const unchanged = (await f.admin.call('/api/dashboard?userId='+employee.user.id)).data.shifts[0];
    assert.deepEqual(unchanged,own);
  }
  assert.deepEqual((await f.admin.call('/api/dashboard')).data.shifts,[shifts.get(f.adminUser.id)]);
  for (const employee of [alice,boris]) {
    const own = shifts.get(employee.user.id);
    const changes = {version:own.version,startedAt:f.now-5*HOUR,endedAt:f.now-0.5*HOUR,
      breaks:[{startedAt:f.now-3*HOUR,endedAt:f.now-2*HOUR}],note:'Admin edit',reason:'Уточнение по заявлению сотрудника'};
    const edited = await f.admin.call('/api/shifts/'+own.id,'PATCH',changes);
    assert.equal(edited.status,200,JSON.stringify(edited.data));
    assert.equal(edited.data.shift.userId,employee.user.id);
    assert.equal(edited.data.shift.startedAt,changes.startedAt);
    assert.equal(edited.data.shift.endedAt,changes.endedAt);
    assert.deepEqual(edited.data.shift.breaks,changes.breaks);
    assert.deepEqual((await employee.call('/api/dashboard')).data.shifts,[edited.data.shift]);
  }
});

test('concurrent shift edit uses compare-and-swap and does not overwrite winning breaks', async (t) => {
  const f = await fixture(t); const start = f.now-10*HOUR;
  const added = await f.admin.call('/api/shifts','POST',{userId:f.adminUser.id,startedAt:start,endedAt:start+4*HOUR,breaks:[]});
  const id = added.data.shift.id;
  const results = await Promise.all([
    f.admin.call('/api/shifts/'+id,'PATCH',{version:1,note:'A',reason:'Исправление A',breaks:[{startedAt:start+HOUR,endedAt:start+2*HOUR}]}),
    f.admin.call('/api/shifts/'+id,'PATCH',{version:1,note:'B',reason:'Исправление B',breaks:[{startedAt:start+2*HOUR,endedAt:start+3*HOUR}]}),
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

test('personal calendar is baseline access; timesheets retain report permission and ownership boundaries', async (t) => {
  const f = await fixture(t); const e = await f.employee('calendar_person', []);
  let result = await e.call('/api/calendar?month=2026-10');
  assert.equal(result.status,200,JSON.stringify(result.data)); assert.equal(result.data.month,'2026-10');
  assert.equal(result.data.days.length,31); assert.equal(result.data.days[0].date,'2026-10-01');
  assert.equal(result.data.user.id,e.user.id); assert.equal(result.data.days[0].plannedMs,0);
  assert.equal((await e.call('/api/calendar?month=2026-10&userId='+f.adminUser.id)).status,403);
  assert.equal((await e.call('/api/team-status')).status,403);
  assert.equal((await e.call('/api/timesheet?month=2026-10')).status,403);
  for (const month of ['2026-13','2026-00','2026-1','2026-10-01','not-a-month'])
    assert.equal((await e.call('/api/calendar?month='+month)).status,400);
  assert.equal((await f.client().call('/api/calendar?month=2026-10')).status,401);
  await f.admin.call('/api/users/'+e.user.id,'PATCH',{permissions:['view_reports']});
  result = await e.call('/api/timesheet?month=2026-10');
  assert.equal(result.status,200); assert.equal(result.data.days.length,31); assert.equal(result.data.rows.length,1);
  assert.equal(result.data.rows[0].user.id,e.user.id);
  assert.equal((await e.call('/api/timesheet?month=2026-10&userId=all')).status,403);
  assert.equal((await e.call('/api/timesheet?month=2026-10&userId='+f.adminUser.id)).status,403);
});

test('absence CRUD is admin-only, validates real dates, rejects overlaps atomically and preserves actual time', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  await f.db.prepare('UPDATE users SET created_at=? WHERE id=?').bind(Date.parse('2026-10-01T00:00:00+05:00'),e.user.id).run();
  const absence = {userId:e.user.id,startDate:'2026-10-15',endDate:'2026-10-16',type:'vacation',note:'Отпуск'};
  assert.equal((await e.call('/api/absences','POST',absence)).status,403);
  assert.equal((await f.admin.call('/api/absences','POST',absence,{'X-CSRF-Token':''})).status,403);
  for (const override of [{startDate:'2026-02-30'}, {endDate:'2026-10-14'}, {endDate:'2028-10-16'}, {type:'sick'}, {userId:'bad'}])
    assert.equal((await f.admin.call('/api/absences','POST',{...absence,...override})).status,400);
  const concurrent = await Promise.all([f.admin.call('/api/absences','POST',absence), f.admin.call('/api/absences','POST',absence)]);
  assert.deepEqual(concurrent.map((r)=>r.status).sort(),[201,409]);
  const saved = concurrent.find((r)=>r.status===201).data.absence;
  assert.equal(saved.version,1); assert.equal(saved.userId,e.user.id);
  assert.equal((await f.admin.call('/api/absences','POST',{...absence,startDate:'2026-10-16',endDate:'2026-10-17'})).status,409);
  assert.equal((await f.admin.call('/api/absences','POST',{...absence,startDate:'2026-10-17',endDate:'2026-10-17'})).status,201);
  const start = Date.parse('2026-10-15T09:30:00+05:00');
  assert.equal((await f.admin.call('/api/shifts','POST',{userId:e.user.id,startedAt:start,endedAt:start+2*HOUR,breaks:[]})).status,201);
  const calendar = (await e.call('/api/calendar?month=2026-10')).data;
  const day = calendar.days.find((d)=>d.date==='2026-10-15');
  assert.equal(day.kind,'absence'); assert.equal(day.plannedMs,0); assert.equal(day.workMs,2*HOUR); assert.equal(calendar.absences.length,2);
  const actualOnAbsence = (await f.admin.call('/api/team-status')).data.members.find((m)=>m.user.id===e.user.id);
  assert.equal(actualOnAbsence.status,'finished'); assert.equal(actualOnAbsence.day.kind,'absence');
  assert.equal((await e.call('/api/absences?from=2026-10-01&to=2026-10-31')).data.absences.length,2);
  assert.equal((await e.call('/api/absences?userId='+f.adminUser.id)).status,403);
  assert.equal((await e.call('/api/absences/'+saved.id,'DELETE',{version:1})).status,403);
  assert.equal((await f.admin.call('/api/absences/'+saved.id,'DELETE',{version:2})).status,409);
  assert.equal((await f.admin.call('/api/absences/'+saved.id,'DELETE',{version:1})).status,200);
  const restored = (await e.call('/api/calendar?month=2026-10')).data.days.find((d)=>d.date==='2026-10-15');
  assert.equal(restored.kind,'workday'); assert.equal(restored.plannedMs,8*HOUR); assert.equal(restored.workMs,2*HOUR);
  const audit = (await f.admin.call('/api/audit')).data.entries;
  assert.equal(audit.filter((a)=>a.targetId===saved.id && a.action==='absence_created').length,1);
  assert.equal(audit.filter((a)=>a.targetId===saved.id && a.action==='absence_deleted').length,1);
});

test('team live status prioritizes a prior-month active shift over today absence and excludes inactive users', async (t) => {
  const f = await fixture(t); const night = await f.employee('night'); const off = await f.employee('off');
  await f.admin.call('/api/absences','POST',{userId:night.user.id,startDate:'2026-10-15',endDate:'2026-10-15',type:'day_off'});
  const start = Date.parse('2026-09-30T23:00:00+05:00');
  const added = await f.admin.call('/api/shifts','POST',{userId:night.user.id,startedAt:start,endedAt:null,breaks:[{startedAt:f.now-HOUR,endedAt:null}]});
  assert.equal(added.status,201); const id = added.data.shift.id;
  await f.admin.call('/api/schedules/'+off.user.id,'PUT',{startTime:'09:00',endTime:'18:00',breakMinutes:60,weekdays:[],timezone:'Asia/Qyzylorda'});
  let team = (await f.admin.call('/api/team-status')).data.members;
  let member = team.find((m)=>m.user.id===night.user.id);
  assert.equal(member.status,'break'); assert.equal(member.day.kind,'absence'); assert.equal(member.activeShift.id,id);
  assert.equal(team.find((m)=>m.user.id===off.user.id).status,'day_off');
  assert.equal(team.find((m)=>m.user.id===f.adminUser.id).status,'not_started');
  await f.admin.call('/api/shifts','POST',{userId:off.user.id,startedAt:f.now-2*HOUR,endedAt:f.now-HOUR,breaks:[]});
  const actualOnDayOff = (await f.admin.call('/api/team-status')).data.members.find((m)=>m.user.id===off.user.id);
  assert.equal(actualOnDayOff.status,'finished'); assert.equal(actualOnDayOff.day.kind,'day_off');
  await night.call('/api/shifts/'+id+'/resume','POST',{});
  team = (await f.admin.call('/api/team-status')).data.members;
  assert.equal(team.find((m)=>m.user.id===night.user.id).status,'working');
  await night.call('/api/shifts/'+id+'/finish','POST',{});
  team = (await f.admin.call('/api/team-status')).data.members;
  assert.equal(team.find((m)=>m.user.id===night.user.id).status,'absence');
  await f.admin.call('/api/users/'+off.user.id,'PATCH',{active:false});
  team = (await f.admin.call('/api/team-status')).data.members;
  assert.equal(team.some((m)=>m.user.id===off.user.id),false);
});

test('month timesheet attributes a night shift wholly to its start day and includes archived factual rows', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  await f.db.prepare('UPDATE users SET created_at=? WHERE id=?').bind(Date.parse('2026-09-01T00:00:00+05:00'),e.user.id).run();
  const start = Date.parse('2026-09-30T23:00:00+05:00');
  await f.admin.call('/api/shifts','POST',{userId:e.user.id,startedAt:start,endedAt:start+4*HOUR,breaks:[{startedAt:start+HOUR,endedAt:start+1.5*HOUR}]});
  await f.admin.call('/api/users/'+e.user.id,'DELETE');
  const september = await f.admin.call('/api/timesheet?month=2026-09&userId=all');
  assert.equal(september.status,200); assert.equal(september.data.days.length,30);
  const row = september.data.rows.find((r)=>r.user.id===e.user.id);
  assert.ok(row); assert.equal(row.user.archived,true); assert.equal(row.workMs,3.5*HOUR); assert.equal(row.breakMs,0.5*HOUR);
  assert.equal(row.days.find((d)=>d.date==='2026-09-30').workMs,3.5*HOUR);
  const october = (await f.admin.call('/api/timesheet?month=2026-10&userId=all')).data;
  assert.equal(october.rows.some((r)=>r.user.id===e.user.id),false);
  const ownOctober = (await f.admin.call('/api/calendar?month=2026-10&userId='+e.user.id)).data;
  assert.equal(ownOctober.shifts.length,0); assert.equal(ownOctober.days.reduce((sum,d)=>sum+d.workMs,0),0);
});

test('shift edits require meaningful reasons and write exact before/after without changing legacy audit entries', async (t) => {
  const f = await fixture(t); const e = await f.employee('editor',[]);
  const original = (await f.admin.call('/api/shifts','POST',{userId:e.user.id,startedAt:f.now-4*HOUR,endedAt:f.now-HOUR,breaks:[],note:'Исходная смена'})).data.shift;
  for (const reason of [undefined,'','  ','ab','x'.repeat(501)])
    assert.equal((await e.call('/api/shifts/'+original.id,'PATCH',{version:1,note:'Исправлено',reason})).status,400);
  assert.equal((await e.call('/api/dashboard')).data.shifts[0].version,1);
  const edits = {version:1,note:'Исправлено',startedAt:f.now-3.5*HOUR,breaks:[{startedAt:f.now-3*HOUR,endedAt:f.now-2.5*HOUR}],reason:'  Забыл отметить перерыв  '};
  const changed = await e.call('/api/shifts/'+original.id,'PATCH',edits); assert.equal(changed.status,200);
  const entries = (await f.admin.call('/api/audit')).data.entries;
  const update = entries.find((entry)=>entry.targetId===original.id && entry.action==='shift_updated');
  assert.equal(update.actorName,e.user.name); assert.equal(update.details.reason,'Забыл отметить перерыв');
  assert.deepEqual(update.details.before,{startedAt:original.startedAt,endedAt:original.endedAt,breaks:[],note:'Исходная смена'});
  assert.deepEqual(update.details.after,{startedAt:edits.startedAt,endedAt:original.endedAt,breaks:edits.breaks,note:edits.note});
  assert.equal(entries.find((entry)=>entry.targetId===original.id && entry.action==='shift_created').details.startedAt,original.startedAt);
});

test('persisted version-one SQLite upgrades additively and preserves users, shifts, sessions and historical audit', async (t) => {
  const directory = mkdtempSync(join(tmpdir(),'smena-v1-upgrade-')); const file = join(directory,'version-one.sqlite');
  t.after(() => {
    const target = resolve(directory); const allowed = resolve(tmpdir())+sep;
    assert.ok(target.startsWith(allowed) && target.includes('smena-v1-upgrade-'));
    rmSync(target,{recursive:true,force:true});
  });
  const before = createSqliteDatabase(file,{initialize:false});
  before.executeScript(readFileSync(new URL('../drizzle/0000_ordinary_mephistopheles.sql',import.meta.url),'utf8'));
  before.executeScript('PRAGMA user_version=1');
  const created = Date.parse('2026-10-01T00:00:00Z');
  await before.prepare('INSERT INTO users (id,username,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .bind('legacy-user','legacy','Старый сотрудник','unchanged-hash','employee',created).run();
  await before.prepare('INSERT INTO shifts (id,user_id,started_at,ended_at,note,version,revision_token) VALUES (?,?,?,?,?,?,?)')
    .bind('legacy-shift','legacy-user',created,created+HOUR,'Не потерять',3,'old-revision').run();
  await before.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES (?,?,?,?,?)')
    .bind('old-token-hash','legacy-user','old-csrf',created+12*HOUR,created).run();
  await before.prepare('INSERT INTO audit_log (id,actor_id,actor_name,action,target_type,target_id,details,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('legacy-audit','legacy-user','Старый сотрудник','shift_updated','shift','legacy-shift','{"legacy":true}',created).run();
  before.close();
  let upgraded = createSqliteDatabase(file);
  assert.equal((await upgraded.prepare('PRAGMA user_version').first()).user_version,3);
  assert.equal((await upgraded.prepare('SELECT password_hash FROM users').first()).password_hash,'unchanged-hash');
  assert.equal((await upgraded.prepare('SELECT version,note FROM shifts').first()).version,3);
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS count FROM sessions').first()).count,1);
  assert.equal((await upgraded.prepare('SELECT details FROM audit_log').first()).details,'{"legacy":true}');
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS count FROM absences').first()).count,0);
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS count FROM absence_requests').first()).count,0);
  upgraded.close(); upgraded=createSqliteDatabase(file);
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS count FROM users').first()).count,1);
  upgraded.close();
});

test('absence requests are available to each employee but list and counts never expose other employees', async (t) => {
  const f = await fixture(t); const a = await f.employee('request_alice',[]); const b = await f.employee('request_boris',[]);
  const body = {startDate:'2026-10-20',endDate:'2026-10-21',type:'vacation',note:'Семейные планы'};
  assert.equal((await f.client().call('/api/absence-requests')).status,401);
  assert.equal((await a.call('/api/absence-requests','POST',body,{'X-CSRF-Token':''})).status,403);
  assert.equal((await a.call('/api/absence-requests','POST',body,{Origin:'https://foreign.example'})).status,403);
  const made = await a.call('/api/absence-requests','POST',body); assert.equal(made.status,201,JSON.stringify(made.data));
  const own = made.data.request;
  assert.equal(own.userId,a.user.id); assert.equal(own.user.name,a.user.name); assert.equal(own.status,'pending');
  assert.equal(own.version,1); assert.equal(own.decidedAt,null); assert.equal(own.decidedBy,null); assert.equal(own.absenceId,null);
  assert.deepEqual(Object.keys(own.user).sort(),['department','id','name','position']);
  assert.equal((await b.call('/api/absence-requests')).data.requests.length,0);
  assert.equal((await b.call('/api/absence-requests','POST',body)).status,201);
  let listed = (await a.call('/api/absence-requests?userId='+b.user.id)).data;
  assert.deepEqual(listed.requests.map((r)=>r.userId),[a.user.id]); assert.deepEqual(listed.counts,{pending:1,approved:0,rejected:0,cancelled:0});
  listed = (await f.admin.call('/api/absence-requests')).data;
  assert.equal(listed.requests.length,2); assert.equal(listed.counts.pending,2);
  assert.equal((await a.call('/api/absence-requests?status=unknown')).status,400);
  assert.equal((await b.call('/api/absence-requests/'+own.id+'/cancel','POST',{version:1})).status,403);
  assert.equal((await f.admin.call('/api/absence-requests/'+own.id+'/cancel','POST',{version:1})).status,403);
  assert.equal((await a.call('/api/absence-requests/'+own.id,'PATCH',{version:1,status:'approved'})).status,403);
});

test('request submission validates fields and dates and atomically prevents pending or absence overlap', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const body = {startDate:'2026-10-20',endDate:'2026-10-22',type:'day_off',note:''};
  for (const invalid of [{startDate:'2026-02-30'}, {endDate:'2026-10-19'}, {endDate:'2028-01-01'}, {type:'other'},
    {note:'a'.repeat(2001)}, {status:'approved'}, {userId:f.adminUser.id}, {version:1}])
    assert.equal((await e.call('/api/absence-requests','POST',{...body,...invalid})).status,400);
  const simultaneous = await Promise.all([e.call('/api/absence-requests','POST',body),e.call('/api/absence-requests','POST',body)]);
  assert.deepEqual(simultaneous.map((r)=>r.status).sort(),[201,409]);
  const id = simultaneous.find((r)=>r.status===201).data.request.id;
  assert.equal((await e.call('/api/absence-requests','POST',{...body,startDate:'2026-10-22',endDate:'2026-10-23'})).status,409);
  assert.equal((await e.call('/api/absence-requests','POST',{...body,startDate:'2026-10-23',endDate:'2026-10-23'})).status,201);
  await f.admin.call('/api/absences','POST',{userId:e.user.id,startDate:'2026-10-25',endDate:'2026-10-26',type:'vacation'});
  assert.equal((await e.call('/api/absence-requests','POST',{...body,startDate:'2026-10-26',endDate:'2026-10-27'})).status,409);
  const audit = (await f.admin.call('/api/audit')).data.entries;
  assert.equal(audit.filter((a)=>a.targetId===id && a.action==='absence_request_created').length,1);
});

test('approval creates exactly one absence reflected in calendar and timesheet and preserves approval history after absence deletion', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const made = await e.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-21',type:'vacation',note:'Моя заявка'});
  const id = made.data.request.id;
  const reviewed = await f.admin.call('/api/absence-requests/'+id,'PATCH',{version:1,status:'approved',decisionNote:'  Согласовано  '});
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.data));
  const approved = reviewed.data.request;
  assert.equal(approved.status,'approved'); assert.equal(approved.version,2); assert.equal(approved.decisionNote,'Согласовано');
  assert.deepEqual(approved.decidedBy,{id:f.adminUser.id,name:f.adminUser.name}); assert.equal(approved.decidedAt,f.now); assert.ok(approved.absenceId);
  const calendar = (await e.call('/api/calendar?month=2026-10')).data;
  assert.equal(calendar.absences.length,1); assert.equal(calendar.absences[0].id,approved.absenceId);
  assert.equal(calendar.days.find((d)=>d.date==='2026-10-20').kind,'absence');
  const sheet = (await e.call('/api/timesheet?month=2026-10')).data;
  assert.equal(sheet.rows[0].days.find((d)=>d.date==='2026-10-20').plannedMs,0);
  assert.equal((await f.admin.call('/api/absence-requests/'+id,'PATCH',{version:1,status:'approved'})).status,409);
  assert.equal((await f.admin.call('/api/absence-requests/'+id,'PATCH',{version:2,status:'rejected',decisionNote:'Повторное решение'})).status,409);
  assert.equal((await e.call('/api/absence-requests/'+id+'/cancel','POST',{version:2})).status,409);
  await f.admin.call('/api/absences/'+approved.absenceId,'DELETE',{version:1});
  const history = (await e.call('/api/absence-requests')).data;
  assert.equal(history.requests[0].status,'approved'); assert.equal(history.requests[0].absenceId,null); assert.equal(history.counts.approved,1);
  assert.equal((await e.call('/api/calendar?month=2026-10')).data.absences.length,0);
});

test('rejection requires a reason, cancellation is pending-owner-only, and filtered counts retain all own statuses', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const made = (await e.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-20',type:'day_off'})).data.request;
  for (const decisionNote of [undefined,'','  ','ab','x'.repeat(501)])
    assert.equal((await f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:1,status:'rejected',decisionNote})).status,400);
  assert.equal((await f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:2,status:'rejected',decisionNote:'Недостаточно сотрудников'})).status,409);
  assert.equal((await f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:1,status:'cancelled'})).status,400);
  const rejected = await f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:1,status:'rejected',decisionNote:'  Недостаточно сотрудников  '});
  assert.equal(rejected.status,200); assert.equal(rejected.data.request.decisionNote,'Недостаточно сотрудников'); assert.equal(rejected.data.request.absenceId,null);
  const second = (await e.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-20',type:'day_off'})).data.request;
  assert.equal((await e.call('/api/absence-requests/'+second.id+'/cancel','POST',{version:2})).status,409);
  assert.equal((await e.call('/api/absence-requests/'+second.id+'/cancel','POST',{version:1,userId:f.adminUser.id})).status,400);
  const cancelled = await e.call('/api/absence-requests/'+second.id+'/cancel','POST',{version:1});
  assert.equal(cancelled.status,200); assert.equal(cancelled.data.request.status,'cancelled'); assert.equal(cancelled.data.request.decidedBy.id,e.user.id);
  assert.equal((await e.call('/api/absence-requests/'+second.id+'/cancel','POST',{version:1})).status,409);
  const third = (await e.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-20',type:'day_off'})).data.request;
  const filtered = (await e.call('/api/absence-requests?status=pending')).data;
  assert.deepEqual(filtered.requests.map((r)=>r.id),[third.id]); assert.deepEqual(filtered.counts,{pending:1,approved:0,rejected:1,cancelled:1});
  const adminOwn = (await f.admin.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-20',type:'day_off'})).data.request;
  assert.equal((await f.admin.call('/api/absence-requests/'+adminOwn.id+'/cancel','POST',{version:1})).status,200);
  assert.equal((await e.call('/api/calendar?month=2026-10')).data.absences.length,0);
});

test('double approval and approval versus cancellation are atomic and create no duplicate absence or audit', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const firstRequest = (await e.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-20',type:'vacation'})).data.request;
  const double = await Promise.all([
    f.admin.call('/api/absence-requests/'+firstRequest.id,'PATCH',{version:1,status:'approved'}),
    f.admin.call('/api/absence-requests/'+firstRequest.id,'PATCH',{version:1,status:'approved'}),
  ]);
  assert.deepEqual(double.map((r)=>r.status).sort(),[200,409]);
  assert.equal((await e.call('/api/calendar?month=2026-10')).data.absences.length,1);
  let audit = (await f.admin.call('/api/audit')).data.entries;
  assert.equal(audit.filter((a)=>a.targetId===firstRequest.id && a.action==='absence_request_approved').length,1);
  const next = (await e.call('/api/absence-requests','POST',{startDate:'2026-10-22',endDate:'2026-10-22',type:'day_off'})).data.request;
  const race = await Promise.all([
    f.admin.call('/api/absence-requests/'+next.id,'PATCH',{version:1,status:'approved'}),
    e.call('/api/absence-requests/'+next.id+'/cancel','POST',{version:1}),
  ]);
  assert.deepEqual(race.map((r)=>r.status).sort(),[200,409]);
  const final = (await e.call('/api/absence-requests')).data.requests.find((r)=>r.id===next.id);
  assert.ok(['approved','cancelled'].includes(final.status));
  assert.equal((await e.call('/api/calendar?month=2026-10')).data.absences.length,final.status==='approved'?2:1);
  audit = (await f.admin.call('/api/audit')).data.entries;
  assert.equal(audit.filter((a)=>a.targetId===next.id && ['absence_request_approved','absence_request_cancelled'].includes(a.action)).length,1);
});

test('approval overlap and disabled-user guards leave pending requests unchanged without orphan absences', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const made = (await e.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-22',type:'vacation'})).data.request;
  const absence = (await f.admin.call('/api/absences','POST',{userId:e.user.id,startDate:'2026-10-22',endDate:'2026-10-23',type:'other'})).data.absence;
  assert.equal((await f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:1,status:'approved'})).status,409);
  let pending = (await f.admin.call('/api/absence-requests')).data.requests.find((r)=>r.id===made.id);
  assert.equal(pending.status,'pending'); assert.equal(pending.version,1); assert.equal(pending.absenceId,null);
  assert.equal((await e.call('/api/calendar?month=2026-10')).data.absences.length,1);
  assert.equal((await f.admin.call('/api/audit')).data.entries.filter((a)=>a.targetId===made.id && a.action==='absence_request_approved').length,0);
  await f.admin.call('/api/absences/'+absence.id,'DELETE',{version:1});
  await f.admin.call('/api/users/'+e.user.id,'PATCH',{active:false});
  assert.equal((await f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:1,status:'approved'})).status,409);
  pending = (await f.admin.call('/api/absence-requests')).data.requests.find((r)=>r.id===made.id);
  assert.equal(pending.status,'pending'); assert.equal(pending.version,1);
  assert.equal((await f.admin.call('/api/calendar?month=2026-10&userId='+e.user.id)).data.absences.length,0);
  assert.equal((await f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:1,status:'rejected',decisionNote:'Аккаунт отключён'})).status,200);
});

test('concurrent direct absence and request approval cannot create overlapping approved dates', async (t) => {
  const f = await fixture(t); const e = await f.employee();
  const made = (await e.call('/api/absence-requests','POST',{startDate:'2026-10-20',endDate:'2026-10-22',type:'vacation'})).data.request;
  const race = await Promise.all([
    f.admin.call('/api/absence-requests/'+made.id,'PATCH',{version:1,status:'approved'}),
    f.admin.call('/api/absences','POST',{userId:e.user.id,startDate:'2026-10-22',endDate:'2026-10-24',type:'day_off'}),
  ]);
  assert.equal(race.filter((r)=>r.status===409).length,1); assert.equal(race.filter((r)=>r.status===200 || r.status===201).length,1);
  const calendar = (await e.call('/api/calendar?month=2026-10')).data; assert.equal(calendar.absences.length,1);
  const final = (await e.call('/api/absence-requests')).data.requests[0];
  assert.equal(final.status,race[0].status===200?'approved':'pending');
});

test('persisted version-two SQLite preserves absences while adding requests and supports SET NULL history', async (t) => {
  const directory = mkdtempSync(join(tmpdir(),'smena-v2-upgrade-')); const file = join(directory,'version-two.sqlite');
  t.after(() => {
    const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir())+sep) && target.includes('smena-v2-upgrade-'));
    rmSync(target,{recursive:true,force:true});
  });
  const before = createSqliteDatabase(file,{initialize:false});
  for (const name of ['0000_ordinary_mephistopheles.sql','0001_nice_wendell_vaughn.sql'])
    before.executeScript(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
  before.executeScript('PRAGMA user_version=2');
  await before.prepare('INSERT INTO users (id,username,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .bind('preserved-user','preserved','Сотрудник','stored-hash','employee',1).run();
  await before.prepare('INSERT INTO absences (id,user_id,start_date,end_date,type,note,created_at,version) VALUES (?,?,?,?,?,?,?,?)')
    .bind('preserved-absence','preserved-user','2026-10-20','2026-10-21','vacation','Существующий отпуск',2,1).run();
  before.close();
  const upgraded = createSqliteDatabase(file);
  assert.equal((await upgraded.prepare('PRAGMA user_version').first()).user_version,3);
  assert.equal((await upgraded.prepare('SELECT note FROM absences').first()).note,'Существующий отпуск');
  assert.equal((await upgraded.prepare('SELECT password_hash FROM users').first()).password_hash,'stored-hash');
  assert.equal((await upgraded.prepare('SELECT COUNT(*) AS count FROM absence_requests').first()).count,0);
  await upgraded.prepare('INSERT INTO absence_requests (id,user_id,start_date,end_date,type,status,created_at,absence_id) VALUES (?,?,?,?,?,?,?,?)')
    .bind('preserved-request','preserved-user','2026-10-20','2026-10-21','vacation','approved',3,'preserved-absence').run();
  await upgraded.prepare('DELETE FROM absences WHERE id=?').bind('preserved-absence').run();
  const history = await upgraded.prepare('SELECT status,absence_id FROM absence_requests').first();
  assert.equal(history.status,'approved'); assert.equal(history.absence_id,null);
  upgraded.close();
});
