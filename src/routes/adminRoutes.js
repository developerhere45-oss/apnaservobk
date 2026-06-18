const router = require("express").Router();
const { verifyAdminSecret } = require("../middleware/authMiddleware");
const controller = require("../controllers/adminController");

router.use(verifyAdminSecret);
router.get("/dashboard", controller.dashboard);
router.post("/actions", controller.performAdminAction);
router.get("/review-disputes", controller.listReviewDisputes);
router.patch("/review-disputes/:disputeId", controller.resolveReviewDispute);
router.get("/:resource", controller.listResourceRows);

module.exports = router;
