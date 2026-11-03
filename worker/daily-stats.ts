import type { JsonRecord } from "./types";

type DailyRecord = {
  created_at: string;
  symbol: string;
  direction: string;
  stop_loss: number | null;
  payload_json: string;
};

function parsePayload(value: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyDay(date: string): JsonRecord {
  return { date, signals: 0, wins: 0, resolved: 0, tp1: 0, tp2: 0, sl: 0, open: 0, not_taken: 0, win_rate: null, total_r: 0 };
}

export function buildDailyStats(
  records: DailyRecord[],
  days: number,
  timezoneOffsetMinutes: number,
  now: number,
  symbolFilter: string | null = null,
): { days: JsonRecord[]; today: JsonRecord } {
  const grouped = new Map<string, {
    date: string; signals: number; tp1: number; tp2: number; sl: number; open: number; not_taken: number; total_r: number;
  }>();
  const results: Record<string, number> = { TP1: 1, TP2: 1.8, SL: -1 };

  for (const row of records) {
    if (!["BUY", "SELL"].includes(row.direction) || row.stop_loss === null || !row.created_at) continue;
    if (symbolFilter && (row.symbol || "XAUUSD") !== symbolFilter) continue;
    const timestamp = Date.parse(row.created_at);
    if (!Number.isFinite(timestamp)) continue;
    const date = new Date(timestamp + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
    const group = grouped.get(date) || { date, signals: 0, tp1: 0, tp2: 0, sl: 0, open: 0, not_taken: 0, total_r: 0 };
    const payload = parsePayload(row.payload_json);
    const outcome = payload.outcome && typeof payload.outcome === "object" && !Array.isArray(payload.outcome)
      ? payload.outcome as JsonRecord : {};
    const result = outcome.result;
    group.signals++;
    if (typeof result === "string" && Object.hasOwn(results, result)) {
      group[result.toLowerCase() as "tp1" | "tp2" | "sl"]++;
      group.total_r += finiteNumber(outcome.r) ?? results[result];
    } else if (result === "SKIP") {
      group.not_taken++;
    } else {
      group.open++;
    }
    grouped.set(date, group);
  }

  const items = [...grouped.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, days).map((group) => {
    const wins = group.tp1 + group.tp2;
    const resolved = wins + group.sl;
    return {
      ...group,
      wins,
      resolved,
      win_rate: resolved ? Math.round(wins / resolved * 1000) / 10 : null,
      total_r: Math.round(group.total_r * 100) / 100,
    };
  });
  const todayDate = new Date(now + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
  return { days: items, today: items.find((item) => item.date === todayDate) || emptyDay(todayDate) };
}
