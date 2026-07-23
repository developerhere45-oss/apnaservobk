const { z } = require("zod");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const Partner = require("../models/Partner");
const PartnerDocument = require("../models/PartnerDocument");
const PartnerUploadAsset = require("../models/PartnerUploadAsset");
const SupportTicket = require("../models/SupportTicket");
const { Booking } = require("../models/Booking");
const LocationLog = require("../models/LocationLog");
const { cloudinary } = require("../config/cloudinary");
const { normalizeServiceCategory, serviceCategoryVariants, serviceLabel } = require("../utils/serviceCategory");
const { validatePartnerLocation, partnerLocationUpdate } = require("../utils/locationValidation");
const { validateDocumentUpload } = require("../utils/documentValidation");
const { pendingAssignmentStatuses } = require("../utils/bookingLifecycle");
const { reliableNotify } = require("../utils/reliableNotify");
const { emitAdminEvent, emitNewBookingToPartners, emitBookingAccepted, emitLaundryStaffAssignment, serializeBooking } = require("../sockets/bookingSocket");
const { normalizeDeviceToken, upsertDeviceToken } = require("../utils/notificationTokens");
const { partnerAssetUrl } = require("../utils/partnerUploadAssets");

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).regex(/^[A-Za-z][A-Za-z .'-]+$/).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(180).optional().or(z.literal("")),
  dateOfBirth: z.string().trim().max(30).optional().or(z.literal("")),
  gender: z.string().trim().max(40).optional().or(z.literal("")),
  residentialAddress: z.string().trim().max(700).optional().or(z.literal("")),
  serviceCategory: z.union([z.string().trim().max(80), z.array(z.string().trim().max(80)).max(12)]).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional().or(z.literal("")),
  pinCode: z.string().trim().max(12).optional().or(z.literal("")),
  emergencyContactNumber: z.string().trim().max(20).optional().or(z.literal("")),
  serviceArea: z.string().trim().max(200).optional(),
  workingAreas: z.union([z.string().trim().max(500), z.array(z.string().trim().max(120)).max(30)]).optional(),
  languagesKnown: z.union([z.string().trim().max(300), z.array(z.string().trim().max(60)).max(20)]).optional(),
  businessType: z.enum(["laundry"]).optional(),
  laundryBusiness: z.object({
    shopName: z.string().trim().max(120).optional().or(z.literal("")),
    shopLicenseNumber: z.string().trim().max(100).optional().or(z.literal("")),
    shopLocation: z.string().trim().max(700).optional().or(z.literal("")),
    ownerName: z.string().trim().max(80).optional().or(z.literal("")),
    ownerPhone: z.string().trim().max(20).optional().or(z.literal("")),
    staffMembers: z.array(z.object({
      sequence: z.coerce.number().int().min(1).max(100),
      name: z.string().trim().min(2).max(80),
      phone: z.string().trim().max(20),
      email: z.string().trim().email().max(180).optional().or(z.literal("")),
      // Staff identity is verified from the uploaded document. The Android
      // registration form intentionally does not collect the document number.
      idNumber: z.string().trim().max(100).optional().or(z.literal("")),
      idType: z.string().trim().min(2).max(60),
      documentType: z.string().trim().max(80).optional(),
      documentTitle: z.string().trim().max(120).optional(),
      role: z.string().trim().max(80).optional(),
      photoUrl: z.string().trim().max(1000).optional()
    })).max(20).default([])
  }).optional(),
  yearsOfExperience: z.coerce.number().min(0).max(80).optional(),
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

const partnerDocumentTypes = [
  "aadhaar_front",
  "aadhaar_back",
  "pan_card",
  "selfie_photo",
  "id_proof",
  "address_proof",
  "experience_certificate",
  "skill_certificate",
  "training_certificate",
  "government_license",
  "trade_license",
  "other_supporting_document",
  "laundry_shop_license",
  "laundry_staff_identity"
];

const documentUploadSchema = z.object({
  documentType: z.string().trim().min(2).max(80)
    .transform((value) => value.toLowerCase().replace(/[\s-]+/g, "_"))
    .refine(
      (value) => partnerDocumentTypes.includes(value) || /^laundry_staff_\d+_identity$/.test(value),
      "Unsupported partner document type"
    ),
  aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
  compressedByClient: z.coerce.boolean().optional(),
  originalSizeBytes: z.coerce.number().min(0).max(20 * 1024 * 1024).optional()
});

const deletionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional()
});

const laundryStaffInviteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  email: z.string().trim().email().max(180).optional().or(z.literal("")),
  role: z.string().trim().max(80).optional().or(z.literal(""))
});

const supportTicketSchema = z.object({
  category: z.string().trim().max(120).optional(),
  message: z.string().trim().min(1).max(1000),
  clientMessageId: z.string().trim().max(120).optional(),
  attachmentUrl: z.string().trim().max(1000).optional().or(z.literal("")),
  priority: z.enum(["low", "normal", "medium", "high", "urgent"]).optional()
});

function categoriesFrom(bodyValue) {
  // A company or independent partner must explicitly choose its service.
  // Never silently turn an incomplete registration into an AC profile.
  const values = Array.isArray(bodyValue) ? bodyValue : [bodyValue || ""];
  return [...new Set(values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map(normalizeServiceCategory)
    .filter((value) => value && value !== "service"))];
}

function listFromBody(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  return [...new Set(values.map((entry) => String(entry || "").trim()).filter(Boolean))].slice(0, 30);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const phone = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(phone) ? phone : "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function partnerCanReceiveOpenBookings(partner) {
  if (!partner) return false;
  if (partner.accountStatus !== "active") return false;
  if (partner.trustStatus === "suspended") return false;
  if (!partner.isVerified || partner.kycStatus !== "verified" || partner.trustStatus !== "trusted") return false;
  if (!partner.isOnline) return false;
  return Array.isArray(partner.serviceCategory) && partner.serviceCategory.length > 0;
}

