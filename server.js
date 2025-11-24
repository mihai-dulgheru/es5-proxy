require("dotenv").config();
const express = require("express");
const axios = require("axios");
const babel = require("@babel/core");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { LRUCache } = require("lru-cache");

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  }),
);

// RAM cache (LRU)
const memCache = new LRUCache({ max: 50, ttl: 1000 * 60 * 10 }); // 10 minutes

const CACHE_DIR = path.join(__dirname, ".cache");
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

const ALLOWED_HOSTS = [
  "www.googletagmanager.com",
  "connect.facebook.net",
  "analytics.tiktok.com",
  "www.youtube.com",
  "embed.voomly.com",
];

const BABEL_OPTIONS = {
  presets: [["@babel/preset-env", { targets: { ie: "11" } }]],
  sourceType: "script",
};

function isAllowedUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return ALLOWED_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

app.get("/proxy-es5", async (req, res) => {
  const url = req.query.url;
  if (!url || !isAllowedUrl(url)) {
    return res.status(400).send("Invalid or disallowed script URL.");
  }

  const cacheKey = Buffer.from(url).toString("base64");
  const cacheFile = path.join(CACHE_DIR, cacheKey + ".js");

  // Check in-memory cache
  const memCached = memCache.get(cacheKey);
  if (memCached) {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(memCached);
  }

  // Check disk cache
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, "utf-8");
    memCache.set(cacheKey, cached);
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(cached);
  }

  try {
    const { data } = await axios.get(url);
    const transpiled = await babel.transformAsync(data, BABEL_OPTIONS);

    fs.writeFileSync(cacheFile, transpiled.code);
    memCache.set(cacheKey, transpiled.code);
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(transpiled.code);
  } catch (err) {
    console.error("Transpile error:", err.message);
    res.status(500).send("Failed to fetch or transpile script.");
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`ES5 Proxy Server running at http://localhost:${PORT}`);
});
