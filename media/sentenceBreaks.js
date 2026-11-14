/* Sentence-break repair for Intl.Segmenter, shared by the reader webview (loaded
   as a classic script before reader.js) and the audio export (bundled through
   src/segmenter.ts), so both sides cut sentences by the very same rules.

   Intl.Segmenter ends a sentence at nearly every "." that is followed by a
   capital or a digit. That cuts ".NET Core", "Dr. Smith", "e.g. Python",
   "z. B. Der", "Am 3. Oktober" and "Nr. 3" in two (issue #12): the voice pauses
   mid-sentence and a pronunciation for ".NET" never matches. joinFalseBreaks()
   glues such pieces back on. When unsure it merges, because two real sentences
   read as one unit sound the same, while a false cut is always audible. */
(function (root) {
  // Words that do not end a sentence before a capital (compared in lower case).
  // Left out on purpose: etc., usw., Inc., Ltd., which often do end one.
  const ABBR = new Set([
    // English
    'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'mt', 'sr', 'jr', 'vs', 'approx', 'ca', 'cf',
    'gen', 'capt', 'sgt', 'lt', 'col', 'rev',
    'jan', 'feb', 'apr', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    // German
    'hr', 'hrn', 'fr', 'bzw', 'vgl', 'ggf', 'evtl', 'inkl', 'exkl', 'zzgl', 'bspw', 'sog',
    'ggü', 'gem', 'insb', 'hrsg', 'okt', 'dez',
    // French, Spanish, Italian, Portuguese
    'mme', 'mlle', 'pr', 'sra', 'srta', 'dra', 'ud', 'uds', 'aprox', 'sig', 'sigg', 'dott',
  ]);
  // Words that only stand before a number ("No. 5", "Fig. 3", "Kap. 2"). Before a
  // capital they stay a sentence end: "The answer is No. Then we left."
  const NUM_ABBR = new Set([
    'no', 'nos', 'nr', 'fig', 'figs', 'vol', 'vols', 'ch', 'sec', 'pp',
    'abb', 'tab', 'kap', 'bd', 'art', 'abs', 'pag', 'pág', 'págs', 'núm',
  ]);
  // the word in front of the final dot, keeping inner dots: "e.g", "U.S", "Dr", "3"
  const WORD_BEFORE_DOT = /(?:^|[^\p{L}\p{N}.])([\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*)\.\s+$/u;

  // Is the cut between two raw segments a false sentence end? `prev` still ends
  // with the whitespace Intl.Segmenter keeps after a sentence.
  function falseBreak(prev, next) {
    // no space after the dot: ".NET", "file.README"
    if (prev.endsWith('.')) return /^[\p{L}\p{N}]/u.test(next);
    const m = WORD_BEFORE_DOT.exec(prev);
    if (!m) return false;
    const word = m[1];
    // initials and letter abbreviations: "J. K.", "z. B.", "e.g.", "U.S."
    if (word.split('.').every((p) => p.length === 1 && /\p{L}/u.test(p))) return true;
    // ordinal number before a word: "Am 3. Oktober", "im 19. Jahrhundert"
    if (/^\p{N}{1,3}$/u.test(word)) return /^\p{L}/u.test(next);
    const lower = word.toLowerCase();
    if (NUM_ABBR.has(lower)) return /^\p{N}/u.test(next);
    return ABBR.has(lower);
  }

  // Glue false cuts back on. Takes and returns Intl.Segmenter style
  // { segment, index } pieces, so the reader's character offsets stay valid.
  function joinFalseBreaks(segments) {
    const out = [];
    for (const s of segments) {
      const prev = out[out.length - 1];
      if (prev && falseBreak(prev.segment, s.segment)) prev.segment += s.segment;
      else out.push({ segment: s.segment, index: s.index });
    }
    return out;
  }

  const api = { joinFalseBreaks };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MRASentenceBreaks = api;
})(globalThis);