function partnerDispatchCategories(partner) {
  const companyCategories = isolatedCompanyCategories(partner);
  const source = companyCategories || partner.serviceCategory || [];
  return [...new Set(source.flatMap(serviceCategoryVariants))].filter(Boolean);
}

function isolatedCompanyCategories(partner) {
  if (!partner || partner.businessType !== "laundry") return null;
  const normalized = [...new Set((partner.serviceCategory || []).map(normalizeServiceCategory).filter(Boolean))];
  if (normalized.length === 1) return normalized;
  const businessName = `${partner.laundryBusiness?.shopName || ""} ${partner.name || ""}`.toLowerCase();
  const serviceMatchers = {
    laundry: /laundry|dry\s*clean|wash|iron/,
    cleaning: /cleaning|cleaner|housekeeping|deep\s*clean/,
    ac: /\bac\b|air\s*condition/,
    electrician: /electric/,
    plumbing: /plumb|pipe/,
    carpenter: /carpent|furniture/,
    painting: /paint/,
    pest: /pest/,
    appliances: /appliance/,
    ro: /\bro\b|water\s*purifier/,
    interior: /interior/,
    roadside: /roadside/
  };
  const nameMatched = normalized.find((category) => serviceMatchers[category]?.test(businessName));
  // Legacy profiles that carried multiple services are reduced predictably to
  // one saved service. No new default service is invented for an empty profile.
  return nameMatched ? [nameMatched] : [];
}

async function enforceCompanyServiceIsolation(partner) {
  let isolated = isolatedCompanyCategories(partner);
  const current = (partner?.serviceCategory || []).map(normalizeServiceCategory).filter(Boolean);
  // Older company profiles were incorrectly saved with both Laundry and
  // Cleaning. If the company name is ambiguous, its live booking history is
  // the safest migration signal; this prevents a cleaning company from being
  // converted to Laundry just because of a legacy array order.
  if (partner?.businessType === "laundry" && current.length > 1) {
    const businessName = `${partner.laundryBusiness?.shopName || ""} ${partner.name || ""}`.toLowerCase();
    const hasNameSignal = /laundry|dry\s*clean|wash|iron|cleaning|cleaner|housekeeping|deep\s*clean|\bac\b|air\s*condition|electric|plumb|pipe|carpent|furniture|paint|pest|appliance|\bro\b|water\s*purifier|interior|roadside/.test(businessName);
    if (!hasNameSignal) {
      const counts = await Booking.aggregate([
        { $match: {
          $or: [{ partnerId: partner._id }, { requestedPartners: partner._id }],
          serviceCategory: { $in: current }
        } },
        { $group: { _id: "$serviceCategory", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]);
      const bookingCategory = normalizeServiceCategory(counts[0]?._id || "");
      if (current.includes(bookingCategory)) isolated = [bookingCategory];
    }
  }
  if (!isolated) return partner;
  if (current.length === isolated.length && current.every((value, index) => value === isolated[index])) return partner;
  partner.serviceCategory = isolated;
  await partner.save();
  return partner;
}

async function dispatchPendingBookingsToPartner(partner) {
  partner = await enforceCompanyServiceIsolation(partner);
  if (!partnerCanReceiveOpenBookings(partner)) {
    return 0;
  }
  const categories = partnerDispatchCategories(partner);
  if (!categories.length) {
    return 0;
  }

  const cityRegex = new RegExp(escapeRegExp(partner.city || "Guwahati"), "i");
  const candidates = await Booking.find({
    partnerId: null,
    rejectedPartners: { $ne: partner._id },
    requestedPartners: { $ne: partner._id },
    status: { $in: pendingAssignmentStatuses() },
    serviceCategory: { $in: categories },
    $or: [
      { city: cityRegex },
      { city: { $in: ["", null] } },
      { requestedPartners: { $size: 0 } }
    ]
  }).sort({ createdAt: -1 }).limit(20);

  let dispatched = 0;
  for (const booking of candidates) {
    const updated = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        partnerId: null,
        rejectedPartners: { $ne: partner._id },
        requestedPartners: { $ne: partner._id },
        status: { $in: pendingAssignmentStatuses() }
      },
      {
        $addToSet: { requestedPartners: partner._id },
        $set: { status: "sent_to_partner" },
        $push: {
          statusTimeline: {
            status: "sent_to_partner",
            at: new Date(),
            by: "system",
            note: "Dispatched when partner came online"
          }
        }
      },
      { new: true }
    );
    if (!updated) {
      continue;
    }
    emitNewBookingToPartners(updated, [partner]);
    dispatched += 1;
  }
  return dispatched;
}

function identityHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const secret = process.env.IDENTITY_HASH_PEPPER || process.env.ENCRYPTION_KEY || "apnaservo-dev-identity-hash";
  return crypto.createHmac("sha256", secret).update(normalized).digest("hex");
}

function bookingIdentityFilter(value) {
  const bookingId = String(value || "").trim();
  return /^[a-f0-9]{24}$/i.test(bookingId)
    ? { $or: [{ _id: bookingId }, { bookingCode: bookingId }] }
    : { bookingCode: bookingId };
}

