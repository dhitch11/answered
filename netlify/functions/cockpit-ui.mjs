// cockpit-ui.mjs — the console itself. Served only after the PIN check passes.
//
// The organising metaphor is the air-traffic flight-strip board, because that is literally the
// same job: many simultaneous transient events, each with a state, a clock, and an operator who
// has to see all of them at once and act on one without losing the others. Every live call is a
// strip. The strip carries its own clock, its own last spoken line, and its own controls.
//
// Palette is Answered's own LIVEWIRE. Hi-vis is never ambient and never sits on a light ground;
// it marks the one thing that matters in a given row and nothing else.
//
// Client JS uses string concatenation rather than template literals on purpose: this whole file
// is a template literal, and nesting them is how you ship a page with ${} printed in it.

const CSS = `
:root{
  --ground:#0B0C0E; --raise:#121417; --raise2:#181B1F; --line:#24282D; --hair:#31363C;
  --ink:#F2F4F0; --mute:#8A9199; --dim:#5C636A;
  --hivis:#E3FF4F; --dial:#37C8F0; --kill:#FF3355; --go:#7CE0A3; --hold:#F0B429;
  --mono: ui-monospace,"SF Mono",SFMono-Regular,Menlo,"Cascadia Mono","Liberation Mono",monospace;
  --sans: ui-sans-serif,-apple-system,BlinkMacSystemFont,"Helvetica Neue","Segoe UI","Liberation Sans",Arial,sans-serif;
  --rail:210px; --strip:400px; --hud:52px;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:14px;
     line-height:1.5;-webkit-font-smoothing:antialiased;overflow:hidden}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;background:none;border:0}
:focus-visible{outline:2px solid var(--hivis);outline-offset:2px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.tnum{font-variant-numeric:tabular-nums}

/* ── HUD ─────────────────────────────────────────────────────────────────────── */
.hud{position:fixed;inset:0 0 auto 0;height:var(--hud);display:flex;align-items:center;gap:0;
     background:var(--raise);border-bottom:1px solid var(--line);z-index:50;padding-right:12px}
.brand{width:var(--rail);display:flex;align-items:center;gap:9px;padding:0 16px;flex:0 0 auto;
       border-right:1px solid var(--line);height:100%}
.brand b{font-size:14px;letter-spacing:-.02em}
.brand .tag{font-family:var(--mono);font-size:9px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--dim);flex:0 0 auto}
.pulse.on{background:var(--hivis);animation:pl 2s ease-out infinite}
.pulse.err{background:var(--kill)}
@keyframes pl{0%{box-shadow:0 0 0 0 rgba(227,255,79,.5)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media (prefers-reduced-motion:reduce){.pulse.on{animation:none}}

.gauges{display:flex;align-items:stretch;height:100%;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.gauges::-webkit-scrollbar{display:none}
.g{display:flex;flex-direction:column;justify-content:center;padding:0 16px;border-right:1px solid var(--line);
   min-width:78px;flex:0 0 auto}
.g .k{font-family:var(--mono);font-size:8.5px;letter-spacing:.16em;color:var(--dim);text-transform:uppercase;white-space:nowrap}
.g .v{font-family:var(--mono);font-size:17px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}
.g .v.hi{color:var(--hivis)} .g .v.go{color:var(--go)} .g .v.kill{color:var(--kill)}
.g .v.dial{color:var(--dial)} .g .v.hold{color:var(--hold)}

.master{display:flex;align-items:center;gap:10px;padding:0 4px 0 16px;flex:0 0 auto}
.sw{width:52px;height:26px;border-radius:13px;background:var(--raise2);border:1px solid var(--hair);
    position:relative;transition:background .18s,border-color .18s;flex:0 0 auto}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
           background:var(--mute);transition:transform .18s,background .18s}
.sw[aria-pressed="true"]{background:rgba(227,255,79,.14);border-color:var(--hivis)}
.sw[aria-pressed="true"]::after{transform:translateX(26px);background:var(--hivis)}
.master .lab{font-family:var(--mono);font-size:9px;letter-spacing:.16em;color:var(--dim);text-transform:uppercase}

/* ── SHELL ───────────────────────────────────────────────────────────────────── */
.shell{position:fixed;inset:var(--hud) 0 0 0;display:grid;grid-template-columns:var(--rail) 1fr var(--strip)}
.rail{border-right:1px solid var(--line);background:var(--raise);overflow-y:auto;padding:12px 0}
.nav{display:flex;flex-direction:column}
.nav button{display:flex;align-items:center;gap:10px;padding:9px 16px;text-align:left;color:var(--mute);
            border-left:2px solid transparent;font-size:13px}
.nav button:hover{background:var(--raise2);color:var(--ink)}
.nav button[aria-current="true"]{color:var(--ink);border-left-color:var(--hivis);background:var(--raise2)}
.nav .kb{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--dim);border:1px solid var(--hair);
         border-radius:3px;padding:0 4px;line-height:15px}
.railhead{font-family:var(--mono);font-size:9px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase;
          padding:16px 16px 7px}

.main{overflow-y:auto;padding:20px 22px 60px;min-width:0}
.strip-rail{border-left:1px solid var(--line);background:var(--raise);overflow-y:auto;display:flex;flex-direction:column}

h1{font-size:20px;letter-spacing:-.025em;margin:0 0 3px;font-weight:700}
.sub{color:var(--mute);font-size:13px;margin:0 0 18px}
.eyebrow{font-family:var(--mono);font-size:9px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase;margin-bottom:8px}

/* ── flight strips ───────────────────────────────────────────────────────────── */
.strips{display:flex;flex-direction:column;gap:8px}
.strip{display:grid;grid-template-columns:5px 1fr auto;background:var(--raise);border:1px solid var(--line);
       border-radius:3px;overflow:hidden;cursor:pointer;transition:border-color .14s,transform .14s}
.strip:hover{border-color:var(--hair)}
.strip[data-sel="1"]{border-color:var(--hivis)}
.strip .bar{background:var(--dim)}
.strip[data-st="ringing"] .bar{background:var(--hold);animation:blink 1s steps(2) infinite}
.strip[data-st="in-progress"] .bar{background:var(--go)}
.strip[data-st="queued"] .bar,.strip[data-st="initiated"] .bar{background:var(--dial)}
@keyframes blink{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.strip[data-st="ringing"] .bar{animation:none}}
.strip .body{padding:11px 14px;min-width:0;display:flex;flex-direction:column;gap:3px}
.strip .top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.strip .who{font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:270px}
.strip .num{font-family:var(--mono);font-size:12px;color:var(--mute)}
.strip .said{font-size:12.5px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.strip .said b{color:var(--ink);font-weight:400}
.strip .right{padding:11px 14px;display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:0 0 auto}
.clock{font-family:var(--mono);font-size:19px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.state{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}

/* ── chips + lanes ───────────────────────────────────────────────────────────── */
.chip{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;
      text-transform:uppercase;padding:2px 6px;border:1px solid var(--hair);border-radius:2px;color:var(--mute);white-space:nowrap}
.chip.green{color:var(--go);border-color:rgba(124,224,163,.45)}
.chip.amber{color:var(--hold);border-color:rgba(240,180,41,.45)}
.chip.red{color:var(--kill);border-color:rgba(255,51,85,.5)}
.chip.hold{color:var(--dial);border-color:rgba(55,200,240,.45)}
.chip.hi{color:var(--hivis);border-color:rgba(227,255,79,.5)}

/* ── the active strip rail ───────────────────────────────────────────────────── */
.sr-head{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px;flex:0 0 auto}
.sr-title{font-size:15px;font-weight:700;letter-spacing:-.02em}
.sr-empty{padding:40px 20px;color:var(--dim);text-align:center;font-size:13px}
.ctrls{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);
       border-top:1px solid var(--line);border-bottom:1px solid var(--line);flex:0 0 auto}
.ctrls button{background:var(--raise2);padding:11px 4px;display:flex;flex-direction:column;align-items:center;gap:3px;
              font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
.ctrls button:hover:not(:disabled){background:var(--raise);color:var(--ink)}
.ctrls button:disabled{opacity:.32;cursor:not-allowed}
.ctrls button .kb{font-size:9px;color:var(--dim);border:1px solid var(--hair);border-radius:2px;padding:0 3px}
.ctrls button.danger:hover:not(:disabled){color:var(--kill)}
.ctrls button.hot:hover:not(:disabled){color:var(--hivis)}

.wf{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:9px;min-height:0}
.utt{display:flex;flex-direction:column;gap:2px;max-width:88%}
.utt.them{align-self:flex-start}
.utt.us{align-self:flex-end;align-items:flex-end}
.utt .lab{font-family:var(--mono);font-size:8.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.utt .txt{padding:7px 10px;border-radius:3px;font-size:13px;line-height:1.45}
.utt.them .txt{background:var(--raise2);border:1px solid var(--line)}
.utt.us .txt{background:rgba(55,200,240,.09);border:1px solid rgba(55,200,240,.28);color:var(--ink)}
.utt.partial .txt{opacity:.55;font-style:italic}

/* ── tables ──────────────────────────────────────────────────────────────────── */
.tablewrap{border:1px solid var(--line);border-radius:3px;overflow:auto;background:var(--raise);max-height:calc(100vh - 260px)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line);white-space:nowrap}
thead th{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);
         background:var(--raise2);position:sticky;top:0;z-index:2}
tbody tr{cursor:pointer}
tbody tr:hover{background:var(--raise2)}
tbody tr[data-sel="1"]{background:rgba(227,255,79,.06)}
td.n{font-family:var(--mono);font-variant-numeric:tabular-nums}
td.t{white-space:normal;max-width:280px}

/* ── filters + forms ─────────────────────────────────────────────────────────── */
.bar-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
input[type=text],input[type=tel],input[type=search],select,textarea{
  background:var(--raise);border:1px solid var(--hair);border-radius:3px;padding:7px 10px;font-size:13px;min-width:0}
input:hover,select:hover{border-color:var(--mute)}
select{cursor:pointer}
textarea{width:100%;resize:vertical;font-family:var(--sans)}
.btn{border:1px solid var(--hair);border-radius:3px;padding:7px 13px;font-size:12.5px;background:var(--raise2);
     display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.btn:hover:not(:disabled){border-color:var(--mute)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn.primary{background:var(--hivis);color:#0B0C0E;border-color:var(--hivis);font-weight:600}
.btn.primary:hover:not(:disabled){filter:brightness(1.08)}
.btn.danger{color:var(--kill);border-color:rgba(255,51,85,.4)}
.btn.ghost{background:transparent}

/* ── the dialer ──────────────────────────────────────────────────────────────── */
.dial-grid{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:24px;align-items:start}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.pad button{background:var(--raise);border:1px solid var(--line);border-radius:3px;padding:13px 0;
            font-family:var(--mono);font-size:19px;font-weight:500}
.pad button:hover{border-color:var(--hivis);color:var(--hivis)}
.readout{font-family:var(--mono);font-size:25px;letter-spacing:.02em;padding:14px 0 6px;min-height:56px;
         border-bottom:1px solid var(--hair);margin-bottom:14px;font-variant-numeric:tabular-nums}
.readout .ph{color:var(--dim)}

/* the gate verdict panel: the point of the whole interface */
.verdict{border:1px solid var(--line);border-radius:3px;background:var(--raise);overflow:hidden}
.verdict .vh{padding:13px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.verdict .vlane{font-family:var(--mono);font-size:22px;font-weight:700;letter-spacing:-.02em}
.verdict[data-lane="green"] .vlane{color:var(--go)}
.verdict[data-lane="amber"] .vlane{color:var(--hold)}
.verdict[data-lane="red"] .vlane{color:var(--kill)}
.verdict[data-lane="hold"] .vlane{color:var(--dial)}
.verdict .vb{padding:14px 16px;display:flex;flex-direction:column;gap:11px}
.reasons{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--mute)}
.reasons li::marker{color:var(--dim)}
.oblig{display:flex;flex-wrap:wrap;gap:5px}
.cite{font-family:var(--mono);font-size:10.5px;color:var(--dim);line-height:1.55;border-top:1px solid var(--line);padding-top:10px}
.blocked{background:rgba(255,51,85,.07);border:1px solid rgba(255,51,85,.32);border-radius:3px;padding:12px 14px;
         font-size:12.5px;color:var(--kill);display:flex;gap:9px;align-items:flex-start}

/* ── line pool ───────────────────────────────────────────────────────────────── */
.pool{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:8px}
.tile{border:1px solid var(--line);border-radius:3px;background:var(--raise);padding:11px 12px;
      display:flex;flex-direction:column;gap:6px;cursor:pointer;position:relative;overflow:hidden}
.tile:hover{border-color:var(--hair)}
.tile::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--dim)}
.tile[data-st="active"]::before{background:var(--go)}
.tile[data-st="resting"]::before{background:var(--hold)}
.tile[data-st="quarantined"]::before,.tile[data-st="retired"]::before{background:var(--kill)}
.tile .ph{font-family:var(--mono);font-size:13.5px;font-weight:600;letter-spacing:-.01em}
.tile .lb{font-size:11.5px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meter{height:3px;background:var(--raise2);border-radius:2px;overflow:hidden}
.meter i{display:block;height:100%;background:var(--hivis)}
.meter i.hot{background:var(--kill)}
.tile .foot{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--dim)}
.tile .live{position:absolute;top:9px;right:9px;width:6px;height:6px;border-radius:50%;background:var(--go)}

/* ── drawer ──────────────────────────────────────────────────────────────────── */
.drawer{position:fixed;inset:var(--hud) 0 0 auto;width:min(560px,92vw);background:var(--raise);
        border-left:1px solid var(--hivis);z-index:60;display:flex;flex-direction:column;
        box-shadow:-20px 0 60px rgba(0,0,0,.55);transform:translateX(100%);transition:transform .2s ease}
.drawer.open{transform:none}
@media (prefers-reduced-motion:reduce){.drawer{transition:none}}
.dh{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:12px}
.dh h2{margin:0;font-size:17px;letter-spacing:-.02em}
.db{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:18px}
.kv{display:grid;grid-template-columns:118px 1fr;gap:5px 12px;font-size:12.5px}
.kv dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--dim);padding-top:2px}
.kv dd{margin:0}
.sect{font-family:var(--mono);font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim);
       border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:9px}
.evt{display:flex;gap:10px;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--line)}
.evt .w{font-family:var(--mono);font-size:10.5px;color:var(--dim);flex:0 0 96px}
audio{width:100%;height:32px;margin-top:6px}

/* ── toast ───────────────────────────────────────────────────────────────────── */
.toasts{position:fixed;right:16px;bottom:16px;z-index:99;display:flex;flex-direction:column;gap:7px;max-width:420px}
.toast{background:var(--raise2);border:1px solid var(--hair);border-left:3px solid var(--dial);border-radius:3px;
       padding:10px 13px;font-size:12.5px;box-shadow:0 8px 26px rgba(0,0,0,.5)}
.toast.err{border-left-color:var(--kill)} .toast.ok{border-left-color:var(--go)}
.toast .t{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:3px}

.empty{padding:44px 20px;text-align:center;color:var(--dim);font-size:13px;border:1px dashed var(--line);border-radius:3px}
.hidden{display:none !important}

@media (max-width:1200px){ :root{--strip:330px;--rail:172px} }
@media (max-width:960px){
  .shell{grid-template-columns:1fr}
  .rail{position:fixed;inset:var(--hud) auto 0 0;width:var(--rail);z-index:40;transform:translateX(-100%);transition:transform .18s}
  .rail.open{transform:none}
  .strip-rail{position:fixed;inset:var(--hud) 0 0 auto;width:min(400px,94vw);z-index:41;transform:translateX(100%);transition:transform .18s}
  .strip-rail.open{transform:none}
  .dial-grid{grid-template-columns:1fr}
}
`;

