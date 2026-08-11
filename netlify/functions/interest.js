// The interest form's real endpoint.
// Netlify's automatic form detection is OFF for this site, so a form that
// relied on it would render perfectly and silently drop every submission.
// This function owns the whole path instead, and it fails LOUD rather than
// fail open: if the mail provider is unreachable the submitter is told so.
// Secrets by name only: RESEND_API_KEY from the site env, never logged.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').slice(0, 4000);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { Allow: 'POST' }, body: 'Method not allowed' };
  }

  let f = {};
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');
    const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '');
    if (ct.indexOf('application/json') === 0) {
      f = JSON.parse(raw || '{}');
    } else {
      new URLSearchParams(raw).forEach((v, k) => { f[k] = v; });
    }
  } catch (e) {
    return { statusCode: 400, body: 'Could not read that submission.' };
  }

  if (f['bot-field']) { return { statusCode: 303, headers: { Location: '/thanks.html' }, body: '' }; }

  const email = String(f.email || '').trim();
  if (!email || email.indexOf('@') < 1) {
    return { statusCode: 400, body: 'An email address is required.' };
  }

  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) {
    // No silent success. If we cannot deliver it, the person is told.
    return { statusCode: 503, body: 'We could not record that right now. Please email info@reddenda.com and we will pick it up.' };
  }

  const rows = [
    ['Name', f.name], ['Email', email], ['Phone', f.phone],
    ['Which part', f.product], ['Note', f.note],
  ].filter((r) => r[1]);

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1E1B17">' +
    '<h2 style="font-size:18px;margin:0 0 14px">Answered: new interest</h2><table style="border-collapse:collapse">' +
    rows.map((r) =>
      '<tr><td style="padding:6px 18px 6px 0;color:#6B6459;vertical-align:top;white-space:nowrap">' + esc(r[0]) +
      '</td><td style="padding:6px 0"><b>' + esc(r[1]) + '</b></td></tr>').join('') +
    '</table><p style="font-size:12px;color:#6B6459;margin-top:18px">answered-preview.netlify.app</p></div>';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Answered <info@reddenda.com>',
        to: ['David@Reddenda.com'],
        reply_to: email,
        subject: 'Answered: ' + (f.product || 'interest') + ' from ' + (f.name || email),
        html,
      }),
    });
    if (!r.ok) {
      return { statusCode: 502, body: 'We could not record that right now. Please email info@reddenda.com and we will pick it up.' };
    }
  } catch (e) {
    return { statusCode: 502, body: 'We could not record that right now. Please email info@reddenda.com and we will pick it up.' };
  }

  return { statusCode: 303, headers: { Location: '/thanks.html' }, body: '' };
};
