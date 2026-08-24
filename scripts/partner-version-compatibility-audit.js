const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { serializeBooking } = require("../src/sockets/bookingSocket");

const objectId = "507f1f77bcf86cd799439011";
const payload = serializeBooking({
  _id: objectId,
  bookingCode: "ASB-LEGACY-1",
  userId: "507f191e810c19729de860ea",
  serviceCategory: "laundry",
  serviceName: "Laundry",
  address: "Guwahati",
  city: "Guwahati",
  status: "sent_to_partner",
  userSnapshot: { name: "Compatibility User", phone: "9876543210" },
  location: { type: "Point", coordinates: [91.7362, 26.1445] }
});

// Current builds.
assert.equal(payload.bookingId, objectId);
assert.equal(payload.serviceCategory, "laundry");
assert.equal(payload.status, "sent_to_partner");

// Previously released builds.
assert.equal(payload.id, objectId);
assert.equal(payload.booking_id, objectId);
assert.equal(payload.serviceId, "laundry");
assert.equal(payload.serviceType, "laundry");
assert.equal(payload.service_category, "laundry");
assert.equal(payload.bookingStatus, "sent_to_partner");
assert.equal(payload.customerName, "Compatibility User");
assert.equal(payload.customerAddress, "Guwahati");

const socketSource = fs.readFileSync(path.join(__dirname, "../src/sockets/bookingSocket.js"), "utf8");
for (const eventName of ["booking:new_request", "new_booking", "booking:new"]) {
  assert.ok(socketSource.includes(`room.emit("${eventName}"`), `${eventName} must remain available`);
}
assert.ok(socketSource.includes("io.to(`partner:${partner._id}`)"), "legacy events must remain partner-room scoped");

const controllerSource = fs.readFileSync(path.join(__dirname, "../src/controllers/bookingController.js"), "utf8");
assert.ok(controllerSource.includes('action: "OPEN_BOOKING"'), "legacy push must open the booking screen");
assert.ok(controllerSource.includes('category: "booking_request"'), "legacy push category must be retained");

console.log("PASS old and current Partner App booking contracts receive compatible REST, socket, and push identifiers");
