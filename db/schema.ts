import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), username: text('username').notNull(), name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(), position: text('position').notNull().default(''),
  department: text('department').notNull().default(''), role: text('role').notNull().default('employee'),
  active: integer('active').notNull().default(1), archived: integer('archived').notNull().default(0),
  master: integer('master').notNull().default(0), createdAt: integer('created_at').notNull(),
}, (t) => [uniqueIndex('users_username_unique').on(sql`lower(${t.username})`),
  check('users_role_check', sql`${t.role} IN ('admin', 'employee')`),
  check('users_master_check', sql`${t.master} = 0 OR (${t.role} = 'admin' AND ${t.active} = 1 AND ${t.archived} = 0)`)]);

export const userPermissions = sqliteTable('user_permissions', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), permission: text('permission').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.permission] })]);

export const schedules = sqliteTable('schedules', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  startTime: text('start_time').notNull().default('09:00'), endTime: text('end_time').notNull().default('18:00'),
  breakMinutes: integer('break_minutes').notNull().default(60), weekdays: text('weekdays').notNull().default('[1,2,3,4,5]'),
  timezone: text('timezone').notNull().default('Asia/Qyzylorda'),
});

export const shifts = sqliteTable('shifts', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  startedAt: integer('started_at').notNull(), endedAt: integer('ended_at'), note: text('note').notNull().default(''),
  version: integer('version').notNull().default(1), revisionToken: text('revision_token').notNull(),
}, (t) => [index('shifts_user_start').on(t.userId, t.startedAt),
  uniqueIndex('shifts_one_active').on(t.userId).where(sql`${t.endedAt} IS NULL`),
  check('shifts_time_check', sql`${t.endedAt} IS NULL OR ${t.endedAt} > ${t.startedAt}`)]);

export const breaks = sqliteTable('breaks', {
  id: text('id').primaryKey(), shiftId: text('shift_id').notNull().references(() => shifts.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at').notNull(), endedAt: integer('ended_at'),
}, (t) => [index('breaks_shift_start').on(t.shiftId, t.startedAt),
  uniqueIndex('breaks_one_active').on(t.shiftId).where(sql`${t.endedAt} IS NULL`),
  check('breaks_time_check', sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`)]);

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  csrfToken: text('csrf_token').notNull(), expiresAt: integer('expires_at').notNull(), createdAt: integer('created_at').notNull(),
}, (t) => [index('sessions_user').on(t.userId)]);

export const loginAttempts = sqliteTable('login_attempts', {
  id: text('id').primaryKey(), bucket: text('bucket').notNull(), attemptedAt: integer('attempted_at').notNull(),
}, (t) => [index('login_attempts_bucket_time').on(t.bucket, t.attemptedAt)]);

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(), actorId: text('actor_id').references(() => users.id), actorName: text('actor_name').notNull(),
  action: text('action').notNull(), targetType: text('target_type').notNull(), targetId: text('target_id').notNull(),
  details: text('details').notNull().default('{}'), createdAt: integer('created_at').notNull(),
}, (t) => [index('audit_log_time').on(t.createdAt)]);

export const absences = sqliteTable('absences', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  startDate: text('start_date').notNull(), endDate: text('end_date').notNull(), type: text('type').notNull(),
  note: text('note').notNull().default(''), createdAt: integer('created_at').notNull(), version: integer('version').notNull().default(1),
}, (t) => [index('absences_user_dates').on(t.userId, t.startDate, t.endDate),
  check('absences_type_check', sql`${t.type} IN ('vacation', 'day_off', 'other')`),
  check('absences_date_check', sql`${t.endDate} >= ${t.startDate}`)]);

export const absenceRequests = sqliteTable('absence_requests', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  startDate: text('start_date').notNull(), endDate: text('end_date').notNull(), type: text('type').notNull(),
  note: text('note').notNull().default(''), status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(), decidedAt: integer('decided_at'),
  decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decisionNote: text('decision_note').notNull().default(''),
  absenceId: text('absence_id').references(() => absences.id, { onDelete: 'set null' }),
  version: integer('version').notNull().default(1),
}, (t) => [index('absence_requests_user_status_dates').on(t.userId, t.status, t.startDate, t.endDate),
  index('absence_requests_status_created').on(t.status, t.createdAt),
  check('absence_requests_type_check', sql`${t.type} IN ('vacation', 'day_off')`),
  check('absence_requests_status_check', sql`${t.status} IN ('pending', 'approved', 'rejected', 'cancelled')`),
  check('absence_requests_date_check', sql`${t.endDate} >= ${t.startDate}`)]);
