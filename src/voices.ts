import voicesData from './data/voices.json';
import type { Gender } from './types';

export interface VoiceRec {
  shortName: string;
  locale: string;
  lang: string;
  gender: string; // "Female" | "Male"
  friendlyName: string;
  multilingual: boolean;
}

const voices: VoiceRec[] = voicesData.voices as VoiceRec[];
const curated: Record<string, { female?: string; male?: string }> = voicesData.curated as any;
const langDefaultLocale: Record<string, string> = voicesData.langDefaultLocale as any;

const FALLBACK = {
  female: 'en-US-AvaMultilingualNeural',
  male: 'en-US-AndrewMultilingualNeural',
};

/** Map a base ISO-639-1 language code (e.g. "de") to its primary locale (e.g. "de-DE"). */
export function localeForLang(lang: string): string | undefined {
  return langDefaultLocale[lang.toLowerCase()];
}

/** The curated female/male pair for a locale (best voices we picked). */
export function curatedPair(locale: string): { female?: string; male?: string } {
  return curated[locale] || curated[localeForLang(locale.split('-')[0]) || ''] || {};
}

/** Pick the best voice for a locale + preferred gender, honoring user overrides. */
export function pickVoice(
  locale: string,
  gender: Gender,
  overrides: Record<string, string> = {}
): string {
  if (overrides[locale]) return overrides[locale];
  const base = locale.split('-')[0];
  if (overrides[base]) return overrides[base];

  const tryLocales = [locale, langDefaultLocale[base]].filter(Boolean) as string[];
  for (const loc of tryLocales) {
    const c = curated[loc];
    if (c) return c[gender] || c[gender === 'female' ? 'male' : 'female'] || FALLBACK[gender];
  }
  return FALLBACK[gender];
}

/** All voices for a locale (for the advanced "all voices" picker). */
export function voicesForLocale(locale: string): VoiceRec[] {
  return voices.filter((v) => v.locale === locale);
}

export function getVoice(shortName: string): VoiceRec | undefined {
  return voices.find((v) => v.shortName === shortName);
}

/** Extract a short friendly name, e.g. "Microsoft Ava Online (Natural) - English…" -> "Ava". */
export function displayName(shortName: string): string {
  const v = getVoice(shortName);
  if (v) {
    const m = v.friendlyName.match(/Microsoft\s+([^\s]+?)(?:Multilingual)?\b/);
    if (m) return m[1];
  }
  // Fallback: parse from the shortName ("de-DE-SeraphinaMultilingualNeural" -> "Seraphina")
  const part = shortName.split('-').slice(2).join('-');
  return part.replace(/Multilingual/i, '').replace(/Neural$/i, '') || shortName;
}

export function localeDisplay(locale: string): string {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    return dn.of(locale) || locale;
  } catch {
    return locale;
  }
}

export const catalogInfo = {
  voiceCount: voicesData.voiceCount,
  localeCount: voicesData.localeCount,
  langCount: voicesData.langCount,
  generatedAt: voicesData.generatedAt,
};
