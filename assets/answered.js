/* ═══════════════════════════════════════════════════════════════════════════
   ANSWERED — motion.
   One rAF loop. Canvas 2D only. Transform and opacity only in CSS.
   Nothing here fabricates data: the ring's idle state is the North American
   ring cadence (2s on, 4s off), and its live state is driven by real audio
   amplitude from the visitor's own microphone, only after they ask for it.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ── THE LOAD MOMENT. The page does not load, it answers. 700ms total: the
     mark's arcs fire twice on the ring cadence while the interface unfolds
     upward from the stem baseline. Any scroll or input interrupts it
     permanently. Under prefers-reduced-motion it never runs at all. */
  (function () {
    var root = document.documentElement;
    if (reduced.matches || !document.querySelector('.bt')) {
      root.classList.add('answered-in');
      return;
    }
    var done = false;
    var t = setTimeout(finish, 700);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(t);
      root.classList.remove('answering');
      root.classList.add('answered-in');
    }
    root.classList.add('answering');
    ['scroll', 'wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (ev) {
      window.addEventListener(ev, finish, { once: true, passive: true });
    });
  })();

  /* ── nav ────────────────────────────────────────────────────────────── */
  var nav = document.querySelector('.nav');
  if (nav) {
    var pin = function () {
      nav.classList.toggle('pinned', window.scrollY > 8);
      document.documentElement.classList.toggle('scrolled', window.scrollY > 60);
    };
    pin();
    window.addEventListener('scroll', pin, { passive: true });
  }

  var burger = document.querySelector('.burger');
  var sheet = document.querySelector('.sheet');
  if (burger && sheet) {
    burger.addEventListener('click', function () {
      var open = burger.getAttribute('aria-expanded') === 'true';
      burger.setAttribute('aria-expanded', String(!open));
      sheet.classList.toggle('open', !open);
      document.body.style.overflow = !open ? 'hidden' : '';
    });
    sheet.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        burger.setAttribute('aria-expanded', 'false');
        sheet.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sheet.classList.contains('open')) { burger.click(); }
    });
  }

  /* ── reveal ─────────────────────────────────────────────────────────── */
  var rv = document.querySelectorAll('.rv');
  var press = document.querySelectorAll('.press');
  if (!('IntersectionObserver' in window) || reduced.matches) {
    for (var i = 0; i < rv.length; i++) { rv[i].classList.add('in'); }
    for (var i2 = 0; i2 < press.length; i2++) { press[i2].classList.add('in'); }
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    for (var j = 0; j < rv.length; j++) { io.observe(rv[j]); }
    /* .press gets its OWN observer at threshold 0. measured 2026-08-13:
       Chrome factors the target's own clip-path into intersectionRatio, so
       the resting press plate (an 8% band) reads ~0.074 and a 0.08 gate
       NEVER opens the plate it is hiding. the reveal-gate lesson, live:
       the hidden state must not be what keeps the gate shut. */
    var pio2 = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); pio2.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0 });
    for (var j2 = 0; j2 < press.length; j2++) { pio2.observe(press[j2]); }
  }


  /* ── the conveyor belt, the phone card and the showcase dot animate only
     while actually on screen. the CSS is authored paused under html.js; this
     observer's .go class is the only thing that lets any of them spend a
     frame. no observer (or reduced motion) means a resting, legible state. */
  var belts = document.querySelectorAll('.convey, .phone, .showcase');
  if (belts.length && 'IntersectionObserver' in window && !reduced.matches) {
    /* the conveyor's chips cascade up once before the belt starts rolling.
       staging only happens here, under JS with an observer present, so a
       JS-off or observer-less reader keeps the resting, visible chips. */
    document.querySelectorAll('.convey').forEach(function (c) {
      c.classList.add('stage');
      var chips = c.querySelectorAll('.cv-chip');
      for (var ci = 0; ci < chips.length; ci++) {
        chips[ci].style.setProperty('--ci', String(ci % 20));
      }
    });
    var bio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        e.target.classList.toggle('go', e.isIntersecting);
        if (e.isIntersecting && e.target.classList.contains('stage')) {
          e.target.classList.add('up');
        }
      });
    }, { threshold: 0 });
    belts.forEach(function (b) { bio.observe(b); });
  }

  /* ── the seam answers: each section hairline draws itself and fires one
     pulse down the line as it enters view. one-shot, information not
     perfume. no observer or reduced motion leaves the resting hairline. ── */
  /* class is sm-in, NEVER "lit": .lit is the hero's one-loud-word color rule,
     and reusing it painted every seam section's text Hi-Vis on paper
     (measured 2026-08-13, ledger labels at rgb(227,255,79) on bone). */
  var seams = document.querySelectorAll('.seam');
  if (seams.length) {
    if (!('IntersectionObserver' in window) || reduced.matches) {
      seams.forEach(function (s) { s.classList.add('sm-in'); });
    } else {
      var seio = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('sm-in'); seio.unobserve(e.target); }
        });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0 });
      seams.forEach(function (s) { seio.observe(s); });
    }
  }

  /* ── line-mask reveal ─────────────────────────────────────────────────────
     Splits on the authored <br> only. That is deterministic, it preserves the
     nested .lit spans, and it matches the breaks the design already chose,
     which measuring line boxes would not. */
  if (!reduced.matches) {
    var heads = document.querySelectorAll('h1.display.rv, h2.h2.rv, .pull.rv');
    for (var hi = 0; hi < heads.length; hi++) {
      var el = heads[hi];
      if (el.querySelector('.ln')) continue;
      var parts = el.innerHTML.split(/<br\s*\/?>/i);
      if (parts.length < 2 && el.textContent.trim().length < 28) continue;
      // joined with a space, not with nothing. The spans are display:block so the
      // whitespace collapses and changes nothing visually, but it keeps
      // textContent correct for anything that reads the DOM without layout.
      // Without it, "An AI that works" + "the phone for you" reads as
      // "...worksthe phone..." to any layout-blind reader.
      el.innerHTML = parts.map(function (p) {
        return '<span class="ln"><span class="ln-i">' + p + '</span></span>';
      }).join(' ');
      el.classList.add('split');
    }
  }

  /* ── HERO ENTRANCE 2.0: the headline splits per WORD, each word masked in
     its own clip box, rising off the baseline once the interface has
     unfolded (kinetic type in doses, corpus technique 21). Split only under
     JS and full motion, so JS-off and reduced motion read plain text. ── */
  if (!reduced.matches) {
    var heroHeads = document.querySelectorAll('.hero h1.display');
    for (var hh = 0; hh < heroHeads.length; hh++) {
      (function (head) {
        var wi = 0;
        var wrapWords = function (node) {
          var kids = [].slice.call(node.childNodes);
          kids.forEach(function (k) {
            if (k.nodeType === 1) { wrapWords(k); return; }
            if (k.nodeType !== 3 || !k.textContent.trim()) return;
            var frag = document.createDocumentFragment();
            k.textContent.split(/(\s+)/).forEach(function (part) {
              if (!part) return;
              if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
              var o = document.createElement('span'); o.className = 'wd';
              var inner = document.createElement('span'); inner.className = 'wd-i';
              inner.textContent = part;
              inner.style.setProperty('--wi', String(wi++));
              o.appendChild(inner); frag.appendChild(o);
            });
            node.replaceChild(frag, k);
          });
        };
        wrapWords(head);
      })(heroHeads[hh]);
    }
  }

  /* ── THE PRESS ARC. Every button press emits ONE concentric arc from the
     press point on the mark's own axis. 420ms, opacity .5 to 0, transform and
     opacity only. This ties every interaction back to the logo without ever
     showing the logo. */
  if (!reduced.matches) {
    document.addEventListener('pointerdown', function (e) {
      var b = e.target && e.target.closest
        ? e.target.closest('.btn, .nav-cta, .pc-cta, .seg-b, .card-go')
        : null;
      if (!b) return;
      var r = b.getBoundingClientRect();
      var s = document.createElement('span');
      s.className = 'parc';
      s.setAttribute('aria-hidden', 'true');
      s.style.left = (e.clientX - r.left) + 'px';
      s.style.top = (e.clientY - r.top) + 'px';
      b.appendChild(s);
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 460);
    }, { passive: true });
  }

  /* ── reading progress ───────────────────────────────────────────────────── */
  if (!reduced.matches) {
    var bar = document.createElement('div');
    bar.className = 'prog';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    var ticking = false;
    var setProg = function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var p = h > 0 ? Math.min(1, window.scrollY / h) : 0;
      bar.style.transform = 'scaleX(' + p + ')';
      ticking = false;
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(setProg); }
    }, { passive: true });
    setProg();
  }

  /* ── count up. only on elements carrying a real, cited value: data-count
     counts with prefix/suffix, data-settle is the same motion for a bare
     numeral like the 30 in "30s". the attribute holds the true figure and
     the markup ships with it already printed, so JS-off never loses it. ── */
  var counters = document.querySelectorAll('[data-count], [data-settle]');
  if (counters.length && 'IntersectionObserver' in window) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        cio.unobserve(en.target);
        var el = en.target;
        var to = parseFloat(el.getAttribute('data-count') || el.getAttribute('data-settle'));
        var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
        var pre = el.getAttribute('data-pre') || '';
        var suf = el.getAttribute('data-suf') || '';
        if (reduced.matches || isNaN(to)) { el.textContent = pre + to.toFixed(dec) + suf; return; }
        /* the desk count-up law (DESK-SPEC, desk.js:58): start at 90% of the
           target, settle inside 550ms, land exactly. never a 0-to-N ticker,
           because those read as math errors. */
        var from = to * 0.9, t0 = null, dur = 520;
        el.classList.add('num-in');
        var tick = function (ts) {
          if (t0 === null) t0 = ts;
          var p = Math.min(1, (ts - t0) / dur);
          var e = 1 - Math.pow(1 - p, 3);
          el.textContent = pre + (from + (to - from) * e).toFixed(dec) + suf;
          if (p < 1) requestAnimationFrame(tick);
          else el.textContent = pre + to.toFixed(dec) + suf;
        };
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.5 });
    for (var k = 0; k < counters.length; k++) { cio.observe(counters[k]); }
  }

  /* ── THE RING ───────────────────────────────────────────────────────────
     A ring of radial ticks. Idle: the North American ring cadence, two
     seconds of ringing and four of silence, resolving to Answered, so the hero
     shows the product happening. Live: tick length is driven by real FFT bins
     from the visitor's own mic. There is no fake waveform state.
     ────────────────────────────────────────────────────────────────────── */
  var stage = document.querySelector('.ring-stage');
  if (stage) {
    var cv = stage.querySelector('canvas');
    var ctx = cv.getContext('2d', { alpha: true });
    var stateEl = stage.querySelector('.ring-state');
    var N = 132;                 // ticks
    var dpr = 1, W = 0, H = 0, R = 0;
    var t = 0, t0ref = -1, raf = 0, onScreen = true, tabShown = !document.hidden;
    var live = false, analyser = null, bins = null, stream = null;
    var smooth = new Float32Array(N);

    /* the answer wave: when the ring resolves to Answered, one ring leaves
       the bezel and dies. calls in flight: three faint dots orbit outside
       the ring; on each answer, one of them lands into the line. decoration
       that describes the cadence and nothing else. */
    var waves = [];
    var comets = [];
    var wasRinging = true;
    var seedComet = function (c) {
      c.ang = Math.random() * Math.PI * 2;
      c.av = 0.00010 + Math.random() * 0.00008;
      c.rr = 1.45 + Math.random() * 0.42;      // in units of R
      c.landing = 0;
      return c;
    };
    for (var ci0 = 0; ci0 < 3; ci0++) { comets.push(seedComet({})); }
    var answers = 0;

    /* THE SIGNAL FIELD: the ambient canvas behind the whole hero. sparse
       signal ticks drifting through the dark, pulsing on the same cadence
       the ring runs. seeded, so layout is identical across frames and
       resizes (the price-field shimmer lesson). */
    var hero = document.querySelector('.hero');
    var fcv = hero ? hero.querySelector('.hero-field') : null;
    var fctx = fcv ? fcv.getContext('2d', { alpha: true }) : null;
    var FW = 0, FH = 0, fdpr = 1, marks = [];
    var fresize = function () {
      if (!fcv) return;
      var r = fcv.getBoundingClientRect();
      fdpr = Math.min(window.devicePixelRatio || 1, 1.5);
      FW = Math.max(1, Math.round(r.width * fdpr));
      FH = Math.max(1, Math.round(r.height * fdpr));
      /* only touch the bitmap when the size truly changed: assigning
         canvas.width, even to the same value, ERASES the canvas, and under
         reduced motion the one static frame must survive the observer's
         initial async callback. */
      if (fcv.width !== FW || fcv.height !== FH) { fcv.width = FW; fcv.height = FH; }
      var n = r.width < 768 ? 54 : 108;
      var s = 8675309;
      var rnd = function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
      marks = [];
      for (var mi = 0; mi < n; mi++) {
        marks.push({
          x: rnd(), y: rnd(),
          l: 4 + rnd() * 9,
          p: rnd() * 6.283,
          v: 0.35 + rnd() * 0.65,
          hv: mi % 6 === 0
        });
      }
    };
    var drawField = function (ms, burst) {
      if (!fctx) return;
      fctx.clearRect(0, 0, FW, FH);
      fctx.lineWidth = Math.max(1, 1 * fdpr);
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i];
        var x = (((m.x - ms * 0.0000038 * m.v) % 1) + 1) % 1 * FW;
        var y = m.y * FH;
        var a = (0.05 + 0.05 * Math.sin(ms / 1700 + m.p)) + burst * 0.04;
        if (a <= 0.004) continue;
        var len = m.l * fdpr * (1 + burst * 0.35);
        fctx.strokeStyle = m.hv
          ? 'rgba(227,255,79,' + a.toFixed(3) + ')'
          : 'rgba(242,244,240,' + (a * 0.8).toFixed(3) + ')';
        fctx.beginPath();
        fctx.moveTo(x, y - len / 2);
        fctx.lineTo(x, y + len / 2);
        fctx.stroke();
      }
    };
    fresize();

    var resize = function () {
      var r = cv.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);   // clamp: a 3x phone
      W = Math.max(1, Math.round(r.width * dpr));        // costs 2.25x fill for
      H = Math.max(1, Math.round(r.height * dpr));       // no visible gain
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      R = Math.min(W, H) * 0.33;
    };
    resize();
    /* on any real resize under reduced motion, repaint the static frame:
       a resized canvas is an erased canvas. draw() and restFrame() are both
       defined below; these callbacks only ever run asynchronously, after
       they exist. */
    var onResize = function () {
      resize(); fresize();
      if (reduced.matches) { restFrame(); }
    };
    var ro = ('ResizeObserver' in window) ? new ResizeObserver(onResize) : null;
    if (ro) { ro.observe(cv); if (fcv) ro.observe(fcv); }
    else window.addEventListener('resize', onResize);

    // ring cadence: 6000ms cycle, ringing during the first 2000ms
    var cadence = function (ms) {
      var p = (ms % 6000);
      if (p > 2000) return 0;
      // two swells inside the ring burst, like a real bell being struck twice
      var a = Math.exp(-Math.pow((p - 260) / 220, 2));
      var b = Math.exp(-Math.pow((p - 1080) / 240, 2));
      return Math.min(1, a + b);
    };

    /* the centre readout describes the animation itself and nothing else, so
       it can never be mistaken for a business metric. It counts the ring, then
       resolves to the product's own name. */
    var countEl = stage.querySelector('.ring-count');
    var lastLabel = '';
    // A page whose whole argument is the hold clock must not have its ring
    // overwritten with a ring cadence. /hold ships its own state in the markup
    // ("On hold / 1:47:03"); the ring animates, the readout stays the page's.
    var ownsReadout = !document.querySelector('[data-ring-keep]')
      && !/^\/hold(\.html)?$/.test(location.pathname);

    var readout = function (ms) {
      if (!countEl || !ownsReadout) return;
      var label, state;
      if (live) { label = 'live'; state = 'Listening'; }
      else {
        var p = ms % 6000;
        if (p <= 2000) { label = (p / 1000).toFixed(1) + 's'; state = 'Ringing'; }
        else { label = 'Answered'; state = 'Picked up on the first ring'; }
      }
      if (label !== lastLabel) {
        lastLabel = label;
        countEl.textContent = live ? '' : label;
        countEl.style.fontSize = (label === 'Answered') ? 'clamp(22px,2.6vw,32px)' : '';
        if (stateEl && !live) stateEl.textContent = state;
      }
    };

    var draw = function (ts) {
      raf = requestAnimationFrame(draw);
      t = ts || 0;
      /* anchor the cadence to first paint: the page always opens on the
         first ring, so the entrance choreography and the bell agree. */
      if (t0ref < 0) t0ref = t;
      t -= t0ref;
      readout(t);
      ctx.clearRect(0, 0, W, H);
      var cx = W / 2, cy = H / 2;

      var burst = live ? 0 : cadence(t);
      if (live && analyser) { analyser.getByteFrequencyData(bins); }

      /* the moment the ring resolves to Answered: one wave leaves the bezel,
         and one of the calls in flight lands into the line. */
      var ringingNow = !live && (t % 6000) <= 2000;
      if (wasRinging && !ringingNow && !live) {
        waves.push({ t0: t });
        var lander = comets[answers % comets.length];
        if (lander && !lander.landing) {
          lander.landing = 1; lander.landT = t; lander.startR = lander.rr;
        }
        answers++;
      }
      wasRinging = ringingNow || live;

      // breathing base radius
      var breathe = 1 + Math.sin(t / 1900) * 0.012;
      var baseR = R * breathe * (1 + burst * 0.055);

      for (var i = 0; i < N; i++) {
        var ang = (i / N) * Math.PI * 2 - Math.PI / 2;

        var amp;
        if (live) {
          // map the low 3/4 of the spectrum, where speech energy lives, and
          // mirror it so the ring stays symmetric rather than lopsided
          var idx = Math.floor((i < N / 2 ? i : N - i) / (N / 2) * (bins.length * 0.72));
          amp = (bins[idx] || 0) / 255;
          amp = Math.pow(amp, 1.5);                       // perceptual, not linear
          smooth[i] += (amp - smooth[i]) * (amp > smooth[i] ? 0.55 : 0.10); // fast attack, slow release
        } else {
          var wob = Math.sin(ang * 3 + t / 1400) * 0.5 + Math.sin(ang * 7 - t / 2100) * 0.28;
          amp = 0.10 + wob * 0.055 + burst * 0.42;
          smooth[i] += (amp - smooth[i]) * 0.18;
        }

        var len = R * (0.10 + smooth[i] * 0.62);
        var r0 = baseR, r1 = baseR + len;
        var x0 = cx + Math.cos(ang) * r0, y0 = cy + Math.sin(ang) * r0;
        var x1 = cx + Math.cos(ang) * r1, y1 = cy + Math.sin(ang) * r1;

        var heat = Math.min(1, smooth[i] * 1.5 + burst * 0.5);
        /* ACCENT DISCIPLINE. This ramp used to run Hi-Vis at rest and land on
           exactly #37C8F0 at the peaks, which put a SECOND accent hue on the
           dark ground for the loudest half of the cadence: measured on the
           /trades hero, the whole ring reads teal on obsidian at the strike.
           Dialtone is the "a human is live" signal and it keeps its own
           jobs; the ring is the Hi-Vis instrument, so it stays inside the
           Hi-Vis family and gets HOTTER rather than bluer, running from
           #E3FF4F at rest to its own tint #F2FFA6 at the peak while the
           alpha ramp carries the intensity. One accent on dark, still. */
        var rr = Math.round(227 + heat * 15);
        var gg = 255;
        var bb = Math.round(79 + heat * 87);
        ctx.strokeStyle = 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (0.30 + heat * 0.62) + ')';
        ctx.lineWidth = Math.max(1, 1.35 * dpr);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }

      // the inner hairline: the line itself
      ctx.strokeStyle = 'rgba(242,244,240,' + (0.10 + burst * 0.16) + ')';
      ctx.lineWidth = Math.max(1, 1 * dpr);
      ctx.beginPath(); ctx.arc(cx, cy, baseR * 0.9, 0, Math.PI * 2); ctx.stroke();

      // answer waves: born on the resolve, dead inside 900ms
      for (var wv = waves.length - 1; wv >= 0; wv--) {
        var wk = (t - waves[wv].t0) / 900;
        if (wk >= 1) { waves.splice(wv, 1); continue; }
        var we = 1 - Math.pow(1 - wk, 3);
        ctx.strokeStyle = 'rgba(227,255,79,' + (0.34 * (1 - wk)).toFixed(3) + ')';
        ctx.lineWidth = Math.max(1, 1.2 * dpr);
        ctx.beginPath(); ctx.arc(cx, cy, baseR * (1 + we * 1.5), 0, Math.PI * 2); ctx.stroke();
      }

      // calls in flight: three faint dots orbiting outside the line; the
      // landing one eases onto the bezel and respawns further out
      var lr = baseR / R;
      for (var cm = 0; cm < comets.length; cm++) {
        var c = comets[cm];
        var angNow = c.ang + t * c.av;
        var crr, ca = 0.20 + burst * 0.22;
        if (c.landing) {
          var lk = (t - c.landT) / 700;
          if (lk >= 1) { seedComet(c); continue; }
          var le = lk * lk * (3 - 2 * lk);
          crr = (c.startR + (lr - c.startR) * le) * R;
          ca = 0.25 + le * 0.45;
        } else {
          crr = c.rr * R;
        }
        var cxp = cx + Math.cos(angNow) * crr;
        var cyp = cy + Math.sin(angNow) * crr;
        ctx.fillStyle = 'rgba(227,255,79,' + ca.toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(cxp, cyp, Math.max(1.5, 1.5 * dpr), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(227,255,79,' + (ca * 0.35).toFixed(3) + ')';
        ctx.lineWidth = Math.max(1, 1 * dpr);
        ctx.beginPath(); ctx.arc(cx, cy, crr, angNow - 0.16, angNow - 0.02); ctx.stroke();
      }

      // the ambient field breathes on the same clock, its own canvas
      drawField(t, burst);
    };

    /* the loop does not merely skip work while offscreen, it stops scheduling
       frames at all. a rAF that ticks sixty times a second only to early
       return is still a wakeup on a phone; cancelling it is the only state
       that costs nothing. */
    var running = false;
    var setRun = function () {
      var run = onScreen && tabShown && !reduced.matches;
      if (run === running) return;
      running = run;
      cancelAnimationFrame(raf);
      if (run) raf = requestAnimationFrame(draw);
    };

    /* THE REDUCED-MOTION REST STATE. One static frame, and it must rest on
       the beat the caption claims: drawing at t=0 froze the readout at
       "Ringing / 0.0s" underneath copy that says the line gets picked up,
       which is a stopped clock presented as a running one. 3000ms is inside
       the answered half of the 6000ms cadence, so the readout resolves to
       "Picked up on the first ring / Answered", exactly the pattern the SSR
       markup already ships on /recover and /thanks. t0ref is pinned first so
       draw() does not re-anchor the clock back to zero, and wasRinging is
       cleared so the resolve wave is not born into a frame that never
       advances to kill it. */
    var restFrame = function () {
      for (var s = 0; s < N; s++) { smooth[s] = 0.16 + Math.sin(s / 5) * 0.05; }
      wasRinging = false;
      t0ref = 0;
      lastLabel = '';
      draw(3000);
      cancelAnimationFrame(raf);
    };

    if (reduced.matches) {
      restFrame();
    } else {
      running = true;
      raf = requestAnimationFrame(draw);
    }

    if ('IntersectionObserver' in window) {
      /* observe the hero, not just the ring: the field spans the whole hero,
         and the loop must run exactly while any of it is on screen. */
      new IntersectionObserver(function (e) { onScreen = e[0].isIntersecting; setRun(); }, { threshold: 0 }).observe(hero || cv);
    }
    document.addEventListener('visibilitychange', function () { tabShown = !document.hidden; setRun(); });

    /* mic. opt-in, real, and it removes its own control if the browser
       cannot honour it, so the page never shows a button that cannot work. */
    var mic = document.querySelector('.mic-btn');
    var canMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
                 !!(window.AudioContext || window.webkitAudioContext);
    if (mic && (!canMic || reduced.matches)) {
      mic.parentNode.removeChild(mic);
    } else if (mic) {
      mic.addEventListener('click', function () {
        if (live) {
          live = false;
          stage.classList.remove('live');
          mic.classList.remove('on');
          mic.querySelector('.lbl').textContent = 'Let it hear you';
          if (stateEl) stateEl.textContent = 'Ringing';
          if (stream) { stream.getTracks().forEach(function (tr) { tr.stop(); }); stream = null; }
          return;
        }
        mic.querySelector('.lbl').textContent = 'Asking for the mic';
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) {
          stream = st;
          var AC = window.AudioContext || window.webkitAudioContext;
          var ac = new AC();
          var src = ac.createMediaStreamSource(st);
          analyser = ac.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.72;
          bins = new Uint8Array(analyser.frequencyBinCount);
          src.connect(analyser);           // note: never connected to destination,
          live = true;                     // so there is no feedback loop
          stage.classList.add('live');
          mic.classList.add('on');
          mic.querySelector('.lbl').textContent = 'Listening. Say something';
          if (stateEl) stateEl.textContent = 'Listening';
        }).catch(function () {
          mic.querySelector('.lbl').textContent = 'Microphone blocked';
          mic.disabled = true;
          mic.style.opacity = '.6';
          mic.style.cursor = 'default';
        });
      });
    }
  }


  /* ── SHOWCASES ────────────────────────────────────────────────────────────
     Each showcase plays a scripted product walkthrough once it scrolls into
     view. It is labelled a concept rendering in the markup. It demonstrates
     capability; it never claims to be a customer's live session.
     Reduced motion gets the finished end state immediately, which is the
     honest degradation: the same information, no movement.
     ──────────────────────────────────────────────────────────────────────── */
  var shows = document.querySelectorAll('.showcase');

  /* ── GHOST SKELETONS ──────────────────────────────────────────────────────
     Both typing cards reserve their FULL final height before a single word
     lands, so between scroll-in and first bubble the panel renders as an
     empty vessel, which reads as broken rather than as pending. Every turn
     that has not landed yet therefore rests as a SLAB IN ITS FINAL GEOMETRY:
     you see the shape of the conversation about to happen, the panel is
     never empty, and because the slab is already the size of the finished
     bubble the landing costs exactly zero layout.

     ★ WHY THIS IS A PAINTED SLAB AND NOT AN OPACITY. The first version set
     opacity .02 on the pending turn, which is arithmetically present and
     optically absent. MEASURED 2026-08-13 on /trades, by freezing the scene
     observer and sampling the pixels of the first bubble's box against the
     panel ground beside it: the old recipe read a mean channel delta of
     0.85/255, i.e. under one level, below the just-noticeable difference of
     any display. The new recipe reads 11.67/255. Every computed-style check
     passed the whole time, because .02 really was the computed opacity, so
     only the pixels could settle it.

     Two things the slab fixes, not one. It is VISIBLE, so the reserved panel
     reads as pending structure instead of as a void. And it is BLANK: at .02
     the only thing rendering was the finished dialogue, so such signal as
     there was spoiled the scene rather than reserving space for it. The ghost
     therefore paints its own surface at full opacity and suppresses the INK.

     Neutral on purpose, too: .turn.us and .turn.them have different grounds,
     and a coloured skeleton would let you read who speaks next before they
     speak.

     Two rules this obeys. Reduced motion never ghosts: it gets the finished,
     legible scene at once. JS-off never ghosts either, because the resting
     hidden state itself only exists under html.js.
     ─────────────────────────────────────────────────────────────────────── */
  var GHOST_SEL = '.turn, .pb, .sc-result, .hold-hit';
  var GHOST_BG = 'rgba(242,244,240,.055)';
  var GHOST_LINE = 'rgba(242,244,240,.09)';
  var ghostPending = function (host) {
    if (reduced.matches) return;
    [].slice.call(host.querySelectorAll(GHOST_SEL)).forEach(function (n) {
      if (n.classList.contains('in')) return;
      n.style.opacity = '1';
      n.style.transform = 'none';
      n.style.background = GHOST_BG;
      n.style.borderColor = GHOST_LINE;
      n.style.boxShadow = 'none';
      n.style.color = 'transparent';
      n.dataset.ghost = '1';
      [].slice.call(n.querySelectorAll('*')).forEach(function (k) { k.style.color = 'transparent'; });
    });
  };
  /* clear inline first, then land the class, in the SAME task: the browser
     coalesces both into one style resolution, so the element never paints an
     intermediate state on its way to .in. The slab already sits at opacity 1
     and transform none, and .in resolves to exactly that, so the bubble's own
     surface and ink simply replace the skeleton's in place. Nothing fades
     from nothing, and nothing jumps. */
  var unghost = function (n) {
    n.style.opacity = ''; n.style.transform = '';
    if (n.dataset.ghost !== '1') return;
    n.style.background = ''; n.style.borderColor = ''; n.style.boxShadow = ''; n.style.color = '';
    [].slice.call(n.querySelectorAll('*')).forEach(function (k) { k.style.color = ''; });
    n.dataset.ghost = '';
  };

  /* words become spans only at play time, so JS-off and reduced motion keep
     the untouched, fully legible markup. returns the word spans in order. */
  var prepWords = function (host) {
    var out = [];
    [].slice.call(host.childNodes).forEach(function (k) {
      if (k.nodeType !== 3 || !k.textContent.trim()) return;
      var frag = document.createDocumentFragment();
      k.textContent.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
        var w = document.createElement('span');
        w.className = 'tw';
        w.textContent = part;
        frag.appendChild(w);
        out.push(w);
      });
      host.replaceChild(frag, k);
    });
    return out;
  };
  /* Speech cadence: short words arrive fast, long words take longer.

     ★ RETUNED 2026-08-13 AGAINST A MEASUREMENT, not a feeling. The old curve
     (50 + min(220, len*28)) put the /trades call scene at 14.2s end to end
     and the home phone scene at 12.0s, timed through the serving path from
     the instant each panel crossed its 28% threshold. Nobody watches a
     fourteen second typing animation; past about eight seconds the scene
     stops reading as a competent machine working and starts reading as a
     slow one. The curve below lands the same scenes near eight and seven
     seconds while keeping the long-word/short-word contrast that makes it
     read as speech instead of as a progress bar. Time to first bubble is
     untouched and stays far inside the 1.5s budget. */
  var wordMs = function (w) { return 28 + Math.min(120, w.textContent.length * 16); };

  /* ── LEDGER OUTCOMES ──────────────────────────────────────────────────────
     Three outcomes, not one. .cleared already exists in CSS and owns PAID; the
     other two are painted from here rather than from a new class because the
     stylesheet is another lane's surface and an outcome that only exists in one
     of the two files is exactly how a rule ships and does nothing.

     Both non-paid states are written in the NEUTRAL ink family on purpose. Hi-
     Vis is the money colour on this site and it is reserved for dollars that
     actually cleared: a promise painted in the same accent as a payment would
     re-tell the lie the animation was fixed to stop telling, just quieter. */
  var OUTCOME = {
    promised: { label: ' PROMISED THU', ink: 'rgba(242,244,240,.82)',
                bg: 'rgba(242,244,240,.055)', line: 'rgba(242,244,240,.26)' },
    open:     { label: ' CALLING BACK FRI', ink: 'rgba(242,244,240,.66)',
                bg: '', line: '' }
  };
  var markRow = function (r, out) {
    var o = OUTCOME[out];
    if (!o || r.dataset.marked === '1') return;
    r.dataset.marked = '1';
    if (o.bg) r.style.background = o.bg;
    if (o.line) r.style.borderColor = o.line;
    var age = r.querySelector('.age');
    if (!age) return;
    var tag = document.createElement('span');
    tag.textContent = o.label;
    tag.style.color = o.ink;
    tag.style.letterSpacing = '.1em';
    age.appendChild(tag);
  };

  if (shows.length) {
    var play = function (el) {
      var kind = el.getAttribute('data-show');
      el.classList.add('running');

      if (reduced.matches) {
        el.querySelectorAll('.turn, .sc-result, .hold-hit').forEach(function (n) { n.classList.add('in'); });
        el.querySelectorAll('.sc-kv dt, .sc-kv dd, .sc-bill').forEach(function (n) { n.classList.add('on'); });
        el.querySelectorAll('.rung').forEach(function (n) { n.classList.add('done'); });
        /* REDUCED MOTION GETS THE SAME TRUTH, NOT A SHORTER LIE. This branch
           used to stamp every row cleared and hardcode the meter to '$0', so a
           visitor with reduced motion on was served the 100% recovery rate the
           animated branch no longer claims. The end state is now computed from
           the same data-outcome attributes: what is left is what did not land. */
        var rr = el.querySelectorAll('.inv-row'), rem = 0;
        rr.forEach(function (n) {
          var out = n.getAttribute('data-outcome') || 'paid';
          if (out === 'paid') { n.classList.add('cleared'); return; }
          rem += parseFloat(n.getAttribute('data-amt') || '0');
          markRow(n, out);
        });
        var c0 = el.querySelector('.hold-clock'); if (c0) c0.textContent = '2:11:04';
        var m0 = el.querySelector('.meter-big');
        if (m0 && rr.length) m0.textContent = '$' + Math.round(rem).toLocaleString('en-US');
        return;
      }

      if (kind === 'call') {
        /* the transcript TYPES at speech cadence: each turn's words arrive
           one by one behind a caret, then the job card locks its fields in
           sequence and the bill chip stamps. the caret is .cur on the word
           that just landed, never a ::after on the turn: hidden words still
           occupy layout, so a turn-level caret parks after the LAST word,
           an orphan cursor on an empty line (measured 2026-08-13). */
        /* first bubble lands well inside the 1.5s the room asked for, counted
           from the moment the card is 30% visible. the observer opens at 28%,
           so 220ms after that is the whole budget spent. */
        var at = 180;
        [].slice.call(el.querySelectorAll('.turn')).forEach(function (tn) {
          var words = prepWords(tn);
          setTimeout(function () { unghost(tn); tn.classList.add('in', 'speaking'); }, at);
          at += 170;
          words.forEach(function (w, wn) {
            setTimeout(function () {
              w.classList.add('on', 'cur');
              if (wn > 0) words[wn - 1].classList.remove('cur');
            }, at);
            at += wordMs(w);
          });
          setTimeout(function () {
            tn.classList.remove('speaking');
            if (words.length) words[words.length - 1].classList.remove('cur');
          }, at + 70);
          at += 240;
        });
        var res = el.querySelector('.sc-result');
        if (res) {
          setTimeout(function () { unghost(res); res.classList.add('in'); }, at);
          at += 230;
          [].slice.call(res.querySelectorAll('.sc-kv dt, .sc-kv dd')).forEach(function (n) {
            setTimeout(function () { n.classList.add('on'); }, at);
            at += 62;
          });
          var bill = el.querySelector('.sc-bill');
          if (bill) setTimeout(function () { bill.classList.add('on'); }, at + 130);
        }
      }

      if (kind === 'hold') {
        var rungs = el.querySelectorAll('.rung');
        rungs.forEach(function (r, n) {
          setTimeout(function () {
            rungs.forEach(function (x) { x.classList.remove('hit'); });
            r.classList.add('hit');
            for (var q = 0; q <= n; q++) { rungs[q].classList.add('done'); }
          }, 500 + n * 900);
        });
        var clock = el.querySelector('.hold-clock');
        if (clock) {
          // counts real seconds, sped up, so the number on screen is arithmetic
          // rather than a hand-picked figure
          var secs = 0, iv = setInterval(function () {
            secs += 137;
            if (secs > 7864) { secs = 7864; clearInterval(iv); }
            var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
            clock.textContent = h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          }, 60);
        }
        var hit = el.querySelector('.hold-hit');
        if (hit) setTimeout(function () { unghost(hit); hit.classList.add('in'); }, 500 + rungs.length * 900 + 700);
      }

      if (kind === 'recover') {
        /* THE LEDGER DOES NOT GO TO ZERO. Every row used to stamp PAID and the
           meter used to animate down to $0, which renders a 100% recovery rate
           in motion underneath a caption promising it is "not a projection of
           results". The caption was right and the picture was wrong, and the
           picture is what a reader keeps. Each row now plays the outcome the
           markup gives it, and the meter subtracts ONLY on data-outcome="paid",
           because that is the same line the fee itself is drawn on: money that
           actually cleared. A row with no outcome is treated as paid, which
           keeps this backward compatible with any deck that has not been
           annotated. */
        var rows = el.querySelectorAll('.inv-row');
        var meter = el.querySelector('.meter-big');
        var total = 0;
        rows.forEach(function (r) { total += parseFloat(r.getAttribute('data-amt') || '0'); });
        var left = total;
        var fmt = function (v) { return '$' + Math.round(v).toLocaleString('en-US'); };
        if (meter) meter.textContent = fmt(total);
        rows.forEach(function (r, n) {
          setTimeout(function () {
            var out = r.getAttribute('data-outcome') || 'paid';
            if (out !== 'paid') { markRow(r, out); return; }
            r.classList.add('cleared');
            var amt = parseFloat(r.getAttribute('data-amt') || '0');
            var from = left, to = left - amt, t0 = null;
            left = to;
            var step = function (ts) {
              if (t0 === null) t0 = ts;
              var p = Math.min(1, (ts - t0) / 700);
              var e = 1 - Math.pow(1 - p, 3);
              if (meter) meter.textContent = fmt(from + (to - from) * e);
              if (p < 1) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }, 700 + n * 1000);
        });
      }
    };

    if ('IntersectionObserver' in window) {
      var sio = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { sio.unobserve(e.target); play(e.target); } });
      }, { threshold: 0.28 });
      shows.forEach(function (s) { ghostPending(s); sio.observe(s); });
    } else {
      shows.forEach(play);
    }
  }

  /* ── THE MISSED CALL PLAYS. same speech-cadence engine as the showcase:
     bubbles land in turn, words type, and the one text you get arrives
     whole at the end, because a text message arrives whole. ── */
  var phones = document.querySelectorAll('.phone');
  if (phones.length) {
    var playPhone = function (ph) {
      var sms = ph.querySelector('.phone-sms');
      if (reduced.matches) {
        ph.querySelectorAll('.pb').forEach(function (n) { n.classList.add('in'); });
        if (sms) sms.classList.add('on');
        return;
      }
      /* slightly brisker than the showcase: four bubbles, and the payoff is
         the SMS at the end, so the whole scene stays inside ~12 seconds. */
      var at = 180;
      [].slice.call(ph.querySelectorAll('.pb')).forEach(function (pb) {
        var words = prepWords(pb);
        setTimeout(function () { unghost(pb); pb.classList.add('in'); }, at);
        at += 150;
        words.forEach(function (w) {
          setTimeout(function () { w.classList.add('on'); }, at);
          at += Math.round(wordMs(w) * 0.72);
        });
        at += 200;
      });
      if (sms) setTimeout(function () { sms.classList.add('on'); }, at + 300);
    };
    if ('IntersectionObserver' in window) {
      var pio = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { pio.unobserve(e.target); playPhone(e.target); } });
      }, { threshold: 0.28 });
      phones.forEach(function (p) { ghostPending(p); pio.observe(p); });
    } else {
      phones.forEach(playPhone);
    }
  }

  /* ── THE DRIFT. proof objects (the showcase, the phone, the receipt, the
     ledger, the ring) lag the scroll a few pixels, so motion continues
     between sections instead of stopping at every seam. JS-driven, because
     scroll-driven animation-timeline is not in Firefox (deskScrub doctrine).
     transform only, one rAF, arithmetic gate instead of an observer. ── */
  (function () {
    if (reduced.matches) return;
    var els = [].slice.call(document.querySelectorAll('[data-drift]'));
    if (!els.length) return;
    var metas = [];
    var measure = function () {
      metas = els.map(function (el) {
        var prev = el.style.transform;
        el.style.transform = '';
        var r = el.getBoundingClientRect();
        var m = {
          el: el,
          top: r.top + window.scrollY,
          h: r.height,
          f: parseFloat(el.getAttribute('data-drift')) || 0.05
        };
        el.style.transform = prev;
        return m;
      });
    };
    var tickingD = false;
    var apply = function () {
      tickingD = false;
      var vh = window.innerHeight, sy = window.scrollY;
      for (var i = 0; i < metas.length; i++) {
        var m = metas[i];
        var d = (m.top + m.h / 2 - sy) - vh / 2;
        if (d > vh || d < -vh) continue;                 // offscreen: no write
        var y = Math.max(-26, Math.min(26, d * m.f));
        m.el.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
      }
    };
    var queue = function () {
      if (!tickingD) { tickingD = true; requestAnimationFrame(apply); }
    };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', function () { measure(); queue(); });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { measure(); queue(); });
    }
    measure(); apply();
  })();



  /* ── where each dollar goes ─────────────────────────────────────────────
     One scale for every row: the cost slice is a percentage OF THAT ROW'S
     revenue, so a reader can compare rows directly. The old chart drew every
     revenue bar full width, which made $19 and $1,500 look identical. */
  var drows = document.querySelectorAll('.dtrack');
  if (drows.length && 'IntersectionObserver' in window) {
    var dio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        dio.unobserve(e.target);
        var t = e.target;
        var rev = parseFloat(t.getAttribute('data-rev'));
        var cost = parseFloat(t.getAttribute('data-cost'));
        var pct = (cost / rev) * 100;
        var seg = t.querySelector('.dcost');
        if (pct < 12) { seg.classList.add('thin'); t.classList.add('thin-cost'); }
        setTimeout(function () { seg.style.width = Math.max(pct, 0.6) + '%'; }, 80);
      });
    }, { threshold: 0.35 });
    for (var d = 0; d < drows.length; d++) { dio.observe(drows[d]); }
  }


  /* ── the use-case chooser ────────────────────────────────────────────────
     SEGMENTATION, NOT A CONTROL. Nothing here protects anything, and nothing
     that needs protecting should ever live behind it. Every section renders by
     default; the filter only engages after a deliberate click, so a reader with
     JS off, a crawler, or anyone arriving before this script runs sees the
     whole page. The choice is remembered so a returning visitor is not asked
     the same question twice, and it is always reversible from the chip. */
  var picks = document.querySelectorAll('[data-pick]');
  if (picks.length) {
    var root = document.documentElement;
    var NAMES = { consumer: 'a person', business: 'a business', both: 'everyone' };

    var apply = function (aud, scroll) {
      if (!NAMES[aud]) return;
      root.setAttribute('data-aud', aud);
      var n = document.querySelector('.aud-name');
      if (n) n.textContent = NAMES[aud];
      try { localStorage.setItem('answered.aud', aud); } catch (e) {}
      if (scroll) {
        var first = document.querySelector('.aud-chip');
        if (first) {
          var y = first.getBoundingClientRect().top + window.scrollY - 110;
          window.scrollTo({ top: Math.max(0, y), behavior: reduced.matches ? 'auto' : 'smooth' });
        }
      }
    };

    for (var pi = 0; pi < picks.length; pi++) {
      picks[pi].addEventListener('click', function () {
        apply(this.getAttribute('data-pick'), true);
      });
    }

    var change = document.querySelector('.aud-change');
    if (change) {
      change.addEventListener('click', function () {
        root.removeAttribute('data-aud');
        try { localStorage.removeItem('answered.aud'); } catch (e) {}
        var g = document.getElementById('choose');
        if (g) g.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' });
      });
    }

    // arriving from a product card already says which one you came for
    var q = (new URLSearchParams(location.search).get('p') || '').toLowerCase();
    var fromQuery = q === 'hold' ? 'consumer' : (q === 'answered' || q === 'recover' ? 'business' : null);
    var saved = null;
    try { saved = localStorage.getItem('answered.aud'); } catch (e) {}
    if (fromQuery) { apply(fromQuery, false); }
    else if (saved) { apply(saved, false); }
  }

  /* ── the interest form preselects whichever card sent you here ──────────── */
  var sel = document.getElementById('i-product');
  if (sel) {
    var want = (new URLSearchParams(location.search).get('p') || '').toLowerCase();
    if (want) {
      for (var o = 0; o < sel.options.length; o++) {
        if (sel.options[o].text.toLowerCase().indexOf(want) === 0) { sel.selectedIndex = o; break; }
      }
    }
  }

  /* ── year ───────────────────────────────────────────────────────────── */
  var y = document.querySelectorAll('[data-year]');
  for (var m = 0; m < y.length; m++) { y[m].textContent = String(new Date().getFullYear()); }
})();

