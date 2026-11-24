// Kaaf Studio project assistant: Cloudflare Worker backend.
//
// The chat page on kaafstudio.de sends the conversation here. This Worker adds
// the system prompt and the submit_lead tool, calls the Claude Messages API with
// the secret ANTHROPIC_API_KEY, and returns Claude's reply to the page.
//
// It uses plain fetch because it is pasted into the Cloudflare dashboard editor,
// where npm packages (like the Anthropic SDK) can't be installed.
//
// Setup (Cloudflare dashboard → Workers & Pages → this Worker → Settings → Variables):
//   ANTHROPIC_API_KEY  (type: Secret)  your key from console.anthropic.com
//   ALLOWED_ORIGINS    (optional)      comma-separated, default below

const MODEL = "claude-opus-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ORIGINS = [
  "https://kaafstudio.de",
  "https://www.kaafstudio.de",
  "https://kaafstudio.netlify.app",
];

// Limits that keep a public demo cheap and hard to abuse.
const MAX_MESSAGES = 30;          // whole conversation, user + assistant turns
const MAX_USER_TEXT = 1500;       // characters per visitor message
const MAX_BODY_BYTES = 120_000;   // whole request body
const RATE_LIMIT = 40;            // requests per IP ...
const RATE_WINDOW_MS = 10 * 60_000; // ... per 10 minutes (per Worker instance)

const SYSTEM_PROMPT = `You are the project assistant on the website of Kaaf Studio, a small web design and AI studio in Bavaria, Germany, run by Kashaf Hassan.

Your job: have a short, friendly conversation with a potential client, understand their project, and send Kashaf a clear lead summary.

What Kaaf Studio offers (only mention what is relevant):
- Websites: business sites, landing pages, online stores, restaurant and booking sites, portfolios. Built in WordPress, Webflow or custom code (HTML/CSS/JavaScript, React, Next.js).
- AI agents and automation: chat assistants that answer customers, take bookings or orders, and qualify leads (like you).
- Digital marketing: social media content and ad creatives.
- Every project starts with a free call and a free sample design before the client commits.
- Live demo sites are on kaafstudio.de (a restaurant with scroll-driven video, a takeaway with online ordering, a barber shop with booking).

How to talk:
- Ask one question at a time. Keep each message to 1–3 short sentences.
- Reply in the visitor's language. Note that projects are run in English.
- Be warm and plain-spoken. No jargon unless the visitor uses it.
- If the visitor is unsure, offer 2–3 simple options to choose from.

Find out, in a natural order:
1. Their business and what it does.
2. What they need (new website, redesign, online store, booking, AI agent, marketing…).
3. The main goal (more customers, bookings, sales, saving time…).
4. Must-have features.
5. Timeline.
6. Rough budget. Offer ranges if they hesitate: under €1,000 / €1,000–3,000 / €3,000–8,000 / over €8,000 / not sure yet.
7. Their name and email, so Kashaf can reply.

Rules:
- Never quote a price, a delivery date or a guarantee. Say Kashaf will send a free quote and sample, usually within 24 hours.
- Do not invent facts about Kaaf Studio (no client counts, years or awards).
- If asked something off-topic, answer briefly and steer back to their project.
- When you know enough (at minimum: what they need, their name and a valid-looking email), show a short summary and ask the visitor to confirm. After they confirm, call submit_lead. Do not call it before they confirm.
- After submit_lead, thank them and say Kashaf will be in touch.`;

const TOOLS = [
  {
    name: "submit_lead",
    description:
      "Send the qualified lead to Kaaf Studio. Call only after the visitor has confirmed the summary and has given their name and email.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "name", "email", "business", "project_type", "goal",
        "features", "timeline", "budget", "lead_score", "summary",
      ],
      properties: {
        name: { type: "string", description: "Visitor's name" },
        email: { type: "string", description: "Visitor's email address" },
        business: { type: "string", description: "Business name and what it does" },
        project_type: {
          type: "string",
          enum: ["new_website", "redesign", "online_store", "booking_or_ordering", "ai_agent", "marketing", "other"],
        },
        goal: { type: "string", description: "Main goal in one sentence" },
        features: { type: "array", items: { type: "string" }, description: "Must-have features" },
        timeline: { type: "string", description: "When they want it, or 'not sure'" },
        budget: { type: "string", description: "Budget range, or 'not sure'" },
        lead_score: {
          type: "string",
          enum: ["hot", "warm", "cold"],
          description: "hot = clear need, budget and timeline; warm = clear need, details missing; cold = just exploring",
        },
        summary: { type: "string", description: "2–4 sentence summary for Kashaf" },
      },
    },
  },
];

const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_LIMIT;
}

function corsHeaders(origin, allowed) {
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Checks the conversation the page sent. Returns an error string, or null if OK.
function validate(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "No messages.";
  if (messages.length > MAX_MESSAGES) return "This conversation is too long. Please start a new one.";
  if (messages[0].role !== "user") return "Bad conversation.";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return "Bad conversation.";
    if (m.role === "user") {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      if (!Array.isArray(blocks)) return "Bad conversation.";
      for (const b of blocks) {
        if (b.type === "text") {
          if (typeof b.text !== "string" || b.text.length > MAX_USER_TEXT) return "Message too long.";
        } else if (b.type !== "tool_result") {
          return "Bad conversation.";
        }
      }
    } else if (!Array.isArray(m.content)) {
      return "Bad conversation.";
    }
  }
  return null;
}

// After a mid-output refusal fallback, thinking and tool_use blocks that come
// before the last `fallback` block must not be echoed back. Everything else is
// passed back unchanged, in order.
function prepareHistory(messages) {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    const lastFallback = m.content.map((b) => b.type).lastIndexOf("fallback");
    if (lastFallback === -1) return m;
    const drop = new Set(["thinking", "redacted_thinking", "tool_use"]);
    return {
      role: "assistant",
      content: m.content.filter((b, i) => i > lastFallback || !drop.has(b.type)),
    };
  });
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ORIGINS;
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);
    if (!allowed.includes(origin)) return json({ error: "Not allowed from this site." }, 403, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "The assistant isn't set up yet." }, 503, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) return json({ error: "Too many messages. Please try again in a few minutes." }, 429, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "This conversation is too long. Please start a new one." }, 413, cors);

    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "Bad request." }, 400, cors); }
    const problem = validate(body.messages);
    if (problem) return json({ error: problem }, 400, cors);

    let apiRes;
    try {
      apiRes = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2026-10-21",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4000,
          // Chat needs quick, short answers. Opus 5.5 always thinks; effort sets how much.
          output_config: { effort: "low" },
          fallbacks: "default",
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: TOOLS,
          messages: prepareHistory(body.messages),
        }),
      });
    } catch {
      return json({ error: "The assistant couldn't be reached. Please try again." }, 502, cors);
    }

    let data;
    try { data = await apiRes.json(); } catch { data = null; }

    if (!apiRes.ok || !data) {
      const status = apiRes.status === 429 || apiRes.status === 529 ? 503 : 502;
      console.log("Claude API error", apiRes.status, data && data.error);
      return json({ error: "The assistant is busy right now. Please try again in a moment." }, status, cors);
    }

    if (data.stop_reason === "refusal") {
      return json({
        stop_reason: "refusal",
        content: [{ type: "text", text: "Sorry, I can't help with that. Let's get back to your project. What does your business do?" }],
      }, 200, cors);
    }

    return json({ stop_reason: data.stop_reason, content: data.content }, 200, cors);
  },
};
