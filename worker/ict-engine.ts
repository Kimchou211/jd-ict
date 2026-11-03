export interface IctCandle {
  timestamp_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  [key: string]: unknown;
}

export type IctFeed = IctCandle[] | { bars: IctCandle[] };
export type IctFeeds = Record<string, IctFeed | undefined>;
export type IctTimeframe = "M1" | "M5" | "M15";

type Direction = "bull" | "bear";
type Side = "buy" | "sell";
type IctAction = "BUY" | "SELL";
type Swing = { i: number; type: "high" | "low"; price: number; ts: number; confirmed_at: number };
type StructureEvent = {
  i: number; ts: number; kind: "BOS" | "MSS"; dir: Direction; level: number;
  origin_i: number; origin_ts: number; leg_start_i: number;
};
type LiquidityLevel = {
  kind: string; side: Side; price: number; i: number; ts: number;
  status?: "active" | "swept" | "broken"; swept_i?: number | null;
};
type Sweep = {
  i: number; confirm_i: number; side: Side; kind: string;
  level: number; extreme: number; ts: number;
};
type Zone = {
  dir: Direction; low: number; high: number; i: number; ts: number;
  end_i: number | null; touched: boolean; ref?: string;
};
type OrderBlock = Zone & { event_i: number };
type IctPlan = {
  direction: Direction; action: IctAction; entry: number; entry_low: number; entry_high: number;
  stop: number; tp1: number; tp2: number; tp1_basis: string; tp2_basis: string;
  rr1: number; rr2: number; risk: number; ts_start: number; bars_ahead: number;
  valid_until_ms: number; ltf_minutes: number;
};
type Setup = {
  direction: Direction; action: "BUY" | "SELL"; status: string; score: number;
  reasons: string[]; sweep: Sweep; event: Pick<StructureEvent, "i" | "ts" | "kind" | "dir" | "level">;
  arrays: string[]; fvg: Zone | null; ob: OrderBlock | null; plan: IctPlan;
  id?: string; refs?: Record<string, string | null>;
};
type IctPd = ReturnType<typeof premiumDiscount>;
type IctBias = { label: "BULLISH" | "BEARISH" | "NEUTRAL"; score: number; h1: Direction | null; m15: Direction | null; h1_zone: string | null };

export interface IctScanSetup {
  id: string;
  direction: Direction;
  action: IctAction;
  status: string;
  score: number;
  reasons: string[];
  arrays: string[];
  plan: IctPlan;
  refs: Record<string, string | null>;
  sweep: Pick<Sweep, "kind" | "level" | "extreme" | "ts">;
  event: Pick<StructureEvent, "i" | "ts" | "kind" | "dir" | "level">;
}

export interface IctScanResult {
  scan_type: "ict";
  symbol: keyof typeof PROFILES;
  ltf: IctTimeframe;
  price: number;
  atr: number;
  time_ms: number;
  session: ReturnType<typeof sessionInfo>;
  bias: IctBias;
  structure: Record<string, { trend: Direction | null; last_event: StructureEvent | null }>;
  pd: IctPd;
  pd_htf: Record<string, IctPd>;
  crt: Record<string, unknown>;
  setups: IctScanSetup[];
  selected: string | null;
  direction: IctAction | "WAIT";
  action: "ENTER_ON_RETRACE" | "PRICE_IN_ENTRY_ZONE" | "WAIT_FOR_SETUP";
  confluence_score: number;
  reasons: string[];
  plan: IctPlan | null;
  plan_status: string | null;
  drawings: Record<string, unknown>[];
  level_table: Record<string, Record<string, number>>;
  min_score: number;
}

export interface IctAiReview {
  ok?: boolean;
  status?: string;
  provider?: string;
  model?: string;
  direction?: unknown;
  verdict?: unknown;
  selected_setup?: unknown;
  referenced_levels?: unknown;
  narrative?: unknown;
  confirmation?: unknown;
  invalidation?: unknown;
  risk_note?: unknown;
  confidence?: unknown;
  message?: unknown;
}

export interface IctAiValidation {
  accepted: boolean;
  issues: string[];
}

export interface IctVerdict {
  final_direction: "BUY" | "SELL" | "WAIT";
  final_confidence: number;
  verdict_status: "ENGINE_ONLY" | "ENGINE_WAIT" | "ALIGNED" | "AI_VETO" | "CONFLICT" | "AI_REJECTED_BY_VALIDATOR";
  verdict_notes: string[];
}

const TF_MIN: Record<string, number> = { M1: 1, M5: 5, M15: 15, H1: 60 };
const LOOKBACK: Record<string, number> = { M1: 90, M5: 80, M15: 60 };
const VALID_HOURS: Record<string, number> = { M1: 2, M5: 6, M15: 18 };
const ASIA_UTC: [number, number] = [0, 7];
const LONDON_KZ_UTC: [number, number] = [7, 10];
const NY_KZ_UTC: [number, number] = [12, 15];

const PROFILES = {
  XAUUSD: { aliases: ["XAUUSD", "XAUUSDM", "GOLD", "GOLDUSD"], tol_floor: 0.3, buf_floor: 0.3, gap_floor: 0.05 },
  BTCUSD: { aliases: ["BTCUSD", "BTCUSDT", "BTCUSDM", "BITCOIN", "XBTUSD"], tol_floor: 8, buf_floor: 5, gap_floor: 1 },
} as const;

