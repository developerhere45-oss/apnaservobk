const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { locationWriteFilter } = require("../src/utils/locationValidation");

test("HTTP/socket competing writes cannot overwrite a newer committed location", async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  try {
    await client.connect();
    const collection = client.db("location_test").collection("partners");
    const snapshot = { _id: "test-partner", lastLocationAt: new Date(1000) };
    await collection.insertOne(snapshot);
    const newer = await collection.updateOne(locationWriteFilter(snapshot),
      { $set: { lastLocationAt: new Date(3000), location: { coordinates: [91.74, 26.14] } } });
    const stale = await collection.updateOne(locationWriteFilter(snapshot),
      { $set: { lastLocationAt: new Date(2000), location: { coordinates: [90, 25] } } });
    assert.equal(newer.modifiedCount, 1);
    assert.equal(stale.matchedCount, 0);
    assert.deepEqual((await collection.findOne({ _id: snapshot._id })).location.coordinates, [91.74, 26.14]);
    await collection.insertOne({ _id: "first-location" });
    assert.equal((await collection.updateOne(locationWriteFilter({ _id: "first-location" }),
      { $set: { lastLocationAt: new Date(4000) } })).matchedCount, 1);
  } finally {
    await client.close();
    await server.stop();
  }
});
