const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'survey.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
    created_at TEXT DEFAULT (datetime('now')),
    activated_at TEXT,
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    digit INTEGER NOT NULL,          -- 1-9, the key the caller presses
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submitted_at TEXT DEFAULT (datetime('now')),
    UNIQUE(survey_id, user_id)       -- enforces "one submission per user per survey"
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id),
    option_id INTEGER NOT NULL REFERENCES options(id)
  );

  -- Tracks in-progress IVR calls (which survey a call belongs to, resolved user, etc.)
  CREATE TABLE IF NOT EXISTS ivr_calls (
    call_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    survey_id INTEGER NOT NULL,
    user_id INTEGER,
    started_at TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;