function normalizeSymbol(symbol?: string): keyof typeof PROFILES {
  const normalized = (symbol || "XAUUSD").toUpperCase().replace(/[\/\-\s]/g, "");
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (normalized === name || (profile.aliases as readonly string[]).includes(normalized)) return name as keyof typeof PROFILES;
  }
  throw new Error(`Unsupported symbol '${symbol}'. Use one of: XAUUSD, BTCUSD.`);
}

function barsFrom(feed: IctFeed | undefined): IctCandle[] | undefined {
  return Array.isArray(feed) ? feed : feed?.bars;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
  const rounded = Math.abs(fraction - 0.5) <= epsilon
    ? (floor % 2 === 0 ? floor : floor + 1)
    : Math.round(scaled);
  return rounded / factor;
}

export function calcIctAtr(bars: IctCandle[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const tail = trs.slice(-period);
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
}

function sessionInfo(ts: number) {
  const d = new Date(ts), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  let name = "OFF_HOURS", in_killzone = false;
  if (h >= ASIA_UTC[0] && h < ASIA_UTC[1]) name = "ASIA";
  else if (h >= LONDON_KZ_UTC[0] && h < LONDON_KZ_UTC[1]) { name = "LONDON_KZ"; in_killzone = true; }
  else if (h >= NY_KZ_UTC[0] && h < NY_KZ_UTC[1]) { name = "NY_KZ"; in_killzone = true; }
  else if (h >= LONDON_KZ_UTC[1] && h < NY_KZ_UTC[0]) name = "LONDON";
  else if (h >= NY_KZ_UTC[1] && h < 21) name = "NEW_YORK";
  return { name, in_killzone, utc_hour: round(h, 2) };
}

function findSwings(bars: IctCandle[], left = 3, right = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const h = bars[i].high, l = bars[i].low;
    if (Array.from({ length: left }, (_, k) => i - left + k).every(j => h > bars[j].high)
      && Array.from({ length: right }, (_, k) => i + 1 + k).every(j => h >= bars[j].high)) {
      out.push({ i, type: "high", price: h, ts: bars[i].timestamp_ms, confirmed_at: i + right });
    }
    if (Array.from({ length: left }, (_, k) => i - left + k).every(j => l < bars[j].low)
      && Array.from({ length: right }, (_, k) => i + 1 + k).every(j => l <= bars[j].low)) {
      out.push({ i, type: "low", price: l, ts: bars[i].timestamp_ms, confirmed_at: i + right });
    }
  }
  return out.sort((a, b) => a.i - b.i);
}

function marketStructure(bars: IctCandle[], swings: Swing[]) {
  const byConf = new Map<number, Swing[]>();
  for (const swing of swings) {
    const list = byConf.get(swing.confirmed_at) || [];
    list.push(swing);
    byConf.set(swing.confirmed_at, list);
  }
  const events: StructureEvent[] = [];
  let trend: Direction | null = null, hi: Swing | null = null, lo: Swing | null = null;
  for (let i = 0; i < bars.length; i++) {
    for (const swing of byConf.get(i) || []) {
      if (swing.type === "high") hi = swing;
      else lo = swing;
    }
    const close = bars[i].close;
    if (hi && close > hi.price) {
      let start = hi.i;
      for (let k = hi.i + 1; k <= i; k++) if (bars[k].low < bars[start].low) start = k;
      events.push({ i, ts: bars[i].timestamp_ms, kind: trend === null || trend === "bull" ? "BOS" : "MSS", dir: "bull",
        level: hi.price, origin_i: hi.i, origin_ts: hi.ts, leg_start_i: start });
      trend = "bull"; hi = null;
    } else if (lo && close < lo.price) {
      let start = lo.i;
      for (let k = lo.i + 1; k <= i; k++) if (bars[k].high > bars[start].high) start = k;
      events.push({ i, ts: bars[i].timestamp_ms, kind: trend === null || trend === "bear" ? "BOS" : "MSS", dir: "bear",
        level: lo.price, origin_i: lo.i, origin_ts: lo.ts, leg_start_i: start });
      trend = "bear"; lo = null;
    }
  }
  return { trend, events };
}

function findFvgs(bars: IctCandle[], atr: number, symbol: keyof typeof PROFILES): Zone[] {
  const minimum = Math.max(0.08 * atr, PROFILES[symbol].gap_floor);
  const out: Zone[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1], next = bars[i + 1];
    if (next.low - prev.high >= minimum) {
      out.push({ dir: "bull", low: prev.high, high: next.low, i, ts: bars[i].timestamp_ms, end_i: null, touched: false });
    } else if (prev.low - next.high >= minimum) {
      out.push({ dir: "bear", low: next.high, high: prev.low, i, ts: bars[i].timestamp_ms, end_i: null, touched: false });
    }
  }
  for (const fvg of out) {
    for (let j = fvg.i + 2; j < bars.length; j++) {
      const bar = bars[j];
      if (bar.low <= fvg.high && bar.high >= fvg.low) fvg.touched = true;
      if ((fvg.dir === "bull" && bar.close < fvg.low) || (fvg.dir === "bear" && bar.close > fvg.high)) {
        fvg.end_i = j;
        break;
      }
    }
  }
  return out;
}

