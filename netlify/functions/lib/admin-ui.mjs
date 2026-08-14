// admin-ui.mjs — the operator console's document.
//
// One HTML document, everything inline, no external origin of any kind. The Content-Security-
// Policy on this response is `default-src 'none'` with `connect-src 'self'`, so there is no CDN,
// no font host, no analytics beacon and no image host it could reach even if something tried.
// A console that lists customers and plays their recordings should not be making requests to
// anybody.
//
// THREE DESIGN LAWS THIS FILE FOLLOWS, EACH BOUGHT WITH A REAL DEFECT SOMEWHERE IN THIS ESTATE:
//
//  1. NEVER RE-RENDER A REGION THAT OWNS FOCUS. A lane in this repo shipped a 2.5s poll that
//     called innerHTML on a region containing an input. Focus fell back to BODY, a keyboard guard
//     that only tested activeElement.tagName stopped matching, and typing a campaign name
//     containing "b" and "x" fired barge and then hangup ON A LIVE CALL. An admin console is
//     nothing but polled tables with inputs in them, so every paint here checks
//     `el.contains(document.activeElement)` and skips rather than steals.
//
//  2. A SINGLE-KEY SHORTCUT MUST PROVE THE PAGE, NOT A FIELD, HAS FOCUS. Every shortcut requires
//     `e.target === document.body`, bails on metaKey/ctrlKey/altKey, and bails on `e.repeat`.
//     Testing tagName is not enough: focus can rest on body while a re-render is in flight.
//
//  3. AN EMPTY STATE MUST SAY WHICH KIND OF EMPTY IT IS. "No customers yet" and "we could not
//     reach the database" look identical on screen and mean opposite things. Every panel here
//     distinguishes a measured zero from an unmeasured one, and prints when it was measured.

const VERSION = '2026-08-14.1';

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── the visual system ────────────────────────────────────────────────────────────────────────
// Every colour below is stated with its measured contrast ratio against the surface it is used
// on. Contrast is measured, never eyeballed: this estate has shipped mint text on a mint button.
//
// ★ THE STYLESHEET IS SPLIT IN TWO ON PURPOSE, AND THE REASON IS THE GATE.
// The first build of this file served ONE stylesheet to both documents, so the login page — the
// only thing an anonymous client ever receives — carried 17,445 bytes including the class names
// for the drawer, the command palette, the tab strip and the audit tables. No customer data
// leaked, and it still failed the standard: an anonymous response should describe the login form
// and nothing else, because the shape of what is behind a door is information about the door.
// TOKENS + BASE is what an anonymous client gets. CONSOLE is added only after a session resolves.
const TOKENS = `
:root{
  --bg:#08090B;          /* page                                              */
  --surface:#0E1013;     /* cards, table bodies                               */
  --raised:#151920;      /* hover, active row, inputs                         */
  --raised-2:#1C212A;    /* pressed, selected                                 */
  --line:#232830;        /* hairlines                                         */
  --line-2:#333A45;      /* emphasised borders, focus rings                   */
  --ink:#F5F7FA;         /* primary text     17.6:1 on --bg                   */
  --ink-2:#AAB3BF;       /* secondary text    9.0:1 on --bg                   */
  --ink-3:#8B94A1;       /* labels, meta      5.8:1 on --bg, 5.4:1 on surface */
  --brand:#DFFF4F;       /* Answered hi-vis  16.1:1 on --bg                   */
  --brand-ink:#0A0C05;
  --ok:#4ADE80; --ok-bg:#0C1F15;
  --warn:#FBBF24; --warn-bg:#221A08;
  --bad:#FF5C7A; --bad-bg:#251016;
  --info:#56CCF2; --info-bg:#0A1C24;
  --r-lg:14px; --r:10px; --r-sm:7px;
  --sp:4px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Arial,sans-serif;
  --ease:cubic-bezier(.2,.8,.2,1);
  --shadow:0 1px 2px rgba(0,0,0,.5),0 8px 24px -12px rgba(0,0,0,.7);
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:var(--bg)}
body{background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);
  -webkit-font-smoothing:antialiased;overflow-wrap:break-word}
a{color:var(--info);text-decoration:none}
a:hover{text-decoration:underline}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}
::selection{background:var(--brand);color:var(--brand-ink)}

/* ── login ───────────────────────────────────────────────────────────────── */
.auth{min-height:100dvh;display:grid;place-items:center;padding:24px 18px}
.auth-card{width:100%;max-width:404px}
.mark{display:flex;align-items:center;gap:10px;margin:0 0 26px}
.mark-dot{width:11px;height:11px;border-radius:50%;background:var(--brand);flex:0 0 auto;
  box-shadow:0 0 0 4px rgba(223,255,79,.12)}
.mark-name{font-weight:700;letter-spacing:-.015em;font-size:16px}
.mark-sub{color:var(--ink-3);font-size:13px;margin-left:auto;font-family:var(--mono)}
.auth h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0 0 7px;font-weight:650}
.auth p.lede{color:var(--ink-2);font-size:14.5px;margin:0 0 24px}
.field{margin:0 0 14px}
.field label{display:block;font-size:12.5px;font-weight:600;letter-spacing:.03em;
  text-transform:uppercase;color:var(--ink-3);margin:0 0 7px}
.input{width:100%;background:var(--raised);border:1px solid var(--line);border-radius:var(--r-sm);
  padding:11px 13px;font-size:15px;transition:border-color .12s var(--ease),background .12s var(--ease)}
.input:hover{border-color:var(--line-2)}
.input:focus{outline:none;border-color:var(--brand);background:var(--raised-2)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:var(--brand);color:var(--brand-ink);border:1px solid var(--brand);
  border-radius:var(--r-sm);padding:11px 17px;font-weight:650;font-size:15px;cursor:pointer;
  transition:transform .1s var(--ease),filter .12s var(--ease)}
.btn:hover{filter:brightness(1.07)}
.btn:active{transform:translateY(1px)}
.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none}
.btn.wide{width:100%}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line-2)}
.btn.ghost:hover{background:var(--raised);filter:none}
.btn.danger{background:var(--bad);border-color:var(--bad);color:#1A0509}
.btn.sm{padding:7px 11px;font-size:13.5px;border-radius:var(--r-sm)}
.note{margin-top:18px;color:var(--ink-3);font-size:13px;line-height:1.6}
.alert{border-radius:var(--r-sm);padding:11px 13px;font-size:14px;margin:0 0 16px;
  border:1px solid var(--bad);background:var(--bad-bg);color:#FFD7DF}
.alert.warn{border-color:var(--warn);background:var(--warn-bg);color:#FFE9B8}
.alert.ok{border-color:var(--ok);background:var(--ok-bg);color:#C6F6D9}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.001ms!important;animation-iteration-count:1!important;
    transition-duration:.001ms!important}
}
`;

// Everything below is added ONLY to an authenticated document.
const CONSOLE_CSS = `
/* ── shell ───────────────────────────────────────────────────────────────── */
.shell{display:grid;grid-template-columns:238px 1fr;min-height:100dvh}
.side{border-right:1px solid var(--line);background:var(--surface);padding:18px 12px;
  display:flex;flex-direction:column;gap:3px;position:sticky;top:0;height:100dvh;overflow-y:auto}
.side .mark{padding:0 8px;margin-bottom:20px}
.nav-h{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-3);padding:16px 10px 7px}
.nav{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:var(--r-sm);
  color:var(--ink-2);cursor:pointer;border:none;background:none;width:100%;text-align:left;
  font-size:14.5px;transition:background .11s var(--ease),color .11s var(--ease)}
.nav:hover{background:var(--raised);color:var(--ink)}
.nav[aria-current="page"]{background:var(--raised-2);color:var(--ink);font-weight:600}
.nav[aria-current="page"] .nav-ico{color:var(--brand)}
.nav-ico{width:16px;text-align:center;color:var(--ink-3);flex:0 0 auto;font-size:13px}
.nav-n{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.side-foot{margin-top:auto;padding:14px 10px 4px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--ink-3);line-height:1.65}
.main{min-width:0;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:12px;padding:14px 22px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:rgba(8,9,11,.86);backdrop-filter:blur(12px);z-index:20}
.top h1{font-size:17px;font-weight:650;letter-spacing:-.01em;white-space:nowrap}
.search{flex:1;max-width:420px;position:relative}
.search .input{padding-left:34px;font-size:14px}
.search::before{content:"⌕";position:absolute;left:12px;top:50%;transform:translateY(-50%);
  color:var(--ink-3);font-size:16px;pointer-events:none}
.kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--line-2);border-radius:5px;
  padding:2px 5px;color:var(--ink-3);background:var(--raised)}
.who{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--ink-2);
  white-space:nowrap}
.body{padding:22px;display:flex;flex-direction:column;gap:18px;flex:1}

/* ── primitives ──────────────────────────────────────────────────────────── */
.grid{display:grid;gap:12px}
.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid.g2{align-items:start}
.grid.g3{align-items:start}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);
  padding:15px 16px}
.card.pad0{padding:0;overflow:hidden}
.card h2{font-size:14px;font-weight:650;letter-spacing:-.005em;margin:0}
.card-h{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line)}
.card-h .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.tile-k{font-size:11.5px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;
  color:var(--ink-3);margin:0 0 8px}
.tile-v{font-size:27px;font-weight:660;letter-spacing:-.025em;font-variant-numeric:tabular-nums;
  line-height:1.1}
.tile-s{font-size:12.5px;color:var(--ink-3);margin-top:5px;line-height:1.45}
.tile-v.brand{color:var(--brand)}
.mono{font-family:var(--mono);font-size:12.5px}
.muted{color:var(--ink-3)}
.dim{color:var(--ink-2)}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:640;
  padding:3px 8px;border-radius:100px;border:1px solid var(--line-2);color:var(--ink-2);
  white-space:nowrap;letter-spacing:.01em}
.pill.ok{color:var(--ok);border-color:rgba(74,222,128,.4);background:var(--ok-bg)}
.pill.warn{color:var(--warn);border-color:rgba(251,191,36,.4);background:var(--warn-bg)}
.pill.bad{color:var(--bad);border-color:rgba(255,92,122,.4);background:var(--bad-bg)}
.pill.info{color:var(--info);border-color:rgba(86,204,242,.4);background:var(--info-bg)}
.pill.brand{color:var(--brand);border-color:rgba(223,255,79,.4);background:rgba(223,255,79,.07)}

/* ── tables ──────────────────────────────────────────────────────────────── */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  color:var(--ink-3);padding:9px 14px;border-bottom:1px solid var(--line);white-space:nowrap;
  position:sticky;top:0;background:var(--surface)}
td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr{transition:background .1s var(--ease)}
tbody tr:hover{background:var(--raised)}
tbody tr.click{cursor:pointer}
tbody tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px}
.trunc{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}

/* ── empty and error states ──────────────────────────────────────────────── */
.empty{padding:38px 22px;text-align:center;color:var(--ink-2)}
.empty .big{font-size:16px;font-weight:640;color:var(--ink);margin-bottom:7px}
.empty .sm{font-size:13.5px;line-height:1.65;max-width:56ch;margin:0 auto;color:var(--ink-3)}
.empty.err .big{color:var(--bad)}
.skel{height:13px;border-radius:4px;background:linear-gradient(90deg,var(--raised),var(--raised-2),var(--raised));
  background-size:200% 100%;animation:sh 1.1s linear infinite}
@keyframes sh{to{background-position:-200% 0}}

/* ── drawer ──────────────────────────────────────────────────────────────── */
.scrim{position:fixed;inset:0;background:rgba(3,4,6,.66);backdrop-filter:blur(3px);z-index:60;
  opacity:0;pointer-events:none;transition:opacity .16s var(--ease)}
.scrim.on{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;height:100dvh;width:min(760px,100vw);background:var(--bg);
  border-left:1px solid var(--line);z-index:61;transform:translateX(100%);
  transition:transform .2s var(--ease);display:flex;flex-direction:column;box-shadow:var(--shadow)}
.drawer.on{transform:translateX(0)}
.drawer-h{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line)}
.drawer-b{overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:16px;flex:1}
.tabs{display:flex;gap:2px;padding:0 18px;border-bottom:1px solid var(--line);overflow-x:auto}
.tab{background:none;border:none;padding:10px 12px;color:var(--ink-3);cursor:pointer;font-size:13.5px;
  border-bottom:2px solid transparent;white-space:nowrap;font-weight:560}
.tab:hover{color:var(--ink)}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--brand);font-weight:650}
.kv{display:grid;grid-template-columns:minmax(120px,180px) 1fr;gap:7px 16px;font-size:13.5px}
.kv dt{color:var(--ink-3)}
.kv dd{color:var(--ink);overflow-wrap:anywhere}

/* ── command palette ─────────────────────────────────────────────────────── */
.pal{position:fixed;inset:0;z-index:80;display:none;padding:12vh 18px 18px;
  background:rgba(3,4,6,.6);backdrop-filter:blur(4px)}
.pal.on{display:block}
.pal-box{max-width:560px;margin:0 auto;background:var(--surface);border:1px solid var(--line-2);
  border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow)}
.pal-box input{width:100%;background:none;border:none;padding:15px 17px;font-size:16px}
.pal-box input:focus{outline:none}
.pal-list{max-height:52vh;overflow-y:auto;border-top:1px solid var(--line)}
.pal-i{padding:10px 17px;cursor:pointer;font-size:14px;display:flex;gap:10px;align-items:center}
.pal-i[aria-selected="true"]{background:var(--raised-2)}
.pal-i .r{margin-left:auto;font-size:12px;color:var(--ink-3)}

/* ── toast ───────────────────────────────────────────────────────────────── */
.toasts{position:fixed;bottom:18px;right:18px;z-index:90;display:flex;flex-direction:column;
  gap:8px;max-width:min(420px,calc(100vw - 36px))}
.toast{background:var(--surface);border:1px solid var(--line-2);border-left:3px solid var(--info);
  border-radius:var(--r-sm);padding:11px 14px;font-size:13.5px;box-shadow:var(--shadow);
  animation:tin .18s var(--ease)}
.toast.ok{border-left-color:var(--ok)} .toast.bad{border-left-color:var(--bad)}
@keyframes tin{from{opacity:0;transform:translateY(6px)}}

/* ── modal ───────────────────────────────────────────────────────────────── */
.modal{position:fixed;inset:0;z-index:70;display:none;place-items:center;padding:18px;
  background:rgba(3,4,6,.7);backdrop-filter:blur(3px)}
.modal.on{display:grid}
.modal-box{width:100%;max-width:480px;background:var(--surface);border:1px solid var(--line-2);
  border-radius:var(--r-lg);padding:20px;box-shadow:var(--shadow)}
.modal-box h3{font-size:17px;margin:0 0 8px;font-weight:650}
.modal-box p{font-size:14px;color:var(--ink-2);margin:0 0 16px;line-height:1.6}
.row{display:flex;gap:9px;flex-wrap:wrap}
.row.end{justify-content:flex-end}

/* ── bars ────────────────────────────────────────────────────────────────── */
.bars{display:flex;align-items:flex-end;gap:3px;height:56px;margin-top:10px}
.bar{flex:1;min-width:2px;background:var(--raised-2);border-radius:2px 2px 0 0;position:relative}
.bar i{position:absolute;inset:auto 0 0 0;background:var(--brand);border-radius:2px 2px 0 0;display:block}

/* ── responsive ──────────────────────────────────────────────────────────── */
@media (max-width:980px){
  .g4{grid-template-columns:repeat(2,minmax(0,1fr))}
  .g3{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:820px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;
    border-right:none;border-bottom:1px solid var(--line);padding:11px 12px;gap:4px}
  .side .mark{width:100%;margin-bottom:9px}
  .nav-h{display:none}
  .nav{width:auto;padding:6px 10px;font-size:13.5px}
  .nav-n{margin-left:5px}
  .side-foot{width:100%;margin-top:8px;border-top:none;padding-top:8px}
  .top{padding:11px 14px;flex-wrap:wrap}
  .body{padding:14px}
  .kv{grid-template-columns:1fr;gap:2px 0}
  .kv dd{margin-bottom:9px}
}
@media (max-width:560px){
  .g4,.g3,.g2{grid-template-columns:1fr}
  .who span.hide-s{display:none}
  .tile-v{font-size:23px}
  /* ★ At 320px the search box was crushed to about 60px: the placeholder vanished and only the
     magnifier glyph remained. Every geometry assertion passed and only a screenshot caught it,
     which is why the house rule is to look at the thing. The search takes its own full-width row
     below the title rather than competing with it for a 320px line. */
  .top{row-gap:9px}
  .top h1{flex:0 0 auto}
  .search{order:3;flex:1 0 100%;max-width:none}
  .who{order:2}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.001ms!important;animation-iteration-count:1!important;
    transition-duration:.001ms!important}
  .drawer{transition:none}
}
`;

