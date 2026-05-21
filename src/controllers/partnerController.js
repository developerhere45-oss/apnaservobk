const { z } = require("zod");
const PDFDocument = require("pdfkit");
const Partner = require("../models/Partner");
const { Booking } = require("../models/Booking");
const { normalizeServiceCategory } = require("../utils/serviceCategory");

const profileSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  serviceCategory: z.union([z.string(), z.array(z.string())]).optional(),
  city: z.string().optional(),
  serviceArea: z.string().optional(),
  serviceRadiusKm: z.number().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  isOnline: z.boolean().optional(),
  fcmToken: z.string().optional(),
  photoUrl: z.string().optional()
});

function categoriesFrom(bodyValue) {
  const values = Array.isArray(bodyValue) ? bodyValue : [bodyValue || "ac"];
  return [...new Set(values.map(normalizeServiceCategory).filter(Boolean))];
}

async function upsertProfile(req, res, next) {
  try {
    const body = profileSchema.parse(req.body || {});
    const update = {
      firebaseUid: req.auth.uid,
      name: body.name || req.auth.name || "ApnaServo Partner",
      phone: body.phone || req.auth.phone_number || "",
      email: body.email || req.auth.email || "",
      serviceCategory: categoriesFrom(body.serviceCategory),
      city: body.city || "Guwahati",
      serviceArea: body.serviceArea || "Guwahati, Assam",
      serviceRadiusKm: body.serviceRadiusKm || 25,
      isOnline: body.isOnline !== false,
      isVerified: true
    };

    if (body.fcmToken) update.fcmToken = body.fcmToken;
    if (body.photoUrl) update.photoUrl = body.photoUrl;
    if (Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
      update.location = { type: "Point", coordinates: [body.lng, body.lat] };
    }

    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: update, $setOnInsert: { partnerCode: `ASP${Date.now().toString().slice(-7)}` } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ partner });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    return res.json({ partner });
  } catch (error) {
    return next(error);
  }
}

async function saveFcmToken(req, res, next) {
  try {
    const token = String(req.body?.fcmToken || "");
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { fcmToken: token } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({ ok: true, partnerId: partner._id });
  } catch (error) {
    return next(error);
  }
}

async function setOnline(req, res, next) {
  try {
    const isOnline = req.path.includes("online");
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { isOnline } },
      { new: true }
    );
    return res.json({ ok: true, partner });
  } catch (error) {
    return next(error);
  }
}

async function updateLocation(req, res, next) {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: "lat and lng are required" });
    }
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { location: { type: "Point", coordinates: [lng, lat] } } },
      { new: true }
    );
    return res.json({ ok: true, partner });
  } catch (error) {
    return next(error);
  }
}

function parseStatementDate(value, endOfDay) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return date;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function money(value) {
  return `Rs ${Math.round(Number(value || 0)).toLocaleString("en-IN")}`;
}