function orderBlockFor(bars: IctCandle[], event: StructureEvent): OrderBlock | null {
  const start = event.leg_start_i, wantDown = event.dir === "bull";
  const order = [start, start - 1, start - 2, start - 3, start + 1, start + 2, start + 3];
  for (const j of order) {
    if (j < 0 || j >= bars.length || j >= event.i) continue;
    const bar = bars[j];
    if ((bar.close < bar.open) === wantDown && bar.close !== bar.open) {
      const low = wantDown ? bar.low : bar.open, high = wantDown ? bar.open : bar.high;
      const ob: OrderBlock = { dir: event.dir, low, high, i: j, ts: bar.timestamp_ms, event_i: event.i, end_i: null, touched: false };
      for (let k = event.i + 1; k < bars.length; k++) {
        const later = bars[k];
        if (later.low <= high && later.high >= low) ob.touched = true;
        if ((ob.dir === "bull" && later.close < low) || (ob.dir === "bear" && later.close > high)) { ob.end_i = k; break; }
      }
      return ob;
    }
  }
  return null;
}

function cluster(swings: Swing[], tolerance: number): Swing[][] {
  const groups: Swing[][] = [];
  for (const swing of [...swings].sort((a, b) => a.price - b.price)) {
    const last = groups[groups.length - 1];
    if (last && swing.price - last[last.length - 1].price <= tolerance) last.push(swing);
    else groups.push([swing]);
  }
  return groups.filter(group => group.length >= 2);
}

function dayLevels(bars: IctCandle[], lastTs: number) {
  const today = new Date(lastTs).toISOString().slice(0, 10);
  const days = new Map<string, IctCandle[]>();
  for (const bar of bars) {
    const date = new Date(bar.timestamp_ms).toISOString().slice(0, 10);
    const list = days.get(date) || [];
    list.push(bar);
    days.set(date, list);
  }
  const previous = [...days.keys()].filter(date => date < today).sort();
  if (!previous.length) return null;
  const selected = days.get(previous[previous.length - 1])!;
  const start = Date.parse(`${previous[previous.length - 1]}T00:00:00.000Z`);
  return { high: Math.max(...selected.map(bar => bar.high)), low: Math.min(...selected.map(bar => bar.low)), ts: start };
}

function asiaRange(bars: IctCandle[], lastTs: number) {
  const date = new Date(lastTs), hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  if (hour < ASIA_UTC[1]) return null;
  const day = date.toISOString().slice(0, 10);
  const selected = bars.filter(bar => {
    const d = new Date(bar.timestamp_ms);
    return d.toISOString().slice(0, 10) === day && d.getUTCHours() >= ASIA_UTC[0] && d.getUTCHours() < ASIA_UTC[1];
  });
  if (selected.length < 3) return null;
  return { high: Math.max(...selected.map(bar => bar.high)), low: Math.min(...selected.map(bar => bar.low)), ts: selected[0].timestamp_ms };
}

function firstIndexAtOrAfter(bars: IctCandle[], ts: number): number {
  const i = bars.findIndex(bar => bar.timestamp_ms >= ts);
  return i < 0 ? bars.length - 1 : i;
}

function buildLiquidity(bars: IctCandle[], swings: Swing[], atr: number, htf: IctCandle[] | undefined,
  crt: Record<string, unknown>, symbol: keyof typeof PROFILES): { levels: LiquidityLevel[]; sweeps: Sweep[] } {
  const n = bars.length, tolerance = Math.max(0.25 * atr, PROFILES[symbol].tol_floor);
  const recent = swings.filter(s => s.i >= n - 160), levels: LiquidityLevel[] = [];
  for (const [type, kind, side] of [["high", "EQH", "buy"], ["low", "EQL", "sell"]] as const) {
    const points = recent.filter(s => s.type === type), groups = cluster(points, tolerance);
    for (const group of groups) {
      levels.push({ kind, side, price: type === "high" ? Math.max(...group.map(s => s.price)) : Math.min(...group.map(s => s.price)),
        i: Math.max(...group.map(s => s.i)) + 3, ts: group[0].ts });
    }
    const used = new Set(groups.flat());
    for (const swing of points) if (!used.has(swing)) {
      levels.push({ kind: type === "high" ? "SWH" : "SWL", side, price: swing.price, i: swing.i + 3, ts: swing.ts });
    }
  }
  const lastTs = bars[n - 1].timestamp_ms, day = dayLevels(htf || bars, lastTs);
  if (day) {
    const i = firstIndexAtOrAfter(bars, day.ts + 86_400_000);
    levels.push({ kind: "PDH", side: "buy", price: day.high, i, ts: day.ts }, { kind: "PDL", side: "sell", price: day.low, i, ts: day.ts });
  }
  const asia = asiaRange(bars, lastTs);
  if (asia) {
    const d = new Date(lastTs);
    d.setUTCHours(ASIA_UTC[1], 0, 0, 0);
    const i = Math.min(n - 1, firstIndexAtOrAfter(bars, d.getTime()));
    levels.push({ kind: "ASIA_H", side: "buy", price: asia.high, i, ts: asia.ts }, { kind: "ASIA_L", side: "sell", price: asia.low, i, ts: asia.ts });
  }
  if (crt.high !== null && crt.high !== undefined) {
    const i = firstIndexAtOrAfter(bars, Number(crt.ts2));
    levels.push({ kind: "CRT_H", side: "buy", price: Number(crt.high), i, ts: Number(crt.ts1) },
      { kind: "CRT_L", side: "sell", price: Number(crt.low), i, ts: Number(crt.ts1) });
  }
  const sweeps: Sweep[] = [];
  for (const level of levels) {
    level.status = "active"; level.swept_i = null;
    const start = Math.max(0, Math.min(n - 1, level.i + 1));
    for (let j = start; j < n; j++) {
      const bar = bars[j], hit = level.side === "buy" ? bar.high > level.price : bar.low < level.price;
      if (!hit) continue;
      let confirm: number | null = level.side === "buy" ? (bar.close < level.price ? j : null) : (bar.close > level.price ? j : null);
      if (confirm === null) {
        for (let k = j + 1; k < Math.min(n, j + 3); k++) {
          if (level.side === "buy" ? bars[k].close < level.price : bars[k].close > level.price) { confirm = k; break; }
        }
      }
      if (confirm !== null) {
        level.status = "swept"; level.swept_i = j;
        const relevant = bars.slice(j, confirm + 1);
        const extreme = level.side === "buy" ? Math.max(...relevant.map(b => b.high)) : Math.min(...relevant.map(b => b.low));
        sweeps.push({ i: j, confirm_i: confirm, side: level.side, kind: level.kind, level: level.price, extreme, ts: bar.timestamp_ms });
      } else {
        level.status = "broken"; level.swept_i = j;
      }
      break;
    }
  }
  sweeps.sort((a, b) => a.i - b.i);
  const rank: Record<string, number> = { PDH: 5, PDL: 5, ASIA_H: 4, ASIA_L: 4, CRT_H: 4, CRT_L: 4, EQH: 3, EQL: 3, SWH: 1, SWL: 1 };
  const best = new Map<string, Sweep>();
  for (const sweep of sweeps) {
    const key = `${sweep.i}:${sweep.side}`, current = best.get(key);
    if (!current || rank[sweep.kind] > rank[current.kind]) best.set(key, sweep);
  }
  return { levels, sweeps: [...best.values()].sort((a, b) => a.i - b.i) };
}

