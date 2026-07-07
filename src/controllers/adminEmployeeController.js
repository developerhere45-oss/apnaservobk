const bcrypt = require("bcryptjs");
const { z } = require("zod");
const Employee = require("../models/Employee");
const EmployeeActivityLog = require("../models/EmployeeActivityLog");

const permissionsSchema = z.object({
  viewDashboard: z.boolean().optional(),
  viewBookings: z.boolean().optional(),
  updateBookingStatus: z.boolean().optional(),
  viewPartners: z.boolean().optional(),
  approvePartners: z.boolean().optional(),
  viewUsers: z.boolean().optional(),
  handleChats: z.boolean().optional(),
  sendNotifications: z.boolean().optional()
}).optional();

const createSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  password: z.string().min(8).max(200),
  department: z.enum(["support", "operations", "verification", "general"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  permissions: permissionsSchema
});

const updateSchema = createSchema.omit({ password: true }).partial();

const statusSchema = z.object({
  status: z.enum(["active", "inactive"])
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(200)
});

function safeEmployee(employee) {
  return typeof employee.toSafeJSON === "function" ? employee.toSafeJSON() : employee;
}

async function listEmployees(_req, res, next) {
  try {
    const employees = await Employee.find().sort({ createdAt: -1 });
    return res.json({
      employees: employees.map(safeEmployee),
      rows: employees.map(safeEmployee),
      metrics: {
        totalEmployees: employees.length,
        activeEmployees: employees.filter((employee) => employee.status === "active").length,
        inactiveEmployees: employees.filter((employee) => employee.status === "inactive").length
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function createEmployee(req, res, next) {
  try {
    const body = createSchema.parse(req.body || {});
    const employee = await Employee.create({
      name: body.name,
      email: body.email.toLowerCase().trim(),
      phone: body.phone || "",
      passwordHash: await bcrypt.hash(body.password, 12),
      department: body.department || "general",
      status: body.status || "active",
      permissions: body.permissions || {}
    });
    return res.status(201).json({ employee: safeEmployee(employee) });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "Employee email or ID already exists" });
    }
    return next(error);
  }
}

async function getEmployee(req, res, next) {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ message: "Employee not found" });
    return res.json({ employee: safeEmployee(employee) });
  } catch (error) {
    return next(error);
  }
}

async function updateEmployee(req, res, next) {
  try {
    const body = updateSchema.parse(req.body || {});
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ message: "Employee not found" });
    for (const key of ["name", "phone", "department", "status"]) {
      if (body[key] !== undefined) employee[key] = body[key];
    }
    if (body.email) employee.email = body.email.toLowerCase().trim();
    if (body.permissions) {
      employee.permissions = { ...(employee.permissions?.toObject?.() || employee.permissions || {}), ...body.permissions };
    }
    await employee.save();
    return res.json({ employee: safeEmployee(employee) });
  } catch (error) {
    return next(error);
  }
}

async function updateEmployeeStatus(req, res, next) {
  try {
    const body = statusSchema.parse(req.body || {});
    const employee = await Employee.findByIdAndUpdate(req.params.id, { $set: { status: body.status } }, { new: true });
    if (!employee) return res.status(404).json({ message: "Employee not found" });
    return res.json({ employee: safeEmployee(employee) });
  } catch (error) {
    return next(error);
  }
}

async function resetEmployeePassword(req, res, next) {
  try {
    const body = resetPasswordSchema.parse(req.body || {});
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ message: "Employee not found" });
    employee.passwordHash = await bcrypt.hash(body.password, 12);
    await employee.save();
    return res.json({ ok: true, employee: safeEmployee(employee) });
  } catch (error) {
    return next(error);
  }
}

async function employeeActivity(req, res, next) {
  try {
    const activity = await EmployeeActivityLog.find({ employeeId: req.params.id }).sort({ createdAt: -1 }).limit(100);
    return res.json({
      activity: activity.map((item) => ({
        id: String(item._id),
        employeeId: String(item.employeeId),
        action: item.action,
        module: item.module,
        targetId: item.targetId ? String(item.targetId) : "",
        details: item.details || {},
        ipAddress: item.ipAddress,
        userAgent: item.userAgent,
        createdAt: item.createdAt
      }))
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createEmployee,
  employeeActivity,
  getEmployee,
  listEmployees,
  resetEmployeePassword,
  updateEmployee,
  updateEmployeeStatus
};
