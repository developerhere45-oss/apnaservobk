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

// This is the customer application's implemented catalog.  It is deliberately
// kept here (rather than invented in the admin UI) so App Control still works
// before the optional Service Mongo collection has been populated.
const SERVICE_CATALOG = [
  ["ac", "AC Repair & Service", "AC inspection, cleaning, gas refilling, performance check, and repair replacement."],
  ["electrician", "Electrician", "Switchboard, wiring, fan, MCB, socket, inverter, and urgent electrical repair."],
  ["plumbing", "Plumber", "Tap, sink, flush tank, blocked drain, water motor, leakage, and pipe repair."],
  ["carpenter", "Carpenter", "Door, lock, curtain rod, furniture assembly, wall shelf, and cabinet fixes."],
  ["painting", "Painting", "Wall painting, touch-ups, damp patch repair, rental move-out paint, and finish work."],
  ["interior", "Interior Design", "Consultation for room planning, furniture placement, lighting, and home styling."],
  ["roadside", "Roadside Assistance", "Emergency roadside help, jump-start support, towing coordination, and tyre help."],
  ["cleaning", "Cleaning Services", "Home and office cleaning, bathroom cleaning, sofa cleaning, and deep cleaning."],
  ["laundry", "Laundry", "Clothes washing, ironing, dry cleaning pickup, stain care, and doorstep laundry service."],
  ["pest", "Pest Control", "Safe pest treatment for home, kitchen, bathroom, and office spaces."],
  ["appliances", "Appliances", "Washing machine, refrigerator, microwave, RO, chimney, and geyser inspection."],
  ["ro", "RO Service", "RO water purifier inspection, filter change, leakage repair, servicing, and installation."]
].map(([serviceCategory, name, description]) => ({ serviceCategory, name, description }));

const COMPANY_SERVICE_MATCHERS = {
  laundry: /laundry|dry\s*clean|wash|iron/,
  cleaning: /cleaning|cleaner|housekeeping|deep\s*clean/,
  ac: /\bac\b|air\s*condition/,
  electrician: /electric/,
  plumbing: /plumb|pipe/,
  carpenter: /carpent|furniture/,
  painting: /paint/,
  pest: /pest/,
  appliances: /appliance/,
  ro: /\bro\b|water\s*purifier/,
  interior: /interior/,
  roadside: /roadside/
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

function serviceCatalog() {
  return SERVICE_CATALOG.map((service) => ({ ...service }));
}

function normalizedPartnerCategories(partner) {
  return [...new Set((partner?.serviceCategory || [])
    .map(normalizeServiceCategory)
    .filter((category) => category && category !== "service"))];
}

function companySingleServiceCategory(partner) {
  if (!partner || partner.businessType !== "laundry") return "";
  const categories = normalizedPartnerCategories(partner);
  if (categories.length === 1) return categories[0];
  // An old profile that still has several services is unsafe to route until
  // it can be normalized. A clear company-name signal is the only stateless
  // exception; no arbitrary Laundry/AC default is used.
  const name = `${partner.laundryBusiness?.shopName || ""} ${partner.name || ""}`.toLowerCase();
  return categories.find((category) => COMPANY_SERVICE_MATCHERS[category]?.test(name)) || "";
}

function partnerCanServeService(partner, serviceCategory) {
  const requested = normalizeServiceCategory(serviceCategory);
  const companyCategory = companySingleServiceCategory(partner);
  const categories = partner?.businessType === "laundry"
    ? (companyCategory ? [companyCategory] : [])
    : normalizedPartnerCategories(partner);
  return categories.some((category) => serviceCategoryVariants(category).includes(requested));
}

module.exports = {
  normalizeServiceCategory,
  serviceCategoryVariants,
  serviceLabel,
  serviceCatalog,
  companySingleServiceCategory,
  partnerCanServeService
};
