"use strict";

// Configuration constants
// Use epoxy transport v2.1.28 for better SharedWorker compatibility and proper headers handling
const TRANSPORT_PATH = "/epoxy/index.mjs";

// Scramjet URL prefix for proxy routes
const SCRAMJET_PREFIX = "/scram/";

// Ultraviolet URL prefix for proxy routes (must match uv.config.js)
const UV_PREFIX = "/service/";

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
    // Preserve cookies defaults to true if not set
    preserveCookies: localStorage.getItem("nova-preserve-cookies") !== "false",
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

// Encode a URL through the proxy for loading resources like favicons
// This allows external resources to be loaded through the proxy
function encodeProxyUrl(url) {
  if (!url) return null;
  
  try {
    const urlObj = new URL(url);
    // Only proxy http/https URLs
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return null;
    }
    
    const settings = getSettings();
    
    // For Ultraviolet, use the UV encoding
    if (settings.proxyEngine === "ultraviolet" && typeof __uv$config !== "undefined" && typeof __uv$config.encodeUrl === "function") {
      return __uv$config.prefix + __uv$config.encodeUrl(url);
    }
    
    // For Scramjet, use the scramjet controller to encode the URL properly
    // Scramjet uses its own URL encoding scheme
    if (typeof scramjet !== "undefined" && scramjet.encodeUrl) {
      return scramjet.encodeUrl(url);
    }
    
    // If no encoder is available, return null to indicate encoding failure
    return null;
  } catch (e) {
    return null;
  }
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

// Cache for favicon data URLs to avoid repeated fetches
const faviconCache = new Map();

// Fetch favicon through proxy and convert to data URL
async function fetchFaviconAsDataUrl(faviconUrl) {
  if (!faviconUrl) return null;
  
  // Check cache first
  if (faviconCache.has(faviconUrl)) {
    return faviconCache.get(faviconUrl);
  }
  
  try {
    // First try with no-cors mode (for same-origin proxy URLs)
    let response;
    try {
      response = await fetch(faviconUrl, {
        mode: 'cors',
        credentials: 'omit',
        cache: 'force-cache'
      });
    } catch (corsError) {
      // If CORS fails, try no-cors mode
      try {
        response = await fetch(faviconUrl, {
          mode: 'no-cors',
          credentials: 'omit',
          cache: 'force-cache'
        });
      } catch (e) {
        console.log("Favicon fetch failed:", e.message);
        return null;
      }
    }
    
    // For no-cors responses, we can't check status or read body properly
    // So we need to handle opaque responses - return null and caller will use URL directly
    if (response.type === 'opaque') {
      return null;
    }
    
    if (!response.ok) {
      console.log("Favicon fetch returned status:", response.status);
      return null;
    }
    
    const blob = await response.blob();
    
    // Only process image types, but also accept empty type (some servers don't set it)
    if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') {
      console.log("Favicon blob is not an image:", blob.type);
      return null;
    }
    
    // Check if blob has content
    if (blob.size === 0) {
      return null;
    }
    
    // Convert blob to data URL
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result;
        // Cache the result
        faviconCache.set(faviconUrl, dataUrl);
        resolve(dataUrl);
      };
      reader.onerror = (error) => {
        console.log("FileReader error:", error);
        resolve(null);
      };
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.log("Error fetching favicon:", e.message);
    return null;
  }
}

// Extract the original favicon URL from a proxied URL or href
function extractOriginalFaviconUrl(href, currentUrl) {
  if (!href) return null;
  
  try {
    // Check if it's already a proxied URL
    const hrefUrl = new URL(href);
    
    // Try to decode if it's a proxy URL
    if (hrefUrl.pathname.startsWith(SCRAMJET_PREFIX)) {
      // Scramjet proxied URL - try to decode
      const decoded = decodeProxyUrl(href, false);
      if (decoded) return decoded;
    } else if (typeof __uv$config !== "undefined" && hrefUrl.pathname.startsWith(__uv$config.prefix)) {
      // UV proxied URL - try to decode
      const decoded = decodeProxyUrl(href, true);
      if (decoded) return decoded;
    }
    
    // If it's an absolute URL to the same origin, it might be a proxy URL
    if (hrefUrl.origin === location.origin) {
      // Try both decoders
      let decoded = decodeProxyUrl(href, false);
      if (decoded) return decoded;
      decoded = decodeProxyUrl(href, true);
      if (decoded) return decoded;
    }
    
    // If it's an external absolute URL, use it directly
    if (hrefUrl.protocol === 'http:' || hrefUrl.protocol === 'https:') {
      return href;
    }
    
    // If it's a relative URL, resolve against the current URL
    if (currentUrl) {
      return new URL(href, currentUrl).toString();
    }
  } catch (e) {
    // Try as relative URL
    if (currentUrl) {
      try {
        return new URL(href, currentUrl).toString();
      } catch (e2) {
        // Invalid URL
      }
    }
  }
  
  return null;
}

