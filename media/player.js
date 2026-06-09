(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // Localized UI strings injected by the host (vscode.l10n is unavailable in the
  // webview). English defaults keep the player working if the blob is ever missing.
  const L = Object.assign(
    {
      play: 'Play', pause: 'Pause', mute: 'Mute', unmute: 'Unmute',
      female: 'Female', male: 'Male', multilingual: 'multilingual', sections: 'Sections',
      sentencesOne: '{0} sentence', sentencesOther: '{0} sentences',
      estSeconds: '~{0} s', estMinutes: '~{0} min', autoPrefix: 'Auto: {0}',
    },
    window.__l10n || {}
  );

  const audio = new Audio();
  audio.preservesPitch = true;

  let job = null;
  let engine = 'edge';
  let rate = 1;
  let volume = 1;
  let lastVolume = 1; // restored when unmuting
  let cursor = 0;
  let playing = false;
  let waitingFor = -1;
  let totalChars = 0;
  const PREFETCH = 2;

  const urlCache = new Map(); // index -> objectURL
  const requested = new Set(); // indices we've asked the host for
  let synthVoice = null; // browser engine

  // transcript: built once, then the highlight glides + the list scrolls
  let lineEls = null; // array of <p class="line">
  let linesEl = null; // the scrolling inner container
  let hlEl = null; // the gliding wash

  // language combobox (custom dropdown with flags)
  let flagsBase = ''; // webview URI base for media/flags
  let langOpen = false, langActiveIdx = -1, typeBuf = '', typeAt = 0;

  // ---------- messaging ----------
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case 'load': onLoad(m); break;
      case 'audio': onAudio(m); break;
      case 'audioError': onAudioError(m); break;
      case 'engineFallback': switchToBrowser(); break;
      case 'voiceUi': onVoiceUi(m); break;
      case 'control': onControl(m.action); break;
    }
  });
  const post = (msg) => vscode.postMessage(msg);

  // ---------- load ----------
  function onLoad(m) {
    job = m.job;
    engine = m.engine || 'edge';
    rate = m.rate || 1;
    cursor = m.startIndex || 0;
    flagsBase = m.flagsBase || '';
    clearAudioCache();

    totalChars = job.chunks.reduce((s, c) => s + c.text.length, 0);
    $('title').textContent = job.title;
    renderHeader();
    applyRate(rate, false);
    volume = typeof m.volume === 'number' ? m.volume : 1;
    applyVolume(volume, false);

    renderGender();
    renderLangSelect();
    renderVoiceSelect();
    applyAutoUi();
    renderOutline();
    renderAllLines();

    if (engine === 'browser') initSynthVoices();
    setPlayIcon();
    prewarm(); // fetch the first chunk(s) so Play starts instantly
  }
  // No "click to start" overlay: the in-player Play button click is itself the
  // user gesture the browser requires to begin audio playback.

  // ---------- transport ----------
  function doPlay() {
    if (!job) return;
    playing = true;
    setPlayIcon();
    if (engine === 'edge') {
      if (audio.src && !audio.ended && audio.currentTime > 0) {
        audio.play().catch(onPlayBlocked);
      } else {
        playAt(cursor);
      }
    } else {
      if (window.speechSynthesis.paused && window.speechSynthesis.speaking) {
        window.speechSynthesis.resume();
      } else {
        speak(cursor);
      }
    }
  }

  function doPause() {
    playing = false;
    setPlayIcon();
    if (engine === 'edge') audio.pause();
    else window.speechSynthesis.pause();
  }

  function togglePlay() {
    if (playing) doPause();
    else doPlay();
  }

  function doStop() {
    playing = false;
    setPlayIcon();
    if (engine === 'edge') { audio.pause(); audio.removeAttribute('src'); }
    else window.speechSynthesis.cancel();
    cursor = 0;
    updateTranscript();
    highlightOutline();
    post({ type: 'ended' });
  }

  function playAt(index) {
    if (!job) return;
    if (index < 0) index = 0;
    if (index >= job.chunks.length) { finishAll(); return; }
    cursor = index;
    updateTranscript();
    highlightOutline();
    post({ type: 'nowPlaying', index });

    if (engine === 'browser') { speak(index); return; }

    const url = urlCache.get(index);
    if (url) {
      startAudio(url);
    } else {
      waitingFor = index;
      requestChunk(index);
    }
    prefetch(index);
  }

  function startAudio(url) {
    audio.src = url;
    audio.playbackRate = rate;
    try { audio.currentTime = 0; } catch (_) {}
    const p = audio.play();
    if (p && p.catch) p.catch(onPlayBlocked);
  }

  function onPlayBlocked(err) {
    if (err && err.name === 'NotAllowedError') {
      // Shouldn't happen now (Play is a user gesture), but stay safe.
      playing = false;
      setPlayIcon();
    }
  }

  function finishAll() {
    playing = false;
    setPlayIcon();
    cursor = 0;
    highlightOutline();
    post({ type: 'ended' });
  }

  // ---------- byte-engine audio ----------
  function requestChunk(index) {
    if (index < 0 || index >= job.chunks.length) return;
    if (urlCache.has(index) || requested.has(index)) return;
    requested.add(index);
    post({ type: 'needChunk', index });
  }

  function prefetch(index) {
    for (let k = 1; k <= PREFETCH; k++) requestChunk(index + k);
  }

  // Warm the start chunk(s) on load so pressing Play begins without delay.
  function prewarm() {
    if (engine !== 'edge' || !job) return;
    requestChunk(cursor);
    prefetch(cursor);
  }

  function onAudio(m) {
    requested.delete(m.index);
    const blob = new Blob([m.bytes], { type: m.mime || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const old = urlCache.get(m.index);
    if (old) URL.revokeObjectURL(old);
    urlCache.set(m.index, url);
    if (playing && cursor === m.index && waitingFor === m.index) {
      waitingFor = -1;
      startAudio(url);
    }
  }

  function onAudioError(m) {
    requested.delete(m.index);
    if (playing && cursor === m.index) playAt(cursor + 1);
  }

  audio.addEventListener('ended', () => { if (playing) playAt(cursor + 1); });
  audio.addEventListener('timeupdate', updateScrub);
  audio.addEventListener('loadedmetadata', updateScrub);

  function updateScrub() {
    const d = audio.duration || 0;
    const c = audio.currentTime || 0;
    const pct = d ? (c / d) * 100 : 0;
    $('scrub').value = d ? String(Math.round(pct * 10)) : '0';
    $('scrub').style.setProperty('--played', pct + '%');
    $('time-cur').textContent = fmt(c);
    $('time-total').textContent = fmt(d);
  }
  function fmt(s) {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + String(ss).padStart(2, '0');
  }

  // ---------- browser engine ----------
  function initSynthVoices() {
    const load = () => {
      const vs = window.speechSynthesis.getVoices();
      const base = job ? job.locale.split('-')[0].toLowerCase() : 'en';
      synthVoice =
        vs.find((v) => v.lang.toLowerCase().startsWith(job.locale.toLowerCase())) ||
        vs.find((v) => v.lang.toLowerCase().startsWith(base)) ||
        vs.find((v) => v.default) || vs[0] || null;
    };
    window.speechSynthesis.onvoiceschanged = load;
    load();
  }

  function speak(index) {
    if (index >= job.chunks.length) { finishAll(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(job.chunks[index].text);
    u.rate = Math.min(2.5, Math.max(0.5, rate));
    u.volume = volume;
    u.lang = job.locale;
    if (synthVoice) u.voice = synthVoice;
    u.onend = () => { if (playing && cursor === index) playAt(index + 1); };
    window.speechSynthesis.speak(u);
  }

  function switchToBrowser() {
    engine = 'browser';
    audio.pause();
    initSynthVoices();
    if (playing) speak(cursor);
  }

  // ---------- voice / gender ----------
  function onVoiceUi(m) {
    clearAudioCache();
    if (job) {
      job.autoLang = m.autoLang;
      job.locale = m.locale;
      job.localeName = m.localeName;
      job.languages = m.languages;
      job.voicePair = m.voicePair;
      job.allVoices = m.allVoices;
      job.currentVoice = m.currentVoice;
      job.gender = m.gender;
    }
    renderHeader();
    renderGender();
    renderVoiceSelect();
    applyAutoUi();
    renderLangSelect();
    if (engine === 'browser') initSynthVoices();
    if (playing && engine === 'edge') {
      // Playing: keep the old voice going until the new voice's audio is ready,
      // then cut over (startAudio swaps the src) — no silent gap while it loads.
      playAt(cursor);
    } else if (playing && engine === 'browser') {
      speak(cursor);
    } else if (engine === 'edge') {
      // Paused: drop the now-stale audio so the next Play re-synthesizes in the
      // new voice instead of resuming the old one.
      audio.pause();
      audio.removeAttribute('src');
    } else {
      // Paused, browser engine: cancel the queued utterance so Play uses the new voice.
      window.speechSynthesis.cancel();
    }
  }

  function clearAudioCache() {
    for (const url of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
    requested.clear();
    waitingFor = -1;
  }

  // ---------- rendering ----------
  function renderGender() {
    const f = job.voicePair.female, mle = job.voicePair.male;
    const gf = $('g-female'), gm = $('g-male');
    if (f) { $('g-female-name').textContent = f.name; gf.disabled = false; gf.title = f.shortName; }
    else { gf.disabled = true; }
    if (mle) { $('g-male-name').textContent = mle.name; gm.disabled = false; gm.title = mle.shortName; }
    else { gm.disabled = true; }
    gf.classList.toggle('active', job.gender === 'female');
    gm.classList.toggle('active', job.gender === 'male');
  }

  function renderVoiceSelect() {
    const sel = $('voice-select');
    sel.innerHTML = '';
    const groups = { female: [], male: [] };
    for (const v of job.allVoices) (groups[v.gender] || (groups[v.gender] = [])).push(v);
    for (const g of ['female', 'male']) {
      if (!groups[g] || !groups[g].length) continue;
      const og = document.createElement('optgroup');
      og.label = g === 'female' ? '♀ ' + L.female : '♂ ' + L.male;
      for (const v of groups[g]) {
        const o = document.createElement('option');
        o.value = v.shortName;
        o.textContent = v.name + (v.multilingual ? ' · ' + L.multilingual : '');
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = job.currentVoice;
  }

  function renderLangSelect() {
    const list = $('lang-list');
    if (!list || !job.locales) return;
    list.textContent = '';
    for (const l of job.locales) {
      const li = document.createElement('li');
      li.className = 'lang-opt';
      li.setAttribute('role', 'option');
      li.dataset.locale = l.locale;
      li.setAttribute('aria-selected', l.locale === job.locale ? 'true' : 'false');
      li.appendChild(makeFlagSpan(l.locale));
      const name = document.createElement('span'); name.className = 'lang-name'; name.textContent = l.name;
      const code = document.createElement('span'); code.className = 'lang-code'; code.textContent = l.locale;
      const chk = document.createElement('span'); chk.className = 'lang-check'; chk.textContent = '✓';
      li.appendChild(name); li.appendChild(code); li.appendChild(chk);
      li.addEventListener('click', () => selectLocale(l.locale));
      list.appendChild(li);
    }
    updateLangButton();
  }

  // Rough reading-time estimate (chars/sec at the current speed). Edge neural
  // voices read ~14 chars/sec at 1.0×.
  const CHARS_PER_SEC = 14;
  function estLabel() {
    if (!totalChars) return '';
    const sec = totalChars / CHARS_PER_SEC / Math.max(0.5, rate);
    return sec < 90
      ? L.estSeconds.replace('{0}', String(Math.round(sec)))
      : L.estMinutes.replace('{0}', String(Math.round(sec / 60)));
  }
  function renderHeader() {
    if (!job) return;
    const est = estLabel();
    let langPart;
    if (job.autoLang) {
      const names = (job.languages || []).map((l) => l.name);
      langPart = names.length > 1 ? L.autoPrefix.replace('{0}', names.join(', ')) : (names[0] || job.localeName);
    } else {
      langPart = job.localeName;
    }
    const n = job.chunks.length;
    const sentences = (n === 1 ? L.sentencesOne : L.sentencesOther).replace('{0}', String(n));
    $('lang').textContent = langPart + ' · ' + sentences + (est ? ' · ' + est : '');
  }

  // In auto mode the language/voice pickers are informational (disabled); the
  // gender toggle still applies. In manual mode they drive a single fixed voice.
  function applyAutoUi() {
    const on = !!(job && job.autoLang);
    if ($('auto-lang')) $('auto-lang').checked = on;
    if ($('lang-combo')) $('lang-combo').classList.toggle('disabled', on);
    if ($('lang-button')) $('lang-button').disabled = on;
    if (on) closeLang();
    if ($('voice-select')) $('voice-select').disabled = on;
    if ($('detect-lang')) $('detect-lang').disabled = on;
  }

  function renderOutline() {
    const box = $('outline');
    box.innerHTML = '';
    const panel = $('outline-panel');
    if (!job.outline.length) { if (panel) panel.style.display = 'none'; return; }
    if (panel) panel.style.display = '';
    const head = document.createElement('div');
    head.className = 'outline-head';
    head.textContent = L.sections;
    box.appendChild(head);
    for (const item of job.outline) {
      const b = document.createElement('button');
      b.className = 'outline-item';
      b.style.paddingLeft = 8 + (item.level - 1) * 14 + 'px';
      b.textContent = item.label;
      b.dataset.index = String(item.chunkIndex);
      b.addEventListener('click', () => { cursor = item.chunkIndex; playing = true; setPlayIcon(); playAt(item.chunkIndex); });
      box.appendChild(b);
    }
    highlightOutline();
  }

  function highlightOutline() {
    const items = [...document.querySelectorAll('.outline-item')];
    let activeIdx = -1;
    for (let i = 0; i < job.outline.length; i++) {
      if (job.outline[i].chunkIndex <= cursor) activeIdx = i;
    }
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  }

  // Build every sentence once as a stable line. Advancing then only moves the
  // highlight and scrolls the list, so the change is a smooth glide, not a redraw.
  function renderAllLines() {
    if (!job) return;
    const box = $('transcript');
    box.innerHTML = '';
    linesEl = document.createElement('div');
    linesEl.id = 'lines';
    linesEl.className = 'noanim';
    hlEl = document.createElement('div');
    hlEl.id = 'hl';
    linesEl.appendChild(hlEl);
    lineEls = [];
    for (let i = 0; i < job.chunks.length; i++) {
      const p = document.createElement('p');
      p.className = 'line';
      p.textContent = job.chunks[i].text;
      p.addEventListener('click', () => { cursor = i; playing = true; setPlayIcon(); playAt(i); });
      linesEl.appendChild(p);
      lineEls.push(p);
    }
    box.appendChild(linesEl);
    // place the current line without animation, then enable the glide
    updateTranscript();
    requestAnimationFrame(() => {
      updateTranscript();
      requestAnimationFrame(() => { if (linesEl) linesEl.classList.remove('noanim'); });
    });
  }

  // Move the highlight onto the current line and scroll it toward the middle.
  function updateTranscript() {
    if (!job || !lineEls || !lineEls.length || !hlEl) return;
    const idx = Math.min(Math.max(cursor, 0), lineEls.length - 1);
    for (let i = 0; i < lineEls.length; i++) {
      lineEls[i].classList.toggle('cur', i === idx);
      lineEls[i].classList.toggle('done', i < idx);
    }
    const cur = lineEls[idx];
    const top = cur.offsetTop;
    const h = cur.offsetHeight;
    hlEl.style.transform = 'translateY(' + top + 'px)';
    hlEl.style.height = h + 'px';
    const box = $('transcript');
    const vpH = box.clientHeight;
    let y = top + h / 2 - vpH / 2;
    const maxY = Math.max(0, linesEl.scrollHeight - vpH);
    if (y < 0) y = 0; else if (y > maxY) y = maxY;
    linesEl.style.transform = 'translateY(' + -y + 'px)';
    const sr = $('sr');
    if (sr) sr.textContent = job.chunks[idx] ? job.chunks[idx].text : '';
  }

  function setPlayIcon() {
    const p = $('play');
    if (!p) return;
    p.setAttribute('aria-pressed', playing ? 'true' : 'false');
    p.setAttribute('aria-label', playing ? L.pause : L.play);
  }

  // ---------- controls ----------
  $('play').addEventListener('click', togglePlay);
  $('stop').addEventListener('click', doStop);
  $('next').addEventListener('click', () => { playing = true; setPlayIcon(); playAt(cursor + 1); });
  $('prev').addEventListener('click', () => { playing = true; setPlayIcon(); playAt(cursor - 1); });

  $('scrub').addEventListener('input', () => {
    if (engine !== 'edge' || !audio.duration) return;
    audio.currentTime = (Number($('scrub').value) / 1000) * audio.duration;
  });

  // Single source of truth for the rate: slider, the ± buttons and load all use it.
  function applyRate(r, persist) {
    r = Math.min(2.5, Math.max(0.5, Math.round(r * 100) / 100));
    rate = r;
    audio.playbackRate = rate;
    $('speed').value = String(rate);
    $('speed-val').textContent = rate.toFixed(2).replace(/0$/, '') + '×';
    if ($('speed-down')) $('speed-down').disabled = rate <= 0.5;
    if ($('speed-up')) $('speed-up').disabled = rate >= 2.5;
    renderHeader(); // update the estimated reading time live
    if (persist) post({ type: 'persistSpeed', value: rate });
  }
  $('speed').addEventListener('input', () => applyRate(Number($('speed').value), false));
  $('speed').addEventListener('change', () => post({ type: 'persistSpeed', value: rate }));
  $('speed-down').addEventListener('click', () => applyRate(rate - 0.1, true));
  $('speed-up').addEventListener('click', () => applyRate(rate + 0.1, true));

  // ---------- volume ----------
  function applyVolume(v, persist) {
    v = Math.min(1, Math.max(0, v));
    volume = v;
    if (v > 0.001) lastVolume = v;
    audio.volume = v;
    const sl = $('volume');
    if (sl) { sl.value = String(v); sl.style.setProperty('--vol', v * 100 + '%'); }
    const vv = $('vol-val');
    if (vv) vv.textContent = Math.round(v * 100) + '%';
    updateVolIcon(v);
    if (persist) post({ type: 'persistVolume', value: v });
  }
  function updateVolIcon(v) {
    const b = $('mute');
    if (!b) return;
    const muted = v <= 0.001;
    b.classList.toggle('muted', muted);
    b.classList.toggle('low', !muted && v < 0.5);
    b.setAttribute('aria-label', muted ? L.unmute : L.mute);
    b.title = muted ? L.unmute : L.mute;
  }
  $('volume').addEventListener('input', () => applyVolume(Number($('volume').value), false));
  $('volume').addEventListener('change', () => post({ type: 'persistVolume', value: volume }));
  $('mute').addEventListener('click', () => {
    if (volume > 0.001) applyVolume(0, true);
    else applyVolume(lastVolume > 0.001 ? lastVolume : 1, true);
  });

  $('g-female').addEventListener('click', () => post({ type: 'setGender', gender: 'female' }));
  $('g-male').addEventListener('click', () => post({ type: 'setGender', gender: 'male' }));

  $('voice-select').addEventListener('change', (e) => {
    post({ type: 'setVoice', shortName: e.target.value });
  });

  // ---------- language combobox (custom dropdown with flags) ----------
  function countryOf(locale) {
    const parts = String(locale).split('-');
    for (let i = parts.length - 1; i >= 1; i--) {
      if (/^[A-Z]{2}$/.test(parts[i])) return parts[i].toLowerCase();
    }
    return null;
  }
  function globeSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '9');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18');
    svg.appendChild(c); svg.appendChild(p);
    return svg;
  }
  function fillFlag(span, locale) {
    span.className = 'lang-flag';
    span.textContent = '';
    const cc = countryOf(locale);
    if (cc && flagsBase) {
      const img = document.createElement('img');
      img.src = flagsBase + '/' + cc + '.svg';
      img.alt = '';
      img.onerror = () => { span.className = 'lang-flag globe'; span.textContent = ''; span.appendChild(globeSvg()); };
      span.appendChild(img);
    } else {
      span.className = 'lang-flag globe';
      span.appendChild(globeSvg());
    }
  }
  function makeFlagSpan(locale) {
    const span = document.createElement('span');
    fillFlag(span, locale);
    return span;
  }
  function updateLangButton() {
    const found = (job.locales || []).find((l) => l.locale === job.locale);
    fillFlag($('lang-button-flag'), job.locale);
    $('lang-button-label').textContent = found ? found.name : (job.localeName || job.locale);
  }
  function selectLocale(locale) {
    closeLang();
    $('lang-button').focus();
    if (locale === job.locale) return;
    post({ type: 'setLocale', locale });
  }
  function setLangActive(idx, scroll) {
    const opts = [...$('lang-list').children];
    if (!opts.length) return;
    langActiveIdx = Math.max(0, Math.min(idx, opts.length - 1));
    opts.forEach((o, i) => o.classList.toggle('active', i === langActiveIdx));
    if (scroll && opts[langActiveIdx]) opts[langActiveIdx].scrollIntoView({ block: 'nearest' });
  }
  function openLang() {
    if ($('lang-combo').classList.contains('disabled')) return;
    langOpen = true;
    $('lang-list').hidden = false;
    $('lang-button').setAttribute('aria-expanded', 'true');
    const opts = [...$('lang-list').children];
    const i = opts.findIndex((o) => o.getAttribute('aria-selected') === 'true');
    setLangActive(i < 0 ? 0 : i, true);
  }
  function closeLang() {
    langOpen = false;
    const list = $('lang-list');
    if (list) list.hidden = true;
    const btn = $('lang-button');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  $('lang-button').addEventListener('click', () => { langOpen ? closeLang() : openLang(); });
  $('lang-combo').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (langOpen) { closeLang(); $('lang-button').focus(); e.preventDefault(); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!langOpen) openLang(); else setLangActive(langActiveIdx + 1, true); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (langOpen) setLangActive(langActiveIdx - 1, true); return; }
    if (e.key === 'Home') { if (langOpen) { e.preventDefault(); setLangActive(0, true); } return; }
    if (e.key === 'End') { if (langOpen) { e.preventDefault(); setLangActive(1e9, true); } return; }
    if ((e.key === 'Enter' || e.key === ' ') && langOpen) {
      e.preventDefault();
      const o = [...$('lang-list').children][langActiveIdx];
      if (o) selectLocale(o.dataset.locale);
      return;
    }
    if (langOpen && e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      if (now - typeAt > 800) typeBuf = '';
      typeAt = now; typeBuf += e.key.toLowerCase();
      const opts = [...$('lang-list').children];
      const idx = opts.findIndex((o) => (o.querySelector('.lang-name').textContent || '').toLowerCase().startsWith(typeBuf));
      if (idx >= 0) setLangActive(idx, true);
    }
  });
  document.addEventListener('click', (e) => {
    if (langOpen && !$('lang-combo').contains(e.target)) closeLang();
  });

  $('detect-lang').addEventListener('click', () => post({ type: 'detectLanguage' }));

  $('auto-lang').addEventListener('change', (e) => post({ type: 'setAutoLang', value: e.target.checked }));

  function onControl(action) {
    if (action === 'playpause') togglePlay();
    else if (action === 'stop') doStop();
  }

  post({ type: 'ready' });
})();
