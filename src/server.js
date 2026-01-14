import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCompress from "@fastify/compress";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";

const publicPath = fileURLToPath(new URL("./pages/", import.meta.url));

// Cache duration in seconds for static assets
const STATIC_CACHE_MAX_AGE = 3600; // 1 hour for regular assets
const IMMUTABLE_CACHE_MAX_AGE = 86400 * 7; // 7 days for immutable assets like WASM

// Compute transport paths manually (these packages are browser-only)
// We resolve the main export and go up to get the package directory
const epoxyPath = join(dirname(fileURLToPath(import.meta.resolve("@mercuryworkshop/epoxy-transport"))), "..");
const libcurlPath = join(dirname(fileURLToPath(import.meta.resolve("@mercuryworkshop/libcurl-transport"))), "..");

// Wisp Configuration
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.1", "1.0.0.1"],
});

const fastify = Fastify({
  // Disable logging in production for better performance
  logger: process.env.NODE_ENV === "development",
  // Disable request ID generation in production for slightly faster request handling
  disableRequestLogging: process.env.NODE_ENV !== "development",
  serverFactory: (handler) => {
    return createServer()
      .on("request", (req, res) => {
        // Required headers for SharedArrayBuffer (needed by Scramjet)
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        handler(req, res);
      })
      .on("upgrade", (req, socket, head) => {
        if (req.url.endsWith("/wisp/")) {
          wisp.routeRequest(req, socket, head);
        } else {
          socket.end();
        }
      });
  },
});

// Enable compression for faster response delivery
fastify.register(fastifyCompress, {
  // Enable Brotli for modern browsers (best compression)
  encodings: ["br", "gzip", "deflate"],
  // Only compress responses larger than 1KB
  threshold: 1024,
});

// Serve public/static files
fastify.register(fastifyStatic, {
  root: publicPath,
  decorateReply: true,
  maxAge: STATIC_CACHE_MAX_AGE * 1000, // Convert to milliseconds
});

// Serve Scramjet files with longer cache for WASM files
fastify.register(fastifyStatic, {
  root: scramjetPath,
  prefix: "/scram/",
  decorateReply: false,
  maxAge: IMMUTABLE_CACHE_MAX_AGE * 1000, // WASM files don't change often
});

// Serve Epoxy transport files
fastify.register(fastifyStatic, {
  root: join(epoxyPath, "dist"),
  prefix: "/epoxy/",
  decorateReply: false,
  maxAge: IMMUTABLE_CACHE_MAX_AGE * 1000,
});

// Serve libcurl transport files (better WebSocket support for games)
fastify.register(fastifyStatic, {
  root: join(libcurlPath, "dist"),
  prefix: "/libcurl/",
  decorateReply: false,
  maxAge: IMMUTABLE_CACHE_MAX_AGE * 1000,
});

// Serve BareMux files
fastify.register(fastifyStatic, {
  root: baremuxPath,
  prefix: "/baremux/",
  decorateReply: false,
  maxAge: IMMUTABLE_CACHE_MAX_AGE * 1000,
});

// Serve Ultraviolet files
fastify.register(fastifyStatic, {
  root: uvPath,
  prefix: "/uv/",
  decorateReply: false,
  maxAge: IMMUTABLE_CACHE_MAX_AGE * 1000,
});

fastify.server.on("listening", () => {
  const address = fastify.server.address();
  console.log("Nova Proxy Server listening on:");
  console.log(`  http://localhost:${address.port}`);
  console.log(`  http://${hostname()}:${address.port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("Shutting down server...");
  await fastify.close();
  process.exit(0);
}

const port = parseInt(process.env.PORT || "8080");

fastify.listen({
  port: port,
  host: "0.0.0.0",
});
