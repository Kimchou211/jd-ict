import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyStats } from "../worker/daily-stats.ts";

test("daily statistics use the viewer timezone and exclude WAIT signals", () => {
  const records = [
    { created_at: "2026-01-01T19:30:00.000Z", symbol: "XAUUSD", direction: "BUY", stop_loss: 99, payload_json: '{"outcome":{"result":"TP1","r":1.25}}' },
    { created_at: "2026-01-01T20:00:00.000Z", symbol: "XAUUSD", direction: "SELL", stop_loss: 101, payload_json: '{"outcome":{"result":"SL"}}' },
    { created_at: "2026-01-01T20:30:00.000Z", symbol: "XAUUSD", direction: "BUY", stop_loss: 99, payload_json: '{"outcome":{"result":"SKIP"}}' },
    { created_at: "2026-01-01T21:00:00.000Z", symbol: "XAUUSD", direction: "BUY", stop_loss: 99, payload_json: "{}" },
    { created_at: "2026-01-01T21:15:00.000Z", symbol: "XAUUSD", direction: "WAIT", stop_loss: null, payload_json: "{}" },
  ];
  const result = buildDailyStats(records, 14, 420, Date.parse("2026-01-02T03:00:00.000Z"));
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].date, "2026-01-02");
  assert.equal(result.days[0].signals, 4);
  assert.equal(result.days[0].wins, 1);
  assert.equal(result.days[0].resolved, 2);
  assert.equal(result.days[0].win_rate, 50);
  assert.equal(result.days[0].tp1, 1);
  assert.equal(result.days[0].sl, 1);
  assert.equal(result.days[0].not_taken, 1);
  assert.equal(result.days[0].open, 1);
  assert.equal(result.days[0].total_r, 0.25);
  assert.equal(result.today.date, "2026-01-02");
});

test("daily statistics apply symbol filter and return empty today summary", () => {
  const records = [
    { created_at: "2026-02-10T12:00:00Z", symbol: "BTCUSD", direction: "BUY", stop_loss: 99, payload_json: '{"outcome":{"result":"TP2"}}' },
    { created_at: "2026-02-10T13:00:00Z", symbol: "XAUUSD", direction: "SELL", stop_loss: 101, payload_json: '{"outcome":{"result":"SL"}}' },
  ];
  const result = buildDailyStats(records, 3, 0, Date.parse("2026-02-11T00:00:00Z"), "XAUUSD");
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].symbol, undefined);
  assert.equal(result.days[0].signals, 1);
  assert.equal(result.days[0].sl, 1);
  assert.equal(result.today.signals, 0);
  assert.equal(result.today.date, "2026-02-11");
});
