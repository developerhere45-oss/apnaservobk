require("dotenv").config();
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../src/models/User");
const Partner = require("../src/models/Partner");
const { Booking } = require("../src/models/Booking");
const BookingMessage = require("../src/models/BookingMessage");
const Payment = require("../src/models/Payment");
const Invoice = require("../src/models/Invoice");
const { ensurePaidInvoice } = require("../src/services/invoiceService");

async function run() {
  const mongo = await MongoMemoryServer.create();
  try {
    await mongoose.connect(mongo.getUri());
    await Promise.all([BookingMessage.syncIndexes(), Payment.syncIndexes(), Invoice.syncIndexes()]);
    const user = await User.create({ firebaseUid: "audit-user", name: "Audit User" });
    const partner = await Partner.create({ firebaseUid: "audit-partner", name: "Audit Partner" });
    const booking = await Booking.create({
      bookingCode: "ASB-AUDIT-CHATPAY", serviceCategory: "ac", serviceName: "AC Repair",
      address: "Audit address", location: { type: "Point", coordinates: [91.7, 26.1] },
      userId: user._id, partnerId: partner._id, price: 400, finalAmount: 550,
      quoteAmount: 550, status: "completed", paymentStatus: "paid",
      userSnapshot: { name: user.name }, partnerSnapshot: { name: partner.name }
    });
    const clientMessageId = "audit-message-1";
    await BookingMessage.create({ bookingId: booking._id, bookingCode: booking.bookingCode,
      userId: user._id, partnerId: partner._id, senderRole: "user", message: "hello", clientMessageId });
    let duplicateRejected = false;
    try {
      await BookingMessage.create({ bookingId: booking._id, bookingCode: booking.bookingCode,
        userId: user._id, partnerId: partner._id, senderRole: "user", message: "hello", clientMessageId });
    } catch (error) { duplicateRejected = error?.code === 11000; }
    assert(duplicateRejected, "chat clientMessageId must be idempotent");

    const payment = await Payment.create({ bookingId: booking._id, userId: user._id, partnerId: partner._id,
      serviceAmount: 550, amount: 550, status: "paid", paymentMethod: "direct", paidAt: new Date(), verifiedAt: new Date() });
    const first = await ensurePaidInvoice({ booking, payment, user, partner });
    const second = await ensurePaidInvoice({ booking, payment, user, partner });
    assert.strictEqual(String(first._id), String(second._id), "invoice generation must be idempotent");
    assert.strictEqual(first.finalAmount, payment.amount, "invoice must use payment amount");
    assert.strictEqual(await Invoice.countDocuments({ bookingId: booking._id }), 1, "one invoice per booking");
    console.log("chat-payment-invoice audit passed", { bookingId: String(booking._id), invoiceNumber: first.invoiceNumber });
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
