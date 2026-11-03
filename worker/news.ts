// News layer (Cloudflare Worker port of app/news.py). Tier 1: calendar + blackout (no AI).
// Tier 2: rule-based Actual vs Forecast vs Previous. Blackout is information only; it never blocks a signal.
import type { Env, JsonRecord } from "./types";

export interface NewsEvent {
  id: string; ts_ms: number; iso: string; title: string; country: string; impact: "high" | "medium" | "low";
  category: string | null; label: string; forecast: string | null; previous: string | null; actual: string | null;
  blackout: boolean; source: string;
}
export interface NewsAnalysis {
  category: string | null; status: "PENDING" | "READY" | "NO_FORECAST" | "QUALITATIVE"; magnitude: "IN_LINE" | "MILD" | "STRONG" | null;
  usd_bias: "UP" | "DOWN" | "NEUTRAL"; gold_bias: "UP" | "DOWN" | "NEUTRAL"; score: number; surprise: number | null; surprise_pct: number | null;
  vs_previous: "HIGHER" | "LOWER" | "SAME" | null; note_km: string; note_en: string; caution_km: string;
}

const FF_URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"];
const FINNHUB_URL = "https://finnhub.io/api/v1/calendar/economic";

const CATEGORY_RULES: Array<[string, RegExp, string]> = [
  ["NFP", /non-?farm|nfp/, "NFP"], ["CORE_PCE", /core pce/, "Core PCE"], ["PCE", /\bpce\b/, "PCE"],
  ["CORE_CPI", /core cpi/, "Core CPI"], ["CPI", /\bcpi\b/, "CPI"], ["PPI", /\bppi\b/, "PPI"],
  ["FOMC_RATE", /federal funds rate|fed interest rate|interest rate decision/, "FOMC Rate"],
  ["FOMC_STATEMENT", /fomc statement|monetary policy statement/, "FOMC Statement"],
  ["FOMC_PRESS", /fomc press conference/, "FOMC Presser"], ["FOMC_MINUTES", /fomc meeting minutes|fomc minutes/, "FOMC Minutes"],
  ["FED_SPEECH", /(fed|fomc).*(speak|testif|speech)|(powell|chair).*(speak|testif)|speaks/, "Fed Speech"],
  ["JOBLESS", /unemployment claims|jobless claims/, "Jobless Claims"], ["UNEMPLOYMENT", /unemployment rate/, "Unemployment Rate"],
  ["AHE", /average hourly earnings/, "Avg Hourly Earnings"], ["GDP", /\bgdp\b/, "GDP"], ["RETAIL", /retail sales/, "Retail Sales"],
  ["ISM", /\bism\b/, "ISM"], ["JOLTS", /jolts/, "JOLTS"], ["ADP", /\badp\b/, "ADP"],
];
const BLACKOUT_CATS = new Set(["NFP", "CPI", "CORE_CPI", "PCE", "CORE_PCE", "FOMC_RATE", "FOMC_STATEMENT", "FOMC_PRESS", "GDP", "JOBLESS"]);
const TRACKED = new Set(CATEGORY_RULES.map((r) => r[0]));
const QUALITATIVE = new Set(["FED_SPEECH", "FOMC_STATEMENT", "FOMC_PRESS", "FOMC_MINUTES"]);
const TONE: Record<string, number> = { hawkish: 1, dovish: -1, neutral: 0 };
const RULES: Record<string, { pol: 1 | -1; tol: [number, number] }> = {
  NFP: { pol: 1, tol: [10000, 50000] }, ADP: { pol: 1, tol: [15000, 60000] },
  CPI: { pol: 1, tol: [0, 0.2] }, CORE_CPI: { pol: 1, tol: [0, 0.2] }, PCE: { pol: 1, tol: [0, 0.2] }, CORE_PCE: { pol: 1, tol: [0, 0.2] },
  PPI: { pol: 1, tol: [0, 0.3] }, AHE: { pol: 1, tol: [0, 0.2] }, UNEMPLOYMENT: { pol: -1, tol: [0, 0.2] }, JOBLESS: { pol: -1, tol: [5000, 20000] },
  GDP: { pol: 1, tol: [0.1, 0.4] }, RETAIL: { pol: 1, tol: [0.1, 0.5] }, ISM: { pol: 1, tol: [0.5, 2] }, JOLTS: { pol: 1, tol: [100000, 400000] },
  FOMC_RATE: { pol: 1, tol: [0, 0.25] },
};

let cache: { ts: number; events: NewsEvent[]; source: string | null; error: string | null } = { ts: 0, events: [], source: null, error: null };

