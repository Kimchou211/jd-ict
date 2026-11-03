import assert from "node:assert/strict";
import test from "node:test";
import { combineIctVerdict, scanIct, validateAiReview } from "../worker/ict-engine.ts";

const start = Date.UTC(2026, 9, 27, 8);

function linear(points: Array<[number, number]>, wick = 0.3) {
  const rows: Array<[number, number, number, number, number]> = [];
  let previous = points[0][1];
  for (let p = 0; p < points.length - 1; p++) {
    const [i0, p0] = points[p], [i1, p1] = points[p + 1];
    for (let i = i0 + 1; i <= i1; i++) {
      const close = p0 + (p1 - p0) * (i - i0) / (i1 - i0);
      rows.push([i, previous, Math.max(previous, close) + wick, Math.min(previous, close) - wick, close]);
      previous = close;
    }
  }
  return rows;
}

function bearishSetupBars() {
  const points: Array<[number, number]> = [[0, 4000], [12, 4009], [24, 4003], [36, 4010], [44, 4004], [51, 4009.5]];
  const rows: Array<[number, number, number, number, number]> = [[0, 4000, 4000.3, 3999.7, 4000], ...linear(points)];
  rows.push(
    [52, 4009.5, 4011, 4008.8, 4008],
    [53, 4008, 4008.2, 4002.2, 4002.5],
    [54, 4002.5, 4002.7, 3996.8, 3997],
    [55, 3997, 3997.5, 3993.8, 3994],
  );
  const tail = [3994.5, 3994.2, 3994.8, 3994.4, 3994.6, 3994.5, 3994.5, 3994.5, 3994.5, 3994.5];
  let previous = 3994;
  for (const [offset, close] of tail.entries()) {
    rows.push([56 + offset, previous, Math.max(previous, close) + 0.3, Math.min(previous, close) - 0.3, close]);
    previous = close;
  }
  return rows.map(([i, open, high, low, close]) => ({
    timestamp_ms: start + i * 300_000, open, high, low, close,
  }));
}

test("ICT scan detects a sweep, bearish MSS and geometrically valid retracement plan", () => {
  const result = scanIct({ M5: { bars: bearishSetupBars() } }, "M5", "XAUUSD");
  assert.equal(result.symbol, "XAUUSD");
  assert.equal(result.direction, "SELL");
  assert.equal(result.plan_status, "AWAITING_RETRACE");
  assert.ok(Object.keys(result.level_table as object).some(key => key.startsWith("SWEEP")));
  assert.ok(Object.keys(result.level_table as object).some(key => key.startsWith("MSS")));
  assert.ok(Object.keys(result.level_table as object).some(key => key.startsWith("FVG")));

  const plan = result.plan as Record<string, number>;
  assert.ok(plan.stop > plan.entry_high && plan.entry_high >= plan.entry && plan.entry >= plan.entry_low);
  assert.ok(plan.entry_low > plan.tp1 && plan.tp1 > plan.tp2);
  assert.ok(plan.rr1 >= 1.5);
  assert.ok((result.drawings as Array<Record<string, unknown>>).some(drawing => drawing.type === "plan"));
});

test("ICT scan accepts supported BTC aliases and rejects insufficient history", () => {
  const scaledBars = bearishSetupBars().map(bar => ({
    ...bar, open: bar.open * 25, high: bar.high * 25, low: bar.low * 25, close: bar.close * 25,
  }));
  const result = scanIct({ M5: scaledBars }, "M5", "BTC/USDT");
  assert.equal(result.symbol, "BTCUSD");
  assert.equal(result.direction, "SELL");
  assert.ok((result.plan as Record<string, number>).entry > 90_000);
  assert.throws(() => scanIct({ M5: scaledBars.slice(0, 40) }, "M5"), /Need at least 60/);
});

test("scanIct applies an optional minimum score while preserving the default threshold", () => {
  const feeds = { M5: bearishSetupBars() };
  const defaultScan = scanIct(feeds, "M5", "XAUUSD");
  assert.equal(defaultScan.min_score, 60);
  assert.equal(defaultScan.direction, "SELL");

  const highThresholdScan = scanIct(feeds, "M5", "XAUUSD", { minScore: 101 });
  assert.equal(highThresholdScan.min_score, 101);
  assert.equal(highThresholdScan.direction, "WAIT");
  assert.equal(highThresholdScan.plan_status, "AWAITING_RETRACE");
});

test("AI review may confirm or veto only engine-issued levels and setups", () => {
  const result = scanIct({ M5: bearishSetupBars() }, "M5", "XAUUSD");
  const setup = result.setups[0];
  const review = {
    ok: true, verdict: "APPROVE", direction: "SELL", selected_setup: setup.id,
    referenced_levels: ["ENTRY"], narrative: `Sell near ${(setup.plan.entry).toFixed(2)}`, confidence: 80,
  };
  const validation = validateAiReview(review, result);
  assert.equal(validation.accepted, true);
  assert.equal(combineIctVerdict(result, review, validation, true).verdict_status, "ALIGNED");
  assert.equal(combineIctVerdict(result, { ...review, verdict: "REJECT" }, validation, true).verdict_status, "AI_VETO");

  const invalid = validateAiReview({ ...review, referenced_levels: ["UNKNOWN"], narrative: "Target 9999.00" }, result);
  assert.equal(invalid.accepted, false);
  assert.equal(combineIctVerdict(result, review, invalid, true).verdict_status, "AI_REJECTED_BY_VALIDATOR");
  assert.equal(combineIctVerdict(result, null, null, false).final_direction, "WAIT");
});
