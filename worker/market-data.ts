import type { Env } from "./types";

export type MarketBar = {
  time: string;
  timestamp_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketFeed = {
  symbol: string;
  tf: string;
  source: string;
  bars: MarketBar[];
  last_bar_time: string;
  last_bar_ms: number;
  age_seconds: number;
  fetched_at: string;
  market_closed: boolean;
  is_stale: boolean;
  price: number;
  fallback_reason?: string;
};

const TIMEFRAMES: Record<string, { td: string; yahoo: string; range: string; minutes: number; cache_seconds: number; count: number }> = {
  M1: { td: "1min", yahoo: "1m", range: "5d", minutes: 1, cache_seconds: 45, count: 500 },
  M5: { td: "5min", yahoo: "5m", range: "5d", minutes: 5, cache_seconds: 60, count: 500 },
  M15: { td: "15min", yahoo: "15m", range: "1mo", minutes: 15, cache_seconds: 120, count: 500 },
  H1: { td: "1h", yahoo: "60m", range: "3mo", minutes: 60, cache_seconds: 180, count: 500 },
};

const CACHE = new Map<string, { at: number; feed: MarketFeed }>();
const SYMBOLS: Record<string, { td: string; yahoo: string; weekend_closed: boolean }> = {
  XAUUSD: { td: "XAU/USD", yahoo: "XAUUSD=X", weekend_closed: true },
  BTCUSD: { td: "BTC/USD", yahoo: "BTC-USD", weekend_closed: false },
};

function number(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase().replace(/[\/\-\s]/g, "");
  if (normalized === "BTCUSDT" || normalized === "BITCOIN" || normalized === "XBTUSD") return "BTCUSD";
  if (normalized === "GOLD" || normalized === "GOLDUSD" || normalized === "XAUUSDM") return "XAUUSD";
  if (normalized === "XAUUSD" || normalized === "BTCUSD") return normalized;
  throw new Error("Unsupported symbol. Use XAUUSD or BTCUSD.");
}

function makeFeed(symbol: string, tf: string, source: string, bars: MarketBar[]): MarketFeed {
  if (bars.length < 30) throw new Error(`${source} returned too few candles.`);
  const last = bars[bars.length - 1];
  const now = Date.now();
  const ageSeconds = Math.max(0, Math.floor(now / 1000 - last.timestamp_ms / 1000));
  const options = TIMEFRAMES[tf];
  const marketClosed = SYMBOLS[symbol].weekend_closed && (() => {
    const date = new Date(now);
    const day = date.getUTCDay();
    const hour = date.getUTCHours();
    return (day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 23);
  })();
  return {
    symbol,
    tf,
    source,
    bars: bars.slice(-options.count),
    last_bar_time: last.time,
    last_bar_ms: last.timestamp_ms,
    age_seconds: ageSeconds,
    fetched_at: new Date(now).toISOString(),
    market_closed: marketClosed,
    is_stale: ageSeconds > Math.max(300, options.minutes * 150) && !marketClosed,
    price: last.close,
  };
}

async function fetchTwelveData(symbol: string, tf: string, env: Env): Promise<MarketFeed> {
  const key = env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("Twelve Data API key is not configured");
  const options = TIMEFRAMES[tf];
  const pair = symbol === "XAUUSD" ? env.TWELVEDATA_SYMBOL || SYMBOLS[symbol].td : SYMBOLS[symbol].td;
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", options.td);
  url.searchParams.set("outputsize", String(options.count));
  url.searchParams.set("order", "ASC");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", key);
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  const data = await response.json() as { status?: string; message?: string; values?: Array<Record<string, unknown>> };
  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(`Twelve Data ${response.status}: ${String(data.message || "candle response unavailable").slice(0, 180)}`);
  }
  const bars = data.values.flatMap((item): MarketBar[] => {
    const stamp = String(item.datetime || "");
    const date = new Date(`${stamp.replace(" ", "T")}Z`);
    const open = number(item.open), high = number(item.high), low = number(item.low), close = number(item.close);
    if (!Number.isFinite(date.getTime()) || open === null || high === null || low === null || close === null || high < low) return [];
    return [{
      time: date.toISOString(),
      timestamp_ms: date.getTime(),
      open,
      high,
      low,
      close,
      volume: number(item.volume) || 0,
    }];
  });
  return makeFeed(symbol, tf, `Twelve Data · ${pair}`, bars);
}

async function fetchYahoo(symbol: string, tf: string): Promise<MarketFeed> {
  const profile = SYMBOLS[symbol];
  const options = TIMEFRAMES[tf];
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(profile.yahoo)}`);
  url.searchParams.set("range", options.range);
  url.searchParams.set("interval", options.yahoo);
  url.searchParams.set("includePrePost", "true");
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; JD-ANALYSIS/1.1)", Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`Yahoo Finance ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = await response.json() as {
    chart?: { error?: { description?: string } | null; result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<Record<string, unknown>> };
    }> | null };
  };
  const result = payload.chart?.result?.[0];
  if (payload.chart?.error || !result) {
    throw new Error(`Yahoo Finance returned no ${symbol} data${payload.chart?.error?.description ? `: ${payload.chart.error.description}` : ""}.`);
  }
  const quote = result.indicators?.quote?.[0] || {};
  const timestamps = result.timestamp || [];
  const bars = timestamps.flatMap((stamp, index): MarketBar[] => {
    const get = (field: string): number | null => {
      const values = quote[field];
      return Array.isArray(values) ? number(values[index]) : null;
    };
    const open = get("open"), high = get("high"), low = get("low"), close = get("close");
    if (open === null || high === null || low === null || close === null || high < low) return [];
    return [{
      time: new Date(stamp * 1000).toISOString(),
      timestamp_ms: stamp * 1000,
      open,
      high,
      low,
      close,
      volume: get("volume") || 0,
    }];
  });
  return makeFeed(symbol, tf, `Yahoo Finance · ${profile.yahoo}`, bars);
}

export async function fetchMarketCandles(symbolInput: string, tf: string, env: Env): Promise<MarketFeed> {
  const symbol = normalizedSymbol(symbolInput);
  if (!Object.hasOwn(TIMEFRAMES, tf)) throw new Error("Unsupported timeframe. Use M1, M5, M15 or H1.");
  const cacheKey = `${symbol}:${tf}`;
  const cached = CACHE.get(cacheKey);
  const cacheSeconds = TIMEFRAMES[tf].cache_seconds;
  if (cached && Date.now() - cached.at < cacheSeconds * 1000) return cached.feed;

  const errors: string[] = [];
  if (env.TWELVEDATA_API_KEY) {
    try {
      const feed = await fetchTwelveData(symbol, tf, env);
      CACHE.set(cacheKey, { at: Date.now(), feed });
      return feed;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const feed = await fetchYahoo(symbol, tf);
    if (errors.length) feed.fallback_reason = errors[0];
    CACHE.set(cacheKey, { at: Date.now(), feed });
    return feed;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (cached) {
    const fallback = makeFeed(symbol, tf, cached.feed.source, cached.feed.bars);
    fallback.fetched_at = cached.feed.fetched_at;
    fallback.fallback_reason = errors.join(" | ");
    return fallback;
  }
  throw new Error(`No candle provider available: ${errors.join(" | ")}`);
}
