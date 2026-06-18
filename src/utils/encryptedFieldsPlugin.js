const { decryptString, encryptString } = require("./fieldCrypto");

function encryptedFieldsPlugin(schema, options = {}) {
  const fields = Array.isArray(options.fields) ? options.fields : [];

  for (const field of fields) {
    const path = schema.path(field);
    if (!path) {
      continue;
    }
    path.set(encryptString);
    path.get(decryptString);
  }

  schema.set("toJSON", {
    ...(schema.get("toJSON") || {}),
    getters: true
  });
  schema.set("toObject", {
    ...(schema.get("toObject") || {}),
    getters: true
  });
}

module.exports = encryptedFieldsPlugin;