function premiumDiscount(bars: IctCandle[], price: number, window = 100) {
  const selected = bars.slice(-window), high = Math.max(...selected.map(b => b.high)), low = Math.min(...selected.map(b => b.low));
  const eq = (high + low) / 2, pct = high === low ? 0 : (price - low) / (high - low) * 100;
  return { high, low, eq, pct: round(pct, 1), zone: price > eq ? "PREMIUM" : "DISCOUNT",
    ts1: selected[0].timestamp_ms, ts2: selected[selected.length - 1].timestamp_ms };
}

function crtRange(htf: IctCandle[] | undefined): Record<string, unknown> {
  if (!htf || htf.length < 3) return { state: "unavailable", dir: null, high: null, low: null };
  const c1 = htf[htf.length - 2], c2 = htf[htf.length - 1];
  const out: Record<string, unknown> = { high: c1.high, low: c1.low, ts1: c1.timestamp_ms, ts2: c2.timestamp_ms, state: "inside", dir: null };
  if (c2.high > c1.high && c2.close <= c1.high) { out.state = "swept_high"; out.dir = "bear"; }
  else if (c2.low < c1.low && c2.close >= c1.low) { out.state = "swept_low"; out.dir = "bull"; }
  else if (c2.close > c1.high) out.state = "expansion_up";
  else if (c2.close < c1.low) out.state = "expansion_down";
  return out;
}

function dirNum(trend: Direction | null | undefined): number { return trend === "bull" ? 1 : trend === "bear" ? -1 : 0; }

function mtfBias(structure: Record<string, { trend: Direction | null }>, pdHtf?: IctPd): IctBias {
  const score = 2 * dirNum(structure.H1?.trend) + dirNum(structure.M15?.trend);
  return { label: score >= 2 ? "BULLISH" : score <= -2 ? "BEARISH" : "NEUTRAL", score,
    h1: structure.H1?.trend ?? null, m15: structure.M15?.trend ?? null, h1_zone: pdHtf?.zone ?? null };
}

function setupStatus(direction: Direction, price: number, zone: [number, number], stop: number, tp1: number): string {
  const [low, high] = zone;
  if (direction === "bear") {
    if (price >= stop) return "INVALIDATED";
    if (price <= tp1) return "TARGET_REACHED";
    if (low <= price && price <= high) return "IN_ENTRY_ZONE";
    return price < low ? "AWAITING_RETRACE" : "ZONE_TRADED_THROUGH";
  }
  if (price <= stop) return "INVALIDATED";
  if (price >= tp1) return "TARGET_REACHED";
  if (low <= price && price <= high) return "IN_ENTRY_ZONE";
  return price > high ? "AWAITING_RETRACE" : "ZONE_TRADED_THROUGH";
}

