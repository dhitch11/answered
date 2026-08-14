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
  throw new Error('unterminated ' + name);
};
const src = ['esc','CALLER_QUOTED_PREFIX','gateWhy'].map(grab).join('\n');
const fn = new Function(src + '; return gateWhy;')();

const cases = [
  ['Do not contact: do-not-call request: stop calling me',              true,  'plain caller words'],
  ['Do not contact: do-not-call request: wrong number, try 555-0100',   true,  'caller giving an instruction'],
  ['Do not contact: do-not-call request: <img src=x onerror=alert(1)>', true,  'HOSTILE caller words'],
  ['The mail provider is not configured.',                             false, 'our own sentence, untouched'],
  ['Do not contact: operator',                                         false, 'operator-set reason'],
  ['Do not contact: do-not-call request:   ',                          false, 'prefix with nothing after it'],
];
let fails = 0;
for (const [input, shouldQuote, label] of cases) {
  const out = fn(input);
  const quoted = out.includes('<q class="heard">');
  const safe = !/<img[^&]/i.test(out);
  const ok = quoted === shouldQuote && safe;
  if (!ok) fails++;
  console.log((ok?'PASS':'FAIL').padEnd(5), label.padEnd(30), quoted?'quoted':'as ours', safe?'':'  ESCAPING BROKEN');
}
console.log('');
console.log('hostile case renders as:');
console.log('  ' + fn('Do not contact: do-not-call request: <img src=x onerror=alert(1)>'));
console.log('');
console.log('attributed case renders as:');
console.log('  ' + fn('Do not contact: do-not-call request: wrong number, try 555-0100'));
process.exit(fails?1:0);