const LOGIN_CSS = `
body{margin:0;background:#0B0C0E;color:#F2F4F0;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Helvetica Neue","Segoe UI",Arial,sans-serif;
     display:grid;place-items:center;min-height:100vh;padding:24px}
.card{width:min(400px,100%);border:1px solid #24282D;background:#121417;border-radius:4px;padding:28px}
h1{margin:0 0 6px;font-size:19px;letter-spacing:-.02em}
p{margin:0 0 20px;color:#8A9199;font-size:13.5px;line-height:1.55}
label{display:block;font-family:ui-monospace,Menlo,monospace;font-size:9px;letter-spacing:.18em;
      text-transform:uppercase;color:#5C636A;margin-bottom:7px}
input{width:100%;background:#0B0C0E;border:1px solid #31363C;border-radius:3px;padding:11px 13px;color:#F2F4F0;
      font-family:ui-monospace,Menlo,monospace;font-size:17px;letter-spacing:.28em}
input:focus{outline:2px solid #E3FF4F;outline-offset:1px}
button{margin-top:14px;width:100%;background:#E3FF4F;color:#0B0C0E;border:0;border-radius:3px;padding:11px;
       font-weight:600;font-size:14px;cursor:pointer}
.err{color:#FF3355;font-size:12.5px;margin-top:12px;font-family:ui-monospace,Menlo,monospace}
.note{margin-top:20px;padding-top:16px;border-top:1px solid #24282D;color:#5C636A;font-size:11.5px;
      font-family:ui-monospace,Menlo,monospace;line-height:1.6}
`;

