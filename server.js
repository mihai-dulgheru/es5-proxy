require("dotenv").config({ quiet: true });

const { LRUCache } = require("lru-cache");
const axios = require("axios");
const babel = require("@babel/core");
const cors = require("cors");
const debug = require("debug")("es5-proxy");
const express = require("express");
const fs = require("fs");
const logger = require("morgan");
const path = require("path");
const rateLimit = require("express-rate-limit");

const app = express();

// Rate limiting to prevent abuse (2400 requests per 1 minute per IP)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2400, // limit each IP to 2400 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// HTTP request logger (dev-friendly format)
app.use(logger("dev"));

// CORS: read allowed origins from environment variable (comma-separated)
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// CORS middleware with explicit whitelist and meaningful error status
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser tools (no Origin header)
      if (!origin) {
        return callback(null, true);
      }

      // If no whitelist is configured, allow all origins
      // Otherwise allow only configured origins
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      const err = new Error("Not allowed by CORS");
      err.status = 403;
      callback(err);
    },
  }),
);

// In-memory LRU cache for fast repeat hits
const memCache = new LRUCache({
  max: 50, // maximum number of entries
  ttl: 1000 * 60 * 10, // 10 minutes time-to-live
});

// Disk cache directory for persistent caching across restarts
const CACHE_DIR = path.join(__dirname, ".cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

// Strict allowlist of remote hosts whose scripts can be proxied
// This is a security boundary: only these domains will be fetched.
const ALLOWED_HOSTS = [
  "www.googletagmanager.com",
  "connect.facebook.net",
  "analytics.tiktok.com",
  "www.youtube.com",
  "embed.voomly.com",
];

// Babel configuration to transpile scripts to ES5 (IE11 compatibility)
const BABEL_OPTIONS = {
  presets: [["@babel/preset-env", { targets: { ie: "11" } }]],
  sourceType: "script",
};

// Validates that the URL is syntactically correct and belongs to an allowed host
function isAllowedUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return ALLOWED_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

// Simple health check endpoint
app.get("/", (req, res) => {
  res.send("OK");
});

// Main ES5 proxy endpoint:
// 1. Validates URL against allowlist
// 2. Attempts in-memory cache
// 3. Falls back to disk cache
// 4. On miss, fetches, transpiles, stores in both caches, and returns result
app.get("/proxy-es5", async (req, res, next) => {
  const url = req.query.url;

  if (!url || !isAllowedUrl(url)) {
    return res.status(400).send("Invalid or disallowed script URL.");
  }

  const cacheKey = Buffer.from(url).toString("base64");
  const cacheFile = path.join(CACHE_DIR, cacheKey + ".js");

  // In-memory cache hit
  const memCached = memCache.get(cacheKey);
  if (memCached) {
    debug("Memory cache hit for", url);

    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    return res.send(memCached);
  }

  // Disk cache hit
  if (fs.existsSync(cacheFile)) {
    debug("Disk cache hit for", url);

    const cached = fs.readFileSync(cacheFile, "utf-8");
    memCache.set(cacheKey, cached);

    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    return res.send(cached);
  }

  // Cache miss: fetch and transpile
  debug("Cache miss for", url);

  try {
    const { data } = await axios.get(url, {
      responseType: "text",
      timeout: 10_000,
    });

    const transpiled = await babel.transformAsync(data, BABEL_OPTIONS);

    // Persist to disk and memory
    fs.writeFileSync(cacheFile, transpiled.code);
    memCache.set(cacheKey, transpiled.code);

    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    res.send(transpiled.code);
  } catch (err) {
    // Normalize error before passing to error handler
    err.status = err.status || 502;
    err.message =
      err.message || "Failed to fetch or transpile script from remote URL.";

    next(err);
  }
});

// Catch-all 404 handler for unmatched routes
app.use(function (req, res) {
  res.status(404);

  if (req.accepts("json")) {
    res.json({ error: "Not Found" });
  } else {
    res.type("txt").send("Not Found");
  }
});

// Centralized error handler (must be last middleware)
app.use(function (err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  let status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === "production";

  // Normalize CORS errors to 403
  if (err.message === "Not allowed by CORS") {
    status = 403;
  }

  if (status >= 500) {
    debug("Unhandled error:", err);
  } else {
    debug("Handled error:", err.message);
  }

  const payload = {
    error: status === 500 ? "Internal Server Error" : err.message || "Error",
  };

  // In non-production environments, expose more debugging info
  if (!isProd) {
    payload.stack = err.stack;
    payload.details = {
      method: req.method,
      url: req.originalUrl,
    };
  }

  res.status(status);

  if (req.accepts("json")) {
    res.json(payload);
  } else {
    res
      .type("txt")
      .send(isProd ? payload.error : `${payload.error}\n\n${err.stack || ""}`);
  }
});

// Server startup
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  debug(`ES5 Proxy Server running at http://localhost:${PORT}`);
});
