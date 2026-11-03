import assert from "node:assert/strict";
import test from "node:test";
import { fetchMarketCandles } from "../worker/market-data.ts";
import { fetchLiveMarket } from "../worker/live-market.ts";
import type { Env } from "../worker/types.ts";

function timeSeries() {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  return {
    values: Array.from({ length: 45 }, (_, index) => {
      const time = new Date(now - (44 - index) * 60_000).toISOString().slice(0, 19).replace("T", " ");
      const close = 2300 + index / 10;
      return { datetime: time, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: "10" };
    }),
  };
}

function yahooChart() {
  const now = Math.floor(Date.now() / 60_000);
  const count = 45;
  const close = Array.from({ length: count }, (_, index) => 60_000 + index / 10);
  return {
    chart: {
      result: [{
        timestamp: Array.from({ length: count }, (_, index) => now - (count - 1 - index) * 60),
        indicators: { quote: [{
          open: close.map((value) => value - 0.1),
          high: close.map((value) => value + 0.2),
          low: close.map((value) => value - 0.2),
          close,
          volume: close.map(() => 10),
        }] },
      }],
    },
  };
}

test("live market uses configured Twelve Data feed", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return Response.json(timeSeries());
  };
  try {
    const env = { TWELVEDATA_API_KEY: "test-key" } as Env;
    const result = await fetchLiveMarket("1m", env);
    assert.match(calledUrl, /api\.twelvedata\.com\/time_series/);
    assert.equal(result.symbol, "XAUUSD");
    assert.equal(result.bars && (result.bars as unknown[]).length, 45);
    assert.match(String(result.source), /Twelve Data/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Yahoo feed is used when Twelve Data rejects the request", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    return url.includes("twelvedata.com")
      ? Response.json({ status: "error", message: "rate limit" }, { status: 429 })
      : Response.json(yahooChart());
  };
  try {
    const result = await fetchMarketCandles("BTCUSD", "M1", { TWELVEDATA_API_KEY: "test-key" } as Env);
    assert.equal(urls.length, 2);
    assert.match(String(result.source), /Yahoo Finance/);
    assert.match(String(result.fallback_reason), /rate limit/);
    assert.equal(result.symbol, "BTCUSD");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feed errors identify both unavailable providers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("twelvedata.com")
    ? Response.json({ status: "error", message: "rate limit" }, { status: 429 })
    : new Response("provider offline", { status: 503 });
  try {
    await assert.rejects(
      fetchMarketCandles("XAUUSD", "H1", { TWELVEDATA_API_KEY: "test-key" } as Env),
      /Twelve Data.*rate limit.*Yahoo Finance 503/s,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
