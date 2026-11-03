import spec from "../shared/ict-engine-spec.json" with { type: "json" };
import imageAnalysisSpec from "../shared/image-analysis-spec.json" with { type: "json" };
import { analyzeImages, chatWithDeepSeek, reviewIctWithDeepSeek } from "./ai.ts";
import { buildTradeRead } from "./trade-engine.ts";
import { calculateLiveScan, chatWithLiveMarket, fetchLiveMarket, reviewLiveMarket } from "./live-market.ts";
import { fetchMarketCandles } from "./market-data.ts";
import { combineIctVerdict, scanIct, validateAiReview } from "./ict-engine.ts";
import type { IctScanResult, IctTimeframe } from "./ict-engine.ts";
import { buildDailyStats } from "./daily-stats.ts";
import type { AnalysisRecord, ChartImage, Env, JsonRecord } from "./types";
import { createSql, firstRow, logDatabaseError } from "./db.ts";
import { matchesSymbol, normalizeSymbol, symbolProfile } from "./symbols.ts";
import { analyzeEvent, eventsPayload, newsContext } from "./news.ts";

const TIMEFRAMES = new Set(["M1", "M2", "M3", "M5", "M10", "M15", "M30", "H1", "H2", "H4", "D1", "W1", "MN1"]);
const OUTCOMES = new Set(["TP1", "TP2", "SL", "SKIP", "CLEAR"]);
const RESULT_R: Record<string, number> = { TP1: 1, TP2: 1.8, SL: -1 };

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function equalSecret(candidate: string, expected: string): boolean {
  const candidateBytes = new TextEncoder().encode(candidate);
  const expectedBytes = new TextEncoder().encode(expected);
  let difference = candidateBytes.length ^ expectedBytes.length;
  const length = Math.max(candidateBytes.length, expectedBytes.length);
  for (let index = 0; index < length; index++) {
    difference |= (candidateBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }
  return difference === 0;
}

function authorize(request: Request, env: Env): Response | null {
  if (!env.APP_PASSWORD) {
    return json({ detail: "Application is locked. Configure the APP_PASSWORD Worker secret before use." }, 503);
  }
  const value = request.headers.get("Authorization") || "";
  const match = value.match(/^Basic\s+([A-Za-z0-9+/]+=*)$/i);
  if (match) {
    try {
      const [username, password] = atob(match[1]).split(/:(.*)/s, 2);
      if (username === "jd-analysis" && password !== undefined && equalSecret(password, env.APP_PASSWORD)) return null;
    } catch {
      // Invalid base64 credentials are treated as an unauthorized request.
    }
  }
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="JD ANALYSIS", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

function badRequest(message: string): never {
  throw new ApiError(400, message);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function safeJson(value: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function uploadUrl(name: string): string {
  return `/uploads/${encodeURIComponent(name)}`;
}

async function deleteUploadedImages(bucket: R2Bucket, images: ChartImage[]): Promise<void> {
  const outcomes = await Promise.allSettled(images.map((image) => bucket.delete(image.key)));
  const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected"
    ? [{ key: images[index].key, message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }]
    : []);
  if (failed.length) console.error(JSON.stringify({ event: "upload_cleanup_failed", failed }));
}

function recordPayload(row: AnalysisRecord): JsonRecord {
  return {
    id: row.id,
    created_at: row.created_at || "",
    symbol: row.symbol,
    tf_primary: row.tf_primary,
    tf_secondary: row.tf_secondary,
    direction: row.direction,
    confidence: row.confidence,
    entry_low: row.entry_low,
    entry_high: row.entry_high,
    stop_loss: row.stop_loss,
    take_profit_1: row.take_profit_1,
    take_profit_2: row.take_profit_2,
    image_primary: row.image_primary,
    image_secondary: row.image_secondary,
    image_primary_url: uploadUrl(row.image_primary),
    image_secondary_url: uploadUrl(row.image_secondary),
    analysis: safeJson(row.payload_json),
  };
}

function imageType(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 12
    && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function imageFromForm(
  value: unknown,
  normalizedValue: unknown,
  preparation: JsonRecord,
  maxBytes: number,
  bucket: R2Bucket,
): Promise<ChartImage> {
  if (!(value instanceof File) || !value.size) badRequest("Upload both timeframe screenshots before analyzing.");
  if (value.size > maxBytes) throw new ApiError(413, `Each image must be under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  const bytes = new Uint8Array(await value.arrayBuffer());
  const type = imageType(bytes);
  if (!type) throw new ApiError(415, "Use a readable PNG, JPG/JPEG or WEBP chart screenshot.");
  let inferenceBytes = bytes;
  let inferenceMimeType = type.mimeType;
  const warnings: string[] = [];
  if (normalizedValue instanceof File) {
    if (!normalizedValue.size || normalizedValue.size > maxBytes) {
      throw new ApiError(413, `Each normalized image must be under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
    }
    inferenceBytes = new Uint8Array(await normalizedValue.arrayBuffer());
    const normalizedType = imageType(inferenceBytes);
    if (normalizedType?.mimeType !== "image/jpeg" || inferenceBytes.at(-2) !== 0xff || inferenceBytes.at(-1) !== 0xd9) {
      throw new ApiError(415, "The normalized analysis image is not a complete JPEG.");
    }
    const policy = imageAnalysisSpec.normalization;
    const actualDimensions = jpegDimensions(inferenceBytes);
    const width = finiteNumber(preparation.normalized_width), height = finiteNumber(preparation.normalized_height);
    const sourceWidth = finiteNumber(preparation.source_width), sourceHeight = finiteNumber(preparation.source_height);
    if (preparation.mode !== "browser_canvas" || width === null || height === null
      || width < policy.minimum_width || height < policy.minimum_height
      || Math.max(width, height) > policy.max_dimension || !actualDimensions
      || width !== actualDimensions.width || height !== actualDimensions.height
      || sourceWidth === null || sourceHeight === null
      || sourceWidth < policy.minimum_width || sourceHeight < policy.minimum_height) {
      throw new ApiError(400, "Normalized image metadata does not match the shared preparation policy.");
    }
    const expectedScale = Math.min(1, policy.max_dimension / Math.max(sourceWidth, sourceHeight));
    if (width !== Math.max(1, Math.round(sourceWidth * expectedScale))
      || height !== Math.max(1, Math.round(sourceHeight * expectedScale))) {
      throw new ApiError(400, "Normalized image dimensions do not match the shared aspect-preserving resize policy.");
    }
    inferenceMimeType = "image/jpeg";
  } else {
    warnings.push("Browser-normalized analysis image was not provided; legacy image bytes are used without platform-equivalent normalization.");
  }
  const key = `${crypto.randomUUID().replaceAll("-", "")}.${type.extension}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type.mimeType } });
  return {
    mimeType: inferenceMimeType,
    base64: toBase64(inferenceBytes),
    key,
    preparation: {
      ...preparation,
      source_format: type.mimeType,
      source_bytes: bytes.length,
      normalized_format: inferenceMimeType,
      normalized_bytes: inferenceBytes.length,
      mode: normalizedValue instanceof File ? "browser_canvas" : "legacy_unprepared",
      warnings,
    },
  };
}

async function getHealth(env: Env): Promise<Response> {
  let database = "connected";
  try {
    const sql = createSql(env);
    await sql`SELECT 1`;
  } catch (error) {
    database = "offline";
    logDatabaseError("health_database_check_failed", error);
  }
  return json({
    app: env.APP_NAME || "JD ANALYSIS",
    database,
    providers: {
      gemini_configured: Boolean(env.GEMINI_API_KEY),
      deepseek_configured: Boolean(env.DEEPSEEK_API_KEY),
      twelvedata_configured: Boolean(env.TWELVEDATA_API_KEY),
    },
    mode: "live-market-and-image-analysis",
    symbol: "XAUUSD",
    live_terminal: true,
    live_market_provider: env.TWELVEDATA_API_KEY ? "Twelve Data with Yahoo Finance fallback" : "Yahoo Finance XAUUSD=X",
    force_signal: env.FORCE_SIGNAL?.trim().toLowerCase() !== "false",
    image_force_signal: env.IMAGE_FORCE_SIGNAL?.trim().toLowerCase() === "true",
  });
}

async function analyze(
  request: Request,
  env: Env,
  sendProgress?: (event: JsonRecord) => void,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    badRequest("Upload must use multipart/form-data.");
  }
  const tfPrimary = (form.get("tf_primary")?.toString() || "M1").toUpperCase();
  const tfSecondary = (form.get("tf_secondary")?.toString() || "M5").toUpperCase();
  let symbol: string;
  try {
    symbol = normalizeSymbol(form.get("symbol")?.toString());
  } catch {
    badRequest("Unsupported symbol. Use XAUUSD or BTCUSD.");
  }
  if (!TIMEFRAMES.has(tfPrimary) || !TIMEFRAMES.has(tfSecondary) || tfPrimary === tfSecondary) {
    badRequest("Choose two different supported timeframes.");
  }
  const maxUploadMb = Math.max(1, Math.min(25, finiteNumber(env.MAX_UPLOAD_MB) || 12));
  const maxBytes = maxUploadMb * 1024 * 1024;
  const savedImages: ChartImage[] = [];
  const stages: JsonRecord[] = [];
  let activeStage: JsonRecord | null = null;
  let stageStartedAt = 0;
  const startStage = (id: string, input: JsonRecord) => {
    const definition = imageAnalysisSpec.stages.find((entry) => entry.id === id);
    if (!definition) throw new Error(`Unknown image-analysis stage '${id}'.`);
    activeStage = {
      id, name: definition.name, status: "running", started_at: new Date().toISOString(),
      duration_ms: null, input, output: null, error: null,
    };
    stageStartedAt = Date.now();
    stages.push(activeStage);
    sendProgress?.({ type: "stage", stage: { ...activeStage } });
  };
  const finishStage = (output: JsonRecord) => {
    if (!activeStage) return;
    activeStage.status = "complete";
    activeStage.duration_ms = Math.max(0, Date.now() - stageStartedAt);
    activeStage.output = output;
    sendProgress?.({ type: "stage", stage: { ...activeStage } });
    activeStage = null;
  };
  const failStage = (error: unknown) => {
    if (!activeStage) return;
    activeStage.status = "failed";
    activeStage.duration_ms = Math.max(0, Date.now() - stageStartedAt);
    activeStage.error = error instanceof Error ? error.message.slice(0, 350) : String(error).slice(0, 350);
    sendProgress?.({ type: "stage", stage: { ...activeStage } });
    activeStage = null;
  };
  try {
    startStage("image_intake", { symbol, timeframes: [tfPrimary, tfSecondary] });
    let imagePreparation: unknown = [];
    try {
      imagePreparation = JSON.parse(form.get("image_preparation")?.toString() || "[]");
    } catch {
      badRequest("Image preparation metadata must be valid JSON.");
    }
    const preparations = Array.isArray(imagePreparation)
      ? imagePreparation.map((item) => item && typeof item === "object" && !Array.isArray(item) ? item as JsonRecord : {})
      : [{}, {}];
    if (preparations.length !== 2) preparations.splice(0, preparations.length, {}, {});
    savedImages.push(await imageFromForm(
      form.get("primary_image"), form.get("primary_analysis_image"), preparations[0], maxBytes, env.UPLOADS,
    ));
    savedImages.push(await imageFromForm(
      form.get("secondary_image"), form.get("secondary_analysis_image"), preparations[1], maxBytes, env.UPLOADS,
    ));
    finishStage({
      images: savedImages.map(image => image.preparation || {}),
      originals_preserved: true,
      normalization_consistent: savedImages.every(image => image.preparation?.mode === "browser_canvas"),
    });

    startStage("visual_extraction", { providers: ["Gemini", "DeepSeek"], image_count: 2 });
    let aiResults: Awaited<ReturnType<typeof analyzeImages>>;
    try {
      aiResults = await analyzeImages(env, savedImages, tfPrimary, tfSecondary, symbol);
    } catch (error) {
      await deleteUploadedImages(env.UPLOADS, savedImages);
      if (error instanceof Error && error.message.startsWith("Configure at least one")) {
        throw new ApiError(503, error.message);
      }
      throw error;
    }
    if (!aiResults.providerResults.length) {
      await deleteUploadedImages(env.UPLOADS, savedImages);
      const errors = Object.entries(aiResults.providerErrors).map(([provider, message]) => `${provider}: ${message}`).join(" | ");
      throw new ApiError(502, `All configured AI providers failed. ${errors || "Check API keys/model names."}`);
    }
    const visualQuality = [tfPrimary, tfSecondary].map((timeframe, index) => ({
      timeframe,
      observations: aiResults.providerResults.map(item => {
        const reads = Array.isArray(item.chart_reads) ? item.chart_reads : [];
        const read = reads[index] && typeof reads[index] === "object" ? reads[index] as JsonRecord : {};
        return {
          provider: String(item.provider || "unknown"),
          symbol_header_visible: read.symbol_header_visible ?? null,
          timeframe_label_visible: read.timeframe_label_visible ?? null,
          chart_area_visibility: read.chart_area_visibility ?? null,
          price_axis_visibility: read.price_axis_visibility ?? null,
          indicator_panel_visibility: read.indicator_panel_visibility ?? null,
          glare: read.glare ?? null,
          rotated: read.rotated ?? null,
          cropped: read.cropped ?? null,
          blur_risk: read.blur_risk ?? null,
        };
      }),
    }));
    finishStage({
      providers_succeeded: aiResults.providerResults.map(item => String(item.provider || "unknown")),
      provider_errors: aiResults.providerErrors,
      chart_reads: aiResults.providerResults.reduce((sum, item) => sum + (Array.isArray(item.chart_reads) ? item.chart_reads.length : 0), 0),
      visual_quality: visualQuality,
    });

    startStage("chart_reconstruction", { timeframes: [tfPrimary, tfSecondary] });
    const reconstruction = [tfPrimary, tfSecondary].map((timeframe, index) => {
      const reads = aiResults.providerResults.flatMap((item) =>
        Array.isArray(item.chart_reads) && item.chart_reads[index] ? [item.chart_reads[index] as JsonRecord] : []);
      return {
        timeframe,
        readable_price_labels: reads.flatMap(read =>
          read.current_price_readable === true && typeof read.current_price === "number" ? [read.current_price] : []),
        axis_scale: reads.map(read => ({
          top: read.price_scale_top, bottom: read.price_scale_bottom, readable: read.price_scale_readable === true,
        })),
        reconstructed_ohlc: null,
        missing_data: ["OHLC candles are not reconstructed from screenshot pixels; use validated market-feed candles."],
      };
    });
    finishStage({ charts: reconstruction });

    startStage("live_verification", { requested_timeframes: [tfPrimary, tfSecondary] });
    const supportedFrames = [...new Set([tfPrimary, tfSecondary].filter(isIctTimeframe))];
    const settledFeeds = await Promise.allSettled(supportedFrames.map(frame => fetchMarketCandles(symbol, frame, env)));
    const feeds: Record<string, Awaited<ReturnType<typeof fetchMarketCandles>>> = {};
    const feedErrors: Record<string, string> = {};
    settledFeeds.forEach((result, index) => {
      const timeframe = supportedFrames[index];
      if (result.status === "fulfilled") feeds[timeframe] = result.value;
      else feedErrors[timeframe] = result.reason instanceof Error ? result.reason.message.slice(0, 260) : String(result.reason).slice(0, 260);
    });
    const profile = symbolProfile(symbol);
    const comparisons = [tfPrimary, tfSecondary].map((timeframe, index) => {
      const feed = feeds[timeframe];
      const reads = aiResults.providerResults.flatMap((item) =>
        Array.isArray(item.chart_reads) && item.chart_reads[index] ? [item.chart_reads[index] as JsonRecord] : []);
      const screenshotPrice = reads.find(read => read.current_price_readable === true
        && typeof read.current_price === "number")?.current_price;
      const comparison = !feed ? "feed_unavailable"
        : typeof screenshotPrice !== "number" ? "screenshot_quote_unreadable"
          : Math.abs(screenshotPrice - feed.price) <= Math.max(profile.price_abs, feed.price * profile.price_pct) ? "match" : "mismatch";
      return {
        timeframe, status: comparison, screenshot_price: screenshotPrice ?? null, live_price: feed?.price ?? null,
        feed_timestamp: feed?.last_bar_time ?? null, feed_source: feed?.source ?? null,
        is_stale: feed?.is_stale ?? null, market_closed: feed?.market_closed ?? null,
        data_quality_status: feed?.data_quality_status ?? null,
      };
    });
    const marketVerification = {
      available: comparisons.every(item => feeds[item.timeframe] !== undefined),
      feeds: comparisons,
      errors: feedErrors,
      warning: "Screenshot prices are visual reads; live prices come only from the stated candle feed.",
    };
    finishStage(marketVerification);

    startStage("ict_evaluation", { entry_timeframe: tfPrimary, minimum_score: Number(env.ICT_MIN_SCORE) || 60 });
    let marketScan: IctScanResult | null = null;
    let scanError: string | null = null;
    if (!isIctTimeframe(tfPrimary) || !feeds[tfPrimary]) {
      scanError = feedErrors[tfPrimary] || "Entry timeframe is unsupported or unavailable from the configured market-data providers.";
    } else if (feeds[tfPrimary].bars.length < 60) {
      scanError = `Not enough completed ${tfPrimary} candles for a validated ICT scan.`;
    } else {
      try {
        marketScan = scanIct(
          Object.fromEntries(Object.entries(feeds).map(([frame, feed]) => [frame, feed.bars])),
          tfPrimary, symbol,
        );
      } catch (error) {
        scanError = error instanceof Error ? error.message.slice(0, 260) : String(error).slice(0, 260);
      }
    }
    finishStage({
      status: marketScan ? "scanned" : "unavailable",
      candidate_count: marketScan?.setups.length || 0,
      selected_setup: marketScan?.selected || null,
      direction: marketScan?.direction || "WAIT",
      error: scanError,
      source: "completed market-feed candles; deterministic ICT engine",
    });

    startStage("final_report", { annotation_source: "visual evidence only", trade_levels_source: "validated market candles only" });
    const analysis = buildTradeRead(aiResults.providerResults, aiResults.providerErrors, tfPrimary, tfSecondary, env, symbol);
    const candidate = marketScan?.setups.find(setup => setup.id === marketScan.selected && setup.timeframe === tfPrimary) || null;
    const feedQualityOk = [tfPrimary, tfSecondary].every(timeframe =>
      feeds[timeframe] && !feeds[timeframe].is_stale && !feeds[timeframe].market_closed
      && feeds[timeframe].data_quality_status === "GOOD");
    const normalizationOk = savedImages.every(image => image.preparation?.mode === "browser_canvas");
    const quoteMismatch = comparisons.some(item => item.status === "mismatch");
    const detectedOtherSymbol = aiResults.providerResults.some(item =>
      Array.isArray(item.chart_reads) && item.chart_reads.some((value) => {
        const read = value && typeof value === "object" ? value as JsonRecord : {};
        return typeof read.symbol_detected === "string" && !["", "unknown", symbol].includes(read.symbol_detected)
          && !matchesSymbol(read.symbol_detected, symbol);
      }));
    const tradeReady = Boolean(candidate && feedQualityOk && normalizationOk && !quoteMismatch && !detectedOtherSymbol);
    const plan = tradeReady ? candidate?.plan : null;
    const direction = tradeReady ? candidate?.action || "WAIT" : "WAIT";
    analysis.symbol = symbol;
    analysis.mode = marketVerification.available ? "LIVE_MARKET_VERIFIED" : "IMAGE_ONLY";
    analysis.direction = direction;
    analysis.model_bias = direction;
    analysis.trade_ready = tradeReady;
    analysis.forced_signal = false;
    analysis.force_signal_used = false;
    analysis.levels_available = Boolean(plan);
    analysis.signal_status = tradeReady ? "ICT_SETUP_VALIDATED" : "WAIT_FOR_CONFIRMATION";
    analysis.entry_price = plan?.entry ?? null;
    analysis.entry_low = plan?.entry_low ?? null;
    analysis.entry_high = plan?.entry_high ?? null;
    analysis.stop_loss = plan?.stop ?? null;
    analysis.take_profit_1 = plan?.tp1 ?? null;
    analysis.take_profit_2 = plan?.tp2 ?? null;
    analysis.atr_method = "No ATR-derived plan. Entry, structural invalidation and liquidity targets come from a validated ICT setup on completed market candles.";
    analysis.price_source = plan ? "Live candle feed" : "Screenshot values are not live quotes.";
    analysis.market_verification = marketVerification;
    analysis.market_ict_scan = {
      candidate_count: marketScan?.setups.length || 0,
      selected_setup: candidate,
      error: scanError,
      trade_blockers: [
        ...(!feedQualityOk ? ["market feed is stale, closed, missing, or degraded"] : []),
        ...(!normalizationOk ? ["images were not prepared by the shared browser normalizer"] : []),
        ...(quoteMismatch ? ["screenshot quote does not match the live candle"] : []),
        ...(detectedOtherSymbol ? ["image symbol conflicts with the user-selected symbol"] : []),
        ...(!candidate ? ["no valid ICT setup on the selected entry timeframe"] : []),
      ],
    };
    analysis.chart_reconstruction = reconstruction;
    analysis.live_feeds = comparisons;
    analysis.force_settings = {
      live_terminal_force_signal: env.FORCE_SIGNAL?.trim().toLowerCase() !== "false",
      image_force_signal: env.IMAGE_FORCE_SIGNAL?.trim().toLowerCase() === "true",
    };
    if (plan && candidate) {
      analysis.confidence = candidate.score;
      analysis.setup_rationale = `Validated market-candle ICT setup: ${candidate.reasons.join("; ")}`;
      for (const read of analysis.chart_reads as JsonRecord[]) {
        const scale = read.price_scale && typeof read.price_scale === "object" ? read.price_scale as JsonRecord : {};
        if (scale.verified !== true || typeof scale.bottom !== "number" || typeof scale.top !== "number") continue;
        for (const [label, value] of [["ENTRY", plan.entry], ["SL", plan.stop], ["TP1", plan.tp1], ["TP2", plan.tp2]] as const) {
          if (value >= scale.bottom && value <= scale.top) {
            const annotations = Array.isArray(read.annotations) ? read.annotations as JsonRecord[] : [];
            annotations.push({ type: "price_line", price: value, label: `${label} ${value.toFixed(2)}` });
            read.annotations = annotations;
          }
        }
      }
    } else {
      analysis.risk_notes = [...new Set([
        ...(Array.isArray(analysis.risk_notes) ? analysis.risk_notes : []),
        "No actionable trade levels were issued. Review the pipeline stage outputs and trade blockers.",
      ])];
    }
    analysis.pipeline_stages = stages;
    analysis.provider_errors = aiResults.providerErrors;
    const createdAt = new Date().toISOString();
    const values = [
      createdAt, symbol, tfPrimary, tfSecondary, String(analysis.direction || "WAIT"),
      finiteNumber(analysis.confidence) || 0, finiteNumber(analysis.entry_low), finiteNumber(analysis.entry_high),
      finiteNumber(analysis.stop_loss), finiteNumber(analysis.take_profit_1), finiteNumber(analysis.take_profit_2),
      savedImages[0].key, savedImages[1].key, JSON.stringify(analysis),
    ];
    try {
      const sql = createSql(env);
      const inserted = await sql`
        INSERT INTO analysis_records
          (created_at, symbol, tf_primary, tf_secondary, direction, confidence, entry_low, entry_high,
           stop_loss, take_profit_1, take_profit_2, image_primary, image_secondary, payload_json)
        VALUES (
          ${values[0]}, ${values[1]}, ${values[2]}, ${values[3]}, ${values[4]}, ${values[5]},
          ${values[6]}, ${values[7]}, ${values[8]}, ${values[9]}, ${values[10]}, ${values[11]},
          ${values[12]}, ${values[13]}
        )
        RETURNING id
      `;
      const id = finiteNumber(inserted[0]?.id);
      finishStage({ decision: direction, trade_ready: tradeReady, history_saved: id !== null });
      analysis.pipeline_stages = stages;
      if (id !== null) {
        await sql`UPDATE analysis_records SET payload_json = ${JSON.stringify(analysis)} WHERE id = ${id}`;
      }
      const finalResponse = {
        id,
        created_at: createdAt,
        symbol,
        tf_primary: tfPrimary,
        tf_secondary: tfSecondary,
        direction: analysis.direction,
        confidence: analysis.confidence,
        entry_low: analysis.entry_low,
        entry_high: analysis.entry_high,
        stop_loss: analysis.stop_loss,
        take_profit_1: analysis.take_profit_1,
        take_profit_2: analysis.take_profit_2,
        image_primary: savedImages[0].key,
        image_secondary: savedImages[1].key,
        image_primary_url: uploadUrl(savedImages[0].key),
        image_secondary_url: uploadUrl(savedImages[1].key),
        history_saved: id !== null,
        ...(id === null ? { history_error: "Database did not return the inserted record ID." } : {}),
        analysis,
      };
      sendProgress?.({ type: "complete", data: finalResponse });
      return json({
        ...finalResponse,
      });
    } catch (error) {
      logDatabaseError("analysis_history_save_failed", error);
      finishStage({ decision: direction, trade_ready: tradeReady, history_saved: false, error: "Analysis history could not be saved." });
      analysis.pipeline_stages = stages;
      const finalResponse = {
        id: null,
        created_at: createdAt,
        symbol,
        tf_primary: tfPrimary,
        tf_secondary: tfSecondary,
        direction: analysis.direction,
        confidence: analysis.confidence,
        entry_low: analysis.entry_low,
        entry_high: analysis.entry_high,
        stop_loss: analysis.stop_loss,
        take_profit_1: analysis.take_profit_1,
        take_profit_2: analysis.take_profit_2,
        image_primary: savedImages[0].key,
        image_secondary: savedImages[1].key,
        image_primary_url: uploadUrl(savedImages[0].key),
        image_secondary_url: uploadUrl(savedImages[1].key),
        history_saved: false,
        history_error: "Analysis completed, but saving it to the database failed.",
        analysis,
      };
      sendProgress?.({ type: "complete", data: finalResponse });
      return json({
        ...finalResponse,
      });
    }
  } catch (error) {
    failStage(error);
    await deleteUploadedImages(env.UPLOADS, savedImages);
    if (!(error instanceof ApiError) && error instanceof Error && !error.message.startsWith("Gemini API") && !error.message.startsWith("DeepSeek")) {
      console.error(JSON.stringify({ event: "analysis_failed", message: error.message }));
    }
    throw error;
  }
}

function analyzeStream(request: Request, env: Env): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: JsonRecord) => {
        if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      return analyze(request, env, send).then(() => {
        if (!cancelled) controller.close();
      }).catch((error: unknown) => {
        if (!cancelled) {
          send({
            type: "error",
            status: error instanceof ApiError ? error.status : 500,
            detail: error instanceof Error ? error.message.slice(0, 350) : "Image analysis failed.",
          });
          controller.close();
        }
      });
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function history(env: Env, url: URL): Promise<Response> {
  const requested = Number(url.searchParams.get("limit") || 40);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(150, Math.trunc(requested))) : 40;
  try {
    const sql = createSql(env);
    const rows = await sql`
      SELECT id, created_at::text AS created_at, symbol, tf_primary, tf_secondary, direction, confidence,
             entry_low, entry_high, stop_loss, take_profit_1, take_profit_2,
             image_primary, image_secondary, payload_json
      FROM analysis_records
      ORDER BY id DESC
      LIMIT ${limit}
    `;
    return json({ items: rows.map((row) => recordPayload(row as AnalysisRecord)), database: "connected" });
  } catch (error) {
    logDatabaseError("history_read_failed", error);
    return json({ items: [], database: "offline", error: "Database is unavailable." });
  }
}

async function historyDetail(env: Env, id: number): Promise<Response> {
  try {
    const sql = createSql(env);
    const row = await firstRow(sql`
      SELECT id, created_at::text AS created_at, symbol, tf_primary, tf_secondary, direction, confidence,
             entry_low, entry_high, stop_loss, take_profit_1, take_profit_2,
             image_primary, image_secondary, payload_json
      FROM analysis_records
      WHERE id = ${id}
    `);
    if (!row) throw new ApiError(404, "Signal history item was not found.");
    return json(recordPayload(row as AnalysisRecord));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logDatabaseError("history_detail_read_failed", error);
    throw new ApiError(503, "Database unavailable.");
  }
}

async function setOutcome(request: Request, env: Env, id: number): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    badRequest("Request body must be valid JSON.");
  }
  const result = (body as { result?: unknown } | null)?.result;
  if (typeof result !== "string" || !OUTCOMES.has(result)) {
    badRequest("Result must be TP1, TP2, SL, SKIP or CLEAR.");
  }
  try {
    const sql = createSql(env);
    const row = await firstRow(sql`
      SELECT id, created_at::text AS created_at, symbol, tf_primary, tf_secondary, direction, confidence,
             entry_low, entry_high, stop_loss, take_profit_1, take_profit_2,
             image_primary, image_secondary, payload_json
      FROM analysis_records
      WHERE id = ${id}
    `);
    if (!row) throw new ApiError(404, "Signal history item was not found.");
    const payload = safeJson(row.payload_json);
    if (result === "CLEAR") delete payload.outcome;
    else payload.outcome = { result, at: new Date().toISOString() };
    const updated = await sql`
      UPDATE analysis_records
      SET payload_json = ${JSON.stringify(payload)}
      WHERE id = ${id}
      RETURNING id
    `;
    if (!updated.length) throw new ApiError(503, "Database unavailable.");
    return json(recordPayload({ ...row, payload_json: JSON.stringify(payload) } as AnalysisRecord));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logDatabaseError("outcome_save_failed", error);
    throw new ApiError(503, "Database unavailable.");
  }
}

function bucket(): { resolved: number; wins: number; losses: number; total_r: number } {
  return { resolved: 0, wins: 0, losses: 0, total_r: 0 };
}

function finish(value: ReturnType<typeof bucket>): JsonRecord {
  return {
    ...value,
    total_r: Math.round(value.total_r * 100) / 100,
    win_rate: value.resolved ? Math.round(1000 * value.wins / value.resolved) / 10 : 0,
    avg_r: value.resolved ? Math.round(100 * value.total_r / value.resolved) / 100 : 0,
  };
}

async function stats(env: Env): Promise<Response> {
  try {
    const sql = createSql(env);
    const rows = await sql`
      SELECT direction, stop_loss, payload_json
      FROM analysis_records
      ORDER BY id DESC
      LIMIT 2000
    `;
    const total = bucket();
    const byGrade: Record<string, ReturnType<typeof bucket>> = {};
    const byDirection: Record<string, ReturnType<typeof bucket>> = {};
    let unresolved = 0;
    for (const row of rows) {
      if (!["BUY", "SELL"].includes(row.direction) || row.stop_loss === null) continue;
      const result = safeJson(row.payload_json);
      const outcome = (result.outcome as { result?: unknown } | undefined)?.result;
      if (typeof outcome !== "string" || !(outcome in RESULT_R)) {
        if (outcome !== "SKIP") unresolved++;
        continue;
      }
      const savedR = finiteNumber((result.outcome as { r?: unknown } | undefined)?.r);
      const value = savedR ?? RESULT_R[outcome];
      const gradeName = typeof result.signal_grade === "string" && result.signal_grade ? result.signal_grade : "-";
      for (const group of [total, byGrade[gradeName] ||= bucket(), byDirection[row.direction] ||= bucket()]) {
        group.resolved++;
        if (value > 0) group.wins++;
        if (value < 0) group.losses++;
        group.total_r += value;
      }
    }
    return json({
      ...finish(total),
      unresolved,
      by_grade: Object.fromEntries(Object.keys(byGrade).sort().map((key) => [key, finish(byGrade[key])])),
      by_direction: Object.fromEntries(Object.entries(byDirection).map(([key, value]) => [key, finish(value)])),
    });
  } catch (error) {
    logDatabaseError("stats_read_failed", error);
    return json({ resolved: 0, unresolved: 0, error: "Database is unavailable.", by_grade: {}, by_direction: {} });
  }
}

async function statsDaily(env: Env, url: URL): Promise<Response> {
  const rawDays = Number(url.searchParams.get("days") || "14");
  const rawOffset = Number(url.searchParams.get("tz_offset_min") || "0");
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 60) badRequest("days must be between 1 and 60.");
  if (!Number.isInteger(rawOffset) || rawOffset < -840 || rawOffset > 840) badRequest("tz_offset_min must be between -840 and 840.");
  const symbolFilter = url.searchParams.get("symbol");
  try {
    const sql = createSql(env);
    const rows = await sql`
      SELECT created_at::text AS created_at, symbol, direction, stop_loss, payload_json
      FROM analysis_records
      ORDER BY id DESC
      LIMIT 3000
    `;
    const dailyRecords = rows.map((row) => ({
      created_at: typeof row.created_at === "string" ? row.created_at : "",
      symbol: typeof row.symbol === "string" ? row.symbol : "",
      direction: typeof row.direction === "string" ? row.direction : "",
      stop_loss: finiteNumber(row.stop_loss),
      payload_json: typeof row.payload_json === "string" ? row.payload_json : "",
    }));
    const result = buildDailyStats(dailyRecords, rawDays, rawOffset, Date.now(), symbolFilter);
    return json(result);
  } catch (error) {
    logDatabaseError("daily_stats_read_failed", error);
    return json({ days: [], today: null, error: "Database is unavailable." });
  }
}

function ictSymbol(value: string | null): string {
  const symbol = (value || "XAUUSD").toUpperCase().replace(/[\/\-\s]/g, "");
  if (["XAUUSD", "XAUUSDM", "GOLD", "GOLDUSD"].includes(symbol)) return "XAUUSD";
  if (["BTCUSD", "BTCUSDT", "BTCUSDM", "BITCOIN", "XBTUSD"].includes(symbol)) return "BTCUSD";
  badRequest("Unsupported symbol. Use XAUUSD or BTCUSD.");
}

function isIctTimeframe(value: string): value is IctTimeframe {
  return ["M1", "M5", "M15", "H1", "H4", "D1", "W1"].includes(value);
}

function feedMetadata(feed: Awaited<ReturnType<typeof fetchMarketCandles>>): JsonRecord {
  return {
    symbol: feed.symbol, tf: feed.tf, source: feed.source, last_bar_time: feed.last_bar_time,
    age_seconds: feed.age_seconds, fetched_at: feed.fetched_at, market_closed: feed.market_closed,
    is_stale: feed.is_stale, fallback_reason: feed.fallback_reason, price: feed.price,
    missing_candle_count: feed.missing_candle_count, historical_coverage: feed.historical_coverage,
    aggregation_source: feed.aggregation_source, data_quality_status: feed.data_quality_status,
    duplicate_candle_count: feed.duplicate_candle_count, out_of_order_candle_count: feed.out_of_order_candle_count,
  };
}

async function ictCandles(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tf = (url.searchParams.get("tf") || "M5").toUpperCase();
  const symbol = ictSymbol(url.searchParams.get("symbol"));
  if (!isIctTimeframe(tf)) {
    badRequest("Unsupported timeframe. Use M1, M5, M15, H1, H4, D1 or W1.");
  }
  try {
    const feed = await fetchMarketCandles(symbol, tf, env);
    return json({ feed: feedMetadata(feed), bars: feed.bars.slice(-300) });
  } catch (error) {
    throw new ApiError(503, `Candle feed unavailable: ${error instanceof Error ? error.message.slice(0, 350) : String(error).slice(0, 350)}`);
  }
}

function grade(score: number): string {
  return score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D";
}

function attachSetupHistory(analysis: JsonRecord, previous: JsonRecord | null): void {
  const history = Array.isArray(previous?.setup_lifecycle_history)
    ? [...previous.setup_lifecycle_history] as JsonRecord[]
    : [];
  const lastState = new Map<string, string>();
  for (const event of history) {
    if (typeof event.setup_id === "string" && typeof event.lifecycle === "string") {
      lastState.set(event.setup_id, event.lifecycle);
    }
  }
  const setups = Array.isArray(analysis.setups) ? analysis.setups as JsonRecord[] : [];
  const currentIds = new Set<string>();
  const timestamp = Number(analysis.time_ms) || Date.now();
  for (const setup of setups) {
    if (typeof setup.id !== "string" || typeof setup.lifecycle !== "string") continue;
    currentIds.add(setup.id);
    if (lastState.get(setup.id) !== setup.lifecycle) {
      history.push({ setup_id: setup.id, opportunity_id: setup.opportunity_id,
        lifecycle: setup.lifecycle, observed_at_ms: timestamp });
      lastState.set(setup.id, setup.lifecycle);
    }
  }

  const priorSetups = Array.isArray(previous?.setups) ? previous.setups as JsonRecord[] : [];
  const price = Number(analysis.price);
  for (const setup of priorSetups) {
    if (typeof setup.id !== "string" || currentIds.has(setup.id) || typeof setup.lifecycle !== "string"
      || ["TARGET_REACHED", "INVALIDATED", "EXPIRED"].includes(setup.lifecycle)) continue;
    const plan = setup.plan && typeof setup.plan === "object" ? setup.plan as JsonRecord : {};
    const direction = setup.direction;
    let state = setup.lifecycle;
    if (timestamp >= (Number(plan.valid_until_ms) || Number.POSITIVE_INFINITY)) state = "EXPIRED";
    else if (direction === "bull" && typeof plan.stop === "number" && price <= plan.stop) state = "INVALIDATED";
    else if (direction === "bear" && typeof plan.stop === "number" && price >= plan.stop) state = "INVALIDATED";
    else if (direction === "bull" && typeof plan.tp1 === "number" && price >= plan.tp1) state = "TARGET_REACHED";
    else if (direction === "bear" && typeof plan.tp1 === "number" && price <= plan.tp1) state = "TARGET_REACHED";
    if (state !== lastState.get(setup.id)) {
      history.push({ setup_id: setup.id, opportunity_id: setup.opportunity_id,
        lifecycle: state, observed_at_ms: timestamp });
      lastState.set(setup.id, state);
    }
  }

  const retained = history.slice(-2000);
  analysis.setup_lifecycle_history = retained;
  for (const setup of setups) {
    if (typeof setup.id === "string") {
      setup.lifecycle_history = retained.filter(event => event.setup_id === setup.id).slice(-50);
    }
  }
}

async function ictScan(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const timeframe = (url.searchParams.get("tf") || "M5").toUpperCase();
  const symbol = ictSymbol(url.searchParams.get("symbol"));
  if (!isIctTimeframe(timeframe)) {
    badRequest("Unsupported entry timeframe. Use M1, M5, M15, H1, H4, D1 or W1.");
  }
  const tf: IctTimeframe = timeframe;
  const useAi = (url.searchParams.get("ai") || "true").toLowerCase() !== "false";
  const directionFilter = url.searchParams.get("direction");
  const modelFilter = url.searchParams.get("model");
  const timeframeFilter = url.searchParams.get("timeframe");
  const statusFilter = url.searchParams.get("status");
  const minimumScoreFilter = url.searchParams.get("min_score");
  const minScore = env.ICT_MIN_SCORE === undefined ? 60 : Number(env.ICT_MIN_SCORE);
  if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) {
    throw new ApiError(500, "ICT_MIN_SCORE Worker variable must be an integer from 0 to 100.");
  }
  if (directionFilter && !["BUY", "SELL", "WAIT"].includes(directionFilter.toUpperCase())) {
    badRequest("direction filter must be BUY, SELL or WAIT.");
  }
  const knownModels = spec.scanner.models.map((entry) => entry.id);
  if (modelFilter && !knownModels.includes(modelFilter.toUpperCase() as typeof knownModels[number])) {
    badRequest("Unknown ICT model filter.");
  }
  if (timeframeFilter && !isIctTimeframe(timeframeFilter.toUpperCase())) badRequest("Unknown ICT timeframe filter.");
  const lifecycleStates = ["DETECTED", "FORMING", "WAITING_FOR_CONFIRMATION", "CONFIRMED", "WAITING_FOR_RETRACE",
    "ENTRY_READY", "ACTIVE", "TARGET_REACHED", "INVALIDATED", "EXPIRED"];
  if (statusFilter && !lifecycleStates.includes(statusFilter.toUpperCase())) badRequest("Unknown setup lifecycle status filter.");
  const parsedMinimumScore = minimumScoreFilter === null ? undefined : Number(minimumScoreFilter);
  if (parsedMinimumScore !== undefined && (!Number.isFinite(parsedMinimumScore) || parsedMinimumScore < 0 || parsedMinimumScore > 100)) {
    badRequest("min_score must be from 0 to 100.");
  }
  let feeds: Record<string, Awaited<ReturnType<typeof fetchMarketCandles>>>;
  const dataWarnings: string[] = [];
  let engineResult: IctScanResult;
  try {
    const timeframes = [...new Set(spec.scanner.coverage_timeframes as IctTimeframe[])];
    const settled = await Promise.allSettled(timeframes.map((frame) => fetchMarketCandles(symbol, frame, env)));
    feeds = {};
    for (const [index, result] of settled.entries()) {
      const frame = timeframes[index];
      if (result.status === "fulfilled") feeds[frame] = result.value;
      else if (frame === tf) throw result.reason;
      else dataWarnings.push(`${frame} timeframe unavailable: ${result.reason instanceof Error ? result.reason.message.slice(0, 160) : String(result.reason).slice(0, 160)}`);
    }
    const filters = Object.fromEntries(Object.entries({
      direction: directionFilter || undefined,
      model: modelFilter || undefined,
      timeframe: timeframeFilter || undefined,
      status: statusFilter || undefined,
      min_score: parsedMinimumScore,
    }).filter(([, value]) => value !== undefined));
    engineResult = scanIct(Object.fromEntries(Object.entries(feeds).map(([frame, feed]) => [frame, feed.bars])), tf, symbol, { minScore, filters });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported")) badRequest(error.message);
    throw new ApiError(503, `ICT scan failed: ${error instanceof Error ? error.message.slice(0, 350) : String(error).slice(0, 350)}`);
  }

  // News is context, never a gate: it changes what the UI shows and what the AI is told, not the signal.
  (engineResult as unknown as JsonRecord).news = await newsContext(env);
  const ltfFeed = feeds[tf];
  const feedOk = !ltfFeed.is_stale && !ltfFeed.market_closed;
  let review: Awaited<ReturnType<typeof reviewIctWithDeepSeek>> | null = null;
  let validation: ReturnType<typeof validateAiReview> | null = null;
  if (useAi) {
    review = await reviewIctWithDeepSeek(env, engineResult, ltfFeed.bars);
    if (review.ok) validation = validateAiReview(review, engineResult);
  }
  const verdict = combineIctVerdict(engineResult, review, validation, feedOk);
  const analysis: JsonRecord = {
    ...engineResult,
    ...verdict,
    data_warnings: dataWarnings,
    engine_direction: engineResult.direction,
    feed: feedMetadata(ltfFeed),
    ai_review: review,
    ai_validation: validation,
    ict_scan: true,
    signal_grade: grade(Number(verdict.final_confidence) || 0),
    scan_source: `ict_engine${review?.ok ? "+deepseek" : ""}`,
    feeds: Object.fromEntries(Object.entries(feeds).map(([frame, feed]) => [frame, feedMetadata(feed)])),
    bars: ltfFeed.bars.slice(-160),
  };
  const plan = engineResult.plan;
  const tradable = ["BUY", "SELL"].includes(String(verdict.final_direction)) && plan !== null;
  if (tradable && plan) {
    analysis.ict_plan = plan;
    analysis.ict_track = { state: "PENDING" };
  }
  const createdAt = new Date().toISOString();
  let id: number | null = null;
  let historySaved = true;
  let historyError: string | null = null;
  try {
    const sql = createSql(env);
    const previousRecord = await firstRow(sql`
      SELECT payload_json FROM analysis_records
      WHERE symbol = ${symbol} AND tf_secondary = ${"ICT"}
      ORDER BY id DESC
      LIMIT 1
    `);
    attachSetupHistory(analysis, previousRecord ? safeJson(previousRecord.payload_json) : null);
    const inserted = await sql`
      INSERT INTO analysis_records
        (created_at, symbol, tf_primary, tf_secondary, direction, confidence, entry_low, entry_high,
         stop_loss, take_profit_1, take_profit_2, image_primary, image_secondary, payload_json)
      VALUES (
        ${createdAt}, ${symbol}, ${tf}, ${"ICT"}, ${String(verdict.final_direction)},
        ${Number(verdict.final_confidence) || 0},
        ${tradable && plan ? finiteNumber(plan.entry_low) : null},
        ${tradable && plan ? finiteNumber(plan.entry_high) : null},
        ${tradable && plan ? finiteNumber(plan.stop) : null},
        ${tradable && plan ? finiteNumber(plan.tp1) : null},
        ${tradable && plan ? finiteNumber(plan.tp2) : null},
        ${""}, ${""}, ${JSON.stringify(analysis)}
      )
      RETURNING id
    `;
    id = finiteNumber(inserted[0]?.id);
    if (id === null) {
      historySaved = false;
      historyError = "Database did not return the inserted record ID.";
    }
  } catch (error) {
    historySaved = false;
    historyError = "Database unavailable.";
    logDatabaseError("ict_scan_history_save_failed", error);
  }
  return json({
    id, created_at: createdAt, history_saved: historySaved, history_error: historyError,
    tf_primary: tf, tf_secondary: "ICT", analysis,
  });
}

async function chat(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    badRequest("Request body must be valid JSON.");
  }
  const payload = body as { message?: unknown; analysis_id?: unknown } | null;
  const message = payload?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 4000) {
    badRequest("Message must contain between 1 and 4000 characters.");
  }
  const analysisId = payload?.analysis_id;
  if (analysisId !== undefined && analysisId !== null && (!Number.isSafeInteger(analysisId) || Number(analysisId) <= 0)) {
    badRequest("analysis_id must be a positive integer.");
  }
  let context: JsonRecord | null = null;
  let contextId: number | null = null;
  try {
    const sql = createSql(env);
    const row = analysisId
      ? await firstRow(sql`SELECT id, payload_json FROM analysis_records WHERE id = ${Number(analysisId)}`)
      : await firstRow(sql`SELECT id, payload_json FROM analysis_records ORDER BY id DESC LIMIT 1`);
    if (row) {
      context = safeJson(row.payload_json);
      contextId = row.id;
    }
  } catch (error) {
    logDatabaseError("chat_context_read_failed", error);
  }
  try {
    const answer = await chatWithDeepSeek(env, message, context);
    return json({ answer, provider: "DeepSeek", context_analysis_id: analysisId || contextId });
  } catch (error) {
    throw new ApiError(503, error instanceof Error ? error.message : "DeepSeek chat is unavailable.");
  }
}

async function liveMarket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const interval = url.searchParams.get("interval") || "1m";
  try {
    const market = await fetchLiveMarket(interval, env);
    return json(calculateLiveScan(market));
  } catch (error) {
    throw new ApiError(503, `Live market data unavailable: ${error instanceof Error ? error.message.slice(0, 320) : String(error).slice(0, 320)}`);
  }
}

async function liveAnalyze(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const interval = url.searchParams.get("interval") || "1m";
  let scan: JsonRecord;
  try {
    scan = calculateLiveScan(await fetchLiveMarket(interval, env));
  } catch (error) {
    throw new ApiError(503, `Live market data unavailable: ${error instanceof Error ? error.message.slice(0, 320) : String(error).slice(0, 320)}`);
  }
  scan.technical_direction = scan.direction || "WAIT";
  const review = await reviewLiveMarket(env, scan);
  scan.ai_review = review;
  if (review.ok) {
    const aiDirection = String(review.direction || "WAIT");
    if (aiDirection === scan.technical_direction) {
      scan.confluence_status = "AI_AND_TECHNICAL_ALIGNED";
      scan.scan_source = "deepseek_plus_technical_scan";
    } else {
      scan.confluence_status = "AI_TECHNICAL_CONFLICT";
      scan.direction = "WAIT";
      scan.action = "WAIT_FOR_CONFIRMATION";
      scan.setup_rationale = `${String(scan.setup_rationale || "").trim().replace(/;$/, "")}; AI review (${aiDirection}) conflicts with the technical scan (${String(scan.technical_direction)}); waiting for confirmation.`.replace(/^; /, "");
    }
  } else {
    scan.confluence_status = "TECHNICAL_ONLY";
    scan.scan_source = "rule_based_technical_scan";
  }
  const createdAt = new Date().toISOString();
  let id: number | null = null;
  let historySaved = true;
  let historyError: string | null = null;
  try {
    const sql = createSql(env);
    const inserted = await sql`
      INSERT INTO analysis_records
        (created_at, symbol, tf_primary, tf_secondary, direction, confidence, entry_low, entry_high,
         stop_loss, take_profit_1, take_profit_2, image_primary, image_secondary, payload_json)
      VALUES (
        ${createdAt}, ${"XAUUSD"}, ${String((scan.feed as JsonRecord | undefined)?.timeframe || "M1")}, ${"LIVE"},
        ${String(scan.direction || "WAIT")}, ${finiteNumber(scan.confidence) || 0},
        ${finiteNumber(scan.entry_low)}, ${finiteNumber(scan.entry_high)}, ${finiteNumber(scan.stop_loss)},
        ${finiteNumber(scan.take_profit_1)}, ${finiteNumber(scan.take_profit_2)}, ${""}, ${""}, ${JSON.stringify(scan)}
      )
      RETURNING id
    `;
    id = finiteNumber(inserted[0]?.id);
    if (id === null) { historySaved = false; historyError = "Database did not return the inserted record ID."; }
  } catch (error) {
    historySaved = false;
    historyError = "Database unavailable.";
    logDatabaseError("live_scan_history_save_failed", error);
  }
  return json({ id, created_at: createdAt, tf_primary: String((scan.feed as JsonRecord | undefined)?.timeframe || "M1"),
    tf_secondary: "LIVE", history_saved: historySaved, history_error: historyError, analysis: scan });
}

async function liveChat(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { badRequest("Request body must be valid JSON."); }
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 4000) badRequest("Message must contain between 1 and 4000 characters.");

  let currentScan: JsonRecord;
  try {
    currentScan = calculateLiveScan(await fetchLiveMarket("1m", env));
  } catch (error) {
    throw new ApiError(503, `Live market data unavailable: ${error instanceof Error ? error.message.slice(0, 260) : String(error).slice(0, 260)}`);
  }
  let savedScan: JsonRecord | null = null;
  try {
    const sql = createSql(env);
    const row = await firstRow(sql`
      SELECT payload_json FROM analysis_records
      WHERE tf_secondary = ${"LIVE"}
      ORDER BY id DESC
      LIMIT 1
    `);
    if (row?.payload_json) savedScan = safeJson(row.payload_json);
  } catch (error) {
    logDatabaseError("live_chat_context_read_failed", error);
  }
  if (savedScan) {
    currentScan.latest_analyzer_scan = {
      created_at: savedScan.feed && typeof savedScan.feed === "object" ? (savedScan.feed as JsonRecord).fetched_at : null,
      direction: savedScan.direction, technical_direction: savedScan.technical_direction,
      action: savedScan.action, entry_low: savedScan.entry_low, entry_high: savedScan.entry_high,
      stop_loss: savedScan.stop_loss, take_profit_1: savedScan.take_profit_1, take_profit_2: savedScan.take_profit_2,
      confluence_status: savedScan.confluence_status, ai_review: savedScan.ai_review,
    };
  }
  try {
    const answer = await chatWithLiveMarket(env, message, currentScan);
    return json({ answer, provider: "DeepSeek", context: "live-market-terminal", feed_time: (currentScan.feed as JsonRecord | undefined)?.last_bar_time });
  } catch (error) {
    throw new ApiError(503, error instanceof Error ? error.message : "DeepSeek live chat is unavailable.");
  }
}

async function uploadedImage(env: Env, pathname: string): Promise<Response> {
  const name = pathname.slice("/uploads/".length);
  if (!/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(name)) throw new ApiError(404, "Image not found.");
  const object = await env.UPLOADS.get(name);
  if (!object) throw new ApiError(404, "Image not found.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const { pathname } = requestUrl;
  const origin = request.headers.get("Origin");
  if (request.method === "POST" && origin && origin !== requestUrl.origin) {
    throw new ApiError(403, "Cross-origin requests are not allowed.");
  }
  if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (pathname.startsWith("/uploads/")) {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return uploadedImage(env, pathname);
  }
  if (pathname === "/api/health" && request.method === "GET") return getHealth(env);
  if (pathname === "/api/image-analysis-spec" && request.method === "GET") return json(imageAnalysisSpec);
  if (pathname === "/api/live-market" && request.method === "GET") return liveMarket(request, env);
  if (pathname === "/api/live-analyze" && request.method === "POST") return liveAnalyze(request, env);
  if (pathname === "/api/live-chat" && request.method === "POST") return liveChat(request, env);
  if (pathname === "/api/analyze/stream" && request.method === "POST") return analyzeStream(request, env);
  if (pathname === "/api/analyze" && request.method === "POST") return analyze(request, env);
  if (pathname === "/api/history" && request.method === "GET") return history(env, new URL(request.url));
  if (pathname === "/api/stats" && request.method === "GET") return stats(env);
  if (pathname === "/api/stats/daily" && request.method === "GET") return statsDaily(env, requestUrl);
  if (pathname === "/api/ict/candles" && request.method === "GET") return ictCandles(request, env);
  if (pathname === "/api/ict/scan" && request.method === "POST") return ictScan(request, env);
  if (pathname === "/api/news/events" && request.method === "GET") return json(await eventsPayload(env, requestUrl.searchParams.get("refresh") === "true"));
  if (pathname === "/api/news/status" && request.method === "GET") return json(await newsContext(env));
  if (pathname === "/api/news/analyze" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return json(analyzeEvent(String(body.title || "").slice(0, 200), body.actual, body.forecast, body.previous));
  }
  const outcomeMatch = pathname.match(/^\/api\/history\/(\d+)\/outcome$/);
  if (outcomeMatch && request.method === "POST") return setOutcome(request, env, Number(outcomeMatch[1]));
  const detailMatch = pathname.match(/^\/api\/history\/(\d+)$/);
  if (detailMatch && request.method === "GET") return historyDetail(env, Number(detailMatch[1]));
  if (pathname === "/api/chat" && request.method === "POST") return chat(request, env);
  if (pathname.startsWith("/api/")) return json({ detail: "API endpoint not found." }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/") || pathname.startsWith("/uploads/")) {
        const denied = authorize(request, env);
        if (denied) return denied;
      }
      return await dispatch(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json({ detail: error.message }, error.status);
      const { pathname } = new URL(request.url);
      console.error(JSON.stringify({
        event: "request_failed",
        path: pathname,
        message: error instanceof Error ? error.message : String(error),
      }));
      return json({ detail: "Request failed. Check the Worker logs for details." }, 500);
    }
  },
};
