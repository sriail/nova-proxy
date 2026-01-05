import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("./pages/", import.meta.url));

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

// Serve public/static files
fastify.register(fastifyStatic, {
  root: publicPath,
  decorateReply: true,
});

// Serve Scramjet files
fastify.register(fastifyStatic, {
  root: scramjetPath,
  prefix: "/scram/",
  decorateReply: false,
});

// Serve Epoxy transport files
fastify.register(fastifyStatic, {
  root: join(epoxyPath, "dist"),
  prefix: "/epoxy/",
  decorateReply: false,
});

// Serve BareMux files
fastify.register(fastifyStatic, {
  root: baremuxPath,
  prefix: "/baremux/",
  decorateReply: false,
});

// Serve libcurl transport files
fastify.register(fastifyStatic, {
  root: join(libcurlPath, "dist"),
  prefix: "/libcurl/",
  decorateReply: false,
});

fastify.server.on("listening", () => {
  const address = fastify.server.address();
  console.log("Nova Proxy Server listening on:");
  console.log(`  http://localhost:${address.port}`);
  console.log(`  http://${hostname()}:${address.port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("Shutting down server...");
  fastify.close();
  process.exit(0);
}

const port = parseInt(process.env.PORT || "8080");

fastify.listen({
  port: port,
  host: "0.0.0.0",
});
