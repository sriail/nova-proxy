"use strict";

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
  if (currentTransport !== "/libcurl/index.mjs") {
    await connection.setTransport("/libcurl/index.mjs", [{ websocket: wispUrl }]);
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

    // Reset iframe
    const iframe = document.getElementById("proxy-frame");
    if (iframe) {
      iframe.src = "about:blank";
    }
  };
});
