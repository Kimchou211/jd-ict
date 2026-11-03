export interface SymbolProfile {
  name: "XAUUSD" | "BTCUSD";
  aliases: ReadonlySet<string>;
  price_min: number;
  price_max: number;
  price_abs: number;
  price_pct: number;
  atr_abs: number;
  atr_floor: number;
  agree_abs: number;
}

const PROFILES: Record<SymbolProfile["name"], SymbolProfile> = {
  XAUUSD: {
    name: "XAUUSD",
    aliases: new Set(["XAUUSD", "XAUUSDM", "GOLD", "GOLDUSD"]),
    price_min: 500,
    price_max: 10_000,
    price_abs: 0.5,
    price_pct: 0.0005,
    atr_abs: 0.05,
    atr_floor: 0.05,
    agree_abs: 1,
  },
  BTCUSD: {
    name: "BTCUSD",
    aliases: new Set(["BTCUSD", "BTCUSDT", "BTCUSDM", "BITCOIN", "XBTUSD"]),
    price_min: 1_000,
    price_max: 1_000_000,
    price_abs: 10,
    price_pct: 0.0005,
    atr_abs: 1,
    atr_floor: 1,
    agree_abs: 40,
  },
};

function compactSymbol(value: string): string {
  return value.toUpperCase().replace(/[\/\-\s]/g, "");
}

export function normalizeSymbol(value: string | null | undefined): SymbolProfile["name"] {
  const symbol = compactSymbol(value || "XAUUSD");
  for (const profile of Object.values(PROFILES)) {
    if (profile.aliases.has(symbol)) return profile.name;
  }
  throw new Error("Unsupported symbol. Use XAUUSD or BTCUSD.");
}

export function symbolProfile(symbol: string): SymbolProfile {
  return PROFILES[normalizeSymbol(symbol)];
}

export function matchesSymbol(detected: unknown, symbol: string): boolean {
  if (typeof detected !== "string") return false;
  return symbolProfile(symbol).aliases.has(compactSymbol(detected));
}
