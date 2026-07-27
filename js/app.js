/* ============================================================
   DYNAMIC FLIPBOOK ENGINE
   Content lives in  manifest.json  +  pages/<id>/page.json
   Nothing page-specific is hard-coded in here.
   ============================================================ */

const $ = s => document.querySelector(s);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let MANIFEST = null;
let PAGE_DATA = [];
let CONTACT_PAGE = 1;

let pageFlip = null;
let currentIndex = 0;
let busy = false;
let pending = null;
let mq = null;
let phone = false;

/* StPageFlip switches to single-page (portrait) whenever the book element is
   narrower than 2 × minWidth. Keeping the phone book under this cap is what
   guarantees one page at a time instead of a squashed two-page spread. */
const FLIP_MIN_WIDTH = 240;
const SOLO_MAX_WIDTH = 2 * FLIP_MIN_WIDTH - 20;

const wrap = $('#bookWrap'), indicator = $('#indicator'), hintEl = $('#hint');

const svgIco = {
  pin:'<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>',
  play:'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  left:'<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  right:'<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>'
};

/* ============================================================
   CONTENT LOADING
   ============================================================ */
async function fetchJSON(url){
  const r = await fetch(url, { cache:'no-cache' });
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

async function loadContent(){
  MANIFEST = await fetchJSON('manifest.json');
  PAGE_DATA = await Promise.all(
    MANIFEST.pages.map(async id => {
      const data = await fetchJSON('pages/' + id + '/page.json');
      data.id = id;
      data.base = 'pages/' + id + '/';
      return data;
    })
  );
  CONTACT_PAGE = MANIFEST.contactPage || PAGE_DATA.length;
}

function asset(page, src){
  if (!src) return '';
  return /^(https?:)?\/\/|^\//.test(src) ? src : page.base + src;
}

/* ============================================================
   DOM HELPERS
   ============================================================ */
function el(tag, cls, css){
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (css) e.style.cssText = css;
  return e;
}
function box(l){
  let s = 'left:' + (l.x||0) + '%;top:' + (l.y||0) + '%;';
  if (l.w != null) s += 'width:' + l.w + '%;';
  if (l.h != null) s += 'height:' + l.h + '%;';
  if (l.z != null) s += 'z-index:' + l.z + ';';
  if (l.rotate) s += 'transform:rotate(' + l.rotate + 'deg);';
  return s;
}
/* stop the flip engine from hijacking drags/taps on interactive widgets */
function guard(node){
  ['pointerdown','touchstart','mousedown'].forEach(ev =>
    node.addEventListener(ev, e => e.stopPropagation()));
}

/* starts/stops media & carousels when they enter/leave the viewport */
const mediaIO = new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.target._onVisible) en.target._onVisible(en.isIntersecting); });
}, { threshold: 0.25 });

/* ============================================================
   LAYER RENDERERS
   Every renderer: (layer, page, opts) → DOM node (or null).
   opts.thumb === true when rendering the miniature tray version:
   render a static, lightweight look-alike (no timers, no media).
   ============================================================ */
function textStyle(t, s){
  t.style.fontFamily = s.font === 'serif' ? 'var(--serif)' : 'var(--sans)';
  t.style.fontSize = (s.size || 3) + 'cqw';
  if (s.color) t.style.color = s.color;
  if (s.weight) t.style.fontWeight = s.weight;
  if (s.italic) t.style.fontStyle = 'italic';
  if (s.align) t.style.textAlign = s.align;
  if (s.letterSpacing != null) t.style.letterSpacing = s.letterSpacing + 'em';
  if (s.lineHeight) t.style.lineHeight = s.lineHeight;
  if (s.uppercase) t.style.textTransform = 'uppercase';
  if (s.shadow) t.style.textShadow = '0 2px 12px rgba(0,0,0,.55)';
}

