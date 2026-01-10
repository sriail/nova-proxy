"use strict";

// Configuration constants
// Use epoxy transport v2.1.28 for better SharedWorker compatibility and proper headers handling
const TRANSPORT_PATH = "/epoxy/index.mjs";

// Scramjet URL prefix for proxy routes
const SCRAMJET_PREFIX = "/scram/";

// List of hostnames that are allowed to run service workers on http://
const swAllowedHostnames = ["localhost", "127.0.0.1"];

// Cache transport configuration to avoid redundant setup
let transportConfigured = false;
let lastWispUrl = null;
let transportConfigPromise = null;

// Shared function to configure transport (with deduplication)
async function ensureTransportConfigured() {
  const wispUrl = getWispUrl();
  
  // If already configured with the same URL, return immediately
  if (transportConfigured && lastWispUrl === wispUrl) {
    return;
  }
  
  // If there's an ongoing configuration, wait for it
  if (transportConfigPromise) {
    await transportConfigPromise;
    return;
  }
  
  // Start configuration
  transportConfigPromise = (async () => {
    try {
      const currentTransport = await connection.getTransport();
      if (currentTransport !== TRANSPORT_PATH || lastWispUrl !== wispUrl) {
        await connection.setTransport(TRANSPORT_PATH, [{ wisp: wispUrl }]);
      }
      transportConfigured = true;
      lastWispUrl = wispUrl;
    } finally {
      transportConfigPromise = null;
    }
  })();
  
  await transportConfigPromise;
}

// Get settings from localStorage
function getSettings() {
  return {
    wispServer: localStorage.getItem("nova-wisp-server") || "",
    proxyEngine: localStorage.getItem("nova-proxy-engine") || "scramjet",
    adBlock: localStorage.getItem("nova-ad-block") === "true",
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

// Track the last known URL to avoid duplicate updates
let lastKnownUrl = "";

// Store tab-to-frame mapping
const tabFrames = new Map();

// Function to decode URL from proxy URL path
function decodeProxyUrl(proxyUrl, isUltraviolet) {
  try {
    const url = new URL(proxyUrl);
    const pathname = url.pathname;
    
    if (isUltraviolet && typeof __uv$config !== "undefined" && typeof __uv$config.decodeUrl === "function") {
      // For Ultraviolet, decode from the prefix path
      if (pathname.startsWith(__uv$config.prefix)) {
        const encodedPart = pathname.slice(__uv$config.prefix.length);
        return __uv$config.decodeUrl(encodedPart);
      }
    } else {
      // For Scramjet, the URL structure is /scram/<encoded>/path
      if (pathname.startsWith(SCRAMJET_PREFIX)) {
        const parts = pathname.slice(SCRAMJET_PREFIX.length).split("/");
        if (parts.length > 0) {
          // Try to decode the scramjet URL
          const encodedHost = parts[0];
          try {
            // Scramjet uses a specific encoding scheme
            const decoded = atob(encodedHost);
            if (decoded.startsWith("http")) {
              return decoded + (parts.length > 1 ? "/" + parts.slice(1).join("/") : "");
            }
          } catch (e) {
            // If base64 decoding fails, return the raw URL
          }
        }
      }
    }
  } catch (e) {
    console.log("Error decoding proxy URL:", e);
  }
  return null;
}

// Helper function to get iframe location URL safely
function getIframeLocationUrl(iframe) {
  try {
    return iframe.contentWindow.location.href;
  } catch (e) {
    // Cross-origin restriction
    return null;
  }
}

// Setup URL tracking for iframe navigation changes
function setupUrlTracking(iframe, isUltraviolet, tabId) {
  // Listen for iframe load events
  iframe.addEventListener("load", function() {
    try {
      // Try to get the current URL from the iframe
      let currentUrl = null;
      let pageTitle = null;
      let favicon = null;
      
      // Try accessing iframe's contentWindow location
      const iframeLocation = getIframeLocationUrl(iframe);
      if (iframeLocation) {
        currentUrl = decodeProxyUrl(iframeLocation, isUltraviolet);
      }
      
      // For Scramjet frames, try using the frame's URL property if available
      if (!currentUrl && currentFrame && !currentFrame.isUltraviolet && currentFrame.url) {
        currentUrl = currentFrame.url;
      }
      
      // Try to get page title and favicon from iframe
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iframeDoc) {
          pageTitle = iframeDoc.title || null;
          
          // Try to find favicon
          const linkIcon = iframeDoc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
          if (linkIcon && linkIcon.href) {
            favicon = linkIcon.href;
          } else if (currentUrl) {
            // Use default favicon location
            try {
              const urlObj = new URL(currentUrl);
              favicon = urlObj.origin + '/favicon.ico';
            } catch (e) {}
          }
        }
      } catch (e) {
        // Cross-origin, can't access document
      }
      
      // Update the nav URL bar if we got a valid URL
      if (currentUrl && currentUrl !== lastKnownUrl) {
        lastKnownUrl = currentUrl;
        if (typeof window.updateNavUrlBar === "function") {
          window.updateNavUrlBar(currentUrl);
        }
      }
      
      // Update tab info if tab system is available
      if (tabId !== undefined && typeof window.updateTabInfo === "function") {
        window.updateTabInfo(tabId, {
          url: currentUrl || undefined,
          title: pageTitle || undefined,
          favicon: favicon || undefined
        });
      }
    } catch (e) {
      console.log("Error tracking URL:", e);
    }
  });
}

