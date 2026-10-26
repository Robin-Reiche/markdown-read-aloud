// Daily check from .github/workflows/edge-check.yml: does Microsoft's
// read-aloud service still return audio? It fails when the main way (the old
// host with the v2 token that Edge itself uses) stops working. The reserve
// (api.msedgeservices.com, closed since 23 October 2026) only adds a warning to
// the run, so its outage cannot hide a new one on the main way (see edgeRoute
// in src/engines/edgeEngine.ts). Run it locally with
//   npx esbuild scripts/edge-probe.ts --bundle --platform=node --outfile=.test-dist/edge-probe.js && node .test-dist/edge-probe.js
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { edgeRoute } from '../src/engines/edgeEngine';

const VOICE = 'en-US-AriaNeural';
const TEXT = 'This is the daily check of the Edge voices.';
const ATTEMPTS = 3; // a single network hiccup on the runner is no alarm
const PAUSE_MS = 30000;
// Worst case is 2 ways x 3 attempts x (10 s connect + 20 s stall) plus the
// pauses, about 5 minutes. The watchdog turns any longer hang into a clear
// failure before the job's 10-minute limit cancels the run.
const WATCHDOG_MS = 8 * 60000;

// MsEdgeTTS directly instead of EdgeEngine: the engine would quietly switch to
// the other way and hide the refusal this check looks for.
async function audioVia(route: typeof edgeRoute.current): Promise<number> {
  edgeRoute.current = route;
  const tts = new MsEdgeTTS({ synthesisTimeoutMs: 20000 });
  try {
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { voiceLocale: 'en-US' });
    const { audioStream } = tts.toStream(TEXT);
    let bytes = 0;
    for await (const chunk of audioStream) bytes += (chunk as Buffer).length;
    return bytes;
  } finally {
    tts.close();
  }
}

(async () => {
  setTimeout(() => {
    console.log(`no result after ${WATCHDOG_MS / 60000} minutes, a way hangs`);
    process.exit(1);
  }, WATCHDOG_MS).unref();
  let failed = false;
  for (const route of ['bing', 'msedgeservices'] as const) {
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = await audioVia(route);
        if (bytes < 1000) throw new Error(`only ${bytes} bytes of audio`);
        console.log(`${route}: OK, ${bytes} bytes of audio`);
        break;
      } catch (e) {
        console.log(`${route}: attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
        if (attempt === ATTEMPTS) {
          // GitHub shows ::warning:: as a note on the run without turning it red.
          if (route === 'bing') failed = true;
          else console.log('::warning::The reserve way gives no audio, the users depend on bing alone');
          break;
        }
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
    }
  }
  process.exit(failed ? 1 : 0);
})();