// Helper function to extract page info (title, favicon) from an iframe document
function extractPageInfo(iframe, currentUrl) {
  let pageTitle = null;
  let faviconUrl = null;
  
  try {
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (iframeDoc) {
      pageTitle = iframeDoc.title || null;
      
      // Try to find favicon - check multiple selectors in order of preference
      // Look for link elements with rel containing "icon" (case-insensitive)
      const linkElements = iframeDoc.querySelectorAll('link[rel]');
      for (const link of linkElements) {
        const rel = (link.getAttribute('rel') || '').toLowerCase();
        // Check for various icon rel values
        if (rel.includes('icon')) {
          // Use the resolved href property directly - it's already a valid URL
          // that the browser can access (either proxied or absolute)
          if (link.href) {
            faviconUrl = link.href;
            break;
          }
        }
      }
    }
  } catch (e) {
    // Cross-origin, can't access document - try fallback
    console.log("Cannot access iframe document for favicon:", e.message);
  }
  
  // If no favicon found from link element, try default location using the original URL
  if (!faviconUrl && currentUrl) {
    try {
      const urlObj = new URL(currentUrl);
      if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
        // Construct default favicon URL and proxy it
        const defaultFaviconUrl = urlObj.origin + '/favicon.ico';
        faviconUrl = encodeProxyUrl(defaultFaviconUrl);
      }
    } catch (e) {
      // Invalid URL
    }
  }
  
  return { pageTitle, favicon: faviconUrl };
}

// Delay in milliseconds to wait for page content to be ready after navigation
const PAGE_INFO_DELAY_MS = 250;

// Retry delay for favicon extraction if not found on first attempt
const FAVICON_RETRY_DELAY_MS = 500;

// Maximum number of retries for favicon extraction
const MAX_FAVICON_RETRIES = 2;

// Delay for navigation event handlers to allow URL to update
const NAVIGATION_CHECK_DELAY_MS = 50;

// Track pending favicon retries to prevent overlapping attempts
const pendingFaviconRetries = new Map();

// Update tab and URL bar with current page info
async function updatePageInfo(tabId, currentUrl, iframe, retryCount = 0) {
  const { pageTitle, favicon } = extractPageInfo(iframe, currentUrl);
  
  // Update the nav URL bar if we got a valid URL
  if (currentUrl && currentUrl !== lastKnownUrl) {
    lastKnownUrl = currentUrl;
    if (typeof window.updateNavUrlBar === "function") {
      window.updateNavUrlBar(currentUrl);
    }
  }
  
  // Update tab info if tab system is available
  if (tabId !== undefined && typeof window.updateTabInfo === "function") {
    // Only update title if we have one
    const updateData = {
      url: currentUrl || undefined
    };
    
    if (pageTitle) {
      updateData.title = pageTitle;
    }
    
    // If we found a favicon URL, try to fetch it and convert to data URL
    if (favicon) {
      // Clear any pending retry since we found a favicon
      if (pendingFaviconRetries.has(tabId)) {
        clearTimeout(pendingFaviconRetries.get(tabId));
        pendingFaviconRetries.delete(tabId);
      }
      
      // Try to fetch the favicon as a data URL for better reliability
      const dataUrl = await fetchFaviconAsDataUrl(favicon);
      updateData.favicon = dataUrl || favicon;
    }
    
    window.updateTabInfo(tabId, updateData);
  }
  
  // If no favicon found and we haven't retried too many times, try again
  // Some pages load favicons dynamically
  if (!favicon && retryCount < MAX_FAVICON_RETRIES && tabId !== undefined) {
    // Clear any existing retry for this tab to prevent overlapping
    if (pendingFaviconRetries.has(tabId)) {
      clearTimeout(pendingFaviconRetries.get(tabId));
    }
    
    const timeoutId = setTimeout(() => {
      pendingFaviconRetries.delete(tabId);
      updatePageInfo(tabId, currentUrl, iframe, retryCount + 1);
    }, FAVICON_RETRY_DELAY_MS);
    
    pendingFaviconRetries.set(tabId, timeoutId);
  }
}

