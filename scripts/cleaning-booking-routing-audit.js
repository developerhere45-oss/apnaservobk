const assert = require("node:assert/strict");
const Partner = require("../src/models/Partner");
const findNearbyPartners = require("../src/utils/findNearbyPartners");

async function run() {
  const originalFind = Partner.find;
  let capturedFilter;
  try {
    Partner.find = async (filter) => {
      capturedFilter = filter;
      return [{
        _id: "cleaning-company-audit",
        businessType: "laundry",
        serviceCategory: ["cleaning"],
        serviceRadiusKm: 8,
        location: { type: "Point", coordinates: [91.7362, 26.1445] }
      }];
    };

    const result = await findNearbyPartners.withMetadata({
      serviceCategory: "cleaning",
      lat: 26.1445,
      lng: 91.7362
    });

    assert.equal(result.partners.length, 1, "cleaning company must receive a nearby cleaning booking");
    assert.equal(capturedFilter.isOnline, true, "only explicitly online partners may receive a booking");
    assert.equal(capturedFilter.accountStatus, "active", "inactive partner accounts must be excluded");
    assert.equal(capturedFilter.isVerified, true, "unverified partners must be excluded");
    assert.equal(capturedFilter.kycStatus, "verified", "KYC must be verified before dispatch");
    assert.equal(capturedFilter.trustStatus, "trusted", "untrusted partners must be excluded");
    assert.deepEqual(
      capturedFilter.serviceCategory.$in.sort(),
      ["cleaning", "cleaning_services", "home_cleaning"].sort(),
      "cleaning routing must remain isolated from laundry and other services"
    );
    console.log("Cleaning booking routing audit passed");
  } finally {
    Partner.find = originalFind;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