function buildSetup(direction: Direction, ctx: {
  bars: IctCandle[]; ltf: string; atr: number; price: number; sweeps: Sweep[]; events: StructureEvent[];
  fvgs: Zone[]; obs: OrderBlock[]; liquidity: LiquidityLevel[]; pd: ReturnType<typeof premiumDiscount>;
  crt: Record<string, unknown>; bias: ReturnType<typeof mtfBias>; session: ReturnType<typeof sessionInfo>; symbol: keyof typeof PROFILES;
}): Setup | null {
  const { bars, ltf, atr, price } = ctx, n = bars.length, look = LOOKBACK[ltf] ?? 80;
  const side: Side = direction === "bear" ? "buy" : "sell";
  const sweeps = ctx.sweeps.filter(s => s.side === side && s.confirm_i >= n - look).sort((a, b) => b.i - a.i);
  let chosen: Sweep | null = null, event: StructureEvent | null = null;
  for (const sweep of sweeps) {
    const found = ctx.events.find(e => e.dir === direction && e.i >= sweep.confirm_i - 1 && e.i <= sweep.i + 60);
    if (found) { chosen = sweep; event = found; break; }
  }
  if (!chosen || !event) return null;
  const sw = chosen;
  const range = bars.slice(sw.i, event.i + 1);
  const extreme = direction === "bear" ? Math.max(...range.map(b => b.high)) : Math.min(...range.map(b => b.low));
  let stop = direction === "bear" ? extreme + Math.max(0.15 * atr, PROFILES[ctx.symbol].buf_floor)
    : extreme - Math.max(0.15 * atr, PROFILES[ctx.symbol].buf_floor);
  const fvgCandidates = ctx.fvgs.filter(f => f.dir === direction && f.i >= sw.i && f.i <= event!.i + 1 && f.end_i === null);
  fvgCandidates.sort((a, b) => (b.high - b.low) - (a.high - a.low) || b.i - a.i);
  const fvg = fvgCandidates[0] || null, ob = ctx.obs.find(o => o.event_i === event!.i && o.end_i === null) || null;
  let zone: [number, number], arrays: string[];
  const overlapLow = fvg && ob ? Math.max(fvg.low, ob.low) : 0;
  const overlapHigh = fvg && ob ? Math.min(fvg.high, ob.high) : 0;
  if (fvg && ob && overlapHigh > overlapLow) {
    arrays = ["FVG", "OB"];
    zone = overlapHigh - overlapLow >= 0.3 * (fvg.high - fvg.low) ? [overlapLow, overlapHigh] : [fvg.low, fvg.high];
  } else if (fvg) { zone = [fvg.low, fvg.high]; arrays = ["FVG"]; }
  else if (ob) { zone = [ob.low, ob.high]; arrays = ["OB"]; }
  else {
    const tail = bars.slice(sw.i);
    if (direction === "bear") {
      const legLow = Math.min(...tail.map(b => b.low)), span = extreme - legLow;
      zone = [legLow + 0.62 * span, legLow + 0.79 * span];
    } else {
      const legHigh = Math.max(...tail.map(b => b.high)), span = legHigh - extreme;
      zone = [legHigh - 0.79 * span, legHigh - 0.62 * span];
    }
    arrays = ["OTE"];
  }
  const entry = round((zone[0] + zone[1]) / 2, 2);
  let risk = Math.abs(stop - entry);
  if (risk < 0.4 * atr) {
    stop = direction === "bear" ? entry + 0.4 * atr : entry - 0.4 * atr;
    risk = 0.4 * atr;
  }
  const sign = direction === "bear" ? -1 : 1;
  const candidates = ctx.liquidity.filter(level => level.side === (direction === "bear" ? "sell" : "buy")
    && level.status === "active" && (level.price - entry) * sign >= 1.5 * risk)
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const tp1 = candidates.length ? candidates[0].price : entry + sign * 2 * risk;
  const tp1Kind = candidates.length ? candidates[0].kind : "2R";
  const beyond = candidates.filter(level => (level.price - tp1) * sign > 0.3 * risk);
  const tp2 = beyond.length ? beyond[0].price : entry + sign * (Math.abs(tp1 - entry) / risk + 1) * risk;
  const tp2Kind = beyond.length ? beyond[0].kind : "R-extension";
  const rr1 = round(Math.abs(tp1 - entry) / risk, 2), rr2 = round(Math.abs(tp2 - entry) / risk, 2);
  let status = setupStatus(direction, price, zone, stop, tp1);
  const reasons: string[] = [];
  let score = 0;
  const bias = ctx.bias.label, aligned = (bias === "BEARISH" && direction === "bear") || (bias === "BULLISH" && direction === "bull");
  if (aligned) { score += 25; reasons.push(`HTF bias ${bias} (H1/M15 structure) aligned`); }
  else if (bias === "NEUTRAL") { score += 8; reasons.push("HTF bias neutral/mixed"); }
  else reasons.push(`Counter-trend vs HTF bias ${bias}`);
  const big = ["PDH", "PDL", "ASIA_H", "ASIA_L", "CRT_H", "CRT_L", "EQH", "EQL"].includes(sw.kind);
  score += big ? 25 : 20; reasons.push(`Liquidity sweep of ${sw.kind} @ ${sw.level.toFixed(2)}`);
  if (event.kind === "MSS") { score += 18; reasons.push("MSS (CHoCH) after sweep"); }
  else { score += 10; reasons.push("BOS after sweep"); }
  if (arrays.includes("FVG")) { score += 12; reasons.push("Entry on unfilled FVG"); }
  if (arrays.includes("OB")) { score += 8; reasons.push("Order block in entry zone"); }
  if (arrays.length === 1 && arrays[0] === "OTE") { score += 4; reasons.push("No FVG/OB; entry on 62-79% OTE retracement"); }
  if ((direction === "bear" && extreme >= ctx.pd.eq) || (direction === "bull" && extreme <= ctx.pd.eq)) {
    score += 8; reasons.push(`Sweep happened in ${direction === "bear" ? "premium" : "discount"}`);
  }
  if (ctx.session.in_killzone) { score += 7; reasons.push(`Inside ${ctx.session.name} kill zone`); }
  if (ctx.crt.dir === direction) { score += 7; reasons.push("CRT manipulation of H1 range agrees"); }
  if (event.i < n - look) status = "EXPIRED";
  score = Math.max(0, Math.min(100, score));
  const action = direction === "bear" ? "SELL" : "BUY";
  return { direction, action, status, score, reasons, sweep: sw,
    event: { i: event.i, ts: event.ts, kind: event.kind, dir: event.dir, level: event.level }, arrays, fvg, ob,
    plan: { direction, action, entry, entry_low: round(zone[0], 2), entry_high: round(zone[1], 2),
      stop: round(stop, 2), tp1: round(tp1, 2), tp2: round(tp2, 2), tp1_basis: tp1Kind, tp2_basis: tp2Kind,
      rr1, rr2, risk: round(risk, 2), ts_start: bars[n - 1].timestamp_ms, bars_ahead: 30,
      valid_until_ms: bars[n - 1].timestamp_ms + (VALID_HOURS[ltf] ?? 6) * 3_600_000, ltf_minutes: TF_MIN[ltf] ?? 5 },
  };
}

