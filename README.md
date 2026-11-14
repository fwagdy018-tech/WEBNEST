# WebNest — Lead Finder (BUILDORA)

One page: pick a category, location, rating filters and website conditions, enter how many leads you
want, press **Start Search**. WebNest finds real businesses through the Google Places API, inspects
their websites, removes businesses that are already in your spreadsheet, and appends the new ones to
one central Google Sheet.

It is deliberately **not** a CRM: no contacts management, pipelines, messaging, or dashboards.

---

## 1. Setup (about 20 minutes)

### 1.1 Install and run

```bash
npm install
cp .env.example .env.local     # then fill it in (steps below)
npm run check:apis             # verifies every key with one real request
npm run dev                    # http://localhost:3000
```

### 1.2 Google Cloud — API keys

1. In [Google Cloud Console](https://console.cloud.google.com/) create (or pick) a project with billing enabled.
2. **APIs & Services → Library**, enable:
   - **Places API (New)**
   - **PageSpeed Insights API**
   - **Google Sheets API**
3. **APIs & Services → Credentials → Create credentials → API key.**
   Restrict the key to *Places API (New)* and *PageSpeed Insights API*.
   Put it in `GOOGLE_PLACES_API_KEY` and `PAGESPEED_API_KEY` (one key can serve both).

### 1.3 Google Sheets — service account

1. **Credentials → Create credentials → Service account** (no roles needed).
2. Open it → **Keys → Add key → JSON**. From the downloaded file copy:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (keep the quotes and the `\n` sequences)
3. Create one Google Sheet for all leads. Copy the ID from its URL
   (`docs.google.com/spreadsheets/d/<ID>/edit`) into `GOOGLE_SHEET_ID`.
4. **Share the sheet with the service-account email as Editor.**

WebNest creates the `Leads` tab (or `GOOGLE_SHEET_TAB`) and the header row automatically.
You can reorder columns, add your own columns, and edit cells — WebNest matches columns by header
name and never overwrites a non-empty cell.

### 1.4 Supabase

1. In your Supabase project open **SQL Editor**, paste `supabase/schema.sql`, run it.
2. **Project Settings → API**: copy the project URL → `SUPABASE_URL`, and the
   **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never `NEXT_PUBLIC_`).

Without Supabase, WebNest falls back to a local file (`.webnest-data/`). That is fine for running on
your own computer, but use Supabase for any deployment.

### 1.5 Deploying (optional)

- Set all variables in your host (e.g. Vercel → Project → Environment Variables).
- **Set `WEBNEST_PASSWORD`** so strangers cannot use your API quota (browser asks for it; any username).
- The step endpoint sets `maxDuration = 300` s. A single step is one Places page or ≤ 4 website
  audits, so it normally finishes in under 2 minutes; on hosts with shorter limits, steps that time
  out are simply retried.

If Google Sheets is not configured, nothing is claimed as exported: the summary says so and a
**Download CSV** button gives you the batch's leads (deduplicated within that search only).

---

## 2. How a search works

| Phase | What happens |
|---|---|
| Searching for businesses | The state (or each city you typed) is located on the map, then searched as a grid of map tiles with Google Places Text Search. Any tile that returns a full page (20+) is split into 4 smaller tiles and searched again |
| Collecting business information | Keeps only `OPERATIONAL` businesses in the chosen state with rating ≥ min and reviews ≥ min |
| Checking for duplicates | Compares each candidate with **every row** of the sheet before spending audit quota |
| Auditing websites | Website inspection + PageSpeed mobile & desktop for new businesses with a website |
| Exporting | Takes a global lock, re-reads the whole sheet, updates duplicates, appends new rows |

Searches are saved after every step. If an API fails, the step is retried automatically; after
repeated failures the search pauses with the error shown and a **Resume** button. Closing the tab is
safe — reopen the URL (`/?batch=<id>`) to continue.

**Whole-state coverage.** Google returns at most 60 results per search, so WebNest never relies on
one search per state. Leave *City / target area* empty and the whole state is covered tile by tile;
busy areas keep being split (down to ~2 km tiles) until Google returns less than a full page.
This finds essentially everything Google lists for that category, but it is still limited to what
Google's search returns. A state-wide search can use hundreds to thousands of billed Places requests;
the progress screen shows the count, and `MAX_PLACES_REQUESTS_PER_SEARCH` (default 5000) stops a
runaway search.

**All businesses / manual review.** Tick *All businesses found* to remove the lead limit, and
*Export every business — I'll check them one by one* to skip website audits: every business that
passes the rating/review/location filters is exported (duplicates are still removed). In that mode
Website Status is `No website found` or `Not verified` and Quality is left empty.

### Fields and where they come from

| Column | Source |
|---|---|
| Business Name, Phone, Address, City, State / Province, Country, Rating, Reviews Count, Website URL, Google Maps Link | Google Places API (New) |
| Email | Only an address publicly shown on the business's own website (homepage or its contact page). Left empty otherwise — never guessed |
| Website Status, Website Quality, Audit Notes | WebNest's inspection |
| Mobile / Desktop PageSpeed | Official PageSpeed Insights API (performance score 0–100) |
| Data Source, Source URL | `Google Places API (New)` + the place's Google Maps URL |
| Date Found, Search Batch ID | When/which search first added the row (never changed later) |
| Last Seen Date, Last Seen Batch ID | Updated each time a later search finds the same business |
| Google Place ID | Stable Google identifier, used for reliable duplicate matching |

