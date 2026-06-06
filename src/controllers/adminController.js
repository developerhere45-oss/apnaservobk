const User = require("../models/User");
const Partner = require("../models/Partner");
const Service = require("../models/Service");
const Payment = require("../models/Payment");
const Review = require("../models/Review");
const { Booking } = require("../models/Booking");

const STATUS_LABELS = {
  pending: "Pending",
  sent_to_partner: "Sent To Partner",
  accepted: "Confirmed",
  on_the_way: "On The Way",
  arrived: "Arrived",
  started: "Work Started",
  amount_pending: "Payment Pending",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Rejected"
};

function formatStatus(status) {
  return STATUS_LABELS[status] || String(status || "Pending");
}

function serviceLabel(category) {
  const map = {
    ac: "AC Repair",
    ac_repair: "AC Repair",
    electrician: "Electrician",
    plumber: "Plumbing",
    plumbing: "Plumbing",
    cleaning: "Home Cleaning",
    pest_control: "Pest Control",
    roadside: "Roadside Assistance",
    carpenter: "Carpenter",
    painting: "Painting",
    interior: "Interior Design"
  };
  return map[category] || category || "Service";
}

function bookingAmount(booking) {
  return Number(booking.finalAmount || booking.price || 0);
}

function bookingRow(booking) {
  return {
    id: booking.bookingCode || `#${String(booking._id).slice(-6).toUpperCase()}`,
    customer: booking.userSnapshot?.name || "Customer",
    service: booking.serviceName || serviceLabel(booking.serviceCategory),
    partner: booking.partnerSnapshot?.name || "Unassigned",
    status: formatStatus(booking.status),
    amount: bookingAmount(booking),
    time: booking.createdAt ? booking.createdAt.toISOString() : "",
    city: booking.city || "Guwahati"
  };
}

function partnerRow(partner) {
  return {
    id: partner.partnerCode || String(partner._id).slice(-8).toUpperCase(),
    name: partner.name,
    phone: partner.phone,
    skills: (partner.serviceCategory || []).map(serviceLabel).join(", "),
    status: partner.isVerified ? "Approved" : "Pending",
    online: partner.isOnline ? "Online" : "Offline",
    rating: Number(partner.rating || 0).toFixed(1),
    jobs: partner.totalJobs || 0,
    earnings: partner.earnings || 0
  };
}

async function dashboard(req, res, next) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 7);

    const [
      users,
      partners,
      activePartners,
      bookings,
      activeBookings,
      completedBookings,
      cancelledBookings,
      pendingVerifications,
      paidPayments,
      recentBookings,
      pendingPartners,
      serviceAgg,
      trendAgg
    ] = await Promise.all([
      User.countDocuments(),
      Partner.countDocuments(),
      Partner.countDocuments({ isOnline: true }),
      Booking.countDocuments(),
      Booking.countDocuments({ status: { $in: ["pending", "sent_to_partner", "accepted", "on_the_way", "arrived", "started"] } }),
      Booking.countDocuments({ status: "completed" }),
      Booking.countDocuments({ status: "cancelled" }),
      Partner.countDocuments({ isVerified: false }),
      Payment.aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Booking.find().sort({ createdAt: -1 }).limit(8).lean(),
      Partner.find({ isVerified: false }).sort({ createdAt: -1 }).limit(5).lean(),
      Booking.aggregate([{ $group: { _id: "$serviceCategory", value: { $sum: 1 } } }, { $sort: { value: -1 } }, { $limit: 7 }]),
      Booking.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%d %b", date: "$createdAt" } }, bookings: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$finalAmount", "$price"] } } } },
        { $sort: { _id: 1 } }
      ])
    ]);

    const revenue = Number(paidPayments[0]?.total || recentBookings.reduce((sum, booking) => sum + bookingAmount(booking), 0));
    const totalCategory = serviceAgg.reduce((sum, item) => sum + item.value, 0) || 1;
    const palette = ["#f92b74", "#8b5cf6", "#22b8cf", "#35d39b", "#f6c85f", "#f59e8b", "#fac8d7"];

    return res.json({
      stats: [
        { label: "Total Users", value: users, delta: "+live", hint: "from MongoDB", icon: "users" },
        { label: "Total Service Partners", value: partners, delta: `${activePartners} online`, hint: "active right now", icon: "partners" },
        { label: "Active Bookings", value: activeBookings, delta: "+live", hint: "open jobs", icon: "calendar" },
        { label: "Completed Bookings", value: completedBookings, delta: "+live", hint: "all time", icon: "check" },
        { label: "Total Revenue", value: revenue, delta: "+live", hint: "paid/quoted total", icon: "rupee", currency: true },
        { label: "Pending Verifications", value: pendingVerifications, delta: cancelledBookings ? `${cancelledBookings} cancelled` : "0 cancelled", hint: "needs review", icon: "hourglass", negative: true }
      ],
      bookingTrend: trendAgg.length
        ? trendAgg.map((item) => ({ day: item._id, bookings: item.bookings, revenue: item.revenue || 0 }))
        : [{ day: "Today", bookings, revenue }],
      categories: serviceAgg.length
        ? serviceAgg.map((item, index) => ({
            name: serviceLabel(item._id),
            value: Math.round((item.value / totalCategory) * 100),
            color: palette[index % palette.length]
          }))
        : [{ name: "No bookings yet", value: 100, color: "#fac8d7" }],
      recentActivity: recentBookings.slice(0, 5).map((booking) => ({
        title: `Booking ${formatStatus(booking.status).toLowerCase()}`,
        note: booking.bookingCode || String(booking._id),
        time: booking.createdAt ? booking.createdAt.toISOString() : "",
        type: booking.status
      })),
      recentBookings: recentBookings.map(bookingRow),
      pendingVerifications: pendingPartners.map((partner) => ({
        name: partner.name,
        skill: (partner.serviceCategory || []).map(serviceLabel).join(", ") || "Service Partner",
        city: partner.serviceArea || partner.city || "Assam",
        applied: partner.createdAt ? new Date(partner.createdAt).toLocaleDateString("en-IN") : "",
        avatar: (partner.name || "AS").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()
      }))
    });
  } catch (error) {
    return next(error);
  }
}

