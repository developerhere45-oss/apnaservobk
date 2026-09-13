function cleanCustomerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

// Older mobile builds generated labels such as "Customer 0719" before the
// profile sync completed. They are not customer-entered names and must never
// win over a subsequently submitted real name.
function isPlaceholderCustomerName(value) {
  const name = cleanCustomerName(value);
  return !name
    || /^(?:apnaservo\s+)?customer(?:\s+\d{1,12})?$/i.test(name)
    || /^guest(?:\s+\d{1,12})?$/i.test(name);
}

function firstRealCustomerName(...values) {
  for (const value of values) {
    const name = cleanCustomerName(value);
    if (!isPlaceholderCustomerName(name)) return name;
  }
  return "";
}

module.exports = { cleanCustomerName, isPlaceholderCustomerName, firstRealCustomerName };