// ── the login document ───────────────────────────────────────────────────────────────────────
/**
 * The anonymous response. This is ALL an unauthenticated request ever receives: a form, and
 * nothing about what lies behind it. No customer names, no counts, no nav, no route list.
 *
 * The error text is deliberately identical for an unknown email and a wrong password. Telling a
 * stranger which half they got right turns a login form into an account enumerator.
 */
export function loginPage({ error = '', notice = '', email = '', locked = false } = {}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2308090B'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23DFFF4F'/%3E%3C/svg%3E">
<title>Answered Admin</title>
<style>${TOKENS}</style>
</head><body>
<main class="auth"><div class="auth-card">
  <div class="mark"><span class="mark-dot"></span><span class="mark-name">Answered</span>
    <span class="mark-sub">admin</span></div>
  <h1>Sign in</h1>
  <p class="lede">This console manages real customers, real recordings and real money. It is not a demo.</p>
  ${error ? `<div class="alert">${esc(error)}</div>` : ''}
  ${notice ? `<div class="alert ok">${esc(notice)}</div>` : ''}
  ${locked ? `<div class="alert warn">Too many attempts. This account is locked for a short period. The lock lifts on its own.</div>` : ''}
  <form method="POST" action="/admin/login" autocomplete="on" novalidate>
    <div class="field">
      <label for="email">Email</label>
      <input class="input" id="email" name="email" type="email" inputmode="email"
             autocomplete="username" required value="${esc(email)}" autofocus
             placeholder="you@reddenda.com">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input class="input" id="password" name="password" type="password"
             autocomplete="current-password" required placeholder="••••••••••••">
    </div>
    <button class="btn wide" type="submit">Sign in</button>
  </form>
  <p class="note">Every sign in, and every action taken after it, is written to an audit log that
  cannot be edited or deleted. That is deliberate.</p>
</div></main>
</body></html>`;
}

// ── the console document ─────────────────────────────────────────────────────────────────────
/**
 * Built only after a session has resolved. The operator's own identity is the only data baked
 * into the HTML; every other byte arrives over /api/admin/* after the page is running, so a
 * cached or mis-served document can never carry a customer's details.
 */
export function consolePage({ admin, buildInfo = {} }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2308090B'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23DFFF4F'/%3E%3C/svg%3E">
<title>Answered Admin</title>
<style>${TOKENS}${CONSOLE_CSS}</style>
</head><body>
<div class="shell">
  <nav class="side" aria-label="Sections">
    <div class="mark"><span class="mark-dot"></span><span class="mark-name">Answered</span>
      <span class="mark-sub">admin</span></div>

    <div class="nav-h">Business</div>
    <button class="nav" data-view="overview" aria-current="page"><span class="nav-ico">◎</span>Overview</button>
    <button class="nav" data-view="crm"><span class="nav-ico">☰</span>Leads<span class="nav-n" data-count="leads"></span></button>
    <button class="nav" data-view="customers"><span class="nav-ico">◧</span>Customers<span class="nav-n" data-count="accounts"></span></button>
    <button class="nav" data-view="billing"><span class="nav-ico">§</span>Billing</button>
    <button class="nav" data-view="parley"><span class="nav-ico">⇄</span>Parley</button>

    <div class="nav-h">Activity</div>
    <button class="nav" data-view="calls"><span class="nav-ico">☏</span>Calls<span class="nav-n" data-count="calls"></span></button>
    <button class="nav" data-view="usage"><span class="nav-ico">▤</span>Usage</button>
    <button class="nav" data-view="events"><span class="nav-ico">✦</span>Behaviour</button>

    <div class="nav-h">Control</div>
    <button class="nav" data-view="compliance"><span class="nav-ico">§</span>Compliance</button>
    <button class="nav" data-view="audit"><span class="nav-ico">⎗</span>Audit log</button>
    <button class="nav" data-view="system"><span class="nav-ico">⚙</span>System</button>

    <div class="side-foot">
      <div>Signed in as <strong>${esc(admin.email)}</strong></div>
      <div class="mono">${esc(admin.role || 'owner')} · session to ${esc(String(admin.expires_at || '').slice(11, 16))} UTC</div>
      <div style="margin-top:9px"><button class="btn ghost sm" id="signout">Sign out</button></div>
    </div>
  </nav>

  <div class="main">
    <header class="top">
      <h1 id="title">Overview</h1>
      <div class="search"><input class="input" id="q" type="search" placeholder="Search leads, customers, calls, numbers" aria-label="Search"></div>
      <div class="who">
        <span class="hide-s"><span class="kbd">⌘K</span></span>
        <span class="pill" id="freshness" title="When the data on this page was last measured">measuring</span>
      </div>
    </header>
    <div class="body" id="view" role="main"><div class="card"><div class="skel" style="width:40%"></div></div></div>
  </div>
</div>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true" aria-label="Detail"></aside>
<div class="pal" id="pal"><div class="pal-box">
  <input id="pal-q" type="text" placeholder="Jump to a customer, a call, or a section" aria-label="Command">
  <div class="pal-list" id="pal-list" role="listbox"></div>
</div></div>
<div class="modal" id="modal"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>

<script>${APP_JS}</script>
<script>window.__ADMIN__=${JSON.stringify({ admin: { email: admin.email, role: admin.role, name: admin.name }, build: { ...buildInfo, ui: VERSION } })};ADMIN.boot();</script>
</body></html>`;
}