function buildDrawings(bars: IctCandle[], ctx: {
  price: number; pd: ReturnType<typeof premiumDiscount>; atr: number; swings: Swing[]; events: StructureEvent[];
  sweeps: Sweep[]; fvgs: Zone[]; obs: OrderBlock[];
}, levels: LiquidityLevel[], setups: Setup[], best: Setup | null) {
  const drawings: Record<string, unknown>[] = [], table: Record<string, Record<string, number>> = {};
  const counters: Record<string, number> = {};
  const singles = new Set(["PDH", "PDL", "ASIA_H", "ASIA_L", "CRT_H", "CRT_L", "ENTRY", "SL", "TP1", "TP2", "PD_EQ"]);
  const register = (prefix: string, values: Record<string, number>) => {
    counters[prefix] = (counters[prefix] || 0) + 1;
    const key = singles.has(prefix) ? prefix : `${prefix}${counters[prefix]}`;
    table[key] = values;
    return key;
  };
  const add = (drawing: Record<string, unknown>) => drawings.push({ ...drawing, id: `D${drawings.length + 1}` });
  const n = bars.length, timestamp = (i: number) => bars[Math.max(0, Math.min(n - 1, i))].timestamp_ms;
  let drawn = 0;
  for (const level of [...levels].sort((a, b) => Math.abs(a.price - ctx.price) - Math.abs(b.price - ctx.price))) {
    if (level.kind === "SWH" || level.kind === "SWL" || level.status === "broken") continue;
    if (level.status === "active" && drawn >= 7 && (level.kind === "EQH" || level.kind === "EQL")) continue;
    const key = register(level.kind, { price: round(level.price, 2) });
    const label = level.kind.replace(/_/g, " ") + (level.status === "swept" ? " swept" : "");
    add({ layer: level.kind.startsWith("CRT") ? "range" : "liquidity", type: "hline", ts1: level.ts,
      ts2: level.swept_i !== null && level.swept_i !== undefined ? timestamp(level.swept_i) : null,
      p1: round(level.price, 2), label: level.kind.startsWith("CRT") ? `${label} ${level.price.toFixed(2)}` : label,
      tone: level.side === "buy" ? "liq" : "liq2", style: level.status === "swept" ? "dotted" : "dashed", ref: key });
    drawn++;
  }
  for (const sweep of ctx.sweeps.slice(-4)) {
    const key = register("SWEEP", { price: round(sweep.extreme, 2), level: round(sweep.level, 2) });
    add({ layer: "liquidity", type: "tag", ts: sweep.ts, p1: round(sweep.extreme, 2), label: "Sweep",
      tone: "liq", pos: sweep.side === "buy" ? "above" : "below", ref: key });
  }
  for (const [name, value] of [["Range High", ctx.pd.high], ["Equilibrium", ctx.pd.eq], ["Range Low", ctx.pd.low]] as const) {
    add({ layer: "range", type: "hline", ts1: ctx.pd.ts1, ts2: null, p1: round(value, 2),
      label: `${name} ${value.toFixed(2)}`, tone: "muted", style: "dotted" });
  }
  table.PD_EQ = { price: round(ctx.pd.eq, 2) };
  for (const swing of ctx.swings.slice(-10)) add({ layer: "structure", type: "swing", ts: swing.ts,
    p1: round(swing.price, 2), side: swing.type, tone: "muted" });
  for (const event of ctx.events.slice(-6)) {
    const key = register(event.kind, { price: round(event.level, 2) });
    add({ layer: "structure", type: "hline", ts1: event.origin_ts, ts2: event.ts, p1: round(event.level, 2),
      label: event.kind, tone: event.dir, style: "solid", tag: true, ref: key });
  }
  let shown = 0;
  const keep = new Set(setups.map(setup => setup.fvg).filter((f): f is Zone => Boolean(f)));
  const fvgs = ctx.fvgs.filter(f => f.end_i === null && f.i >= n - 160 && (f.high - f.low >= 0.35 * ctx.atr || keep.has(f)))
    .sort((a, b) => b.i - a.i);
  for (const fvg of fvgs) {
    if (shown >= 4) break;
    const key = register("FVG", { low: round(fvg.low, 2), high: round(fvg.high, 2) });
    add({ layer: "zones", type: "box", ts1: fvg.ts, ts2: null, p1: round(fvg.high, 2), p2: round(fvg.low, 2),
      label: "FVG", tone: fvg.dir, ref: key });
    fvg.ref = key; shown++;
  }
  for (const ob of ctx.obs.filter(o => o.end_i === null).slice(-2)) {
    const key = register("OB", { low: round(ob.low, 2), high: round(ob.high, 2) });
    add({ layer: "zones", type: "box", ts1: ob.ts, ts2: null, p1: round(ob.high, 2), p2: round(ob.low, 2),
      label: "OB", tone: ob.dir, ref: key });
    ob.ref = key;
  }
  if (best) {
    const plan = best.plan;
    for (const [key, value] of [["ENTRY", plan.entry], ["SL", plan.stop], ["TP1", plan.tp1], ["TP2", plan.tp2]] as const) {
      table[key] = { price: Number(value) };
    }
    table.ENTRY.low = Number(plan.entry_low); table.ENTRY.high = Number(plan.entry_high);
    add({ layer: "plan", type: "plan", ts_start: plan.ts_start, bars_ahead: plan.bars_ahead,
      direction: plan.direction, entry: plan.entry, entry_low: plan.entry_low, entry_high: plan.entry_high,
      stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2, rr1: plan.rr1, rr2: plan.rr2,
      status: best.status, ltf_minutes: plan.ltf_minutes });
  }
  return { drawings, table };
}