// Setup URL tracking for Scramjet frames using ScramjetFrame events
function setupScramjetUrlTracking(scramjetFrame, tabId) {
  // Listen for URL change events from Scramjet
  scramjetFrame.addEventListener("urlchange", function(event) {
    try {
      const currentUrl = event.url;
      
      // Delay to allow the page to load and set title/favicon
      // Using setTimeout is necessary because the urlchange event fires before
      // the document content (title, favicon links) is updated
      setTimeout(() => {
        updatePageInfo(tabId, currentUrl, scramjetFrame.frame);
      }, PAGE_INFO_DELAY_MS);
    } catch (e) {
      console.log("Error tracking Scramjet URL change:", e);
    }
  });
  
  // Listen for navigation events from Scramjet
  // This fires when navigation starts, so we update the URL immediately
  // but wait for urlchange event to update title/favicon
  scramjetFrame.addEventListener("navigate", function(event) {
    try {
      const currentUrl = event.url;
      
      // Update URL and tab info immediately on navigation start
      // Title and favicon will be updated by the urlchange event after page loads
      if (tabId !== undefined && typeof window.updateTabInfo === "function") {
        window.updateTabInfo(tabId, {
          url: currentUrl || undefined
        });
      }
      
      // Also update the URL bar immediately
      if (currentUrl && currentUrl !== lastKnownUrl) {
        lastKnownUrl = currentUrl;
        if (typeof window.updateNavUrlBar === "function") {
          window.updateNavUrlBar(currentUrl);
        }
      }
    } catch (e) {
      console.log("Error tracking Scramjet navigation:", e);
    }
  });
  
  // Listen for context initialization to intercept window.open inside the proxied frame
  scramjetFrame.addEventListener("contextInit", function(event) {
    try {
      const proxiedWindow = event.window;
      const scramjetClient = event.client;
      if (!proxiedWindow) return;
      
      // Use ScramjetClient's RawProxy to wrap window.open AFTER Scramjet has hooked it
      // This allows us to intercept calls before they reach Scramjet's native window.open call
      if (scramjetClient && typeof scramjetClient.RawProxy === 'function') {
        scramjetClient.RawProxy(proxiedWindow, 'open', {
          apply: function(proxyArgs) {
            // proxyArgs is Scramjet's proxy context with: fn, this, args, return(), call()
            const url = proxyArgs.args[0];
            const target = proxyArgs.args[1];
            
            // Check if tab system is available
            if (typeof window.openUrlInNewTab !== 'function') {
              // Fall back to Scramjet's behavior if tab system not available
              return; // Let Scramjet handle it normally
            }
            
            // Handle about:blank or empty URL - create a new home tab
            if (!url || url === 'about:blank') {
              console.log("Intercepted proxied window.open for empty/about:blank, opening new home tab");
              window.openUrlInNewTab('');
              proxyArgs.return(null);
              return;
            }
            
            // Resolve relative URLs against the current proxied URL
            let resolvedUrl;
            try {
              // Try to get the base URL from the scramjet client or frame
              let baseUrl;
              if (scramjetClient && scramjetClient.url) {
                baseUrl = scramjetClient.url.toString();
              } else if (scramjetFrame.url) {
                baseUrl = scramjetFrame.url.toString();
              } else {
                // Use location.href from the proxied window as fallback
                baseUrl = proxiedWindow.location.href;
              }
              resolvedUrl = new URL(url, baseUrl).toString();
            } catch (e) {
              resolvedUrl = url;
            }
            
            console.log("Intercepted proxied window.open via RawProxy, opening in new tab:", resolvedUrl);
            window.openUrlInNewTab(resolvedUrl);
            proxyArgs.return(null);
          }
        });
        console.log("Window.open interception set up via RawProxy for proxied frame");
      } else {
        // Fallback: try direct override if RawProxy is not available
        const scramjetOpen = proxiedWindow.open;
        
        const interceptedOpen = function(url, target, features) {
          if (typeof window.openUrlInNewTab !== 'function') {
            return scramjetOpen.call(proxiedWindow, url, target, features);
          }
          
          if (!url || url === 'about:blank') {
            console.log("Intercepted proxied window.open for empty/about:blank, opening new home tab");
            window.openUrlInNewTab('');
            return null;
          }
          
          let resolvedUrl;
          try {
            let baseUrl;
            if (scramjetClient && scramjetClient.url) {
              baseUrl = scramjetClient.url.toString();
            } else if (scramjetFrame.url) {
              baseUrl = scramjetFrame.url.toString();
            } else {
              baseUrl = proxiedWindow.location.href;
            }
            resolvedUrl = new URL(url, baseUrl).toString();
          } catch (e) {
            resolvedUrl = url;
          }
          
          console.log("Intercepted proxied window.open (fallback), opening in new tab:", resolvedUrl);
          window.openUrlInNewTab(resolvedUrl);
          return null;
        };
        
        try {
          Object.defineProperty(proxiedWindow, 'open', {
            value: interceptedOpen,
            writable: true,
            configurable: true,
            enumerable: true
          });
        } catch (e) {
          proxiedWindow.open = interceptedOpen;
        }
        console.log("Window.open interception set up via fallback for proxied frame");
      }
      
      // Also intercept target="_blank" links by adding a click handler
      try {
        const doc = proxiedWindow.document;
        if (doc) {
          doc.addEventListener('click', function(e) {
            let target = e.target;
            while (target && target.tagName !== 'A') {
              target = target.parentElement;
            }
            
            if (target && target.tagName === 'A') {
              const linkTarget = target.getAttribute('target');
              if (linkTarget === '_blank' || linkTarget === '_new') {
                const href = target.href;
                if (href && typeof window.openUrlInNewTab === 'function') {
                  e.preventDefault();
                  e.stopPropagation();
                  
                  let resolvedUrl;
                  try {
                    let baseUrl;
                    if (scramjetClient && scramjetClient.url) {
                      baseUrl = scramjetClient.url.toString();
                    } else if (scramjetFrame.url) {
                      baseUrl = scramjetFrame.url.toString();
                    } else {
                      baseUrl = proxiedWindow.location.href;
                    }
                    resolvedUrl = new URL(href, baseUrl).toString();
                  } catch (err) {
                    resolvedUrl = href;
                  }
                  
                  console.log("Intercepted target=_blank link click, opening in new tab:", resolvedUrl);
                  window.openUrlInNewTab(resolvedUrl);
                  return false;
                }
              }
            }
          }, true);
        }
      } catch (linkError) {
        console.log("Could not set up link click interception:", linkError);
      }
    } catch (e) {
      console.log("Error setting up window.open interception in proxied frame:", e);
    }
  });
  
  // Also listen for iframe load events as a fallback for initial load
  scramjetFrame.frame.addEventListener("load", function() {
    try {
      // Get the current URL from the ScramjetFrame
      let currentUrl = null;
      try {
        // Check if url property exists and has a valid toString method
        if (scramjetFrame.url && typeof scramjetFrame.url.toString === 'function') {
          currentUrl = scramjetFrame.url.toString();
        } else if (scramjetFrame.url && typeof scramjetFrame.url === 'string') {
          currentUrl = scramjetFrame.url;
        }
      } catch (e) {
        // URL property might not be available yet
      }
      
      // Setup verification cookie handler for the iframe
      setupVerificationCookieHandler(scramjetFrame.frame);
      
      // Delay to allow the page content to be ready
      setTimeout(() => {
        updatePageInfo(tabId, currentUrl, scramjetFrame.frame);
      }, PAGE_INFO_DELAY_MS);
    } catch (e) {
      console.log("Error tracking Scramjet iframe load:", e);
    }
  });
}

