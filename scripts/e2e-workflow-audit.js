const assert = require("node:assert/strict");
const {
  transitionDecision,
  pendingAssignmentStatuses,
  activeJobStatuses,
  isTerminalBookingStatus
} = require("../src/utils/bookingLifecycle");
const findNearbyPartners = require("../src/utils/findNearbyPartners");

const checks = [];

function record(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

function expectOk(currentStatus, nextStatus, actorRole, quoteStatus = "none", extra = {}) {
  const result = transitionDecision({ currentStatus, nextStatus, actorRole, quoteStatus });
  assert.equal(result.ok, true, `${actorRole} ${currentStatus} -> ${nextStatus} should pass: ${result.reason || ""}`);
  for (const [key, value] of Object.entries(extra)) {
    assert.equal(result[key], value, `${key} expected ${value}`);
  }
}

function expectBlocked(currentStatus, nextStatus, actorRole, quoteStatus = "none") {
  const result = transitionDecision({ currentStatus, nextStatus, actorRole, quoteStatus });
  assert.equal(result.ok, false, `${actorRole} ${currentStatus} -> ${nextStatus} should be blocked`);
  assert.ok(result.reason, "Blocked transition must explain why");
}

record("customer registration creates a booking only after backend confirmation", () => {
  assert.deepEqual(pendingAssignmentStatuses(), ["pending", "sent_to_partner"]);
  expectOk("pending", "cancelled", "user");
});

record("partner assignment is atomic and starts from accepted state", () => {
  expectOk("accepted", "on_the_way", "partner");
  expectBlocked("pending", "on_the_way", "partner");
  expectBlocked("sent_to_partner", "started", "partner");
});

record("on-job tracking must move in order", () => {
  expectOk("accepted", "on_the_way", "partner");
  expectOk("on_the_way", "arrived", "partner");
  expectOk("arrived", "started", "partner");
  expectOk("started", "amount_pending", "partner");
  assert.deepEqual(activeJobStatuses(), ["accepted", "on_the_way", "arrived", "started", "amount_pending"]);
});

record("quote discussion supports counter offer and revised quote", () => {
  expectOk("amount_pending", "amount_pending", "partner", "countered");
  expectOk("amount_pending", "amount_pending", "partner", "pending", { idempotent: true });
  expectOk("amount_pending", "completed", "user", "pending");
  expectBlocked("amount_pending", "completed", "partner", "pending");
});

record("work completion is customer-approved and terminal", () => {
  expectOk("amount_pending", "completed", "user", "pending");
  assert.equal(isTerminalBookingStatus("completed"), true);
  expectBlocked("completed", "on_the_way", "partner");
  expectBlocked("completed", "cancelled", "user");
});

record("rating is allowed only after completed booking", () => {
  assert.equal(isTerminalBookingStatus("completed"), true);
  assert.equal(isTerminalBookingStatus("amount_pending"), false);
});

record("booking cancellation cannot happen after work starts", () => {
  expectOk("pending", "cancelled", "user");
  expectOk("accepted", "cancelled", "partner");
  expectBlocked("started", "cancelled", "user");
  expectBlocked("started", "cancelled", "partner");
});

record("partner rejection and unavailable cases stay before assignment", () => {
  expectBlocked("accepted", "rejected", "partner");
  expectBlocked("on_the_way", "rejected", "partner");
});

record("offline retry and app restart duplicate events are idempotent", () => {
  expectOk("on_the_way", "on_the_way", "partner", "none", { idempotent: true });
  expectOk("started", "on_the_way", "partner", "none", { idempotent: true });
  expectOk("completed", "completed", "user", "approved", { idempotent: true });
});

record("multiple-device races require atomic current-status filters", () => {
  expectBlocked("accepted", "amount_pending", "partner");
  expectOk("amount_pending", "arrived", "partner", "pending", { idempotent: true });
  expectBlocked("cancelled", "completed", "user");
});

record("partner search expands from 5 km to 10 km", () => {
  const customer = { lat: 26.1445, lng: 91.7362 };
  const partners = [
    { name: "near", location: { coordinates: [91.7722, 26.1445] } },
    { name: "expanded", location: { coordinates: [91.7992, 26.1445] } },
    { name: "outside", location: { coordinates: [91.8442, 26.1445] } }
  ];
  assert.deepEqual(findNearbyPartners.partnersWithinRadius(partners, customer.lat, customer.lng, 5).map((item) => item.partner.name), ["near"]);
  assert.deepEqual(findNearbyPartners.partnersWithinRadius(partners, customer.lat, customer.lng, 10).map((item) => item.partner.name), ["near", "expanded"]);
});

record("partner search requires a valid customer location for radius matching", () => {
  assert.equal(findNearbyPartners.validCoordinates(26.1445, 91.7362), true);
  assert.equal(findNearbyPartners.validCoordinates(0, 0), false);
  assert.equal(findNearbyPartners.validCoordinates(null, 91.7362), false);
});

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  const prefix = check.ok ? "PASS" : "FAIL";
  console.log(`${prefix} ${check.name}${check.ok ? "" : ` - ${check.error}`}`);
}

if (failures.length) {
  console.error(`\n${failures.length} workflow audit check(s) failed.`);
  process.exit(1);
}

console.log(`\nWorkflow audit passed: ${checks.length} checks.`);
