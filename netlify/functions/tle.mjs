// Serverless proxy for CelesTrak TLE data.
//
// CelesTrak does not send CORS headers, so browsers on the deployed site can't
// fetch it directly. This function fetches it server-side and lets Netlify's
// CDN cache the result (~1 hour per group), so every visitor is served from the
// edge and CelesTrak is hit at most once per group per hour regardless of how
// many people load the site.

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';

export async function handler(event) {
  const group = (event.queryStringParameters?.group || '').trim();

  // Strict validation: the upstream host is fixed and the group is constrained
  // to a safe pattern, so this cannot be turned into an open proxy.
  if (!/^[a-z0-9-]{1,32}$/.test(group)) {
    return { statusCode: 400, headers: { 'cache-control': 'no-store' }, body: 'Invalid group' };
  }

  const url = `${CELESTRAK}?GROUP=${group}&FORMAT=tle`;

  try {
    const res = await fetch(url);
    const text = await res.text();

    // CelesTrak returns 200 with this body when it is throttling a repeat
    // download. Never cache that as if it were data.
    if (!res.ok || /^\s*GP data has not updated/i.test(text)) {
      return {
        statusCode: 503,
        headers: { 'cache-control': 'no-store' },
        body: 'Upstream temporarily unavailable',
      };
    }

    return {
      statusCode: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*',
        // Browser caches briefly; Netlify's edge holds it for an hour and can
        // serve stale while it revalidates in the background.
        'cache-control': 'public, max-age=1800',
        'netlify-cdn-cache-control':
          'public, durable, s-maxage=3600, stale-while-revalidate=86400',
      },
      body: text,
    };
  } catch {
    return { statusCode: 502, headers: { 'cache-control': 'no-store' }, body: 'Fetch failed' };
  }
}
