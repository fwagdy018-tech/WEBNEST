/**
 * Website inspection and classification.
 *
 * What is checked automatically (from the site's own HTML):
 *  - reachability, HTTPS, parked / suspended / default-server pages
 *  - mobile viewport, legacy markup (frames, Flash, <font>, table layouts),
 *    old jQuery / generators / doctypes, stale copyright year
 *  - contact info (phone, email, contact page), visible errors, broken
 *    internal links (small sample)
 *  - PageSpeed Insights mobile + desktop scores (supporting evidence only)
 *
 * What is NOT checked: human judgement of visual design. Every audit note
 * says so, and a site whose content cannot be read statically is
 * "Unverified" rather than "Good".
 */
import { runPageSpeed, type PageSpeedResult } from "./pagespeed";
import { safeFetch, SafeFetchError, validatePublicUrl, type SafeResponse } from "./safeFetch";
import type { WebsiteQuality, WebsiteStatus } from "./types";

export interface AuditResult {
  websiteStatus: WebsiteStatus;
  websiteQuality: WebsiteQuality;
  mobileScore: number | null;
  desktopScore: number | null;
  email: string;
  notes: string[];
}

// ---------------------------------------------------------------- HTML analysis

export interface HtmlSignals {
  title: string;
  textLength: number;
  hasViewport: boolean;
  copyrightYear: number | null;
  flash: boolean;
  frames: boolean;
  legacyTagCount: number;
  tableLayout: boolean;
  oldJquery: string | null;
  oldGenerator: string | null;
  oldDoctype: boolean;
  phoneFound: boolean;
  emails: string[];
  contactLink: string | null;
  internalLinks: string[];
  visibleError: string | null;
  underConstruction: boolean;
  defaultServerPage: boolean;
  parked: string | null;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", commat: "@" };

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] ?? m);
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Decode Cloudflare's email obfuscation (publicly displayed emails). */
function decodeCfEmail(hex: string): string {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return "";
  }
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const BAD_EMAIL = /(\.(png|jpe?g|gif|svg|webp|css|js)$)|example\.|sentry|wixpress|domain\.com|yourdomain|youremail|email\.com|^name@|^user@|^your@|@2x|godaddy\.com|squarespace\.com|schema\.org|w3\.org/i;

export function extractEmails(html: string, text: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) {
    try {
      found.add(decodeURIComponent(m[1]).trim().toLowerCase());
    } catch {
      /* ignore malformed */
    }
  }
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) found.add(decodeCfEmail(m[1]).toLowerCase());
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());
  return [...found].filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e) && !BAD_EMAIL.test(e));
}

const PHONE_RE = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|(\+?61|\b0)[2-478](?:[ -]?\d){8}\b/;

function extractLinks(html: string, baseUrl: string): { internal: string[]; contact: string | null } {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./, "");
  const internal = new Set<string>();
  let contact: string | null = null;
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].trim();
    if (/^(mailto|tel|javascript|data|sms):/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hostname.replace(/^www\./, "") !== baseHost) continue;
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|docx?|xlsx?)$/i.test(u.pathname)) continue;
    u.hash = "";
    const s = u.toString();
    if (s === base.toString()) continue;
    internal.add(s);
    const label = htmlToText(m[2]).toLowerCase();
    if (!contact && (/contact/i.test(u.pathname) || /contact/.test(label))) contact = s;
  }
  return { internal: [...internal], contact };
}

