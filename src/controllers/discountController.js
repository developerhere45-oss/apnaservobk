const User = require("../models/User");
const DiscountRule = require("../models/DiscountRule");
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
module.exports = { listDiscountRules, createDiscountRule, updateDiscountRule, deleteDiscountRule };
