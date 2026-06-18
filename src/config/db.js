const mongoose = require("mongoose");

async function connectDb() {
  const uri = process.env.MONGODB_URI;
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
}

module.exports = connectDb;
