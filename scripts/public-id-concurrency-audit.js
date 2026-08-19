process.env.USE_IN_MEMORY_DB = "true";
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { nextPublicId, FORMATS } = require("../src/utils/publicIds");
const User = require("../src/models/User");
const Partner = require("../src/models/Partner");
const { Booking } = require("../src/models/Booking");
const SupportTicket = require("../src/models/SupportTicket");
const Payment = require("../src/models/Payment");
const { serializeBooking } = require("../src/sockets/bookingSocket");

async function main() {
  const server = await MongoMemoryServer.create({ instance: { dbName: "public_id_audit" } });
  await mongoose.connect(server.getUri());
  await Booking.init();
  for (const [kind, format] of Object.entries(FORMATS)) {
    const ids = await Promise.all(Array.from({ length: 100 }, () => nextPublicId(kind)));
    if (new Set(ids).size !== ids.length) throw new Error(`${kind}: duplicate ID generated`);
    const pattern = new RegExp(`^${format.prefix}\\d{${format.width}}$`);
    if (ids.some((value) => !pattern.test(value))) throw new Error(`${kind}: invalid ID format`);
  }
  const user = await User.create({ firebaseUid: "audit-user", deviceTokens: [{ tokenHash: "audit-user-device", platform: "android" }] });
  const upsertedUser = await User.findOneAndUpdate({ firebaseUid: "audit-upsert-user" }, { $set: { name: "Audit" } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const partner = await Partner.create({ firebaseUid: "audit-partner", deviceTokens: [{ tokenHash: "audit-partner-device", platform: "ios" }] });
  const booking = await Booking.create({ bookingCode: "AUDIT-IDEMPOTENCY-CODE", userId: user._id, serviceCategory: "cleaning", address: "Audit" });
  const frontendBookingId = "ASB-20260819-8F4K7M2Q";
  const frontendBooking = await Booking.create({
    bookingId: frontendBookingId,
    publicId: frontendBookingId,
    bookingCode: frontendBookingId,
    userId: user._id,
    serviceCategory: "cleaning",
    address: "Audit frontend booking"
  });
  const payment = await Payment.create({ bookingId: booking._id, userId: user._id, partnerId: partner._id, amount: 100 });
  const userTicket = await SupportTicket.create({ ticketCode: "AUDIT-USER-TICKET", userId: user._id });
  const partnerTicket = await SupportTicket.create({ ticketCode: "AUDIT-PARTNER-TICKET", partnerId: partner._id, source: "partner_app" });
  const values = [user.publicId, upsertedUser.publicId, partner.publicId, booking.publicId, payment.publicId, userTicket.publicId, partnerTicket.publicId, user.deviceTokens[0].publicId, partner.deviceTokens[0].publicId];
  if (values.some((value) => !value)) throw new Error(`Schema hook did not assign every public ID: ${values.join(", ")}`);
  const payload = serializeBooking(booking);
  if (payload.publicId !== booking.publicId || payload.bookingCode !== booking.publicId || payload.internalBookingCode !== booking.bookingCode) {
    throw new Error("Booking API payload did not expose one canonical public ID");
  }
  const frontendPayload = serializeBooking(frontendBooking);
  if (frontendPayload.publicId !== frontendBookingId
      || frontendPayload.bookingCode !== frontendBookingId
      || frontendPayload.canonicalBookingId !== frontendBookingId) {
    throw new Error("Frontend booking ID was replaced instead of being preserved");
  }
  let duplicateRejected = false;
  try {
    await Booking.create({
      bookingId: frontendBookingId,
      publicId: frontendBookingId,
      bookingCode: `${frontendBookingId}-DUPLICATE`,
      userId: user._id,
      serviceCategory: "cleaning",
      address: "Duplicate audit"
    });
  } catch (error) {
    duplicateRejected = error?.code === 11000;
  }
  if (!duplicateRejected) throw new Error("Database did not enforce unique frontend bookingId");
  console.log("Public ID concurrency audit passed: 800 atomic IDs, schema hooks, and canonical booking payload; no duplicates.");
  await mongoose.disconnect();
  await server.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
