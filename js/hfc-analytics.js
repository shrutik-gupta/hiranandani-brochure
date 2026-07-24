/* ============================================================
   hfc-analytics.js — GA4 tracking for the Arena digital brochure
   (adapted to the dynamic JSON-layer engine in js/app.js)
   ------------------------------------------------------------
   SETUP — one required step:
   1. Create a GA4 property at analytics.google.com
      (Admin → Create property → Web data stream)
   2. Paste your Measurement ID below (looks like G-AB12CD34EF)
   Loaded from index.html just before js/app.js.
   Full report guide: TRACKING.md in the repo root.
   ============================================================ */

const GA_MEASUREMENT_ID = 'G-XXXXXXXXXX';   // ← paste yours here

(function () {
  'use strict';
  if (!/^G-[A-Z0-9]+$/i.test(GA_MEASUREMENT_ID)) {
    console.warn('[hfc-analytics] Set GA_MEASUREMENT_ID at the top of js/hfc-analytics.js');
  }

  /* ---- load gtag.js ---- */
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID, {
    send_page_view: false        // one virtual page_view per brochure page instead
  });

  /* ---- shared state ---- */
  var state = { current: 1, max: 1, t0: Date.now() };
  function totalPages() {
    try { if (PAGE_DATA && PAGE_DATA.length) return PAGE_DATA.length; } catch (e) {}
    return 22;
  }
  function viewMode() {
    return document.body.classList.contains('scroll-mode') ? 'scroll' : 'flip';
  }
  function ev(name, params) {
    gtag('event', name, Object.assign({ view_mode: viewMode() }, params || {}));
  }
  /* page title for labelling, e.g. videos: buildCanvas() puts the page.json
     "title" into aria-label on .pg-canvas */
  function pageLabel(node) {
    var c = node && node.closest ? node.closest('.pg-canvas') : null;
    return (c && c.getAttribute('aria-label')) || ('page ' + state.current);
  }

  /* ============================================================
     1) PAGE DEPTH — which pages users reach, and where they exit
     app.js writes #page=N via replaceState on every flip/scroll
     (refresh(), app.js). replaceState fires no event, so we poll,
     and report once the reader settles on a page for 700 ms.
     ============================================================ */
  function sendPage(n) {
    state.current = n;
    state.max = Math.max(state.max, n);
    var nn = (n < 10 ? '0' : '') + n;
    ev('page_view', {
      page_title: 'Brochure page ' + n,
      page_location: location.origin + location.pathname + '#page=' + n,
      page_path: '/page/' + nn
    });
    ev('brochure_page', { page_number: n, max_page: state.max });
  }

  var lastHash = '', settleTimer = null, lastSent = 0;
  function checkHash() {
    if (location.hash === lastHash) return;
    lastHash = location.hash;
    var m = lastHash.match(/page=(\d+)/);
    if (!m) return;
    var n = +m[1];
    state.current = n;                       // exit event sees mid-flip pages too
    state.max = Math.max(state.max, n);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(function () {
      if (n !== lastSent) { lastSent = n; sendPage(n); }
    }, 700);
  }
  setInterval(checkHash, 400);
  window.addEventListener('hashchange', checkHash);
  setTimeout(function () { if (!lastSent) { lastSent = state.current; sendPage(state.current); } }, 1500);

  /* ============================================================
     2) CLICKS — maps, links, call, email, enquire, any hotspot
     Capture phase, so the engine's stopPropagation() calls in
     guard()/hotspot handlers can't hide clicks from us, and it
     keeps working when pages are rebuilt on mode switches.
     ============================================================ */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;

    if (e.target.closest('#enquireBtn')) { ev('enquire_click', { page_number: state.current }); return; }

    var el = e.target.closest('.hs, a[href^="tel:"], a[href^="mailto:"], [data-track]');
    if (!el) return;
    var label = el.getAttribute('aria-label') || el.getAttribute('data-track') ||
                (el.textContent || '').trim().slice(0, 60) || 'unlabelled';
    var href = el.getAttribute('href') || '';
    var base = { link_label: label, page_number: state.current };

    if (el.classList.contains('hs-play'))                      ev('video_play',  { video_title: label, video_trigger: 'lightbox', page_number: state.current });
    else if (href.indexOf('tel:') === 0)                       ev('call_click',  base);
    else if (href.indexOf('mailto:') === 0)                    ev('email_click', base);
    else if (/google\.[^/]+\/maps|maps\.app\.goo/.test(href))  ev('map_click',   Object.assign({ destination: href }, base));
    else                                                       ev('hotspot_click', Object.assign({ destination: href }, base));
  }, true);

  /* ============================================================
     3) VIDEOS — pages 2, 5, 8, 11, 21 autoplay muted (ambient),
     so a "play" fires for every visitor and means nothing; the
     app also auto-pauses/plays them on visibility. The reliable
     signal of a person choosing to watch is UNMUTING via the
     native controls — code never unmutes. That's what we count
     as video_play (video_trigger:'unmute'), once per video.
     "Who saw the video" is already answered by page views.
     ============================================================ */
  document.addEventListener('volumechange', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO' || v.muted || v._hfcCounted) return;
    v._hfcCounted = true;
    var src = (v.currentSrc || v.src || '').split('/').slice(-2).join('/');
    ev('video_play', {
      video_title: pageLabel(v) + (src ? ' — ' + src : ''),
      video_trigger: 'unmute',
      page_number: state.current
    });
  }, true);

  /* ============================================================
     4) FORM — funnel start + submit + errors
     The Web3Forms handler in app.js is a button-click + fetch
     (no native submit event), so app.js calls HFC.form() /
     HFC.event('form_error') in its success and error branches.
     form_start fires here on first focus of any form field.
     ============================================================ */
  var formStarted = false;
  document.addEventListener('focusin', function (e) {
    if (formStarted || !e.target || !e.target.classList || !e.target.classList.contains('fm-in')) return;
    formStarted = true;
    ev('form_start', { page_number: state.current });
  }, true);

  /* fallback for any future native form */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    ev('form_submit', { form_id: (f && (f.id || f.getAttribute('name'))) || 'enquiry', page_number: state.current });
  }, true);

  /* ============================================================
     5) EXIT SNAPSHOT — last page, deepest page, % read, time
     Sent via beacon when the tab hides, so it survives closing.
     ============================================================ */
  var exitSent = false;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden' || exitSent) return;
    exitSent = true;
    ev('brochure_exit', {
      exit_page: state.current,
      max_page: state.max,
      percent_reached: Math.round(state.max / totalPages() * 100),
      engaged_seconds: Math.round((Date.now() - state.t0) / 1000)
    });
    setTimeout(function () { exitSent = false; }, 4000);   // re-arm if they return
  });

  /* ---- manual API (used by app.js for the Web3Forms flow) ---- */
  window.HFC = {
    page:  sendPage,
    video: function (t) { ev('video_play', { video_title: t, video_trigger: 'manual', page_number: state.current }); },
    form:  function (id, extra) { ev('form_submit', Object.assign({ form_id: id || 'enquiry', page_number: state.current }, extra || {})); },
    event: ev
  };
})();