function fitText(value, maxLength) {
  const text = String(value || "-").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function addSummaryRow(doc, label, value, x, y, width) {
  doc.fillColor("#6b5d61").fontSize(9).font("Helvetica").text(label, x, y);
  doc.fillColor("#171717").fontSize(13).font("Helvetica-Bold").text(String(value), x, y + 14, { width });
}

function addTableCell(doc, textValue, x, y, width, options = {}) {
  doc
    .fillColor(options.color || "#241f21")
    .font(options.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(options.size || 8.5)
    .text(textValue, x, y, { width, lineBreak: false });
}

function renderStatementPdf({ res, partner, bookings, fromDate, toDate, gross, commission, netPayable }) {
  const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true });
  const fileName = `apnaservo-job-statement-${Date.now()}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  doc.pipe(res);

  const period = `${formatDate(fromDate || bookings[bookings.length - 1]?.completedAt || bookings[bookings.length - 1]?.updatedAt || bookings[bookings.length - 1]?.createdAt)} - ${formatDate(toDate || bookings[0]?.completedAt || bookings[0]?.updatedAt || bookings[0]?.createdAt)}`;

  doc.rect(0, 0, doc.page.width, 120).fill("#fff4f6");
  doc.fillColor("#e62d66").font("Helvetica-Bold").fontSize(22).text("ApnaServo Partner Job Statement", 42, 36);
  doc.fillColor("#6b5d61").font("Helvetica").fontSize(10).text("Generated securely for the logged-in service partner", 42, 66);
  doc.roundedRect(420, 32, 120, 34, 17).fill("#e62d66");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10).text("COMPLETED JOBS", 437, 43);

  const summaryY = 145;
  doc.roundedRect(42, summaryY - 18, 511, 116, 18).fillAndStroke("#ffffff", "#f4d9df");
  addSummaryRow(doc, "Partner Name", partner.name || "ApnaServo Partner", 64, summaryY, 150);
  addSummaryRow(doc, "Partner Phone", partner.phone || "-", 230, summaryY, 130);
  addSummaryRow(doc, "Statement Period", period, 374, summaryY, 150);
  addSummaryRow(doc, "Total Completed Jobs", bookings.length, 64, summaryY + 58, 120);
  addSummaryRow(doc, "Gross Earnings", money(gross), 205, summaryY + 58, 120);
  addSummaryRow(doc, "App Commission", money(commission), 340, summaryY + 58, 110);
  addSummaryRow(doc, "Net Payable", money(netPayable), 458, summaryY + 58, 80);

  const tableTop = 295;
  const columns = [
    { label: "Booking ID", x: 48, width: 78 },
    { label: "Date", x: 130, width: 72 },
    { label: "Service", x: 206, width: 98 },
    { label: "Customer Name", x: 308, width: 104 },
    { label: "Amount", x: 416, width: 62 },
    { label: "Status", x: 482, width: 60 }
  ];

  doc.fillColor("#241f21").font("Helvetica-Bold").fontSize(15).text("Completed Job List", 42, tableTop - 34);
  doc.roundedRect(42, tableTop - 8, 511, 28, 9).fill("#fce8ee");
  columns.forEach((column) => addTableCell(doc, column.label, column.x, tableTop, column.width, { bold: true, color: "#d82f61", size: 8 }));

  let y = tableTop + 28;
  bookings.forEach((booking, index) => {
    if (y > 735) {
      doc.addPage();
      y = 60;
      doc.roundedRect(42, y - 8, 511, 28, 9).fill("#fce8ee");
      columns.forEach((column) => addTableCell(doc, column.label, column.x, y, column.width, { bold: true, color: "#d82f61", size: 8 }));
      y += 28;
    }

    if (index % 2 === 0) {
      doc.roundedRect(42, y - 8, 511, 26, 6).fill("#fff9fa");
    }
    const amount = booking.finalAmount || booking.price || 0;
    const values = [
      fitText(booking.bookingCode || booking._id, 15),
      formatDate(booking.completedAt || booking.updatedAt || booking.createdAt),
      fitText(booking.serviceName || booking.serviceCategory, 18),
      fitText(booking.userSnapshot?.name || booking.userId?.name || "Customer", 18),
      money(amount),
      "Completed"
    ];
    values.forEach((value, valueIndex) => addTableCell(doc, value, columns[valueIndex].x, y, columns[valueIndex].width));
    y += 30;
  });

  doc.moveTo(42, doc.page.height - 58).lineTo(553, doc.page.height - 58).strokeColor("#f0d8dc").stroke();
  doc.fillColor("#8a777b").font("Helvetica").fontSize(8).text("This statement is generated from completed ApnaServo bookings for the authenticated partner only.", 42, doc.page.height - 44, { width: 511, align: "center" });
  doc.end();
}

async function statement(req, res, next) {
  try {
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(401).json({ message: "Unauthorized partner" });
    }

    const fromDate = parseStatementDate(req.query.from, false);
    const toDate = parseStatementDate(req.query.to, true);
    if ((req.query.from && !fromDate) || (req.query.to && !toDate)) {
      return res.status(400).json({ message: "Invalid date filter" });
    }

    const query = {
      partnerId: partner._id,
      status: "completed"
    };
    if (fromDate || toDate) {
      query.$or = [
        {
          completedAt: {
            ...(fromDate ? { $gte: fromDate } : {}),
            ...(toDate ? { $lte: toDate } : {})
          }
        },
        {
          completedAt: null,
          updatedAt: {
            ...(fromDate ? { $gte: fromDate } : {}),
            ...(toDate ? { $lte: toDate } : {})
          }
        }
      ];
    }

    const bookings = await Booking.find(query)
      .populate("userId", "name phone")
      .sort({ completedAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(500);

    if (!bookings.length) {
      return res.status(404).json({ message: "No completed jobs found" });
    }

    const gross = bookings.reduce((sum, booking) => sum + Number(booking.finalAmount || booking.price || 0), 0);
    const commissionRate = Number(process.env.APP_COMMISSION_RATE || 0.1);
    const commission = Math.round(gross * (Number.isFinite(commissionRate) ? commissionRate : 0.1));
    const netPayable = Math.max(0, gross - commission);

    return renderStatementPdf({
      res,
      partner,
      bookings,
      fromDate,
      toDate,
      gross,
      commission,
      netPayable
    });
  } catch (error) {
    error.message = error.message || "PDF generation failed";
    return next(error);
  }
}

module.exports = {
  upsertProfile,
  me,
  saveFcmToken,
  setOnline,
  updateLocation,
  statement
};
