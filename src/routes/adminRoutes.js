const router = require("express").Router();
const multer = require("multer");
const { verifyAdminSecret } = require("../middleware/authMiddleware");
const { authAdminJwt } = require("../middleware/authMiddleware");
const { adminNotificationLimiter, loginLimiter } = require("../middleware/securityRateLimits");
const { validateUploadedImage } = require("../utils/uploadSecurity");
const controller = require("../controllers/adminController");
const notifications = require("../controllers/adminNotificationController");
const roleAuth = require("../controllers/roleAuthController");
const employees = require("../controllers/adminEmployeeController");
const chats = require("../controllers/adminChatController");
const appControl = require("../controllers/appControlController");
const serviceChecklists = require("../controllers/serviceChecklistController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) {
      return callback(null, true);
    }
    const error = new Error("Only JPG, PNG, or WebP notification images are allowed");
    error.status = 415;
    return callback(error);
  }
});
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.mimetype)) return callback(null, true);
    const error = new Error("Only JPG, PNG, or WebP media images are allowed");
    error.status = 415;
    return callback(error);
  }
});

router.get("/notifications/assets/:assetId", notifications.asset);
router.get("/control-center/media/assets/:assetId", appControl.mediaAsset);
router.get("/partners/assets/:assetId", controller.partnerUploadAsset);
router.post("/login", loginLimiter, roleAuth.loginAdmin);
router.post("/logout", roleAuth.logout);
router.get("/me", authAdminJwt, roleAuth.adminMe);
router.patch("/change-password", authAdminJwt, roleAuth.changeAdminPassword);
router.use(verifyAdminSecret);
router.get("/control-center", appControl.overview);
router.post("/control-center/media/upload", mediaUpload.single("image"), validateUploadedImage(["image/jpeg", "image/png", "image/webp"]), appControl.uploadMedia);
router.patch("/control-center/draft", appControl.saveDraft);
router.post("/control-center/publish", appControl.publish);
router.post("/control-center/open-bookings", appControl.openBookings);
router.post("/control-center/rollback/:activityId", appControl.rollback);
router.post("/control-center/reset-draft", appControl.resetDraft);
router.patch("/control-center/services/:category", appControl.saveServiceAvailability);
router.get("/control-center/audit-logs", appControl.auditLogs);
router.get("/control-center/:kind", appControl.listItems);
router.post("/control-center/:kind", appControl.createItem);
router.patch("/control-center/:kind/:id", appControl.updateItem);
router.delete("/control-center/:kind/:id", appControl.deleteItem);
router.get("/employees", employees.listEmployees);
router.post("/employees", employees.createEmployee);
router.get("/employees/:id", employees.getEmployee);
router.put("/employees/:id", employees.updateEmployee);
router.patch("/employees/:id/status", employees.updateEmployeeStatus);
router.patch("/employees/:id/reset-password", employees.resetEmployeePassword);
router.get("/employees/:id/activity", employees.employeeActivity);
router.get("/chats", chats.listChats);
router.get("/chats/:chatId", chats.getChat);
router.post("/chats/:chatId/assign", chats.assignChat);
router.patch("/chats/:chatId/transfer", chats.transferChat);
router.patch("/chats/:chatId/remove-assignment", chats.removeAssignment);
router.patch("/chats/:chatId/priority", chats.updatePriority);
router.patch("/chats/:chatId/close", chats.closeChat);
router.patch("/chats/:chatId/status", chats.updateStatus);
router.post("/chats/:chatId/note", chats.addNote);
router.get("/chats/:chatId/assignment-history", chats.assignmentHistory);
router.get("/dashboard", controller.dashboard);
router.get("/service-work/checklists", serviceChecklists.list);
router.put("/service-work/checklists/:serviceCategory", serviceChecklists.save);
router.get("/service-work/reports", serviceChecklists.reports);
router.get("/activity", controller.listAdminActivity);
router.get("/settings/booking-launch", controller.bookingLaunchSettings);
router.patch("/settings/booking-launch", controller.updateBookingLaunchSettings);
router.post("/actions", controller.performAdminAction);
router.delete("/reset-platform-data", controller.resetPlatformData);
router.post("/notifications/send", adminNotificationLimiter, notifications.send);
router.post("/notifications/schedule", adminNotificationLimiter, notifications.schedule);
router.get("/notifications/history", notifications.history);
router.get("/notifications/search-recipients", notifications.searchRecipients);
router.post("/notifications/upload-image", adminNotificationLimiter, upload.single("image"), validateUploadedImage(["image/jpeg", "image/png", "image/webp"]), notifications.uploadImage);
router.get("/notifications/:notificationId", notifications.details);
router.delete("/notifications/:notificationId", adminNotificationLimiter, notifications.remove);
router.post("/notifications/:notificationId/cancel", adminNotificationLimiter, notifications.cancel);
router.post("/notifications/:notificationId/resend", adminNotificationLimiter, notifications.resend);
router.get("/smart-assignment", controller.smartAssignmentDashboard);
router.post("/smart-assignment/assign", controller.smartAssignBooking);
router.post("/smart-assignment/bulk-assign", controller.smartBulkAssignPending);
router.get("/users/control-center", controller.usersControlCenter);
router.get("/users/:userId", controller.userProfile);
router.patch("/users/:userId", controller.updateUserAdminState);
router.post("/partners", controller.createPartner);
router.get("/partners/:partnerId", controller.partnerProfile);
router.patch("/partners/:partnerId/documents/:documentId", controller.updatePartnerDocument);
router.get("/bookings/:bookingId/timeline", controller.bookingTimelineDetails);
router.patch("/bookings/:bookingId/location", controller.updateBookingLocation);
router.get("/support-tickets", controller.listSupportTickets);
router.post("/support-tickets", controller.createSupportTicket);
router.get("/support-tickets/:ticketId", controller.supportTicketDetails);
router.patch("/support-tickets/:ticketId", controller.updateSupportTicket);
router.get("/review-disputes", controller.listReviewDisputes);
router.patch("/review-disputes/:disputeId", controller.resolveReviewDispute);
router.get("/:resource", controller.listResourceRows);

module.exports = router;
