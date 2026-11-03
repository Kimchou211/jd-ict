import assert from "node:assert/strict";
import test from "node:test";
import { analyzeImages } from "../worker/ai.ts";
import { buildTradeRead } from "../worker/trade-engine.ts";
import type { ChartImage, Env, JsonRecord } from "../worker/types.ts";

function providerResult(symbol: string, timeframes: [string, string], confidence = 1): JsonRecord {
  return {
    symbol,
    direction: "BUY",
    confidence,
    setup_rationale: "Bullish structure is visible.",
    timeframe_alignment: "aligned",
    risk_notes: [],
    chart_reads: timeframes.map((timeframe, index) => ({
      timeframe,
      symbol_detected: symbol,
      current_price: null,
      current_price_readable: false,
      price_estimate: symbol === "BTCUSD" ? 65_000 + index : 2_350 + index * 0.1,
      atr_value: null,
      atr_visible: false,
      atr_estimate: null,
      atr_period: 14,
      trend: "bullish",
      structure: "Higher highs and higher lows with a confirmed bullish structure break.",
      price_scale_top: symbol === "BTCUSD" ? 66_000 : 2_360,
      price_scale_bottom: symbol === "BTCUSD" ? 64_000 : 2_340,
      price_scale_readable: true,
      confidence,
      key_levels: [{ price: symbol === "BTCUSD" ? 64_800 : 2_345, kind: "support", label: "Retest support" }],
      annotations: [
        { type: "line", ict: "BOS", layer: "structure", x1: 100, y1: 450, x2: 800, y2: 450, label: "BOS" },
      ],
    })),
    entry_trigger_buy: "A bullish structure break and successful retest.",
    entry_trigger_sell: "A bearish break and failed retest.",
    pullback_zones: {
      BUY: { low: symbol === "BTCUSD" ? 64_700 : 2_344, high: symbol === "BTCUSD" ? 64_900 : 2_346, quality: "estimated", basis: "Visible support." },
      SELL: { low: symbol === "BTCUSD" ? 65_500 : 2_353, high: symbol === "BTCUSD" ? 65_700 : 2_355, quality: "estimated", basis: "Visible resistance." },
    },
  };
}

const images: ChartImage[] = [
  { mimeType: "image/png", base64: "primary-image-marker", key: "first.png" },
  { mimeType: "image/jpeg", base64: "secondary-image-marker", key: "second.jpg" },
];

const timeframes: [string, string] = ["M15", "H1"];

function responseFor(provider: "Gemini" | "DeepSeek", result: JsonRecord): Response {
  return provider === "Gemini"
    ? Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] })
    : Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
}

