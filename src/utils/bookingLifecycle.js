const LIFECYCLE_STATUSES = [
  "draft",
  "pending",
  "quoted",
  "negotiating",
  "confirmed",
  "technician_assigned",
  "on_the_way",
  "arrived",
  "work_started",
  "work_completed",
  "payment_pending",
  "completed",
  "cancelled",
  "refunded",
  "disputed"
];

const BOOKING_STATUSES = [
  ...LIFECYCLE_STATUSES,
  "sent_to_partner",
  "accepted",
  "rejected",
  "started",
  "amount_pending",
  "customer_no_response"
];

const TERMINAL_BOOKING_STATUSES = [
  "completed",
  "cancelled",
  "refunded",
  "disputed",
  "customer_no_response"
];

const STORAGE_STATUS_ALIASES = {
  booked: "accepted",
  assigned: "accepted",
  partner_assigned: "accepted",
  technician_assigned: "accepted",
  confirmed: "accepted",
  work_started: "started",
  work_completed: "amount_pending",
  payment_pending: "amount_pending",
  quoted: "amount_pending",
  negotiating: "amount_pending"
};

const PARTNER_STATUS_RANK = {
  accepted: 1,
  on_the_way: 2,
  arrived: 3,
  started: 4,
  amount_pending: 5,
  completed: 6
};

const LIFECYCLE_LABELS = {
  draft: "Draft",
  pending: "Pending",
  quoted: "Quoted",
  negotiating: "Negotiating",
  confirmed: "Confirmed",
  technician_assigned: "Technician Assigned",
  on_the_way: "On The Way",
  arrived: "Arrived",
  work_started: "Work Started",
  work_completed: "Work Completed",
  payment_pending: "Payment Pending",
  completed: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded",
  disputed: "Disputed"
};

function normalizeStatusKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function normalizeBookingStatusInput(value) {
  const normalized = normalizeStatusKey(value);
  const storageStatus = STORAGE_STATUS_ALIASES[normalized] || normalized;
  return BOOKING_STATUSES.includes(storageStatus) ? storageStatus : "";
}

function lifecycleStatusForBooking(booking) {
  const rawStatus = normalizeStatusKey(booking?.status);
  const quoteStatus = normalizeStatusKey(booking?.quoteStatus);
  const paymentStatus = normalizeStatusKey(booking?.paymentStatus);

  if (rawStatus === "sent_to_partner" || rawStatus === "pending") {
    return "pending";
  }
  if (rawStatus === "accepted") {
    return "technician_assigned";
  }
  if (rawStatus === "started") {
    return "work_started";
  }
  if (rawStatus === "amount_pending") {
    if (quoteStatus === "countered") {
      return "negotiating";
    }
    if (quoteStatus === "pending") {
      return "payment_pending";
    }
    return "work_completed";
  }
  if (rawStatus === "customer_no_response" || rawStatus === "rejected") {
    return "cancelled";
  }
  if (rawStatus === "completed" && paymentStatus === "refunded") {
    return "refunded";
  }
  if (LIFECYCLE_STATUSES.includes(rawStatus)) {
    return rawStatus;
  }
  return "pending";
}

function lifecycleLabel(status) {
  return LIFECYCLE_LABELS[status] || LIFECYCLE_LABELS.pending;
}

function pendingAssignmentStatuses() {
  return ["pending", "sent_to_partner"];
}

function activeJobStatuses() {
  return ["accepted", "on_the_way", "arrived", "started", "amount_pending"];
}

function isTerminalBookingStatus(value) {
  const status = normalizeBookingStatusInput(value) || normalizeStatusKey(value);
  return TERMINAL_BOOKING_STATUSES.includes(status);
}

function transitionDecision({ currentStatus, nextStatus, actorRole, quoteStatus }) {
  const current = normalizeBookingStatusInput(currentStatus) || normalizeStatusKey(currentStatus);
  const next = normalizeBookingStatusInput(nextStatus) || normalizeStatusKey(nextStatus);
  const actor = normalizeStatusKey(actorRole);
  const quote = normalizeStatusKey(quoteStatus);

  if (!BOOKING_STATUSES.includes(current)) {
    return { ok: false, reason: "Current booking status is invalid" };
  }
  if (!BOOKING_STATUSES.includes(next)) {
    return { ok: false, reason: "Requested booking status is invalid" };
  }

  if (current === next) {
    if (next === "amount_pending" && ["countered", "rejected", "expired"].includes(quote)) {
      return { ok: true, revisedQuote: true };
    }
    return { ok: true, idempotent: true };
  }

  if (isTerminalBookingStatus(current)) {
    return { ok: false, reason: `Booking is already ${current.replace(/_/g, " ")}` };
  }

  if (actor === "partner") {
    if (next === "cancelled") {
      return ["accepted", "on_the_way", "arrived"].includes(current)
        ? { ok: true }
        : { ok: false, reason: "Booking cannot be cancelled after work starts" };
    }

    const currentRank = PARTNER_STATUS_RANK[current] || 0;
    const nextRank = PARTNER_STATUS_RANK[next] || 0;
    if (currentRank && nextRank) {
      if (nextRank < currentRank) {
        return { ok: true, idempotent: true, alreadyAdvanced: true };
      }
      if (nextRank > currentRank + 1) {
        return { ok: false, reason: `Refresh booking before moving from ${current} to ${next}` };
      }
      if (next === "amount_pending" && current !== "started") {
        return { ok: false, reason: "Service must be started before sending final amount" };
      }
      if (next === "completed" && current !== "amount_pending") {
        return { ok: false, reason: "Customer payment confirmation is pending" };
      }
      if (current === "amount_pending" && next === "completed" && quote !== "payment_submitted") {
        return { ok: false, reason: "Customer payment confirmation is pending" };
      }
      return { ok: true };
    }

    return { ok: false, reason: `Partner cannot move booking from ${current} to ${next}` };
  }

  if (actor === "user") {
    if (next === "cancelled") {
      const cancellable = ["pending", "sent_to_partner", "accepted", "on_the_way", "arrived"];
      return cancellable.includes(current)
        ? { ok: true }
        : { ok: false, reason: "Booking cannot be cancelled after work starts" };
    }
    if (next === "completed") {
      return current === "amount_pending"
        ? { ok: true }
        : { ok: false, reason: "Customer can complete only after partner sends a quote" };
    }
    if (next === "disputed") {
      return ["amount_pending", "completed"].includes(current)
        ? { ok: true }
        : { ok: false, reason: "Dispute can be opened only for a quoted or completed booking" };
    }
  }

  return { ok: false, reason: `Booking cannot move from ${current} to ${next}` };
}

module.exports = {
  BOOKING_STATUSES,
  LIFECYCLE_STATUSES,
  TERMINAL_BOOKING_STATUSES,
  activeJobStatuses,
  isTerminalBookingStatus,
  lifecycleLabel,
  lifecycleStatusForBooking,
  normalizeBookingStatusInput,
  pendingAssignmentStatuses,
  transitionDecision
};
