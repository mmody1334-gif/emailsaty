// emailsaty — pure helpers (no Worker / D1 / network access).
// Kept dependency-free so they can be unit-tested with plain node.
//
// Security note: a mailbox is identified by a random secret token,
// NOT by md5(address) alone. temp-mail.org's legacy API used
// md5(email) as the identifier, which anyone who knows the address
// can compute. Here the token is generated server-side with
// crypto.randomUUID() and never derived from the address.

export const BLOCKED_LOCAL_PARTS = [
  "abuse",
  "webmaster",
  "contact",
  "postmaster",
  "hostmaster",
  "admin",
] as const;

export const OWNER_TELEGRAM_ID = "736161596";

/** Primary domain — ONLY mail.elkabsula.site (Mohamed's decision
 *  2026-11-17). It is a subdomain of a domain he already owns: $0 extra.
 *  ⚠️ RECEIVING FLAG: a `mail.elkabsula.site` zone cannot be created —
 *  Cloudflare free accounts reject subdomains as zones (API error
 *  1116; subdomain zones are Enterprise-only, verified 2026-11-17).
 *  So mail is received in the OLD account (where the `elkabsula.site`
 *  zone lives) via Email Routing + the relay Worker
 *  (src/relay-worker.ts), which forwards it to the storage Worker in
 *  the NEW account. HARD RULE: الكبسولة must not be affected at all —
 *  relay setup may ONLY add mail-subdomain MX + a routing rule for
 *  @mail.elkabsula.site; never touch root DNS records, nameservers,
 *  or الكبسولة Workers/routes.
 *  No .edu domain is listed here on purpose: .edu is restricted to
 *  accredited US postsecondary institutions (EDUCAUSE) and is not
 *  available to an individual / Omani K-12 school. */
export const DEFAULT_DOMAINS = [
  "mail.elkabsula.site",
] as const;

/** Optional public-provider fallback, receive-only (mail.tm).
 *  Shared/public — NOT private, and NOT the primary domain.
 *  Only used if Mohamed explicitly enables it. */
export const PUBLIC_FALLBACK_DOMAINS = ["mail.tm"] as const;

export function isBlockedLocalPart(login: string): boolean {
  return (BLOCKED_LOCAL_PARTS as readonly string[]).includes(
    login.trim().toLowerCase(),
  );
}

/** Login rules: 3–32 chars, lowercase letters/digits, . _ - allowed,
 *  must start with a letter or digit. */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function validateLogin(login: string): { ok: boolean; error?: string } {
  const v = normalizeLogin(login);
  if (v.length < 3 || v.length > 32)
    return { ok: false, error: "login must be 3-32 characters" };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(v))
    return { ok: false, error: "login may only contain a-z, 0-9, . _ -" };
  if (isBlockedLocalPart(v))
    return { ok: false, error: "this address is blocked" };
  return { ok: true };
}

export function validateAddress(
  address: string,
  allowedDomains: readonly string[],
): { ok: boolean; error?: string; login?: string; domain?: string } {
  const v = address.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at <= 0 || at === v.length - 1)
    return { ok: false, error: "address must be login@domain" };
  const login = v.slice(0, at);
  const domain = v.slice(at + 1);
  const loginCheck = validateLogin(login);
  if (!loginCheck.ok) return { ok: false, error: loginCheck.error };
  if (!allowedDomains.includes(domain))
    return { ok: false, error: "domain is not enabled for this service" };
  return { ok: true, login, domain };
}

export function generateLogin(length = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // Guarantee it starts with a letter so it always passes validateLogin.
  if (/[0-9]/.test(out[0])) out = "m" + out.slice(1);
  return out;
}

/** Secret mailbox token. Random, unguessable, never derived from the address. */
export function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export function generateAddress(login: string, domain: string): string {
  return `${normalizeLogin(login)}@${domain.toLowerCase()}`;
}

/**
 * Extract a verification code from message text.
 * Priority: an explicit "code / رمز" label, then a standalone 6-digit
 * code, then 5–8 digit codes (bare 4-digit numbers are usually years),
 * then a 6–8 char alphanumeric code (e.g. 3COTZ5).
 * Long numbers (years, order ids, phone numbers) are ignored.
 */
export function extractVerificationCode(text: string): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ");

  const labelled = flat.match(
    /(?:verification code|verify code|your code|code is|code:|code|رمز التحقق|رمز التأكيد|الكود|كود التحقق|كود التأكيد)\s*[:：]?\s*([A-Z0-9]{4,8})/i,
  );
  // A labelled match only counts if it actually contains a digit —
  // otherwise "Your code" followed by "Hello, …" would capture "HELLO".
  if (labelled && /[0-9]/.test(labelled[1])) return labelled[1].toUpperCase();

  // Standalone 6-digit code, not part of a longer number.
  const six = flat.match(/(?<![0-9])[0-9]{6}(?![0-9])/);
  if (six) return six[0];

  // 5–8 digit codes. Deliberately NOT 4-digit here: a bare 4-digit
  // number is usually a year (2026) — a real 4-digit code is only
  // trusted when it follows a "code" label (handled above).
  const fiveToEight = flat.match(/(?<![0-9])[0-9]{5,8}(?![0-9])/);
  if (fiveToEight) return fiveToEight[0];

  const alnum = flat.match(/(?<![A-Z0-9])[A-Z0-9]{6,8}(?![A-Z0-9])/i);
  if (alnum && /[0-9]/.test(alnum[0]) && /[A-Z]/i.test(alnum[0]))
    return alnum[0].toUpperCase();

  return null;
}

export interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  code: string | null;
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** Minimal raw-RFC822 parser (enough for the Email Worker path).
 *  Handles plain-text and simple multipart/alternative bodies.
 *  Not a full MIME parser — attachments are not decoded here. */
export function parseRawEmail(raw: string): ParsedEmail {
  const [headPart, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const body = bodyParts.join("\n\n");
  const headers = new Map<string, string>();
  let current = "";
  for (const line of headPart.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, (headers.get(current) ?? "") + " " + line.trim());
    } else {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) {
        current = m[1].toLowerCase();
        headers.set(current, m[2].trim());
      }
    }
  }
  const subject = headers.get("subject") ?? "";
  const from = headers.get("from") ?? "";
  const to = headers.get("to") ?? "";

  // multipart/alternative: pick the text/plain part, else text/html.
  let bodyText = "";
  let bodyHtml: string | null = null;
  const boundary = (headers.get("content-type") ?? "").match(
    /boundary="?([^";\s]+)"?/,
  )?.[1];
  if (boundary) {
    const parts = body.split(`--${boundary}`);
    for (const part of parts) {
      const [, partBody = ""] = part.split(/\r?\n\r?\n/);
      const decoded = decodeQuotedPrintable(partBody.trim());
      if (/text\/plain/i.test(part)) bodyText = decoded;
      if (/text\/html/i.test(part)) bodyHtml = decoded;
    }
  } else {
    const decoded = decodeQuotedPrintable(body.trim());
    if (/text\/html/i.test(headers.get("content-type") ?? "")) bodyHtml = decoded;
    else bodyText = decoded;
  }
  if (!bodyText && bodyHtml) {
    bodyText = bodyHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return {
    from,
    to,
    subject,
    bodyText,
    bodyHtml,
    code: extractVerificationCode(`${subject}\n${bodyText}`),
  };
}
