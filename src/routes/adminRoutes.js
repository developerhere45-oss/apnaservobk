const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/adminController");

router.use(verifyFirebaseToken);
router.get("/dashboard", controller.dashboard);

module.exports = router;
