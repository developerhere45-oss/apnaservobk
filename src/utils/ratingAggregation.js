const mongoose = require("mongoose");
const Partner = require("../models/Partner");
const Review = require("../models/Review");

async function recomputePartnerRating(partnerId) {
  if (!partnerId) {
    return null;
  }

  const [summary] = await Review.aggregate([
    {
      $match: {
        partnerId: new mongoose.Types.ObjectId(String(partnerId)),
        status: "published"
      }
    },
    {
      $group: {
        _id: "$partnerId",
        average: { $avg: "$rating" },
        count: { $sum: 1 }
      }
    }
  ]);

  const ratingCount = Number(summary?.count || 0);
  const rating = ratingCount > 0
    ? Math.round(Number(summary.average || 0) * 10) / 10
    : 4.8;

  await Partner.findByIdAndUpdate(partnerId, {
    $set: { rating, ratingCount }
  });

  return { rating, ratingCount };
}

module.exports = {
  recomputePartnerRating
};