const RENDERERS = {

  image(l, page, o){
    const w = el('div','ly', box(l));
    const img = el('img','ly-img');
    img.src = asset(page, l.src);
    img.alt = l.alt || '';
    img.loading = 'lazy';
    img.draggable = false;
    if (l.fit) img.style.objectFit = l.fit;
    if (l.radius) img.style.borderRadius = l.radius;
    w.appendChild(img);
    return w;
  },

  text(l, page, o){
    const t = el('div','ly ly-text', box(l));
    textStyle(t, l.style || {});
    t.textContent = l.text || '';
    return t;
  },

  /* small pictogram: like image but keeps intrinsic ratio (give w only) */
  icon(l, page){
    const w = el('div','ly', box(l));
    const img = el('img','ly-icon');
    img.src = asset(page, l.src);
    img.alt = l.alt || '';
    img.loading = 'lazy';
    img.draggable = false;
    w.appendChild(img);
    return w;
  },

  /* horizontal / vertical rule — handy for layout without images */
  rule(l){
    const r = el('div','ly', box(l));
    r.style.background = l.color || 'var(--gold)';
    if (l.h == null) r.style.height = (l.thickness || 0.15) + 'cqw';
    return r;
  },

  html(l, page, o){
    const t = el('div','ly', box(l));
    t.innerHTML = l.html || '';
    return t;
  },

  /* container whose children are positioned in % OF THE GROUP box —
     build a layout block once, then move/scale it as one unit */
  group(l, page, o){
    const g = el('div','ly ly-group', box(l));
    (l.children || []).forEach(c => {
      const r = RENDERERS[c.type];
      if (!r) return;
      const node = r(c, page, o);
      if (node) g.appendChild(node);
    });
    return g;
  },

  video(l, page, o){
    if (o.thumb){                                    // tray miniature: poster or dark slab
      const w = el('div','ly ly-video', box(l));
      if (l.poster){ const p = el('img','ly-img'); p.src = asset(page, l.poster); p.style.objectFit='cover'; w.appendChild(p); }
      return w;
    }
    if (l.mode === 'lightbox'){
      const b = el('button','hs hs-play', 'left:' + l.x + '%;top:' + l.y + '%');
      b.innerHTML = '<span class="ring">' + svgIco.play + '</span><span class="chip">' + (l.label||'Play') + '</span>';
      b.setAttribute('aria-label', l.label || 'Play video');
      b.addEventListener('click', e => { e.stopPropagation(); openLightbox(asset(page, l.src), l.label); });
      guard(b);
      return b;
    }
    const w = el('div','ly ly-video interactive', box(l));
    const v = document.createElement('video');
    v.src = asset(page, l.src);
    v.playsInline = true;
    v.preload = 'none';
    if (l.poster) v.poster = asset(page, l.poster);
    v.controls = l.controls === true;
    if (l.autoplay) {
      v.muted = true;
      v.loop = l.loop !== false;
      v.preload = "metadata";
      w._onVisible = vis => {
        if (vis) {
          v.play().catch(console.error);
        } else {
          v.pause();
        }
      };
      mediaIO.observe(w);
    }
    guard(w);
    w.appendChild(v);
    return w;
  },

  /* carousel — per-page behaviour via JSON:
       autoplay : true/false        (default true)
       interval : ms                (default 4000; e.g. 5000 = every 5 s)
       arrows   : true/false        (default false — manual prev/next buttons)
       dots     : true/false        (default true)
  */
  carousel(l, page, o){
    /* RICH MODE: each slide is its own stack of layers, cross-faded.
       Use "slides":[ { "layers":[…] }, … ] instead of "images":[…].
       Layers inside a slide are positioned in % of the carousel box and
       may be any renderer type (image, text, image-as-icon, underline…). */
    if (l.slides){
      if (o.thumb){
        const w = el('div','ly ly-carousel', box(l));
        const s = el('div','ss-slide on');
        ((l.slides[0] && l.slides[0].layers) || []).forEach(c => {
          try { const r = RENDERERS[c.type]; if (!r) return;
            const node = r(c, page, o); if (node) s.appendChild(node); }
          catch (err) { console.error('Slide layer failed on', page.id, c && c.type, err); }
        });
        w.appendChild(s); return w;
      }

      const w = el('div','ly ly-carousel ly-slideshow interactive', box(l));
      const n = l.slides.length;
      const slideMode = l.transition || 'fade';          // 'fade' | 'slide' | 'scroller'
      const moving    = slideMode === 'slide' || slideMode === 'scroller';

      // scroller geometry (% of carousel width)
      const peek  = slideMode === 'scroller' ? (l.peek != null ? l.peek : 6) : 0;
      const gap   = slideMode === 'scroller' ? (l.gap  != null ? l.gap  : 2) : 0;
      const peekLeft = (l.peekSide === 'right') ? 0 : peek;   // NEW
      const paneW = 100 - peekLeft - peek;                    // CHANGED
      const step  = paneW + gap;

      const isSlideLayer = c => c.type === 'image' || c.type === 'html';

      let track = null;
      if (moving){
        track = el('div','ss-track');
        track.style.cssText = 'position:absolute;inset:0;display:flex;will-change:transform;';
      }

      const fadeSlides = l.slides.map((sl, k) => {
        const layers = sl.layers || [];
        if (moving){
          const pane = el('div','ss-pane');
          pane.style.cssText = 'position:relative;flex:0 0 ' + paneW + '%;height:100%;margin-right:' + gap + '%;';
          layers.filter(isSlideLayer).forEach(c => {
            try { const r = RENDERERS[c.type]; if (!r) return;
              const node = r(c, page, o); if (node) pane.appendChild(node); }
            catch(e){ console.error('pane layer', page.id, c&&c.type, e); }
          });
          track.appendChild(pane);
        }
        const fade = el('div','ss-slide' + (k === 0 ? ' on' : ''));
        if (slideMode === 'scroller'){                    // align captions with the active pane
          fade.style.left = peekLeft + '%';                   // CHANGED (was: peek + '%')
          fade.style.right = 'auto';
          fade.style.width = paneW + '%';
        }
        const fadeLayers = moving ? layers.filter(c => !isSlideLayer(c)) : layers;
        fadeLayers.forEach(c => {
          try { const r = RENDERERS[c.type]; if (!r) return;
            const node = r(c, page, o); if (node) fade.appendChild(node); }
          catch(e){ console.error('fade layer', page.id, c&&c.type, e); }
        });
        return fade;
      });

      if (track) w.appendChild(track);
      fadeSlides.forEach(f => w.appendChild(f));

      let dots = null;
      if (l.dots !== false){
        dots = el('div','car-dots ss-dots');
        l.slides.forEach(() => dots.appendChild(el('i')));
        w.appendChild(dots);
      }

      let idx = 0, timer = null, visible = false;
      const autoplay = l.autoplay === true;               // slider: off unless explicitly asked
      const offsetFor = i => peekLeft - i * step;

      function paint(anim){
        if (track){
          track.style.transition = (anim && !reduceMotion)
            ? 'transform .45s cubic-bezier(.25,.8,.3,1)' : 'none';
          track.style.transform = 'translateX(' + offsetFor(idx) + '%)';
        }
        fadeSlides.forEach((s,k) => s.classList.toggle('on', k === idx));
        if (dots) dots.querySelectorAll('i').forEach((d,k) => d.classList.toggle('on', k === idx));
      }
      function show(i, anim){
        idx = (slideMode === 'scroller')
          ? Math.max(0, Math.min(n - 1, i))               // clamp: user-driven, no wrap
          : ((i % n) + n) % n;
        paint(anim !== false);
      }
      /* a user drag never wraps — running past the last slide is the signal
         that the gesture was meant for the page underneath */
      function showClamped(i){ show(Math.max(0, Math.min(n - 1, i))); }
      w._canMove = dir => n > 1 && (dir > 0 ? idx < n - 1 : idx > 0);
      function go(i, user){ show(i); if (user) restart(); }
      function restart(){
        clearInterval(timer);
        if (autoplay && visible && !reduceMotion && n > 1)
          timer = setInterval(() => go(idx + 1), l.interval || 4000);
      }
      w._onVisible = vis => { visible = vis; restart(); };
      mediaIO.observe(w);

      if (l.arrows === true && n > 1){
        const mk = (dir, ico) => {
          const b = el('button','car-btn ' + dir);
          b.innerHTML = ico;
          b.setAttribute('aria-label', dir === 'prev' ? 'Previous image' : 'Next image');
          if (l.arrowColor) b.style.color = l.arrowColor;
          if (l.arrowSize){
            b.style.width  = l.arrowSize + 'px';
            b.style.height = l.arrowSize + 'px';
            const sv = b.querySelector('svg');
            if (sv){
              sv.style.width  = Math.round(l.arrowSize * 0.62) + 'px';
              sv.style.height = Math.round(l.arrowSize * 0.62) + 'px';
            }
          }
          if (l.arrowY != null) b.style.top = l.arrowY + '%';
          if (l.arrowGap != null){                       // sit either side of the dots
            b.style.right = 'auto';
            b.style.left = 'calc(50% ' + (dir === 'prev' ? '- ' : '+ ') + l.arrowGap + '%)';
            b.style.transform = 'translate(-50%,-50%)';
          }
          b.addEventListener('click', e => { e.stopPropagation(); go(idx + (dir === 'next' ? 1 : -1), true); });
          guard(b); w.appendChild(b);
        };
        mk('prev', svgIco.left); mk('next', svgIco.right);
      }

      /* ---- drag: content follows the finger, then snaps ---- */
      let startX = null, dragging = false, dxPct = 0;
      w.addEventListener('pointerdown', e => {
        if (e.target.closest('.car-btn')) return;
        startX = e.clientX; dragging = true; dxPct = 0;
        clearInterval(timer);
        if (w.setPointerCapture) { try { w.setPointerCapture(e.pointerId); } catch(_){} }
        if (track) track.style.transition = 'none';
      });
      w.addEventListener('pointermove', e => {
        if (!dragging) return;
        dxPct = (e.clientX - startX) / w.offsetWidth * 100;
        if (track) track.style.transform = 'translateX(' + (offsetFor(idx) + dxPct) + '%)';
      });
      function endDrag(){
        if (!dragging) return;
        dragging = false;
        if (slideMode === 'scroller'){
          const moved = Math.round(-dxPct / step);
          const extra = Math.abs(dxPct) > step * 0.18 && moved === 0 ? (dxPct < 0 ? 1 : -1) : 0;
          show(idx + moved + extra);
        } else {
          if (Math.abs(dxPct) > 12) showClamped(idx + (dxPct < 0 ? 1 : -1));
          else show(idx);
        }
        restart();
      }
      w.addEventListener('pointerup', endDrag);
      w.addEventListener('pointercancel', endDrag);
      w.addEventListener('pointerleave', endDrag);
      guard(w);
      paint(false);
      return w;
    }

    if (o.thumb){                                    // miniature: first slide only
      const w = el('div','ly ly-carousel', box(l));
      if (l.images && l.images[0]){
        const img = el('img','ly-img');
        img.src = asset(page, l.images[0]); img.style.objectFit = 'cover';
        w.appendChild(img);
      }
      return w;
    }
    const w = el('div','ly ly-carousel interactive', box(l));
    const track = el('div','car-track');
    const imgs = l.images || [];
    const n = imgs.length;
    imgs.forEach(src => {
      const s = el('div','car-slide');
      const img = el('img');
      img.src = asset(page, src); img.alt = ''; img.loading = 'lazy'; img.draggable = false;
      s.appendChild(img); track.appendChild(s);
    });
    w.appendChild(track);

    let dots = null;
    if (l.dots !== false){
      dots = el('div','car-dots');
      l.images.forEach(() => dots.appendChild(el('i')));
      w.appendChild(dots);
    }

    let idx = 0, timer = null, visible = false;
    const autoplay = slideMode === 'scroller'
        ? l.autoplay === true          
        : l.autoplay !== false;
    function paint(){
      track.style.transform = 'translateX(' + (-idx * 100) + '%)';
      if (dots) dots.querySelectorAll('i').forEach((d,k) => d.classList.toggle('on', k === idx));
    }
    function go(i, user){
      idx = ((i % n) + n) % n;
      track.style.transition = reduceMotion ? 'none' : 'transform .5s cubic-bezier(.25,.7,.3,1)';
      paint();
      if (user) restart();
    }
    function restart(){
      clearInterval(timer);
      if (autoplay && visible && !reduceMotion && n > 1)
        timer = setInterval(() => go(idx + 1), l.interval || 4000);
    }
    w._onVisible = vis => { visible = vis; restart(); };
    mediaIO.observe(w);

    if (l.arrows && n > 1){
      const mk = (dir, ico) => {
        const b = el('button','car-btn ' + dir);
        b.innerHTML = ico;
        b.setAttribute('aria-label', dir === 'prev' ? 'Previous image' : 'Next image');
        b.addEventListener('click', e => { e.stopPropagation(); go(idx + (dir === 'next' ? 1 : -1), true); });
        guard(b);
        w.appendChild(b);
      };
      mk('prev', svgIco.left); mk('next', svgIco.right);
    }

    /* drag / swipe */
    let startX = null, dragging = false;
    w.addEventListener('pointerdown', e => {
      if (e.target.closest('.car-btn')) return;
      startX = e.clientX; dragging = true; clearInterval(timer);
      w.setPointerCapture(e.pointerId);
      track.style.transition = 'none';
    });
    w.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = (e.clientX - startX) / w.offsetWidth * 100;
      track.style.transform = 'translateX(' + (-idx * 100 + dx) + '%)';
    });
    function endDrag(e){
      if (!dragging) return;
      dragging = false;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > w.offsetWidth * 0.15) go(idx + (dx < 0 ? 1 : -1), true);
      else go(idx, true);
    }
    w.addEventListener('pointerup', endDrag);
    w.addEventListener('pointercancel', endDrag);
    guard(w);
    paint();
    return w;
  },

  /* ---- Web3Forms-backed contact form ----
     JSON: { "type":"form", "x":..,"y":..,"w":..,
             "accessKey":"...", "subject":"...", "fromName":"...",
             "submitLabel":"Submit",
             "fields":[ {name,label,type:"text|email|tel|textarea",required,rows,placeholder} ] } */
  form(l, page, o){
    const w = el('div','ly ly-form', box(l));
    const fm = el('div','fm');
    const inputs = [];

    (l.fields || []).forEach(f => {
      const lab = el('label','fm-lab');
      lab.textContent = f.label || f.name;
      if (f.required) lab.innerHTML += ' <span class="fm-req">*</span>';
      const isArea = f.type === 'textarea';
      const inp = document.createElement(isArea ? 'textarea' : 'input');
      if (!isArea) inp.type = f.type || 'text';
      if (isArea && f.rows) inp.rows = f.rows;
      inp.className = 'fm-in';
      inp.name = f.name;
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.required = !!f.required;
      inp.autocomplete = 'on';
      lab.setAttribute('for', page.id + '-' + f.name);
      inp.id = page.id + '-' + f.name;
      fm.appendChild(lab); fm.appendChild(inp);
      inputs.push({ cfg: f, el: inp });
    });

    /* honeypot — Web3Forms drops submissions that fill this */
    const bot = document.createElement('input');
    bot.type = 'checkbox'; bot.name = 'botcheck'; bot.className = 'fm-bot';
    bot.tabIndex = -1; bot.setAttribute('aria-hidden','true');
    fm.appendChild(bot);

    const btn = el('button','fm-btn');
    btn.type = 'button';
    btn.textContent = l.submitLabel || 'Submit';
    const note = el('div','fm-note');
    fm.appendChild(btn); fm.appendChild(note);
    w.appendChild(fm);

    if (o.thumb){ fm.style.pointerEvents = 'none'; return w; }

    function say(text, ok){
      note.textContent = text;
      note.className = 'fm-note' + (ok ? ' ok' : text ? ' err' : '');
    }

    btn.addEventListener('click', async () => {
      say('');
      for (const { cfg, el: inp } of inputs){
        const v = inp.value.trim();
        if (cfg.required && !v){ say('Please fill in ' + (cfg.label || cfg.name) + '.'); inp.focus(); return; }
        if (inp.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)){
          say('Please enter a valid email address.'); inp.focus(); return;
        }
      }
      if (bot.checked) return;                       // bot

      const key = l.accessKey || (MANIFEST && MANIFEST.web3formsKey);
      if (!key){ say('Form is not configured (missing access key).'); return; }

      const payload = {
        access_key: key,
        subject: l.subject || 'New enquiry',
        from_name: l.fromName || (MANIFEST && MANIFEST.title) || 'Digital Brochure',
        botcheck: false
      };
      inputs.forEach(({ cfg, el: inp }) => { payload[cfg.name] = inp.value.trim(); });

      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Sending…';
      try {
        const res = await fetch('https://api.web3forms.com/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success){
          say(l.successMessage || 'Thank you — we will be in touch shortly.', true);
          inputs.forEach(({ el: inp }) => { inp.value = ''; });
          if (window.HFC) HFC.form('enquiry');                       // analytics: count the lead
        } else {
          say(data.message || 'Something went wrong. Please try again.');
          if (window.HFC) HFC.event('form_error', { reason: data.message || 'api' });
        }
      } catch (err){
        console.error('Web3Forms error', err);
        say('Network error. Please try again.');
        if (window.HFC) HFC.event('form_error', { reason: 'network' });
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    /* keep typing/selection from reaching the flip engine */
    guard(w);
    ['keydown','keyup','pointerdown','mousedown','touchstart','click'].forEach(ev =>
      fm.addEventListener(ev, e => e.stopPropagation()));

    return w;
  },

  map(l, page, o){
    if (o.thumb) return null;
    const a = el('a', l.w ? 'hs hs-area' : 'hs hs-pin',
      l.w ? box(l) : 'left:' + l.x + '%;top:' + l.y + '%');
    a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(l.q);
    a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = (l.w ? '' : '<span class="dot">' + svgIco.pin + '</span>')
                + '<span class="chip">' + (l.label||'') + '</span>';
    a.setAttribute('aria-label', l.label || 'Open map');
    a.addEventListener('click', e => e.stopPropagation());
    return a;
  },

  link(l, page, o){
    if (o.thumb) return null;
    const a = el('a', l.w ? 'hs hs-area' : 'hs hs-pin',
      l.w ? box(l) : 'left:' + l.x + '%;top:' + l.y + '%');
    a.href = l.href; a.target = /^https?:/.test(l.href) ? '_blank' : '_self'; a.rel = 'noopener';
    a.innerHTML = (l.w ? '' : '<span class="dot">' + svgIco.pin + '</span>')
                + '<span class="chip">' + (l.label||'') + '</span>';
    a.setAttribute('aria-label', l.label || 'Open link');
    a.addEventListener('click', e => e.stopPropagation());
    return a;
  }
};

/* ============================================================
   PAGE BUILDER — used for full sheets AND live tray miniatures
   ============================================================ */
function buildCanvas(data, opts){
  opts = opts || {};
  const canvas = el('div','pg-canvas' + (opts.thumb ? ' thumbMode' : ''));
  canvas.setAttribute('aria-label', data.title || data.id);

  if (data.background){
    const bg = el('img','pg-bg');
    bg.src = asset(data, data.background.src);
    bg.alt = ''; bg.draggable = false; bg.loading = 'lazy';
    if (data.background.fit) bg.style.objectFit = data.background.fit;
    canvas.appendChild(bg);
  }
  if (data.backgroundColor) canvas.style.background = data.backgroundColor;

  (data.layers || []).forEach(l => {
    try {
      const r = RENDERERS[l.type];
      if (!r){ console.warn('Unknown layer type "' + l.type + '" on page', data.id); return; }
      const node = r(l, data, opts);
      if (node) canvas.appendChild(node);
    } catch (err) {
      console.error('Layer failed on page', data.id, '→ type:', l && l.type, err);
    }
  });
  return canvas;
}

function makeSheet(i, cls){
  const data = PAGE_DATA[i];
  const pg = document.createElement('div');
  const hard = (i === 0 || i === PAGE_DATA.length - 1);
  pg.className = cls + (hard && cls === 'sheet' ? ' --hard' : '');
  if (cls === 'sheet') pg.setAttribute('data-density', hard ? 'hard' : 'soft');
  pg.dataset.i = i;
  pg.appendChild(buildCanvas(data));
  return pg;
}

function pauseInlineMedia(){
  wrap.querySelectorAll('video').forEach(v => { if (!v.paused) v.pause(); });
}

/* ============================================================
   SIZING — keep the whole brochure inside the stage.
   StPageFlip derives its height from the container width, so a
   wide window used to push the book taller than the stage and
   crop the bottom. fitBook() caps the book's width so
   pageHeight never exceeds the stage height.
   ============================================================ */
function bookWidth(){
  const stage = $('#stage');
  const sz = MANIFEST.pageSize || { width:517, height:731 };
  const ratio = sz.width / sz.height;

  const cs = getComputedStyle(stage);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 10;
  const availW = stage.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

  /* phones always read one page at a time; on larger screens follow whatever
     orientation the engine has settled on */
  const solo = phone || !pageFlip || pageFlip.getOrientation() === 'portrait';
  const across = solo ? 1 : 2;
  let target = Math.max(FLIP_MIN_WIDTH * across, Math.min(availW, availH * ratio * across));
  if (phone) target = Math.min(target, SOLO_MAX_WIDTH, availW);
  return target;
}

function fitBook(){
  if (!pageFlip) return;
  const book = $('#book');
  if (!book) return;
  const target = bookWidth();
  if (Math.abs(parseFloat(book.style.width || 0) - target) > 1){
    book.style.width = target + 'px';
    book.style.margin = '0 auto';
    try { pageFlip.getUI().update(); } catch(e){}
  }
}

/* ============================================================
   FLIP MODE (desktop / tablet)
   ============================================================ */
function buildFlip(){
  wrap.innerHTML = '<div id="book"></div>';
  const bookEl = $('#book');
  PAGE_DATA.forEach((_, i) => bookEl.appendChild(makeSheet(i, 'sheet')));

  /* size the element before the engine reads it, so phones never flash a
     two-page spread before fitBook() narrows it down */
  bookEl.style.width = bookWidth() + 'px';
  bookEl.style.margin = '0 auto';

  const sz = MANIFEST.pageSize || { width:517, height:731 };
  pageFlip = new St.PageFlip(bookEl, {
    width: sz.width, height: sz.height,
    size: 'stretch',
    minWidth: FLIP_MIN_WIDTH, maxWidth: 1600, minHeight: 320, maxHeight: 2200,
    showCover: true,
    maxShadowOpacity: 0.42,
    flippingTime: reduceMotion ? 120 : 850,
    usePortrait: true,
    mobileScrollSupport: false,
    clickEventForward: true,
    showPageCorners: false,
    swipeDistance: 30,
    /* pages are interactive (carousels, videos): a click inside the page
       must NOT turn it. Only corner-drag / swipe / arrows / keys flip. */
    disableFlipByClick: MANIFEST.flipOnClick !== true
  });
  pageFlip.loadFromHTML(bookEl.querySelectorAll('.sheet'));

  pageFlip.on('flip', e => { currentIndex = e.data; refresh(); hint(false); applyShift(); });
  pageFlip.on('changeOrientation', () => { fitBook(); refresh(); applyShift(); });
  pageFlip.on('changeState', e => {
    busy = e.data !== 'read';
    if (busy) pauseInlineMedia();
    if (!busy && pending) { const run = pending; pending = null; run(); }
  });

  if (currentIndex > 0) pageFlip.turnToPage(currentIndex);
  bookEl.style.transition = 'none';
  requestAnimationFrame(() => {
    fitBook();
    applyShift();
    requestAnimationFrame(() => { bookEl.style.transition = ''; });
  });
}

/* ============================================================
   PHONE SWIPE
   The engine's own touch handling is no use here: almost every page is
   covered by a video, carousel or hotspot, and those either stop the event
   (guard()) or are an <a>/<button>, which the engine skips on purpose. So on
   phones we listen in the capture phase — ahead of every widget — and drive
   the same fold the engine uses for a corner drag, which is what makes the
   page follow the finger instead of just cutting to the next one.
   ============================================================ */
function bindSwipe(){
  const START = 12;                 // px of travel before we start folding
  const MIN_TURN = 42;              // ...and before letting go actually turns it
  const FLICK = 0.35;               // px/ms — a quick flick turns on any distance
  let sx = 0, sy = 0, st = 0, live = false, car = null, origin = null, at = null, dir = 0;

  /* Anchor the fold on the corner the turn has to come from — the engine reads
     the direction off the point it starts from, so starting it under the
     finger would fold backwards for any swipe begun on the left of the page.
     From there the fold travels exactly as far as the finger does.

     A backward turn starts on the spine. In single-page (portrait) mode that
     is NOT rect.left: the engine keeps a virtual left page, so the rect begins
     a whole page width off-screen and rect.left + 10 would run the whole fold
     outside the visible page — the drag did nothing and the release always
     landed short of the halfway point the engine needs to complete the turn. */
  function cornerFor(step, clientY){
    const r = pageFlip.getRender().getRect();
    const box = pageFlip.getUI().getDistElement().getBoundingClientRect();
    const spine = r.left + (pageFlip.getOrientation() === 'portrait' ? r.pageWidth : 0);
    return {
      x: step > 0 ? r.left + 2 * r.pageWidth - 10 : spine + 10,
      y: Math.min(Math.max(clientY - box.top, r.top + 2), r.top + r.height - 2)
    };
  }

  wrap.addEventListener('touchstart', e => {
    live = false; origin = null; at = null;
    if (!phone || !pageFlip) return;
    e.stopPropagation();            // on phones this layer replaces the engine's own
    if (busy || e.touches.length !== 1) { car = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    car = e.target.closest ? e.target.closest('.ly-carousel') : null;
  }, true);

  wrap.addEventListener('touchmove', e => {
    if (!phone || !pageFlip) return;
    e.stopPropagation();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;

    if (!live){
      if (origin === false) return;                       // gesture already conceded
      if (Math.abs(dx) < START || Math.abs(dx) < Math.abs(dy)) return;
      const step = dx < 0 ? 1 : -1;
      /* a carousel that still has slides in that direction owns the gesture */
      if (car && car._canMove && car._canMove(step)){ origin = false; return; }
      const n = PAGE_DATA.length, i = pageFlip.getCurrentPageIndex();
      if ((step > 0 && i >= n - 1) || (step < 0 && i <= 0)){ origin = false; return; }
      origin = cornerFor(step, sy);
      dir = step;
      live = true;
      pageFlip.startUserTouch(origin);
      /* Lock the direction while the point is still on its corner: the engine
         reads it off whichever point reaches fold() first, and a fast flick's
         first move can land past the middle of the page — read as a turn the
         other way. A 6px nudge is enough to clear its 5px dead zone. */
      pageFlip.userMove({ x: origin.x - 6 * step, y: origin.y }, true);
    }
    at = { x: origin.x + dx, y: origin.y + dy };
    pageFlip.userMove(at, true);
    if (e.cancelable) e.preventDefault();   // no rubber-banding, no stray tap
  }, { capture: true, passive: false });

  /* Let go of the fold and see the turn through.

     The engine's own release (userStop → stopMove) completes a turn only once
     the fold has travelled past the spine — a whole page width, nearly the
     width of the phone. Anything shorter snapped back, so a page only ever
     turned when you dragged it the entire way across; and backwards, where the
     fold starts *on* the spine, the opposite: the slightest drag turned it.

     So decide it here — distance, or a quick flick — and then hand the fold to
     the engine's own finishing animation from wherever the finger left it. The
     page carries on from that point at its normal speed instead of waiting for
     the finger to do all the work. */
  function settle(commit){
    pageFlip.userStop(at, true);            // release, but skip the engine's verdict
    let fc = null, calc = null;
    try { fc = pageFlip.getFlipController(); calc = fc.getCalculation(); } catch (err) {}
    if (!fc || !calc) { pageFlip.userStop(at, false); return; }
    const r = fc.getBoundsRect();
    const y = calc.getCorner() === 'bottom' ? r.height : 0;
    fc.animateFlippingTo(calc.getPosition(), { x: commit ? -r.pageWidth : r.pageWidth, y }, commit);
  }

  const end = e => {
    if (!phone || !pageFlip) return;
    e.stopPropagation();
    if (live && at){
      const travel = (origin.x - at.x) * dir;             // px dragged towards the turn
      const speed  = travel / Math.max(1, Date.now() - st);
      settle(travel > MIN_TURN || (travel > START && speed > FLICK));
    }
    live = false; origin = null; at = null; car = null; dir = 0;
  };
  wrap.addEventListener('touchend', end, true);
  wrap.addEventListener('touchcancel', end, true);
}

function applyShift(){
  const book = $('#book');
  if (!book || !pageFlip) return;
  let px = 0;
  const parent = book.classList.contains('stf__parent')
    ? book
    : book.querySelector('.stf__parent');
  if (parent && pageFlip.getOrientation() !== 'portrait') {
    const n = pageFlip.getPageCount(), i = pageFlip.getCurrentPageIndex();
    const quarter = parent.offsetWidth / 4;
    if (i === 0) px = -quarter;
    else if (n % 2 === 0 && i === n - 1) px = quarter;
  }
  book.style.transform = 'translateX(' + px + 'px)';
}

/* ============================================================
   NAVIGATION / SHARED UI
   ============================================================ */
/* disableFlipByClick makes the engine ignore any flip whose origin point is
   not on a page corner — that is what stops a tap inside a page from turning
   it. But flipPrev() aims at x=10 in element space, and in single-page
   (portrait) mode the book's virtual left edge sits a whole page width
   off-screen, so that point is nowhere near the left corner and every
   backwards turn is silently dropped. Lift the guard for the instant of a
   deliberate, programmatic turn; taps still cannot flip. */
function turn(run){
  const s = pageFlip.getSettings();
  const guarded = s.disableFlipByClick;
  s.disableFlipByClick = false;
  try { run(); } finally { s.disableFlipByClick = guarded; }
}

function goto(i){
  if (!pageFlip) return;
  i = Math.max(0, Math.min(PAGE_DATA.length - 1, i));
  const run = () => turn(() => pageFlip.flip(i));
  if (busy) { pending = run; return; }
  run();
}
function nav(dir){
  if (!pageFlip) return;
  const step = dir === 'next' ? 1 : -1;
  const n = PAGE_DATA.length, i = pageFlip.getCurrentPageIndex();
  if ((step > 0 && i >= n - 1) || (step < 0 && i <= 0)) return;
  const run = () => turn(() => (step > 0 ? pageFlip.flipNext() : pageFlip.flipPrev()));
  if (busy) { pending = run; return; }
  run();
}

function refresh(){
  const n = PAGE_DATA.length, i = currentIndex;
  let label;
  const spread = pageFlip && pageFlip.getOrientation() !== 'portrait'
              && i !== 0 && !(n % 2 === 0 && i === n - 1);
  if (spread) {
    const L = (i % 2 === 1) ? i : i - 1;
    label = (L + 1) + '–' + (L + 2) + ' / ' + n;
  } else label = (i + 1) + ' / ' + n;
  indicator.innerHTML = label + '<small>page</small>';

  document.querySelectorAll('.th').forEach((t, k) => {
    let active = k === i;
    if (spread) { const L = (i % 2 === 1) ? i : i - 1; active = (k === L || k === L + 1); }
    t.classList.toggle('active', active);
  });

  const atStart = i <= 0, atEnd = i >= n - 1;
  [$('#prevBtn'), $('#prevArrow')].forEach(b => b.setAttribute('aria-disabled', atStart));
  [$('#nextBtn'), $('#nextArrow')].forEach(b => b.setAttribute('aria-disabled', atEnd));

  try { history.replaceState(null, '', '#page=' + (i + 1)); } catch (e) {}
}

/* Rebuild the book whenever we cross the phone breakpoint — the engine caches
   its geometry at construction, so a straight resize is not enough. */
function setMode(){
  const wasPhone = phone;
  phone = mq.matches;
  if (pageFlip && wasPhone === phone) { fitBook(); applyShift(); return; }

  if (pageFlip) { try { pageFlip.destroy(); } catch (e) {} pageFlip = null; }
  busy = false; pending = null;
  document.body.classList.toggle('phone-mode', phone);
  buildFlip();
  hintEl.textContent = phone
    ? 'Swipe to turn the page'
    : 'Drag a page corner — or use your arrow keys';
  refresh();
}

/* ---------- live miniature thumbnails (no thumb.jpg needed) ----------
   Each tray thumbnail is the page itself, rendered small: since text
   sizes use container-query units, everything scales automatically. */
function buildThumbs(){
  const thumbRow = $('#thumbRow');
  thumbRow.innerHTML = '';
  const sz = MANIFEST.pageSize || { width:517, height:731 };
  PAGE_DATA.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'th'; b.setAttribute('aria-label', 'Go to page ' + (i + 1));
    const mini = el('div','mini');
    mini.style.aspectRatio = sz.width + '/' + sz.height;
    mini.appendChild(buildCanvas(p, { thumb:true }));
    b.appendChild(mini);
    const n = el('span','n'); n.textContent = i + 1;
    b.appendChild(n);
    b.addEventListener('click', () => { goto(i); toggleTray(false); });
    thumbRow.appendChild(b);
  });
}

