const mongoose = require("mongoose");

let memoryServer;

async function connectDb() {
  let uri = process.env.MONGODB_URI;
  if (process.env.USE_IN_MEMORY_DB === "true") {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    memoryServer = await MongoMemoryServer.create({
      instance: { dbName: "apnaservo_dev" }
    });
    uri = memoryServer.getUri();
    console.log("Development in-memory MongoDB started");
  }
  if (!uri) {
    throw new Error("MONGODB_URI is required in .env");
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    autoIndex: process.env.NODE_ENV !== "production",
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 50),
    minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 2),
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 8000),
    socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS || 45000)
  });

  if (process.env.MONGODB_SYNC_INDEXES === "true") {
    await mongoose.syncIndexes();
    console.log("MongoDB indexes synced");
  }

  console.log("MongoDB connected");
  if (process.env.SEED_ADMIN_DEMO === "true") {
    await require("../dev/seedAdminDemo")();
  }
}

module.exports = connectDb;
