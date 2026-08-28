const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validatePartnerLocation: validate, locationWriteFilter } = require("../src/utils/locationValidation");
const payload = (extra = {}) => ({ lat: 26.14, lng: 91.74, accuracy: 8, provider: "gps", recordedAt: Date.now(), ...extra });
const partner = (extra = {}) => ({
  _id: "p", location: { coordinates: [91.74, 26.14] },
  lastLocationAt: new Date(Date.now() - 30000), lastLocationAccuracy: 8, ...extra
});

test("existing app payload and legacy omitted timestamp remain compatible", () => {
  assert.equal(validate({ payload: payload() }).valid, true);
  assert.equal(validate({ payload: payload({ recordedAt: undefined }) }).valid, true);
});
test("empty, zero and malformed coordinates are not valid GPS", () => {
  for (const lat of [null, "", false, NaN, 91]) assert.equal(validate({ payload: payload({ lat }) }).valid, false);
  assert.equal(validate({ payload: payload({ lat: 0, lng: 0 }) }).valid, false);
});
test("invalid, stale and future timestamps rejected", () => {
  for (const recordedAt of ["bad", Date.now() - 180000, Date.now() + 120000])
    assert.equal(validate({ payload: payload({ recordedAt }) }).valid, false);
});
test("poor GPS does not label partner suspicious", () => {
  const result = validate({ partner: partner(), payload: payload({ accuracy: 900 }) });
  assert.equal(result.valid, false);
  assert.equal(result.suspicious, false);
});
test("explicit mock still flagged", () => {
  const result = validate({ payload: payload({ isMock: true }) });
  assert.equal(result.valid, false);
  assert.equal(result.suspicious, true);
});
test("100m network estimate cannot replace fresh 8m GPS", () => {
  assert.equal(validate({ partner: partner(), payload: payload({ accuracy: 100, provider: "network" }) }).valid, false);
});
test("available network location accepted when precise fix is old", () => {
  assert.equal(validate({ partner: partner({ lastLocationAt: new Date(Date.now() - 180000) }),
    payload: payload({ accuracy: 100, provider: "network" }) }).valid, true);
});
test("out of order response rejected", () => {
  assert.equal(validate({ partner: partner(), payload: payload({ recordedAt: Date.now() - 45000 }) }).valid, false);
});
test("rapid impossible jump no longer bypasses speed validation", () => {
  assert.equal(validate({ partner: partner({ lastLocationAt: new Date(Date.now() - 2000) }),
    payload: payload({ lat: 27.14 }) }).valid, false);
});
test("small GPS drift and normal motion allowed", () => {
  assert.equal(validate({ partner: partner(), payload: payload({ lat: 26.141 }) }).valid, true);
});
test("near-customer job checks remain enforced", () => {
  assert.equal(validate({ payload: payload(), booking: { location: { coordinates: [90, 25] } },
    requireNearCustomer: true }).valid, false);
});
test("compare-and-set uses exact observed timestamp, including absent location", () => {
  const p = partner();
  assert.deepEqual(locationWriteFilter(p), { _id: "p", lastLocationAt: p.lastLocationAt });
  assert.deepEqual(locationWriteFilter({ _id: "p" }), { _id: "p", lastLocationAt: null });
});
