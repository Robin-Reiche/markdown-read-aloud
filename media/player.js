(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const audio = new Audio();
  audio.preservesPitch = true;

  let job = null;
  let engine = 'edge';
  let rate = 1;
  let cursor = 0;
  let playing = false;
  let unlocked = false;
  let waitingFor = -1;
  let pendingGesture = null;
  let totalChars = 0;
  const PREFETCH = 2;

  const urlCache = new Map(); // index -> objectURL
  const requested = new Set(); // indices we've asked the host for
  let synthVoice = null; // browser engine

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
    clearAudioCache();

    totalChars = job.chunks.reduce((s, c) => s + c.text.length, 0);
    $('title').textContent = job.title;
    renderHeader();
    audio.playbackRate = rate;
    $('speed').value = String(rate);
    $('speed-val').textContent = rate.toFixed(2).replace(/0$/, '') + '×';

    renderGender();
    renderLangSelect();
    renderVoiceSelect();
    renderOutline();
    renderTranscript();

    if (engine === 'browser') initSynthVoices();

    if (m.autostart) startFlow(() => doPlay());
  }

  // ---------- gesture gate (first play needs a user gesture) ----------
  function startFlow(cb) {
    if (unlocked) { cb(); return; }
    pendingGesture = cb;
    $('gesture-overlay').classList.remove('hidden');
  }
  $('gesture-play').addEventListener('click', () => {
    unlocked = true;
    $('gesture-overlay').classList.add('hidden');
    const cb = pendingGesture; pendingGesture = null;
    if (cb) cb();
  });

  // ---------- transport ----------
  function doPlay() {
    if (!job) return;
    unlocked = true;
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
    else startFlow(() => doPlay());
  }

  function doStop() {
    playing = false;
    setPlayIcon();
    if (engine === 'edge') { audio.pause(); audio.removeAttribute('src'); }
    else window.speechSynthesis.cancel();
    cursor = 0;
    renderTranscript();
    highlightOutline();
    post({ type: 'ended' });
  }

  function playAt(index) {
    if (!job) return;
    if (index < 0) index = 0;
    if (index >= job.chunks.length) { finishAll(); return; }
    cursor = index;
    renderTranscript();
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
      playing = false; setPlayIcon();
      startFlow(() => doPlay());
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
    $('scrub').value = d ? String(Math.round((c / d) * 1000)) : '0';
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
      job.locale = m.locale;
      job.localeName = m.localeName;
      job.voicePair = m.voicePair;
      job.allVoices = m.allVoices;
      job.currentVoice = m.currentVoice;
      job.gender = m.gender;
    }
    renderHeader();
    renderGender();
    renderVoiceSelect();
    if ($('lang-select')) $('lang-select').value = m.locale;
    if (engine === 'browser') initSynthVoices();
    if (playing && engine === 'edge') { audio.pause(); playAt(cursor); }
    else if (playing && engine === 'browser') speak(cursor);
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
      og.label = g === 'female' ? '♀ Female' : '♂ Male';
      for (const v of groups[g]) {
        const o = document.createElement('option');
        o.value = v.shortName;
        o.textContent = v.name + (v.multilingual ? ' · multilingual' : '');
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = job.currentVoice;
  }

  function renderLangSelect() {
    const sel = $('lang-select');
    if (!sel || !job.locales) return;
    sel.innerHTML = '';
    for (const l of job.locales) {
      const o = document.createElement('option');
      o.value = l.locale;
      o.textContent = l.name;
      sel.appendChild(o);
    }
    sel.value = job.locale;
  }

  // Rough reading-time estimate (chars/sec at the current speed). Edge neural
  // voices read ~14 chars/sec at 1.0×.
  const CHARS_PER_SEC = 14;
  function estLabel() {
    if (!totalChars) return '';
    const sec = totalChars / CHARS_PER_SEC / Math.max(0.5, rate);
    return sec < 90 ? '~' + Math.round(sec) + ' s' : '~' + Math.round(sec / 60) + ' min';
  }
  function renderHeader() {
    if (!job) return;
    const est = estLabel();
    $('lang').textContent =
      job.localeName + ' · ' + job.chunks.length + ' sentences' + (est ? ' · ' + est : '');
  }

  function renderOutline() {
    const box = $('outline');
    box.innerHTML = '';
    for (const item of job.outline) {
      const b = document.createElement('button');
      b.className = 'outline-item';
      b.style.paddingLeft = 4 + (item.level - 1) * 12 + 'px';
      b.textContent = item.label;
      b.dataset.index = String(item.chunkIndex);
      b.addEventListener('click', () => { startFlow(() => { cursor = item.chunkIndex; playing = true; setPlayIcon(); playAt(item.chunkIndex); }); });
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

  function renderTranscript() {
    if (!job) return;
    const box = $('transcript');
    box.innerHTML = '';
    const from = Math.max(0, cursor - 1);
    const to = Math.min(job.chunks.length, cursor + 3);
    for (let i = from; i < to; i++) {
      const span = document.createElement('span');
      span.textContent = job.chunks[i].text + ' ';
      span.className = i < cursor ? 'done' : i === cursor ? 'cur' : '';
      box.appendChild(span);
    }
  }

  function setPlayIcon() { $('play').textContent = playing ? '⏸' : '▶'; }

  // ---------- controls ----------
  $('play').addEventListener('click', togglePlay);
  $('stop').addEventListener('click', doStop);
  $('next').addEventListener('click', () => startFlow(() => { playing = true; setPlayIcon(); playAt(cursor + 1); }));
  $('prev').addEventListener('click', () => startFlow(() => { playing = true; setPlayIcon(); playAt(cursor - 1); }));

  $('scrub').addEventListener('input', () => {
    if (engine !== 'edge' || !audio.duration) return;
    audio.currentTime = (Number($('scrub').value) / 1000) * audio.duration;
  });

  $('speed').addEventListener('input', () => {
    rate = Number($('speed').value);
    audio.playbackRate = rate;
    $('speed-val').textContent = rate.toFixed(2).replace(/0$/, '') + '×';
    renderHeader(); // update the estimated reading time live
  });
  $('speed').addEventListener('change', () => post({ type: 'persistSpeed', value: rate }));

  $('g-female').addEventListener('click', () => post({ type: 'setGender', gender: 'female' }));
  $('g-male').addEventListener('click', () => post({ type: 'setGender', gender: 'male' }));

  $('voice-select').addEventListener('change', (e) => {
    post({ type: 'setVoice', shortName: e.target.value });
  });

  $('lang-select').addEventListener('change', (e) => {
    post({ type: 'setLocale', locale: e.target.value });
  });

  function onControl(action) {
    if (action === 'playpause') togglePlay();
    else if (action === 'stop') doStop();
  }

  post({ type: 'ready' });
})();
