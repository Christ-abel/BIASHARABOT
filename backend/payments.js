export async function triggerSTKPush({ amount, phone, entryId, callbackUrl, channelId }) {
  const username = process.env.PAYHERO_API_USERNAME;
  const password = process.env.PAYHERO_API_PASSWORD;
  const activeChannelId = channelId || process.env.PAYHERO_CHANNEL_ID;
  const payheroUrl = process.env.PAYHERO_API_URL || "https://backend.payhero.co.ke/api/v2/payments/external";

  console.log(`[PAYHERO STK] Triggering STK push for Entry #${entryId}. Amount: KSh ${amount}, Phone: ${phone}, Channel ID: ${activeChannelId}`);

  if (!username || !password || !activeChannelId || username === "mock") {
    console.log("[PAYHERO MOCK MODE] Simulating M-Pesa STK push success.");
    return {
      success: true,
      message: "STK push initiated successfully (Mock Mode)",
      merchant_reference: "PH_" + Math.random().toString(36).substring(2, 11),
      mock: true
    };
  }

  // Normalize phone number to 254XXXXXXXXX
  let formattedPhone = phone.trim().replace(/\+/g, "");
  if (formattedPhone.startsWith("0")) {
    formattedPhone = "254" + formattedPhone.slice(1);
  } else if (!formattedPhone.startsWith("254")) {
    formattedPhone = "254" + formattedPhone;
  }

  // Create Basic Auth token
  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  const payload = {
    amount: parseFloat(amount),
    phone_number: formattedPhone,
    channel_id: parseInt(activeChannelId),
    provider: "m-pesa",
    external_reference: String(entryId),
    callback_url: callbackUrl
  };

  try {
    const response = await fetch(payheroUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("[PAYHERO STK RESPONSE]", data);

    if (response.ok && (data.status === "success" || data.success)) {
      return {
        success: true,
        message: data.message || "STK Push initiated",
        merchant_reference: data.transaction_id || data.reference || "PH_" + Math.random().toString(36).substring(2, 11)
      };
    } else {
      console.error("[PAYHERO STK ERROR]", data);
      return { success: false, error: data.message || "Failed to initiate payment" };
    }
  } catch (error) {
    console.error("[PAYHERO STK REQUEST EXCEPTION]", error);
    return { success: false, error: error.message };
  }
}
