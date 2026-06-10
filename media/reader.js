(function () {
  const vscode = acquireVsCodeApi();
  const L = Object.assign({
    title:'Read Aloud', play:'Play', pause:'Pause', stop:'Stop', prev:'Previous sentence', next:'Next sentence',
    speed:'Speed', volume:'Volume', mute:'Mute', unmute:'Unmute', female:'Female', male:'Male', voice:'Voice',
    language:'Language', autoLangLabel:'Auto language (per paragraph)', multilingual:'multilingual',
    readingFont:'Reading font', comfort:'Comfort', compact:'Compact', cozy:'Cozy', wide:'Wide',
    theme:'Theme', themeAuto:'Follow VS Code', themeStudy:'Study', themeDaylight:'Daylight', themePaper:'Paper',
    ambient:'Ambient focus', badges:'Show language badges', readSection:'Read section', settings:'More settings',
    reading:'Reading', playback:'Playback', minShort:'~{0} min', edit:'Edit source',
    collapseAll:'Collapse all sections', expandAll:'Expand all sections', toggleSection:'Toggle section',
    backToReading:'Back to reading', startOver:'Start over', resumed:'Resumed where you left off',
    sleepTimer:'Sleep timer', off:'Off', untilSectionEnd:'Until end of section',
    codeBlock:'Code block', heading:'Heading', sentenceOf:'Sentence {0} of {1}',
    progress:'Progress', nothingToRead:'Nothing readable in this document.',
    openInEditor:'Alt+Click a sentence to open it in the editor',
    fontSerifSub:'warm serif', fontSansSub:'clean sans', fontA11ySub:'max legibility', fontMonoSub:'calm, technical',
  }, window.__l10n || {});

  const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  const audio = new Audio();
  audio.preservesPitch = true;

  const FONTS = [
    { key:'serif', name:'Literata', sub:L.fontSerifSub },
    { key:'sans',  name:'Inter', sub:L.fontSansSub },
    { key:'a11y',  name:'Atkinson Hyperlegible', sub:L.fontA11ySub },
    { key:'mono',  name:'IBM Plex Mono', sub:L.fontMonoSub },
  ];
  const THEMES = ['auto', 'study', 'daylight', 'paper'];
  const COMFORTS = ['compact', 'cozy', 'wide'];
  const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2];

  const saved = vscode.getState() || {};
  const state = {
    idx: 0, playing: false, rate: 1, volume: 1, lastVol: 1, muted: false,
    engine: 'edge', autoLang: true, following: true,
    font: 'serif', theme: 'auto', comfort: 'cozy', ambient: false, badges: false,
    settings: { codeBlocks: 'announce', tables: 'skip', announceHeadings: false, highlight: true },
    sleep: null, // null | {mode:'section', boundary} | {mode:'timer', until, id}
    ended: false,
  };
  applyPrefs(saved);
  function applyPrefs(p) {
    if (!p) return;
    if (FONTS.some((f) => f.key === p.font)) state.font = p.font;
    if (THEMES.includes(p.theme)) state.theme = p.theme;
    if (COMFORTS.includes(p.comfort)) state.comfort = p.comfort;
    if (typeof p.ambient === 'boolean') state.ambient = p.ambient;
    if (typeof p.badges === 'boolean') state.badges = p.badges;
  }
  function persistPrefs() {
    const p = { font: state.font, theme: state.theme, comfort: state.comfort, ambient: state.ambient, badges: state.badges };
    vscode.setState(p);
    post({ type: 'persistPrefs', prefs: p });
  }

  let vu = null;            // voice UI payload from host
  let SEG_SEQ = 0;
  let SEGMENTS = [];        // [{id, el, text, lang}]
  let SECTIONS = [];        // [{idx, title}] for chapter ticks
  let wordsPrefix = [];     // cumulative word counts for remaining-time ETA
  let synthVoice = null;    // browser engine
  const urlCache = new Map();
  const localeById = new Map(); // host-resolved locale per sentence (the language actually spoken)
  const requested = new Set();
  let waitingFor = -1;
  const PREFETCH = 2;
  let rovingEl = null;      // roving tabindex target among segments

  /* ---------------- icons ---------------- */
  const I = {
    prev:'<svg viewBox="0 0 24 24"><path d="M6 5v14h2V5H6zm3 7l9 7V5l-9 7z"/></svg>',
    play:'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause:'<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.3"/><rect x="14" y="5" width="4" height="14" rx="1.3"/></svg>',
    next:'<svg viewBox="0 0 24 24"><path d="M16 5v14h2V5h-2zM15 12L6 5v14l9-7z"/></svg>',
    moon:'<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36A5.5 5.5 0 0112.36 3.1 9.05 9.05 0 0012 3z"/></svg>',
    sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/></svg>',
    paper:'<svg viewBox="0 0 24 24"><path d="M6 3h9l5 5v13H6zM14 4v5h5"/></svg>',
    auto:'<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 100 18V3z"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    ambient:'<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0 8a3 3 0 110-6 3 3 0 010 6z" opacity=".55"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.6"/></svg>',
    gear:'<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.49 7.49 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.3 7.3 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 00-.6.22L2.71 8.84a.5.5 0 00.12.64l2.03 1.58a7.49 7.49 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.21.09.47 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>',
    down:'<svg viewBox="0 0 24 24"><path d="M12 16l-6-6h12z"/></svg>',
    edit:'<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    playSm:'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  };
  const SPK = '<svg viewBox="0 0 24 24"><path d="M4 9v6h3.6L13 20V4L7.6 9H4z"/><path d="M16 8.6a4 4 0 010 6.8M18.4 6a7 7 0 010 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  const SPK_MUTE = '<svg viewBox="0 0 24 24"><path d="M4 9v6h3.6L13 20V4L7.6 9H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const $ = (id) => document.getElementById(id);
  const post = (m) => vscode.postMessage(m);
  const fmt = (k, ...a) => a.reduce((s, v, i) => s.replace('{' + i + '}', String(v)), k);
  const fmtRate = (r) => (Math.round(r * 100) / 100).toFixed(2).replace(/(\.\d)0$/, '$1') + '×';

  /* ---------------- chrome ---------------- */
  function buildChrome() {
    $('app').innerHTML = `
      <header id="bar"><div class="bar-row">
        <div class="controls">
          <button class="btn" data-act="prev" title="${esc(L.prev)} (←)" aria-label="${esc(L.prev)}">${I.prev}</button>
          <button class="btn play" data-act="toggle" aria-pressed="false" aria-label="${esc(L.play)}" title="${esc(L.play)} (Space)">${I.play}</button>
          <button class="btn" data-act="next" title="${esc(L.next)} (→)" aria-label="${esc(L.next)}">${I.next}</button>
        </div>
        <div class="title-block">
          <div class="doc-title" id="doctitle">${esc(L.title)}</div>
          <div class="meta"><span id="pos"></span><span class="dot"></span><span id="eta"></span><span class="dot"></span><span class="chip" id="curlang">EN</span></div>
        </div>
        <button id="speed-btn" aria-haspopup="true" aria-expanded="false" title="${esc(L.speed)}" aria-label="${esc(L.speed)}">1.0×</button>
        <button class="btn" data-act="edit" title="${esc(L.edit)}" aria-label="${esc(L.edit)}">${I.edit}</button>
        <button class="btn" data-act="gear" title="${esc(L.settings)}" aria-haspopup="true" aria-label="${esc(L.settings)}" aria-expanded="false">${I.gear}</button>
        <div class="progress" id="progress" role="slider" tabindex="0" aria-label="${esc(L.progress)}" aria-valuemin="1" aria-valuemax="1" aria-valuenow="1"><i id="prog"></i></div>
      </div></header>
      <div id="reader-wrap">
        <article id="reader" data-font="serif" data-comfort="cozy">
          <div id="empty-note">${esc(L.nothingToRead)}</div>
          <div id="doc"></div>
        </article>
      </div>
      <div id="vignette" aria-hidden="true"></div>

      <div class="pop" id="pop" role="dialog" aria-label="${esc(L.settings)}">
        <div class="grp"><span class="lbl">${esc(L.voice)}</span>
          <div class="seg-ctl" id="gender" style="width:max-content">
            <button data-g="female" aria-pressed="true">${esc(L.female)}</button><button data-g="male" aria-pressed="false">${esc(L.male)}</button></div>
          <label class="toggle"><input type="checkbox" id="autolang" checked> ${esc(L.autoLangLabel)}</label>
          <select id="lang" aria-label="${esc(L.language)}"></select>
          <select id="voice" aria-label="${esc(L.voice)}"></select>
        </div>
        <div class="grp"><span class="lbl">${esc(L.playback)}</span>
          <div class="slider-row"><button class="ico-btn" id="mute" title="${esc(L.mute)}" aria-label="${esc(L.mute)}">${SPK}</button><input type="range" id="volume" min="0" max="1" step="0.05" value="1" aria-label="${esc(L.volume)}"><span class="val" id="volval">100%</span></div>
          <span class="lbl" style="text-transform:none;letter-spacing:0">${esc(L.sleepTimer)}</span>
          <div class="seg-row" id="sleep">
            <button data-sleep="off" class="sel-on">${esc(L.off)}</button><button data-sleep="section" title="${esc(L.untilSectionEnd)}">§</button><button data-sleep="15">15m</button><button data-sleep="30">30m</button><button data-sleep="60">60m</button></div>
        </div>
        <div class="grp"><span class="lbl">${esc(L.readingFont)}</span><div class="font-list" id="font-list"></div></div>
        <div class="grp"><span class="lbl">${esc(L.theme)}</span><div class="seg-ctl pop-theme" id="theme-pop" role="group" aria-label="${esc(L.theme)}">
          <button data-theme-set="auto" title="${esc(L.themeAuto)}" aria-label="${esc(L.themeAuto)}">${I.auto}</button><button data-theme-set="study" title="${esc(L.themeStudy)}" aria-label="${esc(L.themeStudy)}">${I.moon}</button><button data-theme-set="daylight" title="${esc(L.themeDaylight)}" aria-label="${esc(L.themeDaylight)}">${I.sun}</button><button data-theme-set="paper" title="${esc(L.themePaper)}" aria-label="${esc(L.themePaper)}">${I.paper}</button></div></div>
        <div class="grp"><span class="lbl">${esc(L.comfort)}</span><div class="seg-row" id="comfort">
          <button data-comfort="compact">${esc(L.compact)}</button><button data-comfort="cozy">${esc(L.cozy)}</button><button data-comfort="wide">${esc(L.wide)}</button></div></div>
        <div class="grp"><span class="lbl">${esc(L.reading)}</span>
          <label class="toggle"><input type="checkbox" id="ambient-t"> ${esc(L.ambient)}</label>
          <label class="toggle"><input type="checkbox" id="badges"> ${esc(L.badges)}</label>
          <div class="mini-row"><button class="btn" id="collapse-all" title="${esc(L.collapseAll)}" aria-label="${esc(L.collapseAll)}">−</button><button class="btn" id="expand-all" title="${esc(L.expandAll)}" aria-label="${esc(L.expandAll)}">+</button></div>
          <span class="hint">${esc(L.openInEditor)}</span>
        </div>
      </div>

      <div class="pop mini" id="spop" role="dialog" aria-label="${esc(L.speed)}">
        <div class="slider-row"><input type="range" id="rate" min="0.5" max="2.5" step="0.05" value="1" aria-label="${esc(L.speed)}"><span class="val" id="ratev">1.0×</span></div>
        <div class="preset-row" id="speed-presets">${SPEED_PRESETS.map((p) => `<button data-rate="${p}">${fmtRate(p)}</button>`).join('')}</div>
      </div>

      <div class="pill-float" id="follow-pill"><button class="primary" id="follow-btn">${I.down} ${esc(L.backToReading)}</button></div>
      <div class="pill-float" id="resume-pill"><span class="pill-label">${esc(L.resumed)}</span><span class="pill-sep"></span><button class="primary" id="startover-btn">${esc(L.startOver)}</button></div>
      <div id="ptip" aria-hidden="true"></div>`;
    bindChrome();
  }

  /* ---------------- language heuristic (cosmetic: badges + browser fallback) ---------------- */
  const STOP = {
    de:['der','die','das','und','ist','nicht','mit','auch','sich','ein','eine','den','dem','für','von','zu','ich','wird','dann'],
    fr:['le','la','les','et','est','pas','vous','une','des','du','je','que','qui','pour','par','ce'],
    es:['el','la','los','las','y','es','no','una','por','para','con','que','de','está','este'],
    en:['the','and','is','to','of','a','in','you','it','for','read','with','that','this','your'],
  };
  const LANG_LABEL = { de:'DE', fr:'FR', es:'ES', en:'EN', zh:'ZH', ja:'JA', ru:'RU', it:'IT', pt:'PT' };
  function detectLang(text) {
    const t = text.toLowerCase();
    if (/[぀-ヿ]/.test(t)) return 'ja';
    if (/[一-鿿]/.test(t)) return 'zh';
    if (/[Ѐ-ӿ]/.test(t)) return 'ru';
    const words = t.match(/[\p{L}]+/gu) || [];
    const sc = { de:0, fr:0, es:0, en:0 };
    for (const w of words) for (const k in STOP) if (STOP[k].includes(w)) sc[k]++;
    if (/[äöüß]/.test(t)) sc.de += 2; if (/[ñ¿¡]/.test(t)) sc.es += 2; if (/[àâçéèêëîïôûœ]/.test(t)) sc.fr += 1.5;
    let best='en', bv=0; for (const k in sc) if (sc[k] > bv) { bv = sc[k]; best = k; }
    return bv === 0 ? 'en' : best;
  }

  /* ---------------- sentence wrapping (shared ids) ----------------
     The Range-based splitter keeps nested inline markup (<strong>, <a>, <code>)
     intact even when a sentence boundary falls inside it, and container blocks
     (e.g. an <li> with a nested <ul>) get their own direct text segmented too. */
  function readableSelector() {
    let s = 'p, li, h1, h2, h3, h4, h5, h6, blockquote';
    if (state.settings.tables === 'read') s += ', td, th';
    return s;
  }
  const BLOCKISH = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre, ul, ol, table';
  const isBlockish = (n) => n.nodeType === 1 && (n.matches(BLOCKISH) || !!n.querySelector(BLOCKISH));

  function sentencesOf(text, base) {
    try { return [...new Intl.Segmenter(base, { granularity:'sentence' }).segment(text)]; }
    catch { return [{ segment:text, index:0 }]; }
  }

  function buildSegments(root) {
    SEG_SEQ = 0; SEGMENTS = [];
    const sel = readableSelector() + ', pre';
    root.querySelectorAll(sel).forEach((block) => {
      if (block.tagName === 'PRE') { handlePre(block); return; }
      if (block.closest('pre')) return;
      wrapBlock(block);
    });
    document.body.classList.toggle('no-segments', SEGMENTS.length === 0);
    wordsPrefix = new Array(SEGMENTS.length + 1).fill(0);
    for (let i = 0; i < SEGMENTS.length; i++) {
      wordsPrefix[i + 1] = wordsPrefix[i] + (SEGMENTS[i].text.match(/\S+/g) || []).length;
    }
    applyBadges();
  }

  function wrapBlock(block) {
    if (!block.textContent.trim()) return;
    const isHeading = /^H[1-6]$/.test(block.tagName);
    const prefix = isHeading && state.settings.announceHeadings ? L.heading + '. ' : '';
    // group direct children into runs of inline content, splitting at nested blocks
    let run = [];
    const runs = [];
    block.childNodes.forEach((n) => {
      if (isBlockish(n)) { if (run.length) runs.push(run); run = []; }
      else run.push(n);
    });
    if (run.length) runs.push(run);
    let first = true;
    for (const r of runs) {
      const did = segmentRun(block, r, first ? prefix : '');
      if (did) first = false;
    }
  }

  function segmentRun(block, nodes, ttsPrefix) {
    const text = nodes.map((n) => n.textContent).join('');
    if (!text.trim()) return false;
    // index every text node in the run by cumulative character offset
    const tnodes = [];
    let off = 0;
    for (const n of nodes) {
      if (n.nodeType === 3) { tnodes.push({ node:n, start:off, end:off + n.nodeValue.length }); off += n.nodeValue.length; }
      else if (n.nodeType === 1) {
        const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        let t;
        while ((t = w.nextNode())) { tnodes.push({ node:t, start:off, end:off + t.nodeValue.length }); off += t.nodeValue.length; }
      }
    }
    if (!tnodes.length) return false;
    const last = tnodes[tnodes.length - 1];
    // starts prefer the NEXT node at exact boundaries (avoids cloning an empty
    // shell of the previous inline element); ends prefer the previous one.
    const locateStart = (i) => {
      for (const t of tnodes) if (i < t.end) return [t.node, Math.max(0, i - t.start)];
      return [last.node, last.node.nodeValue.length];
    };
    const locateEnd = (i) => {
      for (const t of tnodes) if (i <= t.end) return [t.node, Math.max(0, i - t.start)];
      return [last.node, last.node.nodeValue.length];
    };
    const base = detectLang(text);
    const segs = sentencesOf(text, base);
    const spans = [];
    let pushed = false;
    for (const s of segs) {
      const range = document.createRange();
      const [sn, so] = locateStart(s.index);
      const [en, eo] = locateEnd(s.index + s.segment.length);
      range.setStart(sn, so); range.setEnd(en, eo);
      const span = document.createElement('span');
      span.className = 'seg'; span.dataset.seg = String(SEG_SEQ);
      span.appendChild(range.cloneContents());
      const tts = s.segment.replace(/\s+/g, ' ').trim();
      const lang = detectLang(s.segment) || base;
      span.dataset.lang = lang;
      if (tts) {
        span.tabIndex = -1;
        SEGMENTS.push({ id: SEG_SEQ, el: span, text: (!pushed && ttsPrefix ? ttsPrefix : '') + tts, lang });
        pushed = true;
      }
      SEG_SEQ++;
      spans.push(span);
    }
    const parent = nodes[0].parentNode;
    const anchor = nodes[0];
    for (const sp of spans) parent.insertBefore(sp, anchor);
    for (const n of nodes) n.remove();
    return pushed;
  }

  function handlePre(pre) {
    const mode = state.settings.codeBlocks;
    if (mode === 'skip') return;
    if (mode === 'announce') {
      const prev = SEGMENTS.length ? SEGMENTS[SEGMENTS.length - 1].lang : 'en';
      SEGMENTS.push({ id: SEG_SEQ++, el: pre, text: L.codeBlock, lang: prev });
      return;
    }
    // 'read': chunk the code into line groups so synthesis stays manageable
    const lines = pre.textContent.split('\n');
    let buf = '';
    const flush = () => {
      const t = buf.replace(/\s+/g, ' ').trim();
      if (t) SEGMENTS.push({ id: SEG_SEQ++, el: pre, text: t, lang: 'en' });
      buf = '';
    };
    for (const ln of lines) {
      buf += ln + '\n';
      if (buf.length > 240) flush();
    }
    flush();
  }

  function applyBadges() {
    let prev = null;
    for (const s of SEGMENTS) {
      if (s.el.classList && s.el.classList.contains('seg') && s.lang !== prev) {
        const b = document.createElement('span'); b.className = 'langbadge'; b.textContent = LANG_LABEL[s.lang] || s.lang;
        b.setAttribute('aria-hidden', 'true'); s.el.insertBefore(b, s.el.firstChild); prev = s.lang;
      }
    }
  }

  /* ---------------- headings: collapse + read-section + reading time ---------------- */
  function decorateHeadings() {
    document.querySelectorAll('#doc h1, #doc h2, #doc h3').forEach((h) => {
      const chev = document.createElement('button');
      chev.className = 'chev'; chev.type = 'button';
      chev.title = L.toggleSection; chev.setAttribute('aria-label', L.toggleSection); chev.setAttribute('aria-expanded', 'true');
      chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>';
      chev.onclick = (e) => { e.stopPropagation(); toggleCollapse(h); };
      h.insertBefore(chev, h.firstChild);
      const mins = sectionMinutes(h);
      if (mins) { const m = document.createElement('span'); m.className = 'sec-meta'; m.textContent = fmt(L.minShort, mins); h.appendChild(m); }
      const rh = document.createElement('button'); rh.className = 'read-here'; rh.type = 'button';
      rh.innerHTML = I.playSm + '<span class="rh-txt">' + esc(L.readSection) + '</span>';
      rh.setAttribute('aria-label', L.readSection);
      rh.onclick = (e) => { e.stopPropagation(); const i = firstSegIndexIn(h); if (i >= 0) playAt(i); };
      h.appendChild(rh);
    });
    // chapter ticks for the progress bar
    SECTIONS = [];
    let hs = [...document.querySelectorAll('#doc h1, #doc h2')];
    if (hs.length < 3) hs = [...document.querySelectorAll('#doc h1, #doc h2, #doc h3')];
    if (hs.length > 40) hs = hs.filter((h) => h.tagName !== 'H3');
    for (const h of hs) {
      const i = firstSegIndexIn(h);
      if (i > 0) SECTIONS.push({ idx: i, title: headingText(h) });
    }
    buildTicks();
  }
  function headingText(h) {
    const c = h.cloneNode(true);
    c.querySelectorAll('.chev, .read-here, .sec-meta, .langbadge').forEach((n) => n.remove());
    return c.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  function sectionEls(h) { const d = +h.tagName[1]; const els = []; let n = h.nextElementSibling; while (n && !(/^H[1-6]$/.test(n.tagName) && +n.tagName[1] <= d)) { els.push(n); n = n.nextElementSibling; } return els; }
  function toggleCollapse(h, force) {
    const c = force != null ? force : !(h.dataset.collapsed === '1');
    h.dataset.collapsed = c ? '1' : '0';
    sectionEls(h).forEach((e) => e.style.display = c ? 'none' : '');
    const ch = h.querySelector('.chev');
    if (ch) { ch.classList.toggle('rot', c); ch.setAttribute('aria-expanded', String(!c)); }
  }
  function ensureVisible(el) {
    if (el.offsetParent !== null) return;
    document.querySelectorAll('#doc h1,#doc h2,#doc h3').forEach((h) => {
      if (h.dataset.collapsed === '1' && sectionEls(h).some((s) => s.contains(el))) toggleCollapse(h, false);
    });
  }
  function firstSegIndexIn(h) { const els = sectionEls(h); els.unshift(h); for (let i = 0; i < SEGMENTS.length; i++) { if (els.some((e) => e.contains(SEGMENTS[i].el))) return i; } return -1; }
  function lastSegIndexIn(h) { const els = sectionEls(h); els.unshift(h); let last = -1; for (let i = 0; i < SEGMENTS.length; i++) { if (els.some((e) => e.contains(SEGMENTS[i].el))) last = i; } return last; }
  function sectionMinutes(h) { let w = 0; sectionEls(h).forEach((e) => { if (e.tagName !== 'PRE') w += (e.textContent.match(/\S+/g) || []).length; }); return w ? Math.max(1, Math.round(w / 200)) : 0; }

  /* ---------------- playback (host-synthesized audio, with browser fallback) ---------------- */
  function setPlaying(p) {
    if (state.playing === p) { setPlayIcon(); return; }
    state.playing = p;
    setPlayIcon();
    updateFollowPill();
    post({ type: 'playState', playing: p });
    if (!p) sendPosition(true);
  }
  function activate(i) {
    SEGMENTS.forEach((s) => s.el.classList.remove('speaking'));
    const seg = SEGMENTS[i]; if (!seg) return;
    ensureVisible(seg.el);
    if (state.settings.highlight) {
      seg.el.classList.add('speaking');
      if (state.following) scrollToSeg(seg);
    }
    if (rovingEl) rovingEl.tabIndex = -1;
    if (seg.el.classList.contains('seg')) { seg.el.tabIndex = 0; rovingEl = seg.el; }
    updateLangChip(i);
    updateProgress();
    const sr = $('sr'); if (sr) { sr.lang = localeById.get(i) || seg.lang; sr.textContent = seg.text; }
    sendPosition(false);
  }
  /** The chip shows what is actually SPOKEN: the host-resolved locale (eld) when known.
      The local heuristic is only trusted in browser-engine mode, where it picks the voice. */
  function updateLangChip(i) {
    const cl = $('curlang'); if (!cl) return;
    const loc = localeById.get(i);
    const lang = loc ? loc.split('-')[0] : (state.engine === 'browser' && SEGMENTS[i] ? SEGMENTS[i].lang : null);
    if (lang) cl.textContent = LANG_LABEL[lang] || lang.toUpperCase();
  }
  function scrollToSeg(seg) {
    seg.el.scrollIntoView({ behavior: RM.matches ? 'auto' : 'smooth', block: 'center' });
  }
  function stopAudioEl() { audio.pause(); audio.removeAttribute('src'); }
  function playAt(i) {
    if (!SEGMENTS.length) return;
    if (i < 0) i = 0;
    if (i >= SEGMENTS.length) { finishAll(); return; }
    state.idx = i; state.ended = false; state.following = true;
    setPlaying(true); activate(i); updateFollowPill();
    if (state.engine === 'browser') { speak(i); return; }
    const url = urlCache.get(i);
    if (url) { waitingFor = -1; startAudio(url); }
    else { stopAudioEl(); waitingFor = i; requestSynth(i); }
    for (let k = 1; k <= PREFETCH; k++) requestSynth(i + k);
  }
  let fadeMul = 1; // sleep-timer fade multiplier, survives sentence advances
  function startAudio(url) {
    audio.src = url; audio.playbackRate = state.rate; audio.volume = (state.muted ? 0 : state.volume) * fadeMul;
    try { audio.currentTime = 0; } catch (_) {}
    const p = audio.play(); if (p && p.catch) p.catch(() => setPlaying(false));
  }
  let loadGen = 0; // bumped per 'load' so late audio from the previous document is dropped
  function requestSynth(i) {
    if (i < 0 || i >= SEGMENTS.length) return;
    if (urlCache.has(i) || requested.has(i)) return;
    requested.add(i); post({ type:'synth', id:i, gen: loadGen, text: SEGMENTS[i].text });
  }
  function onAudio(m) {
    if (typeof m.gen === 'number' && m.gen !== loadGen) return;
    requested.delete(m.id);
    if (m.locale) localeById.set(m.id, m.locale);
    const blob = new Blob([m.bytes], { type: m.mime || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const old = urlCache.get(m.id); if (old) URL.revokeObjectURL(old);
    urlCache.set(m.id, url);
    if (state.idx === m.id) updateLangChip(m.id);
    if (state.playing && state.idx === m.id && waitingFor === m.id) { waitingFor = -1; startAudio(url); }
  }
  function onAudioError(m) {
    if (typeof m.gen === 'number' && m.gen !== loadGen) return;
    requested.delete(m.id);
    if (state.playing && state.idx === m.id) advance();
  }
  function doPlay() {
    if (!SEGMENTS.length) return;
    if (state.ended) { state.ended = false; playAt(0); return; }
    setPlaying(true);
    if (state.engine === 'edge') {
      if (audio.src && !audio.ended && audio.currentTime > 0) audio.play().catch(() => setPlaying(false));
      else playAt(state.idx);
    } else { if (speechSynthesis.paused && speechSynthesis.speaking) speechSynthesis.resume(); else speak(state.idx); }
  }
  function doPause() { setPlaying(false); if (state.engine === 'edge') audio.pause(); else speechSynthesis.pause(); }
  function togglePlay() { state.playing ? doPause() : doPlay(); }
  function doStop() {
    setPlaying(false);
    if (state.engine === 'edge') stopAudioEl(); else speechSynthesis.cancel();
    state.idx = 0; state.ended = false; waitingFor = -1;
    SEGMENTS.forEach((s) => s.el.classList.remove('speaking'));
    disarmSleep(); updateProgress();
  }
  function finishAll() {
    setPlaying(false);
    state.idx = 0; state.ended = true;
    SEGMENTS.forEach((s) => s.el.classList.remove('speaking'));
    disarmSleep();
    const pr = $('prog'); if (pr) pr.style.width = '100%';
  }
  /** Natural advance to the next sentence — honors the "until end of section" sleep mode. */
  function advance() {
    const n = state.idx + 1;
    if (state.sleep && state.sleep.mode === 'section' && n > state.sleep.boundary) {
      disarmSleep(); doPause(); stopAudioEl();
      state.idx = Math.min(n, SEGMENTS.length - 1);
      updateProgress();
      return;
    }
    playAt(n);
  }
  audio.addEventListener('ended', () => { if (state.playing) advance(); });
  audio.addEventListener('error', () => { if (state.playing && audio.src) advance(); });

  /* browser engine fallback */
  function initSynthVoices() {
    const load = () => {
      const vs = speechSynthesis.getVoices();
      const base = SEGMENTS[state.idx] ? SEGMENTS[state.idx].lang : 'en';
      synthVoice = vs.find((v) => v.lang.toLowerCase().startsWith(base)) || vs.find((v) => v.default) || vs[0] || null;
    };
    speechSynthesis.onvoiceschanged = load; load();
  }
  function speak(i) {
    if (i >= SEGMENTS.length) { finishAll(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(SEGMENTS[i].text);
    u.rate = Math.min(2.5, Math.max(0.5, state.rate)); u.volume = state.muted ? 0 : state.volume;
    const vs = speechSynthesis.getVoices(); const base = SEGMENTS[i].lang;
    const v = vs.find((x) => x.lang.toLowerCase().startsWith(base)) || synthVoice;
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = () => { if (state.playing && state.idx === i) advance(); };
    activate(i); speechSynthesis.speak(u);
  }
  function restartUtterance() {
    if (state.engine === 'browser' && state.playing && speechSynthesis.speaking) { speechSynthesis.cancel(); speak(state.idx); }
  }
  function clearAudioCache() { for (const u of urlCache.values()) URL.revokeObjectURL(u); urlCache.clear(); localeById.clear(); requested.clear(); waitingFor = -1; }

  /* ---------------- follow / detach (teleprompter) ---------------- */
  function detachFollow() { if (!state.following) return; state.following = false; updateFollowPill(); }
  function attachFollow() {
    state.following = true; updateFollowPill();
    const seg = SEGMENTS[state.idx]; if (seg && state.playing) scrollToSeg(seg);
  }
  function updateFollowPill() {
    const p = $('follow-pill'); if (!p) return;
    const show = !state.following && state.playing && state.settings.highlight;
    p.classList.toggle('show', show);
    if (show) hideResumePill();
  }
  let scrollRaf = 0;
  function onScroll() {
    const wrap = $('reader-wrap');
    $('bar').classList.toggle('scrolled', wrap.scrollTop > 4);
    if (state.following || !state.playing) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const seg = SEGMENTS[state.idx]; if (!seg) return;
      const r = seg.el.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      const cy = (r.top + r.bottom) / 2;
      if (cy > w.top + w.height * 0.32 && cy < w.top + w.height * 0.68) attachFollow();
    });
  }

  /* ---------------- resume pill ---------------- */
  let resumeTimer = 0;
  function showResumePill() {
    const p = $('resume-pill'); if (!p) return;
    p.classList.add('show');
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(hideResumePill, 12000);
  }
  function hideResumePill() {
    const p = $('resume-pill'); if (p && p.classList.contains('show')) p.classList.remove('show');
    clearTimeout(resumeTimer);
  }

  /* ---------------- sleep timer ---------------- */
  function disarmSleep() {
    if (state.sleep && state.sleep.id) clearTimeout(state.sleep.id);
    state.sleep = null;
    updateSleepUI('off');
  }
  function armSleep(key) {
    disarmSleep();
    if (key === 'off') return;
    if (key === 'section') {
      const seg = SEGMENTS[state.idx];
      let boundary = SEGMENTS.length - 1;
      if (seg) {
        // nearest enclosing heading = the LAST one (in document order) whose section contains the sentence
        const hs = [...document.querySelectorAll('#doc h1, #doc h2, #doc h3')];
        for (const h of hs) {
          const els = sectionEls(h); els.unshift(h);
          if (els.some((e) => e.contains(seg.el))) boundary = lastSegIndexIn(h);
        }
      }
      state.sleep = { mode: 'section', boundary };
    } else {
      const mins = parseInt(key, 10);
      const id = setTimeout(() => fadeOutAndPause(), mins * 60000);
      state.sleep = { mode: 'timer', id };
    }
    updateSleepUI(key);
  }
  function fadeOutAndPause() {
    const steps = 16; let n = 0;
    const iv = setInterval(() => {
      n++;
      fadeMul = Math.max(0, 1 - n / steps);
      audio.volume = (state.muted ? 0 : state.volume) * fadeMul;
      if (n >= steps) {
        clearInterval(iv);
        doPause();
        fadeMul = 1;
        audio.volume = state.muted ? 0 : state.volume;
        disarmSleep();
      }
    }, 250);
  }
  function updateSleepUI(key) {
    document.querySelectorAll('#sleep button').forEach((b) => b.classList.toggle('sel-on', b.dataset.sleep === key));
  }

  /* ---------------- progress / position / icons ---------------- */
  function buildTicks() {
    const bar = $('progress'); if (!bar) return;
    bar.querySelectorAll('.tick').forEach((t) => t.remove());
    if (SEGMENTS.length < 2) return;
    for (const s of SECTIONS) {
      const t = document.createElement('span'); t.className = 'tick';
      t.style.left = (s.idx / (SEGMENTS.length - 1)) * 100 + '%';
      bar.appendChild(t);
    }
  }
  function updateProgress() {
    const n = SEGMENTS.length;
    const pct = n > 1 ? (state.idx / (n - 1)) * 100 : 0;
    const pr = $('prog'); if (pr) pr.style.width = (n ? pct : 0) + '%';
    const ps = $('pos'); if (ps) ps.textContent = n ? (state.idx + 1) + ' / ' + n : '';
    const bar = $('progress');
    if (bar) {
      bar.setAttribute('aria-valuemax', String(Math.max(1, n)));
      bar.setAttribute('aria-valuenow', String(Math.min(n, state.idx + 1)));
      bar.setAttribute('aria-valuetext', fmt(L.sentenceOf, state.idx + 1, n));
    }
    updateEta();
  }
  function updateEta() {
    const e = $('eta'); if (!e) return;
    if (!SEGMENTS.length) { e.textContent = ''; return; }
    const remaining = wordsPrefix[SEGMENTS.length] - wordsPrefix[state.idx];
    const mins = Math.max(1, Math.round(remaining / (200 * state.rate)));
    e.textContent = fmt(L.minShort, mins);
  }
  let posTimer = 0, lastSentIdx = -1;
  function sendPosition(immediate) {
    if (!SEGMENTS.length) return;
    const fire = () => {
      posTimer = 0;
      if (state.idx === lastSentIdx) return;
      lastSentIdx = state.idx;
      const seg = SEGMENTS[state.idx];
      post({ type: 'position', docKey: state.docKey, idx: state.idx, total: SEGMENTS.length, text: seg ? seg.text.slice(0, 80) : '' });
    };
    if (immediate) { clearTimeout(posTimer); fire(); }
    else if (!posTimer) posTimer = setTimeout(fire, 1500);
  }
  function setPlayIcon() {
    const b = document.querySelector('.btn.play'); if (!b) return;
    b.innerHTML = state.playing ? I.pause : I.play;
    b.setAttribute('aria-pressed', String(state.playing));
    b.setAttribute('aria-label', state.playing ? L.pause : L.play);
    b.title = (state.playing ? L.pause : L.play) + ' (Space)';
  }

  /* ---------------- theme / font / comfort / ambient ---------------- */
  function applyTheme() {
    if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = state.theme;
    document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === state.theme)));
  }
  function setTheme(t) { state.theme = t; applyTheme(); persistPrefs(); }
  function applyFont() {
    $('reader').dataset.font = state.font;
    document.querySelectorAll('.font-opt').forEach((o) => o.classList.toggle('sel', o.dataset.font === state.font));
  }
  function setFont(key) { state.font = key; applyFont(); persistPrefs(); }
  function cycleFont() { const i = FONTS.findIndex((f) => f.key === state.font); setFont(FONTS[(i + 1) % FONTS.length].key); }
  function applyComfort() { $('reader').dataset.comfort = state.comfort; document.querySelectorAll('#comfort button').forEach((b) => b.classList.toggle('sel-on', b.dataset.comfort === state.comfort)); }
  function setComfort(c) { state.comfort = c; applyComfort(); persistPrefs(); }
  function applyAmbient() {
    document.body.classList.toggle('ambient', state.ambient);
    document.body.classList.toggle('focusing', state.ambient);
    const t = $('ambient-t'); if (t) t.checked = state.ambient;
  }
  function applyBadgesPref() {
    document.body.classList.toggle('hide-badges', !state.badges);
    const t = $('badges'); if (t) t.checked = state.badges;
  }

  /* ---------------- voice / language pickers ---------------- */
  function buildFontList() {
    const wrap = $('font-list'); if (!wrap) return;
    wrap.innerHTML = FONTS.map((f) => `<button type="button" class="font-opt" data-font="${f.key}"><span class="pv" style="font-family:var(--f-${f.key})">Ag</span><span><span class="nm">${esc(f.name)}</span><br><span class="sub">${esc(f.sub)}</span></span></button>`).join('');
    wrap.querySelectorAll('.font-opt').forEach((o) => o.onclick = () => setFont(o.dataset.font));
  }
  function renderPickers() {
    if (!vu) return;
    document.querySelectorAll('#gender button').forEach((b) => { const on = b.dataset.g === vu.gender; b.classList.toggle('sel-on', on); b.setAttribute('aria-pressed', String(on)); const has = vu.voicePair && vu.voicePair[b.dataset.g]; b.disabled = !has; });
    const al = $('autolang'); if (al) al.checked = !!vu.autoLang;
    const lang = $('lang');
    if (lang) {
      lang.innerHTML = (vu.locales || []).map((l) => `<option value="${esc(l.locale)}" ${l.locale === vu.locale ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
      lang.disabled = !!vu.autoLang;
    }
    const voice = $('voice');
    if (voice) {
      const groups = { female: [], male: [] };
      for (const v of (vu.allVoices || [])) (groups[v.gender] || (groups[v.gender] = [])).push(v);
      let html = '';
      for (const g of ['female', 'male']) {
        if (!groups[g] || !groups[g].length) continue;
        html += `<optgroup label="${g === 'female' ? esc(L.female) : esc(L.male)}">`;
        for (const v of groups[g]) html += `<option value="${esc(v.shortName)}">${esc(v.name)}${v.multilingual ? ' · ' + esc(L.multilingual) : ''}</option>`;
        html += '</optgroup>';
      }
      voice.innerHTML = html; voice.value = vu.currentVoice || ''; voice.disabled = !!vu.autoLang;
    }
  }

  /* ---------------- volume / speed ---------------- */
  function updateMuteUI() {
    const b = $('mute'); const m = state.muted || state.volume === 0;
    if (b) { b.classList.toggle('muted', m); b.innerHTML = m ? SPK_MUTE : SPK; b.setAttribute('aria-label', m ? L.unmute : L.mute); b.title = m ? L.unmute : L.mute; }
    const vv = $('volval'); if (vv) vv.textContent = Math.round((m ? 0 : state.volume) * 100) + '%';
    const v = $('volume'); if (v) v.setAttribute('aria-valuetext', Math.round(state.volume * 100) + '%');
  }
  function applyVolume() { audio.volume = state.muted ? 0 : state.volume; const v = $('volume'); if (v) v.value = String(state.volume); updateMuteUI(); }
  function applyRate() {
    audio.playbackRate = state.rate;
    const r = $('rate'); if (r) { r.value = String(state.rate); r.setAttribute('aria-valuetext', fmtRate(state.rate)); }
    const rv = $('ratev'); if (rv) rv.textContent = fmtRate(state.rate);
    const sb = $('speed-btn'); if (sb) { sb.textContent = fmtRate(state.rate); sb.classList.toggle('on', Math.abs(state.rate - 1) > 0.001); }
    document.querySelectorAll('#speed-presets button').forEach((b) => b.classList.toggle('sel-on', Math.abs(parseFloat(b.dataset.rate) - state.rate) < 0.001));
    updateEta();
  }
  let speedPersist = 0;
  function setRate(r, persist) {
    state.rate = Math.min(2.5, Math.max(0.5, Math.round(r * 100) / 100));
    applyRate();
    if (persist) {
      clearTimeout(speedPersist);
      speedPersist = setTimeout(() => { restartUtterance(); post({ type:'persistSpeed', value: state.rate }); }, 400);
    } else restartUtterance();
  }

  /* ---------------- popovers (anchored) ---------------- */
  let openPopInfo = null; // { pop, btn }
  function positionPop(pop, btn) {
    const r = btn.getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 8) + 'px';
    pop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    pop.style.maxHeight = Math.max(120, window.innerHeight - r.bottom - 20) + 'px';
  }
  function openPop(pop, btn) {
    closePops();
    pop.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    positionPop(pop, btn);
    openPopInfo = { pop, btn };
    const f = pop.querySelector('button:not([disabled]), input, select');
    if (f) f.focus({ preventScroll: true });
  }
  function closePops(refocus) {
    if (!openPopInfo) return;
    openPopInfo.pop.classList.remove('open');
    openPopInfo.btn.setAttribute('aria-expanded', 'false');
    if (refocus) openPopInfo.btn.focus({ preventScroll: true });
    openPopInfo = null;
  }
  function togglePop(pop, btn) {
    if (openPopInfo && openPopInfo.pop === pop) closePops();
    else openPop(pop, btn);
  }
  window.addEventListener('resize', () => { if (openPopInfo) positionPop(openPopInfo.pop, openPopInfo.btn); });

  /* ---------------- seek (progress strip) ---------------- */
  function segAtX(clientX) {
    const bar = $('progress');
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(ratio * (SEGMENTS.length - 1));
  }
  function seekTo(i) {
    if (!SEGMENTS.length) return;
    i = Math.min(SEGMENTS.length - 1, Math.max(0, i));
    state.following = true;
    hideResumePill();
    if (state.playing) playAt(i);
    else { stopAudioEl(); waitingFor = -1; state.idx = i; state.ended = false; activate(i); }
  }
  function sectionTitleFor(i) {
    let t = '';
    for (const s of SECTIONS) { if (s.idx <= i) t = s.title; else break; }
    return t;
  }
  function bindProgress() {
    const bar = $('progress');
    const tip = $('ptip');
    let scrubbing = false;
    const showTip = (x) => {
      if (!SEGMENTS.length) return;
      const i = segAtX(x);
      const sec = sectionTitleFor(i);
      tip.textContent = (sec ? sec + ' · ' : '') + fmt(L.sentenceOf, i + 1, SEGMENTS.length);
      const r = bar.getBoundingClientRect();
      tip.style.left = Math.min(window.innerWidth - 20, Math.max(20, x)) + 'px';
      tip.style.top = r.top + 'px';
      tip.classList.add('show');
    };
    bar.addEventListener('pointermove', (e) => { if (!scrubbing) showTip(e.clientX); });
    bar.addEventListener('pointerleave', () => { if (!scrubbing) tip.classList.remove('show'); });
    bar.addEventListener('pointerdown', (e) => {
      if (!SEGMENTS.length) return;
      scrubbing = true; bar.classList.add('scrubbing');
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const i = segAtX(ev.clientX);
        const pr = $('prog'); if (pr) pr.style.width = (SEGMENTS.length > 1 ? (i / (SEGMENTS.length - 1)) * 100 : 0) + '%';
        showTip(ev.clientX);
      };
      move(e);
      const finish = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', cancel);
        scrubbing = false; bar.classList.remove('scrubbing'); tip.classList.remove('show');
      };
      const up = (ev) => { finish(); seekTo(segAtX(ev.clientX)); };
      const cancel = () => { finish(); updateProgress(); }; // pointercancel carries (0,0) — don't seek
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', cancel);
    });
    bar.addEventListener('keydown', (e) => {
      if (!SEGMENTS.length) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); seekTo(state.idx - 1); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); seekTo(state.idx + 1); }
      else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
      else if (e.key === 'End') { e.preventDefault(); seekTo(SEGMENTS.length - 1); }
    });
  }

  /* ---------------- bindings ---------------- */
  function bindChrome() {
    document.querySelectorAll('[data-act]').forEach((el) => el.onclick = () => {
      const a = el.dataset.act;
      if (a === 'toggle') togglePlay();
      else if (a === 'prev') playAt(state.idx - 1);
      else if (a === 'next') playAt(state.idx + 1);
      else if (a === 'gear') togglePop($('pop'), el);
      else if (a === 'edit') {
        const seg = SEGMENTS[state.idx];
        const lineEl = seg && seg.el.closest ? seg.el.closest('[data-line]') : null;
        post({ type:'editSource', line: lineEl ? parseInt(lineEl.dataset.line, 10) : 1 });
      }
    });
    $('speed-btn').onclick = () => togglePop($('spop'), $('speed-btn'));
    $('speed-btn').addEventListener('wheel', (e) => { e.preventDefault(); setRate(state.rate + (e.deltaY < 0 ? 0.05 : -0.05), true); }, { passive: false });
    document.querySelectorAll('[data-theme-set]').forEach((b) => b.onclick = () => setTheme(b.dataset.themeSet));
    document.querySelectorAll('#comfort button').forEach((b) => b.onclick = () => setComfort(b.dataset.comfort));
    document.querySelectorAll('#sleep button').forEach((b) => b.onclick = () => armSleep(b.dataset.sleep));
    $('gender').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) post({ type:'setGender', gender: b.dataset.g }); });
    $('autolang').onchange = (e) => post({ type:'setAutoLang', value: e.target.checked });
    $('lang').onchange = (e) => post({ type:'setLocale', locale: e.target.value });
    $('voice').onchange = (e) => post({ type:'setVoice', shortName: e.target.value });
    $('badges').onchange = (e) => { state.badges = e.target.checked; applyBadgesPref(); persistPrefs(); };
    $('ambient-t').onchange = (e) => { state.ambient = e.target.checked; applyAmbient(); persistPrefs(); };
    $('collapse-all').onclick = () => document.querySelectorAll('#doc h2, #doc h3').forEach((h) => toggleCollapse(h, true));
    $('expand-all').onclick = () => document.querySelectorAll('#doc h1,#doc h2,#doc h3').forEach((h) => toggleCollapse(h, false));
    $('follow-btn').onclick = () => attachFollow();
    $('startover-btn').onclick = () => { hideResumePill(); playAt(0); };

    const rate = $('rate');
    rate.oninput = (e) => setRate(parseFloat(e.target.value), true);
    document.querySelectorAll('#speed-presets button').forEach((b) => b.onclick = () => setRate(parseFloat(b.dataset.rate), true));

    const vol = $('volume');
    vol.oninput = (e) => {
      const v = parseFloat(e.target.value);
      state.volume = v;
      if (v > 0) { state.lastVol = v; state.muted = false; }
      audio.volume = state.muted ? 0 : state.volume;
      updateMuteUI();
    };
    vol.onchange = () => { restartUtterance(); post({ type:'persistVolume', value: state.volume }); };
    $('mute').onclick = () => {
      if (state.muted || state.volume === 0) {
        state.muted = false;
        if (state.volume === 0) state.volume = state.lastVol > 0 ? state.lastVol : 1;
        post({ type:'persistVolume', value: state.volume });
      } else {
        state.lastVol = state.volume; state.muted = true;
      }
      applyVolume(); restartUtterance();
    };

    const wrap = $('reader-wrap');
    wrap.addEventListener('scroll', onScroll, { passive: true });
    wrap.addEventListener('wheel', (e) => {
      if (!state.playing) return;
      const canScroll = (e.deltaY < 0 && wrap.scrollTop > 0) || (e.deltaY > 0 && wrap.scrollTop < wrap.scrollHeight - wrap.clientHeight - 1);
      if (canScroll) detachFollow();
    }, { passive: true });
    wrap.addEventListener('touchmove', () => { if (state.playing) detachFollow(); }, { passive: true });
    wrap.addEventListener('pointerdown', (e) => {
      // drags on the scrollbar gutter detach; sentence clicks re-attach via playAt
      if (state.playing && e.target === wrap && e.offsetX >= wrap.clientWidth) detachFollow();
    });
    bindProgress();

    document.addEventListener('keydown', (e) => {
      // 1) Escape: close popover, else stop playback
      if (e.key === 'Escape') {
        if (openPopInfo) { e.preventDefault(); closePops(true); }
        else if (state.playing || audio.src) { e.preventDefault(); doStop(); }
        return;
      }
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // 2) Enter/Space on a focused sentence reads from there
      if (t && t.classList && t.classList.contains('seg') && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        const id = SEGMENTS.findIndex((s) => s.el === t);
        if (id >= 0) playAt(id);
        return;
      }
      // 3) let buttons/links handle their own keys
      if (t && t.closest && t.closest('button, a, [role="button"], [role="slider"]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); playAt(state.idx - 1); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); playAt(state.idx + 1); }
      else if (e.key === '+' || e.key === '=') setRate(state.rate + 0.1, true);
      else if (e.key === '-') setRate(state.rate - 0.1, true);
      else if (e.key.toLowerCase() === 'm') $('mute').click();
      else if (e.key.toLowerCase() === 'f') cycleFont();
      else if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') { if (state.playing) detachFollow(); }
    });
    document.addEventListener('click', (e) => {
      if (openPopInfo && !e.target.closest('.pop') && e.target !== openPopInfo.btn && !openPopInfo.btn.contains(e.target)) closePops();
    });
  }

  /* ---------------- messaging ---------------- */
  window.addEventListener('message', (e) => {
    const m = e.data; if (!m) return;
    switch (m.type) {
      case 'load': onLoad(m); break;
      case 'update': onUpdate(m); break;
      case 'audio': onAudio(m); break;
      case 'audioError': onAudioError(m); break;
      case 'engineFallback': switchToBrowser(); break;
      case 'voiceUi': onVoiceUi(m); break;
      case 'control': if (m.action === 'playpause') togglePlay(); else if (m.action === 'stop') doStop(); break;
    }
  });

  function onLoad(m) {
    // fully stop whatever the previous document was doing
    stopAudioEl();
    try { speechSynthesis.cancel(); } catch (_) {}
    setPlaying(false);
    disarmSleep(); hideResumePill();
    clearAudioCache();
    lastSentIdx = -1; loadGen++;

    state.engine = m.engine || 'edge';
    state.rate = typeof m.rate === 'number' ? m.rate : 1;
    state.volume = typeof m.volume === 'number' ? m.volume : 1;
    state.lastVol = state.volume || 1; state.muted = false;
    state.settings = Object.assign({ codeBlocks:'announce', tables:'skip', announceHeadings:false, highlight:true }, m.settings || {});
    document.body.classList.toggle('no-highlight', !state.settings.highlight);
    applyPrefs(m.prefs);
    vu = { autoLang:m.autoLang, locale:m.locale, localeName:m.localeName, locales:m.locales, voicePair:m.voicePair, allVoices:m.allVoices, currentVoice:m.currentVoice, gender:m.gender };
    state.autoLang = !!m.autoLang;
    state.idx = 0; state.ended = false; state.following = true;

    $('doctitle').textContent = m.title || L.title;
    $('doctitle').title = m.title || '';
    state.docKey = m.docKey || '';
    const base = $('doc-base') || (() => { const b = document.createElement('base'); b.id = 'doc-base'; document.head.appendChild(b); return b; })();
    base.href = m.baseHref || '';
    $('doc').innerHTML = m.html || '';
    buildSegments($('doc'));
    decorateHeadings();
    document.querySelectorAll('[data-act="prev"], [data-act="toggle"], [data-act="next"]').forEach((b) => b.disabled = !SEGMENTS.length);
    $('speed-btn').disabled = !SEGMENTS.length;

    buildFontList(); applyFont(); applyComfort(); applyTheme(); applyAmbient(); applyBadgesPref();
    renderPickers();
    // seed the language chip with the host-detected document language (eld)
    const cl = $('curlang');
    if (cl && m.locale) { const b = String(m.locale).split('-')[0]; cl.textContent = LANG_LABEL[b] || b.toUpperCase(); }
    applyRate(); applyVolume();
    updateProgress(); setPlayIcon(); updateFollowPill();

    if (state.engine === 'browser') initSynthVoices();
    if (!SEGMENTS.length) return;

    // starting point: explicit cursor anchor > stored resume position > top
    let start = 0;
    let resumed = false;
    if (m.anchorText) {
      const a = anchorIndex(m.anchorText);
      if (a > 0) start = a;
    } else if (m.resume && typeof m.resume.idx === 'number' && m.resume.idx >= 3) {
      const r = resumeIndex(m.resume);
      if (r > 0) { start = r; resumed = true; }
    }
    if (m.autoplay === false) {
      state.idx = start; activate(start);
      if (resumed) showResumePill();
      requestSynth(start); for (let k = 1; k <= PREFETCH; k++) requestSynth(start + k);
    } else {
      playAt(start);
      if (resumed) showResumePill();
    }
  }

  /** Live re-render while the source is edited: swap the prose, keep the place. */
  function onUpdate(m) {
    if (typeof m.html !== 'string') return;
    const curText = SEGMENTS[state.idx] ? SEGMENTS[state.idx].text : '';
    const oldIdx = state.idx;
    const wrap = $('reader-wrap');
    const scrollTop = wrap.scrollTop;

    loadGen++;
    clearAudioCache();
    lastSentIdx = -1;
    $('doc').innerHTML = m.html;
    buildSegments($('doc'));
    decorateHeadings();
    document.querySelectorAll('[data-act="prev"], [data-act="toggle"], [data-act="next"]').forEach((b) => b.disabled = !SEGMENTS.length);
    $('speed-btn').disabled = !SEGMENTS.length;

    if (!SEGMENTS.length) { doStop(); return; }
    // relocate the sentence we were on (exact text near the old index, else clamp)
    let idx = Math.max(0, Math.min(oldIdx, SEGMENTS.length - 1));
    if (curText) {
      const probe = (i) => SEGMENTS[i] && SEGMENTS[i].text === curText;
      if (!probe(idx)) {
        for (let d = 1; d <= 60; d++) {
          if (probe(oldIdx - d)) { idx = oldIdx - d; break; }
          if (probe(oldIdx + d)) { idx = oldIdx + d; break; }
        }
      }
    }
    state.idx = idx; state.ended = false;
    if (state.sleep && state.sleep.mode === 'section') armSleep('section'); // boundaries shifted
    if (state.playing) {
      activate(idx);
      if (state.engine === 'browser') {
        if (idx !== oldIdx) speak(idx); // utterance onend was bound to the old index
      } else {
        // if nothing is audibly playing we were waiting on synth — wait for the new one
        if (!audio.src || audio.paused || audio.ended) waitingFor = idx;
        requestSynth(idx); for (let k = 1; k <= PREFETCH; k++) requestSynth(idx + k);
      }
    } else {
      const f = state.following;
      state.following = false; // re-render while paused must not yank the viewport
      activate(idx);
      state.following = f;
      wrap.scrollTop = scrollTop;
    }
    updateProgress();
  }

  function anchorIndex(anchorText) {
    const words = (anchorText.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).slice(0, 6);
    for (let take = words.length; take >= 3; take--) {
      const needle = words.slice(0, take).join(' ');
      for (let i = 0; i < SEGMENTS.length; i++) {
        const hay = (SEGMENTS[i].text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).join(' ');
        if (hay.includes(needle)) return i;
      }
    }
    return -1;
  }
  function resumeIndex(r) {
    const probe = (i) => SEGMENTS[i] && SEGMENTS[i].text.slice(0, 80) === r.text;
    if (probe(r.idx)) return r.idx;
    for (let d = 1; d <= 30; d++) {
      if (probe(r.idx - d)) return r.idx - d;
      if (probe(r.idx + d)) return r.idx + d;
    }
    if (r.total && Math.abs(r.total - SEGMENTS.length) <= Math.max(4, r.total * 0.05) && r.idx < SEGMENTS.length) return r.idx;
    return -1;
  }

  function onVoiceUi(m) {
    clearAudioCache();
    vu = { autoLang:m.autoLang, locale:m.locale, localeName:m.localeName, locales:m.locales, voicePair:m.voicePair, allVoices:m.allVoices, currentVoice:m.currentVoice, gender:m.gender };
    state.autoLang = !!m.autoLang;
    renderPickers();
    if (state.engine === 'browser') initSynthVoices();
    if (state.playing) playAt(state.idx);
    else if (state.engine === 'edge') stopAudioEl();
    else speechSynthesis.cancel();
  }
  function switchToBrowser() { state.engine = 'browser'; audio.pause(); initSynthVoices(); if (state.playing) speak(state.idx); }

  /* ---------------- boot ---------------- */
  buildChrome();
  applyTheme(); applyFont(); applyComfort(); applyAmbient(); applyBadgesPref(); applyRate(); applyVolume();
  // sentence click → read from there; Alt+Click → open the source line in the editor
  document.addEventListener('click', (e) => {
    const seg = e.target.closest && e.target.closest('.seg'); if (!seg) return;
    if (e.altKey) {
      const lineEl = seg.closest('[data-line]') || (e.target.closest && e.target.closest('[data-line]'));
      if (lineEl) { post({ type:'openSource', line: parseInt(lineEl.dataset.line, 10) }); return; }
    }
    const id = SEGMENTS.findIndex((s) => s.el === seg);
    if (id >= 0) playAt(id);
  });
  post({ type: 'ready' });
})();
