// emailsaty — Cloudflare Worker (TypeScript).
// Two entry points:
//   1. `email()` — Email Worker: Cloudflare Email Routing delivers every
//      message addressed to one of our domains here. We store it in D1
//      and notify the owner on Telegram. No mailbox needs pre-creation:
//      catch-all — any login@domain works, like temp-mail.org.
//   2. `fetch()` — HTTP JSON API used by index.html (GitHub Pages).
//
// Auth model: each mailbox has a random secret `token` (see lib.ts).
// Only the token holder can read that mailbox. There is no public
// "list all mailboxes" endpoint. The Telegram bot is notified by the
// Worker, never by the browser, using TELEGRAM_BOT_TOKEN (a secret,
// never shipped to the frontend).
//
// D1 tables (see schema.sql):
//   mailboxes(address, token, telegram_chat_id, domain, created_at, last_seen_at)
//   messages(id, mailbox_address, sender, subject, body_text, body_html, code, received_at)

import {
  BLOCKED_LOCAL_PARTS,
  DEFAULT_DOMAINS,
  OWNER_TELEGRAM_ID,
  extractVerificationCode,
  generateAddress,
  generateLogin,
  generateToken,
  isBlockedLocalPart,
  parseRawEmail,
  validateAddress,
  validateLogin,
} from "./lib.ts";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string; // default owner chat id; defaults to OWNER_TELEGRAM_ID
  DOMAINS?: string; // optional comma-separated override of DEFAULT_DOMAINS
  INGEST_SECRET?: string; // shared secret for POST /api/ingest (relay Worker)
}

