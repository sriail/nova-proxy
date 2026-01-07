"use strict";

// Configuration constants
const TRANSPORT_PATH = "/libcurl/index.mjs";

// List of hostnames that are allowed to run service workers on http://
const swAllowedHostnames = ["localhost", "127.0.0.1"];

// Get settings from localStorage
function getSettings() {
  return {
    wispServer: localStorage.getItem("nova-wisp-server") || "",
    proxyEngine: localStorage.getItem("nova-proxy-engine") || "scramjet",
  };
}

// Get the Wisp URL (custom or default)
function getWispUrl() {
  const settings = getSettings();
  if (settings.wispServer) {
    return settings.wispServer;
  }
  return (
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" +
    location.host +
    "/wisp/"
  );
}

// Register the service worker for Scramjet
async function registerScramjetSW() {
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

// Register the service worker for Ultraviolet
async function registerUltravioletSW() {
  if (!navigator.serviceWorker) {
    if (
      location.protocol !== "https:" &&
      !swAllowedHostnames.includes(location.hostname)
    ) {
      throw new Error("Service workers cannot be registered without https.");
    }
    throw new Error("Your browser doesn't support service workers.");
  }
  
  // Check if Ultraviolet config is available
  if (typeof __uv$config === "undefined") {
    throw new Error("Ultraviolet configuration not loaded. Please refresh the page.");
  }
  
  // Register the UV service worker with the service prefix scope
  const registration = await navigator.serviceWorker.register("/uv-sw.js", {
    scope: __uv$config.prefix,
  });
  
  // Wait for the service worker to be active
  if (registration.active) {
    return;
  }
  
  // If the service worker is installing or waiting, wait for it to activate
  if (registration.installing || registration.waiting) {
    const sw = registration.installing || registration.waiting;
    // Check if already activated before setting up listener
    if (sw.state === "activated") {
      return;
    }
    await new Promise((resolve) => {
      sw.addEventListener("statechange", function handler() {
        if (sw.state === "activated") {
          sw.removeEventListener("statechange", handler);
          resolve();
        }
      });
    });
  }
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

// Main function to load a URL through the proxy using Scramjet
async function loadProxiedUrlScramjet(url) {
  try {
    await registerScramjetSW();
  } catch (err) {
    console.error("Failed to register service worker:", err);
    alert("Failed to register service worker: " + err.message);
    throw err;
  }

  // Set up libcurl transport with Wisp
  const wispUrl = getWispUrl();

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

// Main function to load a URL through Ultraviolet proxy
async function loadProxiedUrlUltraviolet(url) {
  // Verify Ultraviolet config is available
  if (typeof __uv$config === "undefined" || typeof __uv$config.encodeUrl !== "function") {
    alert("Ultraviolet proxy is not properly configured. Please refresh the page or switch to Scramjet.");
    throw new Error("Ultraviolet configuration not available");
  }

  // Set up libcurl transport with Wisp for bare-mux
  const wispUrl = getWispUrl();

  // Always set transport to ensure it's configured correctly
  await connection.setTransport(TRANSPORT_PATH, [{ websocket: wispUrl }]);

  try {
    await registerUltravioletSW();
  } catch (err) {
    console.error("Failed to register Ultraviolet service worker:", err);
    alert("Failed to register service worker: " + err.message);
    throw err;
  }

  const container = document.getElementById("container");
  let iframe = document.getElementById("proxy-frame");

  // Create or reuse iframe
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "proxy-frame";
    iframe.style.width = "100%";
    iframe.style.height = "100vh";
    iframe.style.border = "none";
    container.appendChild(iframe);
  }

  // Store reference (for Ultraviolet we use a simple object wrapper)
  currentFrame = { frame: iframe, isUltraviolet: true };

  // Show iframe mode
  container.classList.add("iframe-active");

  // Encode the URL and navigate
  const encodedUrl = __uv$config.prefix + __uv$config.encodeUrl(url);
  iframe.src = encodedUrl;
}

// Main function to load a URL through the proxy (selects engine based on settings)
async function loadProxiedUrl(url) {
  const settings = getSettings();
  if (settings.proxyEngine === "ultraviolet") {
    await loadProxiedUrlUltraviolet(url);
  } else {
    await loadProxiedUrlScramjet(url);
  }
}

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
        // Remove domain restrictions that might fail verification
        let modifiedValue = value;

        // Remove domain attribute that might cause issues
        modifiedValue = modifiedValue.replace(
          /;\s*domain=[^;]+/gi,
          "; domain=" + location.hostname
        );

        // Remove secure flag if not on HTTPS (for localhost testing)
        if (location.protocol !== "https:") {
          modifiedValue = modifiedValue.replace(/;\s*secure/gi, "");
        }

        // Remove SameSite=None if not secure
        if (location.protocol !== "https:") {
          modifiedValue = modifiedValue.replace(
            /;\s*samesite=none/gi,
            "; SameSite=Lax"
          );
        }

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
      
      // Handle Ultraviolet differently
      if (currentFrame.isUltraviolet && typeof __uv$config !== "undefined" && typeof __uv$config.encodeUrl === "function") {
        const encodedUrl = __uv$config.prefix + __uv$config.encodeUrl(resolvedUrl);
        currentFrame.frame.src = encodedUrl;
      } else if (currentFrame.isUltraviolet) {
        // Fallback for Ultraviolet if config not available
        console.error("Ultraviolet config not available for window.open");
        return originalOpen.call(window, url, target, features);
      } else {
        currentFrame.go(resolvedUrl);
      }
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
