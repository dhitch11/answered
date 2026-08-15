#!/usr/bin/env node
// notes-fit.test.mjs — test the instruction-length card's WARNING branches, which live data cannot
// reach because no account is currently over the limit.
//
//   node research/notes-fit.test.mjs
//
// The passing state ("fits, 1,734 characters headroom") renders on prod today and proves only the
// passing state. Every branch that matters — will-clip, has-clipped, has-clipped-but-since-fixed,
// unmeasurable — is unreachable without an account that has written too much, so they are exercised
// here against the SHIPPED function extracted from the emitted page.
//
// The since-fixed case is the one worth keeping: a stored flag alone would go on accusing an owner
// who has already trimmed their notes, which is how a warning surface teaches people to ignore it.
const m = await import('/Users/user/answered-site/netlify/functions/lib/admin-ui.mjs');
const html = m.consolePage({ admin:{email:'a@b.c',admin_id:1}, buildInfo:{} });
const grab = (name) => {
  let i = html.indexOf('function ' + name + '(');
  if (i < 0) i = html.indexOf('const ' + name + ' = ');
  if (i < 0) throw new Error('missing ' + name);
  if (html.startsWith('function', i)) { let d=0;
    for (let k=html.indexOf('{',i); k<html.length; k++){ if(html[k]==='{')d++; else if(html[k]==='}'){d--; if(!d) return html.slice(i,k+1);} } }
  let d=0; for (let k=i;k<html.length;k++){ const c=html[k];
    if('({['.includes(c))d++; else if(')}]'.includes(c))d--; else if(c===';'&&d===0) return html.slice(i,k+1); }
};
const src = ['esc','stamp','n','kv','notesFitCard'].map(grab).join('\n');
const f = new Function(src + '; return notesFitCard;')();

const T = (label, input, expect) => {
  const out = f(input) || '';
  const ok = expect.every(e => out.includes(e));
  console.log((ok?'PASS':'FAIL').padEnd(5), label.padEnd(46), ok?'':JSON.stringify(out.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,220)));
  return ok;
};
let bad = 0;
if (!T('fits, never clipped -> quiet, no warning',
  { measurable:true, chars_now:2266, limit:4000, over_by:0, will_clip:false, happened:null },
  ['Headroom','1,734'])) bad++;
if (!T('WILL clip -> names the overflow and the risk',
  { measurable:true, chars_now:9000, limit:4000, over_by:5000, will_clip:true, happened:null },
  ['too long to send whole','5,000','Never say','not happened on a real call yet'])) bad++;
if (!T('HAS clipped and still over -> both facts',
  { measurable:true, chars_now:9000, limit:4000, over_by:5000, will_clip:true,
    happened:{ chars_sent:9000, chars_kept:4000, chars_dropped:5000, times_seen:3, last_seen:new Date().toISOString() } },
  ['too long to send whole','already happened','on 3 calls'])) bad++;
if (!T('HAS clipped but SINCE FIXED -> says fixed',
  { measurable:true, chars_now:1200, limit:4000, over_by:0, will_clip:false,
    happened:{ chars_sent:9000, chars_kept:4000, chars_dropped:5000, times_seen:1, last_seen:new Date().toISOString() } },
  ['fixed now','already happened','once'])) bad++;
if (!T('unmeasurable -> says so, blames the check not the notes',
  { measurable:false, error:'renderSpec threw' },
  ['Could not be measured','renderSpec threw'])) bad++;
if (!T('absent -> renders nothing at all', null, [])) bad++;
console.log(f(null) === '' ? 'PASS  absent renders empty string' : 'FAIL  absent rendered something');
process.exit(bad?1:0);