/* ---------- controls / tray / lightbox / hint ---------- */
const tray = $('#tray');
function toggleTray(force){
  const open = typeof force === 'boolean' ? force : !tray.classList.contains('open');
  tray.classList.toggle('open', open);
  $('#trayBtn').setAttribute('aria-expanded', open);
}

const lb = $('#lightbox'), lbFrame = $('#lbFrame');
function openLightbox(src, title){ lbFrame.src = src; $('#lbTitle').textContent = title || ''; lb.classList.add('open'); }
function closeLightbox(){ lb.classList.remove('open'); lbFrame.src = ''; }

/* ---------- fullscreen ----------
   iPhone Safari lets nothing but a <video> go fullscreen, and older
   Safari/Android only ship the webkit-prefixed call. So: try the standard
   call, then the prefixed one, and if neither is allowed — or the request is
   rejected — fall back to a faux fullscreen that hides our own chrome and
   gives the whole viewport to the book.

   The catch that broke the button on iPhone: WebKit still *defines*
   webkitRequestFullscreen on every element there, so feature-detection alone
   says yes. The call then returns undefined (the prefixed API has no promise),
   throws nothing, and quietly fires webkitfullscreenerror — leaving us
   convinced we had gone fullscreen when nothing had happened at all. Hence the
   three checks below: the *Enabled flag up front, the error event, and a
   timeout that verifies the request actually took. */
