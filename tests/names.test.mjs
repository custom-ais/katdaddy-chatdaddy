// Customer names (and cities) are capitalized before they're saved, so the receipt, emails, the
// Jobber client and the dashboard all read "Jack Frost", not "jack frost".

import test from "node:test";
import assert from "node:assert/strict";
import { properName } from "../shared/domain.mjs";
import { harness, contact } from "./helpers.mjs";

test("names are capitalized the way people expect, and deliberate capitals are kept", () => {
  const cases = {
    "jack frost": "Jack Frost",
    "JACK FROST": "Jack Frost",
    "Jack frost": "Jack Frost", // a phone keyboard capitalizes only the first word
    "  jack   frost ": "Jack Frost",
    "o'brien": "O'Brien",
    "O'brien": "O'Brien",
    "mary-jane smith": "Mary-Jane Smith",
    "mccoy": "McCoy",
    "john smith iii": "John Smith III",
    "j. r. r. tolkien": "J. R. R. Tolkien",
    "josé álvarez": "José Álvarez",
    "li": "Li",
    // kept as typed
    "DeShawn jones": "DeShawn Jones",
    "McDonald": "McDonald",
    "JD Smith": "JD Smith",
    "Jan van der Berg": "Jan van der Berg",
    // cities
    "peoria": "Peoria",
    "El mirage": "El Mirage",
    "LITCHFIELD PARK": "Litchfield Park",
    "": "",
  };
  for (const [typed, saved] of Object.entries(cases)) assert.equal(properName(typed), saved, JSON.stringify(typed));
  assert.equal(properName(null), "");
});

test("a booking typed in lowercase is saved, sent to Jobber and shown capitalized", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const token = await h.prepare("cleaning", { ...contact, name: "jack frost", city: "buckeye" });
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const booked = await h.confirm(token, held.data.hold);
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.equal(booked.data.receipt.name, "Jack Frost");
  assert.equal(booked.data.receipt.city, "Buckeye");
  const appt = (await h.store.appointments()).at(-1);
  assert.deepEqual([appt.customerName, appt.city], ["Jack Frost", "Buckeye"]);
  const client = h.jobber.clients.at(-1);
  assert.deepEqual([client.contact.firstName, client.contact.lastName, client.address.city], ["Jack", "Frost", "Buckeye"], "the Jobber client too");
});

test("a callback request keeps the capitalized name too", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  const sent = await h.call("/api/requests", { method: "POST", token, body: { name: "JANE DOE", phone: "6235550188", message: "Please call me about a vent.", idempotencyKey: "names-test-request-0001" } });
  assert.ok([200, 201].includes(sent.status), JSON.stringify(sent.data));
  assert.equal((await h.store.requests()).at(-1).name, "Jane Doe");
});
