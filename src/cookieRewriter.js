/**
 * Backend Cookie Rewriter for Nova Proxy
 * 
 * This module provides utilities to rewrite domain verification cookies
 * before they are processed by the browser. It handles:
 * - Domain attribute rewriting
 * - Secure flag handling for HTTP contexts
 * - SameSite attribute adjustments
 * - Path attribute normalization
 */

/**
 * Parses a Set-Cookie header string into a structured object
 * @param {string} cookieString - The Set-Cookie header value
 * @returns {object} Parsed cookie object
 */
export function parseCookie(cookieString) {
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
    sameSite: null,
    raw: cookieString
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
}

/**
 * Serializes a parsed cookie object back to a Set-Cookie header string
 * @param {object} cookie - Parsed cookie object
 * @returns {string} Set-Cookie header value
 */
export function serializeCookie(cookie) {
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
}

/**
 * Rewrites a cookie to work correctly with the proxy
 * @param {string} cookieString - Original Set-Cookie header value
 * @param {object} options - Rewrite options
 * @param {string} options.proxyOrigin - The proxy's origin (e.g., 'http://localhost:8080')
 * @param {string} options.targetOrigin - The target site's origin (e.g., 'https://example.com')
 * @param {boolean} options.isSecureContext - Whether the proxy is running on HTTPS
 * @returns {string} Rewritten Set-Cookie header value
 */
export function rewriteCookie(cookieString, options = {}) {
  const cookie = parseCookie(cookieString);
  
  if (!cookie) {
    return cookieString;
  }

  const { proxyOrigin, targetOrigin, isSecureContext = false } = options;

  // Extract proxy hostname from origin
  let proxyHostname = '';
  if (proxyOrigin) {
    try {
      proxyHostname = new URL(proxyOrigin).hostname;
    } catch {
      proxyHostname = proxyOrigin;
    }
  }

  // Rewrite domain attribute
  // If the cookie has a domain that matches the target, rewrite it to the proxy domain
  // If no domain is set, keep it unset (browser will use current host)
  if (cookie.domain) {
    // Remove leading dot if present for comparison
    const cookieDomain = cookie.domain.replace(/^\./, '');
    
    if (targetOrigin) {
      try {
        const targetHost = new URL(targetOrigin).hostname;
        // If cookie domain matches target, rewrite to proxy domain
        if (targetHost === cookieDomain || targetHost.endsWith('.' + cookieDomain)) {
          // Set domain to proxy hostname (with leading dot for subdomain inclusion)
          if (proxyHostname && proxyHostname !== 'localhost' && proxyHostname !== '127.0.0.1') {
            cookie.domain = '.' + proxyHostname;
          } else {
            // For localhost, remove domain entirely to allow cookie setting
            cookie.domain = null;
          }
        } else {
          // Domain doesn't match target - remove it to allow setting
          cookie.domain = null;
        }
      } catch {
        // If target parsing fails, remove domain
        cookie.domain = null;
      }
    } else {
      // No target origin, remove domain to be safe
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

  return serializeCookie(cookie);
}

/**
 * Rewrites multiple Set-Cookie headers
 * @param {string[]} cookies - Array of Set-Cookie header values
 * @param {object} options - Rewrite options (same as rewriteCookie)
 * @returns {string[]} Array of rewritten Set-Cookie header values
 */
export function rewriteCookies(cookies, options = {}) {
  if (!Array.isArray(cookies)) {
    return [];
  }

  return cookies.map(cookie => rewriteCookie(cookie, options)).filter(Boolean);
}

/**
 * Extracts Set-Cookie headers from a Headers object or raw headers object
 * @param {Headers|object} headers - Headers object
 * @returns {string[]} Array of Set-Cookie header values
 */
export function extractSetCookieHeaders(headers) {
  const cookies = [];

  if (headers instanceof Headers) {
    // Headers object - use getSetCookie if available, otherwise iterate
    if (typeof headers.getSetCookie === 'function') {
      return headers.getSetCookie();
    }
    
    // Fallback: iterate through all headers
    for (const [name, value] of headers) {
      if (name.toLowerCase() === 'set-cookie') {
        cookies.push(value);
      }
    }
  } else if (headers && typeof headers === 'object') {
    // Raw headers object
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) {
          cookies.push(...value);
        } else if (typeof value === 'string') {
          // Some headers combine multiple cookies with comma
          // But Set-Cookie with commas in Expires is tricky
          // Just push the value as-is
          cookies.push(value);
        }
      }
    }
  }

  return cookies;
}

/**
 * Rewrites Set-Cookie headers in a headers object and returns a new headers object
 * @param {object} headers - Raw headers object (key-value pairs)
 * @param {object} options - Rewrite options
 * @returns {object} New headers object with rewritten cookies
 */
export function rewriteHeadersCookies(headers, options = {}) {
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
    const rewrittenCookies = rewriteCookies(setCookies, options);
    if (rewrittenCookies.length > 0) {
      newHeaders['set-cookie'] = rewrittenCookies;
    }
  }

  return newHeaders;
}

/**
 * Creates a cookie rewriter function with preset options
 * @param {object} defaultOptions - Default options to use for all rewrites
 * @returns {function} Cookie rewriter function
 */
export function createCookieRewriter(defaultOptions = {}) {
  return {
    rewrite: (cookieString, extraOptions = {}) => {
      return rewriteCookie(cookieString, { ...defaultOptions, ...extraOptions });
    },
    rewriteAll: (cookies, extraOptions = {}) => {
      return rewriteCookies(cookies, { ...defaultOptions, ...extraOptions });
    },
    rewriteHeaders: (headers, extraOptions = {}) => {
      return rewriteHeadersCookies(headers, { ...defaultOptions, ...extraOptions });
    }
  };
}

// Export default object for convenience
export default {
  parseCookie,
  serializeCookie,
  rewriteCookie,
  rewriteCookies,
  extractSetCookieHeaders,
  rewriteHeadersCookies,
  createCookieRewriter
};
