"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CATEGORIES } from "@/lib/categories";
import { COUNTRIES, getCountry } from "@/lib/locations";
import type { BatchStatus, CountryCode, WebsiteCondition } from "@/lib/types";

const CUSTOM = "__custom__";

const CONDITIONS: { value: WebsiteCondition; label: string; hint: string; default: boolean }[] = [
  { value: "no_website", label: "No website found", hint: "Source lists no website (not proof none exists)", default: true },
  { value: "outdated", label: "Outdated website", hint: "Old design/tech signals, not just slow", default: true },
  { value: "poor", label: "Poor-quality website", hint: "Not mobile-friendly, errors, no HTTPS…", default: true },
  { value: "broken", label: "Broken / inaccessible", hint: "Dead domain, server errors, SSL errors", default: true },
  { value: "unverified", label: "Could not be verified", hint: "Blocked inspection or JS-only pages", default: false },
  { value: "good", label: "Good websites too", hint: "Only if you explicitly want them", default: false },
];

const PHASE_ORDER = [
  "Searching for businesses",
  "Collecting business information",
  "Checking for duplicates",
  "Auditing websites",
  "Exporting new leads to Google Sheets",
];

interface Config {
  places: boolean;
  pagespeed: boolean;
  sheets: boolean;
  supabase: boolean;
  sheetUrl: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Home() {
  const [config, setConfig] = useState<Config | null>(null);
  const [category, setCategory] = useState(CATEGORIES[0].label);
  const [customCategory, setCustomCategory] = useState("");
  const [country, setCountry] = useState<CountryCode>("US");
  const [region, setRegion] = useState("");
  const [areas, setAreas] = useState("");
  const [minRating, setMinRating] = useState("4.0");
  const [minReviews, setMinReviews] = useState("15");
  const [conditions, setConditions] = useState<WebsiteCondition[]>(CONDITIONS.filter((c) => c.default).map((c) => c.value));
  const [targetLeads, setTargetLeads] = useState("50");
  const [allLeads, setAllLeads] = useState(true);
  const [skipAudit, setSkipAudit] = useState(false);

  const [status, setStatus] = useState<BatchStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState("");
  const [netError, setNetError] = useState("");
  const loopId = useRef(0);

  const countryInfo = getCountry(country)!;
  const regionInfo = countryInfo.regions.find((r) => r.code === region);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => {});
  }, []);

  const runLoop = useCallback(async (id: string) => {
    const my = ++loopId.current;
    setRunning(true);
    setNetError("");
    let failures = 0;
    while (loopId.current === my) {
      try {
        const res = await fetch(`/api/search/${id}/step`, { method: "POST" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        failures = 0;
        setNetError("");
        setStatus(json);
        if (json.stage === "done" || json.stage === "failed") break;
        if (/^(Waiting|Temporary)/.test(json.message)) await sleep(4000);
      } catch (err) {
        failures++;
        setNetError(`Connection problem (${(err as Error).message}). Retrying… progress is saved.`);
        if (failures >= 6) {
          setNetError("Lost connection to the server. Your progress is saved — press Resume to continue.");
          break;
        }
        await sleep(Math.min(30_000, 2000 * 2 ** failures));
      }
    }
    if (loopId.current === my) setRunning(false);
  }, []);

  // Resume a search from ?batch=<id> after a reload.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("batch");
    if (!id) return;
    fetch(`/api/search/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: BatchStatus | null) => {
        if (!s) return;
        setStatus(s);
        if (s.stage === "searching" || s.stage === "exporting") runLoop(s.id);
      })
      .catch(() => {});
  }, [runLoop]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    const cat = category === CUSTOM ? customCategory.trim() : category;
    if (!cat) return setFormError("Enter a custom category.");
    if (!region) return setFormError(`Choose a ${countryInfo.regionLabel.toLowerCase()}.`);
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: cat,
        country,
        region,
        areas: areas.split(",").map((a) => a.trim()).filter(Boolean),
        minRating: Number(minRating),
        minReviews: Number(minReviews),
        conditions,
        targetLeads: allLeads ? 0 : Number(targetLeads),
        skipAudit,
      }),
    });
    const json = await res.json();
    if (!res.ok) return setFormError(json.error || "Could not start the search.");
    setStatus(json);
    window.history.replaceState(null, "", `?batch=${json.id}`);
    runLoop(json.id);
  }

  async function resume() {
    if (!status) return;
    const res = await fetch(`/api/search/${status.id}/resume`, { method: "POST" });
    const json = await res.json();
    if (res.ok) {
      setStatus(json);
      runLoop(json.id);
    } else setNetError(json.error || "Could not resume");
  }

  function newSearch() {
    loopId.current++;
    setRunning(false);
    setStatus(null);
    setNetError("");
    window.history.replaceState(null, "", window.location.pathname);
  }

  function addArea(city: string) {
    const list = areas.split(",").map((a) => a.trim()).filter(Boolean);
    if (!list.includes(city)) setAreas([...list, city].join(", "));
  }

  const toggleCondition = (c: WebsiteCondition) =>
    setConditions((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <main className="wrap">
      <header>
        <h1>WebNest</h1>
        <p>Lead Finder for BUILDORA — find local businesses that need a better website.</p>
      </header>

      {config && <ConfigNotices config={config} />}

      {!status && (
        <form className="card" onSubmit={start}>
          <h2>New search</h2>
          <div className="grid">
            <label className="field">
              Business category
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c.label} value={c.label}>{c.label}</option>
                ))}
                <option value={CUSTOM}>Other (type a custom category)…</option>
              </select>
            </label>
            {category === CUSTOM ? (
              <label className="field">
                Custom category
                <input type="text" value={customCategory} maxLength={80} placeholder="e.g. Pool cleaning" onChange={(e) => setCustomCategory(e.target.value)} />
              </label>
            ) : (
              <div />
            )}

            <label className="field">
              Country
              <select
                value={country}
                onChange={(e) => {
                  setCountry(e.target.value as CountryCode);
                  setRegion("");
                  setAreas("");
                }}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              {countryInfo.regionLabel}
              <select value={region} onChange={(e) => { setRegion(e.target.value); setAreas(""); }}>
                <option value="">Select…</option>
                {countryInfo.regions.map((r) => (
                  <option key={r.code} value={r.code}>{r.name}</option>
                ))}
              </select>
            </label>

            <label className="field full">
              <span>City / target area <small>(optional — leave empty to cover the WHOLE {countryInfo.regionLabel.toLowerCase()})</small></span>
              <input type="text" value={areas} placeholder={regionInfo ? `Whole ${regionInfo.name} — or e.g. ${regionInfo.cities.slice(0, 2).join(", ")}` : "Choose a state / province first"} onChange={(e) => setAreas(e.target.value)} disabled={!region} />
              {regionInfo && (
                <div className="chips">
                  {regionInfo.cities.map((c) => (
                    <button type="button" className="chip" key={c} onClick={() => addArea(c)}>+ {c}</button>
                  ))}
                </div>
              )}
            </label>

            <label className="field">
              Minimum Google rating
              <input type="number" min={0} max={5} step={0.1} value={minRating} onChange={(e) => setMinRating(e.target.value)} />
            </label>
            <label className="field">
              Minimum number of reviews
              <input type="number" min={0} step={1} value={minReviews} onChange={(e) => setMinReviews(e.target.value)} />
            </label>

            <label className="check full">
              <input type="checkbox" checked={skipAudit} onChange={(e) => setSkipAudit(e.target.checked)} />
              <span>
                Export every business — I&apos;ll check them one by one
                <small>Skips website audits (much faster). All businesses matching rating/location go to the sheet; duplicates are still removed.</small>
              </span>
            </label>

            <fieldset className="full" disabled={skipAudit} style={{ opacity: skipAudit ? 0.45 : 1 }}>
              <legend>Website condition (include businesses whose website is…)</legend>
              <div className="checks">
                {CONDITIONS.map((c) => (
                  <label className="check" key={c.value}>
                    <input type="checkbox" checked={conditions.includes(c.value)} onChange={() => toggleCondition(c.value)} />
                    <span>{c.label}<small>{c.hint}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="field">
              Number of new leads
              <input type="number" min={1} step={1} value={targetLeads} disabled={allLeads} onChange={(e) => setTargetLeads(e.target.value)} />
            </label>
            <label className="check" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={allLeads} onChange={(e) => setAllLeads(e.target.checked)} />
              <span>All businesses found<small>No limit — search every map area</small></span>
            </label>
          </div>

          {!areas.trim() && (
            <div className="notice info" style={{ marginTop: 14 }}>
              Whole-state search: the state is searched as a map grid, and busy areas are split into smaller tiles until
              Google stops returning full pages. Large states can take hundreds or thousands of billed Places requests.
            </div>
          )}

          {formError && <div className="notice err" style={{ marginTop: 14 }}>{formError}</div>}
          <div className="actions">
            <button className="btn" type="submit" disabled={!config?.places || (conditions.length === 0 && !skipAudit)}>Start Search</button>
          </div>
        </form>
      )}

      {status && <Progress status={status} running={running} netError={netError} onResume={resume} onNew={newSearch} />}
    </main>
  );
}

function ConfigNotices({ config }: { config: Config }) {
  return (
    <>
      {!config.places && (
        <div className="notice err">
          <b>Google Places API key missing.</b> Set <code>GOOGLE_PLACES_API_KEY</code> on the server to search for businesses (see README).
        </div>
      )}
      {!config.sheets && (
        <div className="notice warn">
          <b>Google Sheets not configured.</b> Results will be available as a CSV download only, deduplicated within each search.
        </div>
      )}
      {!config.pagespeed && (
        <div className="notice warn">
          <code>PAGESPEED_API_KEY</code> not set — websites are still inspected, but PageSpeed scores will be empty.
        </div>
      )}
      {!config.supabase && (
        <div className="notice info">
          Supabase not configured — using a local file store (fine for local use; required for deployments and concurrent searches across servers).
        </div>
      )}
    </>
  );
}

function Progress({ status, running, netError, onResume, onNew }: {
  status: BatchStatus;
  running: boolean;
  netError: string;
  onResume: () => void;
  onNew: () => void;
}) {
  const s = status.summary;
  const finished = status.stage === "done";
  const currentIdx = PHASE_ORDER.indexOf(status.phase);
  const p = status.params;
  const region = getCountry(p.country)?.regions.find((r) => r.code === p.region)?.name ?? p.region;

  const phaseState = (i: number) => {
    if (finished) return "done";
    if (status.stage === "exporting") return i < 4 ? "done" : "active";
    if (status.stage === "failed") return i === currentIdx ? "" : "";
    return i === currentIdx ? "active" : i === 4 ? "" : currentIdx > i ? "done" : "";
  };

  return (
    <section className="card">
      <h2>{finished ? "Search complete" : status.stage === "failed" ? "Search paused" : "Search in progress"}</h2>
      <p className="meta" style={{ marginTop: -8, marginBottom: 14 }}>
        {p.category} · {p.areas.length ? p.areas.join(", ") + ", " : ""}{region}, {getCountry(p.country)?.name} · ★ ≥ {p.minRating}, ≥ {p.minReviews} reviews · {p.targetLeads ? `target ${p.targetLeads} leads` : "all businesses"}{p.skipAudit ? " · no website audit" : ""}
      </p>

      {!finished && (
        <>
          <ul className="phases">
            {PHASE_ORDER.map((name, i) => {
              const st = phaseState(i);
              const label = i === 4 && status.exportMode === "csv" ? "Preparing CSV export" : name;
              return (
                <li key={name} className={st}>
                  <span className="dot">{st === "done" ? "✓" : ""}</span>
                  {label}
                </li>
              );
            })}
          </ul>
          <div className="msg">{status.message}</div>
          <div className="meta">
            Map areas searched: {status.coverage.areasDone} / {status.coverage.areasTotal} · Places requests: {status.coverage.placesRequests}
          </div>
        </>
      )}

      {status.error && <div className="notice err" style={{ marginTop: 12 }}><b>Problem:</b> {status.error}</div>}
      {finished && status.message && <div className="notice warn">{status.message}</div>}
      {netError && <div className="notice warn" style={{ marginTop: 12 }}>{netError}</div>}

      <div className="stats" style={{ marginTop: 14 }}>
        <Stat n={s.discovered} label="Businesses discovered" />
        <Stat n={s.matchingFilters} label="Matching rating / location filters" />
        <Stat n={s.qualified} label="New leads matching website condition" />
        <Stat n={s.duplicatesSkipped} label="Already in sheet — skipped" />
        <Stat n={s.updated} label="Existing rows updated" />
        <Stat n={status.exportMode === "sheets" ? s.added : 0} label="New rows added to Google Sheets" />
        <Stat n={s.unverified} label="Could not be verified" />
      </div>

      <div className="actions">
        {finished && status.sheetUrl && (
          <a className="btn" href={status.sheetUrl} target="_blank" rel="noopener noreferrer">Open Google Sheet</a>
        )}
        {(finished || status.stage === "failed") && (
          <a className="btn secondary" href={`/api/search/${status.id}/csv`}>Download CSV</a>
        )}
        {!running && !finished && <button className="btn" onClick={onResume}>Resume</button>}
        {(finished || !running) && <button className="btn secondary" onClick={onNew}>New search</button>}
      </div>
      <p className="meta">
        Batch <code>{status.id}</code> · started {new Date(status.createdAt).toLocaleString()} · Data: Google Places API (official) — coverage is limited to what Google returns for each map area.
      </p>
    </section>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="stat">
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}
