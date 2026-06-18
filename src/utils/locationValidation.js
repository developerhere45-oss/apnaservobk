function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function distanceMeters(latA, lngA, latB, lngB) {
  const radius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bookingCoordinates(booking) {
  const coordinates = booking?.location?.coordinates || [];
  const lng = numberValue(coordinates[0]);
  const lat = numberValue(coordinates[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function validatePartnerLocation({ partner, booking, payload = {}, requireNearCustomer = false }) {
  const lat = numberValue(payload.lat);
  const lng = numberValue(payload.lng);
  const accuracy = Number.isFinite(numberValue(payload.accuracy)) ? numberValue(payload.accuracy) : 9999;
  const provider = String(payload.provider || "").toLowerCase();
  const isMock = payload.isMock === true || payload.isMock === "true";
  const recordedAt = payload.recordedAt ? new Date(payload.recordedAt) : new Date();

  const result = {
    valid: false,
    reason: "",
    lat,
    lng,
    accuracy,
    provider,
    isMock,
    recordedAt: Number.isNaN(recordedAt.getTime()) ? new Date() : recordedAt,
    speedMps: 0,
    distanceToCustomerM: 0
  };

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    result.reason = "Valid GPS location required";
    return result;
  }
  if (isMock || provider.includes("mock")) {
    result.reason = "Mock/fake location detected";
    return result;
  }
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 150) {
    result.reason = "GPS accuracy too low. Move to open area and try again";
    return result;
  }
  const ageMs = Date.now() - result.recordedAt.getTime();
  if (ageMs > 2 * 60 * 1000 || ageMs < -60 * 1000) {
    result.reason = "Fresh live GPS location required";
    return result;
  }

  const previous = partner?.location?.coordinates || [];
  const previousLng = numberValue(previous[0]);
  const previousLat = numberValue(previous[1]);
  const previousAt = partner?.lastLocationAt ? new Date(partner.lastLocationAt) : null;
  if (Number.isFinite(previousLat) && Number.isFinite(previousLng) && previousAt && !Number.isNaN(previousAt.getTime())) {
    const seconds = Math.max(1, (result.recordedAt.getTime() - previousAt.getTime()) / 1000);
    const meters = distanceMeters(previousLat, previousLng, lat, lng);
    result.speedMps = meters / seconds;
    if (seconds > 5 && result.speedMps > 60) {
      result.reason = "Impossible location jump detected";
      return result;
    }
  }

  const customer = bookingCoordinates(booking);
  if (customer) {
    result.distanceToCustomerM = distanceMeters(lat, lng, customer.lat, customer.lng);
    if (requireNearCustomer && result.distanceToCustomerM > 900) {
      result.reason = "You are not near customer location yet";
      return result;
    }
  }

  result.valid = true;
  result.reason = "accepted";
  return result;
}

function partnerLocationUpdate(validation) {
  return {
    location: { type: "Point", coordinates: [validation.lng, validation.lat] },
    lastLocationAt: validation.recordedAt,
    lastLocationAccuracy: validation.accuracy,
    lastLocationProvider: validation.provider,
    locationTrustStatus: "trusted"
  };
}

module.exports = {
  distanceMeters,
  validatePartnerLocation,
  partnerLocationUpdate
};
