// The home layout is two short questions: 1-story or 2-story, and for a 2-story home, which floor
// the laundry is on. The answers pick the 1-story, 2-story or upstairs-laundry price.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, INITIAL_FAQS, serviceQuote } from "../shared/domain.mjs";
import { initialSession, turn } from "../shared/conversation.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true };
const run = (steps) => { let s = initialSession(), r; for (const m of steps) { r = turn(m, s, config, INITIAL_FAQS); s = r.session; } return r; };
const toStories = ["Dryer Vent Cleaning", "85326", "Have Dryer", "No"];
const last = (r) => r.reply.split("\n\n").at(-1);

test("the stories question offers 1-Story, 2-Story and Not sure", () => {
  const r = run(toStories);
  assert.equal(last(r), "Is your home a 1-story or 2-story residence?");
  assert.deepEqual(r.options, ["1-Story Home", "2-Story Home", "Not sure"]);
});

test("a 2-story home is asked which floor the laundry is on", () => {
  const r = run([...toStories, "2-Story Home"]);
  assert.match(r.reply, /^Got it, a 2-story home\.\n\nIs the laundry room on the 1st floor or the 2nd floor\?$/);
  assert.deepEqual(r.options, ["1st Floor", "2nd Floor", "Not sure"]);
  assert.equal(r.session.pending, "laundryFloor");
  for (const [answer, floor, ack] of [["1st Floor", "1st floor", /^Got it, 2-story home with first-floor laundry setup\./], ["2nd Floor", "2nd floor", /^Understood, second-floor laundry setup\./], ["Not sure", "Not sure", /./]]) {
    const next = run([...toStories, "2-Story Home", answer]);
    assert.deepEqual([next.session.property.stories, next.session.property.laundryFloor], ["2-story", floor], answer);
    assert.match(next.reply, ack, answer);
    assert.notEqual(next.session.pending, "laundryFloor", "asked once");
    assert.match(last(next), /gas or electric/i, "then on to the dryer");
  }
});

test("a 1-story home (or not sure) isn't asked about the laundry floor", () => {
  for (const answer of ["1-Story Home", "Not sure"]) {
    const r = run([...toStories, answer]);
    assert.notEqual(r.session.pending, "laundryFloor", answer);
    assert.doesNotMatch(r.reply, /laundry room on the 1st floor/, answer);
  }
});

test("a typed answer that already says where the laundry is skips the follow-up", () => {
  const r = run([...toStories, "two story, laundry is upstairs"]);
  assert.deepEqual([r.session.property.stories, r.session.property.laundryFloor], ["2-story", "2nd floor"]);
  assert.notEqual(r.session.pending, "laundryFloor");
});

test("the answers pick the price: 2-story with upstairs laundry is $20 less than with first-floor laundry", () => {
  const premium = (steps) => {
    const { session } = run([...toStories, ...steps, "Electric Dryer", "Standard Floor Setup", "Dries in one normal cycle", "No signs"]);
    return serviceQuote("cleaning", config, { package: "premium", property: session.property }).priceCents;
  };
  const oneStory = premium(["1-Story Home"]), down = premium(["2-Story Home", "1st Floor"]), up = premium(["2-Story Home", "2nd Floor"]);
  assert.equal(down - up, 2000);
  assert.ok(down > oneStory, "a 2-story home with first-floor laundry costs more than a 1-story home");
});