export function analyzeHtml(html: string, finalUrl: string, now: Date = new Date()): HtmlSignals {
  const text = htmlToText(html);
  const head = html.slice(0, 20_000);
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()).slice(0, 200);
  const year = now.getUTCFullYear();

  let copyrightYear: number | null = null;
  for (const m of text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?((?:19|20)\d{2})/gi)) {
    const y = Number(m[1]);
    if (y <= year + 1 && (copyrightYear === null || y > copyrightYear)) copyrightYear = y;
  }
  // Sites that print the current year via JavaScript often show nothing statically.
  if (/new Date\(\)\.getFullYear\(\)/.test(html) && copyrightYear !== null && copyrightYear < year) copyrightYear = null;

  const jq = html.match(/jquery[/.-]?(?:min[.-])?v?(\d+)\.(\d+)(?:\.\d+)?(?:\.min)?\.js/i);
  const oldJquery = jq && Number(jq[1]) === 1 && Number(jq[2]) < 9 ? `${jq[1]}.${jq[2]}` : null;

  const gen = head.match(/<meta[^>]+name\s*=\s*["']generator["'][^>]*content\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
  let oldGenerator: string | null = null;
  if (/frontpage|dreamweaver|iweb|publisher|homestead|netobjects|joomla! 1\.|drupal [4-6]\b/i.test(gen)) oldGenerator = gen;
  const wp = gen.match(/wordpress (\d+)\./i);
  if (wp && Number(wp[1]) < 5) oldGenerator = gen;

  const doctype = html.slice(0, 500).match(/<!doctype[^>]*>/i)?.[0] ?? "";
  const oldDoctype = /html 4\.0|xhtml 1\.0 transitional|html 3\.2/i.test(doctype);

  const { internal, contact } = extractLinks(html, finalUrl);

  const visibleError =
    text.match(
      /(Fatal error:[^.]{0,80}|Parse error:[^.]{0,80}|Warning: [^.]{0,60} on line \d+|Error establishing a database connection|Database Error|Internal Server Error|404 Not Found|Page not found)/i,
    )?.[0] ?? null;

  const parked =
    (text + " " + title).match(
      /(this domain (?:name )?(?:may be |is )?for sale|buy this domain|domain (?:name )?is for sale|parked (?:free|domain)|this account has been suspended|account suspended|website (?:is )?(?:expired|suspended)|domain (?:has )?expired)/i,
    )?.[0] ??
    (/(sedoparking|parkingcrew|bodis\.com|hugedomains|dan\.com\/buy|afternic)/i.test(html) ? "parking service" : null);

  return {
    title,
    textLength: text.length,
    hasViewport: /<meta[^>]+name\s*=\s*["']?viewport/i.test(html),
    copyrightYear,
    flash: /<(object|embed)[^>]+(\.swf|shockwave)/i.test(html),
    frames: /<frameset\b|<frame\s/i.test(html),
    legacyTagCount: (html.match(/<(font|center|marquee|blink)\b/gi) ?? []).length,
    tableLayout: (html.match(/<table[^>]*\b(width|bgcolor|cellpadding|cellspacing|border)\s*=/gi) ?? []).length >= 2,
    oldJquery,
    oldGenerator,
    oldDoctype,
    phoneFound: /href\s*=\s*["']tel:/i.test(html) || PHONE_RE.test(text),
    emails: extractEmails(html, text),
    contactLink: contact,
    internalLinks: internal.slice(0, 40),
    visibleError,
    underConstruction: /(under construction|coming soon|site is being (?:built|updated))/i.test(text.slice(0, 3000) + " " + title),
    defaultServerPage:
      /^(index of \/|it works!?|welcome to nginx!?|apache2 \w+ default page|iis windows server|default web site page)/i.test(title) ||
      /(welcome to nginx!|apache2 (ubuntu|debian) default page)/i.test(text.slice(0, 500)),
    parked,
  };
}

// ---------------------------------------------------------------- classification

export interface ExtraChecks {
  brokenLinks: string[];
  linksChecked: number;
  mobile: PageSpeedResult;
  desktop: PageSpeedResult;
  contactPageEmails: string[];
  contactPagePhone: boolean;
}

export function classify(
  s: HtmlSignals,
  finalUrl: string,
  extra: ExtraChecks,
  now: Date = new Date(),
): { quality: WebsiteQuality; status: WebsiteStatus; notes: string[] } {
  const notes: string[] = [];
  const year = now.getUTCFullYear();

  if (s.parked) return { status: "Confirmed unavailable", quality: "Broken / Inaccessible", notes: [`Domain parked/expired/suspended ("${s.parked}")`] };
  if (s.defaultServerPage) return { status: "Accessible", quality: "Broken / Inaccessible", notes: ["Server default page — no real website content"] };

  // Outdated design signals (never based on PageSpeed).
  const outdated: string[] = [];
  if (s.flash) outdated.push("uses Flash");
  if (s.frames) outdated.push("uses HTML frames");
  if (!s.hasViewport) outdated.push("no mobile viewport (not responsive)");
  if (s.copyrightYear !== null && s.copyrightYear <= year - 4) outdated.push(`copyright year ${s.copyrightYear}`);
  if (s.legacyTagCount >= 3) outdated.push(`legacy tags (<font>/<center>) x${s.legacyTagCount}`);
  if (s.tableLayout) outdated.push("table-based layout");
  if (s.oldJquery) outdated.push(`jQuery ${s.oldJquery}`);
  if (s.oldGenerator) outdated.push(`built with "${s.oldGenerator}"`);
  if (s.oldDoctype) outdated.push("HTML4/XHTML doctype");

  // Quality / UX problems.
  const poor: string[] = [];
  if (!finalUrl.startsWith("https:")) poor.push("no HTTPS");
  if (!s.hasViewport) poor.push("not mobile-friendly (no viewport)");
  if (s.visibleError) poor.push(`visible error: "${s.visibleError.slice(0, 60)}"`);
  if (s.underConstruction) poor.push("under construction / coming soon");
  if (extra.brokenLinks.length) poor.push(`${extra.brokenLinks.length}/${extra.linksChecked} sampled internal links broken`);
  const hasPhone = s.phoneFound || extra.contactPagePhone;
  const hasEmail = s.emails.length > 0 || extra.contactPageEmails.length > 0;
  if (!hasPhone && !hasEmail && !s.contactLink) poor.push("no contact information found");
  if (s.textLength < 150 && s.internalLinks.length < 2) poor.push("almost no content");

  const lowSpeed = extra.mobile.score !== null && extra.mobile.score < 30;
  if (extra.mobile.score !== null || extra.desktop.score !== null) {
    notes.push(`PageSpeed mobile ${extra.mobile.score ?? "n/a"}, desktop ${extra.desktop.score ?? "n/a"}`);
  }
  if (extra.mobile.error) notes.push(extra.mobile.error);
  if (extra.desktop.error) notes.push(extra.desktop.error);

  const strongOutdated = s.flash || s.frames;
  let quality: WebsiteQuality;
  if (strongOutdated || outdated.length >= 2) quality = "Outdated";
  else if (poor.length >= 1 || (lowSpeed && outdated.length >= 1)) quality = "Poor";
  else if (s.textLength < 300) {
    quality = "Unverified";
    notes.push("Content is rendered by JavaScript; static checks could not evaluate the page");
  } else quality = "Good";

  if (outdated.length) notes.push(`Outdated signals: ${outdated.join(", ")}`);
  if (poor.length) notes.push(`Issues: ${poor.join(", ")}`);
  if (lowSpeed) notes.push("Very slow on mobile");
  notes.push("Visual design not reviewed by a human — automated checks only");
  return { status: "Accessible", quality, notes };
}

// ---------------------------------------------------------------- orchestration

async function robotsDisallows(origin: string): Promise<string[]> {
  try {
    const res = await safeFetch(origin + "/robots.txt", { timeoutMs: 6000, maxBytes: 100_000 });
    if (res.status !== 200) return [];
    const rules: string[] = [];
    let applies = false;
    let sawRule = false;
    for (const line of res.body.split(/\r?\n/)) {
      const [k, ...rest] = line.replace(/#.*/, "").split(":");
      const key = k.trim().toLowerCase();
      const val = rest.join(":").trim();
      if (key === "user-agent") {
        if (sawRule) {
          applies = false;
          sawRule = false;
        }
        if (val === "*" || /webnest/i.test(val)) applies = true;
      } else if (key === "disallow") {
        sawRule = true;
        if (applies && val) rules.push(val);
      } else if (key === "allow") sawRule = true;
    }
    return rules;
  } catch {
    return [];
  }
}

const allowedByRobots = (url: string, disallow: string[]) => {
  const p = new URL(url).pathname;
  return !disallow.some((d) => p.startsWith(d.replace(/\*.*$/, "")));
};

function statusFromNetworkError(err: SafeFetchError): { status: WebsiteStatus; quality: WebsiteQuality; note: string } {
  switch (err.kind) {
    case "blocked":
      return { status: "Not verified", quality: "Unverified", note: `URL not inspected for safety: ${err.message}` };
    case "dns_not_found":
      return { status: "Confirmed unavailable", quality: "Broken / Inaccessible", note: "Domain does not resolve (DNS lookup failed)" };
    case "tls":
      return { status: "Inaccessible during inspection", quality: "Broken / Inaccessible", note: "SSL certificate/handshake error — browsers show a security warning" };
    default:
      return { status: "Inaccessible during inspection", quality: "Broken / Inaccessible", note: `Could not load site: ${err.message} (may be temporary)` };
  }
}

function isBotChallenge(res: SafeResponse): boolean {
  if (res.headers["cf-mitigated"]) return true;
  if (res.status >= 200 && res.status < 300) return /<title>\s*(just a moment|attention required|access denied)/i.test(res.body);
  return /(cf-browser-verification|challenge-platform|captcha|just a moment|access denied|attention required)/i.test(res.body);
}

export async function auditWebsite(url: string): Promise<AuditResult> {
  const base: AuditResult = { websiteStatus: "Not verified", websiteQuality: "Unverified", mobileScore: null, desktopScore: null, email: "", notes: [] };
  try {
    validatePublicUrl(url);
  } catch (err) {
    return { ...base, notes: [`URL not inspected: ${(err as Error).message}`] };
  }

  let home: SafeResponse;
  try {
    home = await safeFetch(url);
  } catch (err) {
    const e = err instanceof SafeFetchError ? err : new SafeFetchError("other", String(err));
    const s = statusFromNetworkError(e);
    return { ...base, websiteStatus: s.status, websiteQuality: s.quality, notes: [s.note] };
  }

  if (isBotChallenge(home)) {
    return { ...base, notes: [`Site blocked automated inspection (HTTP ${home.status}, bot protection) — not bypassed`] };
  }
  if (home.status === 404 || home.status === 410) {
    return { ...base, websiteStatus: "Confirmed unavailable", websiteQuality: "Broken / Inaccessible", notes: [`Homepage returns HTTP ${home.status}`] };
  }
  if (home.status >= 500) {
    return { ...base, websiteStatus: "Inaccessible during inspection", websiteQuality: "Broken / Inaccessible", notes: [`Homepage returns HTTP ${home.status} (server error, may be temporary)`] };
  }
  if (home.status < 200 || home.status >= 300) {
    return { ...base, notes: [`Homepage returned HTTP ${home.status}; could not inspect`] };
  }
  const ctype = String(home.headers["content-type"] || "");
  if (ctype && !/html|xml|text\/plain/i.test(ctype)) {
    return { ...base, notes: [`Homepage is not HTML (${ctype.slice(0, 40)})`] };
  }

  const signals = analyzeHtml(home.body, home.url);
  if (signals.parked || signals.defaultServerPage) {
    const c = classify(signals, home.url, { brokenLinks: [], linksChecked: 0, mobile: { score: null }, desktop: { score: null }, contactPageEmails: [], contactPagePhone: false });
    return { ...base, websiteStatus: c.status, websiteQuality: c.quality, notes: c.notes };
  }

  const origin = new URL(home.url).origin;
  const disallow = await robotsDisallows(origin);

  const contactTask = (async () => {
    if (!signals.contactLink || signals.emails.length || !allowedByRobots(signals.contactLink, disallow)) {
      return { emails: [] as string[], phone: false };
    }
    try {
      const r = await safeFetch(signals.contactLink, { timeoutMs: 10_000, maxBytes: 1_000_000 });
      if (r.status !== 200) return { emails: [], phone: false };
      const s = analyzeHtml(r.body, r.url);
      return { emails: s.emails, phone: s.phoneFound };
    } catch {
      return { emails: [], phone: false };
    }
  })();

  const linkTask = (async () => {
    const sample = signals.internalLinks.filter((l) => allowedByRobots(l, disallow)).slice(0, 6);
    const broken: string[] = [];
    let checked = 0;
    await Promise.all(
      sample.map(async (link) => {
        try {
          let r = await safeFetch(link, { method: "HEAD", timeoutMs: 8000, maxBytes: 1000 });
          if (r.status === 405 || r.status === 501 || r.status === 403) r = await safeFetch(link, { timeoutMs: 8000, maxBytes: 64_000 });
          checked++;
          if (r.status === 404 || r.status === 410) broken.push(link);
        } catch {
          /* network errors on a single link are not counted either way */
        }
      }),
    );
    return { broken, checked };
  })();

  const [contact, links, mobile, desktop] = await Promise.all([
    contactTask,
    linkTask,
    runPageSpeed(home.url, "mobile"),
    runPageSpeed(home.url, "desktop"),
  ]);

  const c = classify(signals, home.url, {
    brokenLinks: links.broken,
    linksChecked: links.checked,
    mobile,
    desktop,
    contactPageEmails: contact.emails,
    contactPagePhone: contact.phone,
  });

  const emails = [...signals.emails, ...contact.emails];
  const host = new URL(home.url).hostname.replace(/^www\./, "");
  const email = emails.find((e) => e.endsWith("@" + host)) ?? emails[0] ?? "";

  return {
    websiteStatus: c.status,
    websiteQuality: c.quality,
    mobileScore: mobile.score,
    desktopScore: desktop.score,
    email,
    notes: c.notes,
  };
}
