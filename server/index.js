import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn("[server] Missing OPENAI_API_KEY. Set it in server/.env");
}

// Compact, token-optimized system prompt
const PROJECT_CONTEXT = `
You are an ultra-concise AI real-estate guide inside a Babylon.js panorama for Skyview Towers, Bangalore.
Features: 3BHK luxury apartments, rooftop infinity pool, metro access.
Tasks: welcome users, move to zones, rotate view, answer short factual questions.
Zones: living_room, balcony, lobby, kitchen, bedroom, rooftop.
Rules:
- Prefer one JSON command per reply.
- Keep message under 30 words.
- JSON keys: action (move_to_zone|rotate_view|speak_only), zone, angle, message.
- If unsure, ask a brief clarification via {"action":"speak_only","message":"..."}.
`;

app.post("/api/chat", async (req, res) => {
  const { userMessage } = req.body || {};
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server missing OPENAI_API_KEY" });
  }
  if (!userMessage || typeof userMessage !== "string") {
    return res.status(400).json({ error: "userMessage is required" });
  }

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        temperature: 0.3, // lower for consistency + fewer retries
        max_tokens: 150, // tighter budget per call
        messages: [
          { role: "system", content: PROJECT_CONTEXT },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({ error: "OpenAI request failed", details: data });
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OpenAI request failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));