// Setup URL tracking for iframe navigation changes (for Ultraviolet)
function setupUrlTracking(iframe, isUltraviolet, tabId) {
  // Track last known URL to avoid duplicate updates
  let lastTrackedUrl = null;
  
  // Function to update page info with current URL
  function updateCurrentPageInfo() {
    try {
      // Try to get the current URL from the iframe
      let currentUrl = null;
      
      // Try accessing iframe's contentWindow location
      const iframeLocation = getIframeLocationUrl(iframe);
      if (iframeLocation) {
        currentUrl = decodeProxyUrl(iframeLocation, isUltraviolet);
      }
      
      // Only update if URL actually changed
      if (currentUrl && currentUrl !== lastTrackedUrl) {
        lastTrackedUrl = currentUrl;
        
        // Delay to allow content to be ready before extracting page info
        setTimeout(() => {
          updatePageInfo(tabId, currentUrl, iframe);
        }, PAGE_INFO_DELAY_MS);
      } else if (currentUrl === lastTrackedUrl) {
        // URL is the same, but title/favicon might have changed (SPA navigation)
        setTimeout(() => {
          updatePageInfo(tabId, currentUrl, iframe);
        }, PAGE_INFO_DELAY_MS);
      }
    } catch (e) {
      console.log("Error tracking URL:", e);
    }
  }
  
  // Listen for iframe load events
  iframe.addEventListener("load", function() {
    try {
      // Get current URL
      let currentUrl = null;
      const iframeLocation = getIframeLocationUrl(iframe);
      if (iframeLocation) {
        currentUrl = decodeProxyUrl(iframeLocation, isUltraviolet);
      }
      
      // For Ultraviolet, set up additional event listeners in the iframe
      if (isUltraviolet) {
        setupUltravioletWindowOpenInterception(iframe, currentUrl);
        setupUltravioletNavigationTracking(iframe, tabId);
      }
      
      // Setup verification cookie handler for the iframe
      setupVerificationCookieHandler(iframe);
      
      // Update page info
      updateCurrentPageInfo();
    } catch (e) {
      console.log("Error on iframe load:", e);
    }
  });
}

