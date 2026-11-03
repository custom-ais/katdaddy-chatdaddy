// The website nudge: page-aware offers in the embed script, and taps logged as activity.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harness } from "./helpers.mjs";

const embed = readFileSync(new URL("../public/embed.js", import.meta.url), "utf8");

test("the embed script offers page-aware nudges, can be turned off, and is ASCII-only", () => {
  assert.ok([...embed].every((ch) => ch.charCodeAt(0) < 128), "plain ASCII shows right on pages that don't declare UTF-8");
  for (const key of ["emergency", "pest", "repair", "cleaning"]) assert.match(embed, new RegExp(`key:'${key}'`));
  assert.match(embed, /data-nudge="off"|dataset\.nudge==='off'/);
  assert.match(embed, /bob-nudge-dismissed/);
  assert.match(embed, /14\*864e5/, "a dismissal keeps it away for two weeks");
  assert.match(embed, /'\/chat\?embed=1'\+\(start\?'&start='/, "tapping it opens BOB on the matching path");
});

test("a nudge tap is logged with its topic; unknown topics are logged as general", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  for (const topic of ["repair", "made-up"]) {
    const r = await h.call("/api/activity", { method: "POST", token, body: { kind: "widget.nudge_opened", topic } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const { items } = await h.store.activity({});
  const taps = items.filter((i) => i.kind === "widget.nudge_opened").map((i) => i.details.topic).sort();
  assert.deepEqual(taps, ["general", "repair"]);
});