/* ══ TRACK SWITCH ══════════════════════════════════════════════════
   Two audiences, one page. The markup ships with body.track-me so the
   consumer track is what a person sees with JS off or still loading.
   The choice is remembered, because coming back to the wrong side of
   the page is the fastest way to lose somebody.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  var seg = document.querySelector('.seg');
  if (!seg) return;
  var btns  = [].slice.call(seg.querySelectorAll('[data-track-to]'));
  var thumb = seg.querySelector('.seg-thumb');
  var body  = document.body;

  function moveThumb(btn) {
    if (!thumb || !btn) return;
    // geometry from getBoundingClientRect, not offsetLeft: the offsetLeft
    // arithmetic landed the thumb 1px left of the button (measured
    // translateX(-1) on the resting state). rects are unambiguous: the
    // button's offset inside the padding box, minus the thumb's own 5px.
    var d = btn.getBoundingClientRect().left - seg.getBoundingClientRect().left - seg.clientLeft - 5;
    thumb.style.width = btn.getBoundingClientRect().width + 'px';
    thumb.style.transform = 'translateX(' + d + 'px)';
  }

  function apply(track, animate) {
    body.classList.toggle('track-me',  track === 'me');
    body.classList.toggle('track-biz', track === 'biz');
    btns.forEach(function (b) {
      var on = b.getAttribute('data-track-to') === track;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) moveThumb(b);
    });
    if (animate) {
      [].slice.call(document.querySelectorAll('[data-track="' + track + '"]')).forEach(function (el, i) {
        el.classList.remove('track-swap');
        void el.offsetWidth;            // restart the animation
        // the page turns to face you top-down, not all at once
        el.style.animationDelay = Math.min(i * 40, 240) + 'ms';
        el.classList.add('track-swap');
      });
    }
    try { localStorage.setItem('answered_track', track); } catch (e) {}
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () { apply(b.getAttribute('data-track-to'), true); });
  });

  // arrow keys, because it is a real tablist
  seg.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    var n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    n.focus(); apply(n.getAttribute('data-track-to'), true);
  });

  var saved = null;
  try { saved = localStorage.getItem('answered_track'); } catch (e) {}
  if (location.hash === '#business' || location.hash === '#biz') saved = 'biz';
  apply(saved === 'biz' ? 'biz' : 'me', false);

  function remeasure() {
    var on = seg.querySelector('[aria-selected="true"]');
    if (on) { var t = thumb.style.transition; thumb.style.transition = 'none'; moveThumb(on); void thumb.offsetWidth; thumb.style.transition = t; }
  }
  addEventListener('resize', remeasure);
  // the buttons are measured before the webfont swaps in, so the thumb keeps a
  // fallback-font width forever unless it is measured again once fonts settle
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(remeasure); }
})();

/* ══ THE NARRATION PLAYER ══════════════════════════════════════════════════
   The rule, from HANDOFF.md and IDENTITY-V2.md: an audio control on this site
   plays real audio or it does not render. This estate shipped a play button
   once whose media was gitignored, so it sat there dead.
   Therefore the markup ships hidden and NOTHING reveals it except the browser
   telling us it has actually loaded enough of the file to play. We do not HEAD
   the URL: a 200 on a HEAD proves the bytes exist, not that they decode.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  var wrap = document.getElementById('vo');
  if (!wrap) return;
  var a = document.getElementById('vo-audio');
  var btn = document.getElementById('vo-btn');
  var bar = document.getElementById('vo-bar');
  var fill = document.getElementById('vo-fill');
  var time = document.getElementById('vo-time');
  var lbl = document.getElementById('vo-lbl');
  if (!a || !btn) return;

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  // reveal ONLY on real decodable metadata, and only with a sane duration
  a.addEventListener('loadedmetadata', function () {
    if (!isFinite(a.duration) || a.duration < 5) return;   // a broken/empty file
    time.textContent = fmt(a.duration);
    wrap.hidden = false;
  });
  a.addEventListener('error', function () { wrap.hidden = true; });

  // preload="none" means metadata only arrives once we ask for it
  a.preload = 'metadata';
  a.load();

  btn.addEventListener('click', function () {
    if (a.paused) {
      a.play().then(function () {
        wrap.classList.add('playing');
        lbl.textContent = 'Playing the walkthrough';
      }).catch(function () {
        // autoplay/decode refusal must not leave a control claiming to play
        wrap.classList.remove('playing');
        lbl.textContent = 'Could not play here';
      });
    } else {
      a.pause();
    }
  });

  a.addEventListener('pause', function () {
    wrap.classList.remove('playing');
    lbl.textContent = 'Hear the whole thing';
  });
  a.addEventListener('ended', function () {
    wrap.classList.remove('playing');
    lbl.textContent = 'Play it again';
    fill.style.width = '0';
    bar.setAttribute('aria-valuenow', '0');
  });

  a.addEventListener('timeupdate', function () {
    if (!isFinite(a.duration) || !a.duration) return;
    var pct = (a.currentTime / a.duration) * 100;
    fill.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', Math.round(pct));
    time.textContent = fmt(a.duration - a.currentTime);
  });

  function seek(clientX) {
    var r = bar.getBoundingClientRect();
    if (!isFinite(a.duration) || !r.width) return;
    a.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * a.duration;
  }
  bar.addEventListener('click', function (e) { seek(e.clientX); });
  bar.addEventListener('keydown', function (e) {
    if (!isFinite(a.duration)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); a.currentTime = Math.min(a.duration, a.currentTime + 15); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 15); }
  });
})();

/* ══ THE INTEREST FORM, WITHOUT THE DEAD END ═══════════════════════════════
   This is the only conversion on the site. Everything else is reading.

   It shipped as a plain full-page POST, which is correct and works, right up
   until it does not. netlify/functions/interest.js is deliberately fail-loud:
   no RESEND_API_KEY returns 503, an unreachable mail provider returns 502, a
   missing email returns 400. Every one of those is a NAVIGATION, so what the
   person actually gets is a white browser page reading "We could not record
   that right now" in Times New Roman, with no nav, no styling, no way back,
   and their typed note gone. Failing loud was the right call; landing them in
   a void was not. A lead that reaches a 502 today is a lead lost twice, once
   to the outage and once to the dead end.

   So the submit is intercepted and the person never leaves the page:
     ok        -> go where the server sent us (it 303s to /thanks.html, and
                  fetch has already followed it, so r.url is the truth rather
                  than a second hardcoded copy of the path)
     4xx/5xx   -> the server's own sentence, in the page's type, under the
                  form, with the button live again and every field still
                  filled in, plus a mailto that carries the note they wrote
     offline   -> the same treatment, said honestly

   Rules this keeps. It never swallows a failure and it never invents a
   success: nothing here can show "thanks" for a request that did not land,
   which is the failure mode this estate names fail-open. The browser's own
   validation runs first and is left alone. If fetch or FormData is missing
   the listener never attaches at all and the native POST is untouched, so
   the worst case is exactly today's behaviour rather than a broken form. And
   it is painted in the INK CONTRACT tokens, so it reads on bone paper and on
   obsidian without a second variant.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (!window.fetch || !window.FormData || !window.URLSearchParams) return;
  var forms = document.querySelectorAll('form[action="/api/interest"]');
  if (!forms.length) return;

  var MAIL = 'info@reddenda.com';

  var attach = function (form) {
    var btn = form.querySelector('button[type="submit"]') || form.querySelector('button');
    var note = null;

    var clear = function () { if (note && note.parentNode) { note.parentNode.removeChild(note); note = null; } };

    var fail = function (msg, sent) {
      var text = (msg || '').trim();
      // a server that answered with HTML rather than its own sentence must not
      // have that HTML poured into the page. Only a short plain sentence is
      // ever echoed, and it is set as TEXT, never as markup.
      if (!text || text.length > 240 || text.indexOf('<') > -1) {
        text = 'That did not reach us. It is our side, not yours.';
      }
      clear();
      note = document.createElement('p');
      note.setAttribute('role', 'status');
      note.className = 'src';
      note.style.cssText = 'margin-top:16px;padding:12px 0 12px 14px;border-left:2px solid var(--accent-ink);' +
        'font-size:15px;line-height:1.5;color:var(--ink);text-align:left;max-width:52ch;margin-inline:auto';
      note.appendChild(document.createTextNode(text + ' Nothing you typed is lost. Press it again, or '));
      var a = document.createElement('a');
      // inherit the colour, keep the underline: on this paper ground an
      // unmarked same-colour link is not a link, and this is the one link in
      // the whole flow that a person in trouble has to be able to find.
      a.style.color = 'inherit';
      a.style.textDecoration = 'underline';
      a.style.textUnderlineOffset = '3px';
      a.href = 'mailto:' + MAIL + '?subject=' + encodeURIComponent('Answered: the form would not send') +
        '&body=' + encodeURIComponent(sent || '');
      a.textContent = 'send it to a person instead';
      note.appendChild(a);
      note.appendChild(document.createTextNode('. A human reads that address.'));
      form.parentNode.insertBefore(note, form.nextSibling);
    };

    form.addEventListener('submit', function (e) {
      // the browser's own validation first: required, type=email, all of it.
      if (form.checkValidity && !form.checkValidity()) return;
      e.preventDefault();
      if (form.dataset.sending === '1') return;
      form.dataset.sending = '1';
      clear();
      var label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Sending'; }

      var pairs = new URLSearchParams();
      var fd = new FormData(form);
      var readable = [];
      fd.forEach(function (v, k) {
        pairs.append(k, v);
        if (k !== 'bot-field' && String(v).trim()) readable.push(k + ': ' + v);
      });

      var done = function () {
        form.dataset.sending = '';
        if (btn) { btn.disabled = false; btn.textContent = label; }
      };

      fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pairs.toString(),
        credentials: 'same-origin'
      }).then(function (r) {
        if (r.ok) { window.location.assign(r.url || '/thanks.html'); return null; }
        return r.text().then(function (t) { done(); fail(t, readable.join('\n')); });
      }).catch(function () {
        done();
        fail('That did not reach us, and it looks like the connection dropped rather than the form.',
             readable.join('\n'));
      });
    });
  };

  for (var i = 0; i < forms.length; i++) attach(forms[i]);
})();

/* ══ MEASUREMENT BEACONS ═══════════════════════════════════════════════════
   First-party only. One helper, three wire-ups, nothing else. Every name
   sent from here must be on the /api/event allowlist or the collector
   answers 400. A beacon failure is swallowed on purpose: measurement must
   never break the page it measures. The collector fails loud server-side.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function answeredEvent(name, meta) {
    try {
      var body = JSON.stringify({ event: name, page: location.pathname, meta: meta || {} });
      var sent = false;
      try {
        sent = !!(navigator.sendBeacon &&
          navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' })));
      } catch (e) { sent = false; }
      if (!sent && window.fetch) {
        fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
      }
    } catch (e2) { /* measurement must never break the page */ }
  }
  window.answeredEvent = answeredEvent;

  // the For-me / For-my-business track flip on the home page
  document.addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-track-to]') : null; if (b) answeredEvent('track_flip', { to: b.getAttribute('data-track-to') }); });
  // the pricing audience chooser
  document.addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-pick]') : null; if (b) answeredEvent('aud_choice', { pick: b.getAttribute('data-pick') }); });
  // interest form submit, fired before the POST navigates (sendBeacon outlives the page)
  document.addEventListener('submit', function (e) { var f = e.target; if (f && f.getAttribute && f.getAttribute('action') === '/api/interest') answeredEvent('interest_submitted', { form: f.getAttribute('name') || '' }); }, true);
})();

