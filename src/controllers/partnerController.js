const { z } = require("zod");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const Partner = require("../models/Partner");
const PartnerDocument = require("../models/PartnerDocument");
const { Booking } = require("../models/Booking");
const LocationLog = require("../models/LocationLog");
const { cloudinary } = require("../config/cloudinary");
const { normalizeServiceCategory } = require("../utils/serviceCategory");
const { validatePartnerLocation, partnerLocationUpdate } = require("../utils/locationValidation");
const { validateDocumentUpload } = require("../utils/documentValidation");

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).regex(/^[A-Za-z][A-Za-z .'-]+$/).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(180).optional().or(z.literal("")),
  serviceCategory: z.union([z.string().trim().max(80), z.array(z.string().trim().max(80)).max(12)]).optional(),
  city: z.string().trim().max(80).optional(),
  serviceArea: z.string().trim().max(200).optional(),
  serviceRadiusKm: z.coerce.number().min(1).max(250).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  isOnline: z.boolean().optional(),
  fcmToken: z.string().trim().max(4096).optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  faceVerified: z.boolean().optional(),
  selfieVerified: z.boolean().optional()
});

const livenessChecksSchema = z.object({
  blink: z.boolean().optional(),
  lookLeft: z.boolean().optional(),
  lookRight: z.boolean().optional(),
  smile: z.boolean().optional(),
  turnHead: z.boolean().optional(),
  stepCount: z.coerce.number().optional(),
  sessionId: z.string().trim().max(120).optional(),
  source: z.enum(["video"]).optional(),
  videoDurationMs: z.coerce.number().min(0).max(15000).optional(),
  videoFrameCount: z.coerce.number().min(0).max(60).optional()
}).optional();

const verificationSchema = z.object({
  aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
  selfieUrl: z.string().trim().max(1000).optional(),
  idProofUrl: z.string().trim().max(1000).optional(),
  skillCertificateUrl: z.string().trim().max(1000).optional(),
  faceVerified: z.boolean().optional(),
  selfieVerified: z.boolean().optional(),
  livenessChecks: livenessChecksSchema
});

const documentUploadSchema = z.object({
  documentType: z.enum(["id_proof", "address_proof", "skill_certificate"]),
  aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
  compressedByClient: z.coerce.boolean().optional(),
  originalSizeBytes: z.coerce.number().min(0).max(20 * 1024 * 1024).optional()
});

const deletionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional()
});

function categoriesFrom(bodyValue) {
  const values = Array.isArray(bodyValue) ? bodyValue : [bodyValue || "ac"];
  return [...new Set(values.map(normalizeServiceCategory).filter(Boolean))];
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const phone = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(phone) ? phone : "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function identityHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const secret = process.env.IDENTITY_HASH_PEPPER || process.env.ENCRYPTION_KEY || "apnaservo-dev-identity-hash";
  return crypto.createHmac("sha256", secret).update(normalized).digest("hex");
}

function tokenHasVerifiedEmail(req, email) {
  return Boolean(
    email
      && req.auth?.email_verified === true
      && normalizeEmail(req.auth?.email || "") === email
  );
}

async function findVerifiedEmailPartner(req, email, emailHash) {
  if (!emailHash || !tokenHasVerifiedEmail(req, email)) return null;
  return Partner.findOne({ firebaseUid: { $ne: req.auth.uid }, emailHash })
    .select("_id firebaseUid phoneHash emailHash faceVerified selfieVerified aadhaarStatus kycStatus fcmToken")
    .lean();
}

function isEmptyIdentityPartner(partner) {
  return Boolean(partner && !partner.phoneHash && !partner.emailHash);
}