// Main function to load a URL through the proxy using Scramjet
async function loadProxiedUrlScramjet(url, tabId) {
  try {
    await registerScramjetSW();
  } catch (err) {
    console.error("Failed to register service worker:", err);
    alert("Failed to register service worker: " + err.message);
    throw err;
  }

  // Set up epoxy transport with Wisp (use shared function for caching and deduplication)
  await ensureTransportConfigured();

  const container = document.getElementById("container");
  
  // Get the active tab's iframe ID if tab system is available
  let targetIframeId = null;
  if (tabId !== undefined && typeof window.getTabById === "function") {
    const tab = window.getTabById(tabId);
    if (tab) {
      targetIframeId = tab.iframeId || 'tab-iframe-' + tabId;
    }
  }
  
  // Find existing iframe for this tab or any proxy-frame
  let existingIframe = targetIframeId ? document.getElementById(targetIframeId) : document.getElementById("proxy-frame");

  // Create scramjet frame
  const frame = scramjet.createFrame();
  const frameId = targetIframeId || "proxy-frame";
  frame.frame.id = frameId;
  frame.frame.style.width = "100%";
  frame.frame.style.height = "calc(100vh - var(--nav-bar-height) - var(--tab-bar-height))";
  frame.frame.style.border = "none";
  frame.frame.style.display = "block";

  // Store reference
  currentFrame = frame;
  if (tabId !== undefined) {
    tabFrames.set(tabId, frame);
    
    // Update tab's iframeId
    if (typeof window.getTabById === "function") {
      const tab = window.getTabById(tabId);
      if (tab) {
        tab.iframeId = frameId;
      }
    }
  }

  // Replace existing iframe
  if (existingIframe) {
    existingIframe.replaceWith(frame.frame);
  } else {
    container.appendChild(frame.frame);
  }

  // Show iframe mode
  container.classList.add("iframe-active");

  // Update the nav URL bar with the decoded URL
  if (typeof window.updateNavUrlBar === "function") {
    window.updateNavUrlBar(url);
  }

  // Setup URL change tracking for Scramjet
  setupUrlTracking(frame.frame, false, tabId);

  // Navigate to URL
  frame.go(url);
}

