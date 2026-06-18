const fs = require("fs");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/firebase-json-one-line.js path/to/firebase-adminsdk.json");
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
process.stdout.write(JSON.stringify(parsed));