/* ══ THE HEALTH GATE ═══════════════════════════════════════════════════════
   SITE WIDE, ONE FETCH. Every slot that server-renders as a ghost carries
   [data-callslot]; every section that must stay dark until the line is green
   carries [data-callgate] plus the hidden attribute. This module asks
   /api/demo-health once per page load and ONLY on healthy:true does it
   upgrade EVERY slot on the page and reveal EVERY gated section.

   The demo number is NEVER in the initial HTML of any page. On red, on a
   non-200, on malformed JSON or on a network failure the upgrade simply
   never happens: the ghost CTA stays exactly as it shipped, no dead control
   ever renders anywhere, and at most one info line reaches the console.

   ONE CONTROL SHAPE, EVERY GROUND. A coarse pointer gets an anchor that
   dials. A fine pointer gets a button that copies. There is no second ghost
   pill beside it, for three measured reasons: two pills wrapped the hero
   action row to 124px and pushed the call control past the fold at
   1440x900; the ghost's own tokens are dark-ground only, so a second pill
   could not follow this control onto the bone paper closes; and a one-row
   ghost upgrading into a two-row pair shifted the hero after paint, which
   is page CLS. Ghost and control are both one row, so the upgrade shifts
   nothing.

   EVERY SLOT, NOT THE FIRST ONE. The upgrade walks the whole document, and
   a slot may name its own label in the attribute value (data-callslot="Hear
   it before you pick"), because the sentence that earns the tap on the
   pricing page is not the sentence that earns it in a hero. An empty value
   takes the default. The pass is idempotent: a slot already carrying a live
   control is skipped rather than rebuilt, so a second call cannot orphan an
   already-bound listener or wipe a control mid-press.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (!window.fetch) return;
  var slots = document.querySelectorAll('[data-callslot]');
  var gated = document.querySelectorAll('[data-callgate]');
  var offs = document.querySelectorAll('[data-callgate-off]');
  if (!slots.length && !gated.length && !offs.length) return;

  var NUM_TEL = '+19163504869';
  var NUM_TEXT = '+1 (916) 350-4869';
  var LABEL = 'Hear it answer';

  // one place that swaps children, so the whole module has a single fallback
  // for engines without replaceChildren rather than one per branch.
  function put(host, node) {
    if (host.replaceChildren) { host.replaceChildren(node); return; }
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(node);
  }

  function pill(tag, label) {
    var el = document.createElement(tag);
    el.className = 'btn btn-primary btn-call';
    // pinned centering: the label swaps to a shorter word on copy, and the
    // pill is width-pinned for that beat so nothing beside it moves.
    el.style.justifyContent = 'center';
    el.innerHTML = '<span class="call-l"></span><span class="call-n"></span>';
    // the slot's own words, when it named some. stored on the node so flash()
    // resolves back to THIS pill's label and never to the global default.
    el.dataset.callLabel = label || LABEL;
    el.querySelector('.call-l').textContent = el.dataset.callLabel;
    el.querySelector('.call-n').textContent = NUM_TEXT;
    return el;
  }

  // says a word on the pill for a beat, then always resolves back. the old
  // clipboard-refused path swapped in the number permanently and never came
  // back, which left two identical pills on the row.
  function flash(el, word, ms) {
    var lab = el.querySelector('.call-l');
    if (!lab || el.dataset.flashing === '1') return;
    el.dataset.flashing = '1';
    el.style.minWidth = Math.ceil(el.getBoundingClientRect().width) + 'px';
    lab.textContent = word;
    setTimeout(function () {
      lab.textContent = el.dataset.callLabel || LABEL;
      el.style.minWidth = '';
      el.dataset.flashing = '';
    }, ms);
  }

  function buildControl(slotEl) {
    // idempotent: never rebuild a slot that already carries a live control.
    if (slotEl.querySelector('.btn-call')) return;
    var label = (slotEl.getAttribute('data-callslot') || '').trim() || LABEL;
    var coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse) {
      // a phone in a hand: the whole control dials
      var a = pill('a', label);
      a.href = 'tel:' + NUM_TEL;
      a.addEventListener('click', function () {
        if (typeof window.answeredEvent === 'function') window.answeredEvent('demo_call_tapped');
      });
      put(slotEl, a);
      return;
    }
    // a desktop: the pill itself is the copy control. it is a real button, so
    // it is focusable, keyboard-operable and cursor:pointer from .btn.
    var b = pill('button', label);
    b.type = 'button';
    b.setAttribute('aria-label', 'Copy the demo number ' + NUM_TEXT);
    b.title = 'Copy the number';
    b.addEventListener('click', function () {
      var write = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(NUM_TEL)
        : Promise.reject();
      write.then(function () {
        flash(b, 'Copied', 1400);
        if (typeof window.answeredEvent === 'function') window.answeredEvent('demo_number_copied');
      }).catch(function () {
        // clipboard refused: select the number so a keyboard copy works, say
        // so for two seconds, then resolve back to the normal label.
        try {
          var r = document.createRange();
          r.selectNodeContents(b.querySelector('.call-n'));
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        } catch (e) {}
        flash(b, 'Press copy', 2000);
      });
    });
    put(slotEl, b);
  }

  function upgrade() {
    // re-query: a slot could have been written into the page after load.
    var live = document.querySelectorAll('[data-callslot]');
    for (var i = 0; i < live.length; i++) buildControl(live[i]);
    /* THE INVERSE GATE. [data-callgate-off] ships VISIBLE and is retired the
       moment the line is green. It exists because the opposite of a hidden
       green line is not an empty space, it is a sentence that is still true.
       Measured 2026-08-13 on the red path: /pricing and /thanks both printed
       "The demo line is answering right now" under a heading that said "Call
       it", with no number anywhere on the page, because the only gated node
       in those sections was the fine print underneath. A page that states a
       present fact about a line that is down is not a degraded page, it is a
       false one. Default-visible is also the correct fail direction: JS off,
       fetch missing, a non-200, malformed JSON or a dead network all leave
       the honest copy standing rather than leaving the false copy standing. */
    var off = document.querySelectorAll('[data-callgate-off]');
    for (var q = 0; q < off.length; q++) off[q].hidden = true;
    var g = document.querySelectorAll('[data-callgate]');
    var revealed = [];
    for (var k = 0; k < g.length; k++) {
      g[k].hidden = false;
      if (g[k].classList.contains('rv')) revealed.push(g[k]);
      var kids = g[k].querySelectorAll('.rv');
      for (var m = 0; m < kids.length; m++) revealed.push(kids[m]);
    }
    /* FAIL-SAFE, not decoration. These nodes shipped with display:none, so
       they had no box for the reveal observer to intersect. The observer
       does pick them up once they gain one, but an element that ends up in
       the viewport and never gets .in is invisible, and an invisible element
       reads exactly like a broken one. A second later, force any that are
       on screen and still resting at opacity 0. */
    if (revealed.length) {
      setTimeout(function () {
        for (var n = 0; n < revealed.length; n++) {
          var el = revealed[n];
          if (el.classList.contains('in')) continue;
          var r = el.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('in');
        }
      }, 1000);
    }
    if (typeof window.answeredEvent === 'function') {
      window.answeredEvent('demo_button_rendered', { slots: live.length });
    }
  }

  fetch('/api/demo-health', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (j && j.healthy === true) { upgrade(); return; }
      console.info('Answered: demo line is not green right now; keeping the list CTA.');
    })
    .catch(function () {
      console.info('Answered: demo health unreachable; keeping the list CTA.');
    });
})();

