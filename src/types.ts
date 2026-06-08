export type Gender = 'female' | 'male';

export type BlockKind = 'heading' | 'para' | 'listItem' | 'quote' | 'code' | 'table';

/** A speakable block of the document with its source character range. */
export interface Block {
  kind: BlockKind;
  text: string;
  /** 0-based character offsets into the original document text. */
  startOffset: number;
  endOffset: number;
  headingLevel?: number;
  /** per-block detected locale (for per-paragraph language switching) */
  locale?: string;
}

/** One unit of synthesis/playback (usually a sentence). Carries its block's range. */
export interface Chunk {
  index: number;
  text: string;
  locale: string;
  kind: BlockKind;
  blockStartOffset: number;
  blockEndOffset: number;
  headingLevel?: number;
}

export interface OutlineItem {
  label: string;
  level: number;
  chunkIndex: number;
}

/** Everything the player needs to read a document. */
export interface ReadJob {
  docUri: string;
  title: string;
  /** dominant document locale */
  locale: string;
  /** distinct locales present across chunks (for per-paragraph mode) */
  languages: string[];
  chunks: Chunk[];
  outline: OutlineItem[];
}

/** A byte-producing TTS engine that runs in the extension host. */
export interface TtsEngine {
  readonly id: string;
  readonly mime: string;
  /**
   * Synthesize text with a specific voice and language to an audio buffer.
   * Atomic per call (voice switch + synthesis), so it is safe under the
   * concurrent prefetch requests the player makes.
   */
  synth(text: string, voice: string, locale: string): Promise<Buffer>;
  /** Optionally pre-connect a voice/locale to cut first-play latency. */
  warm(voice: string, locale: string): Promise<void>;
  dispose(): void;
}