// Main function to load a URL through Ultraviolet proxy
async function loadProxiedUrlUltraviolet(url, tabId) {
  // Verify Ultraviolet config is available
  if (typeof __uv$config === "undefined" || typeof __uv$config.encodeUrl !== "function") {
    alert("Ultraviolet proxy is not properly configured. Please refresh the page or switch to Scramjet.");
    throw new Error("Ultraviolet configuration not available");
  }

  // Set up epoxy transport with Wisp (use shared function for caching and deduplication)
  await ensureTransportConfigured();

  try {
    await registerUltravioletSW();
  } catch (err) {
    console.error("Failed to register Ultraviolet service worker:", err);
    alert("Failed to register service worker: " + err.message);
    throw err;
  }

  const container = document.getElementById("container");
  
  // Get the active tab's iframe ID if tab system is available
  let targetIframeId = null;
  if (tabId !== undefined && typeof window.getTabById === "function") {
    const tab = window.getTabById(tabId);
    if (tab) {
      targetIframeId = tab.iframeId || 'tab-iframe-' + tabId;
    }
  }
  
  let iframe = targetIframeId ? document.getElementById(targetIframeId) : document.getElementById("proxy-frame");

  // Create or reuse iframe
  if (!iframe) {
    iframe = document.createElement("iframe");
    const frameId = targetIframeId || "proxy-frame";
    iframe.id = frameId;
    iframe.style.width = "100%";
    iframe.style.height = "calc(100vh - var(--nav-bar-height) - var(--tab-bar-height))";
    iframe.style.border = "none";
    iframe.style.display = "block";
    container.appendChild(iframe);
    
    // Update tab's iframeId
    if (tabId !== undefined && typeof window.getTabById === "function") {
      const tab = window.getTabById(tabId);
      if (tab) {
        tab.iframeId = frameId;
      }
    }
  }

  // Store reference (for Ultraviolet we use a simple object wrapper)
  currentFrame = { frame: iframe, isUltraviolet: true };
  if (tabId !== undefined) {
    tabFrames.set(tabId, currentFrame);
  }

  // Show iframe mode
  container.classList.add("iframe-active");

  // Update the nav URL bar with the decoded URL
  if (typeof window.updateNavUrlBar === "function") {
    window.updateNavUrlBar(url);
  }

  // Setup URL change tracking for Ultraviolet
  setupUrlTracking(iframe, true, tabId);

  // Encode the URL and navigate
  const encodedUrl = __uv$config.prefix + __uv$config.encodeUrl(url);
  iframe.src = encodedUrl;
}

// Main function to load a URL through the proxy (selects engine based on settings)
async function loadProxiedUrl(url, tabId) {
  const settings = getSettings();
  if (settings.proxyEngine === "ultraviolet") {
    await loadProxiedUrlUltraviolet(url, tabId);
  } else {
    await loadProxiedUrlScramjet(url, tabId);
  }
}

// Function to load URL in a specific tab (called from tab system)
window.loadUrlInTab = async function(tabId, url) {
  await loadProxiedUrl(url, tabId);
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

// Common ad-serving domains to block
const AD_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "fbcdn.net",
  "adnxs.com",
  "adsrvr.org",
  "advertising.com",
  "adroll.com",
  "taboola.com",
  "outbrain.com",
  "criteo.com",
  "criteo.net",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "scorecardresearch.com",
  "quantserve.com",
  "bluekai.com",
  "exelator.com",
  "turn.com",
  "mathtag.com",
  "serving-sys.com",
  "2mdn.net",
  "moatads.com",
  "adzerk.net",
  "adtechus.com",
  "amazon-adsystem.com"
];

// Check if URL is from an ad domain
function isAdUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    return AD_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith("." + domain)
    );
  } catch (e) {
    return false;
  }
}