function staffPublicProfile(partner, staff) {
  const approved = partner.businessVerificationStatus === "approved"
    && partner.accountStatus === "active"
    && partner.trustStatus !== "suspended";
  const companyService = isolatedCompanyCategories(partner) || [];
  const serviceName = serviceLabel(companyService[0] || "service");
  const storedRole = String(staff.role || "").trim();
  const role = (!storedRole || (companyService[0] !== "laundry" && /^laundry\s+staff$/i.test(storedRole)))
    ? `${serviceName} Staff`
    : storedRole;
  return {
    sequence: Number(staff.sequence || 0),
    name: staff.name || "Service Staff",
    phone: staff.phone || "",
    email: staff.email || "",
    role,
    staffCode: `${partner.partnerCode || `ASP${String(partner._id).slice(-6).toUpperCase()}`}-S${String(Number(staff.sequence || 0)).padStart(2, "0")}`,
    serviceCategory: companyService,
    photoUrl: staff.photoUrl || "",
    idType: staff.idType || "Government ID",
    identityVerified: staff.verificationStatus === "verified",
    verificationStatus: staff.verificationStatus === "blocked"
      ? "blocked"
      : (approved && staff.verificationStatus === "verified" ? "verified" : (staff.verificationStatus || "pending_review")),
    isOnline: Boolean(staff.isOnline),
    shopName: partner.laundryBusiness?.shopName || "ApnaServo Company",
    shopLocation: partner.laundryBusiness?.shopLocation || partner.serviceArea || "Guwahati, Assam",
    shopLicenseNumber: partner.laundryBusiness?.shopLicenseNumber || "",
    ownerPartnerId: String(partner._id),
    ownerName: partner.laundryBusiness?.ownerName || partner.name || "",
    ownerPhone: partner.laundryBusiness?.ownerPhone || partner.phone || "",
    businessVerificationStatus: partner.businessVerificationStatus || "pending_review"
  };
}

async function findStaffContext(req, { requireApproved = true } = {}) {
  const phone = normalizePhone(req.auth?.phone_number || "");
  const email = normalizeEmail(req.auth?.email || "");
  const verifiedEmail = req.auth?.email_verified === true ? email : "";
  if ((!phone && !verifiedEmail) || req.auth?.development_device) {
    const error = new Error("Verified staff phone OTP or verified email is required");
    error.status = 401;
    throw error;
  }
  const phoneHash = identityHash(phone);
  const emailHash = identityHash(verifiedEmail);
  let partner = await Partner.findOne({
    businessType: "laundry",
    $or: [
      { "laundryBusiness.staffMembers.firebaseUid": req.auth.uid },
      ...(phoneHash ? [{ "laundryBusiness.staffMembers.phoneHash": phoneHash }] : []),
      ...(emailHash ? [{ "laundryBusiness.staffMembers.emailHash": emailHash }] : [])
    ]
  });

  if (!partner) {
    const candidates = await Partner.find({ businessType: "laundry" }).limit(500);
    partner = candidates.find((entry) => (entry.laundryBusiness?.staffMembers || [])
      .some((member) => (phone && normalizePhone(member.phone) === phone)
        || (verifiedEmail && normalizeEmail(member.email) === verifiedEmail)));
  }
  if (!partner) {
    const error = new Error("No company staff invitation was found for this phone or email");
    error.status = 404;
    throw error;
  }

  const staff = (partner.laundryBusiness?.staffMembers || []).find((member) =>
    member.firebaseUid === req.auth.uid
      || member.phoneHash === phoneHash
      || (phone && normalizePhone(member.phone) === phone)
      || (emailHash && member.emailHash === emailHash)
      || (verifiedEmail && normalizeEmail(member.email) === verifiedEmail)
  );
  if (!staff) {
    const error = new Error("Company staff profile not found");
    error.status = 404;
    throw error;
  }
  if (staff.firebaseUid && staff.firebaseUid !== req.auth.uid) {
    const error = new Error("This staff phone is already linked to another account");
    error.status = 409;
    throw error;
  }
  if (["blocked", "rejected"].includes(staff.verificationStatus)) {
    const error = new Error("Staff access is blocked. Contact the company owner or ApnaServo Support");
    error.status = 403;
    throw error;
  }
  if (requireApproved && (
    partner.businessVerificationStatus !== "approved"
    || partner.accountStatus !== "active"
    || partner.trustStatus === "suspended"
    || staff.verificationStatus !== "verified"
  )) {
    const error = new Error("Company or staff verification is still pending");
    error.status = 403;
    throw error;
  }
  let contextChanged = false;
  if (staff.phoneHash !== phoneHash) {
    if (phoneHash) staff.phoneHash = phoneHash;
    contextChanged = true;
  }
  if (emailHash && staff.emailHash !== emailHash) {
    staff.emailHash = emailHash;
    contextChanged = true;
  }
  if (staff.firebaseUid !== req.auth.uid) {
    staff.firebaseUid = req.auth.uid;
    contextChanged = true;
  }
  const now = Date.now();
  const previousLoginAt = staff.lastLoginAt ? new Date(staff.lastLoginAt).getTime() : 0;
  if (!Number.isFinite(previousLoginAt) || now - previousLoginAt >= 5 * 60 * 1000) {
    staff.lastLoginAt = new Date(now);
    contextChanged = true;
  }
  return { partner, staff, phoneHash, emailHash, contextChanged };
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
    .select("_id firebaseUid phoneHash emailHash faceVerified selfieVerified aadhaarStatus kycStatus isVerified trustStatus fcmToken businessType businessVerificationStatus laundryBusiness")
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
  if (partner?.kycStatus === "verified") return "verified";
  if (partner?.kycStatus === "rejected") return "rejected";
  const faceVerified = update.faceVerified ?? partner?.faceVerified ?? false;
  const selfieVerified = update.selfieVerified ?? partner?.selfieVerified ?? false;
  const aadhaarStatus = update.aadhaarStatus || partner?.aadhaarStatus || "missing";
  if (faceVerified || selfieVerified || ["submitted", "verified"].includes(aadhaarStatus) || update.idProofUrl || update.skillCertificateUrl) {
    return "pending_review";
  }
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

function normalizedImageMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value === "image/jpg") return "image/jpeg";
  if (value === "application/x-pdf") return "application/pdf";
  return value;
}

