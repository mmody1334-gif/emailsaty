// emailsaty-relay — Cloudflare Worker (TypeScript) for the OLD account.
//
// Why this exists: Cloudflare free accounts cannot create a
// `mail.elkabsula.site` zone (API error 1116 — subdomain zones are
// Enterprise-only), so the NEW account cannot receive mail directly.
// Instead the OLD account — where the `elkabsula.site` zone already
// lives — receives the mail via Email Routing and this relay splits it:
//
//   sender → MX for elkabsula.site (old account zone)
//        → Email Routing catch-all (the zone has only ONE catch-all,
//          and routing rules cannot match a whole subdomain, so the
//          split happens here, not in routing rules)
//        → this Worker (email())
//          ├─ @mail.elkabsula.site → POST /api/ingest on the NEW
//          │    account Worker (fetch, 10s timeout) → D1 in the NEW
//          │    account (temp mail — the web app inbox)
//          └─ @elkabsula.site (root) → message.forward(FORWARD_TO):
//               Mohamed's own mail, previously delivered by Namecheap
//               email forwarding (removed 2026-11-17 so Email Routing
//               could activate). Forwarding preserves the original
//               message, sender and attachments.
//
// This Worker stores nothing: no D1, no Telegram. If the ingest call
// or the forward fails (non-2xx, network error, timeout) we throw, so
// Email Routing rejects the message honestly instead of silently
// dropping it.
//
// Secrets (never in the repo — set with wrangler secret put, logged in
// to the OLD account, in the repo folder):
//   wrangler secret put INGEST_SECRET --config wrangler-relay.toml
//     (same value as on the NEW account Worker)
//   wrangler secret put FORWARD_TO --config wrangler-relay.toml
//     (paste: mmody1334@gmail.com — the destination for @elkabsula.site
//      root mail; a secret, not a [vars] entry, so it never collides
//      with local edits to wrangler-relay.toml on git pull)
// Redeploy after any change:
//   npx wrangler deploy --config wrangler-relay.toml

import {
  DEFAULT_DOMAINS,
  ROOT_DOMAIN,
  isBlockedLocalPart,
  parseRawEmail,
  validateAddress,
} from "./lib.ts";

export interface RelayEnv {
  INGEST_URL: string; // e.g. https://emailsaty.<subdomain>.workers.dev/api/ingest
  INGEST_SECRET: string; // same value as INGEST_SECRET on the NEW account Worker
  FORWARD_TO: string; // where @elkabsula.site (root) mail is forwarded, e.g. mmody1334@gmail.com
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
    const domain = address.split("@")[1] ?? "";

    // ── Root-domain mail: Mohamed's own mail, forward it untouched. ──
    // Deliberately NO blocked-list / login validation here: this must
    // behave exactly like the old Namecheap forwarding did — every
    // @elkabsula.site address forwards, whatever its local part.
    if (domain === ROOT_DOMAIN) {
      if (!env.FORWARD_TO) {
        throw new Error("FORWARD_TO is not configured on the relay Worker");
      }
      await message.forward(env.FORWARD_TO);
      return;
    }

    // ── Temp mail: @mail.elkabsula.site → ingest into D1. ──
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
