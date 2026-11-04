import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function call(functionName, fixture, ...args) {
  const result = spawnSync(
    process.execPath,
    ["sdk/run.mjs", "--raw", "--replay", fixture, ".", functionName, ...args],
    { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /dropped by Kino/i);
  return JSON.parse(result.stdout);
}

test("home lists anime with valid stable ids and poster art", () => {
  const rows = call("home", "fixtures/home.json");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].genre, "anime");
  assert.ok(rows[0].items.length > 0);
  for (const item of rows[0].items) {
    assert.match(item.id, /^[A-Za-z0-9._~-]{1,128}$/);
    assert.equal(item.kind, "series");
    assert.match(item.poster, /^https:\/\/cdn\.animeav1\.com\//);
  }
});

test("search returns matching catalog entries", () => {
  const result = call("search", "fixtures/search-frieren.json", "Frieren");
  assert.equal(result.items.length, 2);
  assert.ok(result.items.some((item) => item.title === "Sousou no Frieren"));
  assert.ok(result.items.every((item) => item.kind === "series"));
});

test("browse returns the next catalog page", () => {
  const result = call("browse", "fixtures/browse-page-2.json", "catalogo", "2");
  assert.equal(result.items[0].title, "Romelia Senki");
  assert.equal(result.next, "3");
});

test("episodes preserve the source episode numbering", () => {
  const result = call("episodes", "fixtures/episodes-one-piece.json", "one-piece");
  assert.equal(result.series.title, "One Piece");
  assert.equal(result.series.year, "1999");
  assert.equal(result.episodes.length, 1180);
  assert.deepEqual(
    [result.episodes[0].season, result.episodes[0].number, result.episodes.at(-1).number],
    [1, 1, 1180],
  );
});

test("resolve returns the observed HLS manifest", () => {
  const result = call("resolve", "fixtures/resolve-one-piece-1.json", "one-piece|1");
  assert.equal(
    result.url,
    "https://player.zilla-networks.com/m3u8/7601658844858539e438dceee32e7924",
  );
});
