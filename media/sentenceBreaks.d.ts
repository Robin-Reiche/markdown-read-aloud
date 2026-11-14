// Types for media/sentenceBreaks.js, which the webview loads as a plain script.
export interface SentencePiece {
  segment: string;
  index: number;
}
export function joinFalseBreaks(segments: readonly SentencePiece[]): SentencePiece[];
