import { neon } from "@neondatabase/serverless";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { Env } from "./types";

export type WorkerSql = NeonQueryFunction<false, false>;

export function createSql(env: Env): WorkerSql {
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL Worker secret is not configured.");
  }
  return neon(env.DATABASE_URL);
}

export async function firstRow<T>(rows: Promise<T[]>): Promise<T | null> {
  const result = await rows;
  return result[0] ?? null;
}

export function logDatabaseError(event: string, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(JSON.stringify({ event, error_name: name, ...(code ? { postgres_code: code } : {}) }));
}
