import assert from "node:assert/strict";
import test from "node:test";
import { buildTradeRead } from "../worker/trade-engine.ts";

const env = {
  APP_NAME: "JD ANALYSIS",
  MAX_UPLOAD_MB: "12",
  CONFIDENCE_MINIMUM: "65",
  PRICE_AGREEMENT_ABSOLUTE: "0.50",
  ATR_AGREEMENT_PERCENT: "0.20",
  FORCE_SIGNAL: "false",
} as const;

function provider(direction: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "Gemini",
    model: "test-model",
    symbol: "XAUUSD",
    direction,
    confidence: 72,
    setup_rationale: "Visible structure test.",
    timeframe_alignment: "aligned",
    chart_reads: [
      {
        timeframe: "M1",
        symbol_detected: "XAUUSD",
        current_price: 2350,
        current_price_readable: true,
        atr_value: 2,
        atr_visible: true,
        atr_period: 14,
        price_scale_top: 2360,
        price_scale_bottom: 2340,
        price_scale_readable: true,
        trend: "bullish",
        structure: "Higher highs and higher lows.",
        annotations: [],
      },
      {
        timeframe: "M5",
        symbol_detected: "XAUUSD",
        current_price: 2350.1,
        current_price_readable: true,
        atr_value: 4,
        atr_visible: true,
        atr_period: 14,
        price_scale_top: 2370,
        price_scale_bottom: 2330,
        price_scale_readable: true,
        trend: "bullish",
        structure: "Higher timeframe bullish structure.",
        annotations: [],
      },
    ],
    pullback_zones: {
      BUY: { low: 2344.5, high: 2346, quality: "estimated", basis: "Support retest." },
      SELL: { low: 2353, high: 2354.5, quality: "estimated", basis: "Resistance retest." },
    },
    entry_trigger_buy: "Break the recent swing high and retest.",
    entry_trigger_sell: "Break below the recent swing low and fail the retest.",
    ...overrides,
  };
}

test("strict mode calculates screenshot levels only after all verification checks pass", () => {
  const result = buildTradeRead([provider("BUY")], {}, "M1", "M5", env);
  assert.equal(result.direction, "BUY");
  assert.equal(result.levels_available, true);
  assert.equal(result.trade_ready, false);
  assert.equal(result.entry_price, 2350);
  assert.equal(result.validation && (result.validation as Record<string, unknown>).levels_calculated, true);
  assert.equal(result.signal_status, "PROVISIONAL_SINGLE_MODEL");
  assert.equal((result.validation as Record<string, unknown>).single_provider_mode, true);
});

test("strict mode keeps conditional scenarios and withholds levels for unreadable prices", () => {
  const item = provider("WAIT");
  const chartReads = item.chart_reads.map((read) => ({
    ...read,
    current_price: null,
    current_price_readable: false,
    atr_value: null,
    atr_visible: false,
  }));
  const result = buildTradeRead([provider("WAIT", { chart_reads: chartReads })], {}, "M1", "M5", env);
  const setups = result.conditional_setups as Array<Record<string, unknown>>;
  assert.equal(result.direction, "WAIT");
  assert.equal(result.levels_available, false);
  assert.deepEqual(setups.map((setup) => setup.direction), ["BUY", "SELL"]);
  assert.equal(setups[0].pullback_low, 2344.5);
});

test("forced mode produces best-effort levels from axis estimates and marks the signal provisional", () => {
  const forcedEnv = { ...env, FORCE_SIGNAL: "true" };
  const item = provider("BUY", {
    chart_reads: [
      { trend: "bullish", confidence: 60, price_estimate: 2350, atr_estimate: 2, price_scale_top: 2360, price_scale_bottom: 2340, price_scale_readable: true },
      { trend: "bullish", confidence: 60, price_estimate: 2350.1, atr_estimate: 4, price_scale_top: 2370, price_scale_bottom: 2330, price_scale_readable: true },
    ],
  });
  const result = buildTradeRead([item], {}, "M1", "M5", forcedEnv);
  assert.equal(result.direction, "BUY");
  assert.equal(result.forced_signal, true);
  assert.equal(result.trade_ready, false);
  assert.equal(result.levels_available, true);
  assert.equal(result.entry_price, 2350);
  assert.equal(result.entry_low, 2349.81);
  assert.equal(result.entry_high, 2350.19);
  assert.equal(result.stop_loss, 2347.69);
  assert.equal(result.take_profit_1, 2352.31);
  assert.equal(result.take_profit_2, 2354.16);
  assert.equal((result.validation as Record<string, unknown>).single_provider_mode, true);
  assert.ok((result.risk_notes as string[]).some((note) => /one AI provider is active/i.test(note)));
  assert.ok(["C", "D"].includes(String(result.signal_grade)));
});

test("trend-only forced direction uses localhost fallback confidence without overwriting provider confidence", () => {
  const result = buildTradeRead(
    [provider("WAIT", { confidence: 72 })],
    {},
    "M1",
    "M5",
    { ...env, FORCE_SIGNAL: "true" },
  );
  assert.equal(result.direction, "BUY");
  assert.equal(result.confidence, 35);
  assert.equal((result.providers as Array<Record<string, unknown>>)[0].confidence, 72);
});

