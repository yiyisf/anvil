import test from "node:test";
import assert from "node:assert/strict";
import { matchRoute } from "./http.mjs";

test("HTTP router prefers exact routes and decodes path parameters", () => {
  const exact = () => "exact";
  const dynamic = () => "dynamic";
  const routes = {
    "GET /api/works/current": exact,
    "GET /api/works/:id": dynamic,
  };
  assert.equal(matchRoute("GET", "/api/works/current", routes).handler, exact);
  const matched = matchRoute("GET", "/api/works/WORK%201", routes);
  assert.equal(matched.handler, dynamic);
  assert.deepEqual(matched.params, { id: "WORK 1" });
});

test("HTTP router rejects a different method or unmatched path", () => {
  const routes = { "GET /api/works/:id": () => null };
  assert.equal(matchRoute("POST", "/api/works/1", routes), null);
  assert.equal(matchRoute("GET", "/api/projects/1", routes), null);
});
