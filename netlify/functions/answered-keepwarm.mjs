// Scheduled warmer for the demo-line path. The one cold-start 500 we ever saw
// happened on the first request to a cold answered-brain; a warm ping every
// five minutes retires the class (the estate's voice-keepwarm pattern). The
// ping is token-free: it proves route + auth + key config and never spends a
// model call. Secrets by env name only.
export default async () => {
  const results = {};
  const secret = (process.env.ANSWERED_BRAIN_SECRET || '').trim();
  const site = 'https://answered.reddenda.com';

  if (secret) {
    try {
      const r = await fetch(site + '/api/answered-brain', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ warm: true }),
        signal: AbortSignal.timeout(8000),
      });
      results.brain = r.status;
    } catch (e) {
      results.brain = 'failed: ' + String(e && e.message).slice(0, 60);
    }
  } else {
    results.brain = 'skipped: ANSWERED_BRAIN_SECRET not set';
  }

  try {
    const r = await fetch(site + '/api/demo-health', { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    results.health = j ? (j.healthy ? 'green' : 'red: ' + JSON.stringify(j.checks)) : 'status ' + r.status;
  } catch (e) {
    results.health = 'failed: ' + String(e && e.message).slice(0, 60);
  }

  // GET on the Twilio webhook 405s by design; the invocation still warms it
  try {
    const r = await fetch(site + '/api/answered-voice', { signal: AbortSignal.timeout(8000) });
    results.voice = r.status;
  } catch (e) {
    results.voice = 'failed: ' + String(e && e.message).slice(0, 60);
  }

  const line = 'answered-keepwarm brain=' + results.brain + ' health=' + results.health + ' voice=' + results.voice;
  if (String(results.health).startsWith('red') || String(results.health).startsWith('failed')) {
    console.error(line); // red health must be loud in the log stream
  } else {
    console.log(line);
  }
  return new Response('ok');
};

export const config = { schedule: '*/5 * * * *' };
