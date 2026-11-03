export interface Env {
  ASSETS: Fetcher;
  DATABASE_URL: string;
  UPLOADS: R2Bucket;
  APP_NAME?: string;
  APP_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  TWELVEDATA_API_KEY?: string;
  TWELVEDATA_SYMBOL?: string;
  FINNHUB_API_KEY?: string;
  NEWS_BLACKOUT_BEFORE_MIN?: string;
  NEWS_BLACKOUT_AFTER_MIN?: string;
  NEWS_CACHE_SECONDS?: string;
  ICT_AI_LANGUAGE?: string;
  ICT_MIN_SCORE?: string;
  DEEPSEEK_VISION_MODEL?: string;
  DEEPSEEK_CHAT_MODEL?: string;
  MAX_UPLOAD_MB?: string;
  CONFIDENCE_MINIMUM?: string;
  PRICE_AGREEMENT_ABSOLUTE?: string;
  ATR_AGREEMENT_PERCENT?: string;
  FORCE_SIGNAL?: string;
}

export type JsonRecord = Record<string, unknown>;

export interface AnalysisRecord {
  id: number;
  created_at: string;
  symbol: string;
  tf_primary: string;
  tf_secondary: string;
  direction: string;
  confidence: number;
  entry_low: number | null;
  entry_high: number | null;
  stop_loss: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  image_primary: string;
  image_secondary: string;
  payload_json: string;
}

export interface ChartImage {
  mimeType: string;
  base64: string;
  key: string;
}
