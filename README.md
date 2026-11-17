# emailsaty — Stage 1 skeleton (local build, NOT deployed)

Private temporary email for Mohamed only. Receive-only in v1.
**Do not push to GitHub or deploy to Cloudflare from this folder yet —
Stage 1 is a local skeleton; Stage 2 (live receiving) needs the DNS
step below, done by Mohamed on his own machine/account.**

## How temp-mail.org works (reverse engineering, verified 2026-10-29 / 2026-11-17)

- No mailbox is created in advance: **any** `login@domain` works
  (catch-all). The sender's server looks up the domain's MX record,
  connects to temp-mail's SMTP server on port 25, and delivers the mail.
- The service stores the message and the browser polls for it
  (login + domain → message list → one message by id, JSON with
  subject/body/date/attachments, or the raw message base64).
- Messages self-destruct in **1–2 hours**. Addresses
  `abuse@`, `webmaster@`, `contact@`, `postmaster@`, `hostmaster@`,
  `admin@` are blocked.
- The legacy `api.temp-mail.org` endpoints are **dead** (DNS does not
  resolve, verified 2026-10-29); the official page now points to a
  RapidAPI offering. This project does **not** depend on that API.
- Legacy flaw we do **not** copy: the old API identified a mailbox by
  `md5(email)` — anyone who knows the address can compute it.
  emailsaty identifies a mailbox by a **random secret token**
  generated server-side (`crypto.randomUUID()`), never derived from
  the address. Only the token holder can read that inbox.

## How emailsaty differs

| temp-mail.org | emailsaty |
|---|---|
| Public pool, anyone who guesses the address can read it | Private: token-only inbox, owner Telegram id 736161596 |
| Messages die in 1–2 h | **Saved mailboxes**: kept until the owner deletes them |
| New address abandons the old one | Old mailboxes keep receiving; Telegram notifies on **any** of them, even after a new one is generated |
| Many public domains (heavily blocklisted) | One private domain (below) — not published, so it stays clean longer |

## Architecture

```
GitHub Pages (index.html, static frontend, Arabic RTL)
        │  fetch /api/*
        ▼
Cloudflare Worker (src/worker.ts)  ── Email Routing (catch-all)
        │  D1: mailboxes + messages (schema.sql)
        ▼
Telegram bot (notify on arrival: sender / subject / code)
```

- **Frontend** (`index.html`): generate random address, custom login +
  domain selector, copy, saved-mailbox tabs, inbox list, open message,
  delete. Polling (20 s) updates **only** the inbox list — it never
  re-renders the address box, so text inputs and the Android Chrome
  keyboard are never interrupted (this was the bug in the Oct 2026
  multi-provider version). If the API is unreachable it shows
  OFFLINE honestly; it never invents fake messages.
- **Worker** (`src/worker.ts`): `email()` entry point parses the raw
  message, extracts sender/subject/body/verification code, stores it
  in D1, and notifies Telegram. `fetch()` serves
  `GET /api/domains`, `POST /api/mailboxes`, `GET /api/mailboxes/:token/messages`,
  `GET /api/messages/:id?token=…`, `DELETE` for both.
- **D1** (`schema.sql`): `mailboxes(address, token, telegram_chat_id,
  domain, created_at, last_seen_at)`,
  `messages(id, mailbox_address, sender, subject, body_text, body_html,
  code, received_at)`.

## Domains — free only, no paid domains

- **Primary (only): `mail.elkabsula.site`** — a subdomain of
  `elkabsula.site`, a domain Mohamed already owns. **$0 extra.**
  No other primary domain. No `.edu` domain: `.edu` is restricted
  to accredited US postsecondary institutions (EDUCAUSE) and is not
  available to an individual / Omani K-12 school — a fake `.edu`
  address would never receive mail, so it is excluded, not faked.
- **Optional fallback only: mail.tm** — a public provider,
  clearly labelled shared/public, **not private**, not enabled by
  default. It is the only public fallback; no other public providers
  are hard-coded.

### ⚠️ DNS BLOCKER — Stage 2 cannot pass until Mohamed does this

`elkabsula.site`'s DNS zone currently lives in his **OLD** Cloudflare
account. For the **NEW** account (`mmody1330@gmail.com`) the
`mail.elkabsula.site` subdomain must be set up there — subdomain zone
/ MX + Email Routing (catch-all → Worker `emailsaty`) in the new
account — **before live receiving can be tested**. Until that is done,
Stage 2's live test (send a real email from Gmail to
`xxx@mail.elkabsula.site` and see it arrive) will fail, and that
failure is a DNS-setup failure, not a code failure.

## Stage-by-stage test plan

- **Stage 0 — Decisions** (done): Cloudflare (free), new account
  `mmody1330@gmail.com`, primary domain `mail.elkabsula.site`,
  no paid domains, Telegram notify on old + new mailboxes.
- **Stage 1 — Skeleton (this folder)**: `node --test tests/`,
  `tsc --noEmit`, frontend JS syntax check. Pass = all tests green,
  no syntax errors. ✅ / ❌ recorded below.
- **Stage 2 — Live receiving**: after the DNS step above + Worker
  deploy on the new account. Test: real Gmail → generated address,
  message appears < 60 s with the right code; Telegram notification
  arrives. Fix + re-test on failure; do not continue until clean.
- **Stage 3 — Web app on phone**: generate / custom login / copy /
  inbox / open / delete in Android Chrome; typing + keyboard work.
- **Stage 4 — Saved inboxes**: generate A, then B, send to A —
  A still shows the message and Telegram notifies.
- **Stage 5 — Telegram bot**: webhook, `/new` / `/list`, notification
  with code + deep link.
- **Stage 6 — Domain check**: live signup test on the one domain.
- **Stage 7 — Sending (optional, later)**: only from a verified
  domain with SPF/DKIM/DMARC + a relay; never faked from the temp domain.

## What still needs Mohamed

1. **DNS step above** (new account, `mail.elkabsula.site` zone / MX +
   Email Routing → Worker). This is the Stage 2 gate.
2. **New-account credentials**: Account ID + API token from the
   `mmody1330@gmail.com` Cloudflare account (for the GitHub deploy
   workflow). Tokens are never stored in this repo.
3. **Telegram bot token**: create a new bot in BotFather, set it as
   the Worker secret `TELEGRAM_BOT_TOKEN` (`wrangler secret put`).
   Owner chat id is already configured: `736161596`.
4. **D1**: `wrangler d1 create emailsaty-db`, paste the id into
   `wrangler.toml`, run `schema.sql`.
5. Decisions still open: mailbox retention (currently: keep until
   owner deletes), whether to enable the mail.tm fallback, and
   whether sending (Stage 7) is wanted at all.

## Local test results (Stage 1) — verified 2026-11-17

- `node --test tests/lib.test.mjs tests/worker.test.mjs` — **19/19 pass, 0 fail**
  (11 lib tests + 8 worker API tests with a mock D1).
- `./node_modules/.bin/tsc --noEmit` — **clean, no errors**.
- Frontend JS extracted from `index.html` — `node --check` — **OK**.
- Two real bugs were found and fixed during testing: (1) code extraction
  grabbed the word "Hello" after a "code" label — now a labelled match
  must contain a digit; (2) a bare year (2026) was mistaken for a
  4-digit code — unlabelled codes are now 5–8 digits only.
- Live receiving is **not** verified locally — it cannot be, without
  the new Cloudflare account + DNS. No claim is made that live mail
  works yet.
