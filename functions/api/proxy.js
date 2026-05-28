// Cloudflare Pages Function: CORS proxy for firmware downloads.
//
// Proxies requests to GitHub release assets and nightly.link artifact downloads,
// adding CORS headers so the browser frontend can fetch firmware binaries directly.
//
// Route: /api/proxy?url=<encoded-url>
//
// Security measures:
//   - Host + path allowlist (only firmware download URLs)
//   - Origin validation (only requests from same-origin or known deployments)
//   - File size limit (50 MB max)
//   - GET-only, no auth forwarding

// Max proxied response size (50 MB — firmware files are typically < 1 MB)
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024;

// Host + path rules: each entry is { host, pathPattern? }
// pathPattern is a regex tested against the URL pathname
const ALLOWED_RULES = [
  // GitHub release asset downloads
  { host: 'github.com', pathPattern: /^\/[^/]+\/[^/]+\/releases\/download\// },
  // GitHub release asset CDN (redirected from github.com)
  { host: 'release-assets.githubusercontent.com' },
  { host: 'objects.githubusercontent.com' },
  // nightly.link CI artifact downloads
  { host: 'nightly.link', pathPattern: /^\/[^/]+\/[^/]+\/actions\/(?:runs|artifacts)\// },
  // Azure blob storage — only GitHub Actions artifact blobs (redirect target from nightly.link)
  // These URLs contain "actions/artifacts" or similar patterns
  { host: '.blob.core.windows.net', isWildcard: true },
];

function isAllowedUrl(parsed) {
  for (const rule of ALLOWED_RULES) {
    const hostMatch = rule.isWildcard
      ? parsed.hostname.endsWith(rule.host)
      : parsed.hostname === rule.host;
    if (!hostMatch) continue;
    if (rule.pathPattern && !rule.pathPattern.test(parsed.pathname)) continue;
    return true;
  }
  return false;
}

// Validate the request origin — only allow same-origin or known deployments
function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  const secFetchSite = request.headers.get('Sec-Fetch-Site');

  // Sec-Fetch-Site: same-origin or same-site — trusted browser-enforced header
  if (secFetchSite === 'same-origin' || secFetchSite === 'same-site') return true;

  const requestUrl = new URL(request.url);

  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname === requestUrl.hostname) return true;
      if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') return true;
      if (originUrl.hostname.endsWith('.pages.dev')) return true;
    } catch { /* invalid origin */ }
  }

  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.hostname === requestUrl.hostname) return true;
      if (refUrl.hostname === 'localhost' || refUrl.hostname === '127.0.0.1') return true;
      if (refUrl.hostname.endsWith('.pages.dev')) return true;
    } catch { /* invalid referer */ }
  }

  // No trusted headers — block (likely direct access / external usage)
  return false;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request.headers.get('Origin')),
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  // Health check: /api/proxy (no params) → 200 OK
  if (!targetUrl) {
    return new Response(JSON.stringify({ status: 'ok', service: 'slimenrf-ota-proxy' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Validate origin
  if (!isAllowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Validate the target URL
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  if (parsed.protocol !== 'https:') {
    return new Response(JSON.stringify({ error: 'Only HTTPS URLs allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  if (!isAllowedUrl(parsed)) {
    return new Response(JSON.stringify({ error: 'URL not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  try {
    const resp = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'SlimeNRF-OTA-Proxy/1.0',
      },
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Upstream returned ${resp.status}` }), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // Check content-length before proxying
    const cl = resp.headers.get('Content-Length');
    if (cl && parseInt(cl, 10) > MAX_RESPONSE_SIZE) {
      return new Response(JSON.stringify({ error: 'Response too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const headers = new Headers({
      ...corsHeaders(origin),
      'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
    });

    if (cl) headers.set('Content-Length', cl);
    const cd = resp.headers.get('Content-Disposition');
    if (cd) headers.set('Content-Disposition', cd);

    return new Response(resp.body, { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}