const fsRoot = document.documentElement;
const fsRequest = fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen;
const fsRelease = document.exitFullscreen || document.webkitExitFullscreen;
const fsAllowed = !!fsRequest && (
  'fullscreenEnabled' in document       ? !!document.fullscreenEnabled :
  'webkitFullscreenEnabled' in document ? !!document.webkitFullscreenEnabled : false
);

const FS_ICON = {
  on:  'M9 4v5H4M20 9h-5V4M4 15h5v5M15 20v-5h5',
  off: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'
};

function nativeFs(){ return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function fauxFs(){ return document.body.classList.contains('faux-fs'); }
function isFs(){ return nativeFs() || fauxFs(); }

/* the engine caches its geometry, so every viewport change has to be followed
   by a re-fit once the browser has settled on the new size */
function afterFsChange(){
  syncFsBtn();
  requestAnimationFrame(() => { fitBook(); applyShift(); });
  setTimeout(() => { fitBook(); applyShift(); }, 350);
}

function syncFsBtn(){
  const btn = $('#fsBtn');
  if (!btn) return;
  const on = isFs();
  btn.querySelector('path').setAttribute('d', on ? FS_ICON.on : FS_ICON.off);
  btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
  btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
}

function setFauxFs(on){
  document.body.classList.toggle('faux-fs', on);
  afterFsChange();
}

function toggleFs(){
  if (fauxFs()) return setFauxFs(false);
  if (nativeFs()) {
    try { fsRelease ? fsRelease.call(document) : setFauxFs(false); } catch (e) { setFauxFs(false); }
    return;
  }
  if (!fsAllowed) return setFauxFs(true);
  try {
    const r = fsRequest.call(fsRoot);
    if (r && r.catch) r.catch(() => setFauxFs(true));
    /* prefixed call: no promise to reject, so confirm it by looking */
    else setTimeout(() => { if (!isFs()) setFauxFs(true); }, 300);
  } catch (e) { setFauxFs(true); }
}

let hintTimer;
function hint(show){
  clearTimeout(hintTimer);
  hintEl.classList.toggle('show', show);
  if (show) hintTimer = setTimeout(() => hintEl.classList.remove('show'), 4500);
}

function bindControls(){
  $('#prevBtn').onclick = () => nav('prev');
  $('#nextBtn').onclick = () => nav('next');
  $('#prevArrow').onclick = () => nav('prev');
  $('#nextArrow').onclick = () => nav('next');
  $('#enquireBtn').onclick = () => { goto(CONTACT_PAGE - 1); };
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') nav('prev');
    if (e.key === 'ArrowRight') nav('next');
    if (e.key === 'Escape') { closeLightbox(); toggleTray(false); if (fauxFs()) setFauxFs(false); }
  });
  $('#trayBtn').onclick = () => toggleTray();
  $('#trayClose').onclick = () => toggleTray(false);
  $('#fsBtn').onclick = toggleFs;
  $('#fsExit').onclick = toggleFs;
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
    document.addEventListener(ev, afterFsChange));
  ['fullscreenerror', 'webkitfullscreenerror'].forEach(ev =>
    document.addEventListener(ev, () => { if (!isFs()) setFauxFs(true); }));
  syncFsBtn();
  $('#lbClose').onclick = closeLightbox;
  lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
}


