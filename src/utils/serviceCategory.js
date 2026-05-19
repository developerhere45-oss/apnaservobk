const SERVICE_ALIASES = {
  ac: ["ac", "ac_repair", "ac repair", "air conditioner"],
  plumber: ["plumber", "plumbing", "pipe", "tap"],
  electrician: ["electrician", "electric", "electrical"],
  carpenter: ["carpenter", "wood", "furniture"],
  painting: ["painting", "paint"],
  cleaning: ["cleaning", "cleaning_services", "cleaning services"],
  interior: ["interior", "interior_design", "interior design"],
  roadside: ["roadside", "roadside_assistance", "roadside assistance"],
  appliance: ["appliance", "appliances"],
  pest: ["pest", "pest_control", "pest control"]
};

function normalizeServiceCategory(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[-_]+/g, " ");
  if (!raw) {
    return "service";
  }

  for (const [key, aliases] of Object.entries(SERVICE_ALIASES)) {
    if (aliases.some((alias) => raw === alias || raw.includes(alias))) {
      return key;
    }
  }

  return raw.replace(/\s+/g, "_");
}

function serviceLabel(value) {
  const key = normalizeServiceCategory(value);
  const labels = {
    ac: "AC Repair & Service",
    plumber: "Plumber Service",
    electrician: "Electrician",
    carpenter: "Carpenter",
    painting: "Painting",
    cleaning: "Cleaning Services",
    interior: "Interior Design",
    roadside: "Roadside Assistance",
    appliance: "Appliances",
    pest: "Pest Control"
  };
  return labels[key] || key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

module.exports = {
  normalizeServiceCategory,
  serviceLabel
};