/**
 * Deterministic candle-only ICT scan. feeds may map each timeframe to candle arrays
 * or feed objects containing a `bars` array.
 */
export function scanIct(
  feeds: IctFeeds,
  ltf: IctTimeframe = "M5",
  symbol = "XAUUSD",
  options: { minScore?: number } = {},
): IctScanResult {
  const minScore = options.minScore ?? 60;
  if (!["M1", "M5", "M15"].includes(ltf)) throw new Error("Entry timeframe must be M1, M5 or M15.");
  const normalizedSymbol = normalizeSymbol(symbol), bars = barsFrom(feeds[ltf]);
  if (!bars) throw new Error(`Missing ${ltf} candles.`);
  if (bars.length < 60) throw new Error(`Need at least 60 ${ltf} candles for an ICT scan (got ${bars.length}).`);
  const htf = barsFrom(feeds.H1), price = bars[bars.length - 1].close, atr = calcIctAtr(bars);
  const swings = findSwings(bars), structure = marketStructure(bars, swings);
  const structureByTf: Record<string, { trend: Direction | null; last_event: StructureEvent | null }> = {
    [ltf]: { trend: structure.trend, last_event: structure.events[structure.events.length - 1] || null },
  };
  const pdByTf: Record<string, ReturnType<typeof premiumDiscount>> = {};
  for (const tf of ["H1", "M15"]) {
    const tfBars = barsFrom(feeds[tf]);
    if (tfBars && tfBars.length >= 30 && tf !== ltf) {
      const st = marketStructure(tfBars, findSwings(tfBars));
      structureByTf[tf] = { trend: st.trend, last_event: st.events[st.events.length - 1] || null };
      pdByTf[tf] = premiumDiscount(tfBars, tfBars[tfBars.length - 1].close, 60);
    }
  }
  if (ltf === "M15") pdByTf.M15 = premiumDiscount(bars, price, 60);
  const bias = mtfBias(structureByTf, pdByTf.H1), crt = crtRange(htf);
  const { levels, sweeps } = buildLiquidity(bars, swings, atr, htf, crt, normalizedSymbol);
  const fvgs = findFvgs(bars, atr, normalizedSymbol);
  const obs = structure.events.slice(-8).map(event => orderBlockFor(bars, event)).filter((ob): ob is OrderBlock => Boolean(ob));
  const pd = premiumDiscount(bars, price), session = sessionInfo(bars[bars.length - 1].timestamp_ms);
  const ctx = { bars, ltf, atr, price, swings, events: structure.events, sweeps, fvgs, obs, liquidity: levels, pd, crt, bias, session, symbol: normalizedSymbol };
  const setups = [buildSetup("bear", ctx), buildSetup("bull", ctx)].filter((s): s is Setup => Boolean(s));
  [...setups].sort((a, b) => b.score - a.score).forEach((setup, i) => { setup.id = `S${i + 1}`; });
  setups.sort((a, b) => a.id!.localeCompare(b.id!));
  const live = setups.filter(setup => ["AWAITING_RETRACE", "IN_ENTRY_ZONE"].includes(setup.status) && setup.score >= minScore);
  const best = live.reduce<Setup | null>((top, candidate) => !top || candidate.score > top.score ? candidate : top, null);
  const show = best || setups.reduce<Setup | null>((top, candidate) => !top || candidate.score > top.score ? candidate : top, null);
  const { drawings, table } = buildDrawings(bars, { price, pd, atr, swings, events: structure.events, sweeps, fvgs, obs }, levels, setups, show);
  for (const setup of setups) {
    setup.refs = {
      sweep: Object.entries(table).find(([key, value]) => key.startsWith("SWEEP") && Math.abs(value.level - setup.sweep.level) < 0.01)?.[0] || null,
      event: Object.entries(table).find(([key, value]) => key.startsWith(setup.event.kind) && Math.abs(value.price - setup.event.level) < 0.01)?.[0] || null,
    };
    if (setup.fvg?.ref) setup.refs.fvg = setup.fvg.ref;
    if (setup.ob?.ref) setup.refs.ob = setup.ob.ref;
  }
  let direction: IctAction | "WAIT";
  let action: IctScanResult["action"];
  let score: number, reasons: string[];
  if (best) {
    direction = best.action; action = best.status === "AWAITING_RETRACE" ? "ENTER_ON_RETRACE" : "PRICE_IN_ENTRY_ZONE";
    reasons = best.reasons; score = best.score;
  } else {
    direction = "WAIT"; score = setups.reduce((max, setup) => Math.max(max, setup.score), 0);
    if (!setups.length) reasons = ["No liquidity sweep followed by MSS/BOS in the lookback window"];
    else {
      const top = setups.reduce((a, b) => b.score > a.score ? b : a);
      reasons = [`Best candidate ${top.action} is ${top.status} / score ${top.score} (< ${minScore} or not actionable)`, ...top.reasons];
    }
    action = "WAIT_FOR_SETUP";
  }
  const slimSetups: IctScanSetup[] = setups.map(setup => ({
    id: setup.id!, direction: setup.direction, action: setup.action, status: setup.status, score: setup.score,
    reasons: setup.reasons, arrays: setup.arrays, plan: setup.plan, refs: setup.refs!,
    sweep: { kind: setup.sweep.kind, level: setup.sweep.level, extreme: setup.sweep.extreme, ts: setup.sweep.ts },
    event: setup.event,
  }));
  const roundedPd: IctPd = {
    ...pd, high: round(pd.high, 2), low: round(pd.low, 2), eq: round(pd.eq, 2),
  };
  return {
    scan_type: "ict", symbol: normalizedSymbol, ltf, price: round(price, 2), atr: round(atr, 3), time_ms: bars[bars.length - 1].timestamp_ms,
    session, bias, structure: structureByTf, pd: roundedPd, pd_htf: pdByTf, crt, setups: slimSetups,
    selected: show?.id || null, direction, action, confluence_score: score, reasons,
    plan: show?.plan || null, plan_status: show?.status || null, drawings, level_table: table, min_score: minScore,
  };
}

