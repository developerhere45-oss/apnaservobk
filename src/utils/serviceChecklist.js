const ServiceChecklistConfig = require("../models/ServiceChecklistConfig");
const { normalizeServiceCategory } = require("./serviceCategory");

const DEFAULTS = {
  ac_repair: ["AC Repair", "AC deep cleaning, gas refilling, filter cleaning, cooling check, etc.", ["Indoor unit deep cleaning", "Outdoor unit cleaning", "Gas pressure checked", "Cooling performance checked", "Minor wiring issue fixed"]],
  plumbing: ["Plumbing", "Pipe repair, leakage fix, tap replacement, blockage removal, etc.", ["Pipe inspection completed", "Leakage identified and fixed", "Tap / fitting repaired or replaced", "Drain blockage cleared", "Water pressure checked", "Final leakage test completed"]],
  electrician: ["Electrician", "Wiring repair, switch replacement, fault fixed, etc.", ["Electrical inspection completed", "Switch / socket repaired or replaced", "Wiring checked and tightened", "Loose connection fixed", "MCB / Fuse checked or replaced", "Voltage / Current tested", "Fault identified and fixed", "Earthing connection checked", "Final safety check completed"]],
  carpenter: ["Carpenter", "Furniture repair, door fitting, cabinet installation, etc.", ["Furniture inspection completed", "Wood cutting and measurement done", "Furniture repair completed", "Hinges / handles replaced or adjusted", "Drawer / door fitting fixed", "New fitting / installation done", "Polishing / finishing completed", "Alignment and stability checked", "Final quality check completed"]],
  ro_service: ["RO Service", "RO installation, filter change, TDS check, leakage fix, etc.", ["RO installation completed", "Pre filter replaced", "RO membrane cleaned / replaced", "Inline filter replaced", "TDS level checked and adjusted", "Leakage checked and fixed", "RO water flow tested", "Complete system sanitization done", "Final quality check completed"]],
  appliance_repair: ["Appliance Repair", "Washing machine repair, motor change, drum cleaning, etc.", ["Appliance inspection completed", "Fault identified and diagnosed", "Part(s) repaired or replaced", "Wiring / connection checked", "Motor / component repaired", "Cleaning and servicing done", "Functionality test completed", "Performance check completed", "Final quality check completed"]]
};

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function canonicalCategory(value) {
  const normalized = normalizeServiceCategory(value);
  const raw = slug(normalized || value);
  if (raw.includes("electric")) return "electrician";
  if (raw.includes("plumb")) return "plumbing";
  if (raw.includes("carpent")) return "carpenter";
  if (raw.includes("ro") || raw.includes("water_purifier")) return "ro_service";
  if (raw.includes("appliance") || raw.includes("washing") || raw.includes("refriger")) return "appliance_repair";
  return "ac_repair";
}

function defaultConfig(category) {
  const serviceCategory = canonicalCategory(category);
  const [serviceLabel, descriptionExample, names] = DEFAULTS[serviceCategory];
  return {
    serviceCategory,
    serviceLabel,
    descriptionExample,
    version: 1,
    enabled: true,
    tasks: names.map((name, order) => ({ taskId: `${serviceCategory}_${slug(name)}`, name, enabled: true, order }))
  };
}

async function getChecklist(category) {
  const serviceCategory = canonicalCategory(category);
  const stored = await ServiceChecklistConfig.findOne({ serviceCategory }).lean();
  const config = stored || defaultConfig(serviceCategory);
  return {
    ...config,
    tasks: (config.tasks || []).filter((task) => task.enabled !== false).sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
  };
}

module.exports = { canonicalCategory, defaultConfig, getChecklist, slug };
