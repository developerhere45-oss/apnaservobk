const router = require("express").Router();
const { authEmployee, checkChatAssignment, requirePermission } = require("../middleware/authMiddleware");
const { loginLimiter } = require("../middleware/securityRateLimits");
const auth = require("../controllers/roleAuthController");
const controller = require("../controllers/employeeController");

router.post("/login", loginLimiter, auth.loginEmployee);
router.post("/logout", auth.logout);

router.use(authEmployee);
router.get("/me", auth.employeeMe);
router.patch("/change-password", auth.changeEmployeePassword);
router.get("/dashboard", requirePermission("viewDashboard"), controller.dashboard);

router.get("/bookings", requirePermission("viewBookings"), controller.listBookings);
router.get("/bookings/:id", requirePermission("viewBookings"), controller.getBooking);
router.patch("/bookings/:id/status", requirePermission("updateBookingStatus"), controller.updateBookingStatus);
router.post("/bookings/:id/note", requirePermission("viewBookings"), controller.addBookingNote);

router.get("/partners", requirePermission("viewPartners"), controller.listPartners);
router.get("/partners/:id", requirePermission("viewPartners"), controller.getPartner);
router.post("/partners/:id/note", requirePermission("viewPartners"), controller.addPartnerNote);
router.patch("/partners/:id/verification", requirePermission("approvePartners"), controller.updatePartnerVerification);

router.get("/users", requirePermission("viewUsers"), controller.listUsers);
router.get("/users/:id", requirePermission("viewUsers"), controller.getUser);
router.post("/users/:id/note", requirePermission("viewUsers"), controller.addUserNote);

router.get("/chats", requirePermission("handleChats"), controller.listChats);
router.get("/chats/:chatId", requirePermission("handleChats"), checkChatAssignment, controller.getChat);
router.post("/chats/:chatId/messages", requirePermission("handleChats"), checkChatAssignment, controller.sendChatMessage);
router.patch("/chats/:chatId/status", requirePermission("handleChats"), checkChatAssignment, controller.updateChatStatus);
router.post("/chats/:chatId/request-transfer", requirePermission("handleChats"), checkChatAssignment, controller.requestTransfer);
router.post("/chats/:chatId/note", requirePermission("handleChats"), checkChatAssignment, controller.addChatNote);

module.exports = router;