const PRICE_PATTERN = /(?<![\d.,])(\d{3,7}(?:\.\d{1,3})?)(?![\d,])/g;

/** Validate that an optional AI review only chooses engine setups and engine levels. */
export function validateAiReview(review: IctAiReview, scan: IctScanResult, tolerance?: number): IctAiValidation {
  const issues: string[] = [];
  const priceTolerance = tolerance ?? Math.max(0.6, 0.15 * (Number(scan.atr) || 0));
  const prices: number[] = [];
  for (const level of Object.values(scan.level_table)) {
    for (const value of [level.price, level.low, level.high]) if (typeof value === "number") prices.push(value);
  }
  for (const setup of scan.setups) {
    const plan = setup.plan;
    prices.push(plan.entry, plan.entry_low, plan.entry_high, plan.stop, plan.tp1, plan.tp2);
  }
  prices.push(scan.price);

  const direction = (review.direction === undefined ? "WAIT" : String(review.direction)).toUpperCase();
  if (!["BUY", "SELL", "WAIT"].includes(direction)) issues.push(`invalid direction '${direction}'`);
  const selected = review.selected_setup;
  const setupIds = new Set(scan.setups.map(setup => setup.id));
  if (selected !== undefined && selected !== null && selected !== "NONE" && !setupIds.has(String(selected))) {
    issues.push(`unknown setup '${String(selected)}'`);
  }
  const refsValue = review.referenced_levels || [];
  let refs: unknown[];
  if (Array.isArray(refsValue)) refs = refsValue;
  else {
    refs = [];
    issues.push("referenced_levels is not a list");
  }
  for (const ref of refs) if (typeof ref !== "string" || !(ref in scan.level_table)) issues.push(`unknown level id '${String(ref)}'`);

  const text = ["narrative", "confirmation", "invalidation", "risk_note"]
    .map(key => String(review[key as keyof IctAiReview] ?? ""))
    .join(" ");
  for (const match of text.matchAll(PRICE_PATTERN)) {
    const value = Number(match[1]);
    if (0.5 * scan.price <= value && value <= 1.5 * scan.price && !prices.some(price => Math.abs(value - price) <= priceTolerance)) {
      issues.push(`price ${value} is not an engine level`);
    }
  }
  return { accepted: issues.length === 0, issues: issues.slice(0, 8) };
}

/** Apply engine-first AI confirmation/veto rules and feed freshness gating. */
export function combineIctVerdict(
  scan: IctScanResult,
  review: IctAiReview | null,
  validation: IctAiValidation | null,
  feedOk: boolean,
): IctVerdict {
  let finalDirection: IctVerdict["final_direction"] = scan.direction;
  let confidence = scan.confluence_score;
  const notes: string[] = [];
  let status: IctVerdict["verdict_status"] = "ENGINE_ONLY";
  if (review?.ok) {
    if (validation?.accepted) {
      const ai = review.verdict === "APPROVE"
        ? (review.direction === undefined ? "WAIT" : String(review.direction)).toUpperCase()
        : "WAIT";
      if (finalDirection === "WAIT") {
        status = "ENGINE_WAIT";
        if (ai === "BUY" || ai === "SELL") {
          notes.push("AI suggested a trade but the engine has no valid setup; AI cannot create levels, so WAIT.");
        }
      } else if (ai === finalDirection) {
        status = "ALIGNED";
        confidence = round(0.6 * confidence + 0.4 * Number(review.confidence ?? confidence));
      } else if (ai === "WAIT") {
        status = "AI_VETO";
        finalDirection = "WAIT";
        notes.push("AI mentor vetoed the engine setup.");
      } else {
        finalDirection = "WAIT";
        status = "CONFLICT";
        notes.push(`AI says ${ai} but the engine says ${finalDirection}; showing WAIT.`);
      }
    } else {
      status = "AI_REJECTED_BY_VALIDATOR";
      notes.push("AI answer was discarded (it referenced levels/prices that are not in the engine): "
        + (validation?.issues || []).slice(0, 3).join("; "));
    }
  } else if (review) {
    notes.push(`AI review unavailable: ${String(review.message ?? "").slice(0, 160)}`);
  }
  if (!feedOk && finalDirection !== "WAIT") {
    finalDirection = "WAIT";
    notes.push("Feed is stale or the market is closed: analysis shown for the last available candles, not a live signal.");
  }
  return { final_direction: finalDirection, final_confidence: Math.max(0, Math.min(100, round(confidence))),
    verdict_status: status, verdict_notes: notes };
}