async function ensureUniquePartnerIdentity({ uid, partnerId, phoneHash, emailHash }) {
  const checks = [];
  if (phoneHash) checks.push({ phoneHash });
  if (emailHash) checks.push({ emailHash });
  if (!checks.length) return;
  const query = { $or: checks };
  if (uid) query.firebaseUid = { $ne: uid };
  if (partnerId) query._id = { $ne: partnerId };
  const existing = await Partner.findOne(query).select("_id phoneHash emailHash").lean();
  if (existing) {
    const error = new Error("Partner with this phone or email already exists");
    error.status = 409;
    throw error;
  }
}

function kycStatusFor(update, partner) {
  const faceVerified = update.faceVerified ?? partner?.faceVerified ?? false;
  const selfieVerified = update.selfieVerified ?? partner?.selfieVerified ?? false;
  const aadhaarStatus = update.aadhaarStatus || partner?.aadhaarStatus || "missing";
  if (partner?.kycStatus === "rejected") return "rejected";
  if (faceVerified && selfieVerified && aadhaarStatus === "verified") return "verified";
  if (faceVerified || selfieVerified || aadhaarStatus === "submitted") return "pending_review";
  return "missing";
}

function hasPassedLiveness(checks) {
  if (!checks) return false;
  return Boolean(
    checks.source === "video"
      && checks.blink
      && checks.lookLeft
      && checks.lookRight
      && checks.smile
      && checks.turnHead
      && Number(checks.stepCount || 0) >= 5
      && Number(checks.videoDurationMs || 0) >= 2500
      && Number(checks.videoFrameCount || 0) >= 5
  );
}

function livenessUpdate(checks) {
  return {
    faceLivenessStatus: "passed",
    faceLivenessVerifiedAt: new Date(),
    faceLivenessSessionId: checks.sessionId || "",
    faceLivenessChecks: {
      blink: Boolean(checks.blink),
      lookLeft: Boolean(checks.lookLeft),
      lookRight: Boolean(checks.lookRight),
      smile: Boolean(checks.smile),
      turnHead: Boolean(checks.turnHead),
      stepCount: Number(checks.stepCount || 5),
      source: "video",
      videoDurationMs: Number(checks.videoDurationMs || 0),
      videoFrameCount: Number(checks.videoFrameCount || 0)
    }
  };
}

function fileDataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

async function uploadDocumentToCloudinary(file, partnerId, documentType) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    return { storageProvider: "inline", url: "", cloudinaryPublicId: "" };
  }
  const result = await cloudinary.uploader.upload(fileDataUri(file), {
    folder: `apnaservo/partner_documents/${partnerId}`,
    public_id: `${documentType}_${Date.now()}`,
    resource_type: "image",
    overwrite: false,
    quality: "auto:good",
    fetch_format: "auto"
  });
  return {
    storageProvider: "cloudinary",
    url: result.secure_url || result.url || "",
    cloudinaryPublicId: result.public_id || ""
  };
}

