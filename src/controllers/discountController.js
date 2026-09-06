const User = require("../models/User");
const DiscountRule = require("../models/DiscountRule");
const { Booking } = require("../models/Booking");
const mongoose = require("mongoose");
const { emitBookingStatusUpdate, emitAdminEvent, serializeBooking } = require("../sockets/bookingSocket");
const id = value => value ? String(value) : "";
const money = value => Number(value || 0);
const iso = value => value ? new Date(value).toISOString() : "";
function serializeDiscountRule(rule) {
  return {
    id: id(rule._id), name: rule.name, serviceCategory: rule.serviceCategory,
    targetUserId: id(rule.targetUserId),
    audience: rule.audience, discountType: rule.discountType, value: money(rule.value),
    maxDiscount: money(rule.maxDiscount), minimumAmount: money(rule.minimumAmount),
    active: rule.active !== false, startsAt: iso(rule.startsAt), endsAt: iso(rule.endsAt),
    createdAt: iso(rule.createdAt), updatedAt: iso(rule.updatedAt)
  };
}

async function discountRuleInput(body) {
  const input = body && typeof body === "object" ? body : {};
  const name = String(input.name || "").trim().slice(0, 100);
  const serviceCategory = String(input.serviceCategory || "all").trim().toLowerCase().slice(0, 80);
  const audience = input.audience || "new_users";
  if (!["all", "new_users", "individual"].includes(audience)) throw Object.assign(new Error("Invalid discount audience"), { status: 400 });
  let targetUserId = null;
  if (audience === "individual") {
    const reference = String(input.targetUserId || "").trim();
    if (!reference || reference.length > 100) throw Object.assign(new Error("User ID is required for an individual offer"), { status: 400 });
    const filter = /^[a-f0-9]{24}$/i.test(reference) ? { _id: reference } : { publicId: reference };
    const target = await User.findOne(filter).select("_id");
    if (!target) throw Object.assign(new Error("User not found. Copy the User ID from Users."), { status: 400 });
    targetUserId = target._id;
  }
  const discountType = ["fixed", "percent"].includes(input.discountType) ? input.discountType : "fixed";
  const value = Number(input.value);
  const maxDiscount = Math.max(0, Number(input.maxDiscount || 0));
  const minimumAmount = Math.max(0, Number(input.minimumAmount || 0));
  if (name.length < 2) throw Object.assign(new Error("Discount name is required"), { status: 400 });
  if (!serviceCategory) throw Object.assign(new Error("Service category is required"), { status: 400 });
  if (!Number.isFinite(value) || value <= 0 || (discountType === "percent" && value > 100)) throw Object.assign(new Error("Enter a valid discount value"), { status: 400 });
  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime())) || (startsAt && endsAt && endsAt <= startsAt)) throw Object.assign(new Error("Invalid discount validity dates"), { status: 400 });
  return { name, serviceCategory, audience, targetUserId, discountType, value, maxDiscount, minimumAmount, active: input.active !== false, startsAt, endsAt };
}

async function listDiscountRules(req, res, next) {
  try { const rules = await DiscountRule.find().sort({ createdAt: -1 }); return res.json({ rules: rules.map(serializeDiscountRule) }); } catch (error) { return next(error); }
}

async function createDiscountRule(req, res, next) {
  try { const rule = await DiscountRule.create({ ...await discountRuleInput(req.body), createdBy: req.auth.email || req.auth.uid || "admin" }); return res.status(201).json({ rule: serializeDiscountRule(rule) }); } catch (error) { return next(error); }
}

async function updateDiscountRule(req, res, next) {
  try {
    const rule = await DiscountRule.findByIdAndUpdate(req.params.ruleId, { $set: await discountRuleInput(req.body) }, { new: true, runValidators: true });
    if (!rule) return res.status(404).json({ message: "Discount rule not found" });
    return res.json({ rule: serializeDiscountRule(rule) });
  } catch (error) { return next(error); }
}

async function deleteDiscountRule(req, res, next) {
  try { const rule = await DiscountRule.findByIdAndDelete(req.params.ruleId); if (!rule) return res.status(404).json({ message: "Discount rule not found" }); return res.json({ ok: true }); } catch (error) { return next(error); }
}

async function setDiscountRuleStatus(req, res, next) {
  try {
    if (typeof req.body?.active !== "boolean") return res.status(400).json({ message: "Discount status must be true or false" });
    const rule = await DiscountRule.findByIdAndUpdate(req.params.ruleId, { $set: { active: req.body.active } }, { new: true });
    if (!rule) return res.status(404).json({ message: "Discount rule not found" });
    return res.json({ rule: serializeDiscountRule(rule) });
  } catch (error) { return next(error); }
}

function bookingIdFilter(reference) {
  const raw = String(reference || "").trim();
  const upper = raw.toUpperCase();
  const matches = [{ bookingId: upper }, { bookingCode: raw }, { publicId: upper }];
  if (mongoose.Types.ObjectId.isValid(raw)) matches.unshift({ _id: new mongoose.Types.ObjectId(raw) });
  return { $or: matches };
}

async function applyBookingDiscount(req, res, next) {
  try {
    const input = req.body && typeof req.body === "object" ? req.body : {};
    const reference = String(input.bookingId || "").trim();
    const requestedAmount = Math.round(Number(input.amount));
    const reason = String(input.reason || "").trim().slice(0, 300);
    if (!reference || reference.length > 100) return res.status(400).json({ message: "Enter a valid booking ID" });
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > 1000000) {
      return res.status(400).json({ message: "Enter a valid discount amount" });
    }

    const booking = await Booking.findOne(bookingIdFilter(reference));
    if (!booking) return res.status(404).json({ message: "Booking not found. Check the booking ID and try again." });
    if (booking.paymentStatus === "paid" || booking.status === "completed") {
      return res.status(409).json({ message: "Paid or completed bookings need a refund or credit note; their invoice cannot be changed here." });
    }
    if (booking.quoteStatus === "payment_submitted") {
      return res.status(409).json({ message: "Payment confirmation is already pending for this booking. Verify or reject that payment first." });
    }

    const now = new Date();
    booking.adminDiscount = {
      amount: requestedAmount,
      reason,
      appliedBy: req.auth?.email || req.auth?.uid || "admin",
      appliedAt: now
    };

    const grossAmount = Math.round(Number(booking.grossAmount || booking.finalAmount || booking.quoteAmount || booking.price || 0));
    const appliesNow = booking.status === "amount_pending" && booking.quoteStatus === "pending" && grossAmount > 0;
    if (appliesNow) {
      const effectiveAmount = Math.min(Math.max(0, grossAmount - 1), requestedAmount);
      booking.grossAmount = grossAmount;
      booking.finalAmount = grossAmount - effectiveAmount;
      booking.quoteAmount = grossAmount - effectiveAmount;
      booking.discount = {
        ruleId: null,
        name: reason || "Admin booking discount",
        type: "fixed",
        value: requestedAmount,
        amount: effectiveAmount,
        appliedAt: now
      };
      booking.quoteHistory.push({
        kind: "admin_discount",
        amount: -effectiveAmount,
        by: "admin",
        message: `Admin applied a Rs ${effectiveAmount} booking discount`,
        at: now
      });
    }

    await booking.save();
    const payload = serializeBooking(booking);
    emitBookingStatusUpdate(booking);
    emitAdminEvent("booking:discount_applied", payload);
    return res.json({ booking: payload, appliedNow: appliesNow });
  } catch (error) { return next(error); }
}

module.exports = { listDiscountRules, createDiscountRule, updateDiscountRule, deleteDiscountRule, setDiscountRuleStatus, applyBookingDiscount };
