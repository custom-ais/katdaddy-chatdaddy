import test from "node:test";
import assert from "node:assert/strict";
import { approvalPolicy } from "../server/approval-policy.mjs";

const now = Date.parse("2026-11-01T00:00:00Z"); // October 31 in Phoenix
const today = { start: Date.parse("2026-11-01T01:00:00Z") };
const tomorrow = { scheduledAt: "2026-11-01T18:00:00Z", sameDay: true };
const config = { approvalServices: ["emergency", "special"] };

test("only emergency today in Phoenix requires company approval, even with the legacy switch off", () => {
  assert.deepEqual(approvalPolicy({ package: "emergency" }, today, { approvalServices: [] }, now), { required: true, blocked: false, reason: "" });
  assert.equal(approvalPolicy({ package: "emergency" }, { ...today, overflow: true }, config, now).required, true);
});

test("ordinary appointments do not wait for approval", () => {
  assert.deepEqual(approvalPolicy({ package: "premium" }, today, config, now), { required: false, blocked: false, reason: "" });
  assert.equal(approvalPolicy({ package: "premium" }, tomorrow, config, now).blocked, false);
});

test("out-of-scope legacy exceptions remain blocked instead of silently bypassing approval", () => {
  for (const [quote, slot] of [
    [{ package: "premium" }, { ...today, overflow: true }],
    [{ package: "special" }, today],
    [{ package: "emergency" }, tomorrow],
    [{ package: "emergency" }, { sameDay: true }],
  ]) {
    const policy = approvalPolicy(quote, slot, config, now);
    assert.equal(policy.required, false);
    assert.equal(policy.blocked, true);
    assert.match(policy.reason, /office/);
  }
});

test("approval policy rechecks date at decision time and does not trust a sameDay flag", () => {
  const emergency = { package: "emergency" };
  assert.equal(approvalPolicy(emergency, { ...today, sameDay: false }, config, now).required, true);
  assert.equal(approvalPolicy(emergency, today, config, now + 86_400_000).blocked, true);
});