/* ============================================================
   BOOT
   ============================================================ */
async function boot(){
  try {
    await loadContent();
  } catch (err) {
    console.error(err);
    $('#loader .lSub').textContent = 'Could not load brochure content';
    $('#loader .lTitle').style.fontSize = '18px';
    $('#loader .lTitle').textContent = String(err.message || err);
    return;
  }
  // $('#pagesNote').textContent = PAGE_DATA.length + ' pages';

  /* second clause catches phones held in landscape, where the width is wide
     but the height is far too short for a readable two-page spread */
  mq = matchMedia('(max-width: ' + (MANIFEST.mobileBreakpoint || 767) + 'px), '
                + '(max-height: 520px) and (pointer: coarse)');
  mq.addEventListener ? mq.addEventListener('change', setMode) : mq.addListener(setMode);
  const onResize = () => requestAnimationFrame(() => { fitBook(); applyShift(); });
  window.addEventListener('resize', onResize);
  /* iOS reports the collapsing address bar here rather than on window */
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  bindControls();
  bindSwipe();
  buildThumbs();

  const m = location.hash.match(/page=(\d+)/);
  if (m) currentIndex = Math.min(Math.max(1, +m[1]), PAGE_DATA.length) - 1;
  setMode();

  $('#loader').classList.add('done');
  refresh();
  hint(true);
}

boot();
setTimeout(() => $('#loader').classList.add('done'), 6000);