test("Gemini and DeepSeek receive the full forced prompts and screenshots in selected order", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ provider: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.hostname === "generativelanguage.googleapis.com") {
      calls.push({ provider: "Gemini", body });
      return responseFor("Gemini", providerResult("BTCUSD", timeframes));
    }
    if (url.hostname === "api.deepseek.com") {
      calls.push({ provider: "DeepSeek", body });
      return responseFor("DeepSeek", providerResult("BTCUSD", timeframes));
    }
    throw new Error(`Unexpected provider request: ${url.hostname}`);
  };

  try {
    const result = await analyzeImages({
      FORCE_SIGNAL: "true",
      GEMINI_API_KEY: "test-gemini-key",
      GEMINI_MODEL: "test-gemini-model",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_VISION_MODEL: "test-deepseek-model",
    } as Env, images, ...timeframes, "BTCUSD");

    assert.deepEqual(result.providerErrors, {});
    assert.deepEqual(result.providerResults.map((item) => item.provider), ["Gemini", "DeepSeek"]);
    assert.deepEqual(result.providerResults.map((item) => item.confidence), [1, 1]);
    assert.deepEqual(calls.map((call) => call.provider), ["Gemini", "DeepSeek"]);

    const geminiParts = ((calls[0].body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]).parts;
    const geminiPrompt = geminiParts[0].text as string;
    assert.match(geminiPrompt, /qualitative conviction/i);
    assert.match(geminiPrompt, /NOT win probability/i);
    assert.match(geminiPrompt, /30-55/);
    assert.match(geminiPrompt, /70\+/);
    assert.match(geminiPrompt, /ICT DRAWING MODE/);
    assert.match(geminiPrompt, /BTCUSD/);
    assert.doesNotMatch(geminiPrompt, /XAUUSD/);
    assert.match(geminiPrompt, /first screenshot is M15; the second screenshot is H1/i);
    assert.deepEqual(geminiParts.slice(1).map((part) => {
      if ("inline_data" in part) return (part.inline_data as { data: string }).data;
      return part.text;
    }), ["Screenshot timeframe: M15.", "primary-image-marker", "Screenshot timeframe: H1.", "secondary-image-marker"]);

    const deepseekBody = calls[1].body;
    const messages = deepseekBody.messages as Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
    const deepseekSystem = messages.find((message) => message.role === "system")?.content as string;
    const deepseekUser = messages.find((message) => message.role === "user")?.content as Array<Record<string, unknown>>;
    assert.match(deepseekSystem, /qualitative conviction/i);
    assert.match(deepseekSystem, /30-55/);
    assert.match(deepseekSystem, /70\+/);
    assert.match(deepseekSystem, /ICT DRAWING MODE/);
    assert.match(deepseekSystem, /BTCUSD/);
    const imageUrls = deepseekUser.filter((part) => part.type === "image_url")
      .map((part) => ((part.image_url as { url: string }).url));
    assert.match(imageUrls[0], /primary-image-marker/);
    assert.match(imageUrls[1], /secondary-image-marker/);
    assert.match(String(deepseekUser[1].text), /M15/);
    assert.match(String(deepseekUser[3].text), /H1/);
    assert.equal(result.providerResults[0].chart_reads && (result.providerResults[0].chart_reads as Array<JsonRecord>)[1].timeframe, "H1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("confidence 1 remains 1 and failed providers stay separately diagnosable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "generativelanguage.googleapis.com") {
      return responseFor("Gemini", providerResult("BTCUSD", timeframes, 1));
    }
    return Response.json({ error: "provider unavailable" }, { status: 503 });
  };
  try {
    const env = {
      FORCE_SIGNAL: "true",
      GEMINI_API_KEY: "test-gemini-key",
      GEMINI_MODEL: "test-gemini-model",
      DEEPSEEK_API_KEY: "test-deepseek-key",
      DEEPSEEK_VISION_MODEL: "test-deepseek-model",
      CONFIDENCE_MINIMUM: "65",
      PRICE_AGREEMENT_ABSOLUTE: "0.5",
      ATR_AGREEMENT_PERCENT: "0.2",
    } as Env;
    const result = await analyzeImages(env, images, ...timeframes, "BTCUSD");
    assert.equal(result.providerResults.length, 1);
    assert.equal(result.providerResults[0].confidence, 1);
    assert.match(result.providerErrors.DeepSeek, /DeepSeek API 503/);
    assert.doesNotMatch(result.providerErrors.DeepSeek, /test-deepseek-key/);

    const analysis = buildTradeRead(result.providerResults, result.providerErrors, ...timeframes, env, "BTCUSD");
    assert.equal(analysis.symbol, "BTCUSD");
    assert.equal(analysis.confidence, 1);
    assert.equal(analysis.signal_status, "FORCED_SIGNAL");
    assert.equal(analysis.providers[0].confidence, 1);
    assert.equal(analysis.provider_status.DeepSeek.status, "failed");
    assert.match(analysis.provider_errors.DeepSeek, /DeepSeek API 503/);
    assert.equal(analysis.validation.single_provider_mode, true);
    assert.ok(analysis.risk_notes.some((note: string) => note.includes("Only one AI provider responded")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("out-of-range confidence is reported as a provider validation error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseFor("Gemini", providerResult("XAUUSD", timeframes, 101));
  try {
    const result = await analyzeImages({
      FORCE_SIGNAL: "true",
      GEMINI_API_KEY: "test-gemini-key",
    } as Env, images, ...timeframes, "XAUUSD");
    assert.deepEqual(result.providerResults, []);
    assert.match(result.providerErrors.Gemini, /invalid confidence/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeframe order mismatches are rejected rather than attached to the wrong screenshot", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseFor("Gemini", providerResult("XAUUSD", ["H1", "M15"]));
  try {
    const result = await analyzeImages({
      FORCE_SIGNAL: "true",
      GEMINI_API_KEY: "test-gemini-key",
    } as Env, images, ...timeframes, "XAUUSD");
    assert.deepEqual(result.providerResults, []);
    assert.match(result.providerErrors.Gemini, /timeframe did not match M15/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
