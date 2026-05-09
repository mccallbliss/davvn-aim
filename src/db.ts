import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Message, Report } from './types.js'

// DB path is env-driven so the Fly volume mount at /app/data is actually used.
// Falls back to a local file in dev.
const DB_PATH = process.env.DB_PATH || 'aim.db'

// Make sure the parent directory exists (e.g. /app/data on first boot).
try {
  mkdirSync(dirname(DB_PATH), { recursive: true })
} catch {
  // ignore — happens when path has no directory component (e.g. "aim.db")
}

const db = new Database(DB_PATH)
console.log(`[db] opened ${DB_PATH}`)

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL')

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter TEXT NOT NULL,
    reported_user TEXT NOT NULL,
    message_id TEXT,
    reason TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS screen_names (
    screen_name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(from_user, to_user);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(reported_user);

  CREATE TABLE IF NOT EXISTS guestbook (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT DEFAULT '',
    message TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_guestbook_timestamp ON guestbook(timestamp);
`)

// Prepared statements
const insertMessage = db.prepare(`
  INSERT INTO messages (id, from_user, to_user, text, timestamp)
  VALUES (?, ?, ?, ?, ?)
`)

const getHistory = db.prepare(`
  SELECT id, from_user as 'from', to_user as 'to', text, timestamp
  FROM messages
  WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
  ORDER BY timestamp ASC
  LIMIT 100
`)

const insertReport = db.prepare(`
  INSERT INTO reports (id, reporter, reported_user, message_id, reason, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`)

const getReportCount = db.prepare(`
  SELECT COUNT(*) as count FROM reports WHERE reported_user = ?
`)

const upsertScreenName = db.prepare(`
  INSERT INTO screen_names (screen_name, created_at, last_seen)
  VALUES (?, ?, ?)
  ON CONFLICT(screen_name) DO UPDATE SET last_seen = ?
`)

export function saveMessage(from: string, to: string, text: string): Message {
  const msg: Message = {
    id: uuid(),
    from,
    to,
    text,
    timestamp: Date.now(),
  }
  insertMessage.run(msg.id, msg.from, msg.to, msg.text, msg.timestamp)
  return msg
}

export function loadHistory(user1: string, user2: string): Message[] {
  return getHistory.all(user1, user2, user2, user1) as Message[]
}

export function saveReport(reporter: string, reportedUser: string, messageId: string | null, reason: string): Report {
  const report: Report = {
    id: uuid(),
    reporter,
    reportedUser,
    messageId,
    reason,
    timestamp: Date.now(),
  }
  insertReport.run(report.id, report.reporter, report.reportedUser, report.messageId, report.reason, report.timestamp)
  return report
}

export function getReportsForUser(screenName: string): number {
  const row = getReportCount.get(screenName) as { count: number }
  return row.count
}

export function touchScreenName(screenName: string): void {
  const now = Date.now()
  upsertScreenName.run(screenName, now, now, now)
}

// ---- Guestbook ----

export interface GuestbookEntry {
  id: string
  name: string
  location: string
  message: string
  timestamp: number
}

const insertGuestbookEntry = db.prepare(`
  INSERT INTO guestbook (id, name, location, message, timestamp) VALUES (?, ?, ?, ?, ?)
`)

const getGuestbookEntries = db.prepare(`
  SELECT * FROM guestbook ORDER BY timestamp DESC LIMIT 50
`)

export function addGuestbookEntry(name: string, location: string, message: string): GuestbookEntry {
  const entry: GuestbookEntry = { id: uuid(), name, location, message, timestamp: Date.now() }
  insertGuestbookEntry.run(entry.id, entry.name, entry.location, entry.message, entry.timestamp)
  return entry
}

export function getGuestbook(): GuestbookEntry[] {
  return getGuestbookEntries.all() as GuestbookEntry[]
}

// ---- SMS Signups ----

db.exec(`
  CREATE TABLE IF NOT EXISTS sms_signups (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL
  );
`)

const insertSmsSignup = db.prepare(`
  INSERT OR IGNORE INTO sms_signups (id, phone, timestamp) VALUES (?, ?, ?)
`)

const getSmsSignups = db.prepare(`
  SELECT * FROM sms_signups ORDER BY timestamp DESC
`)

export function addSmsSignup(phone: string): { id: string; phone: string; timestamp: number } {
  const entry = { id: uuid(), phone, timestamp: Date.now() }
  insertSmsSignup.run(entry.id, entry.phone, entry.timestamp)
  return entry
}

export function getAllSmsSignups() {
  return getSmsSignups.all()
}
