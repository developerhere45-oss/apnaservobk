const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.IDENTITY_HASH_PEPPER = "laundry-workflow-audit-pepper";

const Partner = require("../src/models/Partner");
const { Booking } = require("../src/models/Booking");
const controller = require("../src/controllers/partnerController");

function identityHash(value) {
  return crypto
    .createHmac("sha256", process.env.IDENTITY_HASH_PEPPER)
    .update(String(value || "").trim().toLowerCase())
    .digest("hex");
}

function invoke(handler, request) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const response = {
      status(code) {
        status = code;
        return this;
      },
      json(payload) {
        resolve({ status, payload });
        return this;
      }
    };
    Promise.resolve(handler(request, response, reject)).catch(reject);
  });
}

async function main() {
  const server = await MongoMemoryServer.create();
  try {
    await mongoose.connect(server.getUri(), { dbName: "apnaservo-laundry-workflow-audit" });
    const staffPhone = "9876543211";
    const owner = await Partner.create({
      firebaseUid: "laundry-owner-audit",
      partnerCode: `LAUNDRY-${Date.now()}`,
      name: "Audit Laundry Owner",
      phone: "9876543210",
      serviceCategory: ["laundry"],
      businessType: "laundry",
      businessVerificationStatus: "approved",
      isVerified: true,
      kycStatus: "verified",
      trustStatus: "trusted",
      accountStatus: "active",
      laundryBusiness: {
        shopName: "Audit Laundry",
        shopLicenseNumber: "AUDIT-LIC-1",
        shopLocation: "Guwahati, Assam",
        ownerName: "Audit Owner",
        ownerPhone: "9876543210",
        staffMembers: [{
          sequence: 1,
          name: "Audit Staff",
          phone: staffPhone,
          phoneHash: identityHash(staffPhone),
          role: "Washer Staff",
          verificationStatus: "verified"
        }]
      }
    });
    const booking = await Booking.create({
      bookingCode: `LND-AUDIT-${Date.now()}`,
      userId: new mongoose.Types.ObjectId(),
      partnerId: owner._id,
      serviceCategory: "laundry",
      serviceName: "Wash and Fold",
      address: "Guwahati, Assam",
      status: "accepted"
    });

    const staffAuth = {
      uid: "laundry-staff-audit",
      phone_number: `+91${staffPhone}`
    };
    const session = await invoke(controller.staffSession, {
      auth: staffAuth,
      body: { isOnline: true }
    });
    assert.equal(session.status, 200);
    assert.equal(session.payload.sessionRole, "laundry_staff");
    assert.equal(session.payload.staff.verificationStatus, "verified");

    const assignment = await invoke(controller.assignLaundryStaff, {
      auth: { uid: owner.firebaseUid },
      params: { bookingId: booking.bookingCode },
      body: { staffSequence: 1 }
    });
    assert.equal(assignment.status, 200);
    assert.equal(assignment.payload.booking.laundryAssignment.taskStatus, "assigned");

    const jobs = await invoke(controller.listStaffBookings, {
      auth: staffAuth,
      body: {}
    });
    assert.equal(jobs.status, 200);
    assert.equal(jobs.payload.bookings.length, 1);
    assert.equal(jobs.payload.bookings[0].bookingCode, booking.bookingCode);

    const started = await invoke(controller.updateStaffBookingStatus, {
      auth: staffAuth,
      params: { bookingId: booking.bookingCode },
      body: { status: "in_progress" }
    });
    assert.equal(started.status, 200);
    assert.equal(started.payload.booking.laundryAssignment.taskStatus, "in_progress");

    const completed = await invoke(controller.updateStaffBookingStatus, {
      auth: staffAuth,
      params: { bookingId: booking.bookingCode },
      body: { status: "completed" }
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.payload.booking.laundryAssignment.taskStatus, "completed");

    const stored = await Booking.findById(booking._id).lean();
    assert.equal(stored.status, "accepted", "Staff task updates must not bypass the customer booking lifecycle");
    assert.ok(stored.laundryAssignment.startedAt);
    assert.ok(stored.laundryAssignment.completedAt);

    const reassignment = await invoke(controller.assignLaundryStaff, {
      auth: { uid: owner.firebaseUid },
      params: { bookingId: booking.bookingCode },
      body: { staffSequence: 1 }
    });
    assert.equal(reassignment.status, 409);
    console.log("PASS Laundry owner/staff verification, assignment and task lifecycle audit");
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(`FAIL Laundry workflow audit - ${error.stack || error.message}`);
  process.exit(1);
});
