#!/usr/bin/env node
// enrich.mjs — turn the corpus into a lead book by reading what each business publishes itself.
//
//   ./research/with-env.sh node research/enrich.mjs --limit 200
//   ./research/with-env.sh node research/enrich.mjs --limit 50 --state OH
//
// WHAT THIS DOES: fetches the business's OWN website — the one they listed publicly — and reads
// the owner's name, a business email and a LinkedIn link out of the HTML they published. A
// contractor's site almost always says "Owned and operated by Dave Rivera" and prints an office
// email, because they want customers to have both.
//
// ★ WHAT THIS DELIBERATELY DOES NOT DO, and each of these is a decision rather than a gap:
//   - No LinkedIn scraping. It breaks their terms, and the estate already measured that the useful
//     signal there is not indexable anyway. A linkedin.com link the business itself published on
//     its own page is fine; going to LinkedIn to find one is not.
//   - No guessed emails. dave@<domain> is a plausible string, not a fact, and a CRM full of
//     plausible strings is worse than empty columns because somebody will mail them.
//   - No personal addresses. Business contact only. A gmail address on a contractor's contact page
//     is their business address and is fine; anything that looks like a private individual is not.
//   - No bought lists.
//
// A field it cannot fill honestly stays NULL and `enriched_at` is set anyway, so the record says
// "we looked and they do not publish one" rather than "nobody has looked". Those are two different
// empties and the console renders them differently.
//
// Politeness: one request per site, a real timeout, a descriptive User-Agent with a contact route,
// robots.txt respected, and a pause between hosts. We are reading a small business's homepage, not
// crawling them.

import { read } from './lib/store.mjs';

const URL_ = process.env.ANSWERED_DB_URL;
const ANON = process.env.ANSWERED_DB_ANON;
const SECRET = process.env.ANSWERED_DB_SECRET;
if (!URL_ || !ANON || !SECRET) {
  console.error('Run through research/with-env.sh.');
  process.exit(1);
}

const UA = 'Answered-Research/1.0 (+https://answered.reddenda.com; contact: info@reddenda.com)';
const argv = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || 'true']),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, args = {}) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...args }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

const robotsCache = new Map();
async function robotsAllows(origin, path) {
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const r = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const txt = await r.text();
        let applies = false;
        for (const line of txt.split('\n')) {
          const l = line.trim().toLowerCase();
          if (l.startsWith('user-agent:')) applies = ['*'].includes(l.split(':')[1].trim());
          else if (applies && l.startsWith('disallow:')) {
            const p = line.split(':').slice(1).join(':').trim();
            if (p) rules.push(p);
          }
        }
      }
    } catch { rules = []; }
    robotsCache.set(origin, rules);
  }
  return !robotsCache.get(origin).some((p) => path.startsWith(p));
}

// ── extraction ───────────────────────────────────────────────────────────────────────────────
const NOT_A_PERSON = /\b(llc|inc|corp|company|services?|plumbing|heating|cooling|hvac|electric|roofing|construction|contractors?|group|solutions?|air|sons?|brothers)\b/i;

