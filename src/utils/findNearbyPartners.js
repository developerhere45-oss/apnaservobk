const Partner = require("../models/Partner");
const { normalizeServiceCategory, serviceCategoryVariants, partnerCanServeService } = require("./serviceCategory");
const { validateServiceArea } = require("./serviceArea");

const EARTH_RADIUS_M = 6378137;
const DEFAULT_RADIUS_STEPS_KM = [5, 8];
const GUWAHATI_FALLBACK_RADIUS_KM = 35;

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
  return DEFAULT_RADIUS_STEPS_KM;
}

function excludedPartnerIds(values = []) {
  return new Set((values || []).map((value) => String(value || "")).filter(Boolean));
}

function approvalFilter(categories, excludedIds) {
  const filter = {
    // Every service is isolated. A verified company is never a fallback for
    // another category (the former Cleaning->all companies fallback caused
    // laundry staff to receive cleaning work).
    serviceCategory: { $in: categories },
    isOnline: true,
    accountStatus: "active",
    isVerified: true,
    kycStatus: "verified",
    trustStatus: "trusted",
    // A partner explicitly marked online can still miss a GPS heartbeat when
    // Android pauses the socket/background location task. Keep the last valid
    // stored GeoJSON point as a dispatch fallback so requests do not silently
    // disappear. Suspicious locations remain excluded and the normal 8 km
    // distance/service-radius checks below still apply.
    locationTrustStatus: { $ne: "suspicious" }
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
      const configuredServiceRadiusKm = Math.min(8, safeNumber(entry.partner?.serviceRadiusKm, 8));
      const serviceRadiusM = Math.max(1, configuredServiceRadiusKm) * 1000;
      return entry.distanceMeters <= stageRadiusM && entry.distanceMeters <= serviceRadiusM;
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
}

function partnersForRequestedService(partners, serviceCategory) {
  return (partners || []).filter((partner) => partnerCanServeService(partner, serviceCategory));
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
    });
  } catch (error) {
    // A manual distance pass keeps matching correct while a missing geo index is repaired.
    return Partner.find(filter);
  }
}

async function findNearbyPartnersWithMeta({ serviceCategory, city, lat, lng, radiusKm, excludePartnerIds = [] }) {
  const category = normalizeServiceCategory(serviceCategory);
  const categories = serviceCategoryVariants(category);
  const excludedIds = excludedPartnerIds(excludePartnerIds);
  const filter = approvalFilter(categories, excludedIds);

  if (validCoordinates(lat, lng)) {
    const latitude = Number(lat);
    const longitude = Number(lng);
    const steps = radiusStepsKm(radiusKm);
    for (const stepKm of steps) {
      const candidates = partnersForRequestedService(await geoCandidates(filter, latitude, longitude, stepKm), category);
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
    // Android partners can be online and approved but farther than the fast
    // 5/8 km rings. Keep nearby partners first, then fan out the request to
    // eligible same-service partners inside the supported Guwahati area so a
    // valid customer booking never disappears without reaching the app.
    const cityCandidates = partnersForRequestedService(
      await Partner.find(filter).limit(250),
      category
    );
    const cityMatches = cityCandidates
      .map((partner) => ({ partner, distanceMeters: partnerDistance(partner, latitude, longitude) }))
      .filter((entry) => {
        const coordinates = entry.partner?.location?.coordinates;
        return Array.isArray(coordinates)
          && validateServiceArea(coordinates[1], coordinates[0]).allowed;
      })
      .sort((left, right) => left.distanceMeters - right.distanceMeters);
    if (cityMatches.length) {
      return {
        partners: cityMatches.map((entry) => entry.partner),
        radiusKm: GUWAHATI_FALLBACK_RADIUS_KM,
        mode: "guwahati_service_area_fallback",
        distancesMeters: Object.fromEntries(cityMatches.map((entry) => [String(entry.partner._id), Math.round(entry.distanceMeters)]))
      };
    }
    return { partners: [], radiusKm: GUWAHATI_FALLBACK_RADIUS_KM, mode: "customer_location", distancesMeters: {} };
  }

  return { partners: [], radiusKm: 10, mode: "location_required", distancesMeters: {} };
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
