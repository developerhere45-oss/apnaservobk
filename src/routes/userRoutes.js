const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/userController");

router.use(verifyFirebaseToken);
router.post("/profile", controller.upsertProfile);
router.get("/me", controller.me);
router.post("/fcm-token", controller.saveFcmToken);

module.exports = router;
