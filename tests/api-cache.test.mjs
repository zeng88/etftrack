import assert from "node:assert/strict";
import test from "node:test";
import { cachedPayload } from "../src/api-cache.ts";

function createDb() {
  const state = { cache: new Map(), writes: 0 };
  const db = {
    prepare(sql) {
      const statement = { sql, args: [], bind(...args) { this.args = args; return this; } };
      statement.first = async () => {
        if (sql.includes("FROM api_cache WHERE cache_key=?")) {
          const row = state.cache.get(statement.args[0]);
          return row ? { payload_json: row.payload, data_version: row.version } : null;
        }
        return null;
      };
      statement.run = async () => {
        if (sql.includes("INSERT INTO api_cache")) {
          const [key, payload, version] = statement.args;
          state.cache.set(key, { payload, version });
          state.writes++;
        }
        return { success: true };
      };
      return statement;
    },
  };
  return { db, state };
}

test("a cached payload is reused until the data revision changes", async () => {
  const { db, state } = createDb();
  let computes = 0;
  const compute = async () => ({ value: ++computes });

  const first = await cachedPayload({ DB: db }, "dashboard", "rev-1", compute);
  const second = await cachedPayload({ DB: db }, "dashboard", "rev-1", compute);
  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(second, { value: 1 });
  assert.equal(computes, 1);
  assert.equal(state.writes, 1);

  const updated = await cachedPayload({ DB: db }, "dashboard", "rev-2", compute);
  assert.deepEqual(updated, { value: 2 });
  assert.equal(computes, 2);
  assert.equal(state.writes, 2);
});

test("different cache keys do not share payloads", async () => {
  const { db, state } = createDb();
  let computes = 0;
  const compute = async () => ({ value: ++computes });

  await cachedPayload({ DB: db }, "pool-stats:all", "rev-1", compute);
  await cachedPayload({ DB: db }, "flow-overview", "rev-1", compute);
  assert.equal(computes, 2);
  assert.equal(state.cache.size, 2);
});