// Setup navigation tracking for Ultraviolet iframe (handles SPA navigation)
function setupUltravioletNavigationTracking(iframe, tabId) {
  try {
    const iframeWindow = iframe.contentWindow;
    if (!iframeWindow) return;
    
    // Track last known URL for this iframe
    let lastKnownIframeUrl = null;
    
    // Function to check and update URL
    function checkAndUpdateUrl() {
      try {
        const iframeLocation = getIframeLocationUrl(iframe);
        if (iframeLocation) {
          const currentUrl = decodeProxyUrl(iframeLocation, true);
          if (currentUrl && currentUrl !== lastKnownIframeUrl) {
            lastKnownIframeUrl = currentUrl;
            setTimeout(() => {
              updatePageInfo(tabId, currentUrl, iframe);
            }, PAGE_INFO_DELAY_MS);
          }
        }
      } catch (e) {
        // Cross-origin or other error
      }
    }
    
    // Listen for popstate events (back/forward navigation)
    iframeWindow.addEventListener('popstate', function() {
      setTimeout(checkAndUpdateUrl, NAVIGATION_CHECK_DELAY_MS);
    });
    
    // Listen for hashchange events
    iframeWindow.addEventListener('hashchange', function() {
      setTimeout(checkAndUpdateUrl, NAVIGATION_CHECK_DELAY_MS);
    });
    
    // Override history.pushState and history.replaceState to catch SPA navigation
    const originalPushState = iframeWindow.history.pushState;
    const originalReplaceState = iframeWindow.history.replaceState;
    
    iframeWindow.history.pushState = function(...args) {
      const result = originalPushState.apply(this, args);
      setTimeout(checkAndUpdateUrl, NAVIGATION_CHECK_DELAY_MS);
      return result;
    };
    
    iframeWindow.history.replaceState = function(...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(checkAndUpdateUrl, NAVIGATION_CHECK_DELAY_MS);
      return result;
    };
    
    // Also watch for title changes using MutationObserver
    try {
      const iframeDoc = iframe.contentDocument || iframeWindow.document;
      if (iframeDoc) {
        const titleElement = iframeDoc.querySelector('title');
        if (titleElement) {
          const observer = new MutationObserver(function() {
            setTimeout(checkAndUpdateUrl, NAVIGATION_CHECK_DELAY_MS);
          });
          observer.observe(titleElement, { childList: true, characterData: true, subtree: true });
        }
        
        // Also observe head for new link elements (favicon changes)
        const headElement = iframeDoc.head;
        if (headElement) {
          const headObserver = new MutationObserver(function(mutations) {
            for (const mutation of mutations) {
              if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                  // Check if node is an element before accessing tagName
                  if (node.nodeType === Node.ELEMENT_NODE && 
                      node.tagName === 'LINK' && 
                      node.rel && 
                      node.rel.toLowerCase().includes('icon')) {
                    setTimeout(checkAndUpdateUrl, NAVIGATION_CHECK_DELAY_MS);
                    return;
                  }
                }
              }
            }
          });
          headObserver.observe(headElement, { childList: true });
        }
      }
    } catch (e) {
      // Cross-origin restriction
    }
    
    console.log("UV: Navigation tracking set up for Ultraviolet iframe");
  } catch (e) {
    console.log("UV: Error setting up navigation tracking:", e);
  }
}