export const LOGIN = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Cockpit</title><style>${LOGIN_CSS}</style></head><body>
<div class="card">
  <h1>Cockpit</h1>
  <p>Call and text operations for Answered. This console places real calls to real people. Enter the PIN.</p>
  <form method="POST" autocomplete="off">
    <label for="pin">PIN</label>
    <input id="pin" name="pin" type="password" inputmode="numeric" autofocus autocomplete="off">
    <button type="submit">Unlock</button>
  </form>
  ${msg ? `<div class="err">${msg}</div>` : ''}
  <div class="note">Nothing on the other side of this form is sent to your browser until the PIN is checked on the server.</div>
</div></body></html>`;

export const PAGE = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Cockpit</title><style>${CSS}</style></head><body>

<header class="hud">
  <div class="brand"><span class="pulse" id="pulse"></span><div><b>Cockpit</b><div class="tag" id="clock">--:--:--</div></div></div>
  <div class="gauges" id="gauges"></div>
  <div class="master">
    <div><div class="g" style="padding:0;border:0"><span class="k">Autopilot</span></div></div>
    <button class="sw" id="master" aria-pressed="false" aria-label="Autopilot master switch"></button>
  </div>
</header>

<div class="shell">
  <nav class="rail" id="rail">
    <div class="railhead">Operations</div>
    <div class="nav" id="nav"></div>
    <div class="railhead">Session</div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px">
      <input type="text" id="operator" placeholder="your name" aria-label="Operator name" style="width:100%">
      <button class="btn ghost" id="refresh" style="justify-content:center">Refresh now</button>
    </div>
    <div class="railhead">Keys</div>
    <div style="padding:0 16px;font-family:var(--mono);font-size:10.5px;color:var(--dim);line-height:1.9">
      1-6 view · / search<br>D dial · X hang up<br>M listen · W whisper<br>B barge · T take over<br>S suppress · Esc close
    </div>
  </nav>

  <main class="main" id="main"></main>

  <aside class="strip-rail" id="striprail">
    <div class="sr-head"><div class="sr-title" id="srTitle">No call selected</div>
      <div id="srMeta" style="color:var(--mute);font-size:12px"></div></div>
    <div class="ctrls" id="ctrls"></div>
    <div class="wf" id="wf"><div class="sr-empty">Pick a live call to watch it speak.</div></div>
  </aside>
</div>

<div class="drawer" id="drawer"><div class="dh"><div style="flex:1"><h2 id="drTitle"></h2>
  <div id="drSub" style="color:var(--mute);font-size:12.5px"></div></div>
  <button class="btn ghost" id="drClose">Close</button></div>
  <div class="db" id="drBody"></div></div>

<div class="toasts" id="toasts"></div>

<script>
"use strict";
var S = {
  view: "board", board: null, sel: null, since: 0, utts: [],
  contacts: {rows:[],total:0}, calls: [], filters: {}, drawer: null,
  dialNum: "", dialMode: "measure", verdict: null, checking: false, err: 0
};
var $ = function(id){ return document.getElementById(id); };
var el = function(tag, cls, txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; };
var esc = function(s){ var d=document.createElement("div"); d.textContent=(s==null?"":String(s)); return d.innerHTML; };
var operator = function(){ return ($("operator").value||"operator").slice(0,40); };

function toast(msg, kind){
  var t = el("div","toast"+(kind?" "+kind:""));
  t.appendChild(el("div","t", kind==="err"?"Problem":"Done"));
  t.appendChild(el("div",null,msg));
  $("toasts").appendChild(t);
  setTimeout(function(){ t.style.opacity="0"; t.style.transition="opacity .3s"; setTimeout(function(){t.remove();},320); }, kind==="err"?7000:3600);
}

function api(op, body){
  body = body || {}; body.op = op; body.operator = operator();
  return fetch(location.pathname, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  }).then(function(r){
    return r.json().catch(function(){ return {error:"server returned "+r.status}; }).then(function(j){
      if(!r.ok) throw new Error(j.error||("HTTP "+r.status));
      return j;
    });
  });
}

/* ── formatting ────────────────────────────────────────────────────────────── */
function fmtPhone(p){
  if(!p) return "";
  var d = String(p).replace(/\\D/g,"").replace(/^1/,"");
  if(d.length!==10) return p;
  return "(" + d.slice(0,3) + ") " + d.slice(3,6) + "-" + d.slice(6);
}
function clockFrom(iso){
  if(!iso) return "0:00";
  var s = Math.max(0, Math.floor((Date.now()-new Date(iso).getTime())/1000));
  var m = Math.floor(s/60);
  return m + ":" + String(s%60).padStart(2,"0");
}
function ago(iso){
  if(!iso) return "";
  var s = Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<60) return s+"s ago";
  if(s<3600) return Math.floor(s/60)+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
}

/* ── HUD ───────────────────────────────────────────────────────────────────── */
var VIEWS = [
  ["board","Board","1"],["dialer","Dialer","2"],["contacts","Contacts","3"],
  ["lines","Lines","4"],["campaigns","Autopilot","5"],["calls","History","6"]
];
function renderNav(){
  var n = $("nav"); n.innerHTML="";
  VIEWS.forEach(function(v){
    var b = el("button",null,v[1]);
    b.setAttribute("aria-current", S.view===v[0] ? "true":"false");
    var k = el("span","kb",v[2]); b.appendChild(k);
    b.onclick = function(){ go(v[0]); };
    n.appendChild(b);
  });
}
function gauge(k,v,cls){
  var g = el("div","g"); g.appendChild(el("div","k",k));
  g.appendChild(el("div","v"+(cls?" "+cls:""), v));
  return g;
}
function renderHUD(){
  var b = S.board; var g = $("gauges"); g.innerHTML="";
  if(!b){ g.appendChild(gauge("Status","...")); return; }
  var t = b.today || {};
  var live = (b.live||[]).length;
  var lines = (b.lines||[]).filter(function(l){return l.status==="active";}).length;
  g.appendChild(gauge("Live", String(live), live?"hi":""));
  g.appendChild(gauge("Lines", String(lines)+"/"+String((b.lines||[]).length)));
  g.appendChild(gauge("Placed", String(t.placed||0)));
  g.appendChild(gauge("Reached", String(t.human||0), "go"));
  g.appendChild(gauge("Machine", String(t.machine||0)));
  g.appendChild(gauge("No answer", String(t.no_answer||0)));
  g.appendChild(gauge("Refused", String(t.refused||0), (t.refused?"kill":"")));
  var talk = t.talk_seconds||0;
  g.appendChild(gauge("Talk time", Math.floor(talk/60)+"m"));
  var gate = b.gate||{};
  g.appendChild(gauge("Dialable", String((gate.green||0)+(gate.amber||0)), "go"));
  g.appendChild(gauge("Blocked", String(gate.red||0), "kill"));
  $("pulse").className = "pulse " + (S.err>2 ? "err" : "on");
}

/* ── the board ─────────────────────────────────────────────────────────────── */
function stripFor(c){
  var s = el("div","strip"); s.dataset.st = c.status||"queued";
  if(S.sel && S.sel.call_sid===c.call_sid) s.dataset.sel="1";
  s.appendChild(el("div","bar"));
  var body = el("div","body");
  var top = el("div","top");
  var name = (c.contact && c.contact.name) || "Unknown business";
  top.appendChild(el("div","who",name));
  top.appendChild(el("div","num",fmtPhone(c.to)));
  if(c.contact && c.contact.trade){ var ch=el("span","chip",c.contact.trade); top.appendChild(ch); }
  if(c.answered_by==="human"){ top.appendChild(el("span","chip green","human")); }
  else if(c.answered_by && c.answered_by.indexOf("machine")===0){ top.appendChild(el("span","chip","machine")); }
  if(c.conference_name){ top.appendChild(el("span","chip hi","conference")); }
  body.appendChild(top);
  var said = el("div","said");
  if(c.last_line){ said.innerHTML = "<b>" + esc(c.last_line.slice(0,120)) + "</b>"; }
  else { said.textContent = c.status==="ringing" ? "ringing..." : "connecting..."; }
  body.appendChild(said);
  s.appendChild(body);
  var right = el("div","right");
  var clk = el("div","clock", clockFrom(c.answered_at||c.started_at||c.queued_at));
  clk.dataset.since = c.answered_at||c.started_at||c.queued_at||"";
  right.appendChild(clk);
  right.appendChild(el("div","state", (c.status||"").replace("-"," ")));
  s.appendChild(right);
  s.onclick = function(){ select(c); };
  return s;
}

function viewBoard(){
  var m = $("main"); m.innerHTML="";
  m.appendChild(el("h1","","Live board"));
  m.appendChild(el("p","sub","Every call in flight. One strip each, with its own clock and its own last spoken line."));
  var live = (S.board && S.board.live) || [];
  if(!live.length){
    var e = el("div","empty","Nothing in flight. Open the Dialer to place a call, or arm a campaign in Autopilot.");
    m.appendChild(e);
  } else {
    var wrap = el("div","strips");
    live.forEach(function(c){ wrap.appendChild(stripFor(c)); });
    m.appendChild(wrap);
  }
  var b = S.board||{};
  var f = b.funnel||{};
  m.appendChild(el("div","eyebrow","Pipeline"));
  var tw = el("div","tablewrap"); var tb = el("table");
  tb.innerHTML = "<thead><tr><th>Stage</th><th>Contacts</th></tr></thead>";
  var body = el("tbody");
  Object.keys(f).sort(function(a,c){ return f[c]-f[a]; }).forEach(function(k){
    var tr = el("tr");
    tr.innerHTML = "<td>"+esc(k.replace(/_/g," "))+"</td><td class='n'>"+f[k]+"</td>";
    tr.onclick = function(){ S.filters={disposition:k}; go("contacts"); };
    body.appendChild(tr);
  });
  tb.appendChild(body); tw.appendChild(tb); m.appendChild(tw);
}

/* ── the dialer ────────────────────────────────────────────────────────────── */
function verdictPanel(){
  var v = S.verdict;
  var w = el("div","verdict");
  if(!v){
    w.dataset.lane = "";
    var vh0 = el("div","vh"); vh0.appendChild(el("div","vlane","--"));
    vh0.appendChild(el("div","",S.checking?"Checking the line...":"Enter a number to see whether it may be dialled."));
    w.appendChild(vh0);
    return w;
  }
  var lane = v.verdict.lane;
  w.dataset.lane = lane;
  var vh = el("div","vh");
  vh.appendChild(el("div","vlane", lane.toUpperCase()));
  vh.appendChild(el("span","chip "+lane, v.verdict.dialable ? "may be dialled" : "blocked"));
  if(v.line_type) vh.appendChild(el("span","chip", v.line_type));
  w.appendChild(vh);
  var vb = el("div","vb");
  var ul = el("ul","reasons");
  (v.verdict.reasons||[]).forEach(function(r){ ul.appendChild(el("li",null,r)); });
  vb.appendChild(ul);
  if(v.verdict.obligations && v.verdict.obligations.length){
    vb.appendChild(el("div","eyebrow","This call must carry"));
    var ob = el("div","oblig");
    v.verdict.obligations.forEach(function(o){ ob.appendChild(el("span","chip hi", o.replace(/_/g," "))); });
    vb.appendChild(ob);
  }
  if(v.verdict.retryAt){
    vb.appendChild(el("div","chip hold","opens " + new Date(v.verdict.retryAt).toLocaleString()));
  }
  vb.appendChild(el("div","cite",
    "47 CFR 64.1200(a)(1) artificial voice to a mobile needs prior express consent \\u00b7 (a)(3) the non-consented exemptions are written against a residential line \\u00b7 (b) identify the caller and give a callback number \\u00b7 FCC 24-17 an AI voice is an artificial voice \\u00b7 Cal. AB 2905 disclose the AI at the open."));
  w.appendChild(vb);
  return w;
}

function checkGate(){
  var d = S.dialNum.replace(/\\D/g,"");
  if(d.length < 10){ S.verdict=null; renderView(); return; }
  S.checking = true; renderView();
  api("gatecheck",{phone:"+1"+d.slice(-10)}).then(function(r){
    S.verdict = r; S.checking=false; renderView();
  }).catch(function(e){ S.checking=false; S.verdict=null; toast(e.message,"err"); renderView(); });
}

function viewDialer(){
  var m = $("main"); m.innerHTML="";
  m.appendChild(el("h1","","Dialer"));
  m.appendChild(el("p","sub","Every number is checked before the button works. There is no override, because there is no lawful one."));
  var grid = el("div","dial-grid");

  var left = el("div");
  var ro = el("div","readout");
  if(S.dialNum){ ro.textContent = fmtPhone("+1"+S.dialNum.replace(/\\D/g,"")); }
  else { ro.innerHTML = "<span class='ph'>(___) ___-____</span>"; }
  left.appendChild(ro);
  var pad = el("div","pad");
  ["1","2","3","4","5","6","7","8","9","*","0","#"].forEach(function(k){
    var b = el("button",null,k);
    b.onclick = function(){
      if(k==="*"||k==="#") return;
      S.dialNum = (S.dialNum + k).slice(0,10); renderView(); if(S.dialNum.length===10) checkGate();
    };
    pad.appendChild(b);
  });
  left.appendChild(pad);
  var row = el("div","bar-row"); row.style.marginTop="10px";
  var back = el("button","btn ghost","Delete");
  back.onclick = function(){ S.dialNum = S.dialNum.slice(0,-1); S.verdict=null; renderView(); };
  var clr = el("button","btn ghost","Clear");
  clr.onclick = function(){ S.dialNum=""; S.verdict=null; renderView(); };
  row.appendChild(back); row.appendChild(clr);
  left.appendChild(row);

  var right = el("div");
  var modeRow = el("div","bar-row");
  var sel = el("select");
  [["measure","Measure - answer rate study, asks nothing"],["discovery","Discovery - one question, then the offer"],["conference","Conference - you talk, joined by phone"]]
    .forEach(function(o){ var op=el("option",null,o[1]); op.value=o[0]; if(S.dialMode===o[0])op.selected=true; sel.appendChild(op); });
  sel.onchange = function(){ S.dialMode = sel.value; };
  modeRow.appendChild(el("span","eyebrow","Script"));
  modeRow.appendChild(sel);
  right.appendChild(modeRow);
  right.appendChild(verdictPanel());

  var act = el("div","bar-row"); act.style.marginTop="14px";
  var canDial = S.verdict && S.verdict.verdict && S.verdict.verdict.dialable;
  if(S.verdict && !canDial){
    var blk = el("div","blocked");
    blk.appendChild(el("div","","\\u2715"));
    blk.appendChild(el("div","", "This number cannot be dialled from this console. " + ((S.verdict.verdict.reasons||[])[0]||"")));
    right.appendChild(blk);
  } else {
    var dial = el("button","btn primary","Place the call");
    dial.disabled = !canDial;
    dial.onclick = function(){
      dial.disabled = true;
      api("dial",{phone:"+1"+S.dialNum.replace(/\\D/g,""), mode:S.dialMode}).then(function(r){
        if(r.placed){ toast("Calling " + fmtPhone("+1"+S.dialNum) + " \\u00b7 " + r.call_sid,"ok"); S.dialNum=""; S.verdict=null; go("board"); }
        else { toast("Refused: " + ((r.gate&&r.gate.reasons||[]).join("; ")||"blocked"),"err"); renderView(); }
        tick();
      }).catch(function(e){ toast(e.message,"err"); dial.disabled=false; });
    };
    act.appendChild(dial);
    right.appendChild(act);
  }
  grid.appendChild(left); grid.appendChild(right);
  m.appendChild(grid);
}

/* ── contacts ──────────────────────────────────────────────────────────────── */
function loadContacts(){
  var f = Object.assign({limit:200}, S.filters);
  api("contacts", f).then(function(r){ S.contacts = r; if(S.view==="contacts") renderView(); })
    .catch(function(e){ toast(e.message,"err"); });
}
function viewContacts(){
  var m = $("main"); m.innerHTML="";
  m.appendChild(el("h1","","Contacts"));
  m.appendChild(el("p","sub", (S.contacts.total||0) + " in the book. Click a row for everything we know and everything we said."));
  var bar = el("div","bar-row");
  var q = el("input"); q.type="search"; q.placeholder="name, number or city"; q.id="q"; q.value=S.filters.q||"";
  q.onkeydown = function(e){ if(e.key==="Enter"){ S.filters.q=q.value||null; loadContacts(); } };
  bar.appendChild(q);
  [["lane","Lane",["","green","amber","red","hold"]],
   ["disposition","Stage",["","new","queued","attempted","reached","interested","shadow_week","callback","not_interested","do_not_call","customer"]],
   ["lineType","Line type",["","landline","fixedVoip","mobile","nonFixedVoip","tollFree"]]]
   .forEach(function(f){
     var s = el("select");
     f[2].forEach(function(o){ var op=el("option",null,o||("Any "+f[1].toLowerCase())); op.value=o; if((S.filters[f[0]]||"")===o)op.selected=true; s.appendChild(op); });
     s.onchange = function(){ S.filters[f[0]] = s.value||null; loadContacts(); };
     bar.appendChild(s);
   });
  var clr = el("button","btn ghost","Reset"); clr.onclick=function(){ S.filters={}; loadContacts(); };
  bar.appendChild(clr);
  m.appendChild(bar);

  var tw = el("div","tablewrap"); var t = el("table");
  t.innerHTML = "<thead><tr><th>Business</th><th>Number</th><th>Line</th><th>Lane</th><th>Trade</th><th>Where</th><th>Stage</th><th>Calls</th><th>Last</th></tr></thead>";
  var tb = el("tbody");
  (S.contacts.rows||[]).forEach(function(c){
    var tr = el("tr");
    tr.innerHTML =
      "<td>"+esc(c.name||"Unknown")+(c.suppressed?" <span class='chip red'>stop</span>":"")+"</td>"+
      "<td class='n'>"+fmtPhone(c.phone)+"</td>"+
      "<td>"+esc(c.line_type||"?")+"</td>"+
      "<td><span class='chip "+esc(c.lane||"")+"'>"+esc(c.lane||"unchecked")+"</span></td>"+
      "<td>"+esc(c.trade||"")+"</td>"+
      "<td>"+esc([c.city,c.state].filter(Boolean).join(", "))+"</td>"+
      "<td>"+esc((c.disposition||"").replace(/_/g," "))+"</td>"+
      "<td class='n'>"+(c.call_count||0)+"</td>"+
      "<td>"+esc(ago(c.last_contacted_at))+"</td>";
    tr.onclick = function(){ openContact(c.id); };
    tb.appendChild(tr);
  });
  t.appendChild(tb); tw.appendChild(t); m.appendChild(tw);
}

/* ── lines ─────────────────────────────────────────────────────────────────── */
function viewLines(){
  var m = $("main"); m.innerHTML="";
  var lines = (S.board && S.board.lines) || [];
  m.appendChild(el("h1","","Line pool"));
  m.appendChild(el("p","sub", lines.length + " numbers. A number that dials hard gets rested before the carriers rest it for you."));
  var bar = el("div","bar-row");
  var sync = el("button","btn","Adopt every Twilio number");
  sync.onclick = function(){ sync.disabled=true; api("syncnumbers").then(function(r){ toast("Adopted "+r.synced+" numbers","ok"); tick(); }).catch(function(e){toast(e.message,"err");}).finally(function(){sync.disabled=false;}); };
  bar.appendChild(sync);
  var ac = el("input"); ac.type="text"; ac.placeholder="area code"; ac.style.width="110px"; ac.id="ac";
  var find = el("button","btn","Find numbers to add");
  find.onclick = function(){
    find.disabled=true;
    api("searchnumbers",{area_code:ac.value||null,limit:8}).then(function(r){
      var box = $("numresults"); box.innerHTML="";
      (r.numbers||[]).forEach(function(n){
        var row = el("div","bar-row");
        row.appendChild(el("span","mono",fmtPhone(n.phone_number)));
        row.appendChild(el("span","chip",(n.locality||"")+" "+(n.region||"")));
        var buy = el("button","btn primary","Add to pool");
        buy.onclick = function(){ buy.disabled=true; api("provision",{phone_number:n.phone_number,purpose:"research"})
          .then(function(){ toast("Added "+fmtPhone(n.phone_number),"ok"); box.innerHTML=""; tick(); })
          .catch(function(e){ toast(e.message,"err"); buy.disabled=false; }); };
        row.appendChild(buy);
        box.appendChild(row);
      });
      if(!(r.numbers||[]).length) box.appendChild(el("div","empty","Nothing available for that area code."));
    }).catch(function(e){toast(e.message,"err");}).finally(function(){find.disabled=false;});
  };
  bar.appendChild(ac); bar.appendChild(find);
  m.appendChild(bar);
  var box = el("div"); box.id="numresults"; m.appendChild(box);

  if(!lines.length){ m.appendChild(el("div","empty","No numbers in the pool yet. Adopt the ones the Twilio account already owns, or add a new one.")); return; }
  var pool = el("div","pool");
  lines.forEach(function(l){
    var t = el("div","tile"); t.dataset.st = l.status;
    if(l.active_now) t.appendChild(el("div","live"));
    t.appendChild(el("div","ph", fmtPhone(l.phone)));
    t.appendChild(el("div","lb", l.label || l.purpose));
    var pct = Math.min(100, Math.round(((l.calls_today||0)/(l.daily_cap||80))*100));
    var mtr = el("div","meter"); var i = el("i"); i.style.width = pct+"%"; if(pct>85) i.className="hot";
    mtr.appendChild(i); t.appendChild(mtr);
    var foot = el("div","foot");
    foot.appendChild(el("span",null,(l.calls_today||0)+"/"+(l.daily_cap||80)+" today"));
    foot.appendChild(el("span",null,l.reputation||"unknown"));
    t.appendChild(foot);
    t.onclick = function(){
      var next = l.status==="active" ? "resting" : "active";
      api("lineupdate",{phone:l.phone,purpose:l.purpose,status:next,daily_cap:l.daily_cap,label:l.label})
        .then(function(){ toast(fmtPhone(l.phone)+" is now "+next,"ok"); tick(); })
        .catch(function(e){toast(e.message,"err");});
    };
    pool.appendChild(t);
  });
  m.appendChild(pool);
}

/* ── campaigns ─────────────────────────────────────────────────────────────── */
function viewCampaigns(){
  var m = $("main"); m.innerHTML="";
  m.appendChild(el("h1","","Autopilot"));
  m.appendChild(el("p","sub","A campaign only ever dials what the gate has already cleared. Pausing is instant; the queue is not consumed until a call is placed."));
  var cs = (S.board && S.board.campaigns) || [];
  var bar = el("div","bar-row");
  var name = el("input"); name.type="text"; name.placeholder="campaign name"; name.style.minWidth="220px";
  var mode = el("select");
  [["measure","Measure"],["discovery","Discovery"]].forEach(function(o){var op=el("option",null,o[1]);op.value=o[0];mode.appendChild(op);});
  var mk = el("button","btn primary","Create");
  mk.onclick = function(){
    if(!name.value) return toast("Give it a name","err");
    api("campaign",{name:name.value,mode:mode.value,status:"draft"}).then(function(){ toast("Created","ok"); name.value=""; tick(); })
      .catch(function(e){toast(e.message,"err");});
  };
  bar.appendChild(name); bar.appendChild(mode); bar.appendChild(mk);
  m.appendChild(bar);

  if(!cs.length){ m.appendChild(el("div","empty","No campaigns yet.")); return; }
  var tw = el("div","tablewrap"); var t = el("table");
  t.innerHTML="<thead><tr><th>Campaign</th><th>Script</th><th>State</th><th>Placed</th><th>Refused</th><th>Reached</th><th>Queue</th><th>Pace</th><th></th></tr></thead>";
  var tb = el("tbody");
  cs.forEach(function(c){
    var tr = el("tr");
    var td = function(h){ var d=el("td"); d.innerHTML=h; return d; };
    tr.appendChild(td(esc(c.name)+(c.halt_reason?"<div style='color:var(--kill);font-size:11px'>"+esc(c.halt_reason)+"</div>":"")));
    tr.appendChild(td(esc(c.mode)));
    tr.appendChild(td("<span class='chip "+(c.autopilot?"green":"")+"'>"+esc(c.status)+"</span>"));
    tr.appendChild(td("<span class='n'>"+(c.placed||0)+"</span>"));
    tr.appendChild(td("<span class='n'>"+(c.refused||0)+"</span>"));
    tr.appendChild(td("<span class='n'>"+(c.reached||0)+"</span>"));
    tr.appendChild(td("<span class='n'>"+(c.queue||0)+"</span>"));
    tr.appendChild(td("<span class='n'>"+(c.pacing_per_min||0)+"/min</span>"));
    var act = el("td");
    var b = el("button","btn"+(c.autopilot?" danger":" primary"), c.autopilot?"Pause":"Arm");
    b.onclick = function(ev){ ev.stopPropagation();
      api("autopilot",{id:c.id,name:c.name,mode:c.mode,on:!c.autopilot,pacing_per_min:c.pacing_per_min,max_concurrent:c.max_concurrent})
        .then(function(){ toast(c.autopilot?"Paused":"Armed","ok"); tick(); }).catch(function(e){toast(e.message,"err");});
    };
    act.appendChild(b); tr.appendChild(act);
    tb.appendChild(tr);
  });
  t.appendChild(tb); tw.appendChild(t); m.appendChild(tw);
}

/* ── history ───────────────────────────────────────────────────────────────── */
function loadCalls(){
  api("calls",{limit:200}).then(function(r){ S.calls = r.rows||[]; if(S.view==="calls") renderView(); })
    .catch(function(e){ toast(e.message,"err"); });
}
function viewCalls(){
  var m = $("main"); m.innerHTML="";
  m.appendChild(el("h1","","History"));
  m.appendChild(el("p","sub","Every call, including the ones the gate refused. The refusals are the evidence the gate ran."));
  var tw = el("div","tablewrap"); var t = el("table");
  t.innerHTML="<thead><tr><th>When</th><th>Business</th><th>Number</th><th>Result</th><th>Ring</th><th>Length</th><th>Outcome</th><th>Audio</th></tr></thead>";
  var tb = el("tbody");
  S.calls.forEach(function(c){
    var tr = el("tr");
    var res = !c.placed ? "<span class='chip red'>refused</span>"
      : c.answered_by==="human" ? "<span class='chip green'>human</span>"
      : (c.answered_by||"").indexOf("machine")===0 ? "<span class='chip'>machine</span>"
      : "<span class='chip'>"+esc(c.status||"")+"</span>";
    tr.innerHTML =
      "<td>"+esc(ago(c.created_at))+"</td>"+
      "<td>"+esc(c.contact_name||"")+"</td>"+
      "<td class='n'>"+fmtPhone(c.to_number)+"</td>"+
      "<td>"+res+"</td>"+
      "<td class='n'>"+(c.ring_seconds!=null?c.ring_seconds+"s":"")+"</td>"+
      "<td class='n'>"+(c.duration_seconds!=null?c.duration_seconds+"s":"")+"</td>"+
      "<td class='t'>"+esc(c.refused_reason||c.summary||(c.disposition||"").replace(/_/g," "))+"</td>"+
      "<td>"+(c.recording_url?"<span class='chip hi'>audio</span>":"")+"</td>";
    tr.onclick = function(){ if(c.contact_id) openContact(c.contact_id); };
    tb.appendChild(tr);
  });
  t.appendChild(tb); tw.appendChild(t); m.appendChild(tw);
}

/* ── contact drawer ────────────────────────────────────────────────────────── */
function openContact(id){
  api("contact",{id:id}).then(function(r){
    S.drawer = r; var c = r.contact || {};
    $("drTitle").textContent = c.name || "Unknown business";
    $("drSub").textContent = [fmtPhone(c.phone), c.trade, [c.city,c.state].filter(Boolean).join(", ")].filter(Boolean).join(" \\u00b7 ");
    var b = $("drBody"); b.innerHTML="";

    var kv = el("dl","kv");
    [["Line type", c.line_type||"unchecked"],["Carrier", c.carrier||""],["Lane", c.lane||"unchecked"],
     ["Stage",(c.disposition||"").replace(/_/g," ")],["Calls", String(c.call_count||0)],
     ["Suppressed", c.suppressed ? ("yes \\u00b7 "+(c.suppressed_reason||"")) : "no"],
     ["Source", c.source||""],["Website", c.website||""]]
     .forEach(function(p){ kv.appendChild(el("dt",null,p[0])); kv.appendChild(el("dd",null,p[1])); });
    b.appendChild(kv);

    if((c.lane_reasons||[]).length){
      var lr = el("div"); lr.appendChild(el("div","sect","Gate reasoning"));
      var ul = el("ul","reasons"); c.lane_reasons.forEach(function(x){ ul.appendChild(el("li",null,x)); });
      lr.appendChild(ul); b.appendChild(lr);
    }

    var actions = el("div","bar-row");
    var dial = el("button","btn primary","Call this shop");
    dial.disabled = c.suppressed;
    dial.onclick = function(){ dial.disabled=true;
      api("dial",{contact_id:c.id,mode:S.dialMode}).then(function(r){
        if(r.placed){ toast("Calling "+(c.name||fmtPhone(c.phone)),"ok"); closeDrawer(); go("board"); }
        else { toast("Refused: "+((r.gate&&r.gate.reasons||[]).join("; ")),"err"); dial.disabled=false; }
        tick();
      }).catch(function(e){toast(e.message,"err");dial.disabled=false;});
    };
    actions.appendChild(dial);
    var supp = el("button","btn danger","Never call again");
    supp.onclick = function(){ api("suppress",{phone:c.phone,reason:"suppressed by "+operator()})
      .then(function(){ toast("Suppressed","ok"); openContact(id); }).catch(function(e){toast(e.message,"err");}); };
    actions.appendChild(supp);
    b.appendChild(actions);

    var dsel = el("div","bar-row");
    dsel.appendChild(el("span","eyebrow","Set stage"));
    var ds = el("select");
    ["new","queued","attempted","reached","interested","shadow_week","callback","not_interested","customer"].forEach(function(o){
      var op=el("option",null,o.replace(/_/g," ")); op.value=o; if(c.disposition===o)op.selected=true; ds.appendChild(op); });
    ds.onchange=function(){ api("disposition",{id:c.id,disposition:ds.value}).then(function(){toast("Stage updated","ok");}).catch(function(e){toast(e.message,"err");}); };
    dsel.appendChild(ds); b.appendChild(dsel);

    var nt = el("div");
    nt.appendChild(el("div","sect","Notes"));
    var ta = el("textarea"); ta.rows=2; ta.placeholder="what you learned";
    var add = el("button","btn","Save note"); add.style.marginTop="7px";
    add.onclick=function(){ if(!ta.value.trim())return; api("note",{contact_id:c.id,body:ta.value})
      .then(function(){ ta.value=""; openContact(id); }).catch(function(e){toast(e.message,"err");}); };
    nt.appendChild(ta); nt.appendChild(add);
    (r.notes||[]).forEach(function(n){
      var e = el("div","evt"); e.appendChild(el("div","w",ago(n.at)));
      e.appendChild(el("div",null,n.body + (n.author?" \\u2014 "+n.author:""))); nt.appendChild(e);
    });
    b.appendChild(nt);

    var ch = el("div"); ch.appendChild(el("div","sect","Calls"));
    if(!(r.calls||[]).length) ch.appendChild(el("div","empty","Never called."));
    (r.calls||[]).forEach(function(x){
      var e = el("div","evt");
      e.appendChild(el("div","w",ago(x.created_at)));
      var d = el("div");
      d.innerHTML = (x.placed ? esc(x.answered_by||x.status||"") : "<span style='color:var(--kill)'>refused: "+esc(x.refused_reason||"")+"</span>")
        + (x.duration_seconds?" \\u00b7 "+x.duration_seconds+"s":"");
      if(x.recording_url){
        var au = el("audio"); au.controls=true; au.preload="none"; au.src = x.recording_url; d.appendChild(au);
      }
      if(x.transcript){ var tr=el("div"); tr.style.cssText="color:var(--mute);font-size:12px;margin-top:5px"; tr.textContent=x.transcript.slice(0,600); d.appendChild(tr); }
      e.appendChild(d); ch.appendChild(e);
    });
    b.appendChild(ch);

    $("drawer").classList.add("open");
  }).catch(function(e){ toast(e.message,"err"); });
}
function closeDrawer(){ $("drawer").classList.remove("open"); S.drawer=null; }

/* ── the active call rail ──────────────────────────────────────────────────── */
function select(c){
  S.sel = c; S.since = 0; S.utts = [];
  $("srTitle").textContent = (c.contact && c.contact.name) || fmtPhone(c.to);
  $("srMeta").textContent = [fmtPhone(c.to), (c.status||"").replace("-"," "), c.answered_by||""].filter(Boolean).join(" \\u00b7 ");
  $("wf").innerHTML = "";
  renderCtrls();
  pollTranscript();
  if(window.innerWidth<=960) $("striprail").classList.add("open");
  renderView();
}
function ctrlBtn(label, key, cls, fn, disabled){
  var b = el("button", cls||"");
  b.appendChild(el("span",null,label));
  b.appendChild(el("span","kb",key));
  b.disabled = !!disabled; b.onclick = fn;
  return b;
}
function renderCtrls(){
  var c = $("ctrls"); c.innerHTML="";
  var s = S.sel;
  var inConf = !!(s && s.conference_name);
  var live = !!(s && (s.status==="in-progress"||s.status==="ringing"));
  c.appendChild(ctrlBtn("Listen","M","", function(){ callOp("monitor"); }, !s||!inConf));
  c.appendChild(ctrlBtn("Whisper","W","", function(){ callOp("whisper"); }, !s||!inConf));
  c.appendChild(ctrlBtn("Barge","B","", function(){ callOp("barge"); }, !s||!inConf));
  c.appendChild(ctrlBtn("Take over","T","hot", function(){ callOp("takeover"); }, !s||!live));
  c.appendChild(ctrlBtn("Suppress","S","danger", function(){
    if(!S.sel) return;
    api("suppress",{phone:S.sel.to,reason:"suppressed from the console by "+operator()})
      .then(function(){ toast("Number suppressed","ok"); }).catch(function(e){toast(e.message,"err");});
  }, !s));
  c.appendChild(ctrlBtn("Hang up","X","danger", function(){
    if(!S.sel) return;
    api("hangup",{call_sid:S.sel.call_sid}).then(function(){ toast("Ended","ok"); tick(); }).catch(function(e){toast(e.message,"err");});
  }, !s||!live));
}
function callOp(op){
  if(!S.sel) return;
  api(op,{call_sid:S.sel.call_sid, conference_name:S.sel.conference_name})
    .then(function(r){
      if(r.operator_leg_error) toast("Call moved to a conference, but your phone leg failed: "+r.operator_leg_error,"err");
      else if(op==="takeover") toast("You are being called in. Pick up.","ok");
      else toast(op+" leg placed. Pick up your phone.","ok");
      tick();
    })
    .catch(function(e){ toast(e.message,"err"); });
}
function pollTranscript(){
  if(!S.sel) return;
  api("transcript",{call_sid:S.sel.call_sid, since:S.since}).then(function(r){
    var lines = r.lines||[];
    if(lines.length){
      S.since = lines[lines.length-1].id;
      var wf = $("wf");
      if(!S.utts.length) wf.innerHTML="";
      lines.forEach(function(l){
        var key = l.track+":"+l.seq;
        var existing = wf.querySelector('[data-k="'+key+'"]');
        if(existing){
          existing.querySelector(".txt").textContent = l.text;
          existing.className = "utt " + (l.speaker==="us"?"us":"them") + (l.is_final?"":" partial");
        } else {
          var u = el("div","utt " + (l.speaker==="us"?"us":"them") + (l.is_final?"":" partial"));
          u.dataset.k = key;
          u.appendChild(el("div","lab", l.speaker==="us" ? "Answered" : "Them"));
          u.appendChild(el("div","txt", l.text));
          wf.appendChild(u);
          S.utts.push(l);
        }
      });
      wf.scrollTop = wf.scrollHeight;
    }
  }).catch(function(){ /* a transcript gap is not worth a toast */ });
}

/* ── loop ──────────────────────────────────────────────────────────────────── */
function renderView(){
  renderNav();
  if(S.view==="board") viewBoard();
  else if(S.view==="dialer") viewDialer();
  else if(S.view==="contacts") viewContacts();
  else if(S.view==="lines") viewLines();
  else if(S.view==="campaigns") viewCampaigns();
  else if(S.view==="calls") viewCalls();
}
function go(v){
  S.view = v;
  if(v==="contacts" && !(S.contacts.rows||[]).length) loadContacts();
  if(v==="calls") loadCalls();
  renderView();
  if(window.innerWidth<=960) $("rail").classList.remove("open");
}
function tick(){
  api("board").then(function(r){
    S.board = r; S.err = 0;
    renderHUD();
    if(S.sel){
      var found = (r.live||[]).filter(function(c){ return c.call_sid===S.sel.call_sid; })[0];
      if(found){ S.sel = found; $("srMeta").textContent = [fmtPhone(found.to),(found.status||"").replace("-"," "),found.answered_by||""].filter(Boolean).join(" \\u00b7 "); }
      renderCtrls();
    }
    if(S.view==="board"||S.view==="lines"||S.view==="campaigns") renderView();
    var m = (r.campaigns||[]).some(function(c){ return c.autopilot; });
    $("master").setAttribute("aria-pressed", m ? "true":"false");
  }).catch(function(e){
    S.err++; $("pulse").className = "pulse err";
    if(S.err===1) toast(e.message,"err");
  });
}
function clocks(){
  document.querySelectorAll(".clock").forEach(function(c){
    if(c.dataset.since) c.textContent = clockFrom(c.dataset.since);
  });
  var d = new Date();
  $("clock").textContent = String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")+":"+String(d.getSeconds()).padStart(2,"0");
}

document.addEventListener("keydown", function(e){
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){
    if(e.key==="Escape") document.activeElement.blur();
    return;
  }
  var k = e.key.toLowerCase();
  var idx = "123456".indexOf(k);
  if(idx>=0){ go(VIEWS[idx][0]); return; }
  if(k==="/"){ e.preventDefault(); go("contacts"); setTimeout(function(){ var q=$("q"); if(q)q.focus(); },40); return; }
  if(k==="d"){ go("dialer"); return; }
  if(k==="escape"){ closeDrawer(); $("striprail").classList.remove("open"); return; }
  if(!S.sel) return;
  if(k==="m") callOp("monitor");
  if(k==="w") callOp("whisper");
  if(k==="b") callOp("barge");
  if(k==="t") callOp("takeover");
  if(k==="x") api("hangup",{call_sid:S.sel.call_sid}).then(function(){toast("Ended","ok");tick();}).catch(function(e){toast(e.message,"err");});
  if(k==="s") api("suppress",{phone:S.sel.to,reason:"suppressed from the console by "+operator()}).then(function(){toast("Suppressed","ok");});
});

$("drClose").onclick = closeDrawer;
$("refresh").onclick = function(){ tick(); if(S.view==="contacts") loadContacts(); if(S.view==="calls") loadCalls(); };
$("master").onclick = function(){
  var cs = (S.board && S.board.campaigns) || [];
  var anyOn = cs.some(function(c){ return c.autopilot; });
  if(!cs.length){ toast("No campaigns to arm. Create one in Autopilot.","err"); return; }
  Promise.all(cs.map(function(c){
    return api("autopilot",{id:c.id,name:c.name,mode:c.mode,on:!anyOn,pacing_per_min:c.pacing_per_min,max_concurrent:c.max_concurrent});
  })).then(function(){ toast(anyOn?"All campaigns paused":"All campaigns armed","ok"); tick(); })
    .catch(function(e){ toast(e.message,"err"); });
};
try{ $("operator").value = localStorage.getItem("ans_op")||""; }catch(e){}
$("operator").onchange = function(){ try{ localStorage.setItem("ans_op",$("operator").value); }catch(e){} };

renderNav(); renderView(); tick();
setInterval(tick, 2500);
setInterval(clocks, 1000);
setInterval(function(){ if(S.sel) pollTranscript(); }, 1200);
</script>
</body></html>`;
