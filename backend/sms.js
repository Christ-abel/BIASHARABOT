export async function sendSMS({ to, message }) {
  const apiKey = process.env.TIARA_API_KEY;
  const senderId = process.env.TIARA_SENDER_ID || "CONNECT";

  console.log(`[SMS OUTBOUND] Recipient: ${to}`);
  console.log(`[SMS OUTBOUND] Message:\n${message}\n`);

  if (!apiKey || apiKey === "mock" || apiKey.trim() === "") {
    console.log("[SMS MOCK MODE] Successfully simulated sending report via Tiara Connect.");
    return { success: true, message: "Mock SMS sent successfully", mock: true };
  }

  // Ensure phone number starts with 254
  let formattedTo = to.trim().replace(/\+/g, "");
  if (formattedTo.startsWith("0")) {
    formattedTo = "254" + formattedTo.slice(1);
  } else if (!formattedTo.startsWith("254")) {
    formattedTo = "254" + formattedTo;
  }

  const smsUrl = "https://api2.tiaraconnect.io/api/messaging/sendsms";
  const smsHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  };
  const refId = "ref_" + Math.random().toString(36).substring(2, 11);
  const smsBody = {
    from: senderId,
    to: formattedTo,
    message: message,
    refId: refId
  };

  try {
    const response = await fetch(smsUrl, {
      method: "POST",
      headers: smsHeaders,
      body: JSON.stringify(smsBody)
    });

    const data = await response.json();
    console.log("[SMS TIARA RESPONSE]", JSON.stringify(data, null, 2));

    if (response.ok) {
      return { success: true, data, refId };
    } else {
      console.error("[SMS TIARA ERROR] Status:", response.status, data);
      return { success: false, error: data };
    }
  } catch (error) {
    console.error("[SMS TIARA REQUEST EXCEPTION]", error);
    return { success: false, error: error.message };
  }
}

// Check remaining Tiara Connect balance before sending, to fail fast
// instead of silently losing credit on a doomed send.
export async function checkBalance() {
  const apiKey = process.env.TIARA_API_KEY;
  const balanceUrl = "https://api2.tiaraconnect.io/api/messaging/checkbalance";

  try {
    const response = await fetch(balanceUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    const data = await response.json();
    console.log("[TIARA BALANCE]", JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error("[TIARA BALANCE CHECK EXCEPTION]", error);
    return null;
  }
}