// Setup window.open interception for Ultraviolet iframe
function setupUltravioletWindowOpenInterception(iframe, currentUrl) {
  try {
    const iframeWindow = iframe.contentWindow;
    if (!iframeWindow) return;
    
    // Save the original window.open
    const originalOpen = iframeWindow.open;
    
    // Override window.open in the UV iframe
    iframeWindow.open = function(url, target, features) {
      // Check if tab system is available in parent
      if (typeof window.openUrlInNewTab !== 'function') {
        // Fall back to original behavior
        return originalOpen.call(iframeWindow, url, target, features);
      }
      
      // Handle about:blank or empty URL - create a new home tab
      if (!url || url === 'about:blank') {
        console.log("UV: Intercepted window.open for empty/about:blank, opening new home tab");
        window.openUrlInNewTab('');
        return null;
      }
      
      // Resolve relative URLs against the current proxied URL
      let resolvedUrl;
      try {
        if (currentUrl) {
          resolvedUrl = new URL(url, currentUrl).toString();
        } else {
          // Try to decode the current iframe URL
          const iframeLocation = getIframeLocationUrl(iframe);
          if (iframeLocation) {
            const decodedUrl = decodeProxyUrl(iframeLocation, true);
            if (decodedUrl) {
              resolvedUrl = new URL(url, decodedUrl).toString();
            } else {
              resolvedUrl = url;
            }
          } else {
            resolvedUrl = url;
          }
        }
      } catch (e) {
        resolvedUrl = url;
      }
      
      console.log("UV: Intercepted window.open, opening in new tab:", resolvedUrl);
      window.openUrlInNewTab(resolvedUrl);
      return null;
    };
    
    // Also intercept target="_blank" links
    const iframeDoc = iframeWindow.document;
    if (iframeDoc) {
      iframeDoc.addEventListener('click', function(e) {
        let target = e.target;
        while (target && target.tagName !== 'A') {
          target = target.parentElement;
        }
        
        if (target && target.tagName === 'A') {
          const linkTarget = target.getAttribute('target');
          if (linkTarget === '_blank' || linkTarget === '_new') {
            const href = target.href;
            if (href && typeof window.openUrlInNewTab === 'function') {
              e.preventDefault();
              e.stopPropagation();
              
              // Resolve the URL - href is already the proxied URL, so decode it first
              let resolvedUrl;
              try {
                // Try to decode the proxied href
                const decodedHref = decodeProxyUrl(href, true);
                if (decodedHref) {
                  resolvedUrl = decodedHref;
                } else if (currentUrl) {
                  // If decoding fails, try to resolve against current URL
                  const hrefAttr = target.getAttribute('href');
                  resolvedUrl = new URL(hrefAttr, currentUrl).toString();
                } else {
                  resolvedUrl = href;
                }
              } catch (err) {
                resolvedUrl = href;
              }
              
              console.log("UV: Intercepted target=_blank link click, opening in new tab:", resolvedUrl);
              window.openUrlInNewTab(resolvedUrl);
              return false;
            }
          }
        }
      }, true);
    }
    
    console.log("UV: Window.open interception set up for Ultraviolet iframe");
  } catch (e) {
    console.log("UV: Error setting up window.open interception:", e);
  }
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

  // Setup URL change tracking using Scramjet's native events
  setupScramjetUrlTracking(frame, tabId);

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

// ============================================
// Browser Verification and Cloudflare Support
// ============================================

// Cloudflare and browser verification cookie names that must be preserved
const VERIFICATION_COOKIES = [
  "cf_clearance",      // Cloudflare clearance cookie
  "__cf_bm",           // Cloudflare bot management
  "_cf_bm",            // Alternative Cloudflare bot management
  "cf_chl_prog",       // Cloudflare challenge progress
  "cf_chl_rc_ni",      // Cloudflare challenge recaptcha
  "cf_chl_seq_",       // Cloudflare challenge sequence
  "__cfruid",          // Cloudflare rate limiting UID
  "__cfwaitingroom",   // Cloudflare waiting room
  "_cfuvid",           // Cloudflare unique visitor ID
  // hCaptcha related
  "hc_accessibility",
  // reCAPTCHA related
  "_GRECAPTCHA",
  // Turnstile related
  "cf_turnstile_"
];

// Check if a cookie name is a verification cookie
function isVerificationCookie(cookieName) {
  const name = cookieName.toLowerCase().trim();
  return VERIFICATION_COOKIES.some(vcookie => 
    name === vcookie.toLowerCase() || name.startsWith(vcookie.toLowerCase())
  );
}

// Preserve verification cookies by extending their path and removing restrictions
// When preserveCookies setting is enabled, all cookies are preserved
function preserveVerificationCookie(cookieString) {
  const settings = getSettings();
  
  // Parse the cookie to check if it's a verification cookie
  const parts = cookieString.split(";");
  const nameValue = parts[0].split("=");
  const cookieName = nameValue[0].trim();
  
  // If preserve all cookies is enabled, apply preservation to all cookies
  // Otherwise, only preserve verification cookies
  if (!settings.preserveCookies && !isVerificationCookie(cookieName)) {
    return cookieString; // Not a verification cookie and preservation disabled, return as-is
  }
  
  // Ensure cookies have broad path and proper settings for cross-domain functionality
  let modified = cookieString;
  
  // Remove restrictive path and set to root
  modified = modified.replace(/;\s*path=[^;]+/gi, "");
  modified += "; path=/";
  
  // Ensure SameSite is set appropriately for cookies
  if (!/;\s*samesite=/i.test(modified)) {
    modified += "; SameSite=None";
  }
  
  // Ensure Secure flag is set if on HTTPS
  if (location.protocol === "https:" && !/;\s*secure/i.test(modified)) {
    modified += "; Secure";
  }
  
  return modified;
}

// Setup browser verification support
function setupBrowserVerification() {
  // Ensure navigator properties look like a real browser
  // This helps pass basic browser verification checks
  
  // Preserve webdriver detection - ensure we don't look like automated
  try {
    // Only modify if webdriver is detected as true (indicating automation)
    if (navigator.webdriver === true) {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
        configurable: true
      });
    }
  } catch (e) {
    // Property might not be configurable in some browsers
  }
  
  // Ensure plugins array looks normal (some verification checks this)
  try {
    if (navigator.plugins.length === 0) {
      // Create a generic mock plugins array to appear more like a real browser
      // Uses generic PDF viewer plugin which is common across browsers
      const mockPlugins = {
        length: 1,
        item: (index) => mockPlugins[index],
        namedItem: (name) => mockPlugins[0],
        refresh: () => {},
        0: { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" }
      };
      Object.defineProperty(navigator, "plugins", {
        get: () => mockPlugins,
        configurable: true
      });
    }
  } catch (e) {
    // Property might not be configurable
  }
  
  // Ensure languages look normal
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
        configurable: true
      });
    }
  } catch (e) {
    // Property might not be configurable
  }
}

