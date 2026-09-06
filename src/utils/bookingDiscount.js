const DiscountRule = require("../models/DiscountRule");
const { Booking } = require("../models/Booking");

async function bestDiscountForBooking(booking, grossAmount, now = new Date()) {
  const amount = Math.max(0, Math.round(Number(grossAmount || 0)));
  if (!booking || amount <= 0) return { amount: 0, rule: null };
  const priorBookings = await Booking.countDocuments({
    userId: booking.userId,
    _id: { $ne: booking._id },
    status: { $nin: ["cancelled"] }
  });
  const rules = await DiscountRule.find({
    active: true,
    serviceCategory: { $in: [String(booking.serviceCategory || "").toLowerCase(), "all"] },
    minimumAmount: { $lte: amount },
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }
    ]
  }).lean();
  let best = { amount: 0, rule: null };
  for (const rule of rules) {
    if (rule.audience === "individual" && (!rule.targetUserId || String(rule.targetUserId) !== String(booking.userId))) continue;
    if (!["all", "new_users", "individual"].includes(rule.audience)) continue;
    if (rule.audience === "new_users" && priorBookings > 0) continue;
    let discount = rule.discountType === "percent" ? amount * Number(rule.value || 0) / 100 : Number(rule.value || 0);
    if (rule.maxDiscount > 0) discount = Math.min(discount, rule.maxDiscount);
    // Existing mobile clients require a positive payable finalAmount. Keep the
    // server-driven offer backward compatible without forcing an app update.
    discount = Math.min(Math.max(0, amount - 1), Math.max(0, Math.round(discount)));
    if (discount > best.amount) best = { amount: discount, rule };
  }
  return best;
}

module.exports = { bestDiscountForBooking };
