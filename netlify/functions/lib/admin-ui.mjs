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
/* ── THE BRAND FACES, SELF-HOSTED ──────────────────────────────────────────────────────────
   Same-origin only. font-src 'self' adds ZERO external origins, so the page keeps the property
   that matters: it can reach nobody. Not a CDN, not a font host, not a data: URI (base64 inflates
   ~33% and would sit inside a no-store document, re-downloading on every navigation).
   The previous stack shipped Inter and Roboto, both banned by the brand law, so on every Windows
   and Android machine this console was rendering in a forbidden face. */
@font-face{font-family:"Switzer";src:url("/assets/fonts/switzer-400.woff2") format("woff2");
  font-weight:450;font-style:normal;font-display:optional}
@font-face{font-family:"Switzer";src:url("/assets/fonts/switzer-500.woff2") format("woff2");
  font-weight:500;font-style:normal;font-display:optional}
@font-face{font-family:"Switzer";src:url("/assets/fonts/switzer-700.woff2") format("woff2");
  font-weight:620 700;font-style:normal;font-display:optional}
@font-face{font-family:"Martian Mono";src:url("/assets/fonts/martian-mono-400-600.woff2") format("woff2");
  font-weight:400 600;font-style:normal;font-display:optional}

:root{
  /* In CSS, not only the meta tag, so UA scrollbars, autofill and pickers follow. */
  color-scheme: dark;

  /* ground ramp — five real elevations, none decorative */
  --bg:#08090B; --surface:#0E1013; --raised:#151920; --raised-2:#1C212A; --raised-3:#222834;

  /* ink ramp — MEASURED against all five grounds, not eyeballed */
  --ink:#F5F7FA;    /* 18.56 17.75 16.42 15.05 13.77 */
  --ink-2:#CDD4DE;  /* 13.34 12.76 11.80 10.82  9.90  — was #AAB3BF, which topped out at 9.40 */
  --ink-3:#949DAA;  /*  7.27  6.95  6.43  5.89  5.39  — was #8B94A1, whose FLOOR was 4.82: a FAIL */
  --ink-4:#6B7482;  /*  4.22  4.03  3.73  3.42  3.13  — DISABLED CONTROLS ONLY. WCAG 1.4.3
                          exempts inactive components. Never for live text. */

  /* lines — the third exists solely because WCAG 1.4.11 wants 3:1 for non-text UI */
  --line:#232830;   /* 1.29:1 decorative hairline. NEVER the sole indicator of a state. */
  --line-2:#333A45; /* 1.66:1 emphasised edge. Still decorative. */
  --line-3:#606B7B; /* 3.53 on surface. THE ONLY border allowed to BE a control: unchecked
                       checkbox, radio, resize grip, segmented divider, chip outline. */

  /* brand + semantics */
  --brand:#E3FF4F;      /* the brand Hi-Vis exactly. 16.95:1 on surface. The console was on
                           #DFFF4F: dE2000 0.75, below the 2.0 JND, so this swap is invisible
                           on screen and makes the console token-identical to the brand. */
  --brand-ink:#0A0C05;  /* 17.50:1 on --brand. The only ink allowed on a brand fill. */
  --brand-dim:rgba(227,255,79,.10);
  --ok:#4ADE80;   --ok-bg:#0C1F15;   /* 10.93 — LIFECYCLE only: live, settled, verified */
  --warn:#FBBF24; --warn-bg:#221A08; /* 11.41 */
  --bad:#FF5C7A;  --bad-bg:#251016;  /*  6.41 on surface */
  --bad-2:#FF7A93;                   /*  7.67 — use inside pills on the lightest ground */
  --info:#56CCF2; --info-bg:#0A1C24; /* 10.27 */
  --live:#37C8F0;                    /* RESERVED: a call is on the wire RIGHT NOW. One meaning. */
  --ai:#B08CFF;   --ai-bg:#160F26;   /* AI provenance. Used nowhere else, ever. */

  /* type */
  --sans:"Switzer",system-ui,-apple-system,"Segoe UI Variable Text","Segoe UI",Helvetica,Arial,sans-serif;
  --mono:"Martian Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --t-micro:11px;  --lh-micro:14px;  --ls-micro:.06em;
  --t-mini:12px;   --lh-mini:16px;   --ls-mini:0;
  --t-small:13px;  --lh-small:18px;  --ls-small:-.006em;
  --t-base:14px;   --lh-base:20px;   --ls-base:-.011em;
  --t-lg:16px;     --lh-lg:22px;     --ls-lg:-.014em;
  --t-xl:20px;     --lh-xl:26px;     --ls-xl:-.018em;
  --t-num:24px;    --lh-num:26px;    --ls-num:-.02em;
  --t-num-lg:32px; --lh-num-lg:34px; --ls-num-lg:-.022em;
  /* three weights, not six: 640/650/660 measured a 0.23% width spread on the same string */
  --w-body:450; --w-med:500; --w-semi:620;

  /* geometry */
  --row-h:36px; --row-h-compact:32px; --row-h-comfy:44px;
  --topbar-h:52px; --side-w:212px;
  --r-lg:12px; --r:8px; --r-sm:6px; --r-xs:4px;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px;

  --shadow-pop:0 4px 12px -2px rgba(0,0,0,.6), inset 0 1px 0 0 rgba(255,255,255,.03);
  --shadow-modal:0 24px 64px -16px rgba(0,0,0,.8), inset 0 1px 0 0 rgba(255,255,255,.04);

  --ease:cubic-bezier(.2,.8,.2,1); --ease-out:cubic-bezier(.16,1,.3,1);
  --d-fast:100ms; --d-base:160ms; --d-slow:220ms;

  --z-sticky:10; --z-topbar:20; --z-scrim:60; --z-drawer:61; --z-modal:70;
  --z-popover:80; --z-toast:90; --z-tooltip:100;

  /* legacy aliases, so nothing that already shipped breaks while the rest migrates */
  --r-sm-legacy:7px; --sp:4px;
}

/* the fixes that are not tokens but ship with them */
::placeholder{color:var(--ink-3);opacity:1}
  /* the UA default was rgb(117,117,117) = 3.82:1, a fail. This is 6.43:1 on --raised. */
.num,.tile-v,time,[data-num],td.num,th.num{
  font-variant-numeric:tabular-nums lining-nums slashed-zero;
  font-feature-settings:"tnum" 1,"zero" 1}
  /* a slashed zero is not decoration: operators read E.164 numbers and call SIDs, and
     O-versus-0 confusion is a support cost */
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

/* TOKENS-END */
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


/* ── the filter bar: real controls ────────────────────────────────────────────────────────── */
.filterbar{display:flex;flex-wrap:wrap;gap:var(--sp-2);align-items:center;
  padding:var(--sp-3) var(--sp-4);background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r);position:sticky;top:calc(var(--topbar-h) + 8px);z-index:var(--z-sticky)}
.fx{position:relative;display:inline-flex;align-items:center}
.fx > label{position:absolute;left:10px;top:-7px;font-size:10px;font-weight:var(--w-semi);
  letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);background:var(--surface);
  padding:0 4px;pointer-events:none;border-radius:2px}
select.fsel{appearance:none;-webkit-appearance:none;background:var(--raised);color:var(--ink);
  border:1px solid var(--line-3);border-radius:var(--r-sm);
  padding:8px 30px 8px 11px;font-size:var(--t-small);line-height:var(--lh-small);
  font-family:var(--sans);cursor:pointer;min-width:132px;
  transition:border-color var(--d-fast) var(--ease),background var(--d-fast) var(--ease)}
select.fsel:hover{border-color:var(--ink-3);background:var(--raised-2)}
select.fsel:focus-visible{outline:2px solid var(--brand);outline-offset:1px;border-color:var(--brand)}
select.fsel[data-on="1"]{border-color:var(--brand);color:var(--brand);background:var(--brand-dim)}
.fx::after{content:"";position:absolute;right:11px;top:50%;width:0;height:0;pointer-events:none;
  border-left:4px solid transparent;border-right:4px solid transparent;
  border-top:5px solid var(--ink-3);transform:translateY(-2px)}
.fx:hover::after{border-top-color:var(--ink)}
.fsearch{flex:1 1 260px;min-width:200px;position:relative}
.fsearch input{width:100%;background:var(--raised);border:1px solid var(--line-3);
  border-radius:var(--r-sm);padding:8px 12px 8px 32px;font-size:var(--t-small);
  color:var(--ink);font-family:var(--sans)}
.fsearch input:focus{outline:none;border-color:var(--brand);background:var(--raised-2)}
.fsearch::before{content:"⌕";position:absolute;left:11px;top:50%;transform:translateY(-50%);
  color:var(--ink-3);font-size:15px;pointer-events:none}
.fcount{margin-left:auto;display:flex;align-items:center;gap:var(--sp-2);white-space:nowrap}
.fcount b{font-size:var(--t-lg);font-weight:var(--w-semi);letter-spacing:var(--ls-lg);
  font-variant-numeric:tabular-nums}
.activef{display:flex;flex-wrap:wrap;gap:6px;padding:0 var(--sp-4) var(--sp-3)}
.afx{display:inline-flex;align-items:center;gap:6px;font-size:var(--t-mini);
  background:var(--brand-dim);border:1px solid rgba(227,255,79,.35);color:var(--brand);
  border-radius:100px;padding:3px 5px 3px 10px}
.afx button{background:none;border:none;color:inherit;cursor:pointer;font-size:14px;
  line-height:1;padding:0 3px;opacity:.75}
.afx button:hover{opacity:1}

/* ── reach indicators: one glyph per channel, colour-blind safe by shape ─────────────────── */
.reach{display:inline-flex;gap:4px;align-items:center}
.rch{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:var(--r-xs);
  font-size:11px;font-weight:var(--w-semi);border:1px solid var(--line-2);color:var(--ink-3);
  background:var(--raised);cursor:default}
.rch.on{color:var(--brand-ink);background:var(--brand);border-color:var(--brand)}
.rch.blocked{color:var(--ink-3);background:transparent;border-style:dashed}
.rch.wait{color:var(--warn);border-color:rgba(251,191,36,.45);background:var(--warn-bg)}

/* ── density ──────────────────────────────────────────────────────────────────────────────── */
table.dense td{padding:6px 12px;font-size:var(--t-small)}
table.dense th{padding:7px 12px}


/* ══ THE COCKPIT ═══════════════════════════════════════════════════════════════════════════
   David: "like a world class video game / fighter jet / phone interface ... incredible visual
   and user interface ... very operator/user friendly."

   The model is an AIRCRAFT MASTER CAUTION PANEL, and that is a deliberate choice rather than a
   theme. A real cockpit is trustworthy BECAUSE it is loud and specific about what is inoperative.
   Every lamp here is wired to a measurement and carries the sentence that explains it. Nothing
   animates unless real data is moving: no decorative waveform, no idle pulse on a dead channel,
   no LIVE lamp without a call actually on the wire.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
.ckpt{display:grid;gap:var(--sp-3);grid-template-columns:minmax(0,1fr) 344px;align-items:start}
.ckpt-full{grid-column:1/-1}
@media (max-width:1180px){.ckpt{grid-template-columns:minmax(0,1fr)}}

/* the instrument shell: a hairline bezel and a very slight inner light, so panels read as
   machined objects rather than as flat divs */
.inst{background:linear-gradient(180deg,var(--raised) 0%,var(--surface) 100%);
  border:1px solid var(--line-2);border-radius:var(--r);position:relative;overflow:hidden;
  box-shadow:inset 0 1px 0 0 rgba(255,255,255,.045), 0 1px 2px rgba(0,0,0,.5)}
.inst-h{display:flex;align-items:center;gap:var(--sp-2);padding:9px 13px;
  border-bottom:1px solid var(--line);background:rgba(0,0,0,.25)}
.inst-h h3{font-size:var(--t-micro);font-weight:var(--w-semi);letter-spacing:var(--ls-micro);
  text-transform:uppercase;color:var(--ink-3);margin:0}
.inst-h .sp{margin-left:auto;display:flex;gap:var(--sp-2);align-items:center}
.inst-b{padding:var(--sp-3) var(--sp-3)}

/* ── the lamp. Four states, distinguished by SHAPE and LABEL as well as colour. ───────────── */
/* Eight lamps. auto-fit gave seven across at 1600 and left the eighth alone beside a dead gap,
   which reads as a missing instrument rather than as a designed panel. Fixed counts instead, so
   every row is full at every breakpoint: 4x2, 3x3, 2x4, 1x8. */
