import assert from "node:assert/strict";
import test from "node:test";
import { analyzeEvent, buildStatus, classify, parseValue } from "../worker/news.ts";

test("classifies the tracked USD events", () => {
  assert.equal(classify("Core CPI m/m")[0], "CORE_CPI");
  assert.equal(classify("Non-Farm Employment Change")[0], "NFP");
  assert.equal(classify("Unemployment Claims")[0], "JOBLESS");
  assert.equal(classify("Fed Chair Powell Speaks")[0], "FED_SPEECH");
});

test("parses K/M/% values", () => {
  assert.equal(parseValue("225K"), 225000);
  assert.equal(parseValue("-0.1%"), -0.1);
  assert.equal(parseValue("-"), null);
});

test("hot CPI pushes gold down first; weak NFP and high claims push gold up", () => {
  const cpi = analyzeEvent("CPI m/m", "0.5%", "0.3%", "0.2%");
  assert.equal(cpi.magnitude, "STRONG");
  assert.equal(cpi.gold_bias, "DOWN");
  assert.equal(analyzeEvent("Non-Farm Employment Change", "90K", "180K", "150K").gold_bias, "UP");
  assert.equal(analyzeEvent("Unemployment Claims", "240K", "225K", "220K").gold_bias, "UP");
  assert.equal(analyzeEvent("CPI m/m", "0.3%", "0.3%", "0.2%").gold_bias, "NEUTRAL");
  assert.equal(analyzeEvent("CPI m/m", null, "0.3%", "0.2%").status, "PENDING");
});

test("blackout window is information only and uses the configured minutes", () => {
  const now = Date.now();
  const ev = { id: "x", ts_ms: now + 20 * 60000, iso: "", title: "CPI m/m", country: "USD", impact: "high", category: "CPI", label: "CPI", forecast: null, previous: null, actual: null, blackout: true, source: "t" } as const;
  assert.equal(buildStatus([ev], {} as never, now).blackout, true);
  assert.equal(buildStatus([ev], {} as never, now - 45 * 60000).blackout, false);
});
