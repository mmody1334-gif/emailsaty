// emailsaty-relay — Cloudflare Worker (TypeScript) for the OLD account.
//
// Why this exists: Cloudflare free accounts cannot create a
// `mail.elkabsula.site` zone (API error 1116 — subdomain zones are
// Enterprise-only), so the NEW account cannot receive mail directly.
// Instead the OLD account — where the `elkabsula.site` zone already
// lives — receives the mail via Email Routing and this relay forwards
// it to the storage Worker in the NEW account.
//
// Flow:
//   sender → MX for mail.elkabsula.site (old account zone)
//        → Email Routing catch-all → this Worker (email())
//        → POST /api/ingest on the NEW account Worker (fetch, 10s timeout)
//        → D1 (mailboxes + messages) in the NEW account
//
// This Worker stores nothing: no D1, no Telegram. If the ingest call
// fails (non-2xx, network error, timeout) we throw, so Email Routing
// rejects the message honestly instead of silently dropping it.

import {
  DEFAULT_DOMAINS,
  isBlockedLocalPart,
  parseRawEmail,
  validateAddress,
} from "./lib.ts";

export interface RelayEnv {
  INGEST_URL: string; // e.g. https://emailsaty.<subdomain>.workers.dev/api/ingest
  INGEST_SECRET: string; // same value as INGEST_SECRET on the NEW account Worker
}

const INGEST_TIMEOUT_MS = 10_000;

export default {
  /** Email Routing entry point (old account). */
  async email(
    message: ForwardableEmailMessage,
    env: RelayEnv,
  ): Promise<void> {
    const to = message.to;
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

    const address = (parsed.to || to).trim().toLowerCase();
    const login = address.split("@")[0] ?? "";
    if (isBlockedLocalPart(login)) {
      message.setReject("550 blocked address");
      return;
    }
    const check = validateAddress(address, [...DEFAULT_DOMAINS]);
    if (!check.ok) {
      message.setReject(`550 ${check.error ?? "rejected"}`);
      return;
    }

    if (!env.INGEST_URL || env.INGEST_URL === "PLACEHOLDER_INGEST_URL") {
      throw new Error("INGEST_URL is not configured on the relay Worker");
    }
    if (!env.INGEST_SECRET) {
      throw new Error("INGEST_SECRET is not configured on the relay Worker");
    }

    const payload = {
      to: address,
      sender: parsed.from || message.from,
      subject: parsed.subject,
      body_text: parsed.bodyText,
      body_html: parsed.bodyHtml,
      code: parsed.code,
      received_at: new Date().toISOString(),
      secret: env.INGEST_SECRET,
    };

    let res: Response;
    try {
      res = await fetch(env.INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ingest-secret": env.INGEST_SECRET,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`ingest fetch failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new Error(`ingest rejected the message: HTTP ${res.status}`);
    }
  },
};
