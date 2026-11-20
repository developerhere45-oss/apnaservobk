const OMNIDIM_DISPATCH_URL = "https://omnidim.io/api/v1/calls/dispatch";

function configured() {
  return Boolean(String(process.env.OMNIDIM_API_KEY || "").trim()
    && String(process.env.OMNIDIM_AGENT_ID || "").trim());
}

function safeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function dispatchAssistanceCall({ toNumber, userName, serviceIds, userId, idempotencyKey }) {
  const apiKey = String(process.env.OMNIDIM_API_KEY || "").trim();
  const agentId = safeInteger(process.env.OMNIDIM_AGENT_ID);
  if (!apiKey || !agentId) {
    const error = new Error("OmniDimension assistance calls are not configured");
    error.status = 503;
    throw error;
  }

  const fromNumberId = safeInteger(process.env.OMNIDIM_FROM_NUMBER_ID);
  const payload = {
    agent_id: agentId,
    to_number: toNumber,
    call_context: {
      user_name: String(userName || "Customer").slice(0, 120),
      reason: "The customer opted in for help after exploring ApnaServo services.",
      services_explored: serviceIds.join(", ").slice(0, 500)
    },
    metadata: {
      user_id: String(userId),
      source: "apnaservo_android_engagement"
    },
    __languages: ["Hindi", "English"]
  };
  if (fromNumberId) payload.from_number_id = fromNumberId;

  let response;
  try {
    response = await fetch(OMNIDIM_DISPATCH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    });
  } catch (cause) {
    const error = new Error("OmniDimension could not be reached");
    error.status = 502;
    error.cause = cause;
    throw error;
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) {
    const error = new Error("OmniDimension rejected the assistance call");
    error.status = 502;
    error.providerStatus = response.status;
    throw error;
  }
  return body;
}

module.exports = { configured, dispatchAssistanceCall };
