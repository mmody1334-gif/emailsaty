// Ingest endpoint tests (storage Worker) — run with: node --test tests/
// Covers: POST /api/ingest rejects wrong/missing secret (401),
// rejects unknown mailboxes without auto-creating them (404),
// stores a message for a known mailbox (201 + visible in inbox),
// rejects invalid JSON (400), and 500s when INGEST_SECRET is unset.
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";

// --- Minimal mock D1 (same shape as tests/worker.test.mjs) ------------
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
              return { success: true };
            } else if (sql.startsWith("INSERT INTO messages")) {
              const [mailbox_address, sender, subject, body_text, body_html, code, received_at] = params;
              const id = db.nextId++;
              db.messages.push({ id, mailbox_address, sender, subject, body_text, body_html, code, received_at });
              return { success: true, meta: { last_row_id: id } };
            } else if (sql.startsWith("UPDATE mailboxes SET last_seen_at")) {
              const row = db.mailboxes.get(params[1]);
              if (row) row.last_seen_at = params[0];
              return { success: true };
            }
            return { success: true };
          },
        };
      },
    };
  }
}

const SECRET = "test-ingest-secret";
function env() {
  return { DB: new MockDB(), TELEGRAM_CHAT_ID: "736161596", INGEST_SECRET: SECRET };
}
const req = (url, init) => new Request(url, init);
const ingestBody = {
  to: "ingestbox@mail.elkabsula.site",
  sender: "noreply@some-site.com",
  subject: "Verify your account",
  body_text: "Your verification code is 445566.",
  body_html: null,
  code: "445566",
  received_at: "2026-11-17T10:00:00.000Z",
};

async function createMailbox(e, login = "ingestbox") {
  const res = await worker.fetch(
    req("https://x/api/mailboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login, domain: "mail.elkabsula.site" }) }),
    e,
  );
  assert.equal(res.status, 201);
  return res.json();
}

function ingestRequest(body, secret = SECRET) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers["x-ingest-secret"] = secret;
  return req("https://x/api/ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /api/ingest rejects wrong or missing secret with 401", async () => {
  const e = env();
  assert.equal((await worker.fetch(ingestRequest(ingestBody, "wrong-secret"), e)).status, 401);
  assert.equal((await worker.fetch(ingestRequest(ingestBody, null), e)).status, 401);
  assert.equal(e.DB.messages.length, 0);
});

test("POST /api/ingest rejects invalid JSON with 400", async () => {
  const e = env();
  const res = await worker.fetch(ingestRequest("{not json"), e);
  assert.equal(res.status, 400);
});

test("POST /api/ingest returns 500 when INGEST_SECRET is not configured", async () => {
  const e = { DB: new MockDB(), TELEGRAM_CHAT_ID: "736161596" };
  const res = await worker.fetch(ingestRequest(ingestBody), e);
  assert.equal(res.status, 500);
});

test("POST /api/ingest rejects an unknown mailbox with 404 and does not create it", async () => {
  const e = env();
  const res = await worker.fetch(ingestRequest(ingestBody), e);
  assert.equal(res.status, 404);
  assert.equal(e.DB.messages.length, 0);
  assert.equal(e.DB.mailboxes.size, 0);
});

test("POST /api/ingest stores a message for a known mailbox", async () => {
  const e = env();
  const created = await createMailbox(e);
  const res = await worker.fetch(ingestRequest(ingestBody), e);
  assert.equal(res.status, 201);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(typeof d.id, "number");
  const inbox = await (await worker.fetch(req(`https://x/api/mailboxes/${created.token}/messages`), e)).json();
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].code, "445566");
  assert.equal(inbox.messages[0].sender, "noreply@some-site.com");
});

test("POST /api/ingest extracts the code itself when code is missing", async () => {
  const e = env();
  const created = await createMailbox(e);
  const body = { ...ingestBody, code: null, body_text: "Your code is 112233." };
  const res = await worker.fetch(ingestRequest(body), e);
  assert.equal(res.status, 201);
  const inbox = await (await worker.fetch(req(`https://x/api/mailboxes/${created.token}/messages`), e)).json();
  assert.equal(inbox.messages[0].code, "112233");
});
