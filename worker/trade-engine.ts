import type { Env, JsonRecord } from "./types";
import { matchesSymbol, symbolProfile } from "./symbols.ts";

const TF_MINUTES: Record<string, number> = {
  M1: 1, M2: 2, M3: 3, M5: 5, M10: 10, M15: 15, M30: 30,
  H1: 60, H2: 120, H4: 240, D1: 1440, W1: 10080, MN1: 43200,
};
const SIDES = new Set(["BUY", "SELL"]);
const ICT_KINDS = new Set(["BOS", "MSS", "SWEEP", "FVG", "OB", "EQH", "EQL", "PDH", "PDL", "CRT_H", "CRT_L", "SWING", "PREMIUM", "DISCOUNT"]);
const ANNOTATION_LAYERS = new Set(["liquidity", "structure", "zones", "range", "plan"]);
const ICT_LAYERS: Record<string, string> = {
  BOS: "structure", MSS: "structure", SWING: "structure",
  SWEEP: "liquidity", EQH: "liquidity", EQL: "liquidity", PDH: "liquidity", PDL: "liquidity",
  FVG: "zones", OB: "zones", CRT_H: "range", CRT_L: "range", PREMIUM: "range", DISCOUNT: "range",
};

function num(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function readAt(result: JsonRecord, index: number): JsonRecord {
  return records(result.chart_reads)[index] || {};
}

function text(value: unknown, fallback = "", limit = 1200): string {
  return ["string", "number"].includes(typeof value) ? String(value).trim().slice(0, limit) : fallback;
}

function within(a: number, b: number, absolute: number, pct: number): boolean {
  return Math.abs(a - b) <= Math.max(absolute, Math.abs((a + b) / 2) * pct);
}

function providerValue(
  results: JsonRecord[],
  index: number,
  key: string,
  readableKey: string | null,
  absolute: number,
  pct: number,
): [number | null, boolean] {
  const values: number[] = [];
  for (const result of results) {
    const read = readAt(result, index);
    if (readableKey && read[readableKey] !== true) return [null, false];
    const value = num(read[key]);
    if (value === null || value <= 0) return [null, false];
    values.push(value);
  }
  if (!values.length) return [null, false];
  if (!values.every((value) => within(values[0], value, absolute, pct))) return [null, false];
  return [values.reduce((sum, value) => sum + value, 0) / values.length, true];
}

function consensusDirection(results: JsonRecord[]): [string, boolean] {
  const directions = results.map((item) => text(item.direction, "WAIT").toUpperCase());
  if (directions.length === 1) return SIDES.has(directions[0]) ? [directions[0], false] : ["WAIT", false];
  if (directions.length >= 2 && SIDES.has(directions[0]) && directions.every((side) => side === directions[0])) {
    return [directions[0], true];
  }
  return ["WAIT", false];
}

function sanitizeAnnotations(read: JsonRecord): JsonRecord[] {
  const result: JsonRecord[] = [];
  for (const item of records(read.annotations).slice(0, 14)) {
    const kind = item.type;
    if (kind !== "line" && kind !== "rect" && kind !== "text") continue;
    const keys = kind === "line" ? ["x1", "y1", "x2", "y2"]
      : kind === "rect" ? ["x", "y", "w", "h"] : ["x", "y"];
    const ict = text(item.ict).toUpperCase().replaceAll(" ", "_");
    const layer = text(item.layer).toLowerCase();
    const clean: JsonRecord = {
      type: kind,
      label: text(item.label, "", 80),
      ...(ICT_KINDS.has(ict) ? { ict } : {}),
      layer: ANNOTATION_LAYERS.has(layer) ? layer : ICT_LAYERS[ict] || "structure",
    };
    let valid = true;
    for (const key of keys) {
      const value = num(item[key]);
      if (value === null || value < 0 || value > 1000) {
        valid = false;
        break;
      }
      clean[key] = value;
    }
    if (valid) result.push(clean);
  }
  return result;
}

function pullbackSetup(
  results: JsonRecord[],
  direction: string,
  profile: ReturnType<typeof symbolProfile>,
): JsonRecord {
  const candidates = results.flatMap((result) => {
    const zone = record(record(result.pullback_zones)[direction]);
    const low = num(zone.low);
    const high = num(zone.high);
    if (low === null || high === null || low < profile.price_min || high > profile.price_max || low >= high) return [];
    const quality = text(zone.quality).toLowerCase();
    return [{
      low, high,
      quality: quality === "read" || quality === "estimated" ? quality : "estimated",
      basis: text(zone.basis, "", 240),
      provider: text(result.provider, "AI", 40),
      confidence: num(result.confidence) || 0,
    }];
  });
  const unavailable: JsonRecord = {
    pullback_low: null, pullback_high: null, pullback_quality: "unavailable",
    pullback_basis: "No usable zone was returned for this side.", pullback_provider: "",
    pullback_agreement: "unavailable",
  };
  if (!candidates.length) return unavailable;
  candidates.sort((a, b) => Number(b.quality === "read") - Number(a.quality === "read") || b.confidence - a.confidence);
  const selected = candidates[0];
  const second = candidates[1];
  if (second
    && within(selected.low, second.low, profile.price_abs, profile.price_pct)
    && within(selected.high, second.high, profile.price_abs, profile.price_pct)) {
    return {
      pullback_low: round((selected.low + second.low) / 2, 2),
      pullback_high: round((selected.high + second.high) / 2, 2),
      pullback_quality: selected.quality === "read" && second.quality === "read" ? "corroborated" : "axis_estimate",
      pullback_basis: selected.basis || second.basis || "Both AI readers identified a similar structure zone.",
      pullback_provider: `${selected.provider} + ${second.provider}`,
      pullback_agreement: "agreed",
    };
  }
  return {
    pullback_low: round(selected.low, 2),
    pullback_high: round(selected.high, 2),
    pullback_quality: selected.quality === "estimated" ? "axis_estimate" : "single_read",
    pullback_basis: selected.basis || "AI-identified support/resistance retest area.",
    pullback_provider: selected.provider,
    pullback_agreement: second ? "models_differed" : "single_model",
  };
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function buildSummary(out: JsonRecord): string {
  const parts = [
    `Bias: ${text(out.model_bias, "WAIT")} | Decision: ${text(out.direction, "WAIT")} | Status: ${text(out.signal_status, "WAIT_FOR_CONFIRMATION")}.`,
  ];
  if (out.signal_grade) parts.push(`Signal grade ${text(out.signal_grade)}: ${text(out.grade_summary)}`);
  for (const setup of records(out.conditional_setups)) {
    const low = num(setup.pullback_low);
    const high = num(setup.pullback_high);
    if (low !== null && high !== null) {
      parts.push(`${text(setup.direction)} pullback watch zone: ${low.toFixed(2)}–${high.toFixed(2)} (${text(setup.pullback_quality, "estimate")}).`);
    }
  }
  if (out.levels_available) {
    parts.push(`Screenshot reference price: ${num(out.entry_price)?.toFixed(2)}; entry zone ${num(out.entry_low)?.toFixed(2)}–${num(out.entry_high)?.toFixed(2)}; SL ${num(out.stop_loss)?.toFixed(2)}; TP1 ${num(out.take_profit_1)?.toFixed(2)}; TP2 ${num(out.take_profit_2)?.toFixed(2)}.`);
    parts.push("These are image-derived values, not a live quote. Single-provider numbers are provisional.");
  }
  for (const item of records(out.chart_reads)) {
    parts.push(`${text(item.timeframe)}: trend ${text(item.trend)}; price ${item.current_price_verified ? "readable" : "unverified"}; ATR ${item.atr_verified ? "readable" : "unverified"}. ${text(item.structure)}`);
  }
  if (Array.isArray(out.risk_notes) && out.risk_notes.length) {
    parts.push(`Checks: ${(out.risk_notes as unknown[]).slice(0, 4).map((item) => text(item)).join(" ")}`);
  }
  return parts.join("\n\n");
}

function buildStrictRead(
  results: JsonRecord[],
  providerErrors: Record<string, string>,
  tfPrimary: string,
  tfSecondary: string,
  env: Env,
  symbol: string,
): JsonRecord {
  const profile = symbolProfile(symbol);
  let [modelBias, directionAgreed] = consensusDirection(results);
  const primary = results[0] || {};
  if (results.length >= 2 && !directionAgreed) modelBias = "WAIT";
  const confidences = results.map((item) => num(item.confidence)).filter((value): value is number => value !== null)
    .map((value) => Math.max(0, Math.min(100, value)));
  const confidence = confidences.length ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length) : 0;
  const providerCount = results.length;
  const out: JsonRecord = {
    symbol: profile.name, mode: "IMAGE_ONLY", direction: "WAIT", model_bias: modelBias,
    trade_ready: false, levels_available: false, signal_status: "WAIT_FOR_CONFIRMATION",
    confidence, entry_price: null, entry_low: null, entry_high: null, stop_loss: null,
    take_profit_1: null, take_profit_2: null, atr_primary: null, atr_secondary: null,
    effective_atr: null, price_source: "Uploaded screenshot only; not live market data",
    atr_method: "Numeric levels require a clearly readable screenshot price and ATR value on both timeframes.",
    setup_rationale: text(primary.setup_rationale, `Upload clearer ${profile.name} screenshots to receive a chart read.`),
    invalidation: text(primary.invalidation, "Wait for clear structural invalidation/confirmation."),
    bull_case: text(primary.bull_case), bear_case: text(primary.bear_case),
    timeframe_alignment: text(primary.timeframe_alignment, "unclear"),
    setup_type: text(primary.setup_type, "none"), risk_notes: [],
    validation: {
      provider_count: providerCount, provider_errors: providerErrors,
      direction_agreement: directionAgreed, current_price_agreement: false, atr_agreement: false,
      secondary_price_alignment: false, symbol_confirmed: false, atr_periods_visible: false,
      levels_calculated: false, single_provider_mode: providerCount === 1,
    },
    provider_errors: providerErrors,
    provider_status: {
      Gemini: {
        status: results.some((item) => item.provider === "Gemini") ? "ok" : env.GEMINI_API_KEY ? "failed" : "not_configured",
        model: env.GEMINI_MODEL || "gemini-3.6-flash",
        confidence: num(results.find((item) => item.provider === "Gemini")?.confidence),
        error: providerErrors.Gemini || null,
      },
      DeepSeek: {
        status: results.some((item) => item.provider === "DeepSeek") ? "ok" : env.DEEPSEEK_API_KEY ? "failed" : "not_configured",
        model: env.DEEPSEEK_VISION_MODEL || "deepseek-flash",
        confidence: num(results.find((item) => item.provider === "DeepSeek")?.confidence),
        error: providerErrors.DeepSeek || null,
      },
    },
    providers: results.map((item) => ({
      name: text(item.provider, "Unknown"), model: text(item.model), model_name: text(item.model),
      direction: text(item.direction, "WAIT"), confidence: num(item.confidence) ?? 0,
      chart_confidence: records(item.chart_reads).map((read) => num(read.confidence)),
    })),
    chart_reads: [], conditional_setups: [],
  };

  for (const [direction, label, triggerKey, caseKey] of [
    ["BUY", "Bullish / BUY scenario", "entry_trigger_buy", "bull_case"],
    ["SELL", "Bearish / SELL scenario", "entry_trigger_sell", "bear_case"],
  ]) {
    let trigger = text(primary[triggerKey]) || text(primary[caseKey]);
    if (!trigger) trigger = direction === "BUY"
      ? "AI did not provide a chart-specific trigger. Wait for a visible break of structure and retest; no numeric level is verified."
      : "AI did not provide a chart-specific trigger. Wait for a visible breakdown of structure and failed retest; no numeric level is verified.";
    const scenario: JsonRecord = {
      direction, title: label, trigger,
      invalidation: text(primary.invalidation, "Require a clear structural invalidation level before considering entry."),
      numeric_levels_available: false,
    };
    Object.assign(scenario, pullbackSetup(results, direction, profile));
    (out.conditional_setups as JsonRecord[]).push(scenario);
  }

  const priceAbs = profile.name === "XAUUSD" ? num(env.PRICE_AGREEMENT_ABSOLUTE) ?? profile.price_abs : profile.price_abs;
  const atrPct = num(env.ATR_AGREEMENT_PERCENT) ?? 0.2;
  const tfNames = [tfPrimary, tfSecondary];
  for (let index = 0; index < 2; index++) {
    const [price, priceOk] = providerValue(results, index, "current_price", "current_price_readable", priceAbs, profile.price_pct);
    const [atr, atrOk] = providerValue(results, index, "atr_value", "atr_visible", profile.atr_abs, atrPct);
    const [top, topOk] = providerValue(results, index, "price_scale_top", "price_scale_readable", priceAbs, profile.price_pct);
    const [bottom, bottomOk] = providerValue(results, index, "price_scale_bottom", "price_scale_readable", priceAbs, profile.price_pct);
    const reads = results.map((item) => readAt(item, index));
    const trends = reads.map((item) => text(item.trend, "unclear").toLowerCase());
    const structures = reads.map((item) => text(item.structure, "", 900)).filter(Boolean);
    const periods = reads.map((item) => num(item.atr_period)).filter((value): value is number => value !== null && value > 0);
    const periodOk = results.length === 1
      ? periods.length === 1
      : periods.length === results.length && new Set(periods.map(Math.trunc)).size === 1;
    const scaleOk = topOk && bottomOk && top !== null && bottom !== null && top > bottom && top - bottom >= 0.05;
    let keyLevels: JsonRecord[] = [];
    for (const providerRead of reads) {
      keyLevels = records(providerRead.key_levels).slice(0, 8).flatMap((level) => {
        const value = num(level.price);
        return value !== null && value >= profile.price_min && value <= profile.price_max
          ? [{ price: round(value, 2), kind: text(level.kind, "other"), label: text(level.label, "", 90) }]
          : [];
      });
      if (keyLevels.length) break;
    }
    const annotations = reads.flatMap((item) => sanitizeAnnotations(item));
    const uniqueAnnotations = [...new Map(annotations.map((item) => [JSON.stringify(item), item])).values()].slice(0, 14);
    const chartRead: JsonRecord = {
      timeframe: tfNames[index],
      trend: trends.length && trends.every((value) => value === trends[0]) ? trends[0] : trends.length === 1 ? trends[0] : "mixed",
      trend_agreement: Boolean(trends.length) && trends.every((value) => value === trends[0]),
      structure: structures[0] || "No readable structure summary.",
      current_price: priceOk && price !== null && price >= profile.price_min && price <= profile.price_max ? round(price, 2) : null,
      current_price_verified: Boolean(priceOk && price !== null && price >= profile.price_min && price <= profile.price_max),
      current_price_verification_mode: providerCount >= 2 ? "cross-model" : "single-model image read",
      atr_value: atrOk && atr !== null && atr >= Math.max(0.001, profile.atr_floor / 10) && atr <= Math.max(500, profile.atr_floor * 1000) ? round(atr, 3) : null,
      atr_verified: Boolean(atrOk && atr !== null && atr >= Math.max(0.001, profile.atr_floor / 10) && atr <= Math.max(500, profile.atr_floor * 1000)),
      atr_verification_mode: providerCount >= 2 ? "cross-model" : "single-model image read",
      atr_period: periodOk ? Math.trunc(periods[0]) : null,
      price_scale: { top: scaleOk ? round(top!, 2) : null, bottom: scaleOk ? round(bottom!, 2) : null, verified: Boolean(scaleOk) },
      key_levels: keyLevels, annotations: uniqueAnnotations,
      provider_reads: results.map((item) => {
        const read = readAt(item, index);
        return {
          name: text(item.provider, "Unknown"),
          model: text(item.model),
          confidence: num(item.confidence),
          chart_confidence: num(read.confidence),
          timeframe: text(read.timeframe),
          symbol_detected: text(read.symbol_detected, "unknown"),
          trend: text(read.trend, "unclear"),
          structure: text(read.structure, "", 900),
          current_price: num(read.current_price),
          current_price_readable: read.current_price_readable === true,
          price_estimate: num(read.price_estimate),
          atr_value: num(read.atr_value),
          atr_visible: read.atr_visible === true,
          atr_estimate: num(read.atr_estimate),
          atr_period: num(read.atr_period),
          price_scale_top: num(read.price_scale_top),
          price_scale_bottom: num(read.price_scale_bottom),
          price_scale_readable: read.price_scale_readable === true,
          key_levels: records(read.key_levels).slice(0, 8),
          annotations: sanitizeAnnotations(read),
        };
      }),
    };
    (out.chart_reads as JsonRecord[]).push(chartRead);
  }

  const reads = out.chart_reads as JsonRecord[];
  const pricesOk = reads.every((item) => item.current_price_verified === true);
  const atrsOk = reads.every((item) => item.atr_verified === true);
  const p0 = num(reads[0].current_price);
  const p1 = num(reads[1].current_price);
  const priceAlignment = pricesOk && p0 !== null && p1 !== null && within(p0, p1, profile.agree_abs, profile.price_pct);
  const validation = out.validation as JsonRecord;
  validation.current_price_agreement = pricesOk && (providerCount === 1 || reads.every((item) => item.current_price_verified));
  validation.atr_agreement = atrsOk;
  validation.secondary_price_alignment = priceAlignment;
  validation.symbol_confirmed = Boolean(providerCount) && results.every((item) =>
    matchesSymbol(item.symbol, profile.name)
    && [0, 1].every((index) => matchesSymbol(readAt(item, index).symbol_detected, profile.name)));
  validation.requested_symbol = profile.name;
  validation.timeframe_alignment = out.timeframe_alignment;
  validation.price_verified_by_timeframe = reads.map((item) => item.current_price_verified === true);
  validation.atr_verified_by_timeframe = reads.map((item) => item.atr_verified === true);
  const allPeriods = results.flatMap((item) => [0, 1].map((index) => num(readAt(item, index).atr_period)));
  const periodsVerified = allPeriods.length === providerCount * 2
    && allPeriods.every((value) => value !== null && value > 0)
    && new Set(allPeriods.map((value) => Math.trunc(value!))).size === 1;
  validation.atr_periods_visible = periodsVerified;
  if (providerCount === 1 && SIDES.has(text(primary.direction).toUpperCase())) {
    out.model_bias = text(primary.direction).toUpperCase();
    out.signal_status = "PROVISIONAL_SINGLE_MODEL";
  } else if (directionAgreed && SIDES.has(modelBias)) {
    out.signal_status = "DUAL_MODEL_DIRECTION_AGREEMENT";
  }

  const notes = results.flatMap((item) => Array.isArray(item.risk_notes) ? (item.risk_notes as unknown[]).slice(0, 5).map((note) => text(note, "", 220)) : []);
  if (providerCount === 1) notes.push(providerErrors && Object.keys(providerErrors).length
    ? "Only one AI provider responded. Its chart read and conditional scenarios are shown, but numerical levels remain provisional."
    : "Only one AI provider is active. Conditional scenarios are available; independent corroboration is unavailable.");
  if (!pricesOk) notes.push("A readable last-price badge was not identified on both screenshots. Numeric reference levels cannot be validated.");
  if (!atrsOk) notes.push("A numeric ATR readout was not visible/readable on both screenshots.");
  if (!periodsVerified) notes.push("ATR period was not consistently readable on both screenshots.");
  if (pricesOk && !priceAlignment) notes.push("The screenshot reference prices differ materially. Capture both timeframes close together using the same feed.");
  if (validation.symbol_confirmed !== true) notes.push(`${profile.name} symbol could not be confirmed from both screenshots and provider response.`);
  for (const [provider, error] of Object.entries(providerErrors)) {
    notes.push(`${provider} provider unavailable: ${text(error, "analysis failed", 220)}`);
  }
  if (providerCount >= 2 && !directionAgreed) notes.push("The two AI readers did not agree on direction. Review the conditional BUY/SELL triggers.");
  const directionalOk = SIDES.has(text(out.model_bias));
  const confidenceOk = confidence >= (num(env.CONFIDENCE_MINIMUM) ?? 65);
  const canCalculate = pricesOk && atrsOk && priceAlignment && periodsVerified
    && validation.symbol_confirmed === true && directionalOk && confidenceOk
    && (providerCount === 1 || directionAgreed);
  if (canCalculate) {
    const ap = num(reads[0].atr_value)!;
    const secondaryAtr = num(reads[1].atr_value)!;
    const primaryMinutes = TF_MINUTES[tfPrimary] || 1;
    const secondaryMinutes = TF_MINUTES[tfSecondary] || 5;
    const effectiveAtr = 0.65 * ap + 0.35 * secondaryAtr * Math.sqrt(primaryMinutes / secondaryMinutes);
    const entry = p0!;
    const halfWidth = effectiveAtr * 0.1;
    const risk = effectiveAtr * 1.2;
    const sign = out.model_bias === "BUY" ? 1 : -1;
    Object.assign(out, {
      levels_available: true, direction: out.model_bias,
      signal_status: providerCount === 1 ? "PROVISIONAL_SINGLE_MODEL" : "DUAL_MODEL_CORROBORATED",
      trade_ready: providerCount >= 2 && directionAgreed,
      entry_price: round(entry, 2), entry_low: round(entry - halfWidth, 2), entry_high: round(entry + halfWidth, 2),
      stop_loss: round(entry - sign * risk, 2), take_profit_1: round(entry + sign * risk, 2),
      take_profit_2: round(entry + sign * risk * 1.8, 2),
      atr_primary: round(ap, 3), atr_secondary: round(secondaryAtr, 3), effective_atr: round(effectiveAtr, 3),
      atr_method: `Image-read ATRs: ATR ${tfPrimary} × 0.65 + ATR ${tfSecondary} normalized by sqrt(${primaryMinutes}/${secondaryMinutes}) × 0.35; app-defined effective ATR. SL=1.20R, TP1=1.00R, TP2=1.80R. Screenshot-only reference, not live quote.`,
    });
    validation.levels_calculated = true;
    (out.conditional_setups as JsonRecord[]).forEach((setup) => {
      if (setup.direction === out.direction) setup.numeric_levels_available = true;
    });
    if (providerCount === 1) notes.push("Numeric levels are calculated from one model's explicit image reads only. Verify each number against the screenshot before use.");
  } else {
    if (!directionalOk) notes.push("No single directional edge was established. Use the conditional BUY and SELL scenarios.");
    if (directionalOk && !confidenceOk) notes.push(`Directional bias exists, but confidence (${confidence}/100) is below threshold (${num(env.CONFIDENCE_MINIMUM) ?? 65}).`);
  }
  out.risk_notes = [...new Set(notes)].slice(0, 12);
  out.analysis_text = buildSummary(out);
  return out;
}

function providerSide(result: JsonRecord): string | null {
  for (const value of [result.direction, result.forced_direction, result.preferred_setup]) {
    const side = text(value).toUpperCase();
    if (SIDES.has(side)) return side;
  }
  return null;
}

function trendSide(value: unknown): string | null {
  const trend = text(value).toLowerCase();
  return trend === "bullish" ? "BUY" : trend === "bearish" ? "SELL" : null;
}

function forcedDirection(results: JsonRecord[], tfPrimary: string, tfSecondary: string): [string | null, string] {
  const higherTimeframeIndex = (TF_MINUTES[tfPrimary] || 0) >= (TF_MINUTES[tfSecondary] || 0) ? 0 : 1;
  const trendFallback = (): string | null => {
    for (const index of [higherTimeframeIndex, 1 - higherTimeframeIndex]) {
      for (const result of results) {
        const side = trendSide(readAt(result, index).trend);
        if (side) return side;
      }
    }
    return null;
  };
  const weights = { BUY: 0, SELL: 0 };
  const sides: string[] = [];
  for (const result of results) {
    const side = providerSide(result);
    if (!side) continue;
    sides.push(side);
    weights[side as "BUY" | "SELL"] += Math.max(1, num(result.confidence) || 50);
  }
  if (!sides.length) {
    const side = trendFallback();
    return side ? [side, "trend"] : [null, "none"];
  }
  if (new Set(sides).size === 1) return [sides[0], sides.length >= 2 ? "agreed" : "single"];
  if (weights.BUY !== weights.SELL) return [weights.BUY > weights.SELL ? "BUY" : "SELL", "split"];
  return [trendFallback() || sides[0], "split"];
}

function bestValue(
  results: JsonRecord[],
  index: number,
  key: string,
  readableKey: string | null,
  estimateKey: string | null,
  min: number | null,
  max: number | null,
  tolerance: [number, number],
): [number | null, string | null] {
  const readValues: Array<[number, number]> = [];
  const estimates: Array<[number, number]> = [];
  for (const result of results) {
    const chart = readAt(result, index);
    const confidence = num(chart.confidence) ?? num(result.confidence) ?? 0;
    const value = num(chart[key]);
    const estimate = estimateKey ? num(chart[estimateKey]) : null;
    const flagged = readableKey === null || chart[readableKey] === true;
    if (value !== null && value > 0 && flagged) readValues.push([confidence, value]);
    else {
      if (value !== null && value > 0) estimates.push([confidence, value]);
      if (estimate !== null && estimate > 0) estimates.push([confidence, estimate]);
    }
  }
  const usable = (pairs: Array<[number, number]>) => pairs.filter(([, value]) =>
    (min === null || value >= min) && (max === null || value <= max));
  const merge = (pairs: Array<[number, number]>): number => {
    if (pairs.length >= 2 && pairs.slice(1).every(([, value]) => within(pairs[0][1], value, tolerance[0], tolerance[1]))) {
      return pairs.reduce((sum, [, value]) => sum + value, 0) / pairs.length;
    }
    return [...pairs].sort((a, b) => b[0] - a[0])[0][1];
  };
  const printable = usable(readValues);
  if (printable.length) return [merge(printable), "read"];
  const fallback = usable(estimates);
  return fallback.length ? [merge(fallback), "estimated"] : [null, null];
}

function grade(mode: string, priceQuality: string | null, atrQuality: string | null, confidence: number, alignment: string): string {
  let score = ({ agreed: 2, single: 0, trend: 0, split: -1 } as Record<string, number>)[mode] ?? 0;
  score += ({ read: 2, estimated: 1 } as Record<string, number>)[priceQuality || ""] ?? 0;
  score += ({ read: 2, estimated: 1 } as Record<string, number>)[atrQuality || ""] ?? 0;
  if (confidence >= 65) score++;
  if (alignment.toLowerCase() === "aligned") score++;
  return score >= 7 ? "A" : score >= 5 ? "B" : score >= 3 ? "C" : "D";
}

function gradeSummary(value: string, mode: string, priceQuality: string | null, atrQuality: string | null): string {
  const meaning: Record<string, string> = {
    A: "both AIs agree and price + ATR were read from the screenshots",
    B: "good read, minor items unconfirmed",
    C: "some inputs were estimated - treat as lower quality",
    D: "weak: split opinion and/or mostly estimated inputs - small size or skip",
  };
  const modes: Record<string, string> = {
    agreed: "both AIs agree", single: "single AI", split: "AIs disagreed (majority/confidence used)",
    trend: "direction taken from chart trend", none: "no direction",
  };
  return `${meaning[value]}. Direction: ${modes[mode] || mode}; price: ${priceQuality || "missing"}; ATR: ${atrQuality || "missing"}.`;
}

function addPriceLines(out: JsonRecord): void {
  for (const chart of records(out.chart_reads)) {
    const scale = record(chart.price_scale);
    if (scale.verified !== true) continue;
    const bottom = num(scale.bottom);
    const top = num(scale.top);
    if (bottom === null || top === null) continue;
    const annotations = records(chart.annotations);
    for (const [label, key] of [["ENTRY", "entry_price"], ["SL", "stop_loss"], ["TP1", "take_profit_1"], ["TP2", "take_profit_2"]]) {
      const value = num(out[key]);
      if (value !== null && value >= bottom && value <= top) annotations.push({ type: "price_line", price: value, label: `${label} ${value.toFixed(2)}` });
    }
    chart.annotations = annotations;
  }
}

function applyForcedSignal(
  out: JsonRecord,
  results: JsonRecord[],
  tfPrimary: string,
  tfSecondary: string,
  env: Env,
  symbol: string,
): JsonRecord {
  const validation = record(out.validation);
  const strictOk = out.levels_available === true && SIDES.has(text(out.direction));
  const alignment = text(out.timeframe_alignment, "unclear");
  if (strictOk) {
    const mode = validation.direction_agreement ? "agreed" : "single";
    const signalGrade = grade(mode, "read", "read", num(out.confidence) ?? 0, alignment);
    Object.assign(out, {
      forced_signal: false,
      signal_grade: signalGrade,
      grade_summary: gradeSummary(signalGrade, mode, "read", "read"),
    });
    out.analysis_text = buildSummary(out);
    return out;
  }
  const [direction, mode] = forcedDirection(results, tfPrimary, tfSecondary);
  const notes = (Array.isArray(out.risk_notes) ? out.risk_notes as unknown[] : [])
    .map((note) => text(note))
    .filter((note) => !note.startsWith("No single directional edge")
      && !note.startsWith("Directional bias exists, but qualitative confidence")
      && !note.startsWith("The two AI readers did not agree on direction"));
  if (!direction) {
    notes.unshift("The AI returned no usable direction for these screenshots. Upload clearer charts (symbol, price axis and candles visible).");
    out.risk_notes = [...new Set(notes)].slice(0, 12);
    out.analysis_text = buildSummary(out);
    return out;
  }
  const split = mode === "split";
  const sideConfidence = results.filter((result) => providerSide(result) === direction)
    .map((result) => num(result.confidence))
    .filter((value): value is number => value !== null)
    .map((value) => Math.max(0, Math.min(100, value)));
  const profile = symbolProfile(symbol);
  const actualConfidence = mode === "trend"
    ? results.map((result) => num(result.confidence)).filter((value): value is number => value !== null)
    : sideConfidence;
  const confidence = mode === "trend"
    ? 35
    : Math.round((actualConfidence.length
      ? actualConfidence.reduce((sum, value) => sum + value, 0) / actualConfidence.length
      : 40) * (split ? 0.85 : 1));
  const tfMinutes = [TF_MINUTES[tfPrimary] || 1, TF_MINUTES[tfSecondary] || 5];
  const priceAbs = profile.name === "XAUUSD" ? num(env.PRICE_AGREEMENT_ABSOLUTE) ?? profile.price_abs : profile.price_abs;
  const priceTolerance: [number, number] = [priceAbs, profile.price_pct];
  const [price0, priceQ0] = bestValue(results, 0, "current_price", "current_price_readable", "price_estimate", profile.price_min, profile.price_max, priceTolerance);
  const [price1, priceQ1] = bestValue(results, 1, "current_price", "current_price_readable", "price_estimate", profile.price_min, profile.price_max, priceTolerance);
  let price: number | null = null;
  let priceQuality: string | null = null;
  if (price0 !== null && price1 !== null) {
    [price, priceQuality] = priceQ0 !== "read" && priceQ1 === "read" ? [price1, priceQ1] : [price0, priceQ0];
    if (!within(price0, price1, profile.agree_abs, profile.price_pct)) notes.push(`The two screenshots show different prices (${price0.toFixed(2)} vs ${price1.toFixed(2)}). Entry uses the more reliable one.`);
  } else if (price0 !== null) [price, priceQuality] = [price0, priceQ0];
  else if (price1 !== null) [price, priceQuality] = [price1, priceQ1];
  const chartReads = out.chart_reads as JsonRecord[];
  chartReads[0].current_price_est = price0 !== null && priceQ0 === "estimated" ? round(price0, 2) : null;
  chartReads[1].current_price_est = price1 !== null && priceQ1 === "estimated" ? round(price1, 2) : null;

  let levels = false;
  let atrQuality: string | null = null;
  let atr0: number | null = null;
  let atr1: number | null = null;
  let effectiveAtr: number | null = null;
  let atrNote = "";
  let atrQ0: string | null = null;
  let atrQ1: string | null = null;
  if (price !== null) {
    const atrTolerance: [number, number] = [profile.atr_abs, num(env.ATR_AGREEMENT_PERCENT) ?? 0.2];
    const min = price * 0.00005;
    const max = price * 0.02;
    [atr0, atrQ0] = bestValue(results, 0, "atr_value", "atr_visible", "atr_estimate", min, max, atrTolerance);
    [atr1, atrQ1] = bestValue(results, 1, "atr_value", "atr_visible", "atr_estimate", min, max, atrTolerance);
    chartReads[0].atr_est = atr0 !== null && atrQ0 === "estimated" ? round(atr0, 3) : null;
    chartReads[1].atr_est = atr1 !== null && atrQ1 === "estimated" ? round(atr1, 3) : null;
    const normalizedSecondary = atr1 !== null ? atr1 * Math.sqrt(tfMinutes[0] / tfMinutes[1]) : null;
    if (atr0 !== null && normalizedSecondary !== null && Math.max(atr0, normalizedSecondary) / Math.min(atr0, normalizedSecondary) <= 3) {
      effectiveAtr = 0.65 * atr0 + 0.35 * normalizedSecondary;
      atrQuality = atrQ0 === "read" && atrQ1 === "read" ? "read" : "estimated";
      atrNote = `0.65 x ATR ${tfPrimary} + 0.35 x ATR ${tfSecondary} normalized by sqrt(${tfMinutes[0]}/${tfMinutes[1]})`;
    } else if (atr0 !== null) {
      effectiveAtr = atr0; atrQuality = atrQ0; atrNote = `ATR ${tfPrimary}`;
      if (normalizedSecondary !== null) notes.push("The ATR values on the two charts are inconsistent (more than 3x apart); only the primary chart ATR was used.");
    } else if (normalizedSecondary !== null) {
      effectiveAtr = normalizedSecondary; atrQuality = atrQ1; atrNote = `ATR ${tfSecondary} normalized to ${tfPrimary}`;
    } else {
      const [top] = bestValue(results, 0, "price_scale_top", "price_scale_readable", null, profile.price_min, profile.price_max, [priceAbs, profile.price_pct]);
      const [bottom] = bestValue(results, 0, "price_scale_bottom", "price_scale_readable", null, profile.price_min, profile.price_max, [priceAbs, profile.price_pct]);
      effectiveAtr = top !== null && bottom !== null && top > bottom
        ? (top - bottom) * 0.05
        : price * 0.0008 * Math.sqrt(Math.max(tfMinutes[0], 1) / 5);
      atrNote = top !== null && bottom !== null && top > bottom
        ? "rough: 5% of the visible price-axis span"
        : "rough: 0.08% of price scaled by timeframe";
      atrQuality = "heuristic";
    }
    effectiveAtr = Math.max(effectiveAtr, profile.atr_floor);
    const risk = effectiveAtr * 1.2;
    const halfWidth = effectiveAtr * 0.1;
    const sign = direction === "BUY" ? 1 : -1;
    levels = true;
    Object.assign(out, {
      entry_price: round(price, 2), entry_low: round(price - halfWidth, 2),
      entry_high: round(price + halfWidth, 2), stop_loss: round(price - sign * risk, 2),
      take_profit_1: round(price + sign * risk, 2), take_profit_2: round(price + sign * risk * 1.8, 2),
      atr_primary: atr0 === null ? null : round(atr0, 3),
      atr_secondary: atr1 === null ? null : round(atr1, 3),
      effective_atr: round(effectiveAtr, 3),
      atr_method: `Forced-signal levels. Effective ATR = ${atrNote} (source: ${atrQuality}). R = 1.20 x effective ATR; SL = 1R, TP1 = 1R, TP2 = 1.8R. Entry = screenshot price (${priceQuality}). Screenshot-only reference, not a live quote.`,
    });
    if (priceQuality === "estimated") notes.push("No last-price badge was readable, so entry is an estimate from the price axis. Check it against MT5 before ordering.");
    if (atrQuality !== "read") notes.push(`ATR was not fully readable on the charts (${atrQuality}). SL/TP distances are approximate.`);
  } else {
    notes.push("No price could be read or estimated from the screenshots, so Entry/SL/TP are omitted. Use the BUY/SELL trigger text.");
  }
  const signalGrade = grade(mode, priceQuality, atrQuality, confidence, alignment);
  if (split) notes.unshift("The two AIs disagreed on direction; the higher-confidence side was used. Treat this as a low-agreement signal.");
  notes.unshift(`FORCED SIGNAL (grade ${signalGrade}): strict validation did not pass, so this result is a best-effort call, not a validated trade.`);
  Object.assign(out, {
    direction, model_bias: direction, confidence, forced_signal: true,
    signal_status: "FORCED_SIGNAL", trade_ready: false, levels_available: levels,
    signal_grade: signalGrade,
    grade_summary: gradeSummary(signalGrade, mode, priceQuality, atrQuality),
    signal_basis: { direction: mode, price: priceQuality, atr: atrQuality },
  });
  validation.levels_calculated = levels;
  for (const setup of records(out.conditional_setups)) {
    if (setup.direction === direction) setup.numeric_levels_available = levels;
  }
  if (levels) addPriceLines(out);
  out.risk_notes = [...new Set(notes)].slice(0, 12);
  out.analysis_text = buildSummary(out);
  return out;
}

export function buildTradeRead(
  providerResults: JsonRecord[],
  providerErrors: Record<string, string>,
  tfPrimary: string,
  tfSecondary: string,
  env: Env,
  symbol = "XAUUSD",
): JsonRecord {
  const normalizedSymbol = symbolProfile(symbol).name;
  const strict = buildStrictRead(providerResults, providerErrors, tfPrimary, tfSecondary, env, normalizedSymbol);
  return env.FORCE_SIGNAL?.trim().toLowerCase() === "false"
    ? strict
    : applyForcedSignal(strict, providerResults, tfPrimary, tfSecondary, env, normalizedSymbol);
}