// ── the application ──────────────────────────────────────────────────────────────────────────
const APP_JS = String.raw`
const ADMIN = (() => {
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ── formatting. Every one of these has a defined answer for null, because a dash is honest and
// "0" is a claim.
const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const usd = (cents) => (cents == null ? '—' : '$' + (Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const dur = (s) => {
  if (s == null) return '—';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? m + 'm ' + String(r).padStart(2, '0') + 's' : r + 's';
};
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
  return d.toISOString().slice(0, 10);
};
const stamp = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
const phone = (p) => {
  if (!p) return '—';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p);
  return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : p;
};

const STATUS_TONE = { live:'ok', ready:'info', awaiting_line:'warn', configuring:'warn',
  draft:'', paused:'warn', closed:'bad' };

// ── transport ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch('/api/admin/' + path, {
    method: opts.body ? 'POST' : 'GET',
    headers: Object.assign({ 'x-answered-admin': '1' }, opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) { location.href = '/admin?expired=1'; throw new Error('signed out'); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
    const err = new Error(msg); err.status = res.status; err.data = data; throw err;
  }
  return data;
}

// ── toasts ────────────────────────────────────────────────────────────────
function toast(msg, tone) {
  const el = document.createElement('div');
  el.className = 'toast ' + (tone || '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, tone === 'bad' ? 7000 : 3600);
}

// ── the paint guard ───────────────────────────────────────────────────────
// ★ THE MOST IMPORTANT FUNCTION IN THIS FILE. Never replace the contents of a region that
// currently owns focus. A poll in this repo did exactly that, focus fell to BODY, a keyboard
// guard stopped matching, and typing fired barge then hangup on a live call. If the region has
// focus, we skip the paint and try again on the next tick instead of stealing the caret.
function paint(el, html) {
  if (!el) return false;
  const a = document.activeElement;
  if (a && a !== document.body && el.contains(a) && isTextEntry(a)) return false;
  el.innerHTML = html;
  return true;
}

/**
 * ★ THE GUARD PROTECTS TYPING, NOT FOCUS, AND THE DIFFERENCE COST AN HOUR.
 *
 * The first version refused to repaint ANY region containing document.activeElement. That stopped
 * the real defect it was written for — a poll wiping a half-typed field — and it also silently
 * broke every button inside a repainted region, because clicking a button focuses it, and the
 * repaint that click was supposed to cause was then skipped. Filter chips did nothing. Checkboxes
 * did not raise the bulk bar. No error, no console message: the click handler ran, the state
 * changed, and the paint was quietly refused.
 *
 * A button click is a REQUEST for a repaint. A caret in a text field is state the user owns and
 * we must not destroy. Only the second is worth protecting, and conflating them turned a good
 * guard into an invisible bug.
 */
function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = (el.type || 'text').toLowerCase();
  // Checkboxes, radios and buttons are actions, not text the user is in the middle of composing.
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color'].includes(type);
}

// ── state ─────────────────────────────────────────────────────────────────
const S = {
  view: 'overview',
  q: '',
  overview: null,
  filters: { crm: { lane: null, disposition: null, state: null, trade: null, line_type: null,
                    dialable: null, suppressed: null, has_email: null, sort: 'recent', offset: 0 },
             customers: { status: null, sort: 'recent', offset: 0 },
             calls: { recorded: null, direction: null, offset: 0 },
             events: { name: null, offset: 0 } },
  lastMeasuredAt: null,
  drawerAccount: null,
  drawerContact: null,
  selected: new Set(),
  facets: null,
};

// ── empty and error states, which are not the same thing ──────────────────
const emptyState = (title, detail) =>
  '<div class="empty"><div class="big">' + esc(title) + '</div><div class="sm">' + detail + '</div></div>';
const errState = (title, detail) =>
  '<div class="empty err"><div class="big">' + esc(title) + '</div><div class="sm">' + esc(detail) + '</div></div>';
const measuredZero = (thing) =>
  emptyState('No ' + thing + ' yet', 'This is a measured zero, not a loading state and not a failure. ' +
    'The query ran and returned nothing. Measured ' + esc(stamp(S.lastMeasuredAt)) + '.');

// ── views ─────────────────────────────────────────────────────────────────
const VIEWS = {};

VIEWS.overview = async () => {
  const d = await api('overview');
  S.overview = d; S.lastMeasuredAt = d.at;
  freshness();
  counts(d);
  const a = d.accounts, c = d.calls, b = d.billing, ev = d.events, p = d.parley, pl = d.pipeline;
  const tile = (k, v, s, cls) =>
    '<div class="card"><div class="tile-k">' + k + '</div><div class="tile-v ' + (cls || '') + '">' + v +
    '</div>' + (s ? '<div class="tile-s">' + s + '</div>' : '') + '</div>';

  return '' +
  '<div class="grid g4">' +
    tile('Customers', n(a.total), a.total ? n(a.live) + ' live · ' + n(a.new_7d) + ' new this week'
      : 'Nobody has signed up yet. This is a real zero.', a.total ? 'brand' : '') +
    tile('Calls', n(c.total), n(c.with_recording) + ' recorded · ' + n(c.last_24h) + ' in 24h') +
    tile('Billed', usd(b.open_cents + b.paid_cents),
      b.events ? n(b.events) + ' charges · ' + usd(b.refunded_cents) + ' refunded'
               : 'Nothing has been charged yet') +
    tile('Behaviour events', n(ev.total),
      ev.total ? n(ev.last_24h) + ' in 24h' : 'The queryable stream is new and starts empty') +
  '</div>' +

  '<div class="grid g2">' +
    '<div class="card pad0"><div class="card-h"><h2>Where customers are stuck</h2></div>' +
      (a.total ? ladder(a) : emptyState('No customers yet',
        'The ladder below fills in as businesses sign up. Nothing here is simulated.')) +
    '</div>' +
    '<div class="card pad0"><div class="card-h"><h2>The pipeline behind them</h2>' +
      '<span class="sp muted mono">prospects, not customers</span></div>' +
      '<div class="tw"><table><tbody>' +
      row2('Contractors classified', n(pl.contacts)) +
      row2('Suppressed, never to be called', n(pl.suppressed)) +
      row2('Suppression list entries', n(pl.suppression_list)) +
      row2('Consent records on file', n(pl.consent_rows)) +
      row2('Phone lines provisioned', n(pl.lines)) +
      row2('Campaigns running', n(pl.campaigns_running)) +
      '</tbody></table></div></div>' +
  '</div>' +

  '<div class="grid g2">' +
    '<div class="card"><div class="tile-k">Parley</div>' +
      '<div class="tile-v">' + n(p.deals) + '</div>' +
      '<div class="tile-s">' + n(p.settled) + ' settled · ' + n(p.no_overlap) + ' no overlap · ' +
        n(p.signatures) + ' signatures<br>' +
        '<span class="muted">This console cannot see either party&rsquo;s sealed limit. There is no ' +
        'query that returns one.</span></div></div>' +
    '<div class="card"><div class="tile-k">Attribution</div>' +
      '<div class="tile-v">' + n(c.attributed) + ' <span class="muted" style="font-size:15px">of ' + n(c.total) + '</span></div>' +
      '<div class="tile-s">Calls tied to a paying customer. The rest are research, demo and canary ' +
        'traffic, which belong to no customer and bill nobody.' +
        (c.total > c.attributed
          ? ((S.overview && S.overview.accounts && S.overview.accounts.total === 0)
              ? '<br><span class="muted" style="display:inline-block;margin-top:9px">Repair is ' +
                'available but would attribute nothing: it matches on numbers we provisioned to a ' +
                'customer, and there are no customers and no provisioned numbers yet.</span>'
              : '<br><button class="btn ghost sm" style="margin-top:9px" data-act="backfill">Repair attribution</button>')
          : '') +
      '</div></div>' +
  '</div>';
};

const row2 = (k, v) => '<tr><td>' + k + '</td><td class="num">' + v + '</td></tr>';

function ladder(a) {
  const steps = [['draft','Signed up, email not confirmed'],['configuring','Confirming their rules'],
    ['ready','Rules complete, no number yet'],['awaiting_line','Waiting on a human to assign a number'],
    ['live','Live and answering'],['paused','Paused'],['closed','Closed']];
  const max = Math.max(1, ...steps.map(([k]) => a[k] || 0));
  return '<div class="tw"><table><tbody>' + steps.map(([k, label]) =>
    '<tr class="click" data-status="' + k + '"><td><span class="pill ' + (STATUS_TONE[k] || '') + '">' +
    k.replace(/_/g, ' ') + '</span></td><td class="dim">' + label + '</td>' +
    '<td style="width:34%"><div class="bar" style="height:7px;border-radius:3px"><i style="width:' +
      Math.round(((a[k] || 0) / max) * 100) + '%;height:7px"></i></div></td>' +
    '<td class="num">' + n(a[k] || 0) + '</td></tr>').join('') + '</tbody></table></div>';
}

// ── LEADS. The CRM over 4,374 real classified contractor businesses. ─────────────────────────
VIEWS.crm = async () => {
  const f = S.filters.crm;
  const qs = new URLSearchParams({ q: S.q || '', sort: f.sort, limit: 50, offset: f.offset });
  for (const k of ['lane','disposition','state','trade','line_type']) if (f[k]) qs.set(k, f[k]);
  if (f.dialable != null) qs.set('dialable', String(f.dialable));
  if (f.suppressed != null) qs.set('suppressed', String(f.suppressed));
  if (f.has_email != null) qs.set('has_email', String(f.has_email));

  const [d, facets] = await Promise.all([
    api('crm?' + qs),
    S.facets ? Promise.resolve(S.facets) : api('crm/facets'),
  ]);
  S.facets = facets;
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  const n0 = $('[data-count="leads"]'); if (n0) n0.textContent = facets.total || '';

  const chip = (key, value, label, count, active) =>
    '<button class="btn ghost sm" data-crmfilter="' + key + '" data-value="' + esc(value == null ? '' : value) + '"' +
    (active ? ' style="border-color:var(--brand);color:var(--brand)"' : '') + '>' +
    esc(label) + (count != null ? ' <span class="muted" style="margin-left:5px">' + n(count) + '</span>' : '') + '</button>';

  const anyFilter = f.lane || f.disposition || f.state || f.trade || f.line_type ||
                    f.dialable != null || f.suppressed != null || S.q;

  const head =
    '<div class="card"><div class="row" style="align-items:center;gap:8px;margin-bottom:10px">' +
      '<span class="tile-k" style="margin:0">Who we can actually reach</span>' +
      '<span class="sp" style="margin-left:auto"></span>' +
      (anyFilter ? '<button class="btn ghost sm" data-crmfilter="clear" data-value="">Clear filters</button>' : '') +
      '<button class="btn ghost sm" data-act="crm-export">Export CSV</button>' +
    '</div>' +
    '<div class="row">' +
      chip('dialable', 'true', 'AI-callable lines', facets.ai_dialable, f.dialable === true) +
      chip('line_type', 'mobile', 'Mobile', (facets.line_type.find((x) => x.k === 'mobile') || {}).n, f.line_type === 'mobile') +
      chip('has_email', 'true', 'Has an email', facets.with_email, f.has_email === true) +
      chip('suppressed', 'true', 'Suppressed', facets.suppressed, f.suppressed === true) +
    '</div>' +
    '<div class="tile-s" style="margin-top:10px">' +
      n(facets.ai_dialable) + ' of ' + n(facets.total) + ' are verified fixed business lines, which is the ' +
      'only pool an AI voice may cold-call. ' + n(facets.with_email) + ' have an email address on file, ' +
      'read from what each business publishes on its own site. ' +
      (facets.with_email < facets.with_website
        ? '<strong>' + n(facets.with_website - facets.with_email) + '</strong> have a website that has not been read yet, so that number is still climbing.'
        : '') +
    '</div></div>' +

    '<div class="grid g3">' +
      '<div class="card pad0"><div class="card-h"><h2>Trade</h2></div><div style="padding:10px 12px" class="row">' +
        facets.trade.slice(0, 12).map((x) => chip('trade', x.k, x.k, x.n, f.trade === x.k)).join('') + '</div></div>' +
      '<div class="card pad0"><div class="card-h"><h2>State</h2></div><div style="padding:10px 12px" class="row">' +
        facets.state.slice(0, 14).map((x) => chip('state', x.k, x.k, x.n, f.state === x.k)).join('') + '</div></div>' +
      '<div class="card pad0"><div class="card-h"><h2>Stage</h2></div><div style="padding:10px 12px" class="row">' +
        facets.disposition.map((x) => chip('disposition', x.k, String(x.k).replace(/_/g, ' '), x.n, f.disposition === x.k)).join('') + '</div></div>' +
    '</div>';

  if (!d.rows.length) {
    return head + '<div class="card pad0">' +
      (anyFilter
        ? emptyState('Nothing matches that filter',
            'Measured ' + esc(stamp(S.lastMeasuredAt)) + '. Clear the filters to see the whole book.')
        : measuredZero('leads')) + '</div>';
  }

  const sel = S.selected;
  const bulk = sel.size
    ? '<div class="card" style="border-color:var(--brand);position:sticky;top:64px;z-index:15">' +
      '<div class="row" style="align-items:center;gap:9px">' +
        '<strong>' + n(sel.size) + ' selected</strong>' +
        '<span class="sp" style="margin-left:auto"></span>' +
        '<button class="btn ghost sm" data-bulk="disposition" data-value="interested">Mark interested</button>' +
        '<button class="btn ghost sm" data-bulk="disposition" data-value="not_interested">Not interested</button>' +
        '<button class="btn ghost sm" data-bulk="tag_add" data-value="shortlist">Tag shortlist</button>' +
        '<button class="btn danger sm" data-bulk="suppress" data-value="operator">Never contact</button>' +
        '<button class="btn ghost sm" data-act="crm-clear-sel">Clear</button>' +
      '</div></div>'
    : '';

  return head + bulk + '<div class="card pad0">' +
    '<div class="card-h"><h2>' + n(d.total) + ' leads</h2><span class="sp">' +
      '<button class="btn ghost sm" data-act="crm-sort" data-value="recent">Newest</button>' +
      '<button class="btn ghost sm" data-act="crm-sort" data-value="name">A to Z</button>' +
      '<button class="btn ghost sm" data-act="crm-sort" data-value="touched">Last touched</button>' +
    '</span></div>' +
    '<div class="tw"><table><thead><tr>' +
      '<th style="width:34px"><input type="checkbox" data-act="crm-sel-all" aria-label="Select this page"></th>' +
      '<th>Business</th><th>Trade</th><th>Where</th><th>Line</th><th>Reachable</th>' +
      '<th>Stage</th><th class="num">Calls</th><th>Last touched</th></tr></thead><tbody>' +
    d.rows.map((r) => {
      const reach = [];
      if (r.email) reach.push('<span class="pill ok" title="' + esc(r.email) + '">email</span>');
      if (r.ai_dialable) reach.push('<span class="pill info">callable</span>');
      else if (r.line_type === 'mobile' || r.line_type === 'nonFixedVoip') reach.push('<span class="pill">texts</span>');
      if (r.suppressed) reach.push('<span class="pill bad">never</span>');
      return '<tr class="click" data-contact="' + esc(r.id) + '">' +
        // No stopPropagation here: this page delegates every click from the document, so stopping
        // propagation on the cell silently killed the very handler meant to read the checkbox. The
        // row-open branch already returns early when the click originated on a [data-sel] control,
        // which is the correct way to keep a checkbox from opening the drawer.
        '<td><input type="checkbox" data-sel="' + esc(r.id) + '"' +
          (sel.has(r.id) ? ' checked' : '') + ' aria-label="Select ' + esc(r.name || 'lead') + '"></td>' +
        '<td><strong>' + esc(r.name || 'Unnamed') + '</strong>' +
          (r.contact_name ? '<br><span class="muted">' + esc(r.contact_name) + '</span>' : '') + '</td>' +
        '<td class="dim">' + esc(r.trade || '—') + '</td>' +
        '<td class="dim">' + esc([r.city, r.state].filter(Boolean).join(', ') || '—') + '</td>' +
        '<td class="mono">' + esc(r.line_type || 'unknown') + '</td>' +
        '<td>' + (reach.join(' ') || '<span class="muted">no channel</span>') + '</td>' +
        '<td><span class="pill">' + esc(String(r.disposition).replace(/_/g, ' ')) + '</span></td>' +
        '<td class="num">' + n(r.call_count) + '</td>' +
        '<td class="muted">' + esc(r.last_contacted_at ? when(r.last_contacted_at) : 'never') + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>' + pager('crm', d) + '</div>';
};

// ── the lead record: a workspace, not a readout ──────────────────────────────────────────────
let leadTab = 'summary';
async function openContact(id) {
  const dr = $('#drawer'); S.drawerContact = id; S.drawerAccount = null;
  dr.classList.add('on'); dr.setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('on');
  dr.innerHTML = '<div class="drawer-h"><div style="flex:1"><div class="skel" style="width:50%"></div></div>' +
    '<button class="btn ghost sm" data-act="close-drawer">Close</button></div>' +
    '<div class="drawer-b"><div class="skel" style="width:70%"></div></div>';
  let d, pre;
  try {
    [d, pre] = await Promise.all([api('crm/contact?id=' + encodeURIComponent(id)),
                                  api('crm/preflight?id=' + encodeURIComponent(id))]);
  } catch (e) {
    dr.innerHTML = '<div class="drawer-h"><h2>Could not load</h2>' +
      '<button class="btn ghost sm" style="margin-left:auto" data-act="close-drawer">Close</button></div>' +
      '<div class="drawer-b">' + errState('This lead could not be loaded', e.message) + '</div>';
    return;
  }
  renderContact(d, pre);
}

function channelRow(label, state, action, contactId, to) {
  const ok = state && state.ok;
  return '<div class="card" style="padding:12px 14px;border-color:' + (ok ? 'var(--ok)' : 'var(--line)') + '">' +
    '<div class="row" style="align-items:center;gap:10px">' +
      '<strong style="min-width:52px">' + label + '</strong>' +
      (ok ? '<span class="pill ok">ready</span>' : '<span class="pill warn">blocked</span>') +
      '<span class="sp" style="margin-left:auto"></span>' +
      (ok
        ? '<button class="btn sm" data-act="' + action + '" data-contact="' + esc(contactId) + '" data-to="' + esc(to || '') + '">' + label + '</button>'
        : '') +
    '</div>' +
    '<div class="tile-s" style="margin-top:7px">' + esc(state ? state.why : 'unknown') + '</div>' +
  '</div>';
}

function renderContact(d, pre) {
  const c = d.contact;
  const tabs = [['summary','Summary'],['reach','Reach out'],['calls','Calls'],['notes','Notes'],
                ['tasks','Tasks'],['timeline','Timeline']];
  const head =
    '<div class="drawer-h"><div style="flex:1;min-width:0">' +
      '<div class="row" style="align-items:center;gap:9px">' +
        '<h2 style="font-size:18px;font-weight:650">' + esc(c.name || 'Unnamed') + '</h2>' +
        '<span class="pill">' + esc(String(c.disposition).replace(/_/g,' ')) + '</span>' +
        (c.suppressed ? '<span class="pill bad">never contact</span>' : '') +
      '</div>' +
      '<div class="muted mono" style="font-size:12.5px;margin-top:4px">' +
        esc(phone(c.phone)) + ' · ' + esc(c.line_type || 'line type unknown') +
        (c.city ? ' · ' + esc([c.city, c.state].filter(Boolean).join(', ')) : '') + '</div>' +
    '</div><button class="btn ghost sm" data-act="close-drawer">Close</button></div>' +
    '<div class="tabs">' + tabs.map(([k, l]) =>
      '<button class="tab" data-leadtab="' + k + '" aria-selected="' + (leadTab === k) + '">' + l + '</button>').join('') + '</div>';

  const panes = {
    summary: () => '<div class="card"><h2 style="margin-bottom:12px">What we know</h2><dl class="kv">' +
      kv('Business', c.name) + kv('Trade', c.trade) + kv('Phone', phone(c.phone)) +
      kv('Line type', c.line_type ? c.line_type + (c.ai_dialable ? ' (an AI voice may call it)' : '') : 'never established') +
      kv('Email', c.email || null) + kv('Person', c.contact_name) + kv('Role', c.contact_role) +
      kv('Website', c.website ? '<a href="' + esc(c.website) + '" target="_blank" rel="noreferrer noopener">' + esc(c.website) + '</a>' : null) +
      kv('Address', [c.street, c.city, c.state].filter(Boolean).join(', ') || null) +
      kv('Compliance lane', c.lane ? c.lane + (c.lane_reasons && c.lane_reasons.length ? ' — ' + c.lane_reasons.join('; ') : '') : null) +
      kv('Times called', n(c.call_count)) +
      kv('Last touched', c.last_contacted_at ? stamp(c.last_contacted_at) : 'never') +
      kv('Enrichment', c.enriched_at
          ? 'Looked on ' + stamp(c.enriched_at) + (c.email ? '' : ', and this business does not publish an email')
          : 'Not looked at yet') +
      kv('Source', c.source) +
      '</dl></div>' +
      '<div class="card"><h2 style="margin-bottom:10px">Stage</h2><div class="row">' +
        ['new','queued','attempted','reached','interested','callback','not_interested','bad_number','customer']
          .map((s) => '<button class="btn ghost sm" data-setdisp="' + s + '"' +
            (c.disposition === s ? ' style="border-color:var(--brand);color:var(--brand)"' : '') + '>' +
            s.replace(/_/g,' ') + '</button>').join('') +
      '</div></div>',

    reach: () => '<div class="card"><div class="tile-k">Before you press anything</div>' +
        '<div class="tile-s" style="font-size:13.5px;margin-top:4px">Each channel below is checked against ' +
        'this record right now: the line type, any consent on file, the suppression list, the ' +
        'do-not-call programme and the carrier campaign. <strong>A control that cannot act does not ' +
        'render as though it can</strong>, and every blocked attempt is still recorded with its reason.</div></div>' +
      channelRow('Email', pre.email, 'do-email', c.id, c.email) +
      channelRow('Text',  pre.sms,   'do-sms',   c.id, c.phone) +
      channelRow('Call',  pre.call,  'do-call',  c.id, c.phone) +
      (pre.call.ok ? '' :
        '<div class="card"><div class="tile-k">A person can always dial</div>' +
        '<div class="tile-s" style="font-size:13.5px;margin-top:4px">The restrictions above are on an ' +
        '<em>artificial voice</em>. A human picking up a handset is a different call class with different ' +
        'obligations.</div><div style="margin-top:10px"><a class="btn ghost sm" href="tel:' + esc(c.phone) + '">' +
        'Dial ' + esc(phone(c.phone)) + ' yourself</a></div></div>'),

    calls: () => (d.calls || []).length
      ? '<div class="card pad0"><div class="card-h"><h2>Calls</h2></div><div class="tw"><table>' +
        '<thead><tr><th>When</th><th>Class</th><th>Result</th><th class="num">Length</th><th>Disclosure</th></tr></thead><tbody>' +
        d.calls.map((x) => '<tr class="click" data-call="' + esc(x.call_sid || '') + '">' +
          '<td class="muted">' + esc(when(x.created_at)) + '</td>' +
          '<td class="mono">' + esc(x.call_class || 'unclassified') + '</td>' +
          '<td>' + (x.placed ? esc(x.status || 'placed')
                             : '<span class="pill bad" title="' + esc(x.refused_reason || '') + '">refused</span>') + '</td>' +
          '<td class="num">' + dur(x.duration_seconds) + '</td>' +
          '<td>' + (x.disclosure_verified === true ? '<span class="pill ok">verified</span>'
                  : x.disclosure_verified === false ? '<span class="pill bad">failed</span>'
                  : '<span class="pill warn">unchecked</span>') + '</td></tr>').join('') +
        '</tbody></table></div></div>'
      : emptyState('No calls to this business yet',
          'A measured zero: the query ran against the call spine and returned nothing for this number.'),

    notes: () => '<div class="card"><h2 style="margin-bottom:10px">Add a note</h2>' +
        '<textarea class="input" id="notebody" rows="3" placeholder="What happened, in your own words"></textarea>' +
        '<div class="row end" style="margin-top:9px"><button class="btn sm" data-act="add-note" data-contact="' + esc(c.id) + '">Save note</button></div></div>' +
      ((d.notes || []).length
        ? d.notes.map((x) => '<div class="card" style="padding:12px 14px">' +
            '<div class="row" style="gap:8px;align-items:center">' +
              (x.pinned ? '<span class="pill brand">pinned</span>' : '') +
              '<span class="muted mono" style="font-size:12px">' + esc(x.author || 'operator') + ' · ' + esc(stamp(x.at)) + '</span>' +
            '</div><div style="margin-top:7px;font-size:14px">' + esc(x.body) + '</div></div>').join('')
        : emptyState('No notes yet', 'Nobody has written anything about this business.')),

    tasks: () => '<div class="card"><h2 style="margin-bottom:10px">Add a task</h2>' +
        '<input class="input" id="tasktitle" placeholder="What needs doing"><div class="row end" style="margin-top:9px">' +
        '<button class="btn sm" data-act="add-task" data-contact="' + esc(c.id) + '">Add task</button></div></div>' +
      ((d.tasks || []).length
        ? '<div class="card pad0"><div class="tw"><table><thead><tr><th>Task</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>' +
          d.tasks.map((t) => '<tr><td>' + esc(t.title) + '</td>' +
            '<td class="muted">' + esc(t.due_at ? when(t.due_at) : '—') + '</td>' +
            '<td><span class="pill ' + (t.status === 'done' ? 'ok' : t.status === 'cancelled' ? '' : 'warn') + '">' + esc(t.status) + '</span></td>' +
            '<td>' + (t.status === 'open'
              ? '<button class="btn ghost sm" data-task="' + esc(t.id) + '" data-status="done">Done</button>' : '') + '</td></tr>').join('') +
          '</tbody></table></div></div>'
        : emptyState('No tasks', 'Nothing is scheduled against this business.')),

    timeline: () => '<div class="card pad0"><div class="card-h"><h2>Everything that has happened</h2>' +
      '<span class="sp muted">one feed, whatever produced it</span></div>' +
      '<div id="tl" class="tw"><div style="padding:16px"><div class="skel" style="width:60%"></div></div></div></div>',
  };

  const dr = $('#drawer');
  dr.innerHTML = head + '<div class="drawer-b" id="dbody">' + panes[leadTab]() + '</div>';
  dr.__panes = panes; dr.__contact = c; dr.__pre = pre;
  if (leadTab === 'timeline') loadTimeline(c.id);
}

async function loadTimeline(contactId) {
  try {
    const rows = await api('crm/timeline?contact=' + encodeURIComponent(contactId) + '&limit=100');
    const el = $('#tl'); if (!el) return;
    paint(el, rows.length
      ? '<table><tbody>' + rows.map((r) =>
          '<tr><td style="width:150px" class="muted mono">' + esc(stamp(r.at)) + '</td>' +
          '<td><span class="pill">' + esc(r.kind) + '</span></td>' +
          '<td><strong>' + esc(r.title) + '</strong>' +
            (r.body ? '<br><span class="muted">' + esc(String(r.body).slice(0, 200)) + '</span>' : '') + '</td>' +
          '<td class="muted">' + esc(r.source || '') + '</td></tr>').join('') + '</tbody></table>'
      : '<div style="padding:4px">' + emptyState('Nothing recorded yet',
          'The timeline fills as this business is called, emailed, noted on or updated. It is one feed ' +
          'over every table, so nothing has to be looked up in two places.') + '</div>');
  } catch (e) {
    paint($('#tl'), errState('The timeline could not load', e.message));
  }
}

VIEWS.customers = async () => {
  const f = S.filters.customers;
  const d = await api('accounts?' + new URLSearchParams({
    q: S.q || '', status: f.status || '', sort: f.sort, limit: 50, offset: f.offset }));
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  const head = '<div class="card-h"><h2>Customers</h2>' +
    '<span class="sp">' + filterChips('customers', [[null,'All'],['live','Live'],['awaiting_line','Awaiting line'],
      ['configuring','Configuring'],['ready','Ready'],['paused','Paused'],['closed','Closed']], f.status) +
    '<button class="btn ghost sm" data-act="export-accounts">Export CSV</button></span></div>';
  if (!d.rows.length) {
    return '<div class="card pad0">' + head +
      (S.q || f.status
        ? emptyState('Nothing matches that filter', 'Measured ' + esc(stamp(S.lastMeasuredAt)) + '. Clear the filter to see everyone.')
        : measuredZero('customers')) + '</div>';
  }
  return '<div class="card pad0">' + head + '<div class="tw"><table>' +
    '<thead><tr><th>Business</th><th>Owner</th><th>Status</th><th>Number</th>' +
    '<th class="num">Calls</th><th class="num">Recordings</th><th class="num">Charged</th>' +
    '<th class="num">Credit</th><th>Signed up</th></tr></thead><tbody>' +
    d.rows.map((r) =>
      '<tr class="click" data-account="' + esc(r.id) + '">' +
      '<td><strong>' + esc(r.business_name || 'Unnamed') + '</strong>' +
        (r.trade ? '<br><span class="muted mono">' + esc(r.trade) + '</span>' : '') + '</td>' +
      '<td><span class="trunc">' + esc(r.owner_email) + '</span>' +
        (r.owner_name ? '<br><span class="muted">' + esc(r.owner_name) + '</span>' : '') + '</td>' +
      '<td><span class="pill ' + (STATUS_TONE[r.status] || '') + '">' + esc(String(r.status).replace(/_/g, ' ')) + '</span></td>' +
      '<td class="mono">' + esc(phone(r.phone)) + '</td>' +
      '<td class="num">' + n(r.calls) + '</td>' +
      '<td class="num">' + n(r.recordings) + '</td>' +
      '<td class="num">' + (r.account_key ? usd(r.charged_cents) : '<span class="muted">no bill</span>') + '</td>' +
      '<td class="num">' + (r.account_key ? usd(r.credit_cents) : '—') + '</td>' +
      '<td class="muted">' + esc(when(r.created_at)) + '</td></tr>').join('') +
    '</tbody></table></div>' + pager('customers', d) + '</div>';
};

VIEWS.calls = async () => {
  const f = S.filters.calls;
  const d = await api('calls?' + new URLSearchParams({
    q: S.q || '', recorded: f.recorded == null ? '' : String(f.recorded),
    direction: f.direction || '', limit: 50, offset: f.offset }));
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  const head = '<div class="card-h"><h2>Calls and recordings</h2><span class="sp">' +
    filterChips('calls', [[null,'All'],['true','Recorded'],['false','Not recorded']], f.recorded == null ? null : String(f.recorded), 'recorded') +
    '</span></div>';
  if (!d.rows.length) {
    return '<div class="card pad0">' + head +
      (S.q || f.recorded != null ? emptyState('Nothing matches that filter',
        'Measured ' + esc(stamp(S.lastMeasuredAt)) + '.') : measuredZero('calls')) + '</div>';
  }
  return '<div class="card pad0">' + head + '<div class="tw"><table>' +
    '<thead><tr><th>When</th><th>Customer</th><th>Direction</th><th>From</th><th>To</th>' +
    '<th>Result</th><th class="num">Length</th><th>Recording</th><th class="num">Transcript</th></tr></thead><tbody>' +
    d.rows.map((r) =>
      '<tr class="click" data-call="' + esc(r.call_sid || '') + '">' +
      '<td class="muted">' + esc(when(r.created_at)) + '</td>' +
      '<td>' + (r.business_name ? '<strong>' + esc(r.business_name) + '</strong>'
                : '<span class="muted">unattributed</span>') + '</td>' +
      '<td><span class="pill ' + (r.direction === 'inbound' ? 'info' : '') + '">' + esc(r.direction) + '</span></td>' +
      '<td class="mono">' + esc(phone(r.from_number)) + '</td>' +
      '<td class="mono">' + esc(phone(r.to_number)) + '</td>' +
      '<td>' + (r.placed ? '<span class="pill ' + (r.answered_by === 'human' ? 'ok' : '') + '">' +
          esc(r.status || 'placed') + '</span>'
        : '<span class="pill bad" title="' + esc(r.refused_reason || '') + '">refused</span>') + '</td>' +
      '<td class="num">' + dur(r.duration_seconds) + '</td>' +
      '<td>' + (r.recording_sid
        ? '<button class="btn ghost sm" data-rec="' + esc(r.recording_sid) + '">Listen</button>'
        : '<span class="muted">none</span>') + '</td>' +
      '<td class="num">' + (r.transcript_lines ? n(r.transcript_lines) : '<span class="muted">—</span>') + '</td>' +
      '</tr>').join('') +
    '</tbody></table></div>' + pager('calls', d) + '</div>';
};

VIEWS.usage = async () => {
  const d = await api('usage');
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  const t = d.totals;
  const costLine = t.cost_rows_written
    ? usd(Math.round((t.cost_usd || 0) * 100)) + ' across ' + n(t.cost_rows_written) + ' of ' + n(t.calls) + ' calls'
    : '<span class="muted">No call has ever had a cost written to it. This is an unmeasured zero, ' +
      'not a measurement of zero, and the console will not print a dollar figure it did not measure.</span>';
  const CLASS_TEXT = {
    ai_cold: 'AI voice to a verified landline or fixed VoIP. No consent needed.',
    human_cold: 'A person dials and speaks. Not an autodialer and not an artificial voice.',
    consented: 'AI voice to any line type, with a consent record on file.',
    inbound: 'They called us. A different legal world: CIPA, not TCPA.',
    demo: 'Our own demo and canary traffic. Belongs to no customer and bills nobody.',
    unclassified: 'Placed before the class column existed. Not a real category.',
  };
  return '' +
  '<div class="grid g4">' +
    '<div class="card"><div class="tile-k">Calls, 30 days</div><div class="tile-v">' + n(t.calls) + '</div>' +
      '<div class="tile-s">' + n(t.placed) + ' placed · ' + n(t.refused) + ' refused by the gate</div></div>' +
    '<div class="card"><div class="tile-k">Talk time</div><div class="tile-v">' + dur(t.talk_seconds) + '</div>' +
      '<div class="tile-s">' + n(t.recordings) + ' recordings kept</div></div>' +
    '<div class="card"><div class="tile-k">Telephony cost</div><div class="tile-v" style="font-size:19px">' +
      (t.cost_rows_written ? usd(Math.round((t.cost_usd || 0) * 100)) : 'not recorded') + '</div>' +
      '<div class="tile-s">' + costLine + '</div></div>' +
    '<div class="card"><div class="tile-k">Unclassified</div><div class="tile-v">' + n(t.unclassified) + '</div>' +
      '<div class="tile-s">Calls with no compliance class written at dial time</div></div>' +
  '</div>' +
  '<div class="card pad0"><div class="card-h"><h2>By compliance class</h2>' +
    '<span class="sp muted">cost and obligations differ per class, so they are counted separately</span></div>' +
    (d.by_class.length ? '<div class="tw"><table><thead><tr><th>Class</th><th>What it means</th>' +
      '<th class="num">Calls</th><th class="num">Placed</th><th class="num">Refused</th>' +
      '<th class="num">Reached a human</th><th class="num">Talk</th></tr></thead><tbody>' +
      d.by_class.map((c) => '<tr><td><span class="pill ' +
        (c.call_class === 'unclassified' ? '' : 'info') + '">' + esc(c.call_class) + '</span></td>' +
        '<td class="dim">' + esc(CLASS_TEXT[c.call_class] || '') + '</td>' +
        '<td class="num">' + n(c.calls) + '</td><td class="num">' + n(c.placed) + '</td>' +
        '<td class="num">' + n(c.refused) + '</td><td class="num">' + n(c.reached_human) + '</td>' +
        '<td class="num">' + dur(c.talk_seconds) + '</td></tr>').join('') +
      '</tbody></table></div>' : measuredZero('calls in the last 30 days')) + '</div>' +
  '<div class="card"><div class="card-h" style="padding:0 0 12px"><h2>Calls per day, last 30 days</h2></div>' +
    (d.by_day.length ? dayBars(d.by_day) : '<div class="muted" style="font-size:13.5px">No days with calls in this window.</div>') +
  '</div>';
};

function dayBars(days) {
  const max = Math.max(1, ...days.map((d) => d.calls));
  return '<div class="bars">' + days.map((d) =>
    '<div class="bar" title="' + esc(d.day) + ': ' + d.calls + ' calls"><i style="height:' +
    Math.max(3, Math.round((d.calls / max) * 100)) + '%"></i></div>').join('') + '</div>' +
    '<div class="row" style="justify-content:space-between;margin-top:7px"><span class="muted mono">' +
    esc(days[0].day) + '</span><span class="muted mono">' + esc(days[days.length - 1].day) + '</span></div>';
}

VIEWS.billing = async () => {
  const d = await api('billing');
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  const s = d.stripe;
  const stripeTile = !s.configured
    ? '<span class="pill bad">not configured</span>'
    : (s.reachable ? '<span class="pill ' + (s.live_mode ? 'warn' : 'ok') + '">' +
        (s.live_mode ? 'LIVE MODE' : 'test mode') + '</span>' : '<span class="pill bad">unreachable</span>');
  return '' +
  '<div class="grid g4">' +
    '<div class="card"><div class="tile-k">Stripe</div><div class="tile-v" style="font-size:17px">' + stripeTile + '</div>' +
      '<div class="tile-s">' + esc(s.note || '') + '</div></div>' +
    '<div class="card"><div class="tile-k">Charging armed</div><div class="tile-v" style="font-size:17px">' +
      (d.billing_armed ? '<span class="pill warn">armed</span>' : '<span class="pill">disarmed</span>') + '</div>' +
      '<div class="tile-s">' + (d.billing_armed
        ? 'ANSWERED_BILLING_ARMED is set. Money can move.'
        : 'ANSWERED_BILLING_ARMED is not set, so nothing can charge a customer. This is the safe default.') +
      '</div></div>' +
    '<div class="card"><div class="tile-k">Charges recorded</div><div class="tile-v">' + n(d.totals.events) + '</div>' +
      '<div class="tile-s">' + usd(d.totals.open_cents) + ' open · ' + usd(d.totals.paid_cents) + ' paid</div></div>' +
    '<div class="card"><div class="tile-k">Refunded</div><div class="tile-v">' + usd(d.totals.refunded_cents) + '</div>' +
      '<div class="tile-s">' + n(d.totals.refunds) + ' refunds on record</div></div>' +
  '</div>' +
  '<div class="card pad0"><div class="card-h"><h2>The published price book</h2>' +
    '<span class="sp muted">transcribed from /terms. If a bill and that page disagree, that page wins.</span></div>' +
    '<div class="tw"><table><thead><tr><th>Event</th><th>Product</th><th class="num">Price</th>' +
    '<th>Counts toward the cap</th></tr></thead><tbody>' +
    d.catalog.map((c) => '<tr><td class="mono">' + esc(c.kind) + '</td>' +
      '<td>' + esc(c.label) + '</td>' +
      '<td class="num">' + (c.cents == null ? 'percentage' : usd(c.cents)) + '</td>' +
      '<td>' + (c.capped ? 'yes' : '<span class="muted">no</span>') + '</td></tr>').join('') +
    '</tbody></table></div></div>' +
  (d.orphans ? '<div class="card" style="border-color:var(--warn)"><div class="tile-k" style="color:var(--warn)">' +
    n(d.orphans) + ' billing account' + (d.orphans === 1 ? '' : 's') + ' with no customer attached</div>' +
    '<div class="tile-s" style="font-size:13.5px;margin-top:4px">A bill that is not joined to a customer ' +
    'record cannot be explained to the person paying it, and it is invisible to every screen that ' +
    'starts from the customer. These are almost certainly records created before the two tables were ' +
    'joined by a foreign key. They are shown here rather than filtered out.</div></div>' : '') +
  '<div class="card pad0"><div class="card-h"><h2>Billing accounts</h2>' +
    '<span class="sp muted mono">' + n(d.accounts_total) + ' total</span></div>' +
    (d.accounts.length ? '<div class="tw"><table><thead><tr><th>Account</th><th>Plan</th>' +
      '<th class="num">Cap</th><th>Card</th><th class="num">Charges</th><th class="num">Charged</th>' +
      '<th class="num">Credit</th><th class="num">Refunded</th><th>Customer</th></tr></thead><tbody>' +
      d.accounts.map((b) => '<tr' + (b.account_id ? ' class="click" data-account="' + esc(b.account_id) + '"' : '') + '>' +
        '<td><strong>' + esc(b.business_name || b.email || 'unnamed') + '</strong>' +
          '<br><span class="muted mono">' + esc(b.account_key) + '</span></td>' +
        '<td>' + esc(b.plan) + '</td><td class="num">' + usd(b.cap_cents) + '</td>' +
        '<td>' + (b.card_on_file ? esc((b.card_brand || 'card') + ' ····' + (b.card_last4 || '')) : '<span class="muted">none</span>') + '</td>' +
        '<td class="num">' + n(b.charges) + '</td>' +
        '<td class="num">' + usd(b.charged_cents) + '</td><td class="num">' + usd(b.credit_balance_cents) + '</td>' +
        '<td class="num">' + usd(b.refunded_cents) + '</td>' +
        '<td>' + (b.linked ? '<span class="pill ok">linked</span>'
          : '<span class="pill warn" title="This bill is not joined to a customer record">orphan</span>') + '</td>' +
        '</tr>').join('') + '</tbody></table></div>'
      : measuredZero('billing accounts')) + '</div>';
};

VIEWS.parley = async () => {
  const rows = await api('parley');
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  return '<div class="card"><div class="tile-k">What this console can see</div>' +
    '<div class="tile-s" style="font-size:13.5px;margin-top:4px">Status, the settled value, the fee, ' +
    'and whether each side has set <em>a</em> number. <strong>Never the number itself.</strong> Each ' +
    'party&rsquo;s limit lives in a schema that holds no grant for any role, and the projection this ' +
    'page reads does not join it. There is no argument, flag or query string that turns the numbers on, ' +
    'because &ldquo;trusted not to&rdquo; is not a control.</div></div>' +
  '<div class="card pad0"><div class="card-h"><h2>Deals</h2></div>' +
    (rows.length ? '<div class="tw"><table><thead><tr><th>Subject</th><th>Kind</th><th>Status</th>' +
      '<th class="num">Joined</th><th class="num">Set a number</th><th class="num">Signed</th>' +
      '<th class="num">Settled at</th><th class="num">Fee</th><th>Billable</th><th>Created</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td><strong>' + esc(r.subject) + '</strong></td>' +
        '<td class="mono">' + esc(r.kind) + '</td>' +
        '<td><span class="pill ' + (r.status === 'settled' ? 'ok' : r.status === 'no_overlap' ? 'warn' : '') + '">' +
          esc(String(r.status).replace(/_/g, ' ')) + '</span></td>' +
        '<td class="num">' + n(r.joined) + '/2</td><td class="num">' + n(r.ready) + '/2</td>' +
        '<td class="num">' + n(r.signatures) + '/2</td>' +
        '<td class="num">' + (r.settled_value == null ? '—' : '$' + n(r.settled_value)) + '</td>' +
        '<td class="num">' + usd(r.fee_cents) + '</td>' +
        '<td>' + (r.billable ? '<span class="pill ok">yes</span>' : '<span class="muted">no</span>') + '</td>' +
        '<td class="muted">' + esc(when(r.created_at)) + '</td></tr>').join('') +
      '</tbody></table></div>' : measuredZero('deals')) + '</div>';
};

VIEWS.events = async () => {
  const f = S.filters.events;
  const d = await api('events?' + new URLSearchParams({ name: f.name || '', limit: 100, offset: f.offset }));
  S.lastMeasuredAt = new Date().toISOString(); freshness();

  // ★ THIS PANEL SHIPPED A LIE FOR ABOUT AN HOUR AND IT WAS MINE.
  // It rendered "This is a measured zero, not a loading state and not a failure. The query ran and
  // returned nothing." True of the query, false of the world: app_events has ZERO WRITERS anywhere
  // in this repository and nothing calls sv_admin_event. The table is an unwired pipe, and calling
  // that a measured zero is the exact failure this console exists to prevent, wearing the language
  // of honesty. An empty table and an unconnected table look identical and mean opposite things.
  //
  // The banner is conditional on total === 0, so it removes itself the moment a real event lands
  // rather than needing anyone to remember.
  const unwired = (d.total === 0) ? '<div class="card" style="border-color:var(--warn)">' +
    '<div class="tile-k" style="color:var(--warn)">Nothing writes to this table yet</div>' +
    '<div class="tile-s" style="font-size:13.5px;margin-top:4px">This is <strong>not</strong> a measured ' +
    'zero. It is an unwired pipe. The public site posts funnel events to Netlify Blobs, and no ' +
    'collector writes them into the queryable table this panel reads, so <strong>this panel would ' +
    'show zero whether or not anybody visited the site</strong>. Behaviour analytics are not ' +
    'available yet and nothing below is evidence about customer activity. Verified 2026-08-14: ' +
    'zero writers in the repository, against a search that finds 54 matches for the Blobs client in ' +
    'the same pass, so the instrument works.</div></div>' : '';

  return unwired +
    '<div class="card"><div class="tile-k">Where this comes from</div>' +
    '<div class="tile-s" style="font-size:13.5px;margin-top:4px">The public site posts anonymous funnel ' +
    'events to Netlify Blobs, which is durable object storage and cannot be grouped or joined. This ' +
    'table is the queryable copy of the same stream. <strong>Nothing has been migrated out of Blobs</strong>, ' +
    'so no history was destroyed to make this page work.</div></div>' +
  '<div class="grid g2">' +
  '<div class="card pad0"><div class="card-h"><h2>By event, last 30 days</h2></div>' +
    (d.by_name.length ? '<div class="tw"><table><thead><tr><th>Event</th><th class="num">Count</th>' +
      '<th class="num">Customers</th><th>Last seen</th></tr></thead><tbody>' +
      d.by_name.map((g) => '<tr class="click" data-event="' + esc(g.name) + '"><td class="mono">' + esc(g.name) + '</td>' +
        '<td class="num">' + n(g.n) + '</td><td class="num">' + n(g.accounts) + '</td>' +
        '<td class="muted">' + esc(when(g.last_at)) + '</td></tr>').join('') + '</tbody></table></div>'
      : emptyState('No behaviour events',
          'Nothing writes to this table yet, so this is an absence of plumbing rather than an ' +
          'absence of activity. See the banner above.')) + '</div>' +
  '<div class="card pad0"><div class="card-h"><h2>Recent</h2>' +
    (f.name ? '<span class="sp"><span class="pill brand">' + esc(f.name) +
      '</span><button class="btn ghost sm" data-act="clear-event">Clear</button></span>' : '') + '</div>' +
    (d.rows.length ? '<div class="tw"><table><thead><tr><th>When</th><th>Event</th><th>Page</th>' +
      '<th>Customer</th></tr></thead><tbody>' +
      d.rows.slice(0, 40).map((r) => '<tr><td class="muted">' + esc(when(r.at)) + '</td>' +
        '<td class="mono">' + esc(r.name) + '</td><td class="muted"><span class="trunc">' + esc(r.page || '—') + '</span></td>' +
        '<td>' + (r.business_name ? esc(r.business_name) : '<span class="muted">anonymous</span>') + '</td></tr>').join('') +
      '</tbody></table></div>'
      : emptyState('Nothing to show',
          'No collector writes this table, so this list cannot fill regardless of site traffic.')) + '</div>' +
  '</div>';
};

VIEWS.compliance = async () => {
  const d = await api('compliance');
  S.lastMeasuredAt = d.at; freshness();
  const t = d.totals, e = d.evidence, k = d.dnc;

  // ★ THE HEADLINE NUMBER NEVER SHIPS WITHOUT ITS DENOMINATOR. A zero here means either "nothing
  // is wrong" or "nothing has been measured", and those are opposite. The columns behind it are
  // new, so most existing rows carry NULL, and a bare reassuring 0 would be the worst kind of lie:
  // the comfortable one.
  const exposure = e.ai_listened_without_verified_disclosure;
  // The denominator now ships WITH the headline number, so the panel no longer has to derive
  // it. Falling back to the by-class sum keeps an older deploy of the RPC rendering honestly
  // rather than silently reading undefined as zero.
  const measured = (typeof e.ai_listened_total === 'number') ? e.ai_listened_total : t.ai_listened;
  const exposureTone = exposure > 0 ? 'bad' : (measured > 0 ? 'ok' : 'warn');
  const exposureNote = exposure > 0
    ? 'Calls where an AI was receiving the audio and no disclosure has been verified on the wire. ' +
      'This is the count that a class claim turns on. It should be zero.'
    : (measured > 0
        ? 'Zero, and it is a measured zero: ' + n(measured) + ' calls had an AI listening and every ' +
          'one of them has a disclosure verified from the transcript.'
        : 'Zero, but <strong>nothing has been measured yet</strong>. No call on record carries ' +
          'ai_listening, because the column is newer than these rows. This is an unmeasured zero ' +
          'and it must not be read as a clean bill.');

  const three = (v, yes, no, unknown) => v === true
    ? '<span class="pill ok">' + yes + '</span>'
    : (v === false ? '<span class="pill">' + no + '</span>'
                   : '<span class="pill warn">' + unknown + '</span>');

  const gateOpen = k.scrub_ready && k.procedures_ready;

  const CLASS_TEXT = {
    ai_cold: 'AI voice to a verified landline or fixed VoIP',
    human_cold: 'A person dials and speaks, no artificial voice on the call',
    consented: 'AI voice, any line type, consent on file',
    inbound: 'They called us. CIPA, not TCPA.',
    demo: 'Our own demo and canary traffic',
    unclassified: 'Placed before the class column existed. Not a real category.',
  };

  return '' +
  '<div class="card" style="border-color:var(--' + (exposure > 0 ? 'bad' : (measured > 0 ? 'ok' : 'warn')) + ')">' +
    '<div class="tile-k">AI listening without a verified disclosure</div>' +
    '<div class="tile-v" style="color:var(--' + (exposure > 0 ? 'bad' : (measured > 0 ? 'ok' : 'warn')) + ')">' + n(exposure) + '</div>' +
    '<div class="tile-s">' + exposureNote + '</div></div>' +

  '<div class="grid g4">' +
    '<div class="card"><div class="tile-k">Do-not-call gate</div><div class="tile-v" style="font-size:18px">' +
      (gateOpen ? '<span class="pill ok">OPEN</span>' : '<span class="pill bad">SHUT</span>') + '</div>' +
      '<div class="tile-s">' + (gateOpen
        ? 'The registry scrub and the 64.1200(d) procedures are both in place, so non-consented cold calls may be placed.'
        : 'Non-consented cold calls cannot be placed. The gate reads this from the database on every dial, not from a constant anyone can flip.') +
      '</div></div>' +
    '<div class="card"><div class="tile-k">Registry scrub</div><div class="tile-v" style="font-size:18px">' +
      (k.scrub_ready ? '<span class="pill ok">ready</span>' : '<span class="pill bad">not ready</span>') + '</div>' +
      '<div class="tile-s">' + (k.snapshot_numbers
        ? n(k.snapshot_numbers) + ' numbers across ' + n(k.snapshot_area_codes) + ' area codes, ' +
          (k.snapshot_age_days == null ? 'age unknown' : n(k.snapshot_age_days) + ' days old')
        : 'No registry snapshot has ever been loaded. Freshness is a property of the snapshot, so a stale one shuts the gate on day 32 without anyone having to remember.') +
      '</div></div>' +
    '<div class="card"><div class="tile-k">Written procedures</div><div class="tile-v" style="font-size:18px">' +
      (k.procedures_ready ? '<span class="pill ok">in place</span>' : '<span class="pill bad">incomplete</span>') + '</div>' +
      '<div class="tile-s">The six elements of 47 CFR 64.1200(d). A condition precedent, not a mitigation.</div></div>' +
    '<div class="card"><div class="tile-k">Opt-outs overdue</div><div class="tile-v">' + n(k.overdue_requests) + '</div>' +
      '<div class="tile-s">Requests past the ten business day deadline. We honour immediately and record both times, so the evidence shows we were inside the window rather than that we spent it.</div></div>' +
  '</div>' +

  '<div class="card pad0"><div class="card-h"><h2>What the registry program still needs</h2>' +
    '<span class="sp muted">this part is a signature, not a build</span></div>' +
    '<div class="tw"><table><tbody>' +
    row3('Subscription Account Number on file', k.san_on_file,
         'An organisation account at telemarketing.donotcall.gov. $82 per area code, first five free, $22,626 national cap. Nobody can engineer this one.') +
    row3('Registry snapshot loaded', k.scrub_ready,
         'research/dnc-ingest.mjs loads a download the moment one exists and reports honestly until then.') +
    row3('Policy written', k.policy_written, 'The written do-not-call policy, available on demand.') +
    row3('Affiliate scope recorded', k.affiliate_scope, 'Which entities a request covers.') +
    row3('Retention policy', k.retention_policy, 'How long a request is honoured.') +
    row3('Training recorded', k.training_recorded, 'Personnel trained in the procedures, with a record of it.') +
    row3('Internal list live', k.internal_list_live, 'Our own suppression list, checked before every dial.') +
    '</tbody></table></div></div>' +

  '<div class="card pad0"><div class="card-h"><h2>Evidence by call class</h2>' +
    '<span class="sp muted">since ' + esc(String(e.window_start || '').slice(0, 10)) + '</span></div>' +
    (e.by_class && e.by_class.length
      ? '<div class="tw"><table><thead><tr><th>Class</th><th>What it means</th>' +
        '<th class="num">Placed</th><th class="num">Refused</th><th class="num">AI spoke</th>' +
        '<th class="num">AI listened</th><th class="num">Disclosure verified</th>' +
        '<th class="num">Failed</th><th class="num">Unchecked</th><th class="num">DNC scrubbed</th></tr></thead><tbody>' +
        e.by_class.map((c) => '<tr><td><span class="pill ' +
          (c.call_class === 'unclassified' ? 'warn' : 'info') + '">' + esc(c.call_class) + '</span></td>' +
          '<td class="dim">' + esc(CLASS_TEXT[c.call_class] || '') + '</td>' +
          '<td class="num">' + n(c.placed) + '</td><td class="num">' + n(c.refused) + '</td>' +
          '<td class="num">' + n(c.ai_spoke) + '</td><td class="num">' + n(c.ai_listened) + '</td>' +
          '<td class="num">' + (c.disclosure_verified ? '<span style="color:var(--ok)">' + n(c.disclosure_verified) + '</span>' : n(c.disclosure_verified)) + '</td>' +
          '<td class="num">' + (c.disclosure_failed ? '<span style="color:var(--bad)">' + n(c.disclosure_failed) + '</span>' : n(c.disclosure_failed)) + '</td>' +
          '<td class="num">' + (c.disclosure_unchecked ? '<span style="color:var(--warn)">' + n(c.disclosure_unchecked) + '</span>' : n(c.disclosure_unchecked)) + '</td>' +
          '<td class="num">' + n(c.dnc_scrubbed) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : measuredZero('calls in this window')) +
    '<div class="card-h" style="border-bottom:none;border-top:1px solid var(--line)">' +
      '<span class="muted" style="font-size:13px;line-height:1.6">Disclosure is read back from the ' +
      'transcript, never set at dial time. A real call once had the disclosure present in the script, ' +
      'complete in the obligations list, approved by its own checker and findable by grep, while the ' +
      'entire spoken output was the word &ldquo;Hi&rdquo;, because a bare instruction nested inside a ' +
      'listening block is cut off by the first word the other person says. <strong>Unchecked is not ' +
      'disclosed.</strong></span></div>' +
  '</div>' +

  refusalsCard(e);
};

/**
 * ★ A RENAMED KEY MUST FAIL LOUD, NOT VANISH.
 *
 * This card previously read 'e.states_refused'. The outbound lane replaced it with 'refusals',
 * a better shape, and the panel kept rendering a clean page with the table silently absent: no
 * error, no empty state, no gap anyone would notice. A section that disappears when its data
 * source is renamed is the dominant failure mode in this estate wearing a different hat.
 *
 * So: the ONE shape it understands is 'refusals'. Anything else says so on the screen.
 */
function refusalsCard(e) {
  const head = '<div class="card-h"><h2>Why the gate refused</h2>' +
    '<span class="sp muted">refusals are recorded, never discarded: they are the proof the gate ran</span></div>';

  if (!Array.isArray(e.refusals)) {
    return '<div class="card pad0">' + head + errState('The refusal data changed shape',
      "This panel expects a refusals array of { code, reason, n } and the evidence source did not " +
      'return one. The table is not empty, it is unreadable, and those are different. Nothing here ' +
      'is a measurement until this is fixed.') + '</div>';
  }
  if (!e.refusals.length) {
    return '<div class="card pad0">' + head + emptyState('The gate has refused nothing in this window',
      'A measured zero. Every call the gate saw met its preconditions. Measured ' + esc(stamp(S.lastMeasuredAt)) + '.') + '</div>';
  }

  // Colour by what KIND of refusal it is, from the stable code rather than from prose that may be
  // reworded. A do-not-call refusal and a wrong-line-type refusal mean very different things about
  // whether the programme is ready.
  const TONE = { dnc_listed:'bad', dnc_unanswerable:'bad', dnc_no_scrub:'bad', dnc_no_procedures:'bad',
    state_licensing:'warn', state_biometric:'warn', mobile_no_consent:'warn', suppressed:'bad',
    line_type_unfit:'', lookup_failed:'warn', no_state:'warn', frequency_cap:'', toll_free:'', other:'' };
  const total = e.refusals.reduce((a, r) => a + (Number(r.n) || 0), 0);

  return '<div class="card pad0">' + head +
    '<div class="tw"><table><thead><tr><th>Code</th><th>Why, in full</th>' +
    '<th class="num">Calls</th></tr></thead><tbody>' +
    e.refusals.slice().sort((a, b) => b.n - a.n).map((r) =>
      '<tr><td><span class="pill ' + (TONE[r.code] || '') + '">' + esc(r.code || 'other') + '</span></td>' +
      '<td class="dim">' + esc(r.reason) + '</td>' +
      '<td class="num">' + n(r.n) + '</td></tr>').join('') +
    '</tbody></table></div>' +
    '<div class="card-h" style="border-bottom:none;border-top:1px solid var(--line)">' +
      '<span class="muted">' + n(total) + ' refusals across ' + n(e.refusals.length) + ' distinct reasons</span></div>' +
  '</div>';
};

const row3 = (label, ok, detail) =>
  '<tr><td><strong>' + esc(label) + '</strong><br><span class="muted" style="font-size:12.5px">' +
  detail + '</span></td><td class="num" style="vertical-align:top">' +
  (ok === true ? '<span class="pill ok">yes</span>'
    : ok === false ? '<span class="pill bad">no</span>'
    : '<span class="pill warn">unknown</span>') + '</td></tr>';

VIEWS.audit = async () => {
  const d = await api('audit?limit=200');
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  return '<div class="card"><div class="tile-k">Append only</div>' +
    '<div class="tile-s" style="font-size:13.5px;margin-top:4px">Every sign in, every refund, every ' +
    'status change and every recording played is written here. A database trigger refuses UPDATE and ' +
    'DELETE on this table, so it cannot be edited or tidied afterwards, including by this console.</div></div>' +
  '<div class="card pad0"><div class="card-h"><h2>Operator actions</h2></div>' +
    (d.rows.length ? '<div class="tw"><table><thead><tr><th>When</th><th>Who</th><th>Action</th>' +
      '<th>Target</th><th>Result</th><th>From</th></tr></thead><tbody>' +
      d.rows.map((r) => '<tr><td class="muted mono">' + esc(stamp(r.at)) + '</td>' +
        '<td>' + esc(r.actor_email || 'system') + '</td>' +
        '<td class="mono">' + esc(r.action) + '</td>' +
        '<td class="muted mono"><span class="trunc">' + esc([r.target_kind, r.target_id].filter(Boolean).join(' ') || '—') + '</span></td>' +
        '<td>' + (r.result === 'ok' ? '<span class="pill ok">ok</span>'
          : '<span class="pill bad">' + esc(r.result || '') + '</span>') + '</td>' +
        '<td class="muted mono">' + esc(r.ip || '—') + '</td></tr>').join('') +
      '</tbody></table></div>' : measuredZero('operator actions')) + '</div>';
};

VIEWS.system = async () => {
  const d = await api('system');
  S.lastMeasuredAt = d.at; freshness();
  const sw = (on, onText, offText, tone) =>
    '<span class="pill ' + (on ? tone : '') + '">' + (on ? onText : offText) + '</span>';
  return '' +
  '<div class="grid g2">' +
  '<div class="card"><div class="tile-k">Outbound calling</div>' +
    '<div class="tile-v" style="font-size:18px">' +
      sw(d.autopilot_kill, 'DISARMED', 'ARMED', 'warn') + '</div>' +
    '<div class="tile-s">' + (d.autopilot_kill
      ? 'ANSWERED_AUTOPILOT_KILL is set. <strong>No campaign can place a call.</strong> A 200 from the ' +
        'call endpoints does not mean outbound is live, which is exactly why this tile exists.'
      : 'The kill switch is off. Campaigns can dial.') + '</div></div>' +
  '<div class="card"><div class="tile-k">Text messaging</div>' +
    '<div class="tile-v" style="font-size:18px"><span class="pill bad">carrier blocked</span></div>' +
    '<div class="tile-s">The A2P 10DLC campaign has not been approved, so no surface may promise a ' +
      'text to a customer. This tile stays red until the campaign reads verified, not until it is ' +
      'resubmitted.</div></div>' +
  '</div>' +
  '<div class="card pad0"><div class="card-h"><h2>Integrations, read from inside this running function</h2>' +
    '<span class="sp muted">not from a control-plane listing, which is unreliable on this site</span></div>' +
    '<div class="tw"><table><thead><tr><th>Name</th><th>Purpose</th><th>Present</th></tr></thead><tbody>' +
    d.env.map((e) => '<tr><td class="mono">' + esc(e.name) + '</td><td class="dim">' + esc(e.purpose) + '</td>' +
      '<td>' + (e.present ? '<span class="pill ok">set</span>'
        : '<span class="pill ' + (e.required ? 'bad' : 'warn') + '">' + (e.required ? 'MISSING' : 'not set') + '</span>') +
      '</td></tr>').join('') + '</tbody></table></div></div>' +
  '<div class="card pad0"><div class="card-h"><h2>Database</h2></div>' +
    '<div class="tw"><table><thead><tr><th>Table</th><th class="num">Rows</th></tr></thead><tbody>' +
    d.tables.map((t) => '<tr><td class="mono">' + esc(t.name) + '</td><td class="num">' + n(t.rows) + '</td></tr>').join('') +
    '</tbody></table></div></div>' +
  '<div class="card"><div class="tile-k">This build</div><div class="tile-s" style="font-size:13.5px">' +
    'Deploy <span class="mono">' + esc(d.build.deploy_id || 'unknown') + '</span> · ' +
    'UI <span class="mono">' + esc(d.build.ui || '') + '</span> · ' +
    'measured <span class="mono">' + esc(stamp(d.at)) + '</span></div></div>';
};

// ── chrome helpers ────────────────────────────────────────────────────────
function freshness() {
  const el = $('#freshness');
  if (!el) return;
  el.textContent = S.lastMeasuredAt ? 'measured ' + when(S.lastMeasuredAt) : 'not measured';
  el.title = 'Measured ' + stamp(S.lastMeasuredAt);
}
function counts(d) {
  const a = $('[data-count="accounts"]'); if (a) a.textContent = d.accounts.total || '';
  const c = $('[data-count="calls"]'); if (c) c.textContent = d.calls.total || '';
}
function filterChips(group, opts, active, key) {
  return opts.map(([v, label]) =>
    '<button class="btn ghost sm" data-filter="' + group + '" data-key="' + (key || 'status') + '" data-value="' + (v == null ? '' : esc(v)) + '"' +
    (String(active == null ? '' : active) === String(v == null ? '' : v) ? ' style="border-color:var(--brand);color:var(--brand)"' : '') +
    '>' + esc(label) + '</button>').join('');
}
function pager(group, d) {
  const from = d.offset + 1, to = Math.min(d.offset + d.limit, d.total);
  if (d.total <= d.limit) return '<div class="card-h" style="border-bottom:none;border-top:1px solid var(--line)">' +
    '<span class="muted">' + n(d.total) + ' total</span></div>';
  return '<div class="card-h" style="border-bottom:none;border-top:1px solid var(--line)">' +
    '<span class="muted">' + n(from) + '–' + n(to) + ' of ' + n(d.total) + '</span><span class="sp">' +
    '<button class="btn ghost sm" data-page="' + group + '" data-dir="-1"' + (d.offset === 0 ? ' disabled' : '') + '>Previous</button>' +
    '<button class="btn ghost sm" data-page="' + group + '" data-dir="1"' + (to >= d.total ? ' disabled' : '') + '>Next</button>' +
    '</span></div>';
}

// ── router ────────────────────────────────────────────────────────────────
const TITLES = { overview:'Overview', crm:'Leads', customers:'Customers', calls:'Calls and recordings',
  usage:'Usage', billing:'Billing', parley:'Parley', events:'Behaviour', compliance:'Compliance',
  audit:'Audit log', system:'System' };

let painting = false;
async function go(view, opts) {
  if (!VIEWS[view]) view = 'overview';
  S.view = view;
  $$('.nav').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  $('#title').textContent = TITLES[view];
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  const el = $('#view');
  if (!(opts && opts.quiet)) paint(el, '<div class="card"><div class="skel" style="width:38%"></div>' +
    '<div class="skel" style="width:64%;margin-top:11px"></div>' +
    '<div class="skel" style="width:52%;margin-top:11px"></div></div>');
  painting = true;
  try {
    const html = await VIEWS[view]();
    if (S.view === view) paint(el, html);
  } catch (e) {
    paint(el, errState('This section could not load', e.message +
      '. Nothing was changed. The failure is shown rather than an empty table, because an empty ' +
      'table would read as "no data" and that would be a lie.'));
  } finally { painting = false; }
}

// ── drawer ────────────────────────────────────────────────────────────────
function closeDrawer() {
  $('#drawer').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('on'); S.drawerAccount = null;
}
async function openAccount(id) {
  const dr = $('#drawer'); S.drawerAccount = id;
  dr.classList.add('on'); dr.setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('on');
  dr.innerHTML = '<div class="drawer-h"><div style="flex:1"><div class="skel" style="width:50%"></div></div>' +
    '<button class="btn ghost sm" data-act="close-drawer">Close</button></div>' +
    '<div class="drawer-b"><div class="skel" style="width:70%"></div></div>';
  let d;
  try { d = await api('account?id=' + encodeURIComponent(id)); }
  catch (e) { dr.innerHTML = '<div class="drawer-h"><h2>Could not load</h2>' +
    '<button class="btn ghost sm" style="margin-left:auto" data-act="close-drawer">Close</button></div>' +
    '<div class="drawer-b">' + errState('This customer could not be loaded', e.message) + '</div>'; return; }
  if (!d) { dr.innerHTML = '<div class="drawer-h"><h2>Not found</h2>' +
    '<button class="btn ghost sm" style="margin-left:auto" data-act="close-drawer">Close</button></div>' +
    '<div class="drawer-b">' + errState('No such customer', 'That account id does not exist.') + '</div>'; return; }
  renderAccount(d);
}

let drawerTab = 'summary';
function renderAccount(d) {
  const a = d.account, b = d.billing, u = d.usage || {};
  const tabs = [['summary','Summary'],['rules','Rules'],['calls','Calls'],['billing','Billing'],
    ['behaviour','Behaviour'],['history','History']];
  const head =
    '<div class="drawer-h"><div style="flex:1;min-width:0">' +
      '<div class="row" style="align-items:center;gap:9px"><h2 style="font-size:18px;font-weight:650">' +
        esc(a.business_name || 'Unnamed') + '</h2>' +
        '<span class="pill ' + (STATUS_TONE[a.status] || '') + '">' + esc(String(a.status).replace(/_/g,' ')) + '</span></div>' +
      '<div class="muted mono" style="font-size:12.5px;margin-top:4px">' + esc(a.owner_email) +
        ' · signed up ' + esc(stamp(a.created_at)) + '</div>' +
    '</div><button class="btn ghost sm" data-act="close-drawer">Close</button></div>' +
    '<div class="tabs">' + tabs.map(([k, l]) =>
      '<button class="tab" data-tab="' + k + '" aria-selected="' + (drawerTab === k) + '">' + l + '</button>').join('') + '</div>';

  const panes = {
    summary: () => '<div class="grid g2">' +
      '<div class="card"><div class="tile-k">Calls</div><div class="tile-v">' + n(u.calls_total) + '</div>' +
        '<div class="tile-s">' + n(u.calls_30d) + ' in 30 days · ' + n(u.recordings) + ' recorded<br>' +
        'Talk time ' + dur(u.talk_seconds) + '</div></div>' +
      '<div class="card"><div class="tile-k">Money</div><div class="tile-v">' +
        (b ? usd(b.balance ? b.balance.charged_cents : 0) : '—') + '</div>' +
        '<div class="tile-s">' + (b
          ? usd(b.balance ? b.balance.credit_balance_cents : 0) + ' credit · cap ' + usd(b.cap_cents) +
            '<br>' + (b.card_on_file ? esc((b.card_brand||'Card') + ' ····' + (b.card_last4||'')) : 'No card on file')
          : 'No billing account is linked to this customer yet.') + '</div></div>' +
      '</div>' +
      '<div class="card"><h2 style="margin-bottom:12px">Details</h2><dl class="kv">' +
        kv('Business', a.business_name) + kv('Owner', a.owner_name) + kv('Email', a.owner_email) +
        kv('Phone', phone(a.owner_phone)) + kv('Trade', a.trade) + kv('Timezone', a.timezone) +
        kv('Status', String(a.status).replace(/_/g,' ')) +
        kv('Email confirmed', a.email_verified_at ? stamp(a.email_verified_at) : 'not yet') +
        kv('Rules complete', a.ready_at ? stamp(a.ready_at) : 'not yet') +
        kv('Asked for a number', a.requested_line_at ? stamp(a.requested_line_at) : 'not yet') +
        kv('Went live', a.live_at ? stamp(a.live_at) : 'not yet') +
        kv('Numbers', (d.numbers || []).length
          ? d.numbers.map((x) => phone(x.phone) + ' (' + x.status + ')').join(', ') : 'none assigned') +
        kv('Account id', '<span class="mono">' + esc(a.id) + '</span>') +
      '</dl></div>' +
      '<div class="card"><h2 style="margin-bottom:10px">Operator actions</h2>' +
        '<div class="row">' +
        '<button class="btn ghost sm" data-act="status" data-value="paused">Pause line</button>' +
        '<button class="btn ghost sm" data-act="status" data-value="configuring">Send back to configuring</button>' +
        '<button class="btn ghost sm" data-act="status" data-value="closed">Close account</button>' +
        '</div>' +
        '<p class="tile-s" style="margin-top:10px">Going <strong>live</strong> is not on this list on ' +
        'purpose. A line goes live when a real number is assigned to it, never because somebody typed ' +
        'a status. Every action here is written to the audit log with your name on it.</p></div>',

    rules: () => d.config
      ? '<div class="card"><h2 style="margin-bottom:12px">The rules this line answers under</h2><dl class="kv">' +
        kv('Answers as', d.config.greeting_name) + kv('Says the name as', d.config.business_says) +
        kv('Services', (d.config.services || []).join(', ')) + kv('Service area', d.config.service_area) +
        kv('After hours', d.config.after_hours) + kv('Booking', d.config.booking_mode) +
        kv('Booking goes to', d.config.booking_destination) +
        kv('Escalation', d.config.escalation_when + (d.config.escalation_phone ? ' → ' + phone(d.config.escalation_phone) : '')) +
        kv('Quotes', d.config.quote_policy) + kv('Price notes', d.config.price_notes) +
        kv('Never say', (d.config.never_say || []).join(' · ')) +
        kv('Always ask', (d.config.always_ask || []).join(' · ')) +
        kv('Monthly cap', usd(d.config.monthly_cap_cents)) +
        kv('Version', 'v' + d.config.version + ' · updated ' + stamp(d.config.updated_at)) +
        '</dl></div>' +
        ((d.config_versions || []).length ? '<div class="card pad0"><div class="card-h"><h2>Rule history</h2></div>' +
          '<div class="tw"><table><thead><tr><th>Version</th><th>Changed by</th><th>When</th></tr></thead><tbody>' +
          d.config_versions.map((v) => '<tr><td class="mono">v' + v.version + '</td><td>' + esc(v.author || '—') +
            '</td><td class="muted">' + esc(stamp(v.at)) + '</td></tr>').join('') + '</tbody></table></div></div>' : '')
      : emptyState('No rules yet', 'This business has not written the instructions its line would answer under.'),

    calls: () => (d.calls || []).length
      ? '<div class="card pad0"><div class="card-h"><h2>Calls</h2></div><div class="tw"><table>' +
        '<thead><tr><th>When</th><th>Direction</th><th>Result</th><th class="num">Length</th><th>Recording</th></tr></thead><tbody>' +
        d.calls.map((c) => '<tr class="click" data-call="' + esc(c.call_sid || '') + '">' +
          '<td class="muted">' + esc(when(c.created_at)) + '</td><td>' + esc(c.direction) + '</td>' +
          '<td>' + esc(c.status || (c.placed ? 'placed' : 'refused')) + '</td>' +
          '<td class="num">' + dur(c.duration_seconds) + '</td>' +
          '<td>' + (c.recording_sid ? '<button class="btn ghost sm" data-rec="' + esc(c.recording_sid) + '">Listen</button>'
            : '<span class="muted">none</span>') + '</td></tr>').join('') +
        '</tbody></table></div></div>'
      : measuredZero('calls for this customer'),

    billing: () => b
      ? '<div class="card"><h2 style="margin-bottom:12px">Billing</h2><dl class="kv">' +
        kv('Account key', '<span class="mono">' + esc(b.account_key) + '</span>') +
        kv('Plan', b.plan) + kv('Cap this cycle', usd(b.cap_cents)) +
        kv('Pending cap', b.pending_cap_cents ? usd(b.pending_cap_cents) + ' from ' + b.pending_cap_month : 'none') +
        kv('Card', b.card_on_file ? (b.card_brand || 'card') + ' ····' + (b.card_last4 || '') : 'none on file') +
        kv('Stripe customer', b.stripe_customer_id ? '<span class="mono">' + esc(b.stripe_customer_id) + '</span>' : 'none') +
        kv('Charged', usd(b.balance ? b.balance.charged_cents : 0)) +
        kv('Credit balance', usd(b.balance ? b.balance.credit_balance_cents : 0)) +
        kv('Refunded', usd(b.balance ? b.balance.refunded_cents : 0)) +
        '</dl></div>' +
        ((d.charges || []).length ? '<div class="card pad0"><div class="card-h"><h2>Charges</h2></div>' +
          '<div class="tw"><table><thead><tr><th>When</th><th>What</th><th class="num">Amount</th>' +
          '<th>State</th><th></th></tr></thead><tbody>' +
          d.charges.map((c) => '<tr><td class="muted">' + esc(when(c.occurred_at)) + '</td>' +
            '<td>' + esc(c.label || c.kind) + '<br><span class="muted mono">' + esc(c.kind) + '</span></td>' +
            '<td class="num">' + usd(c.cents) + '</td>' +
            '<td><span class="pill ' + (c.state === 'paid' ? 'ok' : c.state === 'voided' ? 'bad' : '') + '">' +
              esc(c.state) + '</span></td>' +
            '<td>' + (c.state !== 'voided' && c.cents > 0
              ? '<button class="btn ghost sm" data-act="refund" data-charge="' + esc(c.id) + '" data-max="' + c.cents +
                '" data-label="' + esc(c.label || c.kind) + '">Refund</button>' : '') + '</td></tr>').join('') +
          '</tbody></table></div></div>' : measuredZero('charges')) +
        ((d.refunds || []).length ? '<div class="card pad0"><div class="card-h"><h2>Refunds</h2></div>' +
          '<div class="tw"><table><thead><tr><th>When</th><th class="num">Amount</th><th>Status</th>' +
          '<th>Reason</th><th>By</th></tr></thead><tbody>' +
          d.refunds.map((r) => '<tr><td class="muted">' + esc(when(r.created_at)) + '</td>' +
            '<td class="num">' + usd(r.amount_cents) + '</td>' +
            '<td><span class="pill ' + (r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn') + '">' +
              esc(r.status) + '</span></td><td class="dim">' + esc(r.reason || '—') + '</td>' +
            '<td class="muted">' + esc(r.created_by || '—') + '</td></tr>').join('') +
          '</tbody></table></div></div>' : '')
      : emptyState('No billing account linked',
          'This customer has no billing record, so there is nothing to charge and nothing to refund. ' +
          'A billing account is created the first time something billable happens.'),

    behaviour: () => (d.events_rollup || []).length
      ? '<div class="card pad0"><div class="card-h"><h2>What they use</h2></div><div class="tw"><table>' +
        '<thead><tr><th>Event</th><th class="num">Times</th><th>Last</th></tr></thead><tbody>' +
        d.events_rollup.map((g) => '<tr><td class="mono">' + esc(g.name) + '</td><td class="num">' + n(g.n) +
          '</td><td class="muted">' + esc(when(g.last_at)) + '</td></tr>').join('') + '</tbody></table></div></div>' +
        ((d.events_recent || []).length ? '<div class="card pad0"><div class="card-h"><h2>Recent activity</h2></div>' +
          '<div class="tw"><table><thead><tr><th>When</th><th>Event</th><th>Page</th></tr></thead><tbody>' +
          d.events_recent.map((e) => '<tr><td class="muted">' + esc(when(e.at)) + '</td>' +
            '<td class="mono">' + esc(e.name) + '</td><td class="muted">' + esc(e.page || '—') + '</td></tr>').join('') +
          '</tbody></table></div></div>' : '')
      : emptyState('Nothing recorded for this customer yet',
          'Behaviour events are attributed to a customer once they are signed in. Anonymous activity ' +
          'before signup is kept separately and is not guessed at here.'),

    history: () => ((d.timeline || []).length || (d.audit || []).length)
      ? ((d.timeline || []).length ? '<div class="card pad0"><div class="card-h"><h2>What happened on this account</h2></div>' +
          '<div class="tw"><table><thead><tr><th>When</th><th>Event</th><th>By</th></tr></thead><tbody>' +
          d.timeline.map((t) => '<tr><td class="muted mono">' + esc(stamp(t.at)) + '</td>' +
            '<td class="mono">' + esc(t.kind) + '</td><td>' + esc(t.actor || 'system') + '</td></tr>').join('') +
          '</tbody></table></div></div>' : '') +
        ((d.audit || []).length ? '<div class="card pad0"><div class="card-h"><h2>What operators did</h2></div>' +
          '<div class="tw"><table><thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead><tbody>' +
          d.audit.map((x) => '<tr><td class="muted mono">' + esc(stamp(x.at)) + '</td>' +
            '<td>' + esc(x.actor_email) + '</td><td class="mono">' + esc(x.action) + '</td></tr>').join('') +
          '</tbody></table></div></div>' : '')
      : measuredZero('history'),
  };

  const dr = $('#drawer');
  dr.innerHTML = head + '<div class="drawer-b" id="dbody">' + panes[drawerTab]() + '</div>';
  dr.__panes = panes;
}
const kv = (k, v) => (v == null || v === '' ? '' : '<dt>' + esc(k) + '</dt><dd>' + (String(v).startsWith('<') ? v : esc(v)) + '</dd>');

// ── modal ─────────────────────────────────────────────────────────────────
function modal(html) { const m = $('#modal'); m.innerHTML = '<div class="modal-box">' + html + '</div>'; m.classList.add('on'); }
function closeModal() { $('#modal').classList.remove('on'); $('#modal').innerHTML = ''; }

function refundModal(chargeId, maxCents, label) {
  modal('<h3>Refund this charge</h3>' +
    '<p>' + esc(label) + ' &middot; charged ' + usd(maxCents) + '. A refund is recorded as a new row; ' +
    'the original charge keeps its amount and its reasoning forever, so the bill can still be explained ' +
    'six months from now.</p>' +
    '<div class="field"><label for="ramt">Amount to refund</label>' +
      '<input class="input" id="ramt" type="text" inputmode="decimal" value="' + (maxCents / 100).toFixed(2) + '"></div>' +
    '<div class="field"><label for="rreason">Reason, which the customer may see</label>' +
      '<input class="input" id="rreason" type="text" placeholder="e.g. the booking was not a real job"></div>' +
    '<div class="alert warn" id="rwarn" style="display:none"></div>' +
    '<div class="row end"><button class="btn ghost" data-act="close-modal">Cancel</button>' +
    '<button class="btn danger" data-act="refund-go" data-charge="' + esc(chargeId) + '" data-max="' + maxCents + '">Refund</button></div>');
  setTimeout(() => $('#ramt') && $('#ramt').focus(), 30);
}

async function doRefund(chargeId, maxCents) {
  const amt = Math.round(parseFloat($('#ramt').value) * 100);
  const warn = $('#rwarn');
  if (!Number.isFinite(amt) || amt <= 0) {
    warn.textContent = 'Enter an amount greater than zero.'; warn.style.display = 'block'; return;
  }
  if (amt > maxCents) {
    warn.textContent = 'That is more than the charge. At most ' + usd(maxCents) + ' can be refunded.';
    warn.style.display = 'block'; return;
  }
  const btn = $('[data-act="refund-go"]'); btn.disabled = true; btn.textContent = 'Refunding…';
  try {
    const r = await api('refund', { body: { charge_id: chargeId, amount_cents: amt,
      reason: $('#rreason').value || null, account_id: S.drawerAccount } });
    closeModal();
    toast(r.replay ? 'That refund was already recorded. Nothing was charged twice.'
                   : 'Refund recorded: ' + usd(amt) + (r.stripe ? ' and sent to Stripe.' : ' (Stripe is not armed, so no money moved).'), 'ok');
    if (S.drawerAccount) openAccount(S.drawerAccount);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Refund';
    warn.textContent = e.message; warn.style.display = 'block';
  }
}

// ── command palette ───────────────────────────────────────────────────────
let palIndex = 0, palItems = [];
function openPal() {
  $('#pal').classList.add('on'); const i = $('#pal-q'); i.value = ''; palSearch(''); setTimeout(() => i.focus(), 20);
}
function closePal() { $('#pal').classList.remove('on'); }
async function palSearch(q) {
  const secs = Object.keys(TITLES).filter((k) => TITLES[k].toLowerCase().includes(q.toLowerCase()))
    .map((k) => ({ kind: 'view', id: k, label: TITLES[k], right: 'Section' }));
  let people = [];
  if (q.trim().length >= 2) {
    try {
      const d = await api('accounts?' + new URLSearchParams({ q: q.trim(), limit: 8, offset: 0, sort: 'recent' }));
      people = d.rows.map((r) => ({ kind: 'account', id: r.id, label: r.business_name || r.owner_email,
        right: String(r.status).replace(/_/g, ' ') }));
    } catch (e) { /* palette must not break the page */ }
  }
  palItems = secs.concat(people); palIndex = 0; palPaint();
}
function palPaint() {
  $('#pal-list').innerHTML = palItems.length
    ? palItems.map((it, i) => '<div class="pal-i" role="option" aria-selected="' + (i === palIndex) + '" data-i="' + i + '">' +
        esc(it.label) + '<span class="r">' + esc(it.right) + '</span></div>').join('')
    : '<div class="pal-i muted">Nothing matches</div>';
}
function palGo() {
  const it = palItems[palIndex]; if (!it) return;
  closePal();
  if (it.kind === 'view') go(it.id); else openAccount(it.id);
}

// ── events. One delegated listener, so nothing is bound to a node a repaint will replace. ──
function wire() {
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-view],[data-account],[data-contact],[data-call],[data-rec],[data-act],[data-filter],[data-crmfilter],[data-page],[data-tab],[data-leadtab],[data-status],[data-event],[data-bulk],[data-setdisp],[data-task],[data-sel],.pal-i');
    if (!t) return;

    // ── CRM ────────────────────────────────────────────────────────────────────────────────
    if (t.dataset.sel != null) {                    // a row checkbox
      const id = t.dataset.sel;
      if (t.checked) S.selected.add(id); else S.selected.delete(id);
      go('crm', { quiet: true });
      return;
    }
    if (t.dataset.crmfilter) {
      const k = t.dataset.crmfilter, v = t.dataset.value;
      if (k === 'clear') {
        S.filters.crm = { lane:null, disposition:null, state:null, trade:null, line_type:null,
                          dialable:null, suppressed:null, has_email:null, sort:S.filters.crm.sort, offset:0 };
        S.q = ''; const qi = $('#q'); if (qi) qi.value = '';
      } else {
        const cur = S.filters.crm[k];
        const val = v === '' ? null : (v === 'true' ? true : v === 'false' ? false : v);
        S.filters.crm[k] = (String(cur) === String(val)) ? null : val;   // click again to unset
        S.filters.crm.offset = 0;
      }
      go('crm'); return;
    }
    if (t.dataset.contact) { openContact(t.dataset.contact); return; }
    if (t.dataset.leadtab) {
      leadTab = t.dataset.leadtab;
      const dr = $('#drawer');
      $$('.tab', dr).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.leadtab === leadTab)));
      if (dr.__panes) { paint($('#dbody'), dr.__panes[leadTab]()); if (leadTab === 'timeline') loadTimeline(dr.__contact.id); }
      return;
    }
    if (t.dataset.bulk) { bulkAction(t.dataset.bulk, t.dataset.value); return; }
    if (t.dataset.setdisp) { setDisposition(t.dataset.setdisp); return; }
    if (t.dataset.task) { taskSet(t.dataset.task, t.dataset.status); return; }

    if (t.dataset.view) { go(t.dataset.view); return; }
    if (t.classList.contains('pal-i') && t.dataset.i != null) { palIndex = +t.dataset.i; palGo(); return; }
    if (t.dataset.tab) { drawerTab = t.dataset.tab;
      const dr = $('#drawer');
      $$('.tab', dr).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === drawerTab)));
      if (dr.__panes) paint($('#dbody'), dr.__panes[drawerTab]());
      return; }
    if (t.dataset.status) { S.filters.customers.status = t.dataset.status; S.filters.customers.offset = 0; go('customers'); return; }
    if (t.dataset.event) { S.filters.events.name = t.dataset.event; S.filters.events.offset = 0; go('events'); return; }
    if (t.dataset.account) { openAccount(t.dataset.account); return; }
    if (t.dataset.call) { openCall(t.dataset.call); return; }
    if (t.dataset.rec) { playRecording(t.dataset.rec, t); return; }
    if (t.dataset.filter) {
      const g = S.filters[t.dataset.filter]; const key = t.dataset.key; const v = t.dataset.value;
      g[key] = v === '' ? null : (v === 'true' ? true : v === 'false' ? false : v);
      g.offset = 0; go(t.dataset.filter); return;
    }
    if (t.dataset.page) {
      const g = S.filters[t.dataset.page];
      g.offset = Math.max(0, g.offset + (+t.dataset.dir) * 50); go(t.dataset.page); return;
    }
    const act = t.dataset.act;
    if (act === 'close-drawer') { closeDrawer(); return; }
    if (act === 'close-modal') { closeModal(); return; }
    if (act === 'clear-event') { S.filters.events.name = null; go('events'); return; }
    if (act === 'refund') { refundModal(t.dataset.charge, +t.dataset.max, t.dataset.label); return; }
    if (act === 'refund-go') { doRefund(t.dataset.charge, +t.dataset.max); return; }
    if (act === 'export-accounts') { exportAccounts(); return; }
    if (act === 'crm-clear-sel') { S.selected.clear(); go('crm'); return; }
    if (act === 'crm-sort') { S.filters.crm.sort = t.dataset.value; S.filters.crm.offset = 0; go('crm'); return; }
    if (act === 'crm-sel-all') {
      $$('[data-sel]').forEach((cb) => { if (t.checked) S.selected.add(cb.dataset.sel); else S.selected.delete(cb.dataset.sel); });
      go('crm'); return;
    }
    if (act === 'crm-export') { exportLeads(); return; }
    if (act === 'do-email') { emailComposer(t.dataset.contact, t.dataset.to); return; }
    if (act === 'do-sms') { smsComposer(t.dataset.contact, t.dataset.to); return; }
    if (act === 'do-call') { doCall(t.dataset.contact, t.dataset.to); return; }
    if (act === 'add-note') { addNote(t.dataset.contact); return; }
    if (act === 'add-task') { addTask(t.dataset.contact); return; }
    if (act === 'ai-draft') { aiDraft(t.dataset.contact); return; }
    if (act === 'backfill') { backfill(t); return; }
    if (act === 'status') { statusChange(t.dataset.value); return; }
  });

  // ★ Single-key shortcuts require the PAGE to own focus, not merely "not an input". Testing
  // tagName is not enough: focus can rest on body mid-repaint. Modifiers and key-repeat bail.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
    if ($('#pal').classList.contains('on')) {
      if (e.key === 'Escape') { closePal(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); palIndex = Math.min(palIndex + 1, palItems.length - 1); palPaint(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); palIndex = Math.max(palIndex - 1, 0); palPaint(); return; }
      if (e.key === 'Enter') { e.preventDefault(); palGo(); return; }
      return;
    }
    if (e.key === 'Escape') {
      if ($('#modal').classList.contains('on')) { closeModal(); return; }
      if ($('#drawer').classList.contains('on')) { closeDrawer(); return; }
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target !== document.body) return;
    const map = { g:'overview', d:'crm', c:'customers', l:'calls', u:'usage', b:'billing', p:'parley',
      e:'events', k:'compliance', a:'audit', s:'system' };
    if (map[e.key]) { e.preventDefault(); go(map[e.key]); }
  });

  let qt;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      S.q = e.target.value.trim();
      if (S.view !== 'customers' && S.view !== 'calls') { S.filters.customers.offset = 0; go('customers'); }
      else { S.filters[S.view].offset = 0; go(S.view, { quiet: true }); }
    }, 280);
  });

  $('#scrim').addEventListener('click', closeDrawer);
  $('#pal').addEventListener('click', (e) => { if (e.target.id === 'pal') closePal(); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#pal-q').addEventListener('input', (e) => palSearch(e.target.value));
  $('#signout').addEventListener('click', async () => {
    try { await api('../../admin/logout', { body: {} }); } catch (e) { /* leaving anyway */ }
    location.href = '/admin';
  });
  window.addEventListener('hashchange', () => {
    const v = location.hash.replace('#', '');
    if (v && v !== S.view) go(v);
  });
}

async function openCall(sid) {
  if (!sid) return;
  const dr = $('#drawer');
  dr.classList.add('on'); dr.setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('on');
  dr.innerHTML = '<div class="drawer-h"><div class="skel" style="width:40%;flex:1"></div>' +
    '<button class="btn ghost sm" data-act="close-drawer">Close</button></div><div class="drawer-b"></div>';
  let d;
  try { d = await api('call?sid=' + encodeURIComponent(sid)); }
  catch (e) { paint($('.drawer-b', dr), errState('Could not load that call', e.message)); return; }
  const c = d.call || {};
  dr.innerHTML = '<div class="drawer-h"><div style="flex:1;min-width:0">' +
    '<h2 style="font-size:17px;font-weight:650">' + esc(phone(c.from_number)) + ' → ' + esc(phone(c.to_number)) + '</h2>' +
    '<div class="muted mono" style="font-size:12.5px;margin-top:4px">' + esc(c.call_sid || '') + ' · ' + esc(stamp(c.created_at)) + '</div>' +
    '</div><button class="btn ghost sm" data-act="close-drawer">Close</button></div>' +
    '<div class="drawer-b">' +
      '<div class="card"><dl class="kv">' +
        kv('Customer', d.account ? d.account.business_name : 'unattributed') +
        kv('Direction', c.direction) + kv('Class', c.call_class || 'unclassified') +
        kv('AI spoke', c.ai_speaking === true ? 'yes' : c.ai_speaking === false ? 'no' : 'not recorded') +
        kv('AI listening', c.ai_listening === true ? 'yes' : c.ai_listening === false ? 'no' : 'not recorded') +
        kv('Disclosure', c.disclosure_verified === true
             ? 'verified on the wire'
             : c.disclosure_verified === false
               ? 'FAILED: the words did not reach the caller'
               : 'not checked. This is not the same as disclosed.') +
        kv('DNC scrubbed at dial', c.dnc_scrubbed_at_dial === true ? 'yes, against a fresh snapshot'
             : c.dnc_scrubbed_at_dial === false ? 'checked and clear'
             : 'could not answer, which the gate treats as a refusal') +
        kv('Status', c.status) + kv('Answered by', c.answered_by) +
        kv('Length', dur(c.duration_seconds)) +
        kv('Placed', c.placed ? 'yes' : 'no, refused: ' + (c.refused_reason || 'unknown')) +
        kv('Recording', c.recording_sid ? c.recording_sid : 'none') +
        kv('Summary', c.summary) + kv('Sentiment', c.sentiment) +
      '</dl>' + (c.recording_sid ? '<div style="margin-top:12px"><button class="btn ghost sm" data-rec="' +
        esc(c.recording_sid) + '">Listen to the recording</button></div>' : '') + '</div>' +
      ((d.transcript || []).length
        ? '<div class="card"><h2 style="margin-bottom:11px">Transcript</h2>' +
          d.transcript.map((t) => '<div style="margin-bottom:9px"><span class="pill">' +
            esc(t.speaker || 'unknown') + '</span> <span style="font-size:14px">' + esc(t.text) + '</span></div>').join('') +
          '</div>'
        : emptyState('No transcript', 'Nothing was transcribed for this call. That is a measured absence, not a loading state.')) +
    '</div>';
}

async function playRecording(sid, btn) {
  const holder = btn.closest('td') || btn.parentElement;
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    // The audio never comes from Twilio directly. A Twilio media URL is effectively a bearer token
    // for a customer's voice, and the moment one is pasted into a ticket it has escaped.
    const el = document.createElement('audio');
    el.controls = true; el.preload = 'none'; el.style.cssText = 'width:230px;height:34px;vertical-align:middle';
    el.src = '/api/admin/recording?sid=' + encodeURIComponent(sid);
    el.addEventListener('error', () => {
      holder.innerHTML = '<span class="pill bad" title="The recording could not be fetched">unavailable</span>';
    });
    btn.replaceWith(el);
    await api('log', { body: { action: 'recording.play', target_kind: 'recording', target_id: sid } });
    el.play().catch(() => { /* the browser may require a second gesture; the control is there */ });
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Listen'; toast('Could not play that recording: ' + e.message, 'bad');
  }
}

async function statusChange(status) {
  if (!S.drawerAccount) return;
  modal('<h3>Change this account to “' + esc(status.replace(/_/g, ' ')) + '”</h3>' +
    '<p>This is written to the audit log with your name and the reason you give.</p>' +
    '<div class="field"><label for="sreason">Reason</label>' +
    '<input class="input" id="sreason" type="text" placeholder="why this is changing"></div>' +
    '<div class="alert warn" id="swarn" style="display:none"></div>' +
    '<div class="row end"><button class="btn ghost" data-act="close-modal">Cancel</button>' +
    '<button class="btn" id="sgo">Change status</button></div>');
  $('#sgo').addEventListener('click', async () => {
    try {
      await api('account-status', { body: { id: S.drawerAccount, status, reason: $('#sreason').value || null } });
      closeModal(); toast('Status changed to ' + status.replace(/_/g, ' '), 'ok'); openAccount(S.drawerAccount);
    } catch (e) { $('#swarn').textContent = e.message; $('#swarn').style.display = 'block'; }
  });
}

async function backfill(btn) {
  btn.disabled = true; btn.textContent = 'Repairing…';
  try {
    const r = await api('attribute-backfill', { body: {} });
    toast('Attributed ' + r.attributed + ' calls. ' + r.remaining_unattributed +
      ' remain unattributed, which is correct for research, demo and canary traffic.', 'ok');
    go('overview');
  } catch (e) { toast(e.message, 'bad'); btn.disabled = false; btn.textContent = 'Repair attribution'; }
}

// ── CRM actions ──────────────────────────────────────────────────────────────────────────────

async function refreshContact() {
  if (S.drawerContact) await openContact(S.drawerContact);
}

async function bulkAction(action, value) {
  const ids = Array.from(S.selected);
  if (!ids.length) return;
  const label = { disposition: 'set the stage to ' + value, tag_add: 'tag as ' + value,
                  suppress: 'mark NEVER CONTACT' }[action] || action;
  modal('<h3>' + esc(label) + '</h3>' +
    '<p>This applies to <strong>' + n(ids.length) + '</strong> selected lead' + (ids.length === 1 ? '' : 's') + '. ' +
    (action === 'suppress'
      ? 'Suppression is permanent and covers every channel. It also writes the durable suppression ledger the dial gate reads, so nothing can call them again.'
      : 'Rows that already have this value are left alone and reported as unchanged.') + '</p>' +
    '<div class="alert warn" id="bwarn" style="display:none"></div>' +
    '<div class="row end"><button class="btn ghost" data-act="close-modal">Cancel</button>' +
    '<button class="btn' + (action === 'suppress' ? ' danger' : '') + '" id="bgo">Apply to ' + n(ids.length) + '</button></div>');
  $('#bgo').addEventListener('click', async () => {
    const b = $('#bgo'); b.disabled = true; b.textContent = 'Applying…';
    try {
      const r = await api('crm/bulk', { body: { ids, action, value } });
      closeModal(); S.selected.clear();
      toast(r.changed + ' changed, ' + r.unchanged + ' already had that value.', 'ok');
      go('crm');
    } catch (e) { b.disabled = false; b.textContent = 'Apply'; $('#bwarn').textContent = e.message; $('#bwarn').style.display = 'block'; }
  });
}

async function setDisposition(d) {
  if (!S.drawerContact) return;
  try { await api('crm/update', { body: { id: S.drawerContact, patch: { disposition: d } } });
    toast('Stage set to ' + d.replace(/_/g, ' '), 'ok'); refreshContact(); }
  catch (e) { toast(e.message, 'bad'); }
}

async function addNote(contactId) {
  const el = $('#notebody'); const body = el ? el.value.trim() : '';
  if (!body) { toast('An empty note helps nobody.', 'bad'); return; }
  try { await api('crm/note', { body: { contact_id: contactId, body } });
    toast('Note saved', 'ok'); refreshContact(); }
  catch (e) { toast(e.message, 'bad'); }
}

async function addTask(contactId) {
  const el = $('#tasktitle'); const title = el ? el.value.trim() : '';
  if (!title) { toast('A task needs a title.', 'bad'); return; }
  try { await api('crm/task', { body: { contact_id: contactId, title } });
    toast('Task added', 'ok'); refreshContact(); }
  catch (e) { toast(e.message, 'bad'); }
}

async function taskSet(id, status) {
  try { await api('crm/task', { body: { id, status } }); toast('Task ' + status, 'ok'); refreshContact(); }
  catch (e) { toast(e.message, 'bad'); }
}

// ── the composers ────────────────────────────────────────────────────────────────────────────

function emailComposer(contactId, to) {
  modal('<h3>Email this business</h3>' +
    '<p>Sending to <strong>' + esc(to) + '</strong>. It goes out from our real sending domain and is ' +
    'logged against this record.</p>' +
    '<div class="field"><label for="esubj">Subject</label><input class="input" id="esubj"></div>' +
    '<div class="field"><label for="ebody">Message</label>' +
      '<textarea class="input" id="ebody" rows="9"></textarea></div>' +
    '<div id="edraftnote" class="tile-s" style="display:none;margin:-6px 0 12px"></div>' +
    '<div class="alert warn" id="ewarn" style="display:none"></div>' +
    '<div class="row"><button class="btn ghost" data-act="ai-draft" data-contact="' + esc(contactId) + '">Draft it with AI</button>' +
      '<span class="sp" style="margin-left:auto"></span>' +
      '<button class="btn ghost" data-act="close-modal">Cancel</button>' +
      '<button class="btn" id="esend" data-to="' + esc(to) + '" data-contact="' + esc(contactId) + '">Send</button></div>');
  $('#esend').addEventListener('click', async () => {
    const subject = $('#esubj').value.trim(), body = $('#ebody').value.trim();
    if (!subject || !body) { $('#ewarn').textContent = 'A subject and a message are both required.'; $('#ewarn').style.display = 'block'; return; }
    const b = $('#esend'); b.disabled = true; b.textContent = 'Sending…';
    try {
      const r = await api('crm/email', { body: { contact_id: contactId, to, subject, body,
        ai_assisted: Boolean(window.__lastDraftModel), ai_model: window.__lastDraftModel || null } });
      closeModal(); window.__lastDraftModel = null;
      toast(r.ok ? 'Email sent and logged against this lead.' : ('Not sent: ' + (r.reason || r.error)), r.ok ? 'ok' : 'bad');
      refreshContact();
    } catch (e) { b.disabled = false; b.textContent = 'Send'; $('#ewarn').textContent = e.message; $('#ewarn').style.display = 'block'; }
  });
  setTimeout(() => $('#esubj') && $('#esubj').focus(), 30);
}

/**
 * ★ THE AI WRITES A DRAFT INTO A BOX A HUMAN THEN EDITS AND SENDS. It never sends anything.
 * It is also required to report what it could NOT say, and that report is shown to the operator
 * rather than hidden, because the useful part of an honest drafting tool is the list of things it
 * refused to invent.
 */
async function aiDraft(contactId) {
  const btn = $('[data-act="ai-draft"]'); if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; }
  try {
    const r = await api('crm/draft', { body: { contact_id: contactId, intent: 'a first, brief outreach email' } });
    $('#esubj').value = r.draft.subject;
    $('#ebody').value = r.draft.body;
    window.__lastDraftModel = r.ai.model;
    const note = $('#edraftnote');
    note.style.display = 'block';
    note.innerHTML = '<strong>Drafted by ' + esc(r.ai.model) + '</strong> · ' +
      n(r.ai.usage.input_tokens) + ' in / ' + n(r.ai.usage.output_tokens) + ' out · about $' +
      (r.ai.cost_usd || 0).toFixed(4) + ' <span class="muted">(cost ESTIMATED from a local rate table; the token counts are measured)</span>' +
      ((r.draft.could_not_say || []).length
        ? '<br><span class="muted">It had no fact for: ' + esc(r.draft.could_not_say.join('; ')) + '</span>' : '') +
      '<br><span class="muted">Read it before you send it. Nothing is sent automatically.</span>';
  } catch (e) {
    $('#ewarn').textContent = 'The draft failed: ' + e.message; $('#ewarn').style.display = 'block';
  } finally { if (btn) { btn.disabled = false; btn.textContent = 'Draft it with AI'; } }
}

function smsComposer(contactId, to) {
  modal('<h3>Text this business</h3>' +
    '<p>Sending to <strong>' + esc(phone(to)) + '</strong>.</p>' +
    '<div class="field"><label for="sbody">Message</label><textarea class="input" id="sbody" rows="4" maxlength="450"></textarea></div>' +
    '<div class="alert warn" id="swarn2" style="display:none"></div>' +
    '<div class="row end"><button class="btn ghost" data-act="close-modal">Cancel</button>' +
    '<button class="btn" id="ssend">Send text</button></div>');
  $('#ssend').addEventListener('click', async () => {
    const body = $('#sbody').value.trim();
    if (!body) return;
    const b = $('#ssend'); b.disabled = true; b.textContent = 'Sending…';
    try {
      const r = await api('crm/sms', { body: { contact_id: contactId, to, body } });
      closeModal();
      toast(r.ok ? 'Text sent and logged.' : ('Not sent: ' + (r.reason || r.error)), r.ok ? 'ok' : 'bad');
      refreshContact();
    } catch (e) { b.disabled = false; b.textContent = 'Send text'; $('#swarn2').textContent = e.message; $('#swarn2').style.display = 'block'; }
  });
}

async function doCall(contactId, to) {
  try {
    const r = await api('crm/call', { body: { contact_id: contactId, to } });
    if (r.ok) {
      toast('Call intent recorded as ' + r.class + '. ' + r.note, 'ok');
    } else {
      toast('Not callable: ' + r.reason, 'bad');
    }
    refreshContact();
  } catch (e) { toast(e.message, 'bad'); }
}

async function exportLeads() {
  try {
    const f = S.filters.crm;
    const qs = new URLSearchParams({ q: S.q || '', sort: f.sort, limit: 200, offset: 0 });
    for (const k of ['lane','disposition','state','trade','line_type']) if (f[k]) qs.set(k, f[k]);
    if (f.dialable != null) qs.set('dialable', String(f.dialable));
    if (f.has_email != null) qs.set('has_email', String(f.has_email));
    const d = await api('crm?' + qs);
    const cols = ['id','name','phone','line_type','ai_dialable','trade','city','state','website',
                  'email','contact_name','disposition','lane','call_count','last_contacted_at'];
    const csv = [cols.join(',')].concat(d.rows.map((r) => cols.map((c) => {
      const v = r[c] == null ? '' : String(r[c]);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'answered-leads-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click(); URL.revokeObjectURL(a.href);
    toast('Exported ' + d.rows.length + ' of ' + n(d.total) + ' matching leads.' +
      (d.total > d.rows.length ? ' The export is capped at 200 rows and says so rather than truncating silently.' : ''), 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

async function exportAccounts() {
  try {
    const d = await api('accounts?' + new URLSearchParams({ q: S.q || '', limit: 200, offset: 0, sort: 'recent' }));
    const cols = ['id','business_name','owner_email','owner_name','owner_phone','trade','status',
      'phone','calls','recordings','charged_cents','credit_cents','created_at'];
    const csv = [cols.join(',')].concat(d.rows.map((r) => cols.map((c) => {
      const v = r[c] == null ? '' : String(r[c]);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'answered-customers-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click(); URL.revokeObjectURL(a.href);
    toast('Exported ' + d.rows.length + ' of ' + d.total + ' customers.' +
      (d.total > d.rows.length ? ' The export is capped at 200 rows and it says so rather than silently truncating.' : ''), 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

function boot() {
  wire();
  const v = location.hash.replace('#', '') || 'overview';
  go(v);
  // A gentle refresh that respects focus. paint() refuses to replace a region owning focus, so a
  // half-typed filter is never wiped by a tick.
  setInterval(() => {
    if (document.hidden) return;
    if ($('#modal').classList.contains('on') || $('#pal').classList.contains('on')) return;
    if ($('#drawer').classList.contains('on')) return;
    go(S.view, { quiet: true });
  }, 45000);
}

return { boot };
})();
`;

// ── a truncation guard, because this failed silently once ────────────────────────────────────
// APP_JS is a String.raw template. A single stray backtick anywhere inside it ends the literal
// early, and the failure is not always a parse error: it can produce a SHORTER but perfectly
// valid string, which ships a half-written application that throws in the browser instead of on
// the server. It happened here (a backtick inside a code comment) and the only reason it was
// caught is that this particular truncation did not parse.
//
// So the module refuses to load unless the script it is about to serve actually reaches its own
// last line. A console that fails at import is an outage. A console that serves a truncated
// script is an outage that looks fine from the outside, which is worse.
if (!/return \{ boot \};\s*\}\)\(\);\s*$/.test(APP_JS)) {
  throw new Error(
    'admin-ui: APP_JS is truncated. It does not end with its own closing lines, which means a ' +
    'stray backtick closed the template literal early. Length is ' + APP_JS.length + ' chars.');
}
