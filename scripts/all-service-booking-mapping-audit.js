const assert = require("node:assert/strict");
const {
  normalizeServiceCategory,
  serviceCategoryVariants,
  partnerCanServeService
} = require("../src/utils/serviceCategory");

const mapping = {
  ac: ["ac", "ac_repair", "ac service", "air conditioner"],
  electrician: ["electrician", "electrical"],
  plumbing: ["plumbing", "plumber"],
  carpenter: ["carpenter"],
  painting: ["painting"],
  interior: ["interior", "interior_design"],
  roadside: ["roadside", "roadside_assistance"],
  cleaning: ["cleaning", "cleaning_services", "home_cleaning"],
  laundry: ["laundry", "dry_clean", "dry_cleaning", "cloth_wash"],
  pest: ["pest", "pest_control"],
  appliances: ["appliances", "appliance_repair", "washing_machine", "refrigerator", "fridge", "microwave"],
  ro: ["ro", "ro_service", "water_purifier"]
};

for (const [canonical, clientIds] of Object.entries(mapping)) {
  for (const clientId of clientIds) {
    assert.equal(normalizeServiceCategory(clientId), canonical, `${clientId} must normalize to ${canonical}`);
    assert.equal(
      partnerCanServeService({ serviceCategory: [clientId], businessType: "" }, canonical),
      true,
      `${clientId} partner must receive ${canonical} booking`
    );
    assert.ok(
      serviceCategoryVariants(canonical).includes(clientId.replace(/[-\s]+/g, "_")),
      `${canonical} database query must include ${clientId}`
    );
  }
}

for (const canonical of Object.keys(mapping)) {
  for (const other of Object.keys(mapping)) {
    if (other === canonical) continue;
    assert.equal(
      partnerCanServeService({ serviceCategory: [other], businessType: "" }, canonical),
      false,
      `${other} partner must not receive ${canonical} booking`
    );
  }
}

console.log(`PASS ${Object.keys(mapping).length} service families map User App bookings only to eligible Partner profiles`);
