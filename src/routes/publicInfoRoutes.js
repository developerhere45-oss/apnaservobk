const router = require("express").Router();

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#172029}h1,h2{color:#d9164f}small{color:#687078}</style></head><body>${body}</body></html>`;
}

router.get("/privacy-policy", (req, res) => {
  res.type("html").send(page("ApnaServo Privacy Policy", `
    <h1>ApnaServo Privacy Policy</h1><small>Effective: 16 August 2026</small>
    <p>ApnaServo provides customer booking, location, communication and service-status features.</p>
    <h2>Information we process</h2><p>Name, verified phone number, optional email, service address and precise location when you choose location access, booking and quote history, support and booking-chat messages, and notification device tokens.</p>
    <h2>How we use information</h2><p>We use this information only to authenticate customers, arrange and fulfil services, connect customers with assigned partners, provide support, prevent fraud, send requested booking updates, and meet legal obligations. We do not use this information for cross-app tracking or advertising.</p>
    <h2>Sharing</h2><p>Information needed to fulfil a booking may be shared with the assigned service partner and infrastructure providers that operate authentication, messaging, hosting and notifications. We do not sell personal information.</p>
    <h2>Location and notifications</h2><p>Location is requested only to set a service address and find nearby partners; manual address entry is available. Notifications are optional and can be disabled in iPhone Settings.</p>
    <h2>Retention and deletion</h2><p>Customers can permanently delete their account in Profile → Legal &amp; Account → Delete Account. Profile data, saved addresses, device tokens and personal conversations are deleted. Booking records retained for legal, fraud-prevention or transaction obligations are de-identified.</p>
    <h2>Security and support</h2><p>Data is transmitted over HTTPS and access is authenticated. For privacy questions or support, open ApnaServo and choose Profile → Help &amp; Support.</p>
  `));
});

router.get("/support", (req, res) => {
  res.type("html").send(page("ApnaServo Support", `
    <h1>ApnaServo Support</h1>
    <p>For booking, account, payment-quote, cancellation, privacy or technical help, open the ApnaServo iOS app and choose <strong>Profile → Help &amp; Support</strong>.</p>
    <p>Your message creates a secure support ticket linked to your authenticated account. Do not include OTPs, card PINs or passwords.</p>
    <p>Account deletion is available directly in the app under <strong>Profile → Legal &amp; Account → Delete Account</strong>.</p>
  `));
});

module.exports = router;
