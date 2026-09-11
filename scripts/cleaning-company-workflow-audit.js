const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const partner = source("src/controllers/partnerController.js");
const booking = source("src/controllers/bookingController.js");
const routes = source("src/routes/partnerRoutes.js");
const model = source("src/models/Booking.js");
const lifecycle = source("src/utils/bookingLifecycle.js");

assert.match(partner, /businessType:\s*z\.enum\(\["laundry", "cleaning"\]\)/, "cleaning company registration must be accepted");
assert.match(routes, /services\/cleaning\/staff/, "cleaning staff management aliases must exist");
assert.match(routes, /cleaning\/bookings\/:bookingId\/assign-team/, "cleaning team assignment route must exist");
assert.match(partner, /async function assignCleaningTeam/, "cleaning team assignment controller must exist");
assert.match(partner, /Every selected cleaning staff member must be verified/, "unverified team members must be rejected");
assert.match(model, /cleaningTeam:\s*\[/, "booking must persist the selected cleaning team");
assert.match(booking, /\["on_the_way", "arrived", "started"\]/, "live partner statuses must remain supported");
assert.match(lifecycle, /next === "amount_pending" && current !== "started"/, "amount must follow work start");
assert.match(lifecycle, /next === "completed" && current !== "amount_pending"/, "completion must follow final amount flow");
assert.match(booking, /quoteStatus !== "payment_submitted"/, "completion must wait for customer payment confirmation");

console.log("PASS cleaning registration, dispatch compatibility, team assignment, live statuses, final amount and completion gates");