async function resource(req, res, next) {
  try {
    const resourceName = req.params.resource;
    let rows = [];

    if (resourceName === "users") {
      const users = await User.find().sort({ createdAt: -1 }).limit(100).lean();
      const bookingCounts = await Booking.aggregate([{ $group: { _id: "$userId", total: { $sum: 1 } } }]);
      const countMap = new Map(bookingCounts.map((item) => [String(item._id), item.total]));
      rows = users.map((user) => ({
        id: String(user._id).slice(-8).toUpperCase(),
        name: user.name,
        phone: user.phone,
        email: user.email || "-",
        bookings: countMap.get(String(user._id)) || 0,
        status: "Active",
        city: user.city || "Guwahati"
      }));
    } else if (resourceName === "partners") {
      rows = (await Partner.find().sort({ createdAt: -1 }).limit(100).lean()).map(partnerRow);
    } else if (resourceName === "bookings") {
      rows = (await Booking.find().sort({ createdAt: -1 }).limit(100).lean()).map(bookingRow);
    } else if (resourceName === "services") {
      rows = (await Service.find().sort({ createdAt: -1 }).limit(100).lean()).map((service) => ({
        id: service.serviceCategory,
        name: service.name,
        category: service.serviceCategory,
        basePrice: service.basePrice || 0,
        status: service.isActive ? "Active" : "Inactive"
      }));
    } else if (resourceName === "analytics") {
      const reviews = await Review.aggregate([{ $group: { _id: null, avg: { $avg: "$rating" }, total: { $sum: 1 } } }]);
      rows = [
        { id: "REVIEWS", metric: "Average Rating", share: Number(reviews[0]?.avg || 0).toFixed(1), status: `${reviews[0]?.total || 0} reviews` },
        { id: "ACTIVE_PARTNERS", metric: "Online Partners", share: await Partner.countDocuments({ isOnline: true }), status: "Live" },
        { id: "OPEN_BOOKINGS", metric: "Open Bookings", share: await Booking.countDocuments({ status: { $nin: ["completed", "cancelled"] } }), status: "Live" }
      ];
    } else {
      rows = [];
    }

    return res.json({ resource: resourceName, rows });
  } catch (error) {
    return next(error);
  }
}

async function action(req, res, next) {
  try {
    const { action: actionName, targetId, payload = {} } = req.body || {};
    if (!actionName || !targetId) {
      return res.status(400).json({ message: "action and targetId are required" });
    }

    if (actionName === "approve-technician") {
      await Partner.findByIdAndUpdate(targetId, { isVerified: true });
    } else if (actionName === "reject-technician" || actionName === "suspend-technician") {
      await Partner.findByIdAndUpdate(targetId, { isVerified: false, isOnline: false });
    } else if (actionName === "assign-booking") {
      await Booking.findByIdAndUpdate(targetId, { partnerId: payload.partnerId, status: "accepted", acceptedAt: new Date() });
    }

    return res.json({ ok: true, action: actionName, targetId });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  dashboard,
  resource,
  action
};
