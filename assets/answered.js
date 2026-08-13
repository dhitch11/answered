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
    var pin = function () { nav.classList.toggle('pinned', window.scrollY > 8); };
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
  if (!('IntersectionObserver' in window) || reduced.matches) {
    for (var i = 0; i < rv.length; i++) { rv[i].classList.add('in'); }
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    for (var j = 0; j < rv.length; j++) { io.observe(rv[j]); }
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

  /* ── count up. only on elements carrying a real data-to value. ──────── */
  var counters = document.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        cio.unobserve(en.target);
        var el = en.target;
        var to = parseFloat(el.getAttribute('data-count'));
        var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
        var pre = el.getAttribute('data-pre') || '';
        var suf = el.getAttribute('data-suf') || '';
        if (reduced.matches || isNaN(to)) { el.textContent = pre + to.toFixed(dec) + suf; return; }
        var t0 = null, dur = 1100;
        var tick = function (ts) {
          if (t0 === null) t0 = ts;
          var p = Math.min(1, (ts - t0) / dur);
          var e = 1 - Math.pow(1 - p, 3);
          el.textContent = pre + (to * e).toFixed(dec) + suf;
          if (p < 1) requestAnimationFrame(tick);
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
    var t = 0, raf = 0, visible = true;
    var live = false, analyser = null, bins = null, stream = null;
    var smooth = new Float32Array(N);

    var resize = function () {
      var r = cv.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);   // clamp: a 3x phone
      W = Math.max(1, Math.round(r.width * dpr));        // costs 2.25x fill for
      H = Math.max(1, Math.round(r.height * dpr));       // no visible gain
      cv.width = W; cv.height = H;
      R = Math.min(W, H) * 0.33;
    };
    resize();
    var ro = ('ResizeObserver' in window) ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(cv); else window.addEventListener('resize', resize);

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
    var readout = function (ms) {
      if (!countEl) return;
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
      if (!visible) return;
      t = ts || 0;
      readout(t);
      ctx.clearRect(0, 0, W, H);
      var cx = W / 2, cy = H / 2;

      var burst = live ? 0 : cadence(t);
      if (live && analyser) { analyser.getByteFrequencyData(bins); }

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
        // hi-vis at rest, dialtone cyan at the peaks. the line coming alive.
        var rr = Math.round(227 - heat * 172);
        var gg = Math.round(255 - heat * 55);
        var bb = Math.round(79 + heat * 161);
        ctx.strokeStyle = 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (0.30 + heat * 0.62) + ')';
        ctx.lineWidth = Math.max(1, 1.35 * dpr);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }

      // the inner hairline: the line itself
      ctx.strokeStyle = 'rgba(242,244,240,' + (0.10 + burst * 0.16) + ')';
      ctx.lineWidth = Math.max(1, 1 * dpr);
      ctx.beginPath(); ctx.arc(cx, cy, baseR * 0.9, 0, Math.PI * 2); ctx.stroke();
    };

    if (reduced.matches) {
      // one static frame. still handsome, zero motion.
      for (var s = 0; s < N; s++) { smooth[s] = 0.16 + Math.sin(s / 5) * 0.05; }
      draw(0); cancelAnimationFrame(raf);
    } else {
      raf = requestAnimationFrame(draw);
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }, { threshold: 0 }).observe(cv);
    }
    document.addEventListener('visibilitychange', function () { visible = !document.hidden; });

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
  if (shows.length) {
    var play = function (el) {
      var kind = el.getAttribute('data-show');
      el.classList.add('running');

      if (reduced.matches) {
        el.querySelectorAll('.turn, .sc-result, .hold-hit').forEach(function (n) { n.classList.add('in'); });
        el.querySelectorAll('.rung').forEach(function (n) { n.classList.add('done'); });
        el.querySelectorAll('.inv-row').forEach(function (n) { n.classList.add('cleared'); });
        var c0 = el.querySelector('.hold-clock'); if (c0) c0.textContent = '2:11:04';
        var m0 = el.querySelector('.meter-big'); if (m0) m0.textContent = '$0';
        return;
      }

      if (kind === 'call') {
        var turns = el.querySelectorAll('.turn');
        turns.forEach(function (t, n) { setTimeout(function () { t.classList.add('in'); }, 420 + n * 1150); });
        var res = el.querySelector('.sc-result');
        if (res) setTimeout(function () { res.classList.add('in'); }, 420 + turns.length * 1150 + 500);
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
        if (hit) setTimeout(function () { hit.classList.add('in'); }, 500 + rungs.length * 900 + 700);
      }

      if (kind === 'recover') {
        var rows = el.querySelectorAll('.inv-row');
        var meter = el.querySelector('.meter-big');
        var total = 0;
        rows.forEach(function (r) { total += parseFloat(r.getAttribute('data-amt') || '0'); });
        var left = total;
        var fmt = function (v) { return '$' + Math.round(v).toLocaleString('en-US'); };
        if (meter) meter.textContent = fmt(total);
        rows.forEach(function (r, n) {
          setTimeout(function () {
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
      shows.forEach(function (s) { sio.observe(s); });
    } else {
      shows.forEach(play);
    }
  }



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
    thumb.style.width = btn.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + (btn.offsetLeft - seg.clientLeft - 5) + 'px)';
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
      [].slice.call(document.querySelectorAll('[data-track="' + track + '"]')).forEach(function (el) {
        el.classList.remove('track-swap');
        void el.offsetWidth;            // restart the animation
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
   The hero's primary slot server-renders as a ghost "Get on the list". This
   module asks /api/demo-health once per page load, and ONLY on healthy:true
   does it upgrade the slot to the Hi-Vis call control. The demo number is
   NEVER in the initial HTML. On red or on any failure the upgrade simply
   never happens: the ghost CTA stays, no dead control ever renders, and at
   most one info line reaches the console.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var slot = document.getElementById('cta-primary');
  if (!slot || !window.fetch) return;

  var NUM_TEL = '+19163504869';
  var NUM_TEXT = '+1 (916) 350-4869';

  function upgrade() {
    var coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse) {
      // a phone in a hand: the whole control dials
      var a = document.createElement('a');
      a.className = 'btn btn-primary btn-call';
      a.href = 'tel:' + NUM_TEL;
      a.innerHTML = '<span class="call-l">Hear it answer</span><span class="call-n">' + NUM_TEXT + '</span>';
      slot.replaceChildren(a);
    } else {
      // a desktop: the number is text, with a copy control beside it
      var wrap = document.createElement('span');
      wrap.className = 'btn btn-primary btn-call is-text';
      wrap.innerHTML = '<span class="call-l">Hear it answer</span><span class="call-n">' + NUM_TEXT + '</span>';
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-ghost btn-copy';
      copy.textContent = 'Copy the number';
      copy.addEventListener('click', function () {
        var write = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(NUM_TEL)
          : Promise.reject();
        write.then(function () {
          copy.textContent = 'Copied';
          setTimeout(function () { copy.textContent = 'Copy the number'; }, 1600);
        }).catch(function () {
          // clipboard refused: show the number as selectable text instead
          copy.textContent = NUM_TEXT;
        });
      });
      slot.replaceChildren(wrap, copy);
    }
    if (typeof window.answeredEvent === 'function') {
      window.answeredEvent('demo_button_rendered');
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
