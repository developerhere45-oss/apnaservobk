const router = require("express").Router();
const { verifyAdminSecret } = require("../middleware/authMiddleware");
const controller = require("../controllers/adminController");

router.use(verifyAdminSecret);
router.get("/dashboard", controller.dashboard);
router.get("/activity", controller.listAdminActivity);
router.post("/actions", controller.performAdminAction);
router.get("/users/control-center", controller.usersControlCenter);
router.get("/users/:userId", controller.userProfile);
router.patch("/users/:userId", controller.updateUserAdminState);
router.get("/bookings/:bookingId/timeline", controller.bookingTimelineDetails);
router.get("/support-tickets", controller.listSupportTickets);
router.post("/support-tickets", controller.createSupportTicket);
router.get("/support-tickets/:ticketId", controller.supportTicketDetails);
router.patch("/support-tickets/:ticketId", controller.updateSupportTicket);
router.get("/review-disputes", controller.listReviewDisputes);
router.patch("/review-disputes/:disputeId", controller.resolveReviewDispute);
router.get("/:resource", controller.listResourceRows);

module.exports = router;
