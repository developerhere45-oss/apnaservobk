const assert = require("node:assert/strict");
const { DEFAULT_INTENTS, normalized, keywordMatches } = require("../src/utils/supportBot");

assert.equal(normalized("  BOOKKIIING!!!  "), "bookkiing");
assert(keywordMatches(normalized("mera paymant fail ho gaya"), "payment"), "one-character payment typo must match");
assert(keywordMatches(normalized("partner abhi tak nhi aya"), "nhi aya"), "Hinglish phrase must match");
assert(keywordMatches(normalized("Helo support"), "hello"), "common greeting typo must match");
assert(DEFAULT_INTENTS.some((intent) => intent.id === "safety"), "urgent safety intent must exist");
assert(DEFAULT_INTENTS.every((intent) => intent.keywords.length && intent.reply.length > 20), "every intent needs keywords and a professional reply");

const controllerSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/controllers/userController.js"), "utf8");
assert(controllerSource.includes("body.serverBot"), "automatic replies must require an explicit client capability to avoid Android duplicates");

console.log(`PASS ${DEFAULT_INTENTS.length} support intents, Hinglish phrases, and spelling-tolerant matching`);
