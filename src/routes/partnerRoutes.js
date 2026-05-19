const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/partnerController");

router.use(verifyFirebaseToken);
router.post("/profile", controller.upsertProfile);
router.get("/me", controller.me);
router.post("/fcm-token", controller.saveFcmToken);
router.post("/online", controller.setOnline);
router.post("/offline", controller.setOnline);
router.patch("/location", controller.updateLocation);

module.exports = router;
