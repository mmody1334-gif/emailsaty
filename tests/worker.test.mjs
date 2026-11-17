// Worker API tests with an in-memory mock D1 — run with: node --test tests/
// Covers: mailbox creation, token-only inbox access, blocked addresses,
// catch-all email storage + code extraction, delete.
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";

// --- Minimal mock D1 -------------------------------------------------
class MockDB {
  constructor() {
    this.mailboxes = new Map(); // address -> row
    this.byToken = new Map(); // token -> row
    this.messages = []; // {id, mailbox_address, sender, subject, body_text, body_html, code, received_at}
    this.nextId = 1;
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...params) {
        return {
          async first() {
            if (sql.includes("FROM mailboxes WHERE address = ?")) {
              return db.mailboxes.get(params[0]) ?? null;
            }
            if (sql.includes("FROM mailboxes WHERE token = ?")) {
              return db.byToken.get(params[0]) ?? null;
            }
            if (sql.includes("FROM messages WHERE id = ? AND mailbox_address = ?")) {
              return db.messages.find((m) => m.id === params[0] && m.mailbox_address === params[1]) ?? null;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM messages WHERE mailbox_address = ?")) {
              const rows = db.messages
                .filter((m) => m.mailbox_address === params[0])
                .sort((a, b) => (a.received_at < b.received_at ? 1 : -1))
                .slice(0, 100)
                .map(({ id, sender, subject, code, received_at }) => ({ id, sender, subject, code, received_at }));
              return { results: rows };
            }
            return { results: [] };
          },
          async run() {
            if (sql.startsWith("INSERT INTO mailboxes")) {
              const [address, token, telegram_chat_id, domain, created_at, last_seen_at] = params;
              const row = { address, token, telegram_chat_id, domain, created_at, last_seen_at };
              db.mailboxes.set(address, row);
              db.byToken.set(token, row);
            } else if (sql.startsWith("INSERT INTO messages")) {
              const [mailbox_address, sender, subject, body_text, body_html, code, received_at] = params;
              db.messages.push({ id: db.nextId++, mailbox_address, sender, subject, body_text, body_html, code, received_at });
            } else if (sql.startsWith("UPDATE mailboxes SET last_seen_at")) {
              const row = db.mailboxes.get(params[1]);
              if (row) row.last_seen_at = params[0];
            } else if (sql.startsWith("DELETE FROM messages WHERE mailbox_address = ?")) {
              db.messages = db.messages.filter((m) => m.mailbox_address !== params[0]);
            } else if (sql.startsWith("DELETE FROM mailboxes WHERE token = ?")) {
              const row = db.byToken.get(params[0]);
              if (row) { db.mailboxes.delete(row.address); db.byToken.delete(params[0]); }
            } else if (sql.startsWith("DELETE FROM messages WHERE id = ?")) {
              db.messages = db.messages.filter((m) => !(m.id === params[0] && m.mailbox_address === params[1]));
            }
            return { success: true };
          },
        };
      },
    };
  }
}

function env() {
  return { DB: new MockDB(), TELEGRAM_CHAT_ID: "736161596" };
}
const ctx = { waitUntil: (p) => p.catch(() => {}) };
const req = (url, init) => new Request(url, init);

test("GET /api/domains returns only mail.elkabsula.site", async () => {
  const res = await worker.fetch(req("https://x/api/domains"), env());
  const d = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(d.domains, ["mail.elkabsula.site"]);
});

test("POST /api/mailboxes creates a mailbox with a secret token", async () => {
  const e = env();
  const res = await worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "megoooo", domain: "mail.elkabsula.site" }) }),
    e,
  );
  assert.equal(res.status, 201);
  const d = await res.json();
  assert.equal(d.address, "megoooo@mail.elkabsula.site");
  assert.ok(d.token && d.token.length >= 32);
});

test("POST /api/mailboxes rejects blocked logins and wrong domains", async () => {
  const e = env();
  for (const login of ["admin", "abuse", "postmaster"]) {
    const res = await worker.fetch(
      req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login, domain: "mail.elkabsula.site" }) }),
      e,
    );
    assert.equal(res.status, 400, login);
  }
  const res = await worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "megoooo", domain: "something.edu" }) }),
    e,
  );
  assert.equal(res.status, 400);
});

test("POST /api/mailboxes duplicate address returns 409, token is not leaked", async () => {
  const e = env();
  const mk = () => worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "dupuser", domain: "mail.elkabsula.site" }) }),
    e,
  );
  assert.equal((await mk()).status, 201);
  const second = await mk();
  assert.equal(second.status, 409);
  const d = await second.json();
  assert.equal(d.token, undefined);
});

test("inbox is token-only: wrong token gets 404", async () => {
  const e = env();
  const created = await (await worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "privuser", domain: "mail.elkabsula.site" }) }),
    e,
  )).json();
  const bad = await worker.fetch(req(`https://x/api/mailboxes/wrongtoken/messages`), e);
  assert.equal(bad.status, 404);
  const good = await worker.fetch(req(`https://x/api/mailboxes/${created.token}/messages`), e);
  assert.equal(good.status, 200);
  assert.deepEqual((await good.json()).messages, []);
});

test("email() catch-all: incoming mail is stored, code extracted, old mailbox still works", async () => {
  const e = env();
  const created = await (await worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "oldbox1", domain: "mail.elkabsula.site" }) }),
    e,
  )).json();
  // Generate a second mailbox — the old one must keep receiving.
  await worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "newbox2", domain: "mail.elkabsula.site" }) }),
    e,
  );
  const raw = [
    "From: noreply@some-site.com",
    "To: oldbox1@mail.elkabsula.site",
    "Subject: Verify your account",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your verification code is 778899. It expires soon.",
  ].join("\r\n");
  await worker.email(
    { to: "oldbox1@mail.elkabsula.site", from: "noreply@some-site.com", headers: new Map([["subject", "Verify your account"]]), raw },
    e,
    ctx,
  );
  const inbox = await (await worker.fetch(req(`https://x/api/mailboxes/${created.token}/messages`), e)).json();
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].code, "778899");
  assert.equal(inbox.messages[0].sender, "noreply@some-site.com");
  const full = await (await worker.fetch(req(`https://x/api/messages/${inbox.messages[0].id}?token=${created.token}`), e)).json();
  assert.match(full.message.body_text, /778899/);
});

test("email() to a blocked address is rejected, not stored", async () => {
  const e = env();
  let rejected = null;
  await worker.email(
    { to: "admin@mail.elkabsula.site", from: "x@y.com", headers: new Map(), raw: "From: x@y.com\r\nTo: admin@mail.elkabsula.site\r\nSubject: hi\r\n\r\nhello", setReject: (msg) => { rejected = msg; } },
    e,
    ctx,
  );
  assert.ok(rejected && rejected.includes("550"));
  assert.equal(e.DB.messages.length, 0);
});

test("DELETE mailbox removes it and its messages", async () => {
  const e = env();
  const created = await (await worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "todelete", domain: "mail.elkabsula.site" }) }),
    e,
  )).json();
  const del = await worker.fetch(req(`https://x/api/mailboxes/${created.token}`, { method: "DELETE" }), e);
  assert.equal(del.status, 200);
  const after = await worker.fetch(req(`https://x/api/mailboxes/${created.token}/messages`), e);
  assert.equal(after.status, 404);
});