// Allowed Cloudflare domains for challenge scripts
const CLOUDFLARE_DOMAINS = [
  "challenges.cloudflare.com",
  "static.cloudflareinsights.com",
  "cloudflare.com"
];

// Safely validate if a URL is from a Cloudflare domain
function isCloudflareScriptUrl(src) {
  if (!src) return false;
  
  try {
    // Parse the URL properly
    const url = new URL(src, location.origin);
    const hostname = url.hostname.toLowerCase();
    
    // Check if the hostname matches or is a subdomain of allowed domains
    return CLOUDFLARE_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith("." + domain)
    );
  } catch (e) {
    // Invalid URL, not a Cloudflare script
    return false;
  }
}

// Setup Cloudflare-specific handling
function setupCloudflareSupport() {
  // Listen for Cloudflare challenge page detection
  // Cloudflare challenges typically include specific elements or scripts
  
  // Monitor for iframe load events to detect CF challenges
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check for Cloudflare Turnstile widget
          if (node.classList && (
            node.classList.contains("cf-turnstile") ||
            node.classList.contains("cf-challenge") ||
            node.id === "cf-wrapper" ||
            node.id === "challenge-form"
          )) {
            handleCloudflareChallenge(node);
          }
          
          // Check for scripts that might be Cloudflare challenges
          if (node.tagName === "SCRIPT") {
            const src = node.getAttribute("src") || "";
            // Properly validate that the script is from Cloudflare domains
            if (isCloudflareScriptUrl(src)) {
              // Allow the script to run - it's a verification challenge
              console.log("Nova: Cloudflare challenge script detected");
            }
          }
        }
      });
    });
  });
  
  // Start observing document for Cloudflare elements
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
  
  // Override fetch to handle Cloudflare challenge responses
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const response = await originalFetch.apply(this, args);
      
      // Check for Cloudflare challenge response using CF-specific headers
      const cfRay = response.headers.get("cf-ray");
      const cfChallenge = response.headers.get("cf-mitigated");
      
      // Only log if this is actually a Cloudflare response (has CF-Ray header)
      // and is a challenge response (cf-mitigated header or specific status with cf-ray)
      if (cfRay && (cfChallenge === "challenge" || 
          ((response.status === 403 || response.status === 503) && cfChallenge))) {
        // This is a Cloudflare challenge, let it proceed normally
        // The challenge page will handle verification
        console.log("Nova: Cloudflare challenge response detected (CF-Ray:", cfRay, ")");
      }
      
      return response;
    } catch (error) {
      throw error;
    }
  };
}

