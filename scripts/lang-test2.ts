import * as fs from 'fs';
import * as path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
const esc = (s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const V='de-DE-SeraphinaMultilingualNeural';
const OUT=path.join(__dirname,'..','voice_samples'); fs.mkdirSync(OUT,{recursive:true});
async function synth(text:string, voiceLocale:string, file:string, label:string){
  const tts=new MsEdgeTTS();
  await tts.setMetadata(V, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { voiceLocale });
  const {audioStream}=tts.toStream(esc(text), {rate:'+0%',pitch:'+0Hz',volume:100});
  const chunks:Buffer[]=[]; await new Promise<void>((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),20000);audioStream.on('data',(c:Buffer)=>chunks.push(c));audioStream.on('end',()=>{clearTimeout(t);res();});audioStream.on('error',(e:Error)=>{clearTimeout(t);rej(e);});});
  const buf=Buffer.concat(chunks); fs.writeFileSync(path.join(OUT,file),buf);
  console.log(label.padEnd(40), buf.length,'bytes'); tts.close();
}
(async()=>{
  const EN='The quick brown fox jumps over the lazy dog near the river bank, reading aloud naturally.';
  const DE='Der schnelle braune Fuchs springt über den faulen Hund am Flussufer und liest ganz natürlich vor.';
  console.log('Same EN text, different speak xml:lang (voiceLocale):');
  await synth(EN,'en-US','xl_en_langEN.mp3','EN text + voiceLocale en-US');
  await synth(EN,'de-DE','xl_en_langDE.mp3','EN text + voiceLocale de-DE');
  console.log('Same DE text, different speak xml:lang:');
  await synth(DE,'de-DE','xl_de_langDE.mp3','DE text + voiceLocale de-DE');
  await synth(DE,'fr-FR','xl_de_langFR.mp3','DE text + voiceLocale fr-FR');
  console.log('\nIf bytes differ per text, voiceLocale IS applied. Listen: xl_en_langEN vs xl_en_langDE.');
})().catch(e=>{console.error(e);process.exit(1)});
