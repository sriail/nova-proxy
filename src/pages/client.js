"use strict";

// Configuration constants
const TRANSPORT_PATH = "/libcurl/index.mjs";

// List of hostnames that are allowed to run service workers on http://
const swAllowedHostnames = ["localhost", "127.0.0.1"];

// Register the service worker
async function registerSW() {
  if (!navigator.serviceWorker) {
    if (
      location.protocol !== "https:" &&
      !swAllowedHostnames.includes(location.hostname)
    ) {
      throw new Error("Service workers cannot be registered without https.");
    }
    throw new Error("Your browser doesn't support service workers.");
  }
  await navigator.serviceWorker.register("/sw.js");
}

// Search helper - converts input to URL or search query
function search(input, template) {
  try {
    return new URL(input).toString();
  } catch (err) {
    // input was not a valid URL
  }

  try {
    const url = new URL(`http://${input}`);
    if (url.hostname.includes(".")) return url.toString();
  } catch (err) {
    // input was not valid URL
  }

  return template.replace("%s", encodeURIComponent(input));
}

// Initialize Scramjet controller
const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
  files: {
    wasm: "/scram/scramjet.wasm.wasm",
    all: "/scram/scramjet.all.js",
    sync: "/scram/scramjet.sync.js",
  },
});

scramjet.init();

// Initialize BareMux connection
const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

// Store reference to current scramjet frame
let currentFrame = null;

// Main function to load a URL through the proxy
async function loadProxiedUrl(url) {
  try {
    await registerSW();
  } catch (err) {
    console.error("Failed to register service worker:", err);
    alert("Failed to register service worker: " + err.message);
    throw err;
  }

  // Set up libcurl transport with Wisp
  const wispUrl =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" +
    location.host +
    "/wisp/";

  const currentTransport = await connection.getTransport();
  if (currentTransport !== TRANSPORT_PATH) {
    await connection.setTransport(TRANSPORT_PATH, [{ websocket: wispUrl }]);
  }

  const container = document.getElementById("container");
  const existingIframe = document.getElementById("proxy-frame");

  // Create scramjet frame
  const frame = scramjet.createFrame();
  frame.frame.id = "proxy-frame";
  frame.frame.style.width = "100%";
  frame.frame.style.height = "100vh";
  frame.frame.style.border = "none";

  // Store reference
  currentFrame = frame;

  // Replace existing iframe
  if (existingIframe) {
    existingIframe.replaceWith(frame.frame);
  } else {
    container.appendChild(frame.frame);
  }

  // Show iframe mode
  container.classList.add("iframe-active");

  // Navigate to URL
  frame.go(url);
}

/**
 * Client-side Cookie Rewriter System
 * Works in coordination with the service worker's backend cookie rewriting
 * to ensure cookies work correctly across the proxy
 */
