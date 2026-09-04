const router = require("express").Router();
const { verifyFirebaseToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/invoiceController");

router.use(verifyFirebaseToken);
router.get("/:invoiceId", controller.getInvoice);
router.get("/:invoiceId/pdf", controller.downloadInvoice);

module.exports = router;
