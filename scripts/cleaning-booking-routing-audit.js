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
    assert.ok(Array.isArray(capturedFilter.$or), "routing must distinguish mobile heartbeat from fixed companies");
    assert.ok(
      capturedFilter.$or.some((entry) => entry.businessType === "laundry"),
      "verified fixed-location company must not require a five-minute mobile heartbeat"
    );
    assert.deepEqual(
      capturedFilter.serviceCategory.$in.sort(),
      ["cleaning", "cleaning_services"].sort(),
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
