const nodemailer = require("nodemailer");

let transporter;

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function mailer() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
      greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
      socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000)
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function layout(name, heading, message, detail) {
  return `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#172033">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:32px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:auto;background:#fff;border-radius:16px;overflow:hidden">
        <tr><td style="background:#ef255b;color:#fff;padding:24px 32px;font-size:24px;font-weight:700">ApnaServo</td></tr>
        <tr><td style="padding:32px"><h1 style="margin:0 0 18px;font-size:26px">${escapeHtml(heading)}</h1>
          <p style="font-size:16px;line-height:1.6">Hi ${escapeHtml(name || "there")},</p>
          <p style="font-size:16px;line-height:1.6">${escapeHtml(message)}</p>
          ${detail ? `<p style="padding:14px 16px;background:#fff3f6;border-radius:10px;line-height:1.5">${escapeHtml(detail)}</p>` : ""}
          <p style="font-size:14px;color:#667085;margin-top:28px">Need help? Contact ApnaServo support.</p>
        </td></tr>
      </table>
    </td></tr></table></body></html>`;
}

async function sendWelcomeEmail({ to, name, audience, companyName }) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!recipient || !smtpConfigured()) return { sent: false, skipped: true };

  const content = audience === "customer"
    ? { subject: "Welcome to ApnaServo", heading: "Welcome to ApnaServo!", message: "Your account has been created successfully. You can now discover and book trusted services from the ApnaServo app." }
    : audience === "staff"
      ? { subject: `Welcome to ${companyName || "ApnaServo"}`, heading: "Welcome to the team!", message: `You have been added as a staff member${companyName ? ` at ${companyName}` : ""}. Your staff profile is verified and ready to use.` }
      : { subject: "Your ApnaServo partner account is verified", heading: "Verification complete!", message: "Welcome to ApnaServo. Your partner profile has been approved and is ready to receive bookings." };

  try {
    const info = await mailer().sendMail({
      from: process.env.MAIL_FROM || `ApnaServo <${process.env.SMTP_USER}>`,
      replyTo: process.env.MAIL_REPLY_TO || undefined,
      to: recipient,
      subject: content.subject,
      text: `Hi ${name || "there"},\n\n${content.message}\n\nNeed help? Contact ApnaServo support.`,
      html: layout(name, content.heading, content.message)
    });
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error("Welcome email delivery failed", { audience, recipient, message: error.message });
    return { sent: false, error: error.message };
  }
}

async function sendPartnerApprovalWelcomeEmails(partner) {
  let changed = false;
  const approvalVersion = Number(partner.approvalVersion || 0);
  if (partner.email && Number(partner.approvalEmailSentVersion || 0) < approvalVersion) {
    const ownerResult = await sendWelcomeEmail({ to: partner.email, name: partner.name, audience: "partner" });
    if (ownerResult.sent) {
      partner.welcomeEmailSentAt = partner.welcomeEmailSentAt || new Date();
      partner.approvalEmailSentVersion = approvalVersion;
      changed = true;
    }
  }

  const companyName = partner.laundryBusiness?.shopName || `${partner.name || "ApnaServo"} Company`;
  for (const staff of partner.laundryBusiness?.staffMembers || []) {
    if (!staff.email || staff.welcomeEmailSentAt || staff.verificationStatus !== "verified") continue;
    const staffResult = await sendWelcomeEmail({
      to: staff.email,
      name: staff.name,
      audience: "staff",
      companyName
    });
    if (staffResult.sent) {
      staff.welcomeEmailSentAt = new Date();
      changed = true;
    }
  }

  if (changed) {
    partner.markModified("laundryBusiness.staffMembers");
    await partner.save();
  }
  return { changed };
}

module.exports = { sendPartnerApprovalWelcomeEmails, sendWelcomeEmail, smtpConfigured };