.lamps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line)}
@media (max-width:1280px){.lamps{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:900px){.lamps{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.lamps{grid-template-columns:1fr}}
.lamp{background:var(--surface);padding:11px 13px;display:flex;flex-direction:column;gap:5px;
  min-height:84px;position:relative}
.lamp-t{display:flex;align-items:center;gap:7px}
.lamp-d{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:var(--ink-4);
  box-shadow:0 0 0 3px rgba(255,255,255,.03)}
.lamp-k{font-size:var(--t-micro);font-weight:var(--w-semi);letter-spacing:var(--ls-micro);
  text-transform:uppercase;color:var(--ink-3)}
.lamp-v{font-size:var(--t-base);font-weight:var(--w-semi);letter-spacing:var(--ls-base);color:var(--ink-2)}
.lamp-w{font-size:var(--t-mini);line-height:1.45;color:var(--ink-3)}
.lamp.go   .lamp-d{background:var(--ok);box-shadow:0 0 0 3px rgba(74,222,128,.14),0 0 12px rgba(74,222,128,.35)}
.lamp.go   .lamp-v{color:var(--ok)}
.lamp.caution .lamp-d{background:var(--warn);box-shadow:0 0 0 3px rgba(251,191,36,.14)}
.lamp.caution .lamp-v{color:var(--warn)}
.lamp.caution{background:linear-gradient(180deg,var(--warn-bg) 0%,var(--surface) 70%)}
.lamp.stop .lamp-d{background:var(--bad);box-shadow:0 0 0 3px rgba(255,92,122,.16)}
.lamp.stop .lamp-v{color:var(--bad-2)}
.lamp.stop{background:linear-gradient(180deg,var(--bad-bg) 0%,var(--surface) 70%)}
/* LIVE is the only lamp permitted to pulse, and only while a call is genuinely on the wire. */
.lamp.live .lamp-d{background:var(--live);animation:lampPulse 1.4s var(--ease) infinite}
.lamp.live .lamp-v{color:var(--live)}
@keyframes lampPulse{
  0%,100%{box-shadow:0 0 0 3px rgba(55,200,240,.20),0 0 10px rgba(55,200,240,.45)}
  50%{box-shadow:0 0 0 6px rgba(55,200,240,.06),0 0 20px rgba(55,200,240,.75)}}

/* ── the line bank. David: "turn on multiple phone lines up to 100+ if we wanted." ───────── */
.bank{display:grid;grid-template-columns:repeat(auto-fill,minmax(206px,1fr));gap:var(--sp-2)}
.ln{border:1px solid var(--line-2);border-radius:var(--r-sm);padding:10px 11px;
  background:var(--surface);position:relative;overflow:hidden}
.ln.act{border-color:rgba(74,222,128,.34)}
.ln.rest{opacity:.62;border-style:dashed}
.ln.flag{border-color:var(--bad)}
.ln-n{font-family:var(--mono);font-size:var(--t-small);color:var(--ink);letter-spacing:-.02em}
.ln-l{font-size:var(--t-mini);color:var(--ink-3);margin-top:2px;line-height:1.35;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ln-m{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:var(--t-micro);
  color:var(--ink-3);letter-spacing:var(--ls-micro);text-transform:uppercase}
/* the capacity bar is driven by calls_today/daily_cap, a real number, never a decoration */
.ln-bar{height:3px;border-radius:2px;background:var(--raised-3);margin-top:8px;overflow:hidden}
.ln-bar i{display:block;height:100%;background:var(--brand);
  transition:width var(--d-slow) var(--ease)}
.ln-add{border:1px dashed var(--line-3);border-radius:var(--r-sm);display:grid;place-items:center;
  min-height:92px;color:var(--ink-3);font-size:var(--t-small);cursor:default;text-align:center;
  padding:10px}

/* ── the flight strip ─────────────────────────────────────────────────────────────────────── */
.strip{display:flex;flex-direction:column}
.fs{display:grid;grid-template-columns:70px 1fr auto;gap:10px;align-items:center;
  padding:8px 13px;border-bottom:1px solid var(--line);font-size:var(--t-small);cursor:pointer;
  transition:background var(--d-fast) var(--ease)}
.fs:hover{background:var(--raised)}
.fs:last-child{border-bottom:none}
.fs-t{font-family:var(--mono);font-size:var(--t-mini);color:var(--ink-3)}
.fs-w{min-width:0}
.fs-w b{display:block;font-weight:var(--w-med);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-w span{font-size:var(--t-mini);color:var(--ink-3)}
.fs-r{display:flex;gap:5px;align-items:center;white-space:nowrap}

/* ── the wire: the live-call region ───────────────────────────────────────────────────────── */
.wire{min-height:186px;display:grid;place-items:center;padding:var(--sp-5) var(--sp-4);
  text-align:center;position:relative}
/* An idle wire is a calm band, not a cavern. It was measured at 520px tall next to a long target
   panel and read as a hole in the page rather than as a resting instrument. */
.wire-idle{padding:var(--sp-2) 0}
.wire-idle{max-width:46ch}
.wire-idle .big{font-size:var(--t-lg);font-weight:var(--w-semi);color:var(--ink-2);margin-bottom:7px}
.wire-idle .sm{font-size:var(--t-small);line-height:1.6;color:var(--ink-3)}
/* the horizon: a single flat trace when nothing is on the wire. It does NOT move, because
   nothing is moving. A scrolling line with no audio behind it would be a lie drawn at 60fps. */
.horizon{width:100%;max-width:520px;height:1px;background:linear-gradient(90deg,
  transparent 0%, var(--line-3) 18%, var(--line-3) 82%, transparent 100%);margin:0 0 18px}
.wire.dead .wire-idle .big{color:var(--bad-2)}

/* ── the queue ─────────────────────────────────────────────────────────────────────────────── */
.q{display:flex;flex-direction:column;max-height:520px;overflow-y:auto}
.qr{display:grid;grid-template-columns:22px 1fr auto;gap:9px;align-items:center;padding:9px 13px;
  border-bottom:1px solid var(--line);cursor:pointer;transition:background var(--d-fast) var(--ease)}
.qr:hover{background:var(--raised)}
.qr[aria-current="true"]{background:var(--brand-dim);
  box-shadow:inset 3px 0 0 0 var(--brand)}
.qr-i{font-family:var(--mono);font-size:var(--t-micro);color:var(--ink-3);text-align:right}
.qr-w{min-width:0}
.qr-w b{display:block;font-size:var(--t-small);font-weight:var(--w-med);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qr-w span{font-size:var(--t-mini);color:var(--ink-3)}

/* ── the channel bay: three arming switches ────────────────────────────────────────────────── */
/* ★ The bay lives in a 344px rail, and three columns there gave each switch about 100px, which
   wrapped its reason to one character per line. Measured on a screenshot, not guessed. Switches
   stack vertically wherever they are narrow and only go side by side when there is genuinely room
   for the sentence, because the sentence is the point of the control. */
.bay{display:grid;grid-template-columns:1fr;gap:var(--sp-2)}
@media (min-width:1500px){ .ckpt-wide .bay{grid-template-columns:repeat(3,1fr)} }
.sw-w{overflow-wrap:anywhere}
.sw{border:1px solid var(--line-2);border-radius:var(--r-sm);padding:12px 11px;text-align:left;
  background:var(--surface);cursor:pointer;position:relative;overflow:hidden;
  transition:border-color var(--d-fast) var(--ease),transform var(--d-fast) var(--ease)}
.sw:hover:not(:disabled){border-color:var(--ink-3);transform:translateY(-1px)}
.sw:active:not(:disabled){transform:translateY(0)}
.sw-k{display:flex;align-items:center;gap:7px;font-size:var(--t-micro);font-weight:var(--w-semi);
  letter-spacing:var(--ls-micro);text-transform:uppercase;color:var(--ink-3)}
.sw-v{font-size:var(--t-base);font-weight:var(--w-semi);margin-top:6px;color:var(--ink-2)}
.sw-w{font-size:var(--t-mini);line-height:1.45;color:var(--ink-3);margin-top:5px}
.sw.armed{border-color:var(--brand);background:linear-gradient(180deg,var(--brand-dim) 0%,var(--surface) 72%)}
.sw.armed .sw-v{color:var(--brand)}
/* A DISARMED SWITCH IS PHYSICALLY DIFFERENT, not merely a different colour: it is dashed, it is
   dimmed, its cursor says not-allowed, and it carries the reason. Colour alone would fail a
   colour-blind operator and would fail a screenshot. */
.sw:disabled{cursor:not-allowed;border-style:dashed;opacity:.72}
.sw:disabled .sw-v{color:var(--ink-4)}

/* the hangar: what the whole cockpit looks like when every channel is down. Darkened and calm
   with one clear caution, which reads as competence. A page that looks broken reads as a broken
   product. */
.hangar{border:1px solid var(--warn);background:linear-gradient(180deg,var(--warn-bg) 0%,var(--surface) 60%);
  border-radius:var(--r);padding:var(--sp-4)}
@media (prefers-reduced-motion:reduce){
  .lamp.live .lamp-d{animation:none;
    box-shadow:0 0 0 4px rgba(55,200,240,.18),0 0 14px rgba(55,200,240,.5)}
  .ln-bar i{transition:none}
}

/* A stranger's transcribed words, set apart from our own sentence. The quotation marks are the
   point: an operator must never read a caller's instruction as our compliance determination. */
.heard{quotes:'\u201C' '\u201D';font-style:italic;color:var(--ink-2)}
.heard::before{content:open-quote}
.heard::after{content:close-quote}

/* ── the call summary ─────────────────────────────────────────────────────
   A quote is the part of a summary that reads as evidence, so it is set apart from the model's own
   prose rather than blended into it. The left rule is the whole point: the reader can see at a
   glance which words are the caller's and which are the machine's. */
.sumbox{border-left:2px solid var(--ai);padding-left:12px}
.quote{margin:7px 0 0;padding:7px 10px;border-left:2px solid var(--line-2);background:var(--bg);
  border-radius:0 8px 8px 0;font-size:13.5px;line-height:var(--lh-base);overflow-wrap:anywhere}

/* ── the conversation ──────────────────────────────────────────────────────
   A thread, not a table. Outbound sits right and inbound sits left, which is the convention every
   messaging app has trained every operator on for fifteen years; fighting it would cost a beat of
   reading time on every single message.
   A BLOCKED SEND IS RENDERED, NOT HIDDEN, and it is styled as its own third thing rather than as a
   red outbound bubble, because "we chose not to send this" is a different event from "we sent this
   and it went badly". The hatch survives greyscale and colour-blindness, so the distinction does
   not rest on hue alone. */
.thread{display:flex;flex-direction:column;gap:10px;padding:14px 16px;max-height:min(46vh,420px);
  overflow-y:auto;overscroll-behavior:contain}
.bub{max-width:min(86%,560px);border:1px solid var(--line);border-radius:12px;padding:9px 11px;
  background:var(--surface)}
.bub-out{align-self:flex-end;border-color:var(--line-2);background:var(--info-bg)}
.bub-in{align-self:flex-start}
.bub-bad{align-self:flex-end;border-color:var(--bad);background:var(--bad-bg);
  background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.045) 0 4px,transparent 4px 8px)}
.bub-h{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;margin-bottom:5px}
.bub-s{font-weight:650;font-size:13px;margin-bottom:3px}
.bub-t{font-size:13.5px;line-height:var(--lh-base);white-space:pre-wrap;overflow-wrap:anywhere}
.bub-f{margin-top:6px;padding-top:6px;border-top:1px solid var(--line);font-size:11.5px;
  color:var(--bad-2)}
.composer{border-top:1px solid var(--line);padding:12px 16px;background:var(--bg)}
/* A channel that cannot send is not hidden and not merely dimmed: it keeps its full hit area and
   its tooltip carries the gate's own sentence, so the operator learns WHY rather than that
   something is broken. */
.composer .btn[data-blocked]{opacity:.72;border-style:dashed}
@media (max-width:640px){ .bub{max-width:94%} .thread{max-height:52vh} }

/* CONSOLE-CSS-END */
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

    <div class="nav-h">Flight deck</div>
    <button class="nav" data-view="cockpit" aria-current="page"><span class="nav-ico">✈</span>Cockpit</button>
    <button class="nav" data-view="ask"><span class="nav-ico">?</span>Ask</button>
    <button class="nav" data-view="deliveries"><span class="nav-ico">⇉</span>Deliveries<span class="nav-n" data-count="dead"></span></button>

    <div class="nav-h">Business</div>
    <button class="nav" data-view="overview"><span class="nav-ico">◎</span>Overview</button>
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
// ★ THIRD VERSION, AND THE SECOND ONE WAS STILL WRONG — MEASURED ON LIVE PROD.
//
// Refusing the paint protects the caret, but the CRM search box LIVES INSIDE the region its own
// results render into. So typing a query fired the request, the rows came back, and the guard then
// refused the only paint that would have shown them. Measured on prod, character by character:
//
//   request  GET /api/admin/crm?q=zzqqxx-no-such-lead-9917...  -> fired, 200, real result
//   DOM      50 rows, unchanged, for as long as the caret stayed in the box
//   blur     still 50 rows: nothing re-runs on blur, so the refusal was permanent
//   navigate away and back -> 0 rows and the correct empty state, which had been true all along
//
// The operator's experience is a search box that does nothing. No error, no console message, a
// perfect 200 in the network panel, and the correct answer sitting in memory behind a guard written
// to help them. This is the same shape as the version before it: a control whose click is a request
// for a repaint, silently denied.
//
// THE FIX IS NOT TO WEAKEN THE GUARD. It is to stop treating "repaint" and "destroy the caret" as
// the same event. We repaint, then put the operator back exactly where they were: same field, same
// value, same selection. Their value wins over the rendered one, because a render is by definition
// older than the keystrokes that raced it.
//
// The refusal survives as the fallback for the one case restoration cannot cover: a focused text
// entry with no id, which we cannot find again after innerHTML. There, skipping is still correct.
function paint(el, html) {
  if (!el) return false;
  const a = document.activeElement;
  const owned = a && a !== document.body && el.contains(a) && isTextEntry(a);

  if (owned && !a.id) return false;          // unfindable after the paint: refuse, as before

  const keep = owned
    ? { id: a.id, value: a.value, start: a.selectionStart, end: a.selectionEnd, scroll: a.scrollLeft }
    : null;

  el.innerHTML = html;

  if (keep) {
    const next = el.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(keep.id) : keep.id));
    if (next) {
      // The operator's keystrokes outrank the render. Only write when they differ, so we never
      // reset a selection the browser already had right.
      if (next.value !== keep.value) next.value = keep.value;
      next.focus({ preventScroll: true });
      // setSelectionRange throws on some input types (number, email) in some engines. A caret at
      // the end is a far better outcome than an exception that kills the rest of the render.
      try { next.setSelectionRange(keep.start, keep.end); } catch (e) { /* caret lands at the end */ }
      next.scrollLeft = keep.scroll;
    }
    // If the field did not survive the render it was genuinely removed, and there is nothing to
    // restore. That is a real state change, not a paint stealing focus.
  }
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
  dense: false,
  ask: null,
  filters: { crm: { lane: null, disposition: null, state: null, trade: null, line_type: null,
                    reach: null, enriched: null, suppressed: null, sort: 'recent', offset: 0 },
             customers: { status: null, sort: 'recent', offset: 0 },
             calls: { recorded: null, direction: null, offset: 0 },
             events: { name: null, offset: 0 },
             deliveries: { state: null, offset: 0 } },
  lastMeasuredAt: null,
  drawerAccount: null,
  drawerContact: null,
  cockpit: null,
  cockpitTarget: null,
  selected: new Set(),
  facets: null,
};

/**
 * ★ A GATE'S REASON CAN CONTAIN A STRANGER'S WORDS, AND MUST NOT BE PRESENTED AS OURS.
 *
 * Traced end to end in the live schema, 2026-08-14:
 *
 *   a caller says "stop"      scripts.mjs matches /^\s*stop\b/i
 *   -> call-transcription.mjs passes p_heard_as: text.slice(0, 200)   — THE CALLER'S OWN SPEECH
 *   -> sv_dnc_request builds  'do-not-call request: ' || p_heard_as
 *   -> trigger apply_suppression sets contacts.suppressed_reason = that string
 *   -> sv_crm_outreach_state SPLICES suppressed_reason into the why sentence this console shows
 *
 * So up to 200 characters of transcribed speech from an unknown third party can arrive inside a
 * sentence an operator reads as the system's compliance determination. It is escaped, so it is not
 * an injection into the page - it is an injection into the VOICE. An operator who reads
 * "Do not contact: do-not-call request: this is the wrong number, try 555-0100" may act on a
 * stranger's instruction believing it is our finding.
 *
 * Two rules follow, and the second is the one that will matter more later:
 *   1. Split our determination from their words, and render theirs as an attributed quotation.
 *   2. NEVER put the raw sentence in a model prompt. Escaping does nothing to a prompt; only the
 *      structural separation this function performs does.
 *
 * The prefix match is deliberately narrow and falls through to rendering the whole string as ours
 * when it does not match, because inventing an attribution would be its own fabrication.
 */
const CALLER_QUOTED_PREFIX = 'do-not-call request: ';
function gateWhy(why) {
  const s = String(why == null ? '' : why);
  const i = s.indexOf(CALLER_QUOTED_PREFIX);
  if (i < 0) return esc(s);
  const ours = s.slice(0, i + CALLER_QUOTED_PREFIX.length - 2);   // keep our sentence, drop the ": "
  const theirs = s.slice(i + CALLER_QUOTED_PREFIX.length).trim();
  if (!theirs) return esc(s);
  return esc(ours) + '. <span class="muted">Heard on the call, transcribed, not our wording:</span> ' +
         '<q class="heard">' + esc(theirs) + '</q>';
}

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

// One place that turns filter state into a query string, so the table and the export can never
// disagree about what "the current filter" means.
function crmQuery(f, limit, offset) {
  const qs = new URLSearchParams({ q: S.q || '', sort: f.sort || 'recent',
                                   limit: String(limit), offset: String(offset || 0) });
  for (const k of ['disposition','state','trade','line_type','lane']) if (f[k]) qs.set(k, f[k]);
  if (f.reach)    qs.set('reach', f.reach);
  if (f.enriched) qs.set('enriched', f.enriched);
  // Suppressed leads are hidden by DEFAULT rather than silently included: an operator working a
  // list should not have to remember that some rows must never be contacted.
  if (f.suppressed === 'true') qs.set('suppressed', 'true');
  else if (f.suppressed !== 'any') qs.set('suppressed', 'false');
  return qs;
}

const tile = (k, v, sub, cls) =>
  '<div class="card"><div class="tile-k">' + esc(k) + '</div>' +
  '<div class="tile-v ' + (cls || '') + '">' + v + '</div>' +
  (sub ? '<div class="tile-s">' + sub + '</div>' : '') + '</div>';

const FILTER_LABELS = { trade:'Trade', state:'State', line_type:'Line', disposition:'Stage',
  reach:'Reachable', enriched:'Enrichment', suppressed:'Suppression' };

function activeChips(f) {
  const on = Object.keys(FILTER_LABELS).filter((k) => f[k] != null && f[k] !== '');
  if (!on.length && !S.q) return '';
  return '<div class="activef">' +
    (S.q ? '<span class="afx">search: ' + esc(S.q) + '<button data-clearf="q" aria-label="Clear search">×</button></span>' : '') +
    on.map((k) => '<span class="afx">' + FILTER_LABELS[k] + ': ' + esc(String(f[k]).replace(/_/g, ' ')) +
      '<button data-clearf="' + k + '" aria-label="Clear ' + FILTER_LABELS[k] + '">×</button></span>').join('') +
    '<button class="btn ghost sm" data-clearf="all">Clear all</button></div>';
}

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
// ══ THE COCKPIT ═══════════════════════════════════════════════════════════════════════════
// David, verbatim: "world class Call/Text internal cockpit/interface ... incredible functionalities
// and filters and features ... manually control or turn on autopilot ... turn on multiple phone
// lines up to 100+ ... like a world class video game/fighter jet/phone interface ... no gated
// processes / no lengthy processes / full usability in every way."
//
// ★ THE RULE THAT SHAPES EVERY PIXEL BELOW. A cockpit is the most tempting surface in software to
// fake, and this estate has a first law that nothing is fabricated. So: no animation runs without
// real data moving, no lamp lights without a measurement behind it, and the LIVE indicator is wired
// to exactly one thing — a call actually on the wire. The honest version is also the better one: a
// panel that is loud about what is inoperative is what makes the rest of it believable.
//
// It calls sv_board and sv_admin_cockpit. IT DOES NOT DIAL. There is exactly one dial path in this
// system and it belongs to the outbound lane; a second one that did not run the compliance gate is
// precisely how that control gets bypassed.
VIEWS.cockpit = async () => {
  const d = await api('cockpit');
  S.lastMeasuredAt = d.at; freshness();
  S.cockpit = d;

  const live = d.in_flight.length;
  const providerDead = /provider_unavailable|unconfigured|unknown/.test(
    (d.providers && d.providers.sms && d.providers.sms.state) || '');

  const lamp = (kind, key, value, why) =>
    '<div class="lamp ' + kind + '"><div class="lamp-t"><span class="lamp-d"></span>' +
    '<span class="lamp-k">' + esc(key) + '</span></div>' +
    '<div class="lamp-v">' + value + '</div>' +
    '<div class="lamp-w">' + why + '</div></div>';

  const p = d.providers || {};
  const lamps = '<div class="inst ckpt-full"><div class="inst-h"><h3>Master caution</h3>' +
    '<span class="sp muted mono" style="font-size:11px">every lamp is a measurement, taken ' +
    esc(when(d.at)) + '</span></div>' +
    '<div class="lamps">' +
      lamp(live ? 'live' : '', 'On the wire', live ? n(live) + ' live' : 'Clear',
        live ? 'A call is connected right now. This is the only thing that lights this lamp.'
             : 'No call is on the wire. Nothing here is animating, because nothing is moving.') +
      lamp(p.telephony && p.telephony.ok ? 'go' : 'stop', 'Telephony',
        p.telephony && p.telephony.ok ? 'Ready' : 'Down',
        esc((p.telephony && p.telephony.why) || 'not measured')) +
      lamp(p.sms && p.sms.ok ? 'go' : 'caution', 'Carrier campaign',
        p.sms && p.sms.ok ? 'Approved' : 'Blocked', gateWhy((p.sms && p.sms.why) || 'not measured')) +
      lamp(p.email && p.email.ok ? 'go' : 'stop', 'Mail',
        p.email && p.email.ok ? 'Sending' : 'Down', gateWhy((p.email && p.email.why) || 'not measured')) +
      lamp(d.lamps.registry.ok ? 'go' : 'caution', 'Do-not-call registry',
        d.lamps.registry.ok ? 'Loaded' : 'Never loaded', esc(d.lamps.registry.why)) +
      lamp(d.autopilot_kill ? 'caution' : 'go', 'Autopilot',
        d.autopilot_kill ? 'Disarmed' : 'Armed',
        d.autopilot_kill
          ? 'The kill switch is set, so no campaign can place a call. A 200 from a call endpoint does not mean outbound is live.'
          : 'Campaigns may dial.') +
      lamp(d.lamps.states.open ? 'go' : 'caution', 'States cleared',
        n(d.lamps.states.open) + ' of ' + n(d.lamps.states.in_book), esc(d.lamps.states.why)) +
      lamp(p.ai && p.ai.ok ? 'go' : 'caution', 'AI',
        p.ai && p.ai.ok ? 'Online' : 'Off', esc((p.ai && p.ai.why) || 'not measured')) +
    '</div></div>';

  // ── the line bank ────────────────────────────────────────────────────────────────────────
  const cap = d.line_capacity;
  const bank = '<div class="inst ckpt-full"><div class="inst-h"><h3>Line bank</h3>' +
    '<span class="sp muted mono" style="font-size:11px">' + n(cap.lines) + ' provisioned · ' +
      n(cap.active) + ' active · ' + n(cap.calls_today) + ' of ' + n(cap.daily_ceiling) +
      ' calls today</span></div><div class="inst-b"><div class="bank">' +
    d.lines.map((l) => {
      const pct = l.daily_cap ? Math.min(100, Math.round((l.calls_today / l.daily_cap) * 100)) : 0;
      const cls = l.reputation === 'flagged' || l.reputation === 'at_risk' ? 'flag'
                : l.resting ? 'rest' : l.status === 'active' ? 'act' : '';
      return '<div class="ln ' + cls + '">' +
        '<div class="ln-n">' + esc(phone(l.phone)) + '</div>' +
        '<div class="ln-l">' + esc(l.label || 'unlabelled') + '</div>' +
        '<div class="ln-m"><span>' + esc(l.purpose) + '</span><span>·</span>' +
          '<span>' + esc(l.resting ? 'resting' : l.status) + '</span>' +
          (l.in_flight ? '<span style="margin-left:auto;color:var(--live)">' + n(l.in_flight) + ' live</span>' : '') +
        '</div>' +
        '<div class="ln-bar" title="' + n(l.calls_today) + ' of ' + n(l.daily_cap) + ' today"><i style="width:' + pct + '%"></i></div>' +
      '</div>';
    }).join('') +
    // The 100+ requirement, answered honestly: the capacity is real and the constraint is named.
    '<div class="ln-add">Add a line<br><span class="muted" style="font-size:11px">' +
      'Provisioning needs the telephony account funded. The bank has no software ceiling.</span></div>' +
    '</div></div></div>';

  // ── the wire ─────────────────────────────────────────────────────────────────────────────
  const wire = '<div class="inst"><div class="inst-h"><h3>The wire</h3>' +
    (live ? '<span class="sp pill" style="color:var(--live);border-color:var(--live)">' + n(live) + ' connected</span>' : '') +
    '</div>' +
    (live
      ? '<div class="strip">' + d.in_flight.map((c) =>
          '<div class="fs" data-call="' + esc(c.call_sid || '') + '">' +
          '<span class="fs-t">' + esc(String(c.elapsed_s || 0)) + 's</span>' +
          '<span class="fs-w"><b>' + esc(c.contact_name || phone(c.to_number)) + '</b>' +
          '<span>' + esc(c.status) + ' · ' + n(c.lines_so_far) + ' transcript lines</span></span>' +
          '<span class="fs-r"><a class="btn ghost sm" href="/internal/cockpit" target="_blank" rel="noreferrer">Listen live</a></span>' +
          '</div>').join('') + '</div>'
      : '<div class="wire' + (providerDead ? ' dead' : '') + '"><div class="wire-idle">' +
        '<div class="horizon"></div>' +
        (providerDead
          ? '<div class="big">The wire is cold</div><div class="sm">' +
            esc((p.telephony && p.telephony.why) || 'The telephony provider is not answering.') +
            ' Nothing is drawn here because nothing is measured. This panel will light by itself when the provider answers again.</div>'
          : '<div class="big">Nothing on the wire</div><div class="sm">No call is connected. ' +
            'The trace above is flat because there is no audio, not because it is decorative. ' +
            'Live calls appear here the moment one connects, and the supervisor console at ' +
            '<a href="/internal/cockpit" target="_blank" rel="noreferrer">/internal/cockpit</a> ' +
            'is where you listen, whisper, barge and take over.</div>') +
        '</div></div>') +
    '</div>';

  // ── the target and its channel bay ───────────────────────────────────────────────────────
  const target = S.cockpitTarget || d.queue[0];
  const bay = target
    ? '<div class="inst" style="height:100%"><div class="inst-h"><h3>Target</h3>' +
        '<span class="sp"><button class="btn ghost sm" data-act="ck-skip">Skip</button>' +
        '<button class="btn ghost sm" data-contact="' + esc(target.id) + '">Open record</button></span></div>' +
      '<div class="inst-b">' +
        '<div style="font-size:var(--t-xl);font-weight:var(--w-semi);letter-spacing:var(--ls-xl)">' +
          esc(target.name || 'Unnamed') + '</div>' +
        '<div class="muted mono" style="font-size:12.5px;margin-top:4px">' +
          esc(phone(target.phone)) + ' · ' + esc(target.line_type || 'line type unknown') +
          (target.city ? ' · ' + esc([target.city, target.state].filter(Boolean).join(', ')) : '') + '</div>' +
        '<div class="tile-s" style="margin-top:9px">' + gateWhy(target.why) + '</div>' +
        '<div class="bay" style="margin-top:14px">' + channelSwitches(target, d) + '</div>' +
      '</div></div>'
    : '<div class="inst"><div class="inst-h"><h3>Target</h3></div>' +
      '<div class="inst-b">' + emptyState('The queue is empty',
        'No lead is in new, queued or callback and not suppressed. That is a measured zero.') + '</div></div>';

  const queue = '<div class="inst"><div class="inst-h"><h3>Queue</h3>' +
    '<span class="sp muted mono" style="font-size:11px">' + n(d.queue.length) + ' ready · ' +
      n(d.book.emailable) + ' emailable in the book</span></div>' +
    '<div class="q">' + d.queue.map((q, i) =>
      '<div class="qr" data-cktarget="' + esc(q.id) + '"' +
        (target && q.id === target.id ? ' aria-current="true"' : '') + '>' +
      '<span class="qr-i">' + (i + 1) + '</span>' +
      '<span class="qr-w"><b>' + esc(q.name || 'Unnamed') + '</b>' +
      '<span>' + esc([q.trade, q.city, q.state].filter(Boolean).join(' · ')) + '</span></span>' +
      '<span class="fs-r">' + (q.has_email ? '<span class="rch on" title="Email is open">E</span>' : '') +
        (q.fixed_line ? '<span class="rch wait" title="Fixed line, waiting on the registry">C</span>' : '') +
      '</span></div>').join('') + '</div></div>';

  const strip = '<div class="inst ckpt-full"><div class="inst-h"><h3>Flight strip</h3>' +
    '<span class="sp muted mono" style="font-size:11px">the last ' + n(d.recent.length) +
    ' calls · ' + n(d.book.transcript_lines) + ' transcript lines on record</span></div>' +
    (d.recent.length
      ? '<div class="strip">' + d.recent.map((c) =>
          '<div class="fs" data-call="' + esc(c.call_sid || '') + '">' +
          '<span class="fs-t">' + esc(when(c.created_at)) + '</span>' +
          '<span class="fs-w"><b>' + esc(c.contact_name || phone(c.to_number) || 'unknown') + '</b>' +
          '<span>' + esc(c.call_class || 'unclassified') + ' · ' +
            (c.placed ? esc(c.status || 'placed') : 'refused') +
            (c.transcript_lines ? ' · ' + n(c.transcript_lines) + ' lines' : '') + '</span></span>' +
          '<span class="fs-r">' +
            (c.recording_sid ? '<span class="pill info">rec</span>' : '') +
            (c.disclosure_verified === true ? '<span class="pill ok">disclosed</span>'
              : c.disclosure_verified === false ? '<span class="pill bad">not spoken</span>'
              : '<span class="pill warn">unchecked</span>') +
          '</span></div>').join('') + '</div>'
      : emptyState('No calls yet', 'A measured zero: the call spine is empty.')) + '</div>';

  // The target is the thing an operator acts on, so it gets the full width and the bay gets room
  // for its sentences. The wire and the queue share the row below it.
  return '<div class="ckpt">' + lamps + bank +
    '<div class="ckpt-full ckpt-wide">' + bay + '</div>' +
    wire + queue + strip + '</div>';
};

const target_or = (t, html) => html;

// Three switches. A switch that cannot act is DASHED, DIMMED and carries its reason: it is
// physically different, not merely a different colour, so it survives a colour-blind operator and
// a black-and-white screenshot.
function channelSwitches(t, d) {
  const p = d.providers || {};
  const mailOk = Boolean(p.email && p.email.ok) && Boolean(t.has_email);
  const smsOk = Boolean(p.sms && p.sms.ok) && (t.line_type === 'mobile' || t.line_type === 'nonFixedVoip');
  const callOk = Boolean(d.lamps.registry.ok) && t.state_open && t.fixed_line && !d.autopilot_kill;

  const sw = (key, label, ok, value, why, act) =>
    '<button class="sw ' + (ok ? 'armed' : '') + '"' + (ok ? '' : ' disabled') +
    (ok ? ' data-act="' + act + '" data-contact="' + esc(t.id) + '" data-to="' +
          esc(key === 'email' ? (t.email || '') : (t.phone || '')) + '"' : '') +
    ' title="' + esc(why) + '">' +
    '<div class="sw-k">' + esc(label) + '</div>' +
    '<div class="sw-v">' + (ok ? value : 'Disarmed') + '</div>' +
    '<div class="sw-w">' + esc(why) + '</div></button>';

  return sw('email', 'Email', mailOk, 'Armed',
      mailOk ? 'A real send goes out and is logged against this record.'
             : (!t.has_email ? 'No email address on this record yet.'
                             : ((p.email && p.email.why) || 'The mail provider is not configured.')), 'do-email') +
    sw('sms', 'Text', smsOk, 'Armed',
      smsOk ? 'The line accepts texts and the campaign is approved.'
            : ((p.sms && p.sms.why) || 'Not textable.'), 'do-sms') +
    sw('call', 'Call', callOk, 'Armed',
      callOk ? 'Lawful right now. Placement runs through the outbound gate, which is the only path that may dial.'
             : (d.autopilot_kill ? 'The autopilot kill switch is set, so nothing on this deploy can place a call.'
                : !t.fixed_line ? 'An artificial voice may not cold-call a ' + (t.line_type || 'line of unknown type') + ' without consent.'
                : !t.state_open ? 'This state has not been cleared. That is a queue, not a refusal.'
                : d.lamps.registry.why), 'do-call');
}

VIEWS.crm = async () => {
  const f = S.filters.crm;
  const qs = crmQuery(f, 50, f.offset);

  // ★ IS THE BOOK NARROWED RIGHT NOW? This mirrors crmQuery EXACTLY and must keep mirroring it: an
  // empty table has to say WHY it is empty, and the two wrong answers are equally bad. Claiming
  // "measured zero" while a filter is hiding every row is a lie about the data; claiming "nothing
  // matches that filter" when no filter is set sends an operator hunting for a filter to clear.
  //
  // The subtle one is suppression. crmQuery sends suppressed=false when the state is null, so the
  // DEFAULT view is already narrowed even though the operator set nothing. That is the right
  // default (a do-not-contact lead should not appear in a working list by accident) but it means a
  // bare "measured zero" would be hiding a condition the operator never chose, so it gets named
  // below rather than left implicit.
  const hidesSuppressed = f.suppressed !== 'any' && f.suppressed !== 'true';
  const anyFilter = Boolean(S.q)
    || ['disposition', 'state', 'trade', 'line_type', 'lane', 'reach', 'enriched'].some((k) => f[k])
    || f.suppressed != null;

  const [d, facets] = await Promise.all([
    api('crm?' + qs),
    S.facets ? Promise.resolve(S.facets) : api('crm/facets'),
  ]);
  S.facets = facets;
  S.lastMeasuredAt = new Date().toISOString(); freshness();
  const n0 = $('[data-count="leads"]'); if (n0) n0.textContent = facets.total || '';

  // ── real form controls, not bubble lists ──────────────────────────────────────────────────
  // A dropdown carries its whole option set with the count beside each value, so an operator can
  // see that "roofer" has 844 before choosing it. A row of chips can only show what fits.
  const dropdown = (key, label, options, current, width) =>
    '<span class="fx"><label for="f-' + key + '">' + esc(label) + '</label>' +
    '<select class="fsel" id="f-' + key + '" data-fsel="' + key + '"' +
    (current != null && current !== '' ? ' data-on="1"' : '') +
    (width ? ' style="min-width:' + width + '"' : '') + '>' +
    options.map((o) => {
      const v = o.v == null ? '' : String(o.v);
      return '<option value="' + esc(v) + '"' +
        (String(current == null ? '' : current) === v ? ' selected' : '') + '>' +
        esc(o.label) + (o.n != null ? '  (' + n(o.n) + ')' : '') + '</option>';
    }).join('') + '</select></span>';

  const opts = (arr, allLabel) =>
    [{ v: '', label: allLabel }].concat(arr.map((x) => ({ v: x.k, label: String(x.k).replace(/_/g, ' '), n: x.n })));

  const filterBar =
    '<div class="filterbar">' +
      '<span class="fsearch"><input id="crmq" type="search" value="' + esc(S.q || '') +
        '" placeholder="Name, phone, city, website, email, person" aria-label="Search leads"></span>' +
      dropdown('trade', 'Trade', opts(facets.trade, 'Any trade'), f.trade) +
      dropdown('state', 'State', opts(facets.state, 'Any state'), f.state, '118px') +
      dropdown('line_type', 'Line', opts(facets.line_type, 'Any line type'), f.line_type) +
      dropdown('disposition', 'Stage', opts(facets.disposition, 'Any stage'), f.disposition) +
      dropdown('reach', 'Reachable', [
        { v: '', label: 'Any channel' },
        { v: 'email', label: 'Has an email', n: facets.emailable_now },
        { v: 'fixed', label: 'Fixed business line', n: facets.fixed_line },
        { v: 'mobile', label: 'Mobile', n: facets.textable_line },
        { v: 'none', label: 'No channel at all' },
      ], f.reach, '176px') +
      dropdown('enriched', 'Enrichment', [
        { v: '', label: 'Any' },
        { v: 'done', label: 'Site read', n: facets.enriched },
        { v: 'todo', label: 'Site not read yet', n: facets.websites_unread },
      ], f.enriched, '164px') +
      dropdown('suppressed', 'Suppression', [
        { v: '', label: 'Not suppressed' },
        { v: 'true', label: 'Suppressed only', n: facets.suppressed },
        { v: 'any', label: 'Include suppressed' },
      ], f.suppressed == null ? '' : String(f.suppressed), '168px') +
      dropdown('sort', 'Sort', [
        { v: 'recent', label: 'Newest first' }, { v: 'name', label: 'A to Z' },
        { v: 'touched', label: 'Last touched' }, { v: 'calls', label: 'Most called' },
      ], f.sort, '150px') +
      '<span class="fcount"><b>' + n(d.total) + '</b><span class="muted">of ' + n(facets.total) + '</span>' +
        '<button class="btn ghost sm" data-act="crm-density">' + (S.dense ? 'Comfortable' : 'Dense') + '</button>' +
        '<button class="btn ghost sm" data-act="crm-export">Export</button></span>' +
    '</div>' +
    (activeChips(f) || '');

  // ── the honest headline. fixed_line is a PROPERTY. callable_now is a PERMISSION. ──────────
  const reachCard =
    '<div class="grid g4">' +
      // ★ THIS TILE USED TO READ "Emailable today ... needs no carrier, no registry and no state
      // clearance." Both halves were wrong, and wrong in the direction that invites a bad send.
      //
      // The label was a PERMISSION word over a PROPERTY count: emailable_now is has-an-email minus
      // suppressed, with no gate expression behind it at all. And the sentence asserted that email
      // is an unregulated channel, which @ANSWERED-RESEARCH refuted from primary text: CAN-SPAM
      // reaches a cold commercial first touch in full, Cal. B&P 17529.5 carries a PRIVATE right of
      // action at $1,000 per email that a business recipient can bring, and WA CEMA carries $500
      // per message. Phone risk is gateable by subscribing to a registry. Email risk is litigation
      // risk, and no subscription immunises it.
      //
      // So the tile now counts a property, says so, and states plainly that the channel is not
      // cleared. A count with an honest caveat is worth more than a confident label.
      tile('Have an email on file', n(facets.emailable_now),
        'A property of the record: an address is present and the lead is not suppressed. ' +
        'It is NOT permission to send. Email is a different regime, not an open one: CAN-SPAM ' +
        'applies in full to a cold commercial message, and CA and WA carry per-message private ' +
        'damages. Gated pending verification.', '') +
      tile('Callable right now', n(facets.callable_now),
        facets.callable_blocked_because ||
        'Fixed business lines, scrubbed and inside a cleared state.',
        facets.callable_now ? 'brand' : '') +
      tile('Fixed business lines', n(facets.fixed_line),
        'A property of the phone number, not a permission. These are the lines an artificial ' +
        'voice may call once the registry and the state are cleared.') +
      tile('Mobiles', n(facets.textable_line),
        'Kept and listed, never discarded. A person may dial and speak to these; an artificial ' +
        'voice may not without consent.') +
    '</div>';

  if (!d.rows.length) {
    return reachCard + filterBar + '<div class="card pad0">' +
      (anyFilter
        ? emptyState('Nothing matches that filter',
            'Measured ' + esc(stamp(S.lastMeasuredAt)) + '. Clear the filters to see the whole book.')
        : hidesSuppressed
          ? emptyState('No leads to work',
              'This is a measured zero, not a loading state and not a failure. The query ran and ' +
              'returned nothing. One condition is on that you did not set: leads marked do-not-contact ' +
              'are hidden by default. Set Suppressed to Any to see whether the book is empty or ' +
              'entirely suppressed. Measured ' + esc(stamp(S.lastMeasuredAt)) + '.')
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

  return reachCard + filterBar + bulk + '<div class="card pad0">' +
    
    '<div class="tw"><table class="' + (S.dense ? 'dense' : '') + '"><thead><tr>' +
      '<th style="width:34px"><input type="checkbox" data-act="crm-sel-all" aria-label="Select this page"></th>' +
      '<th>Business</th><th>Trade</th><th>Where</th><th>Line</th><th>Reachable</th>' +
      '<th>Stage</th><th class="num">Calls</th><th>Last touched</th></tr></thead><tbody>' +
    d.rows.map((r) => {
      // Three glyphs, one per channel, distinguished by SHAPE and letter as well as colour so
      // the row is readable without relying on hue. A dashed outline means the channel exists on
      // this record but is currently refused; a solid fill means it will actually act.
      const g = (letter, state, title) =>
        '<span class="rch ' + state + '" title="' + esc(title) + '">' + letter + '</span>';
      const reach = [
        r.suppressed ? g('E', 'blocked', 'Suppressed: never contact on any channel')
          : r.email ? g('E', 'on', 'Email ready: ' + r.email)
          : g('E', 'blocked', 'No email address on file'),
        r.suppressed ? g('C', 'blocked', 'Suppressed')
          : r.ai_dialable
            ? (facets.callable_now ? g('C', 'on', 'Fixed business line, callable now')
                                   : g('C', 'wait', facets.callable_blocked_because || 'Waiting on clearance'))
            : g('C', 'blocked', (r.line_type || 'unknown') + ': an artificial voice may not cold-call this'),
        r.suppressed ? g('T', 'blocked', 'Suppressed')
          : (r.line_type === 'mobile' || r.line_type === 'nonFixedVoip')
            ? g('T', 'wait', 'The line accepts texts; the carrier campaign is not approved yet')
            : g('T', 'blocked', (r.line_type || 'unknown') + ' does not receive texts'),
      ];
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
        '<td><span class="reach">' + reach.join('') + '</span></td>' +
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
    '<div class="tile-s" style="margin-top:7px">' + gateWhy(state ? state.why : 'unknown') + '</div>' +
  '</div>';
}

function renderContact(d, pre) {
  const c = d.contact;
  const tabs = [['summary','Summary'],['reach','Reach out'],['thread','Conversation'],
                ['calls','Calls'],['notes','Notes'],['tasks','Tasks'],['timeline','Timeline']];
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

    // THE CONVERSATION. Deliberately not the timeline: only what was said between us and them, in
    // the order it was said, so an operator can read the room before adding to it.
    thread: () => '<div class="card pad0"><div class="card-h"><h2>What has been said</h2>' +
      '<span class="sp muted" id="thmeta">reading</span></div>' +
      '<div id="th" class="tw"><div style="padding:16px"><div class="skel" style="width:70%"></div>' +
      '<div class="skel" style="width:45%;margin-top:8px"></div></div></div>' +
      threadComposer(c, pre) + '</div>',
  };

  const dr = $('#drawer');
  dr.innerHTML = head + '<div class="drawer-b" id="dbody">' + panes[leadTab]() + '</div>';
  dr.__panes = panes; dr.__contact = c; dr.__pre = pre;
  const load = LEAD_TAB_LOADERS[leadTab];
  if (load) load(c.id);
}

/**
 * The composer sits under the thread and answers the operator's real question before they type:
 * CAN I SEND, ON WHICH CHANNEL, AND IF NOT, WHY NOT. A disabled button with no explanation is the
 * thing this console exists not to do.
 *
 * Every channel is rendered whether or not it is available. A missing button reads as a missing
 * feature; a present button carrying the gate's own refusal reads as a system that knows its own
 * state and will re-arm itself the moment the condition clears.
 */
function threadComposer(c, pre) {
  const p = pre || {};
  const ch = (key, label, gate, to, act) => {
    const ok = gate && gate.ok;
    const why = (gate && gate.why) || 'This channel has not reported its state.';
    return '<button class="btn ' + (ok ? 'primary' : 'ghost') + ' sm" ' +
      'data-act="' + act + '" data-contact="' + esc(c.id) + '" data-to="' + esc(to || '') + '"' +
      (ok ? '' : ' data-blocked="1" data-why="' + esc(why) + '"') +
      ' title="' + esc(why) + '">' +
      (ok ? '' : '<span aria-hidden="true">·</span> ') + esc(label) + '</button>';
  };
  const anyOpen = [p.email, p.sms, p.call].some((g) => g && g.ok);
  return '<div class="composer">' +
    '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      ch('email', 'Write an email', p.email, c.email, 'do-email') +
      ch('sms',   'Send a text',    p.sms,   c.phone, 'do-sms') +
      // THE LABEL NOW MATCHES WHAT THE BUTTON DOES. It read "Place a call", and it does not
      //   place a call: outreach.callIntent() contains no Twilio call at all. It records the
      //   intent, logs the consent basis, and hands back a tel: link for the operator to dial
      //   from their own handset. That indirection is deliberate and correct - a second dial
      //   path here would be a second way to reach a phone that does not cross the outbound
      //   gate - but the button was describing the thing the code deliberately refuses to do.
      ch('call',  'Call from your phone',   p.call,  c.phone, 'do-call') +
    '</div>' +
    '<div class="sm muted" style="margin-top:8px">' +
      (anyOpen
        ? 'A channel shown plain is not available right now. Hover it to read the gate’s own reason. ' +
          'Nothing here is hardcoded off: each one re-arms itself when its condition clears, with no deploy.'
        : 'No channel is open to this business right now. Each button carries the reason it is closed. ' +
          'That is a live reading, not a setting, so this panel changes on its own when the condition does.') +
    '</div>' +
  '</div>';
}

/**
 * ★ A THREAD THAT HIDES THE BLOCKED SENDS WOULD LIE BY OMISSION. If we tried three times to text a
 * business and the gate refused all three, "no messages" is the wrong answer to "why have we not
 * heard back". Blocked and failed sends are rendered as first-class entries carrying their reason.
 */
async function loadThread(contactId) {
  try {
    const d = await api('crm/thread?contact=' + encodeURIComponent(contactId) + '&limit=200');
    const el = $('#th'); if (!el) return;
    const msgs = (d && d.messages) || [];
    const counts = (d && d.counts) || {};

    const meta = $('#thmeta');
    if (meta) {
      const inb = Object.entries(counts).filter(([k]) => k.endsWith('_inbound')).reduce((a, [, n]) => a + n, 0);
      const out = Object.entries(counts).filter(([k]) => k.endsWith('_outbound')).reduce((a, [, n]) => a + n, 0);
      meta.textContent = msgs.length
        ? (out + ' sent, ' + inb + ' received' + (d.truncated ? ' · showing the most recent ' + d.returned + ' of ' + d.total : ''))
        : 'nothing yet';
    }

    paint(el, msgs.length
      ? '<div class="thread">' + msgs.map(threadBubble).join('') + '</div>'
      : '<div style="padding:4px">' + emptyState('No messages yet',
          'This is a measured zero: the query ran and this business has never been emailed or texted ' +
          'from here. Blocked attempts would appear too, so an empty thread means none were made.') + '</div>');
    // Newest last, so land the operator at the bottom the way every messaging app does.
    if (msgs.length) el.scrollTop = el.scrollHeight;
  } catch (e) {
    paint($('#th'), errState('The conversation could not load', e.message));
  }
}

function threadBubble(m) {
  const inbound = m.direction === 'inbound';
  const bad = m.status === 'blocked' || m.status === 'failed';
  const cls = 'bub ' + (bad ? 'bub-bad' : (inbound ? 'bub-in' : 'bub-out'));
  const head =
    '<div class="bub-h">' +
      '<span class="pill">' + esc(m.channel) + '</span> ' +
      '<span class="muted mono">' + esc(stamp(m.sent_at || m.created_at)) + '</span>' +
      (m.ai_assisted
        // Never let a drafted-by-model message pass as hand-written. The operator sent it, but they
        // are entitled to know later which ones a model helped write, and with which model.
        ? ' <span class="pill" title="' + esc(m.ai_model || 'model not recorded') + '">AI drafted</span>' : '') +
      (m.sent_by ? ' <span class="muted">' + esc(m.sent_by) + '</span>' : '') +
    '</div>';
  const body =
    (m.subject ? '<div class="bub-s">' + esc(m.subject) + '</div>' : '') +
    '<div class="bub-t">' + esc(m.body || '') + '</div>';
  const foot = bad
    ? '<div class="bub-f">' + esc(m.status === 'blocked' ? 'Blocked' : 'Failed') + ': ' +
        esc(m.failure_reason || 'no reason was recorded, which is itself a defect worth reporting') + '</div>'
    : (m.status && m.status !== 'sent' && m.status !== 'delivered'
        ? '<div class="bub-f">' + esc(m.status) + '</div>' : '');
  return '<div class="' + cls + '">' + head + body + foot + '</div>';
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
  // ★ SAY WHICH SCOPE EACH NUMBER WAS COMPUTED AT. This table is the PICKER, so it stays unfiltered
  // even when a name filter is on - filtering it would leave one row and destroy its only job. But
  // an unlabelled unfiltered breakdown sitting beside a filtered total is two numbers that disagree
  // with nothing saying so, and both are individually true, which is what lets that survive review.
  '<div class="card pad0"><div class="card-h"><h2>By event, last 30 days</h2>' +
    (f.name && d.by_name_scope === 'all_names'
      ? '<span class="sp muted">every event name, not just ' + esc(f.name) + ', so you can switch</span>'
      : '') + '</div>' +
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

  /**
   * WHO THE CALL SAYS IT IS. 47 CFR 64.1200(b)(1).
   *
   * This was computed in dial.mjs and rendered nowhere, which meant a named compliance gap lived in
   * a field no screen read — the same fate as the comment it was written to escape. It is a card
   * now, and when the entity IS set the card stays, because "who does this line say it is" is worth
   * confirming on sight rather than only worth warning about when missing.
   */
  const ci = d.caller_identity || {};
  const identityCard =
    '<div class="card" style="border-color:' + (ci.named ? 'var(--line)' : 'var(--warn)') + '">' +
      '<div class="tile-k">Who the call says it is · ' + esc(ci.rule || '47 CFR 64.1200(b)(1)') + '</div>' +
      (ci.named
        ? '<div class="tile-v" style="font-size:19px">' + esc(ci.entity) + '</div>'
        : '<div class="tile-v bad" style="font-size:19px">not named</div>') +
      '<div class="tile-s" style="margin-top:7px;font-size:13.5px;line-height:var(--lh-base)">' +
        '<strong>The line opens with:</strong> ' + esc(ci.what_the_line_says || '') +
      '</div>' +
      '<div class="tile-s" style="margin-top:7px;font-size:13.5px;line-height:var(--lh-base)">' +
        esc(ci.why || '') +
      '</div>' +
      '<div class="sm muted" style="margin-top:8px">The (b) chapeau carries no line-type limit, so ' +
        'this binds on business lines too. Read from the runtime, not from a control-plane listing.' +
      '</div>' +
    '</div>';

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
  identityCard +
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

/**
 * ASK. The operator types a question; SQL answers it; a model only phrases it.
 *
 * THE EVIDENCE TRAIL IS NOT OPTIONAL DECORATION. Every figure in the answer is shown again below
 * it, with the query that produced it and the JSON path it came from. An operator who wants to know
 * where a number came from should never have to ask, and a surface that cannot show its working has
 * not earned the right to state a number at all.
 *
 * A REFUSAL RENDERS AS AN ANSWER, NOT AS AN ERROR. "These tools cannot answer that" and "the model
 * tried to author a figure so it was withheld" are both the system working correctly. Styling them
 * as failures would teach the operator to retry until something slips through, which is the exact
 * opposite of the point.
 */
VIEWS.ask = async () => {
  const last = S.ask || null;
  return '<div class="card">' +
      '<div class="tile-k">Ask your data</div>' +
      '<div class="tile-s" style="font-size:13.5px;margin-top:4px">' +
        'Ask in plain English. The question chooses which measured query runs; the answer is phrased ' +
        'by Claude on the direct Anthropic API. <strong>The model never writes a number.</strong> It ' +
        'references measured values and the server substitutes them, then checks that no quantity ' +
        'appears in the answer that it did not put there. If it cannot answer honestly it says so, ' +
        'and that is a real answer.' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-top:12px;align-items:flex-start">' +
        '<input class="input" id="askq" type="text" maxlength="500" style="flex:1" ' +
          'placeholder="How many leads are waiting on a state review?" ' +
          'value="' + esc((last && last.question) || '') + '">' +
        '<button class="btn" id="askgo" data-act="ask-go">Ask</button>' +
      '</div>' +
      '<div class="sm muted" style="margin-top:8px">' +
        ['How many leads do we have, and how many are on a fixed line?',
         'Where can we legally call, and how many leads are waiting on a review?',
         'How many calls have we made?'].map((q) =>
          '<button class="btn ghost sm" data-askex="' + esc(q) + '" style="margin:3px 4px 0 0">' + esc(q) + '</button>').join('') +
      '</div>' +
    '</div>' +
    '<div id="askout">' + (last ? renderAsk(last) : '') + '</div>';
};

function renderAsk(r) {
  if (!r) return '';
  const trail = (r.trail || []).length
    ? '<div class="card pad0" style="margin-top:12px"><div class="card-h"><h2>What it actually ran</h2>' +
      '<span class="sp muted">every figure above, traced to the query that produced it</span></div>' +
      '<div class="tw"><table><thead><tr><th>Query</th><th>Database function</th><th>Returned</th></tr></thead><tbody>' +
      r.trail.map((x) => '<tr><td class="mono">' + esc(x.tool) + '</td>' +
        '<td class="mono muted">' + esc(x.rpc || '') + '</td><td>' +
        (x.error
          ? '<span class="pill bad">failed</span> <span class="muted">' + esc(x.error) + '</span>'
          : Object.keys(x.slots || {}).map((k) => '<span class="pill">' + esc(k.replace(/_/g, ' ')) + '</span>').join(' ')) +
        '</td></tr>').join('') + '</tbody></table></div></div>'
    : '';

  const slots = (r.slots || []).filter((s) => s.display);
  const figures = slots.length
    ? '<div class="card pad0" style="margin-top:12px"><div class="card-h"><h2>Every figure, and where it came from</h2></div>' +
      '<div class="tw"><table><thead><tr><th>Value</th><th>Meaning</th><th>Source</th></tr></thead><tbody>' +
      slots.map((s) => '<tr><td class="num mono"><strong>' + esc(s.display) + '</strong></td>' +
        '<td>' + esc(String(s.path || '').replace(/_/g, ' ')) +
          (s.measured === false ? ' <span class="pill warn">asserted, not measured</span>' : '') +
          (s.null_means ? ' <span class="pill">never measured</span>' : '') +
          (s.note ? '<div class="sm muted">' + esc(s.note) + '</div>' : '') + '</td>' +
        '<td class="mono muted">' + esc(s.rpc || '') + '</td></tr>').join('') +
      '</tbody></table></div></div>'
    : '';

  if (r.ok) {
    return '<div class="card" style="margin-top:12px">' +
        '<div class="sumbox"><div style="font-size:15px;line-height:var(--lh-base);white-space:pre-wrap">' +
          esc(r.answer) + '</div></div>' +
        '<div class="sm muted" style="margin-top:11px">' + esc(r.model || '') +
          (r.cost_usd != null ? ' · $' + r.cost_usd.toFixed(4) + ', modeled from published rates' : '') +
          (r.steps ? ' · ' + r.steps + ' round trip' + (r.steps === 1 ? '' : 's') : '') +
          (r.repairs ? ' · rephrased once after the firewall stopped a quantity it wrote itself' : '') +
        '</div>' +
      '</div>' + figures + trail;
  }

  const title = r.refused === 'cannot_answer' ? 'These tools cannot answer that'
    : r.refused === 'ai_unconfigured' ? 'The AI layer is off'
    : 'The answer was withheld';
  return '<div class="card" style="margin-top:12px">' +
      '<div class="alert warn"><strong>' + esc(title) + '</strong><br>' + esc(r.why || '') +
      (r.what_would_answer_it ? '<div style="margin-top:8px"><strong>What would answer it:</strong> ' +
        esc(r.what_would_answer_it) + '</div>' : '') + '</div>' +
      (r.draft
        ? '<div style="margin-top:11px"><div class="tile-k">What was refused, so you can judge it yourself</div>' +
          '<blockquote class="quote" style="white-space:pre-wrap">' + esc(r.draft) + '</blockquote></div>'
        : '') +
      '<div class="sm muted" style="margin-top:11px">' + esc(r.model || '') +
        (r.cost_usd != null ? ' · $' + r.cost_usd.toFixed(4) : '') +
        (r.detail ? ' · ' + esc(r.detail) : '') + '</div>' +
    '</div>' + figures + trail;
}

async function runAsk(q) {
  const question = String(q || (($('#askq') || {}).value) || '').trim();
  if (!question) return;
  const out = $('#askout');
  const btn = $('#askgo');
  if (btn) { btn.disabled = true; btn.textContent = 'Asking…'; }
  if (out) out.innerHTML = '<div class="card" style="margin-top:12px">' +
    '<div class="skel" style="width:72%"></div><div class="skel" style="width:48%;margin-top:8px"></div>' +
    '<div class="sm muted" style="margin-top:10px">Choosing which measured query answers this, then running it.</div></div>';
  try {
    const r = await api('ask', { body: { question } });
    r.question = question;
    S.ask = r;
    if (out) out.innerHTML = renderAsk(r);
  } catch (e) {
    if (out) out.innerHTML = errState('The question could not be run', e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Ask'; }
  }
}

/**
 * THE DELIVERY LOG. Every job that owes an outbound write, and what happened to it.
 *
 * This screen exists because the previous shape had no screen. The webhook was fired inside an
 * awaited fan-out with a .catch() that turned a failure into a reason string in a response nobody
 * stored. A receiver could be down for a day and the only trace would be log lines. An integration
 * whose failure mode is silence is worse than no integration, because the customer believes their
 * CRM has the job.
 *
 * DEAD IS THE STATE THAT MATTERS and it is listed first. A dead delivery means a real job exists
 * here and does not exist in the customer's system. It is not a state the queue recovers from on
 * its own: a human decides, and replays.
 */
VIEWS.deliveries = async () => {
  const f = S.filters.deliveries;
  const d = await api('deliveries?' + new URLSearchParams({ state: f.state || '', limit: 200 }));
  const c = d.counts || {};
  S.deadDeliveries = c.dead || 0;

  const tile = (k, v, sub, cls) =>
    '<div class="card"><div class="tile-k">' + esc(k) + '</div>' +
    '<div class="tile-v ' + (cls || '') + '">' + n(v || 0) + '</div>' +
    '<div class="tile-s">' + esc(sub) + '</div></div>';

  const head =
    '<div class="grid g4">' +
      tile('Dead', c.dead, 'Gave up after every retry. A job exists here and not in their system. Replay it or fix the receiver.', c.dead ? 'bad' : '') +
      tile('Waiting', (c.pending || 0) + (c.delivering || 0), 'Queued or in flight. Retries carry the same key, so a duplicate is harmless.') +
      tile('Delivered', c.delivered, 'The receiver accepted it.') +
      tile('Total', d.total, 'Every delivery ever owed.') +
    '</div>' +
    '<div class="card"><div class="row" style="gap:8px;flex-wrap:wrap">' +
      ['', 'dead', 'pending', 'delivering', 'delivered'].map((st) =>
        '<button class="btn ' + (String(f.state || '') === st ? '' : 'ghost ') + 'sm" ' +
        'data-filter="deliveries" data-key="state" data-value="' + esc(st) + '">' +
        (st === '' ? 'All' : esc(st)) + '</button>').join('') +
    '</div></div>';

  if (!(d.rows || []).length) {
    return head + '<div class="card pad0"><div style="padding:16px">' +
      (d.total
        ? emptyState('Nothing in that state', 'Measured ' + esc(stamp(S.lastMeasuredAt)) + '.')
        : emptyState('Nothing has been delivered yet',
            'This is a measured zero. No job has owed an outbound write, which is expected while ' +
            'ANSWERED_WEBHOOK_URL is unset and no customer connection exists. A row appears here the ' +
            'moment a booking is created, because the queue row is written inside the job transaction.')) +
      '</div></div>';
  }

  return head +
    '<div class="card pad0"><div class="card-h"><h2>Deliveries</h2>' +
      '<span class="sp muted">newest first · the key is what makes a retry safe</span></div>' +
    '<div class="tw"><table><thead><tr><th>State</th><th>Event</th><th>Target</th>' +
      '<th class="num">Tries</th><th>Last result</th><th>Idempotency key</th><th>When</th><th></th></tr></thead><tbody>' +
    d.rows.map((r) => '<tr>' +
      '<td><span class="pill ' + (r.state === 'dead' ? 'bad' : r.state === 'delivered' ? 'ok' : '') + '">' +
        esc(r.state) + '</span></td>' +
      '<td class="mono">' + esc(r.event) + '</td>' +
      '<td class="mono muted">' + esc(r.target) + '</td>' +
      '<td class="num">' + n(r.attempts) + '</td>' +
      '<td>' + (r.last_status ? esc(String(r.last_status)) : '<span class="muted">—</span>') +
        (r.last_error ? '<div class="sm muted">' + esc(String(r.last_error).slice(0, 120)) + '</div>' : '') + '</td>' +
      '<td class="mono muted" style="font-size:11.5px">' + esc(r.idempotency_key) + '</td>' +
      '<td class="muted">' + esc(when(r.created_at)) + '</td>' +
      '<td>' + (r.state === 'dead' || r.state === 'delivered'
        ? '<button class="btn ghost sm" data-act="delivery-replay" data-id="' + esc(r.id) + '">Replay</button>'
        : '') + '</td></tr>').join('') +
    '</tbody></table></div></div>' +
    '<div class="card"><div class="tile-s">A replay re-sends with the <strong>same idempotency key</strong>, ' +
    'so a receiver that already has the job will recognise it rather than creating a second one. That is ' +
    'the whole reason the key is minted before the first attempt and never regenerated.</div></div>';
};

async function replayDelivery(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Queued…'; }
  try {
    const r = await api('delivery/replay', { body: { id } });
    toast(r.ok ? 'Queued for another attempt with the same key.' : ('Not replayed: ' + (r.error || 'unknown')), r.ok ? 'ok' : 'bad');
    go('deliveries');
  } catch (e) {
    toast(e.message, 'bad');
    if (btn) { btn.disabled = false; btn.textContent = 'Replay'; }
  }
}

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
const TITLES = { cockpit:'Cockpit', overview:'Overview', crm:'Leads', customers:'Customers', calls:'Calls and recordings',
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
// Whether the call drawer is showing interim transcript lines. Off by default: a streaming
// transcript is mostly the same sentence being revised, and one call here is 471 lines of which 6
// are final.
let showInterim = false;
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

    rules: () => notesFitCard(d.notes_fit) + (d.config
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
      : emptyState('No rules yet', 'This business has not written the instructions its line would answer under.')),

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
/**
 * Which loader each lead tab needs. ONE table, consulted by every path that can put a tab on
 * screen. It exists because there were two: renderContact knew about one set and the tab-click
 * handler knew about another, so a new tab rendered its shell and never fetched anything, forever,
 * with no error. A lookup cannot drift from itself.
 */
const LEAD_TAB_LOADERS = {
  timeline: (id) => loadTimeline(id),
  thread:   (id) => loadThread(id),
};

/**
 * Every explicit action, in one place, returning TRUE when it handled the click.
 *
 * Pulled out of the click listener so it can run BEFORE the noun-based branches. An outreach button
 * carries data-act AND data-contact; while the contact branch ran first, every send button in this
 * console re-opened the lead drawer instead of doing its job.
 *
 * Returning a boolean rather than just acting means an unknown action falls through to the noun
 * branches instead of being swallowed, so a typo in a data-act degrades to the old behaviour
 * instead of making a control inert.
 */
async function actionClick(t, act) {
  switch (act) {
    case 'close-drawer':   closeDrawer(); return true;
    case 'close-modal':    closeModal(); return true;
    case 'clear-event':    S.filters.events.name = null; go('events'); return true;
    case 'refund':         refundModal(t.dataset.charge, +t.dataset.max, t.dataset.label); return true;
    case 'refund-go':      doRefund(t.dataset.charge, +t.dataset.max); return true;
    case 'export-accounts': exportAccounts(); return true;
    case 'crm-clear-sel':  S.selected.clear(); go('crm'); return true;
    case 'crm-density':    S.dense = !S.dense; go('crm'); return true;
    case 'crm-export':     exportLeads(); return true;
    case 'crm-sort':       S.filters.crm.sort = t.dataset.value; S.filters.crm.offset = 0; go('crm'); return true;
    case 'ck-skip': {
      const q = (S.cockpit && S.cockpit.queue) || [];
      const cur = S.cockpitTarget ? q.findIndex((x) => x.id === S.cockpitTarget.id) : 0;
      S.cockpitTarget = q[(cur + 1) % Math.max(q.length, 1)] || null;
      go('cockpit', { quiet: true }); return true;
    }
    case 'crm-sel-all':
      $$('[data-sel]').forEach((cb) => { if (t.checked) S.selected.add(cb.dataset.sel); else S.selected.delete(cb.dataset.sel); });
      go('crm'); return true;

    // The gate's reason travels WITH the click, so the composer states it before the operator
    // writes four hundred characters and then learns it was never sendable. The server still
    // refuses independently: this is courtesy, not the control.
    case 'do-email':  emailComposer(t.dataset.contact, t.dataset.to, t.dataset.why || null); return true;
    case 'do-sms':    smsComposer(t.dataset.contact, t.dataset.to, t.dataset.why || null); return true;
    case 'do-call':   doCall(t.dataset.contact, t.dataset.to); return true;
    case 'add-note':  addNote(t.dataset.contact); return true;
    case 'add-task':  addTask(t.dataset.contact); return true;
    case 'ai-draft':  aiDraft(t.dataset.contact); return true;
    case 'backfill':  backfill(t); return true;
    case 'ask-go':    await runAsk(); return true;
    case 'delivery-replay': await replayDelivery(t.dataset.id, t); return true;
    case 'status':    statusChange(t.dataset.value); return true;
    case 'summarize-call': await summarizeCall(t.dataset.sid, t); return true;
    case 'toggle-interim': {
      showInterim = !showInterim;
      // Re-open the same call rather than repainting a fragment: the drawer owns its own data and
      // a half-repainted drawer is how a panel starts showing two different calls at once.
      const sid = $('#drawer').__callSid;
      if (sid) openCall(sid);
      return true;
    }
    default:          return false;      // fall through to the noun branches
  }
}

function wire() {
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-view],[data-account],[data-contact],[data-call],[data-rec],[data-act],[data-filter],[data-crmfilter],[data-page],[data-tab],[data-leadtab],[data-status],[data-event],[data-bulk],[data-setdisp],[data-task],[data-sel],[data-clearf],[data-cktarget],[data-askex],.pal-i');
    if (!t) return;

    // ── CRM ────────────────────────────────────────────────────────────────────────────────
    if (t.dataset.sel != null) {                    // a row checkbox
      const id = t.dataset.sel;
      if (t.checked) S.selected.add(id); else S.selected.delete(id);
      go('crm', { quiet: true });
      return;
    }
    if (t.dataset.cktarget) {
      const q = (S.cockpit && S.cockpit.queue) || [];
      S.cockpitTarget = q.find((x) => x.id === t.dataset.cktarget) || null;
      go('cockpit', { quiet: true }); return;
    }
    if (t.dataset.clearf) {
      const k = t.dataset.clearf, f = S.filters.crm;
      if (k === 'all') {
        S.filters.crm = { lane:null, disposition:null, state:null, trade:null, line_type:null,
                          reach:null, enriched:null, suppressed:null, sort:f.sort, offset:0 };
        S.q = '';
      } else if (k === 'q') { S.q = ''; }
      else { f[k] = null; f.offset = 0; }
      S.selected.clear();
      go('crm'); return;
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
    // ★ AN EXPLICIT VERB OUTRANKS A NOUN, AND GETTING THIS BACKWARDS BROKE EVERY OUTREACH BUTTON.
    //
    // data-contact means "this element is about that business" and is what makes a table row
    // clickable. data-act means "do this specific thing". An outreach button carries BOTH, because
    // the action needs to know which business it is acting on — and because the contact branch used
    // to run first, EVERY send button re-opened the lead drawer instead of composing.
    //
    // Measured on prod: clicking "Write an email" re-rendered the same lead. No error, no console
    // message, a visible repaint that looked deliberate. The drawer even flickered convincingly.
    // It is the third defect of this exact family in this file: a control whose click was received,
    // routed somewhere reasonable, and silently never did the thing it named.
    //
    // So the action dispatch now runs FIRST, and the noun branches below are the fallback they were
    // always meant to be. Anything with an explicit data-act is handled by actionClick().
    if (t.dataset.act) { if (await actionClick(t, t.dataset.act)) return; }

    if (t.dataset.contact) { openContact(t.dataset.contact); return; }
    if (t.dataset.leadtab) {
      leadTab = t.dataset.leadtab;
      const dr = $('#drawer');
      $$('.tab', dr).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.leadtab === leadTab)));
      if (dr.__panes) {
        paint($('#dbody'), dr.__panes[leadTab]());
        // ONE TABLE, CONSULTED BY BOTH RENDER PATHS. This branch used to name loadTimeline
        // directly while renderContact named its own set, so a tab added to one was invisible in
        // the other: the Conversation tab rendered its shell here and never fetched a message.
        // Two places deciding the same thing is two places to forget.
        const load = LEAD_TAB_LOADERS[leadTab];
        if (load && dr.__contact) load(dr.__contact.id);
      }
      return;
    }
    if (t.dataset.askex) { const i = $('#askq'); if (i) i.value = t.dataset.askex; runAsk(t.dataset.askex); return; }
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
    const map = { f:'cockpit', g:'overview', d:'crm', c:'customers', l:'calls', u:'usage', b:'billing', p:'parley',
      e:'events', k:'compliance', a:'audit', s:'system' };
    if (map[e.key]) { e.preventDefault(); go(map[e.key]); }
  });

  // ── the filter bar ────────────────────────────────────────────────────────────────────────
  // A <select> fires 'change', never 'click', so the delegated click handler above cannot see it.
  // This is delegated on the document so it survives every repaint of the view.
  document.addEventListener('change', (e) => {
    const el = e.target.closest('select[data-fsel]');
    if (!el) return;
    const key = el.dataset.fsel;
    const raw = el.value;
    const f = S.filters.crm;
    if (key === 'sort') f.sort = raw || 'recent';
    else f[key] = raw === '' ? null : raw;
    f.offset = 0;
    S.selected.clear();
    go('crm');
  });

  // Enter in the Ask box submits. Delegated on the document so it survives every repaint of the
  // view, and scoped to that one field so it cannot swallow Enter anywhere else.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!e.target || !e.target.matches || !e.target.matches('#askq')) return;
    e.preventDefault();
    runAsk(e.target.value);
  });

  let cq;
  document.addEventListener('input', (e) => {
    if (!e.target.matches || !e.target.matches('#crmq')) return;
    clearTimeout(cq);
    const v = e.target.value;
    cq = setTimeout(() => {
      S.q = v.trim(); S.filters.crm.offset = 0;
      // quiet, so the caret is not disturbed: paint() already refuses to replace a region that
      // owns a text field, and this keeps the skeleton from flashing under the operator's hands.
      go('crm', { quiet: true });
    }, 280);
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
      callSummaryCard(c, d.transcript || []) +
      transcriptCard(d.transcript || []) +
    '</div>';
  dr.__callSid = c.call_sid || sid;
}

/**
 * Ask for a summary and render whatever comes back, INCLUDING a refusal.
 *
 * The two refusals this can return are not errors and must not look like errors. "There are no
 * final lines" and "the model quoted something that is not in the transcript" are both the system
 * working correctly and declining to show the operator something it cannot stand behind. An error
 * state would teach them to retry; a refusal teaches them what is true.
 */
async function summarizeCall(sid, btn) {
  if (!sid) return;
  const out = $('#sumout');
  if (btn) { btn.disabled = true; btn.textContent = 'Reading the call…'; }
  if (out) out.innerHTML = '<div style="padding:10px 0"><div class="skel" style="width:70%"></div>' +
    '<div class="skel" style="width:45%;margin-top:8px"></div></div>';
  try {
    const r = await api('call/summarize', { body: { call_sid: sid } });
    if (r.ok) {
      toast('Summarised by ' + (r.model || 'a model') + '.', 'ok');
      openCall(sid);                      // re-read, so the panel shows what was actually STORED
      return;
    }
    // a refusal, rendered as the honest answer it is
    if (out) {
      out.innerHTML = '<div class="alert warn" style="margin-top:12px">' +
        '<strong>' + esc(r.refused === 'quote_not_in_transcript'
            ? 'Rejected: a quote was not in the transcript'
            : 'Not summarised') + '</strong><br>' + esc(r.why || '') +
        ((r.quotes || []).length
          ? '<div style="margin-top:8px">' + r.quotes.map((q) =>
              '<blockquote class="quote">' + esc(q) + '</blockquote>').join('') + '</div>'
          : '') +
        '</div>';
    }
  } catch (e) {
    if (out) out.innerHTML = errState('The summary could not be produced', e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Summarise this call'; }
  }
}

/**
 * The AI summary panel. It is a button and a result, and the interesting part is what it refuses.
 *
 * A call with no FINAL transcript lines cannot be summarised honestly, so the button is not offered
 * and the reason is stated with the counts that justify it. One call in this database has 471 lines
 * of which 6 are final: the other 465 are the same sentences being revised as speech is recognised.
 * Summarising those would be summarising a stutter, and a model asked to find meaning in one will.
 */
function callSummaryCard(c, transcript) {
  const finals = transcript.filter((t) => t.is_final).length;
  // ★ THE TWO MOST IMPORTANT FIELDS LIVE SOMEWHERE ELSE. sv_admin_call_summary deliberately splits
  // the result: summary and sentiment go to their own columns on calls, because they are queried
  // and displayed in lists, and ai_notes keeps the rest. Rendering ai_notes alone therefore drew a
  // panel with no summary line and no sentiment row - the two things an operator opens it for.
  // Measured on prod: the card came back headed "They wanted" with the prose simply absent.
  const notes = c.ai_notes && typeof c.ai_notes === 'object' ? c.ai_notes : null;
  const existing = notes
    ? { ...notes, summary: c.summary || notes.summary || '', sentiment: c.sentiment || notes.sentiment || '' }
    : null;

  const head = '<div class="card-h"><h2>What happened on this call</h2>' +
    '<span class="sp muted">' + finals + ' final of ' + transcript.length + ' lines</span></div>';

  if (!finals) {
    return '<div class="card pad0">' + head + '<div style="padding:14px 16px">' +
      emptyState(transcript.length ? 'Not enough of this call is final' : 'Nothing was transcribed',
        transcript.length
          ? 'This call has ' + transcript.length + ' transcript lines and none are marked final. Interim ' +
            'lines are the same sentence being revised as it is recognised, so a summary of them would ' +
            'be a summary of a stutter. Nothing will be sent to a model.'
          : 'That is a measured absence rather than a failure. Not every call is transcribed.') +
      '</div></div>';
  }

  return '<div class="card pad0">' + head + '<div style="padding:14px 16px">' +
    (existing ? renderCallSummary(existing) : '') +
    '<div class="row" style="gap:8px;align-items:center;margin-top:' + (existing ? '12px' : '0') + '">' +
      '<button class="btn ' + (existing ? 'ghost ' : '') + 'sm" data-act="summarize-call" data-sid="' +
        esc(c.call_sid) + '">' + (existing ? 'Summarise again' : 'Summarise this call') + '</button>' +
      '<span class="sm muted">Reads the ' + finals + ' final line' + (finals === 1 ? '' : 's') +
        ' only. Every quote it returns is checked against the transcript before anything is stored.</span>' +
    '</div>' +
    '<div id="sumout"></div>' +
  '</div></div>';
}

/**
 * DO THIS OWNER'S INSTRUCTIONS FIT DOWN THE PHONE?
 *
 * Two different facts, deliberately shown as two, because the operator's next move differs:
 *
 *   WILL clip    computed right now from the same renderSpec() the call path sends. True of an
 *                account that has never been called, and false again the moment they trim it.
 *   HAS clipped  a real call where it actually happened, written by the voice lane.
 *
 * The pair separates "was clipped once, since fixed" from "is still over right now". A stored flag
 * alone would keep accusing an owner who already fixed it, and would say nothing at all about a
 * customer who has written too much but not yet been called — which is the moment you actually want
 * to tell them.
 *
 * When nothing is wrong this renders a quiet line with the headroom, not a green tick. An operator
 * should be able to see the number without being congratulated for it.
 */
function notesFitCard(f) {
  if (!f) return '';
  if (!f.measurable) {
    return '<div class="card"><div class="tile-k">Instruction length</div>' +
      '<div class="tile-s" style="margin-top:4px">Could not be measured' +
      (f.error ? ': ' + esc(f.error) : '. This is a gap in the check, not a statement about the notes.') +
      '</div></div>';
  }
  const had = f.happened;
  const rows =
    kv('Length now', n(f.chars_now) + ' characters') +
    kv('Fits in', n(f.limit) + ' characters') +
    (f.will_clip ? kv('Over by', n(f.over_by) + ' characters') : kv('Headroom', n(f.limit - f.chars_now) + ' characters'));

  if (!f.will_clip && !had) {
    return '<div class="card"><div class="tile-k">Instruction length</div><dl class="kv" style="margin-top:8px">' +
      rows + '</dl></div>';
  }

  const nowLine = f.will_clip
    ? '<strong>This owner’s instructions are too long to send whole.</strong> On the next call, ' +
      n(f.over_by) + ' characters from the middle will be left out. People write the setup first and ' +
      'the caveats last, so the part most likely to be lost is the part that begins “Important” or ' +
      '“Never say”. The assistant is told its notes were clipped and will offer to check rather ' +
      'than guess, but it is still answering from an incomplete brief.'
    : '<strong>This is fixed now.</strong> The instructions currently fit, with ' +
      n(f.limit - f.chars_now) + ' characters to spare.';

  const thenLine = had
    ? '<div style="margin-top:9px" class="sm">It has already happened on a real call: ' +
      n(had.chars_sent) + ' characters were sent, ' + n(had.chars_kept) + ' were kept and ' +
      n(had.chars_dropped) + ' were dropped, ' +
      (had.times_seen > 1 ? 'on ' + n(had.times_seen) + ' calls, most recently ' : 'once, ') +
      esc(stamp(had.last_seen)) + '.</div>'
    : '<div style="margin-top:9px" class="sm muted">It has not happened on a real call yet, so there ' +
      'is time to tell them before it does.</div>';

  return '<div class="card" style="border-color:' + (f.will_clip ? 'var(--warn)' : 'var(--line)') + '">' +
    '<div class="tile-k">Instruction length</div>' +
    '<div class="tile-s" style="margin-top:6px;font-size:13.5px;line-height:var(--lh-base)">' + nowLine + '</div>' +
    thenLine +
    '<dl class="kv" style="margin-top:11px">' + rows + '</dl>' +
    (f.will_clip
      ? '<div class="sm muted" style="margin-top:9px">What to tell them: shorten it, and put anything ' +
        'that must never be missed near the top or the very end.</div>'
      : '') +
  '</div>';
}

function renderCallSummary(s) {
  const list = (arr) => (arr || []).length
    ? '<ul style="margin:4px 0 0 16px">' + arr.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    : '<span class="muted">none</span>';
  return '<div class="sumbox">' +
    '<div style="font-size:14px;line-height:var(--lh-base)">' + esc(s.summary || '') + '</div>' +
    '<dl class="kv" style="margin-top:11px">' +
      kv('They wanted', s.caller_wanted) +
      kv('Outcome', s.outcome) +
      kv('Sentiment', s.sentiment) +
    '</dl>' +
    '<div style="margin-top:11px"><strong class="sm" style="display:block;margin-bottom:3px">Follow-ups</strong>' +
      list(s.follow_ups) + '</div>' +
    ((s.quotes || []).length
      ? '<div style="margin-top:11px"><strong class="sm" style="display:block;margin-bottom:3px">' +
        'Verbatim, checked against the transcript</strong>' +
        s.quotes.map((q) => '<blockquote class="quote"><span class="pill">' + esc(q.speaker || '?') +
          '</span> ' + esc(q.text) + '</blockquote>').join('') + '</div>'
      : '') +
    // ★ THE ABSTENTION IS RENDERED, NOT DROPPED. A model saying what it could not determine is the
    // most valuable field on this panel, and hiding it would turn a careful answer into a confident one.
    (s.unclear && String(s.unclear).trim()
      ? '<div class="alert" style="margin-top:11px"><strong>Not determined from this call:</strong> ' +
        esc(s.unclear) + '</div>'
      : '') +
    '<div class="sm muted" style="margin-top:11px">' +
      esc(s.model || 'model not recorded') +
      (s.cost_usd != null ? ' · ' + esc(String(s.cost_usd)) + ' USD, modeled from published rates' : '') +
      (s.lines_final != null ? ' · read ' + s.lines_final + ' final line' + (s.lines_final === 1 ? '' : 's') : '') +
      (s.at ? ' · ' + esc(stamp(s.at)) : '') +
    '</div>' +
  '</div>';
}

/**
 * The transcript. Final lines by default, because a raw stream is mostly the same sentence six
 * times and reading it is a chore rather than a feature. The interim lines are one click away and
 * the counts are stated, so nothing is hidden - it is ordered.
 */
function transcriptCard(transcript) {
  if (!transcript.length) {
    return emptyState('No transcript',
      'Nothing was transcribed for this call. That is a measured absence, not a loading state.');
  }
  const finals = transcript.filter((t) => t.is_final);
  const show = showInterim ? transcript : (finals.length ? finals : transcript);
  const line = (t) => '<div style="margin-bottom:9px' + (t.is_final ? '' : ';opacity:.62') + '">' +
    '<span class="pill">' + esc(t.speaker || t.track || 'unknown') + '</span> ' +
    '<span style="font-size:14px">' + esc(t.text) + '</span>' +
    (t.is_final ? '' : ' <span class="sm muted">interim</span>') + '</div>';
  return '<div class="card pad0"><div class="card-h"><h2>Transcript</h2>' +
    '<span class="sp muted">' + finals.length + ' final · ' + (transcript.length - finals.length) + ' interim</span>' +
    (transcript.length > finals.length
      ? '<button class="btn ghost sm" data-act="toggle-interim">' +
        (showInterim ? 'Final lines only' : 'Show interim lines') + '</button>'
      : '') +
    '</div><div style="padding:14px 16px">' +
    (finals.length || showInterim ? show.map(line).join('')
      : '<div class="sm muted">Every line on this call is interim. Nothing was ever finalised.</div>') +
    '</div></div>';
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

function emailComposer(contactId, to, blockedWhy) {
  modal('<h3>Email this business</h3>' +
    (blockedWhy
      ? '<div class="alert warn"><strong>This channel cannot send right now.</strong><br>' +
        esc(blockedWhy) +
        '<br><span class="sm">Draft it anyway if it is worth having ready. The send button stays off ' +
        'until the gate clears, and it clears on its own with no deploy.</span></div>'
      : '') +
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
      '<button class="btn" id="esend" data-to="' + esc(to) + '" data-contact="' + esc(contactId) + '"' +
        (blockedWhy ? ' disabled title="' + esc(blockedWhy) + '"' : '') + '>Send</button></div>');
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

function smsComposer(contactId, to, blockedWhy) {
  modal('<h3>Text this business</h3>' +
    // ★ THE REFUSAL COMES FIRST, BEFORE THE TEXTAREA. Letting someone compose into a channel that
    // cannot send is not a neutral act: it spends their attention and then throws the work away.
    // The draft box stays open on purpose, because a message worth writing is worth keeping for
    // when the channel clears, and the AI draft button still works here.
    (blockedWhy
      ? '<div class="alert warn"><strong>This channel cannot send right now.</strong><br>' +
        esc(blockedWhy) +
        '<br><span class="sm">Write it anyway if it is worth having ready. The send button stays off ' +
        'until the gate clears, and it clears on its own with no deploy.</span></div>'
      : '') +
    '<p>Sending to <strong>' + esc(phone(to)) + '</strong>.</p>' +
    '<div class="field"><label for="sbody">Message</label><textarea class="input" id="sbody" rows="4" maxlength="450"></textarea></div>' +
    '<div class="alert warn" id="swarn2" style="display:none"></div>' +
    '<div class="row end"><button class="btn ghost" data-act="close-modal">Cancel</button>' +
    '<button class="btn" id="ssend"' + (blockedWhy ? ' disabled title="' + esc(blockedWhy) + '"' : '') +
      '>Send text</button></div>');
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
    const d = await api('crm?' + crmQuery(f, 200, 0));
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
  const v = location.hash.replace('#', '') || 'cockpit';
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

// ★ THE SAME GUARD FOR THE STYLESHEETS, BECAUSE IT HAPPENED TWICE.
// The first time a stray backtick was inside a code comment in APP_JS. The second time it was
// inside a CSS comment in TOKENS — I wrote `font-src 'self'` with backticks for emphasis, in a
// file where a backtick ends the world. Both times the symptom was a parse error, which is the
// LUCKY outcome; the dangerous one is a shorter but valid string that ships a half-written
// stylesheet and looks merely ugly rather than broken.
//
// Each sheet is asserted to reach its own last rule. A cheap check for a defect that has now
// cost two debugging cycles.
for (const [name, css, sentinel] of [
  ['TOKENS', TOKENS, '/* TOKENS-END */'],
  ['CONSOLE_CSS', CONSOLE_CSS, '/* CONSOLE-CSS-END */'],
]) {
  if (!css.includes(sentinel)) {
    throw new Error(
      'admin-ui: ' + name + ' is truncated at ' + css.length + ' chars. It does not contain its ' +
      'own end sentinel, which means a stray backtick closed the template early. Backticks are ' +
      'not allowed anywhere inside these strings, including inside comments.');
  }
}