// Handle detected Cloudflare challenge elements
function handleCloudflareChallenge(element) {
  console.log("Nova: Cloudflare challenge detected, allowing verification");
  
  // Ensure the challenge element has proper styling to be visible
  // Some challenges might be hidden or have z-index issues in proxy context
  if (element.style) {
    // Ensure visibility
    element.style.visibility = "visible";
    element.style.opacity = "1";
    
    // Ensure proper z-index for overlay challenges
    if (element.id === "cf-wrapper" || element.classList.contains("cf-challenge")) {
      element.style.zIndex = "999999";
      element.style.position = "relative";
    }
  }
  
  // Find and ensure any forms within the challenge are submittable
  const forms = element.querySelectorAll("form");
  forms.forEach((form) => {
    // Ensure form action is not blocked
    form.addEventListener("submit", (e) => {
      console.log("Nova: Cloudflare verification form submitted");
      // Let the form submit normally
    });
  });
  
  // Look for Turnstile widget and ensure it's properly initialized
  const turnstileWidgets = element.querySelectorAll(".cf-turnstile, [data-turnstile-callback]");
  turnstileWidgets.forEach((widget) => {
    console.log("Nova: Turnstile widget found, ensuring proper initialization");
    // Turnstile should self-initialize, but we ensure it's visible
    widget.style.display = "block";
    widget.style.visibility = "visible";
  });
}

// Enhanced cookie handler for verification in iframes
function setupVerificationCookieHandler(iframe) {
  // Check if we can access the iframe (same-origin check)
  try {
    // This will throw if cross-origin
    const iframeWindow = iframe.contentWindow;
    if (!iframeWindow) return;
    
    // Additional same-origin check before accessing document
    // Accessing location.href will throw for cross-origin iframes
    try {
      // eslint-disable-next-line no-unused-expressions
      iframeWindow.location.href;
    } catch (crossOriginError) {
      // Cross-origin iframe, skip cookie handler setup
      return;
    }
    
    const iframeDoc = iframe.contentDocument || iframeWindow.document;
    if (!iframeDoc) return;
    
    // Override document.cookie in the iframe to handle verification cookies
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      iframeDoc.constructor.prototype,
      "cookie"
    );
    
    if (originalDescriptor) {
      Object.defineProperty(iframeDoc, "cookie", {
        get: function() {
          return originalDescriptor.get.call(this);
        },
        set: function(value) {
          // Preserve and enhance verification cookies
          const enhancedValue = preserveVerificationCookie(value);
          return originalDescriptor.set.call(this, enhancedValue);
        },
        configurable: true
      });
    }
  } catch (e) {
    // Cross-origin iframe or other access error, cannot access
  }
}

// Setup all verification support systems
function setupVerificationSupport() {
  const settings = getSettings();
  
  // Browser verification is always enabled for compatibility
  setupBrowserVerification();
  
  // Cloudflare support is always enabled
  setupCloudflareSupport();
  
  console.log("Nova: Browser and Cloudflare verification support enabled");
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

// Window.open injection - redirect new windows/tabs to the site's tab system
function setupWindowOpenInjection() {
  const originalOpen = window.open;

  window.open = function (url, target, features) {
    // Handle about:blank or empty URL - create a new home tab
    if (!url || url === 'about:blank') {
      console.log("Intercepted window.open for empty/about:blank, opening new home tab");
      if (typeof window.openUrlInNewTab === 'function') {
        window.openUrlInNewTab('');
        return null;
      }
    }
    
    // If we have the tab system available, open in a new tab
    if (typeof window.openUrlInNewTab === 'function' && url) {
      // Resolve relative URLs
      let resolvedUrl;
      try {
        // Try to resolve against the current proxied URL if available
        if (currentFrame && currentFrame.url) {
          resolvedUrl = new URL(url, currentFrame.url.toString()).toString();
        } else {
          resolvedUrl = new URL(url, location.href).toString();
        }
      } catch (e) {
        resolvedUrl = url;
      }

      // Open in a new tab within the site's tab system
      console.log("Intercepted window.open, opening in new tab:", resolvedUrl);
      window.openUrlInNewTab(resolvedUrl);
      return null;
    }
    
    // If we have a current frame but no tab system, navigate the current frame (legacy behavior)
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
  setupVerificationSupport();

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

  // Go home function - only define if not already overridden by the tab system
  // The tab system in index.html may override this before DOMContentLoaded
  if (typeof window.goHome !== "function") {
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
  }
});
