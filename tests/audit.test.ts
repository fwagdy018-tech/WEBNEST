import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeHtml, classify, extractEmails, type ExtraChecks } from "../lib/audit";

const NOW = new Date("2026-11-14T00:00:00Z");
const extra = (o: Partial<ExtraChecks> = {}): ExtraChecks => ({
  brokenLinks: [], linksChecked: 5, mobile: { score: 80 }, desktop: { score: 95 }, contactPageEmails: [], contactPagePhone: false, ...o,
});
const filler = "<p>" + "We offer professional detailing services for cars, trucks and SUVs across town. ".repeat(10) + "</p>";

const modern = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shine Detailing</title></head>
<body><nav><a href="/services">Services</a><a href="/contact">Contact us</a></nav>${filler}
<a href="tel:+15125550100">(512) 555-0100</a> <a href="mailto:book@shinedetailing.com">Email</a><footer>© 2026 Shine</footer></body></html>`;

const old = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head><title>Bob's Barbers</title>
<meta name="generator" content="Microsoft FrontPage 4.0"></head><body><table width="800" bgcolor="#fff"><tr><td><font face="Arial">
<center>Welcome!</center></font></td></tr></table><table width="800" border="0"><tr><td><font>Call 512-555-0199</font></td></tr></table>${filler}
<p>Copyright 2014 Bob's</p></body></html>`;

test("modern responsive site with contact info is Good (with visual caveat)", () => {
  const s = analyzeHtml(modern, "https://shinedetailing.com/", NOW);
  assert.equal(s.hasViewport, true);
  assert.equal(s.copyrightYear, 2026);
  assert.deepEqual(s.emails, ["book@shinedetailing.com"]);
  assert.ok(s.contactLink?.endsWith("/contact"));
  const c = classify(s, "https://shinedetailing.com/", extra(), NOW);
  assert.equal(c.quality, "Good");
  assert.ok(c.notes.some((n) => /not reviewed by a human/.test(n)));
});

test("legacy site is Outdated based on design signals", () => {
  const s = analyzeHtml(old, "http://bobsbarbers.com/", NOW);
  const c = classify(s, "http://bobsbarbers.com/", extra(), NOW);
  assert.equal(c.quality, "Outdated");
  assert.ok(c.notes.join(" ").includes("copyright year 2014"));
});

test("low PageSpeed alone never makes a site Outdated or Poor", () => {
  const s = analyzeHtml(modern, "https://shinedetailing.com/", NOW);
  const c = classify(s, "https://shinedetailing.com/", extra({ mobile: { score: 12 }, desktop: { score: 20 } }), NOW);
  assert.equal(c.quality, "Good");
});

test("missing viewport + no https + broken links => Poor", () => {
  const html = modern.replace(/<meta name="viewport"[^>]+>/, "");
  const s = analyzeHtml(html, "http://shinedetailing.com/", NOW);
  const c = classify(s, "http://shinedetailing.com/", extra({ brokenLinks: ["http://shinedetailing.com/services"] }), NOW);
  assert.ok(c.quality === "Poor" || c.quality === "Outdated");
  assert.match(c.notes.join(" "), /no HTTPS/);
  assert.match(c.notes.join(" "), /internal links broken/);
});

test("parked domains are Confirmed unavailable", () => {
  const s = analyzeHtml("<html><head><title>shine.com</title></head><body>This domain is for sale! Buy this domain.</body></html>", "https://shine.com/", NOW);
  const c = classify(s, "https://shine.com/", extra(), NOW);
  assert.equal(c.status, "Confirmed unavailable");
  assert.equal(c.quality, "Broken / Inaccessible");
});

test("JS-only shell pages are Unverified, not Good", () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>App</title></head><body><div id="root"></div><a href="/a">a</a><a href="/b">b</a><a href="/contact">Contact</a><script src="/app.js"></script></body></html>`;
  const s = analyzeHtml(html, "https://x.com/", NOW);
  assert.equal(classify(s, "https://x.com/", extra(), NOW).quality, "Unverified");
});

test("email extraction decodes Cloudflare obfuscation and skips junk", () => {
  // "info@shop.com" XOR-encoded with key 0x42
  const key = 0x42;
  const hex = key.toString(16) + [..."info@shop.com"].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
  const html = `<a data-cfemail="${hex}">[email protected]</a> <img src="logo@2x.png"> user@example.com`;
  assert.deepEqual(extractEmails(html, "logo@2x.png user@example.com"), ["info@shop.com"]);
});
