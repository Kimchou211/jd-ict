import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { scanIct } from "../worker/ict-engine.ts";
import { classifyIctRegime, detectIctCisd, detectIctDisplacement, ictSessionInfo } from "../worker/ict-advanced.ts";
import { backtestIct } from "../worker/ict-backtest.ts";

const start = Date.UTC(2026, 9, 27, 8);

function bearishSetupBars() {
  const points: Array<[number, number]> = [[0, 4000], [12, 4009], [24, 4003], [36, 4010], [44, 4004], [51, 4009.5]];
  const rows: Array<[number, number, number, number, number]> = [[0, 4000, 4000.3, 3999.7, 4000]];
  let previous = points[0][1];
  for (let p = 0; p < points.length - 1; p++) {
    const [i0, p0] = points[p], [i1, p1] = points[p + 1];
    for (let i = i0 + 1; i <= i1; i++) {
      const close = p0 + (p1 - p0) * (i - i0) / (i1 - i0);
      rows.push([i, previous, Math.max(previous, close) + 0.3, Math.min(previous, close) - 0.3, close]);
      previous = close;
    }
  }
  rows.push([52, 4009.5, 4011, 4007.8, 4008], [53, 4008, 4008.2, 4002.2, 4002.5],
    [54, 4002.5, 4002.7, 3996.8, 3997], [55, 3997, 3997.5, 3993.8, 3994]);
  const tail = [3994.5, 3994.2, 3994.8, 3994.4, 3994.6, 3994.5, 3994.5, 3994.5, 3994.5, 3994.5];
  previous = 3994;
  for (const [offset, close] of tail.entries()) {
    rows.push([56 + offset, previous, Math.max(previous, close) + 0.3, Math.min(previous, close) - 0.3, close]);
    previous = close;
  }
  return rows.map(([index, open, high, low, close]) => ({
    timestamp_ms: start + index * 300_000, open, high, low, close,
  }));
}

function assertParity(actual: unknown, expected: unknown, path = "root"): void {
  if (typeof actual === "number" && typeof expected === "number") {
    assert.ok(Math.abs(actual - expected) <= Math.max(1e-8, Math.max(Math.abs(actual), Math.abs(expected)) * 1e-10),
      `${path}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path}.length`);
    actual.forEach((value, index) => assertParity(value, expected[index], `${path}[${index}]`));
    return;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const actualKeys = Object.keys(actual).sort(), expectedKeys = Object.keys(expected).sort();
    assert.deepEqual(actualKeys, expectedKeys, `${path}.keys`);
    for (const key of actualKeys) {
      assertParity((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  assert.equal(actual, expected, path);
}

test("Python and Worker produce matching ICT scans from identical candles", () => {
  const bars = bearishSetupBars();
  const worker = scanIct({ M5: bars }, "M5", "XAUUSD");
  const script = [
    "import json, sys",
    "from app.ict_engine import scan",
    "payload = json.load(sys.stdin)",
    "print(json.dumps(scan({'M5': payload['bars']}, 'M5', payload['symbol']), separators=(',', ':')))",
  ].join("\n");
  const python = JSON.parse(execFileSync("python", ["-c", script], {
    cwd: process.cwd(), input: JSON.stringify({ bars, symbol: "XAUUSD" }), encoding: "utf8",
  })) as unknown;
  assertParity(worker, python);

  const feeds = { M5: bars, M15: bars };
  const multiTimeframeWorker = scanIct(feeds, "M5", "XAUUSD");
  const multiScript = [
    "import json, sys",
    "from app.ict_engine import scan",
    "payload = json.load(sys.stdin)",
    "print(json.dumps(scan(payload['feeds'], 'M5', payload['symbol']), separators=(',', ':')))",
  ].join("\n");
  const multiPython = JSON.parse(execFileSync("python", ["-c", multiScript], {
    cwd: process.cwd(), input: JSON.stringify({ feeds, symbol: "XAUUSD" }), encoding: "utf8",
  })) as unknown;
  assertParity(multiTimeframeWorker, multiPython);
});

test("historical replay is chronological and matches Python backtest output", () => {
  const bars = bearishSetupBars();
  const options = { spread: 0.1, slippage: 0.05, commissionR: 0.01, entryDelayBars: 1 };
  const worker = backtestIct({ M5: bars }, "M5", "XAUUSD", options);
  for (const trade of worker.trades) {
    assert.ok(trade.signal_time_ms <= bars.at(-1)!.timestamp_ms + 300_000);
    assert.ok(trade.entry_time_ms === null || trade.entry_time_ms > trade.signal_time_ms);
  }
  assert.ok(worker.assumptions.some(assumption => assumption.includes("No look-ahead")));
  const script = [
    "import json, sys",
    "from app.ict_backtest import backtest_ict",
    "payload = json.load(sys.stdin)",
    "print(json.dumps(backtest_ict({'M5': payload['bars']}, 'M5', payload['symbol'], **payload['options']), separators=(',', ':')))",
  ].join("\n");
  const python = JSON.parse(execFileSync("python", ["-c", script], {
    cwd: process.cwd(), input: JSON.stringify({ bars, symbol: "XAUUSD", options: {
      spread: options.spread, slippage: options.slippage, commission_r: options.commissionR,
      entry_delay_bars: options.entryDelayBars,
    } }), encoding: "utf8",
  })) as unknown;
  assertParity(worker, python);
});

test("Python and Worker match DST-aware sessions and advanced candle measurements", () => {
  const bars = bearishSetupBars();
  const atr = 2.4;
  const sessions = [Date.UTC(2026, 2, 8, 7, 30), Date.UTC(2026, 10, 1, 6, 30)]
    .map(timestamp => ictSessionInfo(timestamp));
  const worker = {
    sessions,
    displacement: detectIctDisplacement(bars, atr),
    cisd: detectIctCisd(bars, atr),
    regime: classifyIctRegime(bars, "bear", atr),
  };
  const script = [
    "import json, sys",
    "from app.ict_advanced import classify_regime, detect_cisd, detect_displacement, session_info",
    "payload = json.load(sys.stdin)",
    "bars, atr = payload['bars'], payload['atr']",
    "result = {'sessions': [session_info(ts) for ts in payload['timestamps']],",
    "'displacement': detect_displacement(bars, atr), 'cisd': detect_cisd(bars, atr),",
    "'regime': classify_regime(bars, 'bear', atr)}",
    "print(json.dumps(result, separators=(',', ':')))",
  ].join("\n");
  const python = JSON.parse(execFileSync("python", ["-c", script], {
    cwd: process.cwd(),
    input: JSON.stringify({ bars, atr, timestamps: [Date.UTC(2026, 2, 8, 7, 30), Date.UTC(2026, 10, 1, 6, 30)] }),
    encoding: "utf8",
  })) as unknown;
  assertParity(worker, python);
});
