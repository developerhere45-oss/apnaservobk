const Partner = require("../models/Partner");
const { normalizeServiceCategory } = require("./serviceCategory");

const EARTH_RADIUS_M = 6378137;

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function distanceMeters(latA, lngA, latB, lngB) {
  const toRad = (degree) => (degree * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findNearbyPartners({ serviceCategory, city, lat, lng, radiusKm }) {
  const category = normalizeServiceCategory(serviceCategory);
  const latitude = safeNumber(lat, 26.1445);
  const longitude = safeNumber(lng, 91.7362);
  const maxDistance = safeNumber(radiusKm, Number(process.env.DEFAULT_PARTNER_RADIUS_KM || 25)) * 1000;

  let partners = [];
  try {
    partners = await Partner.find({
      serviceCategory: category,
      isOnline: true,
      isVerified: true,
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [longitude, latitude] },
          $maxDistance: maxDistance
        }
      }
    }).limit(30);
  } catch (error) {
    partners = await Partner.find({
      serviceCategory: category,
      isOnline: true,
      isVerified: true,
      city: new RegExp(city || "Guwahati", "i")
    }).limit(30);
  }

  return partners
    .map((partner) => ({
      partner,
      distanceMeters: distanceMeters(
        latitude,
        longitude,
        partner.location.coordinates[1] || latitude,
        partner.location.coordinates[0] || longitude
      )
    }))
    .filter((entry) => entry.distanceMeters <= Math.max(maxDistance, (entry.partner.serviceRadiusKm || 25) * 1000))
    .sort((left, right) => left.distanceMeters - right.distanceMeters)
    .map((entry) => entry.partner);
}

module.exports = findNearbyPartners;
