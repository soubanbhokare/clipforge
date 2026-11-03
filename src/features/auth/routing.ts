// Tiny hash-routing helpers shared by App.tsx and the auth pages.
// The app router is hash-based (#/login, #/app/studio, …); these
// helpers parse the path + query out of location.hash and navigate
// by assigning a new hash.

export interface ParsedHash {
  /** Route path without the leading "#/" — e.g. "login", "app/studio". Empty string = landing. */
  path: string;
  params: URLSearchParams;
}

export function parseHash(): ParsedHash {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  return {
    path: (pathPart ?? "").replace(/\/+$/, ""),
    params: new URLSearchParams(queryPart ?? ""),
  };
}

export function navigateTo(hashPath: string): void {
  window.location.hash = hashPath.startsWith("#") ? hashPath : `#/${hashPath}`;
}

/** Plain workspace routes that may be used as a return target. */
const RETURN_ROUTES = new Set([
  "studio",
  "projects",
  "clips",
  "editor",
  "exports",
  "templates",
  "publishing",
  "publishing-calendar",
  "publishing-queue",
  "analytics",
  "settings",
]);

/**
 * Parameterised workspace routes that may be used as a return target:
 * the Studio workflow sub-routes and project deep links (detail,
 * editor, exports). The id segment accepts the same characters the
 * router itself accepts in App.tsx.
 */
const RETURN_PATTERNS = [
  /^studio\/(create|enhance)$/,
  /^projects\/[A-Za-z0-9-]+$/,
  /^projects\/[A-Za-z0-9-]+\/(editor|exports)$/,
];

/** True when `candidate` (already stripped of any "app/" prefix) is a
 *  known in-app destination. Anything else — external URLs, unknown
 *  routes, traversal tricks — is rejected, so a crafted ?return= can
 *  never become an open redirect. */
export function isReturnTarget(candidate: string): boolean {
  if (RETURN_ROUTES.has(candidate)) return true;
  return RETURN_PATTERNS.some((re) => re.test(candidate));
}

/** Where to send the user after a successful sign-in: the intended
 *  destination, including deep links such as projects/<id>/editor,
 *  when it validates against the route allowlist above. */
export function returnTarget(fallback = "app/studio"): string {
  const target = parseHash().params.get("return");
  if (target) {
    const clean = target.startsWith("app/") ? target.slice(4) : target;
    if (isReturnTarget(clean)) return clean;
  }
  return fallback.replace(/^app\//, "");
}
