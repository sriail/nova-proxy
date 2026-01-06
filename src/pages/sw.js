importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

/**
 * Cookie Rewriter Utilities
 * Rewrites domain verification cookies to work correctly with the proxy
 */
const CookieRewriter = {
  /**
   * Parses a Set-Cookie header string into a structured object
   */
  parseCookie(cookieString) {
    if (!cookieString || typeof cookieString !== 'string') {
      return null;
    }

    const parts = cookieString.split(';').map(part => part.trim());
    const [nameValue, ...attributes] = parts;
    
    if (!nameValue) {
      return null;
    }

    const eqIndex = nameValue.indexOf('=');
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
      sameSite: null
    };

    for (const attr of attributes) {
      const attrLower = attr.toLowerCase();
      
      if (attrLower === 'secure') {
        cookie.secure = true;
      } else if (attrLower === 'httponly') {
        cookie.httpOnly = true;
      } else if (attrLower.startsWith('domain=')) {
        cookie.domain = attr.substring(7).trim();
      } else if (attrLower.startsWith('path=')) {
        cookie.path = attr.substring(5).trim();
      } else if (attrLower.startsWith('expires=')) {
        cookie.expires = attr.substring(8).trim();
      } else if (attrLower.startsWith('max-age=')) {
        cookie.maxAge = parseInt(attr.substring(8).trim(), 10);
      } else if (attrLower.startsWith('samesite=')) {
        cookie.sameSite = attr.substring(9).trim().toLowerCase();
      }
    }

    return cookie;
  },

  /**
   * Serializes a parsed cookie object back to a Set-Cookie header string
   */
  serializeCookie(cookie) {
    if (!cookie || !cookie.name) {
      return '';
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
      result += '; Secure';
    }

    if (cookie.httpOnly) {
      result += '; HttpOnly';
    }

    return result;
  },

  /**
   * Rewrites a cookie to work correctly with the proxy
   */
  rewriteCookie(cookieString, options = {}) {
    const cookie = this.parseCookie(cookieString);
    
    if (!cookie) {
      return cookieString;
    }

    const { proxyHostname, isSecureContext = false } = options;

    // Rewrite domain attribute
    // Remove domain restrictions that would prevent cookie from being set
    if (cookie.domain) {
      if (proxyHostname && proxyHostname !== 'localhost' && proxyHostname !== '127.0.0.1') {
        // Set domain to proxy hostname
        cookie.domain = proxyHostname.startsWith('.') ? proxyHostname : '.' + proxyHostname;
      } else {
        // For localhost, remove domain entirely to allow cookie setting
        cookie.domain = null;
      }
    }

    // Handle Secure flag
    // If not in secure context, remove Secure flag to allow cookie setting
    if (!isSecureContext && cookie.secure) {
      cookie.secure = false;
      
      // If SameSite=None requires Secure, change to Lax
      if (cookie.sameSite === 'none') {
        cookie.sameSite = 'lax';
      }
    }

    // Handle SameSite attribute
    // SameSite=None requires Secure flag, so adjust if needed
    if (cookie.sameSite === 'none' && !cookie.secure && !isSecureContext) {
      cookie.sameSite = 'lax';
    }

    // Ensure path is set (default to root)
    if (!cookie.path) {
      cookie.path = '/';
    }

    return this.serializeCookie(cookie);
  },

  /**
   * Rewrites cookies in a headers object
   */
  rewriteHeaders(headers, options = {}) {
    if (!headers || typeof headers !== 'object') {
      return headers;
    }

    const newHeaders = {};
    let setCookies = [];

    for (const [name, value] of Object.entries(headers)) {
      const nameLower = name.toLowerCase();
      
      if (nameLower === 'set-cookie') {
        if (Array.isArray(value)) {
          setCookies.push(...value);
        } else if (typeof value === 'string') {
          setCookies.push(value);
        }
      } else {
        newHeaders[name] = value;
      }
    }

    // Rewrite all cookies
    if (setCookies.length > 0) {
      const rewrittenCookies = setCookies
        .map(cookie => this.rewriteCookie(cookie, options))
        .filter(Boolean);
      
      if (rewrittenCookies.length > 0) {
        newHeaders['set-cookie'] = rewrittenCookies;
      }
    }

    return newHeaders;
  }
};

/**
 * Get cookie rewrite options based on current context
 */
function getCookieRewriteOptions() {
  return {
    proxyHostname: self.location.hostname,
    isSecureContext: self.location.protocol === 'https:'
  };
}

/**
 * Listen for Scramjet's handleresponse event to rewrite cookies
 */
scramjet.addEventListener('handleresponse', (event) => {
  try {
    const options = getCookieRewriteOptions();
    const headers = event.responseHeaders;
    
    if (headers) {
      // Check for set-cookie headers (case-insensitive)
      const setCookieKey = Object.keys(headers).find(
        key => key.toLowerCase() === 'set-cookie'
      );
      
      if (setCookieKey) {
        const cookies = headers[setCookieKey];
        const cookieArray = Array.isArray(cookies) ? cookies : [cookies];
        
        // Rewrite each cookie
        const rewrittenCookies = cookieArray
          .map(cookie => CookieRewriter.rewriteCookie(cookie, options))
          .filter(Boolean);
        
        // Update the response headers
        if (rewrittenCookies.length > 0) {
          event.responseHeaders[setCookieKey] = rewrittenCookies;
        }
      }
    }
  } catch (err) {
    console.warn('[CookieRewriter] Error rewriting cookies:', err);
  }
});

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) {
    return scramjet.fetch(event);
  }
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