test("a successful provider remains provisional when the other provider fails", () => {
  const result = buildTradeRead(
    [provider("BUY")],
    { DeepSeek: "DeepSeek unavailable." },
    "M1",
    "M5",
    { ...env, DEEPSEEK_API_KEY: "configured" },
  );
  const status = result.provider_status as Record<string, Record<string, unknown>>;
  const validation = result.validation as Record<string, unknown>;
  assert.equal(result.signal_status, "PROVISIONAL_SINGLE_MODEL");
  assert.equal(validation.provider_count, 1);
  assert.equal(validation.single_provider_mode, true);
  assert.equal(status.DeepSeek.status, "failed");
  assert.equal(status.DeepSeek.error, "DeepSeek unavailable.");
  assert.ok((result.risk_notes as string[]).some((note) => note.includes("DeepSeek provider unavailable")));
});

test("ICT annotations retain approved metadata and reject out-of-range normalized coordinates", () => {
  const annotations = [
    { type: "line", ict: "BOS", layer: "structure", x1: 10, y1: 200, x2: 900, y2: 200, label: "BOS" },
    { type: "line", ict: "MSS", layer: "structure", x1: 10, y1: 300, x2: 900, y2: 300, label: "MSS" },
    { type: "text", ict: "SWEEP", layer: "liquidity", x: 500, y: 450, label: "Sweep" },
    { type: "rect", ict: "FVG", layer: "zones", x: 400, y: 500, w: 200, h: 60, label: "FVG" },
    { type: "rect", ict: "OB", layer: "zones", x: 350, y: 600, w: 180, h: 80, label: "OB" },
    ...["EQH", "EQL", "PDH", "PDL"].map((ict, index) => ({
      type: "line", ict, layer: "liquidity", x1: 100, y1: 100 + index * 30, x2: 900, y2: 100 + index * 30, label: ict,
    })),
    ...["CRT_H", "CRT_L"].map((ict, index) => ({
      type: "line", ict, layer: "range", x1: 100, y1: 500 + index * 30, x2: 900, y2: 500 + index * 30, label: ict,
    })),
    { type: "text", ict: "SWING", layer: "structure", x: 220, y: 420, label: "SH" },
    { type: "rect", ict: "PREMIUM", layer: "range", x: 700, y: 100, w: 150, h: 120, label: "Premium" },
    { type: "rect", ict: "DISCOUNT", layer: "range", x: 700, y: 700, w: 150, h: 120, label: "Discount" },
    { type: "line", ict: "BOS", layer: "structure", x1: 1001, y1: 200, x2: 900, y2: 200, label: "invalid" },
  ];
  const result = buildTradeRead([provider("WAIT", {
    chart_reads: [
      { ...provider("WAIT").chart_reads[0], annotations },
      provider("WAIT").chart_reads[1],
    ],
  })], {}, "M1", "M5", env);
  const chartReads = result.chart_reads as Array<{ annotations: Array<Record<string, unknown>> }>;
  const restored = chartReads[0].annotations;
  assert.equal(restored.length, 14);
  assert.ok(restored.some((item) => item.ict === "BOS" && item.layer === "structure"));
  assert.ok(restored.some((item) => item.ict === "SWEEP" && item.layer === "liquidity"));
  assert.ok(restored.some((item) => item.ict === "FVG" && item.layer === "zones"));
  assert.ok(restored.some((item) => item.ict === "PREMIUM" && item.layer === "range"));
  assert.ok(restored.every((item) => ["liquidity", "structure", "zones", "range", "plan"].includes(String(item.layer))));
  assert.ok(restored.every((item) => Object.values(item).every((value) => typeof value !== "number" || (value >= 0 && value <= 1000))));
});

test("BTCUSD uses its symbol profile for validation and forced entry levels", () => {
  const btcProvider = provider("BUY", {
    symbol: "BTCUSD",
    chart_reads: [
      {
        ...provider("BUY").chart_reads[0],
        symbol_detected: "BTC/USD",
        current_price: 65_000,
        price_scale_top: 66_000,
        price_scale_bottom: 64_000,
      },
      {
        ...provider("BUY").chart_reads[1],
        symbol_detected: "BTCUSD",
        current_price: 65_010,
        price_scale_top: 66_100,
        price_scale_bottom: 63_900,
      },
    ],
  });
  const forcedEnv = { ...env, FORCE_SIGNAL: "true" };
  const result = buildTradeRead([btcProvider], {}, "M1", "M5", forcedEnv, "BTCUSD");
  assert.equal(result.symbol, "BTCUSD");
  assert.equal((result.validation as Record<string, unknown>).symbol_confirmed, true);
  assert.equal(result.entry_price, 65_000);
  assert.equal(result.levels_available, true);
});

test("reported confidence 1 is not inflated in forced mode", () => {
  const one = provider("BUY", { confidence: 1 });
  one.chart_reads = one.chart_reads.map((read) => ({ ...read, confidence: 1 }));
  const result = buildTradeRead([one], {}, "M1", "M5", { ...env, FORCE_SIGNAL: "true" });
  assert.equal(result.confidence, 1);
  assert.equal((result.providers as Array<Record<string, unknown>>)[0].confidence, 1);
});
