const Partner = require("../models/Partner");
const { normalizeServiceCategory, serviceCategoryVariants } = require("./serviceCategory");

const EARTH_RADIUS_M = 6378137;
const DEFAULT_RADIUS_STEPS_KM = [5, 10];

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validCoordinates(lat, lng) {
  if (lat === null || lat === undefined || lat === "" || lng === null || lng === undefined || lng === "") {
    return false;
  }
  const latitude = Number(lat);
  const longitude = Number(lng);
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180
    && !(latitude === 0 && longitude === 0);
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

function radiusStepsKm(radiusKm) {
  if (Number.isFinite(Number(radiusKm)) && Number(radiusKm) > 0) {
    return [Number(radiusKm)];
  }
  const configured = String(process.env.PARTNER_SEARCH_RADIUS_STEPS_KM || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 250);
  const steps = configured.length ? configured : DEFAULT_RADIUS_STEPS_KM;
  return [...new Set(steps)].sort((left, right) => left - right);
}

function excludedPartnerIds(values = []) {
  return new Set((values || []).map((value) => String(value || "")).filter(Boolean));
}

function approvalFilter(categories, excludedIds, category = "") {
  const filter = {
    ...(category === "cleaning"
      ? { $or: [{ serviceCategory: { $in: categories } }, { businessType: "laundry", businessVerificationStatus: "approved" }] }
      : { serviceCategory: { $in: categories } }),
    isOnline: true,
    accountStatus: "active",
    isVerified: true,
    kycStatus: "verified",
    trustStatus: "trusted"
  };
  if (excludedIds.size) {
    filter._id = { $nin: [...excludedIds] };
  }
  return filter;
}

function partnerDistance(partner, latitude, longitude) {
  const coordinates = partner?.location?.coordinates;
  if (!Array.isArray(coordinates) || !validCoordinates(coordinates[1], coordinates[0])) {
    return Number.POSITIVE_INFINITY;
  }
  return distanceMeters(latitude, longitude, Number(coordinates[1]), Number(coordinates[0]));
}

function partnersWithinRadius(partners, latitude, longitude, radiusKm) {
  const stageRadiusM = radiusKm * 1000;
  return (partners || [])
    .map((partner) => ({ partner, distanceMeters: partnerDistance(partner, latitude, longitude) }))
    .filter((entry) => {
      const configuredServiceRadiusKm = safeNumber(entry.partner?.serviceRadiusKm, radiusKm);
      const serviceRadiusM = Math.max(1, configuredServiceRadiusKm) * 1000;
      return entry.distanceMeters <= stageRadiusM && entry.distanceMeters <= serviceRadiusM;
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
}

async function geoCandidates(filter, latitude, longitude, radiusKm) {
  const maxDistance = radiusKm * 1000;
  try {
    return await Partner.find({
      ...filter,
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [longitude, latitude] },
          $maxDistance: maxDistance
        }
      }
    }).limit(100);
  } catch (error) {
    // A manual distance pass keeps matching correct while a missing geo index is repaired.
    return Partner.find(filter).limit(500);
  }
}

async function findNearbyPartnersWithMeta({ serviceCategory, city, lat, lng, radiusKm, excludePartnerIds = [] }) {
  const category = normalizeServiceCategory(serviceCategory);
  const categories = serviceCategoryVariants(category);
  const excludedIds = excludedPartnerIds(excludePartnerIds);
  const filter = approvalFilter(categories, excludedIds, category);

  if (validCoordinates(lat, lng)) {
    const latitude = Number(lat);
    const longitude = Number(lng);
    const steps = radiusStepsKm(radiusKm);
    for (const stepKm of steps) {
      const candidates = await geoCandidates(filter, latitude, longitude, stepKm);
      const matches = partnersWithinRadius(candidates, latitude, longitude, stepKm);
      if (matches.length) {
        return {
          partners: matches.map((entry) => entry.partner),
          radiusKm: stepKm,
          mode: "customer_location",
          distancesMeters: Object.fromEntries(matches.map((entry) => [String(entry.partner._id), Math.round(entry.distanceMeters)]))
        };
      }
    }
    return { partners: [], radiusKm: steps[steps.length - 1] || 10, mode: "customer_location", distancesMeters: {} };
  }

  const cityPattern = String(city || "Guwahati").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const partners = await Partner.find({ ...filter, city: new RegExp(cityPattern, "i") }).limit(100);
  return { partners, radiusKm: 0, mode: "city_fallback", distancesMeters: {} };
}

async function findNearbyPartners(options) {
  const result = await findNearbyPartnersWithMeta(options);
  return result.partners;
}

findNearbyPartners.withMetadata = findNearbyPartnersWithMeta;
findNearbyPartners.distanceMeters = distanceMeters;
findNearbyPartners.validCoordinates = validCoordinates;
findNearbyPartners.radiusStepsKm = radiusStepsKm;
findNearbyPartners.partnersWithinRadius = partnersWithinRadius;

module.exports = findNearbyPartners;
