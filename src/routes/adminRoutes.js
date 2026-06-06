const router = require("express").Router();
const { verifyAdminAccess } = require("../middleware/authMiddleware");
const controller = require("../controllers/adminController");

router.use(verifyAdminAccess);
router.get("/dashboard", controller.dashboard);
router.get("/:resource", controller.resource);
router.post("/actions", controller.action);

module.exports = router;
