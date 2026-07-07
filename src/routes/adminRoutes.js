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

router.get("/notifications/assets/:assetId", notifications.asset);
router.get("/partners/assets/:assetId", controller.partnerUploadAsset);
router.post("/login", loginLimiter, roleAuth.loginAdmin);
router.post("/logout", roleAuth.logout);
router.get("/me", authAdminJwt, roleAuth.adminMe);
router.patch("/change-password", authAdminJwt, roleAuth.changeAdminPassword);
router.use(verifyAdminSecret);
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
router.get("/activity", controller.listAdminActivity);
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
router.get("/partners/:partnerId", controller.partnerProfile);
router.patch("/partners/:partnerId/documents/:documentId", controller.updatePartnerDocument);
router.get("/bookings/:bookingId/timeline", controller.bookingTimelineDetails);
router.get("/support-tickets", controller.listSupportTickets);
router.post("/support-tickets", controller.createSupportTicket);
router.get("/support-tickets/:ticketId", controller.supportTicketDetails);
router.patch("/support-tickets/:ticketId", controller.updateSupportTicket);
router.get("/review-disputes", controller.listReviewDisputes);
router.patch("/review-disputes/:disputeId", controller.resolveReviewDispute);
router.get("/:resource", controller.listResourceRows);

module.exports = router;