export function classify(title: string): [string | null, string | null] {
  const t = (title || "").toLowerCase();
  for (const [cat, re, label] of CATEGORY_RULES) if (re.test(t)) return [cat, label];
  return [null, null];
}

export function parseValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim().replace(/,/g, "");
  const m = s.match(/^[<>]?(-?\d+(?:\.\d+)?)\s*([kKmMbBtT]?)/);
  if (!m) return null;
  const mult: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  return Number(m[1]) * mult[m[2].toLowerCase()];
}

async function sha1Short(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 5).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeEvent(ts: Date, title: string, country: string, impactRaw: string, forecast: unknown, previous: unknown, actual: unknown, source: string): Promise<NewsEvent> {
  const ts_ms = ts.getTime();
  const [category, label] = classify(title);
  const impact = (["high", "medium", "low"].includes(String(impactRaw).toLowerCase()) ? String(impactRaw).toLowerCase() : "low") as NewsEvent["impact"];
  const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  return {
    id: await sha1Short(`${ts_ms}|${title}`), ts_ms, iso: ts.toISOString(), title, country, impact, category, label: label || title,
    forecast: str(forecast), previous: str(previous), actual: str(actual), source,
    blackout: impact === "high" || (category !== null && BLACKOUT_CATS.has(category)) || (category === "FED_SPEECH" && /chair/i.test(title)),
  };
}

const relevant = (e: NewsEvent) => e.country === "USD" && (e.impact === "high" || (e.category !== null && TRACKED.has(e.category)));

