import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { isBlockedIp, safeFetch, SafeFetchError, validatePublicUrl } from "../lib/safeFetch";

test("private, loopback, metadata and reserved IPs are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "142.250.80.46", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedIp(ip), false, ip);
});

test("unsafe URLs are rejected before any request", () => {
  for (const u of [
    "file:///etc/passwd", "ftp://example.com", "http://localhost/", "http://127.0.0.1/", "http://2130706433/",
    "http://0x7f.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://user:pw@example.com/",
    "http://example.com:8080/", "http://intranet/", "http://printer.local/", "http://[::ffff:7f00:1]/",
  ]) {
    assert.throws(() => validatePublicUrl(u), Error, u);
  }
  assert.equal(validatePublicUrl("https://example.com/path").hostname, "example.com");
});

test("redirects to internal addresses are refused", async () => {
  // The local server itself is unreachable (blocked IP), proving the connect-time check works.
  const server = http.createServer((_req, res) => res.writeHead(302, { location: "http://169.254.169.254/" }).end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), (e: unknown) => e instanceof Error);
  server.close();
});

test("DNS names resolving to loopback are refused at connect time", async () => {
  // localtest.me publicly resolves to 127.0.0.1. If DNS is unavailable here the error is a DNS error instead.
  await assert.rejects(safeFetch("http://localtest.me/"), (e: unknown) => e instanceof SafeFetchError && ["blocked", "dns_not_found", "dns_temporary"].includes(e.kind));
});
