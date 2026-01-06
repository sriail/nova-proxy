# Nova Framework

A basic, primitive web proxy using scramjet and complex backend systems.

## Features

- Web proxy powered by Scramjet
- Wisp.js for WebSocket tunneling
- Fastify server with static file serving
- Epoxy and libcurl transport support
- **Backend Cookie Rewrite System** - Rewrites domain verification cookies to improve site compatibility

## Cookie Rewrite System

Nova includes a comprehensive cookie rewrite system that processes cookies before they reach the browser. This helps more sites work correctly by:

- **Domain Rewriting**: Rewrites cookie domain attributes to match the proxy domain
- **Secure Flag Handling**: Removes `Secure` flags when running on HTTP (localhost development)
- **SameSite Adjustments**: Converts `SameSite=None` to `SameSite=Lax` when not in secure context
- **Path Normalization**: Ensures cookies have proper path attributes

The system works at two levels:
1. **Service Worker** (`sw.js`): Intercepts HTTP `Set-Cookie` headers and rewrites them before they're processed by the browser
2. **Client-side** (`client.js`): Handles JavaScript-set cookies via `document.cookie`

## Running

```bash
npm install
npm start
```

The server will start on port 8080 (or the port specified by the `PORT` environment variable).
