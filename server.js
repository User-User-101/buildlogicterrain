const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
const page = path.join(__dirname, "index.html");
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/", (_req, res) => {
  if (!fs.existsSync(page)) return res.status(500).send("index.html is missing next to server.js");
  res.sendFile(page);
});
app.listen(process.env.PORT || 3000, () => console.log("running"));
