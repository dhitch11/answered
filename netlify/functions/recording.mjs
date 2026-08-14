// /api/recording — streams a call recording, but only to an operator who is signed in.
//
// The recording URL stored on a call row points here, never at Twilio. That matters: a Twilio
// media URL is effectively a bearer token for a customer's voice, and the moment one is pasted
// into a ticket, a Slack message or a browser history it has escaped. This route checks the
// cockpit cookie first and fetches the audio server-side with the API key, so a leaked link is
// worth nothing to anyone who is not signed in.

import { cookieValid, readCookie, configured } from './lib/gate-auth.mjs';
import { fetchRecording } from './lib/twilio-rest.mjs';

const COOKIE = 'ans_cockpit';

export const handler = async (event) => {
  if (!configured()) return { statusCode: 503, body: 'not configured' };
  if (!cookieValid(COOKIE, readCookie(event.headers, COOKIE))) {
    return { statusCode: 401, headers: { 'Cache-Control': 'no-store' }, body: 'not signed in' };
  }
  const sid = (event.queryStringParameters || {}).sid;
  if (!sid || !/^RE[0-9a-f]{32}$/i.test(sid)) return { statusCode: 400, body: 'bad recording id' };

  try {
    const audio = await fetchRecording(sid);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=600',
        'X-Robots-Tag': 'noindex, nofollow',
        'Content-Disposition': `inline; filename="${sid}.mp3"`,
      },
      body: audio.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('recording fetch failed:', String(e.message).slice(0, 160));
    return { statusCode: 502, body: 'recording unavailable' };
  }
};
