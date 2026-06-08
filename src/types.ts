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
  locale: string;
  chunks: Chunk[];
  outline: OutlineItem[];
}

/** A byte-producing TTS engine that runs in the extension host. */
export interface TtsEngine {
  readonly id: string;
  readonly mime: string;
  /** Set (and connect) the active voice. Cheap no-op if unchanged. */
  setVoice(voiceShortName: string): Promise<void>;
  /** Synthesize text to an audio buffer in `mime` format. */
  synth(text: string): Promise<Buffer>;
  dispose(): void;
}