### Website Status (what we know)

- **No website found** — Google lists no website. This is *not* proof the business has none.
- **Confirmed unavailable** — domain doesn't resolve, homepage returns 404/410, or the domain is parked/expired/suspended.
- **Inaccessible during inspection** — timeout, connection refused, server error, SSL error. May be temporary.
- **Accessible** — homepage loaded and was inspected.
- **Not verified** — inspection blocked (bot protection — never bypassed), unsafe URL, or non-HTML response.

### Website Quality (what we think of it)

- **Outdated** — Flash/frames, or ≥ 2 of: no mobile viewport, copyright ≥ 4 years old, `<font>`/`<center>` tags, table layout, jQuery < 1.9, old generator (FrontPage, WordPress < 5…), HTML4/XHTML doctype.
- **Poor** — any of: no HTTPS, not mobile-friendly, visible errors, "under construction", broken internal links (sample of 6), no contact info, almost no content.
- **Broken / Inaccessible** — see Confirmed unavailable / Inaccessible above, or a default server page.
- **Unverified** — could not be evaluated (e.g. JavaScript-only page, blocked inspection).
- **Good** — none of the above found.

PageSpeed is recorded and noted but **never on its own** makes a site Outdated or Poor.
Visual design is **not** judged by a human or AI — every row's Audit Notes says
"Visual design not reviewed by a human — automated checks only". Treat *Good* as "no problems
detected", and glance at sites before you call.

### Duplicate detection

Before any row is written, the new business is matched against **all** rows in the sheet, in this order:

1. Google Place ID
2. Phone number (normalized to E.164, e.g. `(512) 555-0100` = `+1 512-555-0100`)
3. Website domain (`www.`, `http/https`, paths ignored; for Facebook/Instagram/booking-platform links the path is kept so different businesses on the same platform don't collide)
4. Business name + full address (normalized: `Street`=`St`, `LLC`/`Inc` ignored, …)
5. Business name + city + state/province

If it matches, **no row is added**. Empty cells in the existing row are filled with the new verified
values; non-empty cells (including anything you typed) are never changed. Date Found / Search
Batch ID stay as they were; Last Seen Date / Last Seen Batch ID are updated.

**Concurrency:** exports run under a Supabase lock (`webnest_try_lock`), and each export re-reads the
full sheet while holding it, so two searches running at the same time cannot add the same business
twice. If an export is interrupted after writing, re-running it recognizes its own rows by batch ID.

---

## 3. Security

- All keys are read server-side from environment variables; the browser only sees
  configured/not-configured booleans (`/api/config`).
- Website inspection is SSRF-protected (`lib/safeFetch.ts`): http(s) on ports 80/443 only, no
  credentials in URLs, internal hostnames refused, and every resolved IP (checked at connect time,
  so DNS rebinding doesn't work) plus every redirect hop is validated against private, loopback,
  link-local/metadata, and reserved ranges. Responses are size- and time-capped.
- Sheet writes use `valueInputOption=RAW` and CSV cells are escaped, so text from websites can
  never become a spreadsheet formula.
- Supabase tables have RLS enabled with no policies: only the server's service-role key can access them.
- `robots.txt` is respected for the extra pages WebNest reads (contact page, link checks).

## 4. Compliance notes — please read

- **Google Maps Platform terms** restrict how long Places content (phone, address, ratings…) may be
  stored outside Google; Place IDs are exempt. Exporting Places data into a permanent spreadsheet
  may conflict with those terms. Review the current
  [Google Maps Platform Terms](https://cloud.google.com/maps-platform/terms) and service-specific
  terms, or use a licensed business-data provider for long-term storage. WebNest stores the Place ID
  and Maps link so records can be refreshed from Google instead of kept indefinitely.
- **Costs:** Text Search with phone/website/rating fields is billed at Google's higher Places tier;
  PageSpeed Insights is free within its quota. Check current pricing in the Google Cloud console.
- Emails found on websites are business contact addresses published by the business itself. Follow
  anti-spam laws (CAN-SPAM, CASL in Canada, the Spam Act in Australia) when you contact them.

## 5. Project layout

```
app/page.tsx                 the single page (form, progress, summary)
app/api/search/...           create / step / status / resume / csv endpoints
lib/pipeline.ts              resumable search state machine + export with dedup
lib/places.ts                Google Places API (New) client
lib/audit.ts                 website inspection + classification
lib/pagespeed.ts             PageSpeed Insights client
lib/sheets.ts                Google Sheets client (service account, no SDK)
lib/dedupe.ts, normalize.ts  matching rules
lib/safeFetch.ts             SSRF-safe HTTP client
lib/store/                   Supabase store (+ local file fallback)
supabase/schema.sql          tables + lock functions
scripts/check-apis.ts        `npm run check:apis`
tests/                       `npm test`
```

## 6. Tests

```bash
npm test          # 21 tests: normalization, duplicate matching, SSRF, classification,
                  # and full pipeline runs with fake APIs (incl. two concurrent searches)
npm run check:apis   # real requests against your configured Google / Supabase accounts
```
