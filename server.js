const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "300kb" }));

const GH = process.env.GITHUB_BASE || "https://models.github.ai";
const GROQ = process.env.GROQ_BASE || "https://api.groq.com/openai/v1";
const PROVIDERS = {
  github: {
    chat: GH + "/inference/chat/completions",
    models: GH + "/catalog/models",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    model: "openai/gpt-4.1", tokens: "max_tokens", altTokens: "max_completion_tokens", limit: 4000,
  },
  groq: {
    chat: GROQ + "/chat/completions",
    models: GROQ + "/models",
    headers: {},
    model: "llama-3.3-70b-versatile", tokens: "max_completion_tokens", altTokens: "max_tokens", limit: 6000,
  },
};

const page = (name) => (_req, res) => {
  const f = path.join(__dirname, name);
  if (!fs.existsSync(f)) return res.status(500).send(name + " is missing next to server.js");
  res.sendFile(f);
};
app.get("/", page("index.html"));
app.get("/objects", page("objects.html"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Per-IP limit so a public URL can't be hammered. API keys are never stored or logged:
// they arrive in a request header, are forwarded to the provider, and are discarded.
const hits = new Map();
const limited = (ip) => {
  const now = Date.now(), a = (hits.get(ip) || []).filter((t) => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length > 20;
};
function setup(req, res) {
  const prov = PROVIDERS[req.get("x-provider")] || null;
  const key = (req.get("x-ai-key") || "").trim();
  if (!prov) { res.status(400).json({ error: { message: "Unknown provider." } }); return null; }
  if (!key) { res.status(400).json({ error: { message: "Missing API key." } }); return null; }
  if (limited(req.ip)) { res.status(429).json({ error: { message: "Too many requests, wait a minute." } }); return null; }
  return { prov, key };
}
const call = (prov, key, url, init) =>
  fetch(url, { ...init, headers: { ...prov.headers, ...(init.headers || {}), Authorization: "Bearer " + key }, signal: AbortSignal.timeout(90000) });
const fail = (res, e) =>
  res.status(502).json({ error: { message: "Could not reach the AI service: " + (e.name === "TimeoutError" ? "timed out" : e.message) } });

app.get("/api/models", async (req, res) => {
  const s = setup(req, res); if (!s) return;
  try {
    const r = await call(s.prov, s.key, s.prov.models, { method: "GET" });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (e) { fail(res, e); }
});

app.post("/api/generate", async (req, res) => {
  const b = req.body || {};
  const ok = Array.isArray(b.messages) && b.messages.length > 0 && b.messages.length <= 20 &&
    b.messages.every((m) => m && typeof m.content === "string" && m.content.length < 40000);
  if (!ok) return res.status(400).json({ error: { message: "Bad request." } });
  const s = setup(req, res); if (!s) return;
  const { prov, key } = s;
  const messages = b.messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: m.content }));
  const model = String(b.model || prov.model);
  // Models differ in what they accept. Try the ideal request first, then simpler ones.
  const variants = [
    { json: true, temp: true, tok: prov.tokens },
    { json: false, temp: true, tok: prov.tokens },
    { json: false, temp: false, tok: prov.altTokens },
  ];
  try {
    let last;
    for (const v of variants) {
      const body = { model, messages, [v.tok]: prov.limit };
      if (v.temp) body.temperature = 0.3;
      if (v.json) body.response_format = { type: "json_object" };
      const r = await call(prov, key, prov.chat, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      last = { status: r.status, text: await r.text() };
      if (r.status !== 400 && r.status !== 422) break;
    }
    res.status(last.status).type("application/json").send(last.text);
  } catch (e) { fail(res, e); }
});
app.listen(process.env.PORT || 3000, () => console.log("running"));