async function fetchFinnhub(env: Env): Promise<NewsEvent[]> {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const url = `${FINNHUB_URL}?from=${iso(new Date(today.getTime() - 86400000))}&to=${iso(new Date(today.getTime() + 14 * 86400000))}&token=${encodeURIComponent(env.FINNHUB_API_KEY || "")}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const rows = ((await r.json()) as JsonRecord).economicCalendar as JsonRecord[] | undefined;
  const out: NewsEvent[] = [];
  for (const row of rows || []) {
    if (String(row.country || "").toUpperCase() !== "US") continue;
    const ts = new Date(String(row.time || "").replace(" ", "T").slice(0, 19) + "Z");
    if (Number.isNaN(ts.getTime())) continue;
    const unit = ["%", "K", "M", "B"].includes(String(row.unit)) ? String(row.unit) : "";
    const f = (v: unknown) => (v === null || v === undefined ? null : `${v}${unit}`);
    out.push(await makeEvent(ts, String(row.event || ""), "USD", String(row.impact || ""), f(row.estimate), f(row.prev), f(row.actual), "Finnhub"));
  }
  return out;
}

async function fetchForexFactory(): Promise<NewsEvent[]> {
  const out: NewsEvent[] = [];
  let ok = 0;
  for (const url of FF_URLS) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (JD-ANALYSIS)" } });
      if (!r.ok) continue;
      const rows = (await r.json()) as JsonRecord[];
      ok++;
      for (const row of Array.isArray(rows) ? rows : []) {
        const ts = new Date(String(row.date || ""));
        if (Number.isNaN(ts.getTime())) continue;
        out.push(await makeEvent(ts, String(row.title || ""), String(row.country || "").toUpperCase(), String(row.impact || ""), row.forecast, row.previous, row.actual, "Forex Factory"));
      }
    } catch { /* try the next URL */ }
  }
  if (!ok) throw new Error("Forex Factory feed unavailable (rate-limited or offline)");
  return out;
}

export async function loadEvents(env: Env, force = false) {
  const ttl = Number(env.NEWS_CACHE_SECONDS || 900) * 1000;
  const now = Date.now();
  if (!force && cache.events.length && now - cache.ts < ttl) return { events: cache.events, source: cache.source, stale: false, error: null as string | null, fetched_at: cache.ts };
  let events: NewsEvent[] = [];
  let source: string | null = null;
  const errors: string[] = [];
  if (env.FINNHUB_API_KEY) {
    try { events = await fetchFinnhub(env); source = "Finnhub"; } catch (e) { errors.push(String((e as Error).message).slice(0, 120)); }
  }
  if (!events.length) {
    try { events = await fetchForexFactory(); source = "Forex Factory"; } catch (e) { errors.push(String((e as Error).message).slice(0, 120)); }
  }
  events = events.filter(relevant).sort((a, b) => a.ts_ms - b.ts_ms);
  if (events.length) { cache = { ts: now, events, source, error: null }; return { events, source, stale: false, error: null as string | null, fetched_at: now }; }
  cache.error = errors.join("; ") || "no events";
  return { events: cache.events, source: cache.source, stale: true, error: cache.error, fetched_at: cache.ts || null };
}

export function analyzeEvent(title: string, actual: unknown, forecast: unknown, previous: unknown, category?: string | null): NewsAnalysis {
  const cat = category ?? classify(title)[0];
  const a = parseValue(actual), f = parseValue(forecast), p = parseValue(previous);
  const base: NewsAnalysis = { category: cat, status: "PENDING", magnitude: null, usd_bias: "NEUTRAL", gold_bias: "NEUTRAL", score: 0, surprise: null, surprise_pct: null, vs_previous: null, note_km: "", note_en: "", caution_km: "" };
  const toneKey = String(actual ?? "").trim().toLowerCase();
  if ((cat !== null && QUALITATIVE.has(cat)) || (cat === null && toneKey in TONE)) {
    if (toneKey in TONE) {
      const d = TONE[toneKey];
      return {
        ...base, status: "READY", magnitude: d ? "MILD" : "IN_LINE", usd_bias: d > 0 ? "UP" : d < 0 ? "DOWN" : "NEUTRAL", gold_bias: d > 0 ? "DOWN" : d < 0 ? "UP" : "NEUTRAL", score: -d,
        note_km: d > 0 ? "សម្លេង Hawkish → ដុល្លារ/yield ឡើង → មាសធ្លាក់ជាមុន" : d < 0 ? "សម្លេង Dovish → ដុល្លារ/yield ធ្លាក់ → មាសឡើងជាមុន" : "សម្លេង Neutral → ទីផ្សារប្រហែលជាមិនមានទិសដៅច្បាស់",
        note_en: d > 0 ? "Hawkish tone → USD/yields up → gold dips first" : d < 0 ? "Dovish tone → USD/yields down → gold bids first" : "Neutral tone → no clear edge",
        caution_km: "Fed speech ប្រែប្រួលតាមប្រយោគ ហើយ spike ជាញឹកញាប់ត្រឡប់វិញ",
      };
    }
    return { ...base, status: "QUALITATIVE", note_km: "គ្មានលេខ forecast សម្រាប់ព្រឹត្តិការណ៍នេះ។ ស្តាប់ tone រួចជ្រើស Hawkish / Dovish / Neutral ក្នុង UI ដើម្បីឲ្យ rule វិភាគ។", note_en: "No numeric forecast. Pick the tone (Hawkish / Dovish / Neutral) in the UI so the rule can read it." };
  }
  if (a === null) return { ...base, note_km: "ចាំលទ្ធផល Actual (feed ឬបញ្ចូលដោយដៃ)។", note_en: "Waiting for the Actual value (feed or manual entry)." };
  const rule = cat ? RULES[cat] : undefined;
  const vsPrev: NewsAnalysis["vs_previous"] = p === null ? null : a > p ? "HIGHER" : a < p ? "LOWER" : "SAME";
  if (f === null || !rule) return { ...base, status: "NO_FORECAST", vs_previous: vsPrev, note_km: "គ្មាន Forecast ឬ rule សម្រាប់ព្រឹត្តិការណ៍នេះ — មិនអាចវាស់ surprise បានទេ។", note_en: "No Forecast or rule for this event, so the surprise cannot be measured." };
  const diff = a - f;
  const [inline, strong] = rule.tol;
  const mag: NewsAnalysis["magnitude"] = Math.abs(diff) <= inline + 1e-9 ? "IN_LINE" : Math.abs(diff) >= strong - 1e-9 ? "STRONG" : "MILD";
  const direction = mag === "IN_LINE" ? 0 : (diff > 0 ? 1 : -1) * rule.pol; // +1 => USD up
  const gold: NewsAnalysis["gold_bias"] = direction > 0 ? "DOWN" : direction < 0 ? "UP" : "NEUTRAL";
  const label = classify(title)[1] || title;
  const word = diff > 0 ? "ខ្ពស់ជាង" : "ទាបជាង", wordEn = diff > 0 ? "above" : "below";
  let km: string, en: string;
  if (mag === "IN_LINE") { km = `${label} ស្របតាម Forecast → surprise តូច មាសអាចឆ្លើយតបខ្សោយ ឬច្របូកច្របល់`; en = `${label} in line with Forecast → small surprise, muted/choppy reaction`; }
  else {
    km = `${label} ${word} Forecast (${mag === "STRONG" ? "ខ្លាំង" : "បន្តិច"}) → ដុល្លារ/yield ${direction > 0 ? "ឡើង" : "ធ្លាក់"} → មាស${gold === "DOWN" ? "ធ្លាក់" : "ឡើង"}ភ្លាមៗ`;
    en = `${label} ${wordEn} Forecast (${mag.toLowerCase()}) → USD/yields ${direction > 0 ? "up" : "down"} → gold ${gold === "DOWN" ? "dips" : "pops"} first`;
  }
  return {
    ...base, status: "READY", magnitude: mag, usd_bias: direction > 0 ? "UP" : direction < 0 ? "DOWN" : "NEUTRAL", gold_bias: gold,
    score: -direction * (mag === "STRONG" ? 2 : mag === "MILD" ? 1 : 0), surprise: Math.round(diff * 1e4) / 1e4,
    surprise_pct: f ? Math.round((diff / Math.abs(f)) * 1000) / 10 : null, vs_previous: vsPrev, note_km: km, note_en: en,
    caution_km: mag !== "IN_LINE" ? "spike ដំបូងជាញឹកញាប់ត្រឡប់វិញ (fake-out) — រង់ចាំ M5/M15 បិទ candle និង structure ICT មុនចូល" : "",
  };
}

const withAnalysis = (e: NewsEvent) => ({ ...e, analysis: analyzeEvent(e.title, e.actual, e.forecast, e.previous, e.category) });

export function buildStatus(events: NewsEvent[], env: Env, nowMs = Date.now()) {
  const beforeMin = Number(env.NEWS_BLACKOUT_BEFORE_MIN || 30), afterMin = Number(env.NEWS_BLACKOUT_AFTER_MIN || 30);
  const active = events.filter((e) => e.blackout && e.ts_ms - beforeMin * 60000 <= nowMs && nowMs <= e.ts_ms + afterMin * 60000);
  const upcoming = events.filter((e) => e.ts_ms > nowMs);
  const next = upcoming.find((e) => e.blackout) || upcoming[0] || null;
  return { now_ms: nowMs, blackout: active.length > 0, window_min: { before: beforeMin, after: afterMin }, active, next, countdown_ms: next ? next.ts_ms - nowMs : null };
}

function clusters(events: Array<ReturnType<typeof withAnalysis>>) {
  const by = new Map<number, Array<ReturnType<typeof withAnalysis>>>();
  for (const e of events) if (e.analysis.status === "READY") by.set(e.ts_ms, [...(by.get(e.ts_ms) || []), e]);
  const out: JsonRecord[] = [];
  for (const [ts, items] of by) {
    if (items.length < 2) continue;
    const net = items.reduce((s, i) => s + i.analysis.score, 0);
    out.push({ ts_ms: ts, titles: items.map((i) => i.label), net_score: net, gold_bias: net > 0 ? "UP" : net < 0 ? "DOWN" : "MIXED",
      note_km: `សរុប ${items.length} ទិន្នន័យ → មាស ${net > 0 ? "ទំនោរឡើង" : net < 0 ? "ទំនោរធ្លាក់" : "ច្របូកច្របល់ (ទិន្នន័យទាស់គ្នា)"}` });
  }
  return out;
}

export async function eventsPayload(env: Env, force = false) {
  const data = await loadEvents(env, force);
  const now = Date.now();
  const status = buildStatus(data.events, env, now);
  const shown = data.events.filter((e) => e.ts_ms >= now - 36 * 3600000).map(withAnalysis);
  return {
    source: data.source, stale: data.stale, error: data.error, fetched_at: data.fetched_at, has_actual_feed: data.source === "Finnhub",
    status: { ...status, next: status.next ? withAnalysis(status.next) : null, active: status.active.map(withAnalysis) },
    events: shown, clusters: clusters(shown), keywords: [...TRACKED].sort(),
  };
}

export async function newsContext(env: Env): Promise<JsonRecord> {
  try {
    const data = await loadEvents(env);
    const s = buildStatus(data.events, env);
    return {
      available: data.events.length > 0, blackout: s.blackout, source: data.source, stale: data.stale,
      active: s.active.map((e) => ({ title: e.title, minutes_from_release: Math.round((s.now_ms - e.ts_ms) / 60000) })),
      next: s.next ? { title: s.next.title, impact: s.next.impact, in_minutes: Math.round((s.next.ts_ms - s.now_ms) / 60000), ts_ms: s.next.ts_ms } : null,
    };
  } catch (e) {
    return { available: false, message: String((e as Error).message).slice(0, 160) };
  }
}
