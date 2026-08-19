const DEFAULT_CENTER_LAT = 26.1445;
const DEFAULT_CENTER_LNG = 91.7362;
const DEFAULT_RADIUS_KM = 35;

function finiteEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function serviceAreaConfig() {
  return {
    id: "guwahati",
    name: "Guwahati, Assam",
    enabled: String(process.env.GUWAHATI_SERVICE_AREA_ENABLED || "true").toLowerCase() !== "false",
    centerLat: finiteEnv("GUWAHATI_SERVICE_AREA_CENTER_LAT", DEFAULT_CENTER_LAT),
    centerLng: finiteEnv("GUWAHATI_SERVICE_AREA_CENTER_LNG", DEFAULT_CENTER_LNG),
    radiusKm: Math.max(1, finiteEnv("GUWAHATI_SERVICE_AREA_RADIUS_KM", DEFAULT_RADIUS_KM))
  };
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthKm = 6371.0088;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateServiceArea(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  const config = serviceAreaConfig();
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180
      || (latitude === 0 && longitude === 0)) {
    return { allowed: false, code: "SERVICE_AREA_LOCATION_REQUIRED", reason: "invalid_coordinates", config };
  }
  if (!config.enabled) return { allowed: false, code: "SERVICE_AREA_UNAVAILABLE", reason: "area_disabled", config };
  const distance = distanceKm(latitude, longitude, config.centerLat, config.centerLng);
  return {
    allowed: distance <= config.radiusKm,
    code: distance <= config.radiusKm ? "SERVICE_AREA_AVAILABLE" : "SERVICE_AREA_UNAVAILABLE",
    reason: distance <= config.radiusKm ? "inside_boundary" : "outside_boundary",
    distanceKm: distance,
    config
  };
}

module.exports = { serviceAreaConfig, validateServiceArea, distanceKm };
