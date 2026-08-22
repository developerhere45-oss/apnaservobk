const { z } = require("zod");
const ServiceChecklistConfig = require("../models/ServiceChecklistConfig");
const { Booking } = require("../models/Booking");
const { canonicalCategory, defaultConfig, slug } = require("../utils/serviceChecklist");

const configSchema = z.object({
  serviceLabel: z.string().trim().min(2).max(80),
  descriptionExample: z.string().trim().min(3).max(240),
  enabled: z.boolean().optional().default(true),
  tasks: z.array(z.object({
    taskId: z.string().trim().max(160).optional(),
    name: z.string().trim().min(2).max(140),
    enabled: z.boolean().optional().default(true),
    order: z.coerce.number().int().min(0).max(1000).optional()
  })).min(1).max(40)
});

async function list(req, res, next) {
  try {
    const stored = await ServiceChecklistConfig.find({}).sort({ serviceLabel: 1 }).lean();
    const map = new Map(stored.map((item) => [item.serviceCategory, item]));
    for (const category of ["ac_repair", "plumbing", "electrician", "carpenter", "ro_service", "appliance_repair"]) {
      if (!map.has(category)) map.set(category, defaultConfig(category));
    }
    return res.json({ checklists: [...map.values()] });
  } catch (error) { return next(error); }
}

async function save(req, res, next) {
  try {
    const body = configSchema.parse(req.body || {});
    const serviceCategory = canonicalCategory(req.params.serviceCategory);
    const existing = await ServiceChecklistConfig.findOne({ serviceCategory }).lean();
    const tasks = body.tasks.map((task, index) => ({
      taskId: task.taskId || `${serviceCategory}_${slug(task.name)}`,
      name: task.name,
      enabled: task.enabled,
      order: task.order ?? index
    }));
    const checklist = await ServiceChecklistConfig.findOneAndUpdate(
      { serviceCategory },
      { $set: { serviceCategory, serviceLabel: body.serviceLabel, descriptionExample: body.descriptionExample, enabled: body.enabled, tasks, version: Number(existing?.version || 0) + 1 } },
      { new: true, upsert: true, runValidators: true }
    );
    return res.json({ checklist });
  } catch (error) { return next(error); }
}

async function reports(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(10, Number(req.query.limit || 25)));
    const query = { "serviceWorkDetails.submittedAt": { $ne: null } };
    if (req.query.serviceCategory) query.serviceCategory = canonicalCategory(req.query.serviceCategory);
    if (req.query.status) query.status = String(req.query.status);
    if (req.query.from || req.query.to) {
      query["serviceWorkDetails.submittedAt"] = {};
      if (req.query.from) query["serviceWorkDetails.submittedAt"].$gte = new Date(req.query.from);
      if (req.query.to) query["serviceWorkDetails.submittedAt"].$lte = new Date(req.query.to);
    }
    const [rows, total] = await Promise.all([
      Booking.find(query).sort({ "serviceWorkDetails.submittedAt": -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Booking.countDocuments(query)
    ]);
    return res.json({
      rows: rows.map((booking) => ({
        bookingId: booking.bookingId || booking.bookingCode,
        internalId: String(booking._id),
        partnerId: booking.partnerId ? String(booking.partnerId) : "",
        partnerName: booking.partnerSnapshot?.name || "",
        serviceCategory: booking.serviceCategory,
        serviceName: booking.serviceName,
        quoteAmount: Number(booking.quoteAmount || booking.finalAmount || 0),
        status: booking.status,
        quoteStatus: booking.quoteStatus,
        workDetails: booking.serviceWorkDetails,
        submittedAt: booking.serviceWorkDetails?.submittedAt || null
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) { return next(error); }
}

module.exports = { list, save, reports };
