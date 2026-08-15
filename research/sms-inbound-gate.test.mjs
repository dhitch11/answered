// Prove the webhook FAILS CLOSED. It writes a permanent suppression record keyed by phone number,
// so an unverified caller must not be able to opt anyone out — or, worse, opt anyone back IN.
import fs from 'node:fs';
import crypto from 'node:crypto';
const src = fs.readFileSync('netlify/functions/sms-inbound.mjs', 'utf8');
const grab = (name) => { let i=src.indexOf('function '+name+'('); if(i<0) throw new Error(name);
  let d=0; for(let k=src.indexOf('{',i);k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} } };
const verify = new Function('crypto', grab('verify') + '; return verify;')(crypto);

const params = { From: '+19165550142', Body: 'STOP', MessageSid: 'SM1' };
const url = 'https://answered.reddenda.com/api/sms-inbound';
const mk = (sig) => ({ headers: { host:'answered.reddenda.com', 'x-forwarded-proto':'https', 'x-twilio-signature': sig }, rawUrl: url, path: '/api/sms-inbound' });

const T = (label, ok, want) => { const p = ok===want; console.log(`  ${p?'PASS':'FAIL'}  ${label}`); return p?0:1; };
let bad = 0;

// no token at all
delete process.env.TWILIO_AUTH_TOKEN;
bad += T('no auth token -> REFUSES (does not fail open)', verify(mk('anything'), params).ok, false);

process.env.TWILIO_AUTH_TOKEN = 'test-token-abc';
bad += T('no signature header -> refuses', verify(mk(''), params).ok, false);
bad += T('wrong signature -> refuses', verify(mk('bogus'), params).ok, false);

// a correctly signed request, computed the way Twilio does
const data = Object.keys(params).sort().reduce((a,k)=>a+k+params[k], url);
const good = crypto.createHmac('sha1','test-token-abc').update(Buffer.from(data,'utf-8')).digest('base64');
bad += T('correctly signed -> ACCEPTS', verify(mk(good), params).ok, true);

// tampered body with an otherwise valid signature
const tampered = { ...params, Body: 'START' };
bad += T('body tampered after signing -> refuses', verify(mk(good), tampered).ok, false);

console.log('');
console.log(bad ? `${bad} FAILURE(S)` : 'the webhook fails closed and only accepts what Twilio actually signed');
process.exit(bad?1:0);
