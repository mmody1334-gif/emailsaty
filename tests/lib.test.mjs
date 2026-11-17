// Unit tests for src/lib.ts — run with: node --test tests/
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DOMAINS,
  PUBLIC_FALLBACK_DOMAINS,
  extractVerificationCode,
  generateAddress,
  generateLogin,
  generateToken,
  isBlockedLocalPart,
  parseRawEmail,
  validateAddress,
  validateLogin,
} from "../src/lib.ts";

test("primary domain is only mail.elkabsula.site (free, no paid domain)", () => {
  assert.deepEqual([...DEFAULT_DOMAINS], ["mail.elkabsula.site"]);
});

test("mail.tm is only an optional shared/public fallback, never primary", () => {
  assert.ok(!DEFAULT_DOMAINS.includes("mail.tm"));
  assert.deepEqual([...PUBLIC_FALLBACK_DOMAINS], ["mail.tm"]);
});

test("no .edu domain anywhere in the config", () => {
  for (const d of [...DEFAULT_DOMAINS, ...PUBLIC_FALLBACK_DOMAINS]) {
    assert.ok(!d.endsWith(".edu"), d);
  }
});

test("extractVerificationCode: labelled and standalone codes", () => {
  assert.equal(extractVerificationCode("Your verification code is 123456"), "123456");
  assert.equal(extractVerificationCode("رمز التحقق: 987654"), "987654");
  assert.equal(extractVerificationCode("Welcome! Here is 42"), null); // too short, no code
  assert.equal(extractVerificationCode("Your code: 3COTZ5"), "3COTZ5");
  assert.equal(extractVerificationCode("Order 1234567890 shipped in 2026"), null); // long numbers ignored
});

test("extractVerificationCode: 4-digit code", () => {
  assert.equal(extractVerificationCode("code 4815"), "4815");
});

test("blocked local parts (temp-mail.org parity)", () => {
  for (const bad of ["abuse", "admin", "postmaster", "hostmaster", "webmaster", "contact"]) {
    assert.equal(isBlockedLocalPart(bad), true, bad);
    assert.equal(validateLogin(bad).ok, false, bad);
  }
  assert.equal(isBlockedLocalPart("mohamed"), false);
});

test("validateLogin rules", () => {
  assert.equal(validateLogin("ab").ok, false); // too short
  assert.equal(validateLogin("a".repeat(33)).ok, false); // too long
  assert.equal(validateLogin("hello world").ok, false); // space
  assert.equal(validateLogin("mohamed2026").ok, true);
  assert.equal(validateLogin("megoooo").ok, true);
});

test("validateAddress rejects other domains and bad addresses", () => {
  assert.equal(validateAddress("x@mail.elkabsula.site", DEFAULT_DOMAINS).ok, false); // login too short
  assert.equal(validateAddress("abc123@mail.elkabsula.site", DEFAULT_DOMAINS).ok, true);
  assert.equal(validateAddress("abc123@evil.com", DEFAULT_DOMAINS).ok, false);
  assert.equal(validateAddress("abc123@something.edu", DEFAULT_DOMAINS).ok, false);
  assert.equal(validateAddress("not-an-address", DEFAULT_DOMAINS).ok, false);
});

test("generateLogin / generateToken are random and valid", () => {
  const logins = new Set(Array.from({ length: 50 }, () => generateLogin()));
  assert.equal(logins.size, 50);
  for (const l of logins) assert.equal(validateLogin(l).ok, true, l);
  const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
  assert.equal(tokens.size, 50);
  for (const t of tokens) assert.ok(t.length >= 32);
  // Token is NOT derived from the address (unlike md5(email)).
  assert.notEqual(generateToken(), generateToken());
  assert.equal(generateAddress("Megoooo", "MAIL.ELKABSULA.SITE"), "megoooo@mail.elkabsula.site");
});

test("parseRawEmail: plain text + code extraction", () => {
  const raw = [
    "From: noreply@example.com",
    "To: abc123@mail.elkabsula.site",
    "Subject: Your code",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello, your verification code is 654321. Thanks!",
  ].join("\r\n");
  const p = parseRawEmail(raw);
  assert.equal(p.from, "noreply@example.com");
  assert.equal(p.to, "abc123@mail.elkabsula.site");
  assert.equal(p.subject, "Your code");
  assert.equal(p.code, "654321");
  assert.match(p.bodyText, /654321/);
});

test("parseRawEmail: multipart/alternative prefers text/plain", () => {
  const raw = [
    "From: a@b.com",
    "To: abc123@mail.elkabsula.site",
    "Subject: Hi",
    'Content-Type: multipart/alternative; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain",
    "",
    "plain code 112233",
    "--B1",
    "Content-Type: text/html",
    "",
    "<p>html code 445566</p>",
    "--B1--",
  ].join("\r\n");
  const p = parseRawEmail(raw);
  assert.equal(p.code, "112233");
  assert.match(p.bodyText, /112233/);
  assert.match(p.bodyHtml ?? "", /445566/);
});
