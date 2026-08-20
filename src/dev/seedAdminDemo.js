const User = require("../models/User");
const Partner = require("../models/Partner");
const { Booking } = require("../models/Booking");
const Payment = require("../models/Payment");
const SupportTicket = require("../models/SupportTicket");

function ago(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function seedAdminDemo() {
  if (await User.exists({ firebaseUid: /^demo-user-/ })) return;

  const users = await User.create([
    {
      firebaseUid: "demo-user-rohan",
      name: "Rohan Dey",
      phone: "9876543210",
      email: "rohan@example.com",
      address: "Beltola, Guwahati, Assam",
      savedAddresses: [
        { label: "Home", address: "Beltola, Guwahati, Assam", city: "Guwahati", isDefault: true, location: { type: "Point", coordinates: [91.7898, 26.1119] } },
        { label: "Work", address: "GS Road, Christian Basti, Guwahati", city: "Guwahati", location: { type: "Point", coordinates: [91.7722, 26.1593] } }
      ],
      location: { type: "Point", coordinates: [91.7898, 26.1119] },
      phoneVerified: true,
      phoneVerifiedAt: ago(240),
      bookingRiskStatus: "trusted",
      accountStatus: "active",
      lastLoginAt: ago(1),
      deviceInfo: { platform: "Android", osVersion: "15", appVersion: "1.0.0", model: "Pixel 8", manufacturer: "Google" },
      registrationHistory: [{ source: "user_app", provider: "firebase", registeredAt: ago(240), userAgent: "ApnaServo Android" }],
      loginHistory: [{ loggedInAt: ago(1), userAgent: "ApnaServo Android", deviceInfo: { model: "Pixel 8" } }]
    },
    {
      firebaseUid: "demo-user-priya",
      name: "Priya Sharma",
      phone: "9123456780",
      email: "priya@example.com",
      address: "Dispur, Guwahati, Assam",
      savedAddresses: [{ label: "Home", address: "Dispur, Guwahati, Assam", city: "Guwahati", isDefault: true }],
      location: { type: "Point", coordinates: [91.7892, 26.1433] },
      phoneVerified: true,
      bookingRiskStatus: "trusted",
      accountStatus: "active",
      lastLoginAt: ago(8),
      deviceInfo: { platform: "Android", osVersion: "14", appVersion: "1.0.0", model: "Galaxy S23", manufacturer: "Samsung" }
    },
    {
      firebaseUid: "demo-user-amit",
      name: "Amit Singh",
      phone: "9988776655",
      email: "",
      address: "Six Mile, Guwahati, Assam",
      location: { type: "Point", coordinates: [91.8136, 26.1388] },
      bookingRiskStatus: "review",
      accountStatus: "suspended",
      lastLoginAt: ago(30),
      deviceInfo: { platform: "Android", osVersion: "13", appVersion: "0.9.8", model: "Redmi Note 12", manufacturer: "Xiaomi" }
    },
    {
      firebaseUid: "demo-user-neha",
      name: "Neha Das",
      phone: "9098765432",
      email: "neha@example.com",
      address: "Pan Bazaar, Guwahati, Assam",
      location: { type: "Point", coordinates: [91.7458, 26.1844] },
      bookingRiskStatus: "otp_required",
      accountStatus: "blocked",
      lastLoginAt: ago(72),
      deviceInfo: { platform: "Android", osVersion: "12", appVersion: "0.9.5", model: "OnePlus Nord", manufacturer: "OnePlus" }
    }
  ]);

  const partner = await Partner.create({
    firebaseUid: "demo-partner-karan",
    partnerCode: "PRT-DEMO-01",
    name: "Karan Electricals",
    phone: "9876501234",
    email: "karan@example.com",
    serviceCategory: ["electrician", "ac"],
    city: "Guwahati",
    serviceArea: "Guwahati, Assam",
    location: { type: "Point", coordinates: [91.78, 26.14] },
    isOnline: true,
    isVerified: true,
    kycStatus: "verified",
    trustStatus: "trusted"
  });

  const bookings = await Booking.create([
    {
      bookingCode: "AS-DEMO-1001",
      userId: users[0]._id,
      partnerId: partner._id,
      serviceCategory: "electrician",
      serviceName: "Electrical Repair",
      issue: "Switchboard sparking in living room",
      address: users[0].address,
      city: "Guwahati",
      status: "completed",
      price: 499,
      finalAmount: 599,
      paymentStatus: "paid",
      slot: "22 Jun 2026, 10:00 AM",
      acceptedAt: ago(46),
      completedAt: ago(44),
      userSnapshot: { name: users[0].name, phone: users[0].phone, email: users[0].email },
      partnerSnapshot: { name: partner.name, phone: partner.phone, rating: 4.8 },
      statusTimeline: [
        { status: "accepted", at: ago(46), by: "partner" },
        { status: "on_the_way", at: ago(45.5), by: "partner" },
        { status: "arrived", at: ago(45), by: "partner" },
        { status: "started", at: ago(44.8), by: "partner" },
        { status: "completed", at: ago(44), by: "partner" }
      ]
    },
    {
      bookingCode: "AS-DEMO-1002",
      userId: users[0]._id,
      serviceCategory: "plumbing",
      serviceName: "Plumbing Service",
      issue: "Kitchen tap leakage",
      address: users[0].savedAddresses[1].address,
      city: "Guwahati",
      status: "pending",
      price: 399,
      paymentStatus: "pending",
      slot: "23 Jun 2026, 02:00 PM",
      userSnapshot: { name: users[0].name, phone: users[0].phone, email: users[0].email },
      statusTimeline: [{ status: "pending", at: ago(2), by: "user" }]
    },
    {
      bookingCode: "AS-DEMO-1003",
      userId: users[1]._id,
      partnerId: partner._id,
      serviceCategory: "ac",
      serviceName: "AC Service",
      issue: "AC not cooling",
      address: users[1].address,
      city: "Guwahati",
      status: "cancelled",
      price: 699,
      paymentStatus: "refunded",
      userSnapshot: { name: users[1].name, phone: users[1].phone, email: users[1].email },
      partnerSnapshot: { name: partner.name, phone: partner.phone, rating: 4.8 },
      statusTimeline: [
        { status: "accepted", at: ago(70), by: "partner" },
        { status: "cancelled", at: ago(68), by: "user" }
      ]
    }
  ]);

  await Payment.create([
    { bookingId: bookings[0]._id, userId: users[0]._id, partnerId: partner._id, amount: 599, status: "paid", currency: "INR", razorpayOrderId: "order_demo_1001", razorpayPaymentId: "pay_demo_1001" },
    { bookingId: bookings[2]._id, userId: users[1]._id, partnerId: partner._id, amount: 699, status: "refunded", currency: "INR", razorpayOrderId: "order_demo_1003", razorpayPaymentId: "pay_demo_1003" }
  ]);

  await SupportTicket.create([
    {
      ticketCode: "TCK-DEMO-2001",
      userId: users[0]._id,
      bookingId: bookings[0]._id,
      bookingCode: bookings[0].bookingCode,
      userName: users[0].name,
      mobileNumber: users[0].phone,
      email: users[0].email,
      category: "payments",
      priority: "high",
      status: "open",
      source: "ai_support",
      complaint: "Payment was deducted but confirmation took too long.",
      aiSummary: "Customer reports delayed payment confirmation for a completed electrical booking.",
      conversation: [
        { clientMessageId: "demo-user-msg-1", senderRole: "user", senderName: users[0].name, message: "Payment deduct ho gaya but confirmation nahi aaya.", createdAt: ago(3) },
        { clientMessageId: "demo-ai-msg-1", senderRole: "ai", senderName: "ApnaServo AI Support", message: "I created a high-priority payment ticket for the support team.", createdAt: ago(2.9) }
      ],
      timeline: [{ event: "ticket_created", by: "ai_support", note: "Created from User App", at: ago(3) }],
      lastUpdatedAt: ago(2.9)
    },
    {
      ticketCode: "TCK-DEMO-2002",
      userId: users[1]._id,
      bookingId: bookings[2]._id,
      bookingCode: bookings[2].bookingCode,
      userName: users[1].name,
      mobileNumber: users[1].phone,
      email: users[1].email,
      category: "bookings",
      priority: "medium",
      status: "resolved",
      source: "customer_support",
      complaint: "Cancellation refund status required.",
      aiSummary: "Customer requested the refund status for a cancelled AC booking.",
      resolutionNotes: "Refund processed to original payment method.",
      timeline: [
        { event: "ticket_created", by: "customer_support", note: "Refund status", at: ago(60) },
        { event: "resolved", by: "admin", note: "Refund completed", at: ago(40) }
      ],
      lastUpdatedAt: ago(40),
      resolvedAt: ago(40)
    }
  ]);

  console.log("Admin demo data seeded");
}

module.exports = seedAdminDemo;
