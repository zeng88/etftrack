import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

test("serves the homepage through the static asset binding", async () => {
  const request = new Request("https://etftrack.test/");
  const response = await worker.fetch(request, {
    ASSETS: { fetch: async (assetRequest) => new Response(`asset:${new URL(assetRequest.url).pathname}`) },
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset:/");
});

test("returns JSON 404 for unknown API routes instead of static fallback", async () => {
  const response = await worker.fetch(new Request("https://etftrack.test/api/missing"), {
    ASSETS: { fetch: async () => new Response("unexpected static fallback") },
  });

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), { error: "Not found" });
});
