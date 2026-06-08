import { eld } from 'eld/small';
import { localeForLang } from './voices';
import { stripForDetection } from './markdown/normalize';

/**
 * Detect the document language from its markdown source and map it to a BCP-47
 * locale we have a voice for. Returns the fallback locale when detection is
 * unreliable or the language isn't supported.
 */
export function detectLocale(source: string, fallbackLocale: string): { locale: string; lang?: string; reliable: boolean } {
  const sample = stripForDetection(source).slice(0, 2000);
  if (sample.length < 12) return { locale: fallbackLocale, reliable: false };
  try {
    const r = eld.detect(sample);
    const reliable = r.isReliable();
    if (r.language) {
      const loc = localeForLang(r.language);
      if (loc) return { locale: loc, lang: r.language, reliable };
    }
  } catch {
    /* ignore */
  }
  return { locale: fallbackLocale, reliable: false };
}
