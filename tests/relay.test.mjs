// Relay Worker tests — run with: node --test tests/
// Covers: forwards parsed mail to the ingest URL with the secret
// (header + body), throws on ingest 500 (honest reject), rejects
// blocked addresses without calling ingest.
import assert from "node:assert/strict";
import test from "node:test";
import relay from "../src/relay-worker.ts";

const ENV = {
  INGEST_URL: "https://emailsaty.test.workers.dev/api/ingest",
  INGEST_SECRET: "relay-secret-123",
};

const RAW = [
  "From: noreply@some-site.com",
  "To: relaybox@mail.elkabsula.site",
  "Subject: Verify your account",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your verification code is 778899. It expires soon.",
].join("\r\n");

function message() {
  let rejected = null;
  return {
    msg: {
      to: "relaybox@mail.elkabsula.site",
      from: "noreply@some-site.com",
      headers: new Map([["subject", "Verify your account"]]),
      raw: RAW,
      setReject: (m) => { rejected = m; },
    },
    get rejected() { return rejected; },
  };
}

function stubFetch(t, response) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("relay forwards parsed mail to ingest with secret header + body", async (t) => {
  const calls = stubFetch(t, { ok: true, status: 200 });
  const { msg } = message();
  await relay.email(msg, ENV);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENV.INGEST_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-ingest-secret"], ENV.INGEST_SECRET);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.to, "relaybox@mail.elkabsula.site");
  assert.equal(body.sender, "noreply@some-site.com");
  assert.equal(body.subject, "Verify your account");
  assert.match(body.body_text, /778899/);
  assert.equal(body.code, "778899");
  assert.equal(body.secret, ENV.INGEST_SECRET);
  assert.ok(body.received_at);
});

test("relay throws when ingest returns 500", async (t) => {
  stubFetch(t, { ok: false, status: 500 });
  const { msg } = message();
  await assert.rejects(() => relay.email(msg, ENV), /ingest rejected.*500/);
});

test("relay throws when the ingest fetch itself fails", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  t.after(() => { globalThis.fetch = original; });
  const { msg } = message();
  await assert.rejects(() => relay.email(msg, ENV), /ingest fetch failed/);
});

test("relay rejects a blocked address without calling ingest", async (t) => {
  const calls = stubFetch(t, { ok: true, status: 200 });
  const m = message();
  m.msg.to = "admin@mail.elkabsula.site";
  m.msg.raw = RAW.replace("relaybox@mail.elkabsula.site", "admin@mail.elkabsula.site");
  await relay.email(m.msg, ENV);
  assert.equal(calls.length, 0);
  assert.ok(m.rejected && m.rejected.includes("550"));
});

test("relay throws when INGEST_URL is still the placeholder", async (t) => {
  stubFetch(t, { ok: true, status: 200 });
  const { msg } = message();
  await assert.rejects(
    () => relay.email(msg, { ...ENV, INGEST_URL: "PLACEHOLDER_INGEST_URL" }),
    /INGEST_URL is not configured/,
  );
});