// Ad blocking CSS to hide common ad elements
const AD_BLOCK_CSS = `
  [class*="ad-"], [class*="Ad-"], [class*="AD-"],
  [class*="-ad"], [class*="-Ad"], [class*="-AD"],
  [class*="_ad"], [class*="_Ad"], [class*="_AD"],
  [id*="ad-"], [id*="Ad-"], [id*="AD-"],
  [id*="-ad"], [id*="-Ad"], [id*="-AD"],
  [id*="_ad"], [id*="_Ad"], [id*="_AD"],
  [class*="advertisement"], [id*="advertisement"],
  [class*="sponsored"], [id*="sponsored"],
  [data-ad], [data-ads], [data-ad-slot],
  iframe[src*="doubleclick"],
  iframe[src*="googlesyndication"],
  iframe[src*="googleads"],
  .adsbygoogle,
  ins.adsbygoogle {
    display: none !important;
    visibility: hidden !important;
    height: 0 !important;
    width: 0 !important;
    overflow: hidden !important;
  }
`;

// Inject ad blocking CSS into iframe
function injectAdBlockCSS(iframe) {
  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const style = iframeDoc.createElement("style");
    style.textContent = AD_BLOCK_CSS;
    style.id = "nova-ad-block-style";
    iframeDoc.head.appendChild(style);
  } catch (e) {
    // Cross-origin iframe, cannot inject directly
    console.log("Could not inject ad block CSS (cross-origin)");
  }
}

// Setup ad blocking for fetch requests
function setupAdBlocker() {
  const settings = getSettings();
  if (!settings.adBlock) return;

  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    // Handle string, URL object, or Request object
    const url = typeof input === "string" ? input : (input?.url || input?.toString?.() || String(input));
    if (isAdUrl(url)) {
      console.log("Blocked ad request:", url);
      return Promise.reject(new Error("Blocked by ad blocker"));
    }
    return originalFetch.call(window, input, init);
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (isAdUrl(url)) {
      console.log("Blocked ad XHR:", url);
      this._blocked = true;
    }
    return originalXhrOpen.apply(this, arguments);
  };

  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    if (this._blocked) {
      // Simulate a network error for blocked requests
      const self = this;
      setTimeout(function() {
        Object.defineProperty(self, "status", { value: 0 });
        Object.defineProperty(self, "readyState", { value: 4 });
        if (typeof self.onerror === "function") {
          self.onerror(new Error("Blocked by ad blocker"));
        }
      }, 0);
      return;
    }
    return originalXhrSend.apply(this, arguments);
  };

  // Add CSS to hide ad elements on the main page (prevent duplicate injection)
  if (!document.getElementById("nova-ad-block-style")) {
    const style = document.createElement("style");
    style.textContent = AD_BLOCK_CSS;
    style.id = "nova-ad-block-style";
    document.head.appendChild(style);
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
  setupAdBlocker();

  const urlInput = document.getElementById("url-input");

  // Override the loadUrl function
  window.loadUrl = async function () {
    const input = urlInput.value.trim();
    if (!input) return;

    // Convert input to URL
    const url = search(input, "https://duckduckgo.com/?q=%s");

    // Get active tab ID if tab system is available
    const tabId = typeof window.getActiveTabId === "function" ? window.getActiveTabId() : undefined;
    
    // Update tab type to proxy if tab system is available
    if (tabId !== undefined && typeof window.getTabById === "function") {
      const tab = window.getTabById(tabId);
      if (tab) {
        tab.type = 'proxy';
        tab.url = url;
      }
    }

    // Load through proxy
    await loadProxiedUrl(url, tabId);
  };

  // Go home function - this is overridden by the tab system in index.html
  // but we keep it for fallback
  window.goHome = function () {
    const container = document.getElementById("container");
    container.classList.remove("iframe-active");
    urlInput.value = "";
    currentFrame = null;

    // Clear the nav URL bar
    if (typeof window.updateNavUrlBar === "function") {
      window.updateNavUrlBar("");
    }

    // Remove and reset the iframe for a cleaner state
    const iframe = document.getElementById("proxy-frame");
    if (iframe) {
      iframe.remove();
    }
  };
});
