const { getPublishedConfig } = require("./appControl");

function distanceKm(lat1, lng1, lat2, lng2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthKm = 6371.0088;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pincodeFromAddress(value) {
  return String(value || "").match(/\b(\d{6})\b/)?.[1] || "";
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && !(latitude === 0 && longitude === 0);
}

async function activeServiceAreas() {
  const { config } = await getPublishedConfig({ app: "customer", platform: "android" });
  return (config.serviceAreas || []).filter((area) => area.enabled);
}

function validateAgainstAreas(lat, lng, areas) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!validCoordinates(latitude, longitude)) {
    return { allowed: false, code: "SERVICE_AREA_LOCATION_REQUIRED", reason: "invalid_coordinates" };
  }
  const candidates = (areas || []).map((area) => ({ area, distanceKm: distanceKm(latitude, longitude, area.centerLat, area.centerLng) }));
  const match = candidates.find((entry) => entry.distanceKm <= entry.area.radiusKm);
  if (match) return { allowed: true, code: "SERVICE_AREA_AVAILABLE", reason: "inside_boundary", distanceKm: match.distanceKm, area: match.area };
  return { allowed: false, code: "SERVICE_AREA_UNAVAILABLE", reason: "outside_boundary", nearestArea: candidates.sort((a, b) => a.distanceKm - b.distanceKm)[0]?.area || null };
}

async function validateServiceArea(lat, lng) {
  return validateAgainstAreas(lat, lng, await activeServiceAreas());
}

module.exports = { activeServiceAreas, validateServiceArea, validateAgainstAreas, distanceKm, pincodeFromAddress };
