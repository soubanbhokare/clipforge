// CLIPFORGE API client base.
//
// The frontend talks to the backend same-origin: in development the
// Vite server proxies "/api" to http://localhost:3001 (see
// vite.config.ts), and in production the API is served from the same
// origin as the app. VITE_API_URL can override this for a separately
// hosted API. No secrets ever live in frontend code — authentication
// rides on the server's HttpOnly session cookie.
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "/api";
