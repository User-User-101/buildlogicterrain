const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "300kb" }));
const GROQ = process.env.GROQ_BASE || "https://api.groq.com/openai/v1";

const page = (name) => (_req, res) => {
  const f = path.join(__dirname, name);
  if (!fs.existsSync(f)) return res.status(500).send(name + " is missing next to server.js");
  res.sendFile(f);
};
app.get("/", page("index.html"));
app.get("/objects", page("objects.html"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Tiny per-IP limit so a public URL can't be hammered. The Groq key is never stored or logged:
// it arrives in a request header, is forwarded to Groq, and is discarded.
const hits = new Map();
const limited = (ip) => {
  const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length > 20;
};
async function forward(req, res, url, init) {
  const key = (req.get("x-groq-key") || "").trim();
  if (!key) return res.status(400).json({ error: { message: "Missing Groq API key." } });
  if (limited(req.ip)) return res.status(429).json({ error: { message: "Too many requests, wait a minute." } });
  try {
    const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + key }, signal: AbortSignal.timeout(90000) });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (e) {
    res.status(502).json({ error: { message: "Could not reach Groq: " + (e.name === "TimeoutError" ? "timed out" : e.message) } });
  }
}
app.get("/api/models", (req, res) => forward(req, res, GROQ + "/models", { method: "GET" }));
app.post("/api/generate", (req, res) => {
  const b = req.body || {};
  const ok = Array.isArray(b.messages) && b.messages.length > 0 && b.messages.length <= 20 &&
    b.messages.every((m) => m && typeof m.content === "string" && m.content.length < 40000);
  if (!ok) return res.status(400).json({ error: { message: "Bad request." } });
  forward(req, res, GROQ + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: String(b.model || "llama-3.3-70b-versatile"),
      messages: b.messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: m.content })),
      temperature: 0.3,
      max_completion_tokens: 6000,
      response_format: { type: "json_object" },
    }),
  });
});
app.listen(process.env.PORT || 3000, () => console.log("running"));
