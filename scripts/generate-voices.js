/**
 * Dev tool: pull the full Microsoft Edge voice list and build a curated catalog
 * covering ALL locales (1 best female + 1 best male each), with flagship overrides
 * for the major languages. Writes src/data/voices.json (bundled into the extension).
 *
 *   node scripts/generate-voices.js
 */
const fs = require('fs');
const path = require('path');
const { MsEdgeTTS } = require('msedge-tts');

// Hand-picked best ♀/♂ per major locale (the *MultilingualNeural tier is the most
// expressive; these are the voices we verified sound great).
const FLAGSHIP = {
  'en-US': { female: 'en-US-AvaMultilingualNeural', male: 'en-US-AndrewMultilingualNeural' },
  'en-GB': { female: 'en-GB-SoniaNeural', male: 'en-GB-RyanNeural' },
  'en-AU': { female: 'en-AU-NatashaNeural', male: 'en-AU-WilliamMultilingualNeural' },
  'de-DE': { female: 'de-DE-SeraphinaMultilingualNeural', male: 'de-DE-FlorianMultilingualNeural' },
  'fr-FR': { female: 'fr-FR-VivienneMultilingualNeural', male: 'fr-FR-RemyMultilingualNeural' },
  'es-ES': { female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' },
  'es-MX': { female: 'es-MX-DaliaNeural', male: 'es-MX-JorgeNeural' },
  'it-IT': { female: 'it-IT-IsabellaNeural', male: 'it-IT-GiuseppeMultilingualNeural' },
  'pt-BR': { female: 'pt-BR-ThalitaMultilingualNeural', male: 'pt-BR-AntonioNeural' },
  'pt-PT': { female: 'pt-PT-RaquelNeural', male: 'pt-PT-DuarteNeural' },
  'nl-NL': { female: 'nl-NL-ColetteNeural', male: 'nl-NL-MaartenNeural' },
  'pl-PL': { female: 'pl-PL-ZofiaNeural', male: 'pl-PL-MarekNeural' },
  'ru-RU': { female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' },
  'uk-UA': { female: 'uk-UA-PolinaNeural', male: 'uk-UA-OstapNeural' },
  'tr-TR': { female: 'tr-TR-EmelNeural', male: 'tr-TR-AhmetNeural' },
  'sv-SE': { female: 'sv-SE-SofieNeural', male: 'sv-SE-MattiasNeural' },
  'da-DK': { female: 'da-DK-ChristelNeural', male: 'da-DK-JeppeNeural' },
  'nb-NO': { female: 'nb-NO-PernilleNeural', male: 'nb-NO-FinnNeural' },
  'fi-FI': { female: 'fi-FI-NooraNeural', male: 'fi-FI-HarriNeural' },
  'cs-CZ': { female: 'cs-CZ-VlastaNeural', male: 'cs-CZ-AntoninNeural' },
  'el-GR': { female: 'el-GR-AthinaNeural', male: 'el-GR-NestorasNeural' },
  'hu-HU': { female: 'hu-HU-NoemiNeural', male: 'hu-HU-TamasNeural' },
  'ro-RO': { female: 'ro-RO-AlinaNeural', male: 'ro-RO-EmilNeural' },
  'ja-JP': { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
  'ko-KR': { female: 'ko-KR-SunHiNeural', male: 'ko-KR-HyunsuMultilingualNeural' },
  'zh-CN': { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' },
  'zh-TW': { female: 'zh-TW-HsiaoChenNeural', male: 'zh-TW-YunJheNeural' },
  'ar-SA': { female: 'ar-SA-ZariyahNeural', male: 'ar-SA-HamedNeural' },
  'he-IL': { female: 'he-IL-HilaNeural', male: 'he-IL-AvriNeural' },
  'hi-IN': { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' },
  'th-TH': { female: 'th-TH-PremwadeeNeural', male: 'th-TH-NiwatNeural' },
  'vi-VN': { female: 'vi-VN-HoaiMyNeural', male: 'vi-VN-NamMinhNeural' },
  'id-ID': { female: 'id-ID-GadisNeural', male: 'id-ID-ArdiNeural' },
};

// For a detected base language (ISO 639-1) which locale is the "primary" one.
const PRIMARY_LOCALE = {
  en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', it: 'it-IT',
  nl: 'nl-NL', pl: 'pl-PL', ru: 'ru-RU', uk: 'uk-UA', tr: 'tr-TR', sv: 'sv-SE',
  da: 'da-DK', no: 'nb-NO', nb: 'nb-NO', fi: 'fi-FI', cs: 'cs-CZ', el: 'el-GR',
  hu: 'hu-HU', ro: 'ro-RO', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA',
  he: 'he-IL', hi: 'hi-IN', th: 'th-TH', vi: 'vi-VN', id: 'id-ID', bg: 'bg-BG',
  hr: 'hr-HR', sk: 'sk-SK', sl: 'sl-SI', et: 'et-EE', lv: 'lv-LV', lt: 'lt-LT',
  ca: 'ca-ES', fa: 'fa-IR', ur: 'ur-PK', ta: 'ta-IN', te: 'te-IN', ml: 'ml-IN',
  bn: 'bn-BD', mr: 'mr-IN', gu: 'gu-IN', kn: 'kn-IN', sr: 'sr-RS', af: 'af-ZA',
  sw: 'sw-KE', ms: 'ms-MY', fil: 'fil-PH', is: 'is-IS', ga: 'ga-IE', cy: 'cy-GB',
  mt: 'mt-MT', sq: 'sq-AL', mk: 'mk-MK', az: 'az-AZ', ka: 'ka-GE', hy: 'hy-AM',
  kk: 'kk-KZ', my: 'my-MM', km: 'km-KH', lo: 'lo-LA', si: 'si-LK', ne: 'ne-NP',
  am: 'am-ET', eu: 'eu-ES', gl: 'gl-ES', so: 'so-SO', zu: 'zu-ZA', jv: 'jv-ID',
  su: 'su-ID', uz: 'uz-UZ', mn: 'mn-MN', ps: 'ps-AF', bs: 'bs-BA',
};

function isMultilingual(shortName) {
  return /Multilingual/i.test(shortName);
}

function pick(voices, gender, locale) {
  const byGender = voices.filter((v) => v.Gender === gender);
  if (byGender.length === 0) return undefined;
  // Prefer flagship, then multilingual, then first.
  const flag = FLAGSHIP[locale]?.[gender.toLowerCase()];
  if (flag && byGender.some((v) => v.ShortName === flag)) return flag;
  const multi = byGender.find((v) => isMultilingual(v.ShortName));
  if (multi) return multi.ShortName;
  return byGender[0].ShortName;
}

(async () => {
  const tts = new MsEdgeTTS();
  console.log('Fetching voice list…');
  const all = await tts.getVoices();
  console.log(`Got ${all.length} voices.`);

  const voices = all.map((v) => ({
    shortName: v.ShortName,
    locale: v.Locale,
    lang: v.Locale.split('-')[0].toLowerCase(),
    gender: v.Gender, // "Female" | "Male"
    friendlyName: v.FriendlyName,
    multilingual: isMultilingual(v.ShortName),
  }));

  // Group by locale
  const byLocale = {};
  for (const v of all) (byLocale[v.Locale] ??= []).push(v);

  const curated = {};
  for (const [locale, vs] of Object.entries(byLocale)) {
    const female = pick(vs, 'Female', locale);
    const male = pick(vs, 'Male', locale);
    curated[locale] = {};
    if (female) curated[locale].female = female;
    if (male) curated[locale].male = male;
  }

  // base language -> primary locale (prefer manual map, else locale with a flagship,
  // else most-voices locale)
  const langLocales = {};
  for (const v of all) {
    const base = v.Locale.split('-')[0].toLowerCase();
    (langLocales[base] ??= new Set()).add(v.Locale);
  }
  const langDefaultLocale = {};
  for (const [base, set] of Object.entries(langLocales)) {
    const locales = [...set];
    if (PRIMARY_LOCALE[base] && set.has(PRIMARY_LOCALE[base])) {
      langDefaultLocale[base] = PRIMARY_LOCALE[base];
    } else {
      const withFlag = locales.find((l) => FLAGSHIP[l]);
      langDefaultLocale[base] =
        withFlag ||
        locales.sort((a, b) => byLocale[b].length - byLocale[a].length)[0];
    }
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'Microsoft Edge read-aloud voice list',
    voiceCount: voices.length,
    localeCount: Object.keys(byLocale).length,
    langCount: Object.keys(langDefaultLocale).length,
    voices,
    curated,
    langDefaultLocale,
  };

  const dir = path.join(__dirname, '..', 'src', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify(out, null, 0));
  console.log(
    `Wrote src/data/voices.json — ${out.voiceCount} voices, ${out.localeCount} locales, ${out.langCount} base languages.`
  );
  // quick sanity print
  console.log('Sample curated:', JSON.stringify(curated['de-DE']), JSON.stringify(curated['en-US']), JSON.stringify(curated['ja-JP']));
})().catch((e) => { console.error(e); process.exit(1); });
