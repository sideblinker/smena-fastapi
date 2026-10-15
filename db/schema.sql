PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL,
 position TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'employee',
 active INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, master INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 CONSTRAINT users_role_check CHECK(role IN ('admin','employee')),
 CONSTRAINT users_master_check CHECK(master = 0 OR (role = 'admin' AND active = 1 AND archived = 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(lower(username));
CREATE TABLE IF NOT EXISTS user_permissions (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, permission TEXT NOT NULL, PRIMARY KEY(user_id,permission)
);
CREATE TABLE IF NOT EXISTS schedules (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 start_time TEXT NOT NULL DEFAULT '09:00', end_time TEXT NOT NULL DEFAULT '18:00',
 break_minutes INTEGER NOT NULL DEFAULT 60, weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]', timezone TEXT NOT NULL DEFAULT 'Asia/Qyzylorda'
);
CREATE TABLE IF NOT EXISTS shifts (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), started_at INTEGER NOT NULL, ended_at INTEGER,
 note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, revision_token TEXT NOT NULL,
 CONSTRAINT shifts_time_check CHECK(ended_at IS NULL OR ended_at > started_at)
);
CREATE INDEX IF NOT EXISTS shifts_user_start ON shifts(user_id,started_at);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_active ON shifts(user_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS breaks (
 id TEXT PRIMARY KEY NOT NULL, shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
 started_at INTEGER NOT NULL, ended_at INTEGER,
 CONSTRAINT breaks_time_check CHECK(ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS breaks_shift_start ON breaks(shift_id,started_at);
CREATE UNIQUE INDEX IF NOT EXISTS breaks_one_active ON breaks(shift_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_attempts (id TEXT PRIMARY KEY NOT NULL, bucket TEXT NOT NULL, attempted_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_bucket_time ON login_attempts(bucket,attempted_at);
CREATE TABLE IF NOT EXISTS audit_log (
 id TEXT PRIMARY KEY NOT NULL, actor_id TEXT REFERENCES users(id), actor_name TEXT NOT NULL,
 action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(created_at);
