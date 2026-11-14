/**
 * SSRF-safe HTTP fetch for inspecting third-party business websites.
 *
 * - Only http/https on ports 80/443, no credentials in the URL.
 * - Hostnames like localhost / *.local / single-label names are refused.
 * - IP literals and EVERY resolved DNS address are checked against private,
 *   loopback, link-local (cloud metadata), multicast and reserved ranges.
 *   The check runs inside the socket's DNS lookup, so DNS rebinding between
 *   "check" and "connect" is not possible.
 * - Redirects are followed manually and each hop is re-validated.
 * - Response size and total time are capped.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockList.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockList.addSubnet(addr, prefix, "ipv6");

/** IPv4 address embedded in an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:7f00:1). */
function mappedIpv4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const hex = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return blockList.check(ip, "ipv4");
  if (net.isIPv6(ip)) {
    const v4 = mappedIpv4(ip);
    if (v4) return isBlockedIp(v4);
    return blockList.check(ip, "ipv6");
  }
  return true;
}

export class UrlRejectedError extends Error {
  code = "EBLOCKED";
}

/** Validate a URL before any network activity. Throws UrlRejectedError. */
export function validatePublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlRejectedError("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UrlRejectedError("Only http(s) URLs are inspected");
  if (u.username || u.password) throw new UrlRejectedError("URLs with credentials are not inspected");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UrlRejectedError("Non-standard port");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new UrlRejectedError("Private or reserved IP address");
  } else {
    if (!host.includes(".")) throw new UrlRejectedError("Single-label hostname");
    if (/(^|\.)(localhost|local|internal|intranet|home|lan|corp|localdomain)$/.test(host)) {
      throw new UrlRejectedError("Internal hostname");
    }
  }
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!addresses.length) return cb(Object.assign(new Error("No addresses"), { code: "ENOTFOUND" }));
    if (addresses.some((a) => isBlockedIp(a.address))) {
      return cb(Object.assign(new Error("Resolved to a private or reserved address"), { code: "EBLOCKED" }));
    }
    if (options?.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  url: string;
  body: string;
  truncated: boolean;
}

export type FetchErrorKind = "dns_not_found" | "dns_temporary" | "blocked" | "timeout" | "refused" | "reset" | "tls" | "other";

export class SafeFetchError extends Error {
  constructor(public kind: FetchErrorKind, message: string) {
    super(message);
  }
}

export function classifyNetworkError(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? "";
  const msg = e?.message ?? String(err);
  if (err instanceof UrlRejectedError || code === "EBLOCKED") return new SafeFetchError("blocked", msg);
  if (code === "ENOTFOUND") return new SafeFetchError("dns_not_found", "Domain does not resolve (DNS)");
  if (code === "EAI_AGAIN") return new SafeFetchError("dns_temporary", "Temporary DNS failure");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return new SafeFetchError("timeout", "Timed out");
  if (code === "ECONNREFUSED") return new SafeFetchError("refused", "Connection refused");
  if (code === "ECONNRESET" || code === "EPIPE") return new SafeFetchError("reset", "Connection reset");
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code + " " + msg)) {
    return new SafeFetchError("tls", "SSL/TLS certificate or handshake error");
  }
  return new SafeFetchError("other", msg);
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; WebNestSiteCheck/1.0; website quality check)";

function requestOnce(
  url: URL,
  method: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method,
        lookup: safeLookup as unknown as typeof dns.lookup,
        agent: false,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
        },
      },
      (res) => {
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
        stream.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            finish();
            return;
          }
          chunks.push(c);
        });
        stream.on("end", finish);
        stream.on("error", (err) => (truncated ? undefined : reject(err)));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(
  rawUrl: string,
  opts: { method?: "GET" | "HEAD"; timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
): Promise<SafeResponse> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const deadline = Date.now() + timeoutMs * 2;

  let url = validatePublicUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("timeout", "Timed out (redirect chain)");
    let res;
    try {
      res = await requestOnce(url, method, Math.min(timeoutMs, remaining), maxBytes);
    } catch (err) {
      throw classifyNetworkError(err);
    }
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop >= maxRedirects) throw new SafeFetchError("other", "Too many redirects");
      try {
        url = validatePublicUrl(new URL(loc, url).toString());
      } catch (err) {
        throw classifyNetworkError(err);
      }
      continue;
    }
    return {
      status: res.status,
      headers: res.headers,
      url: url.toString(),
      body: res.body.toString("utf8"),
      truncated: res.truncated,
    };
  }
}