function getDomains(env: Env): string[] {
  const override = (env.DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  return override.length ? override : [...DEFAULT_DOMAINS];
}

/** Constant-time string comparison, so the ingest secret is not
 *  leaked through timing. Plain equality would also work; this is cheap. */
function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * POST /api/ingest — relay-only endpoint.
 * The relay Worker (old account, src/relay-worker.ts) forwards mail
 * here after Email Routing delivers it. Auth is the shared
 * INGEST_SECRET in the x-ingest-secret header — no mailbox token.
 * The mailbox must already exist (created from the web app); unknown
 * addresses are NOT auto-created, so a stray relay cannot fill D1
 * with mailboxes nobody owns.
 */
async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (!env.INGEST_SECRET) return error("ingest not configured", 500);
  const headerSecret = request.headers.get("x-ingest-secret") ?? "";
  if (!secretsEqual(headerSecret, env.INGEST_SECRET)) {
    return error("unauthorized", 401);
  }
  let body: {
    to?: unknown;
    sender?: unknown;
    subject?: unknown;
    body_text?: unknown;
    body_html?: unknown;
    code?: unknown;
    received_at?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("invalid JSON body", 400);
  }
  if (typeof body.to !== "string") return error("missing 'to'", 400);
  const address = body.to.trim().toLowerCase();
  const check = validateAddress(address, getDomains(env));
  if (!check.ok) return error(check.error!, 400);
  const mailbox = await findMailboxByAddress(env, address);
  if (!mailbox) return error("mailbox not found", 404);
  if (typeof body.sender !== "string") return error("missing 'sender'", 400);
  const subject = typeof body.subject === "string" ? body.subject : "";
  const bodyText = typeof body.body_text === "string" ? body.body_text : "";
  const bodyHtml = typeof body.body_html === "string" ? body.body_html : null;
  const code =
    typeof body.code === "string"
      ? body.code
      : extractVerificationCode(`${subject}\n${bodyText}`);
  const receivedAt =
    typeof body.received_at === "string" && body.received_at
      ? body.received_at
      : new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO messages (mailbox_address, sender, subject, body_text, body_html, code, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(address, body.sender, subject, bodyText, bodyHtml, code, receivedAt)
    .run();
  const id =
    (result as { meta?: { last_row_id?: number } })?.meta?.last_row_id ??
    null;
  await env.DB.prepare("UPDATE mailboxes SET last_seen_at = ? WHERE address = ?")
    .bind(receivedAt, address)
    .run();
  return json({ ok: true, id }, 201);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function error(message: string, status: number): Response {
  return json({ ok: false, error: message }, status);
}

async function notifyTelegram(
  env: Env,
  chatId: string,
  text: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
  } catch {
    // Notification failure must never lose the stored email.
  }
}

function telegramText(
  address: string,
  sender: string,
  subject: string,
  code: string | null,
): string {
  const lines = [
    "📩 رسالة جديدة على إيميلك المؤقت",
    `إلى: ${address}`,
    `من: ${sender || "—"}`,
    `الموضوع: ${subject || "—"}`,
  ];
  if (code) lines.push(`🔑 كود التحقق: ${code}`);
  return lines.join("\n");
}

interface MailboxRow {
  address: string;
  token: string;
  telegram_chat_id: string | null;
  domain: string;
  created_at: string;
  last_seen_at: string | null;
}

async function findMailboxByAddress(
  env: Env,
  address: string,
): Promise<MailboxRow | null> {
  return (await env.DB.prepare(
    "SELECT address, token, telegram_chat_id, domain, created_at, last_seen_at FROM mailboxes WHERE address = ?",
  )
    .bind(address.toLowerCase())
    .first()) as MailboxRow | null;
}

async function findMailboxByToken(
  env: Env,
  token: string,
): Promise<MailboxRow | null> {
  return (await env.DB.prepare(
    "SELECT address, token, telegram_chat_id, domain, created_at, last_seen_at FROM mailboxes WHERE token = ?",
  )
    .bind(token)
    .first()) as MailboxRow | null;
}

/** Shared store path used by the email() entry point. */
export async function storeIncomingMail(
  env: Env,
  to: string,
  from: string,
  subject: string,
  bodyText: string,
  bodyHtml: string | null,
): Promise<{ stored: boolean; code: string | null; reason?: string }> {
  const address = to.trim().toLowerCase();
  const login = address.split("@")[0] ?? "";
  if (isBlockedLocalPart(login)) return { stored: false, code: null, reason: "blocked address" };

  const check = validateAddress(address, getDomains(env));
  if (!check.ok) return { stored: false, code: null, reason: check.error };

  const code = extractVerificationCode(`${subject}\n${bodyText}`);
  const now = new Date().toISOString();

  // Mailbox is created lazily on first incoming mail (catch-all model).
  // If the owner generated it from the web app first, the row already
  // exists and we keep its token / telegram_chat_id.
  let mailbox = await findMailboxByAddress(env, address);
  if (!mailbox) {
    const token = generateToken();
    await env.DB.prepare(
      "INSERT INTO mailboxes (address, token, telegram_chat_id, domain, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(address, token, env.TELEGRAM_CHAT_ID ?? OWNER_TELEGRAM_ID, check.domain, now, now)
      .run();
    mailbox = { address, token, telegram_chat_id: env.TELEGRAM_CHAT_ID ?? OWNER_TELEGRAM_ID, domain: check.domain!, created_at: now, last_seen_at: now };
  } else {
    await env.DB.prepare(
      "UPDATE mailboxes SET last_seen_at = ? WHERE address = ?",
    )
      .bind(now, address)
      .run();
  }

  await env.DB.prepare(
    "INSERT INTO messages (mailbox_address, sender, subject, body_text, body_html, code, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(address, from, subject, bodyText, bodyHtml, code, now)
    .run();

  return { stored: true, code, reason: undefined };
}

export default {
  /** Email Routing entry point. */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const to = message.to;
    // Cloudflare gives us the raw message; parse it for subject/body/code.
    let parsed;
    try {
      const raw = await new Response(message.raw).text();
      parsed = parseRawEmail(raw);
    } catch {
      parsed = {
        from: message.from,
        to,
        subject: message.headers.get("subject") ?? "",
        bodyText: "",
        bodyHtml: null,
        code: null,
      };
    }
    const result = await storeIncomingMail(
      env,
      parsed.to || to,
      parsed.from || message.from,
      parsed.subject,
      parsed.bodyText,
      parsed.bodyHtml,
    );
    if (!result.stored) {
      message.setReject(`550 ${result.reason ?? "rejected"}`);
      return;
    }
    const mailbox = await findMailboxByAddress(env, (parsed.to || to).toLowerCase());
    if (mailbox?.telegram_chat_id) {
      ctx.waitUntil(
        notifyTelegram(
          env,
          mailbox.telegram_chat_id,
          telegramText(mailbox.address, parsed.from || message.from, parsed.subject, result.code),
        ),
      );
    }
  },

  /** HTTP API entry point. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({ ok: true });
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // POST /api/ingest — relay-only (see handleIngest above).
    if (request.method === "POST" && path === "/api/ingest") {
      return handleIngest(request, env);
    }

    // GET /api/domains — the free domains this service receives for.
    if (request.method === "GET" && path === "/api/domains") {
      return json({ ok: true, domains: getDomains(env) });
    }

    // GET /api/health
    if (request.method === "GET" && path === "/api/health") {
      return json({ ok: true, service: "emailsaty", owner_only: true });
    }

    // POST /api/mailboxes { login?, domain } -> { address, token }
    if (request.method === "POST" && path === "/api/mailboxes") {
      let body: { login?: string; domain?: string } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return error("invalid JSON body", 400);
      }
      const domains = getDomains(env);
      const domain = (body.domain ?? domains[0] ?? "").toLowerCase();
      if (!domains.includes(domain)) return error("domain is not enabled", 400);
      const login = body.login ? body.login.trim().toLowerCase() : generateLogin();
      const loginCheck = validateLogin(login);
      if (!loginCheck.ok) return error(loginCheck.error!, 400);
      const address = generateAddress(login, domain);
      const existing = await findMailboxByAddress(env, address);
      if (existing) {
        // Address already exists: only return its token if the caller
        // proves nothing — in practice the web app keeps the token in
        // localStorage from creation. Never hand out an existing token
        // to an unauthenticated caller.
        return error("address already exists — open it from your saved mailboxes", 409);
      }
      const token = generateToken();
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO mailboxes (address, token, telegram_chat_id, domain, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(address, token, env.TELEGRAM_CHAT_ID ?? OWNER_TELEGRAM_ID, domain, now, now)
        .run();
      return json({ ok: true, address, token, domain }, 201);
    }

    // GET /api/mailboxes/:token/messages — owner-only inbox list.
    const inboxMatch = path.match(/^\/api\/mailboxes\/([^/]+)\/messages$/);
    if (request.method === "GET" && inboxMatch) {
      const mailbox = await findMailboxByToken(env, inboxMatch[1]);
      if (!mailbox) return error("mailbox not found", 404);
      const rows = await env.DB.prepare(
        "SELECT id, sender, subject, code, received_at FROM messages WHERE mailbox_address = ? ORDER BY received_at DESC LIMIT 100",
      )
        .bind(mailbox.address)
        .all();
      await env.DB.prepare("UPDATE mailboxes SET last_seen_at = ? WHERE address = ?")
        .bind(new Date().toISOString(), mailbox.address)
        .run();
      return json({ ok: true, address: mailbox.address, messages: rows.results ?? [] });
    }

    // GET /api/messages/:id?token=... — full message, owner-only.
    const msgMatch = path.match(/^\/api\/messages\/(\d+)$/);
    if (request.method === "GET" && msgMatch) {
      const token = url.searchParams.get("token") ?? "";
      const mailbox = await findMailboxByToken(env, token);
      if (!mailbox) return error("mailbox not found", 404);
      const row = await env.DB.prepare(
        "SELECT id, mailbox_address, sender, subject, body_text, body_html, code, received_at FROM messages WHERE id = ? AND mailbox_address = ?",
      )
        .bind(Number(msgMatch[1]), mailbox.address)
        .first();
      if (!row) return error("message not found", 404);
      return json({ ok: true, message: row });
    }

    // DELETE /api/mailboxes/:token — delete a saved mailbox + its messages.
    const delBox = path.match(/^\/api\/mailboxes\/([^/]+)$/);
    if (request.method === "DELETE" && delBox) {
      const mailbox = await findMailboxByToken(env, delBox[1]);
      if (!mailbox) return error("mailbox not found", 404);
      await env.DB.prepare("DELETE FROM messages WHERE mailbox_address = ?").bind(mailbox.address).run();
      await env.DB.prepare("DELETE FROM mailboxes WHERE token = ?").bind(delBox[1]).run();
      return json({ ok: true, deleted: mailbox.address });
    }

    // DELETE /api/messages/:id?token=...
    if (request.method === "DELETE" && msgMatch) {
      const token = url.searchParams.get("token") ?? "";
      const mailbox = await findMailboxByToken(env, token);
      if (!mailbox) return error("mailbox not found", 404);
      await env.DB.prepare(
        "DELETE FROM messages WHERE id = ? AND mailbox_address = ?",
      )
        .bind(Number(msgMatch[1]), mailbox.address)
        .run();
      return json({ ok: true, deleted: Number(msgMatch[1]) });
    }

    return error("not found", 404);
  },
};

// Re-exported so the blocked list stays in one place.
export { BLOCKED_LOCAL_PARTS };