async function uploadDocumentToCloudinary(file, partnerId, documentType, req, kind = "document") {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    const asset = await PartnerUploadAsset.create({
      partnerId,
      kind,
      documentType,
      mimeType: normalizedImageMime(file.mimetype),
      originalName: file.originalname || `${documentType}.jpg`,
      sizeBytes: file.size,
      contentHash: crypto.createHash("sha256").update(file.buffer).digest("hex"),
      dataBase64: file.buffer.toString("base64")
    });
    return {
      storageProvider: "mongodb",
      url: partnerAssetUrl(req, asset._id),
      cloudinaryPublicId: "",
      partnerUploadAssetId: asset._id
    };
  }
  const isPdf = normalizedImageMime(file.mimetype) === "application/pdf";
  const uploadOptions = {
    folder: `apnaservo/partner_documents/${partnerId}`,
    public_id: `${documentType}_${Date.now()}${isPdf ? ".pdf" : ""}`,
    resource_type: isPdf ? "raw" : "image",
    overwrite: false
  };
  if (!isPdf) {
    uploadOptions.quality = "auto:good";
    uploadOptions.fetch_format = "auto";
  }
  const result = await cloudinary.uploader.upload(fileDataUri(file), uploadOptions);
  return {
    storageProvider: "cloudinary",
    url: result.secure_url || result.url || "",
    cloudinaryPublicId: result.public_id || "",
    partnerUploadAssetId: null
  };
}

