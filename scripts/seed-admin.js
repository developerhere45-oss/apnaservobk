require("dotenv").config();

const bcrypt = require("bcryptjs");
const connectDb = require("../src/config/db");
const Admin = require("../src/models/Admin");

async function main() {
  await connectDb();
  const name = process.env.SUPER_ADMIN_NAME || "ApnaServo Admin";
  const email = String(process.env.SUPER_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const password = process.env.SUPER_ADMIN_PASSWORD || "";

  if (!email || !password) {
    throw new Error("SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required");
  }

  const existing = await Admin.findOne({ email });
  if (existing) {
    console.log(`Super admin already exists: ${email}`);
    return;
  }

  await Admin.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "super_admin",
    status: "active"
  });
  console.log(`Super admin created: ${email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await require("mongoose").connection.close(false);
  });
