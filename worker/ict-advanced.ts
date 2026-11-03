import spec from "../shared/ict-engine-spec.json" with { type: "json" };

type Bar = { timestamp_ms: number; open: number; high: number; low: number; close: number };
type Fvg = {
  dir: "bull" | "bear"; low: number; high: number; i: number; end_i: number | null;
  invalidation_i?: number; ce?: number; size?: number; size_atr?: number; first_touch_i?: number | null;
  retest_count?: number; mitigation_pct?: number; lifecycle?: string;
};
type Displacement = {
  direction: "bull" | "bear" | null;
  classification: "WEAK" | "MODERATE" | "STRONG" | "EXTREME";
  body_atr: number;
  range_atr: number;
  close_location: number;
  wick_body_ratio: number;
  consecutive_directional_closes: number;
  reasons: string[];
};

const sessionSpec = spec.sessions;
const displacementSpec = spec.displacement;

function localParts(timestampMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: sessionSpec.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

export function ictLocalDateTime(timestampMs: number) { return localParts(timestampMs); }

function contains(minute: number, window: { start: string; end: string }): boolean {
  const toMinutes = (time: string) => {
    const [hour, mins] = time.split(":").map(Number);
    return hour * 60 + mins;
  };
  const start = toMinutes(window.start), end = toMinutes(window.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function ictSessionInfo(timestampMs: number) {
  const local = localParts(timestampMs), minute = local.hour * 60 + local.minute;
  let name = "OFF_HOURS", in_killzone = false;
  if (contains(minute, sessionSpec.asia)) name = "ASIA";
  else if (contains(minute, sessionSpec.london_killzone)) { name = "LONDON_KZ"; in_killzone = true; }
  else if (contains(minute, sessionSpec.new_york_killzone)) { name = "NY_KZ"; in_killzone = true; }
  else if (contains(minute, sessionSpec.london)) name = "LONDON";
  else if (contains(minute, sessionSpec.new_york)) name = "NEW_YORK";
  const date = new Date(timestampMs);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const localMinutes = local.hour * 60 + local.minute;
  let offset = localMinutes - utcMinutes;
  if (offset > 720) offset -= 1440;
  if (offset < -720) offset += 1440;
  return { name, in_killzone, utc_hour: Math.round(utcMinutes / 60 * 100) / 100,
    local_time: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
    timezone: sessionSpec.timezone, utc_offset_minutes: offset };
}

export function detectIctDisplacement(bars: Bar[], atr: number, index = bars.length - 1): Displacement {
  if (!bars.length || atr <= 0) return {
    direction: null, classification: "WEAK", body_atr: 0, range_atr: 0, close_location: 0.5,
    wick_body_ratio: 0, consecutive_directional_closes: 0, reasons: ["ATR or candle data unavailable"],
  };
  const candle = bars[index];
  const body = Math.abs(candle.close - candle.open), span = candle.high - candle.low;
  const direction = candle.close > candle.open ? "bull" : candle.close < candle.open ? "bear" : null;
  const body_atr = body / atr, range_atr = span / atr;
  const close_location = span <= 0 ? 0.5 : (candle.close - candle.low) / span;
  const wick_body_ratio = Math.max(0, span - body) / Math.max(body, 1e-12);
  let run = 0;
  for (let i = index; i >= 0; i--) {
    const bar = bars[i];
    if ((direction === "bull" && bar.close > bar.open) || (direction === "bear" && bar.close < bar.open)) run++;
    else break;
  }
  const favorableClose = direction === "bull" ? close_location : direction === "bear" ? 1 - close_location : 0;
  let classification: Displacement["classification"] = "WEAK";
  if (body_atr >= displacementSpec.extreme_body_atr && range_atr >= displacementSpec.extreme_range_atr
    && favorableClose >= displacementSpec.extreme_close_location && run >= displacementSpec.extreme_consecutive_closes) {
    classification = "EXTREME";
  } else if (body_atr >= displacementSpec.strong_body_atr && range_atr >= displacementSpec.strong_range_atr
    && favorableClose >= displacementSpec.strong_close_location) {
    classification = "STRONG";
  } else if (body_atr >= displacementSpec.moderate_body_atr && range_atr >= displacementSpec.moderate_range_atr
    && favorableClose >= displacementSpec.moderate_close_location) {
    classification = "MODERATE";
  }
  const reasons = [`body/ATR=${body_atr.toFixed(3)}`, `range/ATR=${range_atr.toFixed(3)}`,
    `close_location=${close_location.toFixed(3)}`];
  if (run >= 2) reasons.push(`${run} consecutive directional closes`);
  return { direction, classification, body_atr, range_atr, close_location, wick_body_ratio,
    consecutive_directional_closes: run, reasons };
}

export function detectIctCisd(bars: Bar[], atr: number) {
  if (bars.length < 2) return {
    status: "unavailable", direction: null, reference_open: null, confirmation_price: null, sequence: [], displacement: "WEAK",
  };
  const i = bars.length - 1, current = bars[i];
  const direction = current.close > current.open ? "bull" : current.close < current.open ? "bear" : null;
  if (!direction) return { status: "pending", direction: null, reference_open: null,
    confirmation_price: current.close, sequence: [], displacement: "WEAK" };
  const opposing = (bar: Bar) => direction === "bull" ? bar.close < bar.open : bar.close > bar.open;
  let start = i;
  const limit = spec.indicators.cisd_max_opposing_candles;
  while (start > 0 && i - start < limit && opposing(bars[start - 1])) start--;
  if (start === i) return { status: "pending", direction, reference_open: null, confirmation_price: current.close,
    sequence: [], displacement: detectIctDisplacement(bars, atr).classification };
  const reference = bars[start].open;
  const displacement = detectIctDisplacement(bars, atr);
  const confirmed = (direction === "bull" ? current.close > reference : current.close < reference)
    && ["MODERATE", "STRONG", "EXTREME"].includes(displacement.classification);
  return { status: confirmed ? "confirmed" : "pending", direction, reference_open: reference,
    confirmation_price: current.close, ts: current.timestamp_ms,
    sequence: Array.from({ length: i - start }, (_, offset) => start + offset),
    displacement: displacement.classification };
}

export function classifyIctRegime(bars: Bar[], trend: "bull" | "bear" | null, atr: number) {
  const minimum = spec.data_quality.minimum_bars_for_regime;
  if (bars.length < minimum || atr <= 0) return {
    regime: "UNKNOWN", confidence: 0, start_ts: null, duration: 0, reason: "Insufficient valid candles",
  };
  const recent = bars.slice(-10);
  const bullish = recent.filter(bar => bar.close > bar.open).length;
  const bearish = recent.filter(bar => bar.close < bar.open).length;
  const consistency = Math.max(bullish, bearish) / recent.length;
  const trueRanges = bars.slice(1).map((bar, index) => {
    const previousClose = bars[index].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const recentAtr = average(trueRanges.slice(-5));
  const baseline = average(trueRanges.slice(-20));
  const ratio = baseline ? recentAtr / baseline : 1;
  let regime: string, reason: string;
  if (ratio >= 1.5) { regime = "HIGH_VOLATILITY"; reason = "Recent true range expanded to at least 1.5x its 20-bar baseline"; }
  else if (ratio <= 0.65) { regime = "LOW_VOLATILITY"; reason = "Recent true range contracted to at most 0.65x its 20-bar baseline"; }
  else if (trend === "bull" && consistency >= 0.6) { regime = "TRENDING_BULLISH"; reason = "Confirmed bullish structure with consistent directional closes"; }
  else if (trend === "bear" && consistency >= 0.6) { regime = "TRENDING_BEARISH"; reason = "Confirmed bearish structure with consistent directional closes"; }
  else if (consistency <= 0.5) { regime = "RANGING"; reason = "No confirmed directional structure and mixed recent closes"; }
  else { regime = "TRANSITIONAL"; reason = "Structure and recent candle delivery are not aligned"; }
  const confidence = Math.min(100, Math.round(50 + Math.abs(consistency - 0.5) * 100 + Math.abs(ratio - 1) * 20));
  return { regime, confidence, start_ts: recent[0].timestamp_ms, duration: recent.length, reason,
    atr_expansion_ratio: ratio, directional_consistency: consistency };
}

export function analyzeAdvancedPdArrays(bars: Bar[], fvgs: Fvg[], atr: number) {
  const bprs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < fvgs.length; i++) {
    for (const second of fvgs.slice(i + 1)) {
      const first = fvgs[i];
      if (first.dir === second.dir) continue;
      const low = Math.max(first.low, second.low), high = Math.min(first.high, second.high);
      if (low >= high) continue;
      const bpr: Record<string, unknown> = {
        bull_fvg_i: first.dir === "bull" ? first.i : second.i,
        bear_fvg_i: first.dir === "bear" ? first.i : second.i,
        low, high, midpoint: (low + high) / 2, width: high - low, size_atr: atr ? (high - low) / atr : 0,
        formed_i: Math.max(first.i, second.i), mitigated: false,
      };
      bpr.mitigated = bars.slice(Number(bpr.formed_i) + 2).some(bar => bar.low <= high && bar.high >= low);
      bprs.push(bpr);
    }
  }
  const ifvgs: Array<Record<string, unknown>> = [];
  for (const fvg of fvgs) {
    if (fvg.end_i === null || fvg.end_i === undefined) continue;
    const direction = fvg.dir === "bull" ? "bear" : "bull";
    for (let i = fvg.end_i + 1; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.low <= fvg.high && bar.high >= fvg.low) {
        const midpoint = (fvg.low + fvg.high) / 2;
        const confirms = direction === "bear" ? bar.close < midpoint : bar.close > midpoint;
        if (confirms) ifvgs.push({ original_fvg_i: fvg.i, direction, low: fvg.low, high: fvg.high,
          reversal_i: fvg.end_i, retest_i: i, status: "confirmed" });
        break;
      }
    }
  }
  return { ifvgs, bprs };
}

export function enrichIctFvgs(bars: Bar[], fvgs: Fvg[], atr: number): void {
  for (const fvg of fvgs) {
    const width = fvg.high - fvg.low, ce = (fvg.low + fvg.high) / 2;
    let retestCount = 0, mitigation = 0, firstTouch: number | null = null, lifecycle = "UNTOUCHED";
    for (let i = fvg.i + 2; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.low <= fvg.high && bar.high >= fvg.low) {
        retestCount++;
        if (firstTouch === null) firstTouch = i;
        const progress = width ? (fvg.dir === "bull" ? fvg.high - bar.low : bar.high - fvg.low) / width : 1;
        mitigation = Math.max(mitigation, Math.min(1, Math.max(0, progress)));
        if (mitigation >= 1) lifecycle = "FULLY_FILLED";
        else if (bar.low <= ce && bar.high >= ce) lifecycle = "CONSEQUENT_ENCROACHMENT";
        else lifecycle = "PARTIALLY_MITIGATED";
      }
      if ((fvg.dir === "bull" && bar.close < fvg.low) || (fvg.dir === "bear" && bar.close > fvg.high)) {
        lifecycle = "INVALIDATED";
        fvg.invalidation_i = i;
        break;
      }
    }
    Object.assign(fvg, { ce, size: width, size_atr: atr ? width / atr : 0, first_touch_i: firstTouch,
      retest_count: retestCount, mitigation_pct: mitigation * 100, lifecycle });
  }
}

function atrFor(bars: Bar[], period = spec.indicators.atr_period): number {
  const ranges = bars.slice(1).map((bar, index) => {
    const previousClose = bars[index].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  }).slice(-period);
  return ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : 0;
}

export function validatedIctOte(
  bars: Bar[],
  event: { i: number; leg_start_i: number; dir: "bull" | "bear" } | null,
  atr: number,
) {
  if (!event || atr <= 0) return null;
  const eventBars = bars.slice(0, event.i + 1), displacement = detectIctDisplacement(eventBars, atrFor(eventBars));
  if (!["MODERATE", "STRONG", "EXTREME"].includes(displacement.classification)) return null;
  const start = event.leg_start_i, leg = bars.slice(start, event.i + 1);
  if (leg.length < 2) return null;
  const low = Math.min(...leg.map(bar => bar.low)), high = Math.max(...leg.map(bar => bar.high));
  const span = high - low;
  if (span <= 0) return null;
  const [shallow, , deep] = spec.fvg.ote_levels;
  const zone: [number, number] = event.dir === "bull"
    ? [high - deep * span, high - shallow * span]
    : [low + shallow * span, low + deep * span];
  const retracement = event.dir === "bull" ? (high - bars[bars.length - 1].close) / span * 100
    : (bars[bars.length - 1].close - low) / span * 100;
  return { low: zone[0], high: zone[1], midpoint: (zone[0] + zone[1]) / 2,
    anchor_start_i: start, anchor_end_i: event.i, event_i: event.i,
    retracement_pct: retracement, displacement: displacement.classification, valid: true };
}

export function ictDataQuality(bars: Bar[], timeframe: string) {
  const step = spec.timeframes_minutes[timeframe as keyof typeof spec.timeframes_minutes] * 60_000;
  let missing = 0;
  for (let i = 1; i < bars.length; i++) {
    const difference = bars[i].timestamp_ms - bars[i - 1].timestamp_ms;
    if (difference <= step || difference > 24 * 60 * 60_000) continue;
    missing += Math.max(0, Math.round(difference / step) - 1);
  }
  const score = Math.max(0, 100 - missing * 10);
  return { score, missing_intervals: missing, status: score >= 90 ? "GOOD" : score >= 70 ? "DEGRADED" : "POOR",
    last_candle_complete: true };
}