const ClientCookieRewriter = {
  /**
   * Configuration for the cookie rewriter
   */
  config: {
    isSecureContext: location.protocol === "https:",
    proxyHostname: location.hostname,
    proxyDomain:
      location.hostname !== "localhost" && location.hostname !== "127.0.0.1"
        ? "." + location.hostname
        : null,
  },

  /**
   * Parses a cookie string into components
   */
  parseCookie(cookieString) {
    if (!cookieString || typeof cookieString !== "string") {
      return null;
    }

    const parts = cookieString.split(";").map((part) => part.trim());
    const [nameValue, ...attributes] = parts;

    if (!nameValue) {
      return null;
    }

    const eqIndex = nameValue.indexOf("=");
    if (eqIndex === -1) {
      return null;
    }

    const name = nameValue.substring(0, eqIndex).trim();
    const value = nameValue.substring(eqIndex + 1);

    const cookie = {
      name,
      value,
      domain: null,
      path: null,
      expires: null,
      maxAge: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
    };

    for (const attr of attributes) {
      const attrLower = attr.toLowerCase();

      if (attrLower === "secure") {
        cookie.secure = true;
      } else if (attrLower === "httponly") {
        cookie.httpOnly = true;
      } else if (attrLower.startsWith("domain=")) {
        cookie.domain = attr.substring(7).trim();
      } else if (attrLower.startsWith("path=")) {
        cookie.path = attr.substring(5).trim();
      } else if (attrLower.startsWith("expires=")) {
        cookie.expires = attr.substring(8).trim();
      } else if (attrLower.startsWith("max-age=")) {
        cookie.maxAge = parseInt(attr.substring(8).trim(), 10);
      } else if (attrLower.startsWith("samesite=")) {
        cookie.sameSite = attr.substring(9).trim().toLowerCase();
      }
    }

    return cookie;
  },

  /**
   * Serializes a cookie object back to a string
   */
  serializeCookie(cookie) {
    if (!cookie || !cookie.name) {
      return "";
    }

    let result = `${cookie.name}=${cookie.value}`;

    if (cookie.domain) {
      result += `; Domain=${cookie.domain}`;
    }

    if (cookie.path) {
      result += `; Path=${cookie.path}`;
    }

    if (cookie.expires) {
      result += `; Expires=${cookie.expires}`;
    }

    if (cookie.maxAge !== null && cookie.maxAge !== undefined) {
      result += `; Max-Age=${cookie.maxAge}`;
    }

    if (cookie.sameSite) {
      result += `; SameSite=${cookie.sameSite}`;
    }

    if (cookie.secure) {
      result += "; Secure";
    }

    // Note: httpOnly cannot be set from JavaScript, but we preserve it for parsing
    return result;
  },

  /**
   * Rewrites a cookie string to work with the proxy
   */
  rewriteCookie(cookieString) {
    const cookie = this.parseCookie(cookieString);

    if (!cookie) {
      return cookieString;
    }

    const { isSecureContext, proxyDomain } = this.config;

    // Rewrite domain attribute
    if (cookie.domain) {
      if (proxyDomain) {
        cookie.domain = proxyDomain;
      } else {
        // For localhost, remove domain entirely
        cookie.domain = null;
      }
    }

    // Handle Secure flag in non-secure context
    if (!isSecureContext && cookie.secure) {
      cookie.secure = false;

      // SameSite=None requires Secure, so change to Lax
      if (cookie.sameSite === "none") {
        cookie.sameSite = "lax";
      }
    }

    // Handle SameSite=None without Secure
    if (cookie.sameSite === "none" && !cookie.secure && !isSecureContext) {
      cookie.sameSite = "lax";
    }

    // Ensure path is set
    if (!cookie.path) {
      cookie.path = "/";
    }

    return this.serializeCookie(cookie);
  },
};

// Cookie rewriter system
function setupCookieRewriter() {
  // Override document.cookie to rewrite domain checks
  const originalCookieDescriptor = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "cookie"
  );

  if (originalCookieDescriptor) {
    Object.defineProperty(document, "cookie", {
      get: function () {
        return originalCookieDescriptor.get.call(this);
      },
      set: function (value) {
        // Use the cookie rewriter to process the cookie
        const modifiedValue = ClientCookieRewriter.rewriteCookie(value);
        return originalCookieDescriptor.set.call(this, modifiedValue);
      },
      configurable: true,
    });
  }
}

// Window.open injection - redirect new windows to main iframe
function setupWindowOpenInjection() {
  const originalOpen = window.open;

  window.open = function (url, target, features) {
    // If we have a current frame and this is a new window/tab request
    if (currentFrame && url) {
      // Resolve relative URLs
      let resolvedUrl;
      try {
        resolvedUrl = new URL(url, location.href).toString();
      } catch (e) {
        resolvedUrl = url;
      }

      // Navigate the main proxy frame instead of opening new window
      console.log("Intercepted window.open, navigating iframe to:", resolvedUrl);
      currentFrame.go(resolvedUrl);
      return null;
    }

    // Fall back to original behavior if no frame
    return originalOpen.call(window, url, target, features);
  };
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  setupCookieRewriter();
  setupWindowOpenInjection();

  const urlInput = document.getElementById("url-input");

  // Override the loadUrl function
  window.loadUrl = async function () {
    const input = urlInput.value.trim();
    if (!input) return;

    // Convert input to URL
    const url = search(input, "https://duckduckgo.com/?q=%s");

    // Load through proxy
    await loadProxiedUrl(url);
  };

  // Go home function
  window.goHome = function () {
    const container = document.getElementById("container");
    container.classList.remove("iframe-active");
    urlInput.value = "";
    currentFrame = null;

    // Remove and reset the iframe for a cleaner state
    const iframe = document.getElementById("proxy-frame");
    if (iframe) {
      iframe.remove();
    }
  };
});