async function upsertProfile(req, res, next) {
  try {
    const body = profileSchema.parse(req.body || {});
    const phone = normalizePhone(body.phone || req.auth.phone_number || "");
    if (!phone) {
      return res.status(400).json({ message: "Valid 10 digit Indian mobile number is required" });
    }
    const email = normalizeEmail(body.email || req.auth.email || "");
    const categories = categoriesFrom(body.serviceCategory);
    if (!categories.length) {
      return res.status(400).json({ message: "At least one valid service category is required" });
    }
    const phoneHash = identityHash(phone);
    const emailHash = identityHash(email);
    const existingPartner = await Partner.findOne({ firebaseUid: req.auth.uid })
      .select("_id phoneHash emailHash faceVerified selfieVerified aadhaarStatus kycStatus fcmToken")
      .lean();
    const emailPartner = await findVerifiedEmailPartner(req, email, emailHash);
    const targetPartner = emailPartner || existingPartner;
    await ensureUniquePartnerIdentity({ uid: req.auth.uid, partnerId: targetPartner?._id, phoneHash, emailHash });
    const faceTrusted = targetPartner?.faceVerified === true || targetPartner?.selfieVerified === true;
    const update = {
      firebaseUid: req.auth.uid,
      name: body.name || req.auth.name || "ApnaServo Partner",
      phone,
      phoneHash,
      email,
      emailHash,
      serviceCategory: categories,
      city: body.city || "Guwahati",
      serviceArea: body.serviceArea || "Guwahati, Assam",
      serviceRadiusKm: body.serviceRadiusKm || 25,
      isOnline: body.isOnline !== false,
      isVerified: faceTrusted,
      trustStatus: faceTrusted ? "trusted" : "review_required"
    };

    if (body.fcmToken) update.fcmToken = body.fcmToken;
    if (body.photoUrl) update.photoUrl = body.photoUrl;
    if (body.faceVerified === false) {
      update.faceVerified = false;
      update.selfieVerified = false;
      update.faceLivenessStatus = "failed";
    }
    if (body.selfieVerified === false) update.selfieVerified = false;
    if (Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
      update.location = { type: "Point", coordinates: [body.lng, body.lat] };
    }
    if (emailPartner && existingPartner && String(emailPartner._id) !== String(existingPartner._id)) {
      if (!update.fcmToken && existingPartner.fcmToken) {
        update.fcmToken = existingPartner.fcmToken;
      }
      if (isEmptyIdentityPartner(existingPartner)) {
        await Partner.deleteOne({ _id: existingPartner._id });
      }
    }
    const filter = targetPartner?._id ? { _id: targetPartner._id } : { firebaseUid: req.auth.uid };
    const partner = await Partner.findOneAndUpdate(
      filter,
      { $set: update, $setOnInsert: { partnerCode: `ASP${Date.now().toString().slice(-6)}${crypto.randomBytes(2).toString("hex").toUpperCase()}` } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ partner });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    let partner = await Partner.findOne({ firebaseUid: req.auth.uid })
      .select("_id firebaseUid phoneHash emailHash faceVerified selfieVerified aadhaarStatus kycStatus fcmToken");
    if (req.auth.email_verified === true && req.auth.email) {
      const email = normalizeEmail(req.auth.email);
      const emailHash = identityHash(email);
      if (emailHash) {
        const emailPartner = await Partner.findOne({ emailHash, firebaseUid: { $ne: req.auth.uid } });
        const canRelink = !partner || (
          String(partner._id) !== String(emailPartner?._id)
          && isEmptyIdentityPartner(partner)
        );
        if (emailPartner && canRelink) {
          if (partner && !emailPartner.fcmToken && partner.fcmToken) {
            emailPartner.fcmToken = partner.fcmToken;
          }
          if (partner) {
            await Partner.deleteOne({ _id: partner._id });
          }
          emailPartner.firebaseUid = req.auth.uid;
          partner = await emailPartner.save();
        }
      }
    }
    return res.json({ partner });
  } catch (error) {
    return next(error);
  }
}

