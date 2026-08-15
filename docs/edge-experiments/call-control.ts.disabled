// call-control — put the phone number in the HTML the SERVER sends, when and only when the line
// is genuinely answering.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
//
// The site is static HTML, so until now the number could only be added by JavaScript after load:
// `answered.js` fetches /api/demo-health and fills every [data-callslot] on green. That is correct
// and it stays. But it means the digits are absent for anyone with JavaScript off, absent to a
// screen reader until script runs, and absent from the served bytes entirely, which is what a
// crawler and a link preview read.
//
// The tempting fix is to bake the number into the pages at build time. That is the WRONG fix and
// this estate has the scar: a control that cannot act must never render. A number baked into static
// HTML keeps being served after the line goes down, out of a CDN cache, for as long as the cache
// lives, and every one of those pages dials into silence.
//
// An edge function is the honest resolution, because it is the only layer that knows BOTH things at
// once: it is on the server side of the cache, and it runs per request. So the decision is made
// fresh, and the answer is in the bytes.
//
// ── THE RULES THIS FILE OBEYS ────────────────────────────────────────────────────────────────
//
//  1. FAIL OPEN TO THE PAGE, NEVER TO A NUMBER. Any error, timeout, unexpected shape or unreadable
//     health answer leaves the HTML EXACTLY as it was. The page then behaves as it does today and
//     `answered.js` decides. This function can only ever ADD a number, never remove a page.
//  2. THE HEALTH VERDICT IS CACHED, BECAUSE A FETCH PER PAGE VIEW IS A SELF-INFLICTED OUTAGE.
//     One check per isolate per TTL. A stale-but-recent green is acceptable; the JS gate re-checks
//     on the client anyway, and it is the second opinion.
//  3. IT ONLY EVER TOUCHES HTML. Assets, JSON and everything else pass through untouched.
//  4. IT DOES NOT INVENT A NUMBER. The digits come from the same env var the voice stack uses. If
//     that is unset there is nothing to inject and the page is returned unchanged.

const HEALTH_TTL_MS = 45_000;
const HEALTH_TIMEOUT_MS = 1_200; // a visitor must never wait on our own health check

let cachedVerdict: { ok: boolean; at: number } | null = null;

async function lineIsAnswering(origin: string): Promise<boolean> {
  const now = Date.now();
  if (cachedVerdict && now - cachedVerdict.at < HEALTH_TTL_MS) return cachedVerdict.ok;
  try {
    const r = await fetch(`${origin}/api/demo-health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { 'cache-control': 'no-store' },
    });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    // BOTH must be true. `healthy` is the site-wide verdict; `outbound` being ready is not enough,
    // because a caller dialling us needs the INBOUND line, which is what the number is.
    const ok = j && j.healthy === true && j.checks && j.checks.twilio_number
      && j.checks.twilio_number.landed === true && j.checks.twilio_number.ok === true;
    cachedVerdict = { ok: Boolean(ok), at: now };
    return cachedVerdict.ok;
  } catch (_e) {
    // Unknown is NOT green. Cache the negative briefly so a health outage does not turn into a
    // fetch storm, and let the page render exactly as it does today.
    cachedVerdict = { ok: false, at: now };
    return false;
  }
}

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export default async (request: Request, context: { next: () => Promise<Response> }) => {
  const res = await context.next();

  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return res;

  const tel = (Deno.env.get('ANSWERED_DEMO_NUMBER') || '').trim();
  if (!/^\+\d{10,15}$/.test(tel)) return res; // nothing real to inject

  let html: string;
  try {
    html = await res.text();
  } catch (_e) {
    return res;
  }

  // No slot on this page means nothing to do, and reading further would be wasted work.
  if (!html.includes('data-callslot')) {
    return new Response(html, res);
  }

  let answering = false;
  try {
    answering = await lineIsAnswering(new URL(request.url).origin);
  } catch (_e) {
    answering = false;
  }
  if (!answering) {
    // The honest fallback already in the page is the right thing to serve. Untouched.
    return new Response(html, res);
  }

  // Pretty form for humans and screen readers: +1 (916) 350-4869 rather than a run of digits.
  const m = tel.match(/^\+(\d)(\d{3})(\d{3})(\d{4})$/);
  const pretty = m ? `+${m[1]} (${m[2]}) ${m[3]}-${m[4]}` : tel;

  // Replace the CONTENTS of every call slot with a real, server-rendered link. answered.js is
  // idempotent on slots that already carry a control, so the client gate leaves these alone.
  const out = html.replace(
    /(<span class="cta-slot"[^>]*data-callslot(?:="[^"]*")?[^>]*>)([\s\S]*?)(<\/span>)/g,
    (_full, open: string, _inner: string, close: string) => {
      const labelMatch = open.match(/data-callslot="([^"]*)"/);
      const label = labelMatch && labelMatch[1] ? labelMatch[1] : 'Call the line';
      return open
        + `<a class="btn btn-primary btn-call" href="tel:${escapeAttr(tel)}">`
        + `<span class="call-l">${escapeAttr(label)}</span> `
        + `<span class="call-n">${escapeAttr(pretty)}</span></a>`
        + close;
    },
  );

  const headers = new Headers(res.headers);
  // The answer depends on a live verdict, so it must not be cached as if it were static.
  headers.set('cache-control', 'no-store');
  return new Response(out, { status: res.status, headers });
};

export const config = {
  // Every public HTML page. Excludes the API and the assets, which this never touches anyway.
  path: '/*',
  excludedPath: ['/api/*', '/assets/*', '/.netlify/*', '/internal/*', '/truce/*'],
};
