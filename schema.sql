-- emailsaty — D1 schema.
-- Apply with: wrangler d1 execute emailsaty-db --file=./schema.sql
-- (against the NEW Cloudflare account, mmody1330@gmail.com)
--
-- Retention: mailboxes are kept until the owner deletes them
-- (this is the "saved inbox" requirement — unlike temp-mail.org,
-- which self-destructs messages in 1–2 hours). A cleanup job may
-- later delete messages older than a chosen retention window;
-- do NOT add one silently — it is a product decision for Mohamed.

CREATE TABLE IF NOT EXISTS mailboxes (
  address TEXT PRIMARY KEY,          -- e.g. abc123@mail.elkabsula.site
  token TEXT NOT NULL UNIQUE,        -- random secret; the ONLY key to read this inbox
  telegram_chat_id TEXT,            -- owner chat id (736161596); null = no notify
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_address TEXT NOT NULL REFERENCES mailboxes(address),
  sender TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  code TEXT,                         -- extracted verification code, if any
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_address, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailboxes_token ON mailboxes(token);
