import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import type { Message, Report } from './types.js'

const db = new Database('aim.db')

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
