import type { Env } from "./db.ts";

/**
 * Serve a pre-computed payload instead of re-scanning the historical tables on
 * every cache miss. `revision` comes from app_meta and is bumped whenever a
 * collection run or a local sync writes data, so stale payloads are ignored.
 */
export async function cachedPayload<T>(
  env: Env,
  key: string,
  revision: string,
  compute: () => Promise<T>,
): Promise<T> {
  let row: { payload_json: string; data_version: string } | null = null;
  try {
    row = await env.DB.prepare(
      "SELECT payload_json,data_version FROM api_cache WHERE cache_key=?",
    ).bind(key).first<{ payload_json: string; data_version: string }>();
  } catch (error) {
    // The cache table is created by migration 0003; fall back to computing the
    // payload if a deployment reaches a database where the migration is pending.
    console.warn("api_cache read failed", error);
  }
  if (row && row.data_version === revision) {
    try {
      return JSON.parse(row.payload_json) as T;
    } catch (error) {
      console.warn("api_cache payload is invalid; recomputing", error);
    }
  }
  const payload = await compute();
  try {
    await env.DB.prepare(
      `INSERT INTO api_cache(cache_key,payload_json,data_version,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload_json=excluded.payload_json,
         data_version=excluded.data_version,
         updated_at=excluded.updated_at`,
    ).bind(key, JSON.stringify(payload), revision, new Date().toISOString()).run();
  } catch (error) {
    console.warn("api_cache write failed", error);
  }
  return payload;
}
