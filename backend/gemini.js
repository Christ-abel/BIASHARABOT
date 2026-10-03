import { GoogleGenerativeAI } from "@google/generative-ai";

const getGenAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "mock" || apiKey.trim() === "") {
    return null;
  }
  return new GoogleGenerativeAI(apiKey);
};

export async function parseTextWithGemini(text) {
  const genAI = getGenAI();
  if (!genAI) {
    console.log("Mock Mode: Parsing text locally without Gemini API key");
    return mockParse(text);
  }

  const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
  
  const prompt = `Analyze the following transaction entry from a shop owner. Extract structured information.
Text: "${text}"

You must return a valid JSON object matching the schema below:
{
  "type": "sale" | "purchase" | "expense" | "credit",
  "item": string,
  "qty": number,
  "unit_price": number,
  "total": number,
  "transcription": string
}

Instructions:
- "transcription" must be exactly the text input that was provided.
- If the quantity or unit price is missing, estimate them logically based on the total. E.g. "bought sugar for 200" could be item: "sugar", qty: 1, unit_price: 200, total: 200.
- If total is missing, calculate it as qty * unit_price.
- The "type" must be one of: "sale" (received money for goods), "purchase" (spent money to buy inventory/stock), "expense" (spent money on bills, rent, fees, wages), "credit" (customer took goods without paying, or owes money).
- Keep item name short, clear, and in English (or Swahili if standard, e.g., "sugar", "maize", "chapati").
`;

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const responseText = result.response.text();
    return JSON.parse(responseText);
  } catch (error) {
    console.error("Gemini API error:", error);
    return mockParse(text);
  }
}

export async function parseAudioWithGemini(audioBuffer, mimeType) {
  const genAI = getGenAI();
  if (!genAI) {
    console.log("Mock Mode: Parsing audio locally without Gemini API key");
    return mockParse("voice entry: sold 10 loaves at 50 each");
  }

  const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

  const prompt = `Analyze the accompanying audio message from a shop owner logging a transaction.
Transcribe and extract structured information.

If the audio is silent, contains only background noise, is unintelligible, or does not clearly describe a business transaction (sale, purchase, expense, or credit), you MUST return a JSON object with an "error" field:
{
  "error": "Could not understand the recording. Please repeat clearly, for example: 'sold 10 loaves at 50 each' or 'spent 300 on electricity'."
}

Otherwise, return a valid JSON object matching the schema below:
{
  "type": "sale" | "purchase" | "expense" | "credit",
  "item": string,
  "qty": number,
  "unit_price": number,
  "total": number,
  "transcription": string
}

Instructions:
- The audio is a spoken phrase like "sold 10 loaves at 50 each" or "nimenunua mafuta ya 1500".
- "transcription" must be the exact text transcribed from the audio in English or Swahili depending on what was spoken.
- If the quantity or unit price is missing, estimate them logically based on the total.
- If total is missing, calculate it as qty * unit_price.
- The "type" must be one of: "sale" (received money), "purchase" (bought inventory), "expense" (general expenses/bills), "credit" (customer took on credit/owes money).
`;

  try {
    const base64Audio = audioBuffer.toString("base64");
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const responseText = result.response.text();
    return JSON.parse(responseText);
  } catch (error) {
    console.error("Gemini API error parsing audio:", error);
    return {
      error: "Could not understand the recording. Please repeat clearly, for example: 'sold 10 loaves at 50 each' or 'spent 300 on electricity'."
    };
  }
}

function mockParse(text) {
  const lower = text.toLowerCase();
  let type = "sale";
  let item = "Loaves / Bread";
  let qty = 1;
  let unit_price = 100;
  let total = 100;

  // Simple heuristic parser for testing offline
  if (lower.includes("buy") || lower.includes("bought") || lower.includes("nunua") || lower.includes("purchase")) {
    type = "purchase";
    item = "Flour Bags";
  } else if (lower.includes("expense") || lower.includes("rent") || lower.includes("token") || lower.includes("fee") || lower.includes("lipa")) {
    type = "expense";
    item = "Electricity Tokens";
  } else if (lower.includes("credit") || lower.includes("kopa") || lower.includes("debt") || lower.includes("owes")) {
    type = "credit";
    item = "Credit (Mama Mboga)";
  }

  // Parse numbers
  const numbers = text.match(/\d+(\.\d+)?/g);
  if (numbers && numbers.length >= 2) {
    const val1 = parseFloat(numbers[0]) || 1;
    const val2 = parseFloat(numbers[1]) || 100;
    qty = val1;

    // Check if text contains "at", "each", "per", "at a price of" before or after the second number
    const hasEachOrAt = /at\s+\d+|each\s+\d+|\d+\s+each|\d+\s+at/i.test(lower);
    if (hasEachOrAt) {
      unit_price = val2;
      total = qty * unit_price;
    } else {
      // Default: second number is the total sum, e.g. "sold 5 bags for 1000"
      total = val2;
      unit_price = total / qty;
    }
  } else if (numbers && numbers.length === 1) {
    total = parseFloat(numbers[0]) || 100;
    unit_price = total;
    qty = 1;
  }

  if (text !== "voice entry: sold 10 loaves at 50 each" && text !== "voice entry") {
    // If the user actually typed something, try to extract item name
    const cleanedText = text.replace(/(sold|bought|buy|spent|expense|credit|at|each|for|bags|loaves|pairs|shoes|sugar|\d+)/gi, "").trim();
    if (cleanedText.length > 2) {
      item = cleanedText;
    }
  }

  return { type, item, qty, unit_price, total, transcription: text };
}
