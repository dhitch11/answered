#!/usr/bin/env node
// thread-render.test.mjs — test the SHIPPED conversation renderer, against the bytes the browser
// receives, with a hostile payload.
//
//   node research/thread-render.test.mjs
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
// crm_messages was empty when the Conversation tab shipped, so threadBubble had never rendered a
// single real row. An empty state proves the empty state and nothing about the populated path.
// This feeds the renderer the EXACT row shapes sv_crm_thread returns, measured inside a
// transaction that was then rolled back, so no data was fabricated to obtain them.
//
// It EXTRACTS esc, stamp and threadBubble out of the emitted page rather than importing them,
// because they live inside a template literal and the thing worth testing is what SHIPS. Checking
// the container never checks the artifact: node --check passes on admin-ui.mjs whether or not the
// string it emits is valid JavaScript, which is exactly how a syntax error once killed an entire
// inline script while every file-level check stayed green.
//
// THE HOSTILE ROW IS NOT DECORATION. Inbound message bodies are written by third parties. The day
// inbound SMS is wired, whatever a stranger sends us lands in this renderer, so "does it escape"
// is a real question with a real answer, asserted here rather than assumed.
import { chromium } from '/Users/user/.t6-verify/node_modules/playwright/index.mjs';
const m = await import('/Users/user/answered-site/netlify/functions/lib/admin-ui.mjs');
const html = m.consolePage({ admin:{email:'d@r.com',admin_id:1}, buildInfo:{commit:'x'} });

// Pull the SHIPPED source of the three functions under test out of the page the browser receives.
// Not a copy, not a reimplementation: these exact bytes go to production.
const grab = (name) => {
  // esc and stamp ship as const arrow functions; threadBubble ships as a declaration.
  let i = html.indexOf('function ' + name + '(');
  if (i < 0) i = html.indexOf('const ' + name + ' = ');
  if (i < 0) i = html.indexOf('const ' + name + '=');
  if (i < 0) throw new Error('could not find ' + name + ' in the emitted page');
  if (html.startsWith('function', i)) {
    let d = 0;
    for (let k = html.indexOf('{', i); k < html.length; k++) {
      if (html[k] === '{') d++;
      else if (html[k] === '}') { d--; if (!d) return html.slice(i, k + 1); }
    }
    throw new Error('unbalanced braces reading ' + name);
  }
  // an arrow const: read to the semicolon that closes it at depth zero
  let d = 0;
  for (let k = i; k < html.length; k++) {
    const c = html[k];
    if (c === '(' || c === '{' || c === '[') d++;
    else if (c === ')' || c === '}' || c === ']') d--;
    else if (c === ';' && d === 0) return html.slice(i, k + 1);
  }
  throw new Error('no terminator reading ' + name);
};
const src = ['esc','stamp','threadBubble'].map(grab).join('\n\n');
console.log('extracted', src.length, 'chars of shipped source');

const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [])[1] || '';
console.log('extracted', css.length, 'chars of shipped CSS');

const b = await chromium.launch({ channel:'chrome', headless:true });
const p = await (await b.newContext({ viewport:{width:1000,height:800} })).newPage();
const errors = []; p.on('pageerror', e => errors.push(e.message));
await p.setContent('<!doctype html><html><head><style>' + css + '</style></head><body></body></html>');
await p.addScriptTag({ content: src + '\nwindow.__tb = threadBubble;' });

const out = await p.evaluate(() => {
  const rows = [
    {channel:'sms',  direction:'outbound', status:'sent',      body:'Probe: an ordinary outbound text.',       created_at:new Date(Date.now()-9e5).toISOString(), sent_by:'david@reddenda.com'},
    {channel:'sms',  direction:'inbound',  status:'delivered', body:'Probe: what an inbound reply looks like.',created_at:new Date(Date.now()-7e5).toISOString()},
    {channel:'email',direction:'outbound', status:'blocked',   body:'Probe: a blocked send must still appear.',failure_reason:'No email address is on file for this business.', created_at:new Date(Date.now()-5e5).toISOString()},
    {channel:'sms',  direction:'outbound', status:'failed',    body:'Probe: a failed send is not a blocked one.',failure_reason:'The carrier rejected the message.', created_at:new Date(Date.now()-3e5).toISOString()},
    {channel:'email',direction:'outbound', status:'sent',      subject:'A subject line', body:'AI drafted body.', ai_assisted:true, ai_model:'claude-sonnet-5', created_at:new Date().toISOString()},
    {channel:'sms',  direction:'inbound',  status:'delivered', body:'<img src=x onerror="window.__XSS=1">',    created_at:new Date().toISOString()},
    // a blocked row with NO reason recorded: the renderer must say so rather than print nothing
    {channel:'sms',  direction:'outbound', status:'blocked',   body:'No reason on this one.',                  created_at:new Date().toISOString()},
  ];
  const host = document.createElement('div');
  host.className = 'thread';
  host.innerHTML = rows.map(window.__tb).join('');
  document.body.appendChild(host);
  const bubs = [...host.querySelectorAll('.bub')];
  return {
    rendered: bubs.length,
    bad: bubs.filter(x => x.className.includes('bub-bad')).length,
    align: bubs.map(x => getComputedStyle(x).alignSelf),
    blockedReason: host.querySelector('.bub-bad .bub-f')?.textContent?.trim().slice(0,70) || null,
    noReasonText: [...host.querySelectorAll('.bub-f')].map(x=>x.textContent).find(t=>/no reason/i.test(t))?.slice(0,90) || null,
    aiPill: [...host.querySelectorAll('.pill')].some(x => x.textContent.includes('AI drafted')),
    aiModelTitle: [...host.querySelectorAll('.pill')].find(x=>x.textContent.includes('AI drafted'))?.title || null,
    subjectShown: !!host.querySelector('.bub-s'),
    xss: window.__XSS === 1,
    img: !!host.querySelector('img'),
    escapedText: host.querySelectorAll('.bub-t')[5]?.textContent?.slice(0,40) || null,
    hatchOnBad: getComputedStyle(bubs.find(x=>x.className.includes('bub-bad'))).backgroundImage.includes('gradient'),
  };
});
console.log(JSON.stringify(out,null,1));
console.log('---');
const P = (c) => c ? 'PASS' : 'FAIL';
console.log('7 bubbles rendered                :', P(out.rendered===7), out.rendered);
console.log('blocked AND failed styled as bad  :', P(out.bad===3), out.bad);
console.log('inbound left / outbound right     :', P(out.align[0]==='flex-end' && out.align[1]==='flex-start'), out.align.slice(0,2).join(','));
console.log('blocked carries its reason        :', P(!!out.blockedReason), JSON.stringify(out.blockedReason));
console.log('missing reason is NAMED not blank :', P(!!out.noReasonText), JSON.stringify(out.noReasonText));
console.log('AI-drafted disclosed + model named:', P(out.aiPill && !!out.aiModelTitle), out.aiModelTitle);
console.log('subject rendered                  :', P(out.subjectShown));
console.log('hatch survives greyscale          :', P(out.hatchOnBad));
console.log('HOSTILE BODY ESCAPED, NOT RUN     :', P(!out.xss && !out.img), JSON.stringify(out.escapedText));
console.log('page errors:', errors.length? errors.join(' | ') : 'NONE');
await b.close();
