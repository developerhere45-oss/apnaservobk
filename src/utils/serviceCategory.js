const SERVICE_ALIASES = {
  ac: ["ac", "ac_repair", "ac repair", "air conditioner"],
  plumbing: ["plumbing", "plumber", "pipe", "tap"],
  electrician: ["electrician", "electric", "electrical"],
  carpenter: ["carpenter", "wood", "furniture"],
  painting: ["painting", "paint"],
  cleaning: ["cleaning", "cleaning_services", "cleaning services"],
  laundry: ["laundry", "dry_clean", "dry clean", "cloth", "clothes", "ironing", "washing service"],
  interior: ["interior", "interior_design", "interior design"],
  roadside: ["roadside", "roadside_assistance", "roadside assistance"],
  appliances: ["appliances", "appliance"],
  pest: ["pest", "pest_control", "pest control"],
  ro: ["ro", "ro_service", "ro service", "water purifier", "purifier", "water filter"]
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

function serviceCategoryVariants(value) {
  const key = normalizeServiceCategory(value);
  const variants = new Set([key]);
  const aliases = SERVICE_ALIASES[key] || [];
  for (const alias of aliases) {
    variants.add(String(alias).trim().toLowerCase().replace(/[-\s]+/g, "_"));
  }
  if (key === "plumbing") {
    variants.add("plumber");
  }
  if (key === "appliances") {
    variants.add("appliance");
  }
  return [...variants].filter(Boolean);
}

function serviceLabel(value) {
  const key = normalizeServiceCategory(value);
  const labels = {
    ac: "AC Repair & Service",
    plumbing: "Plumber Service",
    electrician: "Electrician",
    carpenter: "Carpenter",
    painting: "Painting",
    cleaning: "Cleaning Services",
    laundry: "Laundry",
    interior: "Interior Design",
    roadside: "Roadside Assistance",
    appliances: "Appliances",
    pest: "Pest Control",
    ro: "RO Service"
  };
  return labels[key] || key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

module.exports = {
  normalizeServiceCategory,
  serviceCategoryVariants,
  serviceLabel
};
