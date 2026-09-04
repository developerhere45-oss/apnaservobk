const PDFDocument = require("pdfkit");
const mongoose = require("mongoose");
const User = require("../models/User");
const Partner = require("../models/Partner");
const Invoice = require("../models/Invoice");

async function authorizedInvoice(req, res) {
  const identity = String(req.params.invoiceId || "");
  const identifiers = [{ invoiceNumber: identity }];
  if (mongoose.Types.ObjectId.isValid(identity)) {
    identifiers.push({ _id: identity }, { bookingId: identity });
  }
  const invoice = await Invoice.findOne({
    $or: identifiers
  });
  if (!invoice) {
    res.status(404).json({ message: "Invoice not found" });
    return null;
  }
  const [user, partner] = await Promise.all([
    User.findOne({ firebaseUid: req.auth.uid }).select("_id"),
    Partner.findOne({ firebaseUid: req.auth.uid }).select("_id")
  ]);
  const owns = user && String(user._id) === String(invoice.userId);
  const assigned = partner && String(partner._id) === String(invoice.partnerId || "");
  if (!owns && !assigned) {
    res.status(403).json({ message: "Not allowed to access this invoice" });
    return null;
  }
  return invoice;
}

function serialize(invoice) {
  const doc = invoice.toObject();
  return {
    id: String(doc._id), invoiceNumber: doc.invoiceNumber, bookingId: String(doc.bookingId),
    bookingCode: doc.bookingCode, paymentId: String(doc.paymentId), serviceDescription: doc.serviceDescription,
    serviceAmount: doc.serviceAmount, additionalCharges: doc.additionalCharges, discount: doc.discount,
    tax: doc.tax, finalAmount: doc.finalAmount, currency: doc.currency, paymentStatus: doc.paymentStatus,
    paymentMethod: doc.paymentMethod, transactionId: doc.transactionId, paidAt: doc.paidAt,
    customerName: doc.customerName, customerPhone: doc.customerPhone, serviceAddress: doc.serviceAddress,
    partnerName: doc.partnerName, invoiceDate: doc.createdAt
  };
}

async function getInvoice(req, res, next) {
  try {
    const invoice = await authorizedInvoice(req, res);
    if (!invoice) return;
    return res.json({ invoice: serialize(invoice) });
  } catch (error) { return next(error); }
}

function money(value) { return `INR ${Number(value || 0).toFixed(2)}`; }

async function downloadInvoice(req, res, next) {
  try {
    const invoice = await authorizedInvoice(req, res);
    if (!invoice) return;
    const data = serialize(invoice);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=ApnaServo-${data.invoiceNumber}.pdf`);
    const pdf = new PDFDocument({ size: "A4", margin: 52, info: { Title: `Invoice ${data.invoiceNumber}` } });
    pdf.pipe(res);
    pdf.font("Helvetica-Bold").fontSize(20).text("APNASERVO", { align: "center" });
    pdf.fontSize(13).text("SERVICE INVOICE", { align: "center" }).moveDown(2);
    pdf.font("Helvetica").fontSize(10);
    pdf.text(`Invoice No: ${data.invoiceNumber}`).text(`Booking ID: ${data.bookingCode || data.bookingId}`)
      .text(`Invoice Date: ${new Date(data.invoiceDate).toLocaleDateString("en-IN")}`).moveDown();
    pdf.moveTo(52, pdf.y).lineTo(543, pdf.y).strokeColor("#777777").stroke().moveDown();
    pdf.font("Helvetica-Bold").text("BILLED TO").font("Helvetica")
      .text(data.customerName).text(data.customerPhone).text(data.serviceAddress).moveDown();
    pdf.font("Helvetica-Bold").text("SERVICE PROVIDER").font("Helvetica").text(data.partnerName).moveDown();
    const row = (label, value, bold = false) => {
      pdf.font(bold ? "Helvetica-Bold" : "Helvetica").text(label, 52, pdf.y, { continued: true, width: 360 })
        .text(money(value), { align: "right", width: 130 });
    };
    pdf.moveTo(52, pdf.y).lineTo(543, pdf.y).stroke().moveDown(0.5);
    row(data.serviceDescription, data.serviceAmount);
    if (data.additionalCharges > 0) row("Additional Charges", data.additionalCharges);
    if (data.discount > 0) row("Discount", -data.discount);
    if (data.tax > 0) row("Tax", data.tax);
    pdf.moveDown(0.5).moveTo(52, pdf.y).lineTo(543, pdf.y).stroke().moveDown(0.5);
    row("TOTAL", data.finalAmount, true);
    pdf.moveDown().text(`Payment Status: ${data.paymentStatus.toUpperCase()}`)
      .text(`Payment Method: ${data.paymentMethod || "N/A"}`).text(`Transaction ID: ${data.transactionId || "N/A"}`)
      .text(`Payment Date: ${data.paidAt ? new Date(data.paidAt).toLocaleString("en-IN") : "N/A"}`).moveDown(2);
    pdf.text("Thank you for choosing ApnaServo.", { align: "center" }).text("apnaservo.com", { align: "center" });
    pdf.end();
  } catch (error) { return next(error); }
}

module.exports = { getInvoice, downloadInvoice };