async function uploadProfilePhoto(req, res, next) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "Profile photo is required" });
    }
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }
    const uploaded = await uploadDocumentToCloudinary(file, partner._id, "profile_photo", req, "profile_photo");
    partner.photoUrl = uploaded.url;
    partner.profilePhotoAssetId = uploaded.partnerUploadAssetId || null;
    if (partner.kycStatus === "missing") {
      partner.kycStatus = "pending_review";
    }
    await partner.save();
    emitAdminEvent("partner:photo_updated", {
      partnerId: String(partner._id),
      partnerCode: partner.partnerCode || "",
      partnerName: partner.name || "",
      hasProfilePhoto: Boolean(partner.photoUrl)
    });
    return res.status(201).json({
      ok: true,
      photoUrl: partner.photoUrl || "",
      storageProvider: uploaded.storageProvider,
      partner
    });
  } catch (error) {
    return next(error);
  }
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
    if (categories.length !== 1) {
      return res.status(400).json({ message: "Choose exactly one service category for this profile" });
    }
    const isLaundryRegistration = body.businessType === "laundry";
    if (isLaundryRegistration && !body.laundryBusiness) {
      return res.status(400).json({ message: "Complete company and staff details are required" });
    }
    if (isLaundryRegistration && body.laundryBusiness.staffMembers.some((staff) => !normalizePhone(staff.phone))) {
      return res.status(400).json({ message: "Every laundry staff member requires a valid phone number" });
    }
    const ownerPhone = isLaundryRegistration ? normalizePhone(body.laundryBusiness.ownerPhone || phone) : "";
    const normalizedLaundryStaff = isLaundryRegistration
      ? body.laundryBusiness.staffMembers.map((staff) => {
          const staffPhone = normalizePhone(staff.phone);
          return {
            ...staff,
            phone: staffPhone,
            phoneHash: identityHash(staffPhone),
            idNumber: staff.idNumber || "",
            role: staff.role || `${serviceLabel(categories[0])} Staff`,
            photoUrl: staff.photoUrl || ""
          };
        })
      : [];
    if (isLaundryRegistration) {
      const staffHashes = normalizedLaundryStaff.map((staff) => staff.phoneHash);
      if (new Set(staffHashes).size !== staffHashes.length) {
      return res.status(400).json({ message: "Each staff member must use a different phone number" });
      }
      if (normalizedLaundryStaff.some((staff) => staff.phone === ownerPhone)) {
        return res.status(400).json({ message: "Owner and staff phone numbers must be different" });
      }
      if (staffHashes.length) {
        const claimedByAnotherShop = await Partner.exists({
          firebaseUid: { $ne: req.auth.uid },
          "laundryBusiness.staffMembers.phoneHash": { $in: staffHashes }
        });
        if (claimedByAnotherShop) {
          return res.status(409).json({ message: "A staff phone number is already registered with another company" });
        }
      }
    }
    const phoneHash = identityHash(phone);
    const emailHash = identityHash(email);
    const existingPartner = await Partner.findOne({ firebaseUid: req.auth.uid })
      .select("_id phoneHash emailHash faceVerified selfieVerified aadhaarStatus kycStatus isVerified trustStatus fcmToken businessType businessVerificationStatus laundryBusiness")
      .lean();
    const emailPartner = await findVerifiedEmailPartner(req, email, emailHash);
    const targetPartner = emailPartner || existingPartner;
    await ensureUniquePartnerIdentity({ uid: req.auth.uid, partnerId: targetPartner?._id, phoneHash, emailHash });
    const standardApproval = targetPartner?.isVerified === true
      && targetPartner?.kycStatus === "verified"
      && targetPartner?.trustStatus === "trusted";
    const laundryApproval = targetPartner?.businessType === "laundry"
      && targetPartner?.businessVerificationStatus === "approved";
    const adminApproved = standardApproval && (!isLaundryRegistration || laundryApproval);
    const currentTrustStatus = targetPartner?.trustStatus || "review_required";
    const update = {
      firebaseUid: req.auth.uid,
      name: body.name || req.auth.name || "ApnaServo Partner",
      phone,
      phoneHash,
      email,
      emailHash,
      dateOfBirth: body.dateOfBirth || "",
      gender: body.gender || "",
      residentialAddress: body.residentialAddress || body.serviceArea || "",
      serviceCategory: categories,
      city: body.city || "Guwahati",
      state: body.state || "Assam",
      pinCode: body.pinCode || "",
      emergencyContactNumber: normalizePhone(body.emergencyContactNumber || ""),
      serviceArea: body.serviceArea || "Guwahati, Assam",
      workingAreas: listFromBody(body.workingAreas || body.serviceArea || "Guwahati"),
      languagesKnown: listFromBody(body.languagesKnown || "Hindi, English"),
      yearsOfExperience: Number.isFinite(body.yearsOfExperience) ? body.yearsOfExperience : 0,
      serviceRadiusKm: body.serviceRadiusKm || 25,
      isOnline: isLaundryRegistration && !adminApproved ? false : body.isOnline !== false,
      isVerified: adminApproved,
      trustStatus: currentTrustStatus === "suspended"
        ? "suspended"
        : (adminApproved ? "trusted" : "review_required"),
      ...(isLaundryRegistration ? {
        businessType: "laundry",
        businessVerificationStatus: adminApproved ? "approved" : "pending_review",
        laundryBusiness: {
          ...body.laundryBusiness,
          shopName: body.laundryBusiness.shopName || `${body.name || req.auth.name || "Service"} Company`,
          shopLicenseNumber: body.laundryBusiness.shopLicenseNumber || "Not provided",
          shopLocation: body.laundryBusiness.shopLocation || body.serviceArea || "Guwahati, Assam",
          ownerName: body.laundryBusiness.ownerName || body.name || req.auth.name || "Company Owner",
          ownerPhone,
          staffMembers: normalizedLaundryStaff.map((staff) => {
            const previous = (targetPartner?.laundryBusiness?.staffMembers || []).find((entry) =>
              entry.phoneHash === staff.phoneHash || normalizePhone(entry.phone) === staff.phone
            );
            return {
              ...staff,
              firebaseUid: previous?.firebaseUid || "",
              verificationStatus: previous?.verificationStatus || "pending_review",
              isOnline: Boolean(previous?.isOnline),
              fcmToken: previous?.fcmToken || "",
              lastLoginAt: previous?.lastLoginAt || null
            };
          })
        },
        kycStatus: adminApproved ? "verified" : "pending_review"
      } : {})
    };
    if (!adminApproved && currentTrustStatus !== "suspended" && targetPartner?.kycStatus !== "rejected") {
      update.kycStatus = targetPartner?.kycStatus || "pending_review";
    }

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
    emitAdminEvent(targetPartner ? "partner:updated" : "partner:registered", {
      partnerId: String(partner._id),
      partnerCode: partner.partnerCode || "",
      partnerName: partner.name || "",
      partnerPhone: partner.phone || "",
      email: partner.email || "",
      serviceCategory: partner.serviceCategory || [],
      status: partner.accountStatus || "active",
      isOnline: Boolean(partner.isOnline)
    });

    return res.json({ partner });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    let partner = await Partner.findOne({ firebaseUid: req.auth.uid })
      .select("_id firebaseUid partnerCode name phone email dateOfBirth gender residentialAddress city state pinCode emergencyContactNumber serviceCategory yearsOfExperience workingAreas languagesKnown serviceArea serviceRadiusKm photoUrl accountStatus phoneHash emailHash faceVerified selfieVerified aadhaarStatus kycStatus isVerified trustStatus fcmToken approvalVersion approvedAt rejectedAt rejectionReason businessType businessVerificationStatus laundryBusiness");
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
    if (partner) partner = await enforceCompanyServiceIsolation(partner);
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
      return res.status(400).json({ message: "Document file is required" });
    }

    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }
    const isLaundryDocument = body.documentType === "laundry_shop_license"
      || body.documentType === "laundry_staff_identity"
      || /^laundry_staff_\d+_identity$/.test(body.documentType);
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
        message: file.mimetype === "application/pdf"
          ? "The PDF document could not be validated. Upload a valid PDF."
          : "Document image is not clear enough. Retake a sharp photo.",
        documentId: document._id,
        validation
      });
    }

    const uploaded = await uploadDocumentToCloudinary(file, partner._id, body.documentType, req, "document");
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
    if (uploaded.partnerUploadAssetId) {
      await PartnerUploadAsset.findByIdAndUpdate(uploaded.partnerUploadAssetId, { $set: { documentId: document._id } });
    }

    const update = {};
    if (["id_proof", "aadhaar_front", "aadhaar_back"].includes(body.documentType)) {
      update.idProofUrl = uploaded.url;
      update.idProofStatus = validation.validationStatus === "accepted" ? "submitted" : "submitted";
      if (body.aadhaarLast4) update.aadhaarLast4 = body.aadhaarLast4;
      update.aadhaarStatus = validation.ocrStatus === "passed" && validation.validationStatus === "accepted" ? "verified" : "submitted";
      update.aadhaarVerified = update.aadhaarStatus === "verified";
    } else if (body.documentType === "pan_card") {
      update.idProofUrl = uploaded.url;
      update.idProofStatus = "submitted";
    } else if (body.documentType === "selfie_photo") {
      update.selfieUrl = uploaded.url;
      update.selfieVerified = false;
      update.faceVerified = false;
    } else if (["experience_certificate", "skill_certificate", "training_certificate", "government_license", "trade_license", "other_supporting_document"].includes(body.documentType)) {
      update.skillCertificateUrl = uploaded.url;
      update.skillCertificateStatus = "submitted";
    }
    update.kycStatus = isLaundryDocument ? "pending_review" : kycStatusFor(update, partner);
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
    const deviceToken = normalizeDeviceToken({
      token,
      platform: req.body?.platform || "android",
      deviceId: req.body?.deviceId || "",
      appType: "partner"
    });
    if (!deviceToken) {
      return res.status(400).json({ message: "Valid FCM token is required" });
    }
    const partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      {
        $setOnInsert: {
          firebaseUid: req.auth.uid,
          partnerCode: `ASP${Date.now().toString().slice(-6)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
          name: req.auth.name || "ApnaServo Partner",
          phone: normalizePhone(req.auth.phone_number || ""),
          email: normalizeEmail(req.auth.email || ""),
          city: "Guwahati"
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    upsertDeviceToken(partner, deviceToken);
    await partner.save();
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
            deviceTokens: [],
            isOnline: false
          },
        $setOnInsert: {
          firebaseUid: req.auth.uid,
          partnerCode: `ASP${Date.now().toString().slice(-6)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
          name: req.auth.name || "ApnaServo Partner",
          phone: normalizePhone(req.auth.phone_number || ""),
          email: normalizeEmail(req.auth.email || ""),
          serviceCategory: [],
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

function supportTicketCode() {
  return `PTK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
}

async function createSupportTicket(req, res, next) {
  try {
    const body = supportTicketSchema.parse(req.body || {});
    const partner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!partner) {
      return res.status(404).json({ message: "Partner profile not found" });
    }
    const now = new Date();
    const category = body.category || "Partner Verification Support";
    const attachments = body.attachmentUrl ? [{
      name: "partner-support-attachment",
      url: body.attachmentUrl,
      mimeType: "image/jpeg",
      uploadedAt: now
    }] : [];
    const ticket = await SupportTicket.create({
      ticketCode: supportTicketCode(),
      partnerId: partner._id,
      partnerName: partner.name || "",
      userName: partner.name || "",
      mobileNumber: partner.phone || "",
      email: partner.email || "",
      category,
      priority: body.priority || (category.toLowerCase().includes("verification") ? "high" : "normal"),
      status: "open",
      source: "partner_app",
      complaint: body.message,
      aiSummary: category.toLowerCase().includes("verification")
        ? "Partner verification related support request."
        : "Partner support request.",
      conversation: [{
        clientMessageId: body.clientMessageId || "",
        senderRole: "partner",
        senderName: partner.name || "ApnaServo Partner",
        message: body.message,
        attachments,
        createdAt: now
      }],
      attachments,
      timeline: [{ event: "ticket_created", by: "partner_app", note: category, at: now }],
      lastUpdatedAt: now
    });
    emitAdminEvent("support:ticket_created", {
      ticketId: ticket.ticketCode,
      partnerId: String(partner._id),
      partnerName: partner.name || "",
      priority: ticket.priority,
      status: ticket.status,
      category: ticket.category
    });
    return res.status(201).json({ ok: true, ticketId: ticket.ticketCode, ticket });
  } catch (error) {
    return next(error);
  }
}

async function setOnline(req, res, next) {
  try {
    const isOnline = req.path.includes("online");
    let partner = await Partner.findOneAndUpdate(
      { firebaseUid: req.auth.uid },
      { $set: { isOnline } },
      { new: true }
    );
    partner = await enforceCompanyServiceIsolation(partner);
    const dispatchedBookings = isOnline ? await dispatchPendingBookingsToPartner(partner) : 0;
    return res.json({ ok: true, partner, dispatchedBookings });
  } catch (error) {
    return next(error);
  }
}

async function staffJobsFor(partner, staff) {
  const categories = partnerDispatchCategories(partner);
  if (!categories.length) return [];
  return Booking.find({
    partnerId: partner._id,
    serviceCategory: { $in: categories },
    $or: [
      // Sequence is unique within the company. This remains stable even when a
      // staff member signs in later with a newly linked Firebase account.
      { "laundryAssignment.staffSequence": Number(staff.sequence || 0) },
      { "laundryAssignment.staffFirebaseUid": staff.firebaseUid },
      { "laundryAssignment.staffPhoneHash": staff.phoneHash },
      { "laundryAssignment.staffEmailHash": staff.emailHash }
    ]
  }).sort({ updatedAt: -1, createdAt: -1 }).limit(200);
}

async function staffSession(req, res, next) {
  try {
    let { partner, staff } = await findStaffContext(req);
    partner = await enforceCompanyServiceIsolation(partner);
    staff = (partner.laundryBusiness?.staffMembers || []).find((member) => Number(member.sequence) === Number(staff.sequence)) || staff;
    const fcmToken = String(req.body?.fcmToken || "").trim();
    if (fcmToken && fcmToken.length <= 4096) staff.fcmToken = fcmToken;
    staff.isOnline = req.body?.isOnline !== false;
    partner.markModified("laundryBusiness.staffMembers");
    await partner.save();
    const bookings = await staffJobsFor(partner, staff);
    return res.json({
      ok: true,
      sessionRole: "laundry_staff",
      staff: staffPublicProfile(partner, staff),
      bookings: bookings.map(serializeBooking)
    });
  } catch (error) {
    return next(error);
  }
}

async function listStaffBookings(req, res, next) {
  try {
    let { partner, staff, contextChanged } = await findStaffContext(req);
    partner = await enforceCompanyServiceIsolation(partner);
    staff = (partner.laundryBusiness?.staffMembers || []).find((member) => Number(member.sequence) === Number(staff.sequence)) || staff;
    if (contextChanged) {
      partner.markModified("laundryBusiness.staffMembers");
      await partner.save();
    }
    const bookings = await staffJobsFor(partner, staff);
    return res.json({
      staff: staffPublicProfile(partner, staff),
      bookings: bookings.map(serializeBooking)
    });
  } catch (error) {
    return next(error);
  }
}

async function setStaffOnline(req, res, next) {
  try {
    let { partner, staff } = await findStaffContext(req);
    partner = await enforceCompanyServiceIsolation(partner);
    staff = (partner.laundryBusiness?.staffMembers || []).find((member) => Number(member.sequence) === Number(staff.sequence)) || staff;
    staff.isOnline = req.body?.isOnline !== false;
    const fcmToken = String(req.body?.fcmToken || "").trim();
    if (fcmToken && fcmToken.length <= 4096) staff.fcmToken = fcmToken;
    partner.markModified("laundryBusiness.staffMembers");
    await partner.save();
    return res.json({ ok: true, staff: staffPublicProfile(partner, staff) });
  } catch (error) {
    return next(error);
  }
}

async function addLaundryStaff(req, res, next) {
  try {
    const body = laundryStaffInviteSchema.parse(req.body || {});
    let owner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!owner || owner.businessType !== "laundry" || owner.businessVerificationStatus !== "approved") {
      return res.status(403).json({ message: "Approved company owner access required" });
    }
    owner = await enforceCompanyServiceIsolation(owner);
    const serviceName = serviceLabel(isolatedCompanyCategories(owner)?.[0] || "service");
    const phone = normalizePhone(body.phone);
    const email = normalizeEmail(body.email);
    if (!phone && !email) return res.status(400).json({ message: "Staff phone number or email is required" });
    const phoneHash = identityHash(phone);
    const emailHash = identityHash(email);
    const duplicate = await Partner.exists({
      businessType: "laundry",
      $or: [
        ...(phoneHash ? [{ "laundryBusiness.staffMembers.phoneHash": phoneHash }] : []),
        ...(emailHash ? [{ "laundryBusiness.staffMembers.emailHash": emailHash }] : [])
      ]
    });
    if (duplicate) return res.status(409).json({ message: "This staff phone or email is already linked to another company" });
    const members = owner.laundryBusiness?.staffMembers || [];
    const sequence = members.reduce((max, member) => Math.max(max, Number(member.sequence || 0)), 0) + 1;
    members.push({
      sequence,
      name: body.name,
      phone,
      phoneHash,
      email,
      emailHash,
      role: body.role || `${serviceName} Staff`,
      idType: "Company ID",
      documentType: `laundry_staff_${sequence}_identity`,
      documentTitle: `${serviceName} Staff ${sequence} ID Proof`,
      verificationStatus: "verified",
      isOnline: false
    });
    owner.markModified("laundryBusiness.staffMembers");
    await owner.save();
    const staff = owner.laundryBusiness.staffMembers.find((member) => Number(member.sequence) === sequence);
    return res.status(201).json({
      ok: true,
      staff: staffPublicProfile(owner, staff),
      staffMembers: owner.laundryBusiness.staffMembers.map((member) => staffPublicProfile(owner, member))
    });
  } catch (error) {
    return next(error);
  }
}

async function ownerStaffContext(req) {
  let owner = await Partner.findOne({ firebaseUid: req.auth.uid });
  if (!owner || owner.businessType !== "laundry" || owner.businessVerificationStatus !== "approved") {
    const error = new Error("Approved company owner access required");
    error.status = 403;
    throw error;
  }
  owner = await enforceCompanyServiceIsolation(owner);
  const sequence = Number(req.params.staffSequence || 0);
  const staff = (owner.laundryBusiness?.staffMembers || []).find((member) => Number(member.sequence) === sequence);
  if (!staff) {
    const error = new Error("Company staff member not found");
    error.status = 404;
    throw error;
  }
  return { owner, staff, sequence };
}

async function uploadLaundryStaffPhoto(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: "Staff profile photo is required" });
    const { owner, staff, sequence } = await ownerStaffContext(req);
    const uploaded = await uploadDocumentToCloudinary(req.file, owner._id, `laundry_staff_${sequence}_photo`, req, "image");
    staff.photoUrl = uploaded.url;
    owner.markModified("laundryBusiness.staffMembers");
    await owner.save();
    return res.status(201).json({ ok: true, staff: staffPublicProfile(owner, staff) });
  } catch (error) {
    return next(error);
  }
}

async function uploadLaundryStaffIdentity(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ message: "Staff government ID is required" });
    const { owner, staff, sequence } = await ownerStaffContext(req);
    const documentType = `laundry_staff_${sequence}_identity`;
    const contentHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const uploaded = await uploadDocumentToCloudinary(req.file, owner._id, documentType, req, "document");
    const document = await PartnerDocument.create({
      partnerId: owner._id,
      documentType,
      originalName: req.file.originalname || "staff-government-id",
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      contentHash,
      ...uploaded,
      validationStatus: "review",
      validationScore: 100,
      validationReasons: ["manual_staff_id_review_required"],
      ocrStatus: "skipped"
    });
    staff.idType = String(req.body?.idType || "Government ID").trim().slice(0, 60) || "Government ID";
    staff.documentType = documentType;
    staff.documentTitle = req.file.originalname || `${serviceLabel(isolatedCompanyCategories(owner)?.[0] || "service")} Staff ${sequence} Government ID`;
    owner.markModified("laundryBusiness.staffMembers");
    await owner.save();
    return res.status(201).json({ ok: true, documentId: document._id, staff: staffPublicProfile(owner, staff) });
  } catch (error) {
    return next(error);
  }
}

async function assignLaundryStaff(req, res, next) {
  try {
    let owner = await Partner.findOne({ firebaseUid: req.auth.uid });
    if (!owner || owner.businessType !== "laundry" || owner.businessVerificationStatus !== "approved") {
      return res.status(403).json({ message: "Approved company owner access required" });
    }
    owner = await enforceCompanyServiceIsolation(owner);
    const sequence = Number(req.body?.staffSequence || 0);
    const staff = (owner.laundryBusiness?.staffMembers || []).find((member) => Number(member.sequence) === sequence);
    if (!staff || staff.verificationStatus !== "verified") {
      return res.status(404).json({ message: "Verified company staff member not found" });
    }
    const booking = await Booking.findOne(bookingIdentityFilter(req.params.bookingId));
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const allowedCategories = partnerDispatchCategories(owner);
    if (!allowedCategories.includes(normalizeServiceCategory(booking.serviceCategory))) {
      return res.status(403).json({ message: "This booking belongs to a different service category" });
    }
    const ownerId = String(owner._id);
    const currentPartnerId = String(booking.partnerId || "");
    const wasSentToOwner = (booking.requestedPartners || []).some((partnerId) => String(partnerId) === ownerId);
    if (currentPartnerId && currentPartnerId !== ownerId) {
      return res.status(403).json({ message: "This order belongs to another company" });
    }
    if (!currentPartnerId && !wasSentToOwner) {
      return res.status(403).json({ message: "This order was not sent to your company" });
    }
    if (["completed", "cancelled"].includes(booking.status)) {
      return res.status(409).json({ message: "Completed or cancelled bookings cannot be assigned" });
    }
    if (["in_progress", "completed"].includes(booking.laundryAssignment?.taskStatus)) {
      return res.status(409).json({ message: "A task already in progress cannot be reassigned" });
    }
    const acceptedDuringAssignment = !currentPartnerId;
    if (acceptedDuringAssignment) {
      booking.partnerId = owner._id;
      booking.status = "accepted";
      booking.acceptedAt = new Date();
      booking.statusTimeline.push({
        status: "accepted",
        at: booking.acceptedAt,
        by: "partner_owner",
        note: "Company accepted the booking while assigning staff"
      });
    }
    booking.laundryAssignment = {
      ownerPartnerId: owner._id,
      staffSequence: Number(staff.sequence || 0),
      staffName: staff.name || `${serviceLabel(isolatedCompanyCategories(owner)?.[0] || "service")} Staff`,
      staffPhoneHash: staff.phoneHash || identityHash(normalizePhone(staff.phone)),
      staffEmailHash: staff.emailHash || identityHash(normalizeEmail(staff.email)),
      staffFirebaseUid: staff.firebaseUid || "",
      taskStatus: "assigned",
      assignedAt: new Date(),
      startedAt: null,
      completedAt: null
    };
    await booking.save();
    if (acceptedDuringAssignment) emitBookingAccepted(booking, owner);
    emitLaundryStaffAssignment(booking, owner, staff);
    if (staff.fcmToken) {
      await reliableNotify({
        recipients: [{
          role: "partner",
          partnerId: owner._id,
          firebaseUid: staff.firebaseUid || "",
          token: staff.fcmToken,
          phone: staff.phone
        }],
        title: "New Service Task Assigned",
        body: `${owner.laundryBusiness?.shopName || "Your company"} assigned booking ${booking.bookingCode}`,
        category: "laundry_staff_assignment",
        priority: "high",
        data: {
          type: "laundry:staff_assignment",
          targetApp: "partner",
          actionType: "OPEN_LAUNDRY_JOB",
          bookingId: String(booking._id),
          bookingCode: booking.bookingCode
        }
      });
    }
    return res.json({ ok: true, booking: serializeBooking(booking), staff: staffPublicProfile(owner, staff) });
  } catch (error) {
    return next(error);
  }
}

async function updateStaffBookingStatus(req, res, next) {
  try {
    const { partner, staff, contextChanged } = await findStaffContext(req);
    if (contextChanged) {
      partner.markModified("laundryBusiness.staffMembers");
      await partner.save();
    }
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (!["in_progress", "completed"].includes(status)) {
      return res.status(400).json({ message: "Invalid Laundry task status" });
    }
    const booking = await Booking.findOne({
      ...bookingIdentityFilter(req.params.bookingId),
      partnerId: partner._id,
      $or: [
        { "laundryAssignment.staffSequence": Number(staff.sequence || 0) },
        { "laundryAssignment.staffFirebaseUid": staff.firebaseUid },
        { "laundryAssignment.staffPhoneHash": staff.phoneHash },
        { "laundryAssignment.staffEmailHash": staff.emailHash }
      ]
    });
    if (!booking) return res.status(404).json({ message: "Assigned Laundry order not found" });
    const current = booking.laundryAssignment?.taskStatus || "assigned";
    if (status === "in_progress" && !["assigned", "in_progress"].includes(current)) {
      return res.status(409).json({ message: "Only assigned tasks can be started" });
    }
    if (status === "completed" && !["in_progress", "completed"].includes(current)) {
      return res.status(409).json({ message: "Start the task before completing it" });
    }
    booking.laundryAssignment.taskStatus = status;
    if (status === "in_progress" && !booking.laundryAssignment.startedAt) {
      booking.laundryAssignment.startedAt = new Date();
    }
    if (status === "completed" && !booking.laundryAssignment.completedAt) {
      booking.laundryAssignment.completedAt = new Date();
    }
    await booking.save();
    return res.json({ ok: true, booking: serializeBooking(booking) });
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
  uploadProfilePhoto,
  saveFcmToken,
  createSupportTicket,
  requestDeletion,
  setOnline,
  staffSession,
  listStaffBookings,
  setStaffOnline,
  addLaundryStaff,
  uploadLaundryStaffPhoto,
  uploadLaundryStaffIdentity,
  assignLaundryStaff,
  updateStaffBookingStatus,
  updateLocation,
  statement
};