async function submitVerification(req, res, next) {
  try {
    const body = verificationSchema.parse(req.body || {});
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }

    const update = {};
    if (body.aadhaarLast4) {
      update.aadhaarLast4 = body.aadhaarLast4;
      update.aadhaarStatus = "submitted";
      update.aadhaarVerified = false;
    }
    if (body.selfieUrl) update.selfieUrl = body.selfieUrl;
    if (body.faceVerified || body.selfieVerified) {
      if (!hasPassedLiveness(body.livenessChecks)) {
        return res.status(422).json({ message: "Video face verification required: record a live video with blink, look left, look right, smile and turn head" });
      }
      Object.assign(update, livenessUpdate(body.livenessChecks));
      update.faceVerified = true;
      update.selfieVerified = true;
      update.isVerified = true;
      update.trustStatus = "trusted";
    }
    if (body.idProofUrl || body.skillCertificateUrl) {
      update.kycStatus = "pending_review";
    }
    update.kycStatus = kycStatusFor(update, partner);

    partner.set(update);
    await partner.save();
    return res.json({
      ok: true,
      partner,
      verification: {
        aadhaarStatus: partner.aadhaarStatus,
        aadhaarVerified: partner.aadhaarVerified,
        faceVerified: partner.faceVerified,
        selfieVerified: partner.selfieVerified,
        faceLivenessStatus: partner.faceLivenessStatus,
        kycStatus: partner.kycStatus
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function uploadDocument(req, res, next) {
  try {
    const body = documentUploadSchema.parse(req.body || {});
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "Document image is required" });
    }

    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }
    if (body.documentType === "id_proof" && !body.aadhaarLast4) {
      return res.status(400).json({ message: "Aadhaar last 4 digits required for ID proof" });
    }
    const contentHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const duplicate = await PartnerDocument.findOne({
      partnerId: partner._id,
      documentType: body.documentType,
      contentHash,
      validationStatus: { $ne: "rejected" }
    }).sort({ createdAt: -1 });
    if (duplicate) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        document: {
          id: duplicate._id,
          documentType: duplicate.documentType,
          validationStatus: duplicate.validationStatus,
          validationScore: duplicate.validationScore,
          validationReasons: duplicate.validationReasons,
          ocrStatus: duplicate.ocrStatus,
          url: duplicate.url
        },
        partner,
        verification: {
          aadhaarStatus: partner.aadhaarStatus,
          aadhaarVerified: partner.aadhaarVerified,
          idProofStatus: partner.idProofStatus,
          skillCertificateStatus: partner.skillCertificateStatus,
          kycStatus: partner.kycStatus
        }
      });
    }

    const validation = await validateDocumentUpload({
      buffer: file.buffer,
      mimeType: file.mimetype,
      documentType: body.documentType,
      aadhaarLast4: body.aadhaarLast4 || ""
    });
    if (validation.validationStatus === "rejected") {
      const document = await PartnerDocument.create({
        partnerId: partner._id,
        documentType: body.documentType,
        originalName: file.originalname || "document.jpg",
        mimeType: file.mimetype,
        sizeBytes: file.size,
        contentHash,
        compressedByClient: Boolean(body.compressedByClient),
        originalSizeBytes: body.originalSizeBytes || file.size,
        validationStatus: validation.validationStatus,
        validationScore: validation.validationScore,
        validationReasons: validation.validationReasons,
        ocrStatus: validation.ocrStatus,
        ocrTextHash: validation.ocrTextHash,
        aadhaarLast4: body.aadhaarLast4 || ""
      });
      return res.status(422).json({
        message: "Document image is not clear enough. Retake a sharp photo.",
        documentId: document._id,
        validation
      });
    }

    const uploaded = await uploadDocumentToCloudinary(file, partner._id, body.documentType);
    const document = await PartnerDocument.create({
      partnerId: partner._id,
      documentType: body.documentType,
      originalName: file.originalname || "document.jpg",
      mimeType: file.mimetype,
      sizeBytes: file.size,
      contentHash,
      ...uploaded,
      compressedByClient: Boolean(body.compressedByClient),
      originalSizeBytes: body.originalSizeBytes || file.size,
      validationStatus: validation.validationStatus,
      validationScore: validation.validationScore,
      validationReasons: validation.validationReasons,
      ocrStatus: validation.ocrStatus,
      ocrTextHash: validation.ocrTextHash,
      aadhaarLast4: body.aadhaarLast4 || ""
    });

    const update = {};
    if (body.documentType === "id_proof") {
      update.idProofUrl = uploaded.url;
      update.idProofStatus = validation.validationStatus === "accepted" ? "submitted" : "submitted";
      update.aadhaarLast4 = body.aadhaarLast4;
      update.aadhaarStatus = validation.ocrStatus === "passed" && validation.validationStatus === "accepted" ? "verified" : "submitted";
      update.aadhaarVerified = update.aadhaarStatus === "verified";
    } else if (body.documentType === "skill_certificate") {
      update.skillCertificateUrl = uploaded.url;
      update.skillCertificateStatus = "submitted";
    }
    update.kycStatus = kycStatusFor(update, partner);
    partner.set(update);
    await partner.save();

    return res.status(201).json({
      ok: true,
      document: {
        id: document._id,
        documentType: document.documentType,
        validationStatus: document.validationStatus,
        validationScore: document.validationScore,
        validationReasons: document.validationReasons,
        ocrStatus: document.ocrStatus,
        url: uploaded.url
      },
      partner,
      verification: {
        aadhaarStatus: partner.aadhaarStatus,
        aadhaarVerified: partner.aadhaarVerified,
        idProofStatus: partner.idProofStatus,
        skillCertificateStatus: partner.skillCertificateStatus,
        kycStatus: partner.kycStatus
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function saveFcmToken(req, res, next) {
  try {
    const token = String(req.body?.fcmToken || "").trim();
    if (!token || token.length > 4096) {
      return res.status(400).json({ message: "Valid FCM token is required" });
    }
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

async function requestDeletion(req, res, next) {
  try {
    const body = deletionRequestSchema.parse(req.body || {});
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      {
        $set: {
          accountStatus: "deletion_requested",
          deletionRequestedAt: new Date(),
          deletionReason: body.reason || "Partner requested account deletion from Android app",
          fcmToken: "",
          isOnline: false
        },
        $setOnInsert: {
          firebaseUid: req.auth.uid,
          partnerCode: `ASP${Date.now().toString().slice(-6)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
          name: req.auth.name || "ApnaServo Partner",
          phone: normalizePhone(req.auth.phone_number || ""),
          email: normalizeEmail(req.auth.email || ""),
          serviceCategory: ["ac"],
          city: "Guwahati"
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.json({
      ok: true,
      accountStatus: partner.accountStatus,
      deletionRequestedAt: partner.deletionRequestedAt
    });
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
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }

    const bookingId = String(req.body?.bookingId || "");
    const booking = bookingId
      ? await Booking.findOne(
          /^[a-f0-9]{24}$/i.test(bookingId)
            ? { $or: [{ _id: bookingId }, { bookingCode: bookingId }] }
            : { bookingCode: bookingId }
        )
      : null;
    if (booking && String(booking.partnerId || "") !== String(partner._id)) {
      return res.status(403).json({ message: "Not allowed to update location for this booking" });
    }
    if (booking && !["accepted", "on_the_way", "arrived", "started", "amount_pending"].includes(booking.status)) {
      return res.status(409).json({ message: "Location updates are allowed only for active jobs" });
    }

    const validation = validatePartnerLocation({ partner, booking, payload: req.body || {} });
    await LocationLog.create({
      partnerId: partner._id,
      bookingId: booking?._id || null,
      bookingCode: booking?.bookingCode || "",
      lat: Number.isFinite(validation.lat) ? validation.lat : 0,
      lng: Number.isFinite(validation.lng) ? validation.lng : 0,
      accuracy: validation.accuracy,
      provider: validation.provider,
      isMock: validation.isMock,
      validationStatus: validation.valid ? "accepted" : "rejected",
      reason: validation.reason,
      speedMps: validation.speedMps,
      distanceToCustomerM: validation.distanceToCustomerM,
      recordedAt: validation.recordedAt
    });

    if (!validation.valid) {
      partner.locationTrustStatus = "suspicious";
      await partner.save();
      return res.status(422).json({ message: validation.reason });
    }

    partner.set(partnerLocationUpdate(validation));
    await partner.save();
    return res.json({ ok: true, partner, locationAccepted: true });
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
  submitVerification,
  uploadDocument,
  saveFcmToken,
  requestDeletion,
  setOnline,
  updateLocation,
  statement
};
