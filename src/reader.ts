import * as vscode from 'vscode';
import * as path from 'path';
import { processMarkdown } from './markdown/processor';
import { chunkBlocks } from './segmenter';
import { detectLocale } from './languageDetector';
import { localeForLang } from './voices';
import type { OutlineItem, ReadJob } from './types';

export interface BuildOptions {
  /** Source text to read (whole document or a selection). */
  source: string;
  /** Offset of `source` within the document (0 for whole document). */
  baseOffset: number;
  docUri: vscode.Uri;
  title: string;
}

export function buildJob(opts: BuildOptions): ReadJob | undefined {
  const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
  const fallbackLocale = cfg.get<string>('fallbackLanguage', 'en-US');
  const autoDetect = cfg.get<boolean>('autoDetectLanguage', true);

  // 1) provisional locale (for localized announcements + sentence segmentation)
  let locale = fallbackLocale;
  if (autoDetect) {
    locale = detectLocale(opts.source, fallbackLocale).locale;
  }

  // 2) process markdown into speakable blocks
  const res = processMarkdown(opts.source, {
    codeBlocks: cfg.get('codeBlocks', 'announce') as 'skip' | 'announce' | 'read',
    tables: cfg.get('tables', 'skip') as 'skip' | 'read',
    announceHeadings: cfg.get('announceHeadings', false),
    lang: locale.split('-')[0],
  });

  // 3) frontmatter language wins over detection
  if (res.frontmatterLang) {
    const base = res.frontmatterLang.split('-')[0];
    locale = localeForLang(base) || res.frontmatterLang || locale;
  }

  if (!res.blocks.length) return undefined;

  // 4) shift offsets to absolute document positions and chunk into sentences
  if (opts.baseOffset) {
    for (const b of res.blocks) {
      b.startOffset += opts.baseOffset;
      b.endOffset += opts.baseOffset;
    }
  }
  const chunks = chunkBlocks(res.blocks, locale);
  if (!chunks.length) return undefined;

  const outline: OutlineItem[] = chunks
    .filter((c) => c.kind === 'heading')
    .map((c) => ({
      label: c.text.replace(/\s+/g, ' ').slice(0, 70),
      level: c.headingLevel || 1,
      chunkIndex: c.index,
    }));

  return {
    docUri: opts.docUri.toString(),
    title: opts.title,
    locale,
    chunks,
    outline,
  };
}

/** Index of the first chunk at/after a document character offset. */
export function chunkIndexForOffset(job: ReadJob, offset: number): number {
  for (const c of job.chunks) {
    if (c.blockEndOffset >= offset) return c.index;
  }
  return 0;
}

export function titleFor(uri: vscode.Uri): string {
  return path.basename(uri.fsPath) || 'Document';
}