/* ══ THE POINTER ENGINE ════════════════════════════════════════════════════
   Fine pointers, full motion only. One pointermove listener, one lerp loop,
   three effects: THE DIAL (a cursor companion ring that locks on over
   anything pressable), MAGNETIC CTAs (perf-ultra recipe, toned to 8px), and
   the QUIET TILT plus light-response on cards (W2 spec: max 1.2deg, lerped).
   The loop parks itself the moment everything has settled, so an idle page
   schedules zero frames.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var fine = window.matchMedia('(pointer: fine)');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!fine.matches || reduced.matches) return;

  /* THE DIAL. Built LAZILY, and only on evidence of a real mouse.
     `pointer: fine` is necessary but it is not sufficient: every desktop
     browser narrowed to a phone width still reports fine, and so does a
     touchscreen laptop. Measured 2026-08-13 at a 390 viewport, the ring was
     rendering parked dead centre (178-212 x 405-439) on top of the copy.
     So the element does not exist until a real mousemove has landed AND the
     pointer is still fine at that moment. Touch input does not emit
     mousemove without a tap, and nothing downstream may assume the node
     exists. */
  var dial = null;
  var ensureDial = function () {
    if (dial || !fine.matches) return null;
    dial = document.createElement('div');
    dial.className = 'dial';
    dial.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dial);
    return dial;
  };
  var px = -100, py = -100, dx = -100, dy = -100;
  var sc = 1, sct = 1, shown = false;

  /* MAGNETIC CTAs. proximity, not hover: the button leans toward the hand
     before it is touched. list re-scanned lazily so the health-gated call
     control, injected later, is picked up without a hook into that module. */
  var MAG = '.btn-primary, .nav-cta, .pc-cta, .btn-call';
  /* lastScan starts far in the past: pointermove timeStamps begin near 0, so
     a 0 seed made `now - lastScan < 2000` swallow the first two seconds of
     magnetism after load. */
  var mags = [], lastScan = -1e9;
  var magEl = null, mx = 0, my = 0, mtx = 0, mty = 0;

  /* THE QUIET TILT + light response */
  var TILT = '.card, .pcard, .mode, .gc';
  var tiltEl = null, rx = 0, ry = 0, rxt = 0, ryt = 0;

  var idle = true, raf = 0;
  var loop = function () {
    var busy = false;

    // dial follow. the node may legitimately never exist on this device.
    if (dial) {
      dx += (px - dx) * 0.22; dy += (py - dy) * 0.22;
      sc += (sct - sc) * 0.25;
      dial.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' + sc.toFixed(3) + ')';
      if (Math.abs(px - dx) > 0.3 || Math.abs(py - dy) > 0.3 || Math.abs(sct - sc) > 0.01) busy = true;
    }

    // magnet
    mx += (mtx - mx) * 0.18; my += (mty - my) * 0.18;
    if (magEl) {
      magEl.style.transform = 'translate3d(' + mx.toFixed(1) + 'px,' + my.toFixed(1) + 'px,0)';
      if (Math.abs(mtx - mx) > 0.15 || Math.abs(mty - my) > 0.15 || mtx || mty) busy = true;
      else if (!mtx && !mty) { magEl.style.transform = ''; magEl = null; }
    }

    // tilt
    rx += (rxt - rx) * 0.16; ry += (ryt - ry) * 0.16;
    if (tiltEl) {
      tiltEl.style.transform = 'perspective(1200px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
      if (Math.abs(rxt - rx) > 0.02 || Math.abs(ryt - ry) > 0.02 || rxt || ryt) busy = true;
      else if (!rxt && !ryt) { tiltEl.style.transform = ''; tiltEl = null; }
    }

    if (busy) { raf = requestAnimationFrame(loop); }
    else { idle = true; }
  };
  var wake = function () {
    if (idle) { idle = false; raf = requestAnimationFrame(loop); }
  };

  var scanMags = function (now) {
    if (now - lastScan < 2000) return;
    lastScan = now;
    mags = [].slice.call(document.querySelectorAll(MAG));
  };

  var tiltOk = function (el) {
    return el && (!el.classList.contains('rv') || el.classList.contains('in'));
  };

  var vis = false;
  /* the gate: a genuine mousemove is what proves a mouse. it is separate from
     the pointermove handler below because pointermove also fires for touch
     and pen, and neither of those should ever build the ring. */
  document.addEventListener('mousemove', function (e) {
    if (!ensureDial()) return;
    px = e.clientX; py = e.clientY;
    dx = px; dy = py;                       // no swoop in from -100,-100
    if (!vis) { vis = true; shown = true; dial.style.opacity = '1'; }
    wake();
  }, { passive: true });

  document.addEventListener('pointermove', function (e) {
    px = e.clientX; py = e.clientY;
    /* re-show on every move, not only the first: a missed mouseenter after
       the pointer leaves the window must never strand the dial hidden. */
    if (dial && !vis) { vis = true; shown = true; dial.style.opacity = '1'; }

    // magnet: nearest CTA within its own halo leans toward the hand
    scanMags(e.timeStamp || Date.now());
    var best = null, bestD = 1e9, bestR = null;
    for (var i = 0; i < mags.length; i++) {
      var r = mags[i].getBoundingClientRect();
      if (!r.width || r.bottom < -80 || r.top > window.innerHeight + 80) continue;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var d = Math.hypot(px - cx, py - cy);
      var halo = Math.max(r.width, r.height) / 2 + 34;
      if (d < halo && d < bestD) { best = mags[i]; bestD = d; bestR = r; }
    }
    if (best) {
      if (magEl && magEl !== best) magEl.style.transform = '';
      magEl = best;
      var bcx = bestR.left + bestR.width / 2, bcy = bestR.top + bestR.height / 2;
      var fall = 1 - bestD / (Math.max(bestR.width, bestR.height) / 2 + 34);
      mtx = Math.max(-8, Math.min(8, (px - bcx) * 0.18 * (0.4 + fall)));
      mty = Math.max(-6, Math.min(6, (py - bcy) * 0.22 * (0.4 + fall)));
    } else if (magEl) {
      mtx = 0; mty = 0;
    }

    // tilt + light response
    var card = e.target && e.target.closest ? e.target.closest(TILT) : null;
    if (card && !tiltOk(card)) card = null;
    if (card) {
      if (tiltEl && tiltEl !== card) tiltEl.style.transform = '';
      tiltEl = card;
      var cr = card.getBoundingClientRect();
      var nx = (px - cr.left) / cr.width, ny = (py - cr.top) / cr.height;
      card.style.setProperty('--lx', (nx * 100).toFixed(1) + '%');
      card.style.setProperty('--ly', (ny * 100).toFixed(1) + '%');
      ryt = (nx - 0.5) * 2 * 1.2;
      rxt = -(ny - 0.5) * 2 * 1.2;
    } else if (tiltEl) {
      rxt = 0; ryt = 0;
    }

    wake();
  }, { passive: true });

  // lock-on over anything pressable
  document.addEventListener('pointerover', function (e) {
    if (!dial) return;
    var hot = e.target && e.target.closest
      ? e.target.closest('a, button, summary, [role="tab"], input, select, textarea, .vo-bar')
      : null;
    dial.classList.toggle('hot', !!hot);
    sct = hot ? 1.35 : 1;
    wake();
  });
  document.addEventListener('pointerdown', function () { if (dial) { sct = 0.72; wake(); } }, { passive: true });
  document.addEventListener('pointerup', function () { if (dial) { sct = dial.classList.contains('hot') ? 1.35 : 1; wake(); } }, { passive: true });
  document.documentElement.addEventListener('mouseleave', function () { if (dial) { vis = false; dial.style.opacity = '0'; } });
  document.documentElement.addEventListener('mouseenter', function () { if (dial && shown) { vis = true; dial.style.opacity = '1'; } });
})();