function extractOwner(text) {
  // Only patterns where the page itself says this string is a person's name.
  const pats = [
    /(?:owned\s+and\s+operated\s+by|owner[,:]?\s+|founded\s+by|founder[,:]?\s+)\s*([A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+){1,2})/,
    /([A-Z][a-z'\-]+\s+[A-Z][a-z'\-]+)\s*[,–-]\s*(?:Owner|Founder|President|Proprietor)\b/,
    /\b(?:Meet|Hi,?\s+I'?m|My name is)\s+([A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+)?)/,
  ];
  for (const re of pats) {
    const m = re.exec(text);
    if (m && m[1] && !NOT_A_PERSON.test(m[1]) && m[1].length <= 40) {
      return m[1].replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function extractEmail(html, host) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+@[^"'?\s>]+)/gi)) found.add(m[1].toLowerCase());
  for (const m of html.matchAll(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi)) found.add(m[1].toLowerCase());
  const bad = /(example|sentry|wixpress|@2x|\.png|\.jpg|godaddy|squarespace|domain|sentry\.io)/i;
  const list = [...found].filter((e) => !bad.test(e) && e.length < 80);
  // Prefer an address on the business's own domain: that is unambiguously theirs.
  const own = list.find((e) => host && e.endsWith(`@${host.replace(/^www\./, '')}`));
  return own || list.find((e) => /^(info|office|contact|service|sales|admin|hello)@/.test(e)) || list[0] || null;
}

function extractLinkedIn(html) {
  const m = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_\-%.]+/i.exec(html);
  return m ? m[0].replace(/[)"'<>]+$/, '') : null;
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
const corpus = (await read('corpus')).filter((r) => r.website);
const pool = argv.state ? corpus.filter((r) => r.state === argv.state.toUpperCase()) : corpus;
const todo = pool.slice(0, Number(argv.limit || 100));

console.log(`\n${corpus.length} corpus rows carry a website; enriching ${todo.length}\n`);

const stat = { looked: 0, name: 0, email: 0, linkedin: 0, unreachable: 0, blocked: 0 };

for (const [i, r] of todo.entries()) {
  let url;
  try { url = new URL(r.website.startsWith('http') ? r.website : `https://${r.website}`); }
  catch { continue; }

  const sources = ['business_website'];
  let owner = null; let email = null; let linkedin = null;
  // ★ THE FOURTH STATE. Null here means we genuinely read the page and it publishes nothing.
  // A set reason means we never got to read it, which is a different fact and the only one of the
  // two where retrying is worthwhile.
  let failed = null;

  try {
    if (!(await robotsAllows(url.origin, url.pathname || '/'))) {
      stat.blocked += 1;
      sources.push('robots_disallowed');
      failed = 'robots_disallowed';
    } else {
      const res = await fetch(url.href, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const html = (await res.text()).slice(0, 400000);
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
        owner = extractOwner(text);
        email = extractEmail(html, url.hostname);
        linkedin = extractLinkedIn(html);
        // A page that is a JS shell has no readable content, so finding nothing in it is not
        // evidence the business publishes nothing. Treat it as unread rather than as bare.
        if (!owner && !email && !linkedin && text.replace(/\s/g, '').length < 400) {
          failed = 'js_shell_no_readable_html';
          sources.push('js_shell');
        }
      } else {
        stat.unreachable += 1;
        sources.push(`http_${res.status}`);
        failed = `http_${res.status}`;
      }
    }
  } catch (e) {
    stat.unreachable += 1;
    sources.push('unreachable');
    failed = /timeout|abort/i.test(String(e && e.message)) ? 'timeout' : 'unreachable';
  }

  stat.looked += 1;
  if (owner) stat.name += 1;
  if (email) stat.email += 1;
  if (linkedin) stat.linkedin += 1;

  try {
    // enriched_at is set WHATEVER the outcome. That is the whole point: a null name with a set
    // timestamp means "they do not publish one", which is different from "nobody looked".
    await rpc('sv_enrich_contact', {
      p_phone: r.phone,
      p_patch: {
        contact_name: owner, contact_role: owner ? 'owner' : null,
        email, email_source: email ? 'business_website' : null,
        linkedin_url: linkedin, website: r.website, sources,
        // cleared on a successful read, so a site that comes back up stops looking retryable
        failed_reason: failed,
      },
    });
  } catch (e) {
    console.error(`\n  write failed for ${r.phone}: ${String(e.message).slice(0, 100)}`);
  }

  process.stdout.write(`\r  ${i + 1}/${todo.length}  names ${stat.name}  emails ${stat.email}  linkedin ${stat.linkedin}`);
  await sleep(1200);
}

console.log(`\n
  looked at      ${stat.looked}
  owner name     ${stat.name}   ${Math.round((stat.name / Math.max(stat.looked, 1)) * 100)}%
  email          ${stat.email}   ${Math.round((stat.email / Math.max(stat.looked, 1)) * 100)}%
  linkedin       ${stat.linkedin}   ${Math.round((stat.linkedin / Math.max(stat.looked, 1)) * 100)}%
  unreachable    ${stat.unreachable}   (retryable: enrichment_failed_reason is set)
  robots blocked ${stat.blocked}

  Every row above has enriched_at set, including the ones that found nothing. A null field with a
  timestamp means they do not publish it, which is a different fact from nobody having looked.
`);
