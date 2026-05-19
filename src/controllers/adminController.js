const User = require("../models/User");
const Partner = require("../models/Partner");
const { Booking } = require("../models/Booking");

async function dashboard(req, res, next) {
  try {
    const [users, partners, bookings, pendingBookings] = await Promise.all([
      User.countDocuments(),
      Partner.countDocuments(),
      Booking.countDocuments(),
      Booking.countDocuments({ status: { $in: ["pending", "sent_to_partner"] } })
    ]);

    return res.json({
      users,
      partners,
      bookings,
      pendingBookings
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  dashboard
};
