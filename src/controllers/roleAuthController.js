const bcrypt = require("bcryptjs");
const { z } = require("zod");
const Admin = require("../models/Admin");
const Employee = require("../models/Employee");
const EmployeeActivityLog = require("../models/EmployeeActivityLog");
const { signRoleToken } = require("../middleware/authMiddleware");

const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase().trim()),
  password: z.string().min(6).max(200)
});

const employeeLoginSchema = z.object({
  identifier: z.string().min(3).max(160).optional(),
  email: z.string().min(3).max(160).optional(),
  password: z.string().min(6).max(200)
});

const passwordSchema = z.object({
  currentPassword: z.string().min(6).max(200),
  newPassword: z.string().min(8).max(200)
});

function requestMeta(req) {
  return {
    ipAddress: String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(),
    userAgent: String(req.headers["user-agent"] || "")
  };
}

async function logEmployee(employeeId, action, module, details, req) {
  if (!employeeId) return;
  await EmployeeActivityLog.create({
    employeeId,
    action,
    module,
    details,
    ...requestMeta(req)
  }).catch(() => undefined);
}

function adminPayload(admin) {
  return {
    id: String(admin._id),
    role: admin.role,
    type: "admin"
  };
}

function employeePayload(employee) {
  return {
    id: String(employee._id),
    role: "employee",
    type: "employee",
    permissions: employee.permissions || {}
  };
}

async function loginAdmin(req, res, next) {
  try {
    const body = loginSchema.parse(req.body || {});
    const admin = await Admin.findOne({ email: body.email });
    if (!admin || admin.status !== "active") {
      return res.status(401).json({ message: "Email or password is wrong" });
    }
    const ok = await bcrypt.compare(body.password, admin.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: "Email or password is wrong" });
    }
    admin.lastLoginAt = new Date();
    await admin.save();
    return res.json({
      token: signRoleToken(adminPayload(admin)),
      admin: admin.toSafeJSON()
    });
  } catch (error) {
    return next(error);
  }
}

async function adminMe(req, res) {
  return res.json({ admin: req.adminProfile.toSafeJSON() });
}

async function changeAdminPassword(req, res, next) {
  try {
    const body = passwordSchema.parse(req.body || {});
    const admin = req.adminProfile;
    const ok = await bcrypt.compare(body.currentPassword, admin.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: "Current password is wrong" });
    }
    admin.passwordHash = await bcrypt.hash(body.newPassword, 12);
    await admin.save();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function loginEmployee(req, res, next) {
  try {
    const body = employeeLoginSchema.parse(req.body || {});
    const identifier = String(body.identifier || body.email || "").toLowerCase().trim();
    const employee = await Employee.findOne({
      $or: [{ email: identifier }, { employeeId: identifier.toUpperCase() }]
    });
    if (!employee || employee.status !== "active") {
      return res.status(401).json({ message: "Employee login details are wrong" });
    }
    const ok = await bcrypt.compare(body.password, employee.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: "Employee login details are wrong" });
    }
    employee.lastLoginAt = new Date();
    await employee.save();
    await logEmployee(employee._id, "login", "auth", { employeeId: employee.employeeId }, req);
    return res.json({
      token: signRoleToken(employeePayload(employee)),
      employee: employee.toSafeJSON()
    });
  } catch (error) {
    return next(error);
  }
}

async function employeeMe(req, res) {
  return res.json({ employee: req.employeeProfile.toSafeJSON() });
}

async function changeEmployeePassword(req, res, next) {
  try {
    const body = passwordSchema.parse(req.body || {});
    const employee = req.employeeProfile;
    const ok = await bcrypt.compare(body.currentPassword, employee.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: "Current password is wrong" });
    }
    employee.passwordHash = await bcrypt.hash(body.newPassword, 12);
    await employee.save();
    await logEmployee(employee._id, "change_password", "auth", {}, req);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

function logout(_req, res) {
  return res.json({ ok: true });
}

module.exports = {
  adminMe,
  changeAdminPassword,
  changeEmployeePassword,
  employeeMe,
  loginAdmin,
  loginEmployee,
  logout
};
