import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import type { Block, BlockKind } from '../types';
import { normalizeForSpeech } from './normalize';

export interface ProcessOptions {
  codeBlocks: 'skip' | 'announce' | 'read';
  tables: 'skip' | 'read';
  announceHeadings: boolean;
  /** base language (e.g. "de") for localized announcements */
  lang: string;
}

export interface ProcessResult {
  blocks: Block[];
  /** language hinted by frontmatter `lang:`/`language:`, if any */
  frontmatterLang?: string;
}

const CODE_PHRASE: Record<string, string> = {
  en: 'Code block.', de: 'Codeblock.', fr: 'Bloc de code.', es: 'Bloque de código.',
  it: 'Blocco di codice.', pt: 'Bloco de código.', nl: 'Codeblok.', ru: 'Блок кода.',
  ja: 'コードブロック。', zh: '代码块。', ko: '코드 블록.', pl: 'Blok kodu.',
};
const HEADING_PHRASE: Record<string, string> = {
  en: 'Heading.', de: 'Überschrift.', fr: 'Titre.', es: 'Título.', it: 'Titolo.',
  pt: 'Título.', nl: 'Kop.', ru: 'Заголовок.', ja: '見出し。', zh: '标题。', ko: '제목.',
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml', 'toml']);

export function processMarkdown(source: string, opts: ProcessOptions): ProcessResult {
  const tree: any = processor.parse(source);
  const blocks: Block[] = [];
  let frontmatterLang: string | undefined;

  const codePhrase = CODE_PHRASE[opts.lang] || CODE_PHRASE.en;
  const headingPhrase = HEADING_PHRASE[opts.lang] || HEADING_PHRASE.en;

  const pushBlock = (kind: BlockKind, text: string, node: any, headingLevel?: number) => {
    const clean = normalizeForSpeech(text);
    if (!clean) return;
    const pos = node.position;
    blocks.push({
      kind,
      text: clean,
      startOffset: pos?.start?.offset ?? 0,
      endOffset: pos?.end?.offset ?? 0,
      headingLevel,
    });
  };

  const walk = (nodes: any[]) => {
    for (const node of nodes) {
      switch (node.type) {
        case 'yaml':
        case 'toml': {
          const m = String(node.value || '').match(/^(?:lang|language)\s*[:=]\s*["']?([\w-]+)/im);
          if (m) frontmatterLang = m[1];
          break; // never spoken
        }
        case 'heading': {
          const txt = inlineText(node);
          pushBlock('heading', opts.announceHeadings ? `${headingPhrase} ${txt}` : txt, node, node.depth);
          break;
        }
        case 'paragraph':
          pushBlock('para', inlineText(node), node);
          break;
        case 'blockquote':
          walk(node.children || []); // inner paragraphs become their own blocks
          break;
        case 'list':
          walk(node.children || []); // list items
          break;
        case 'listItem': {
          const ownParts: string[] = [];
          const nested: any[] = [];
          for (const child of node.children || []) {
            if (child.type === 'list') nested.push(child);
            else ownParts.push(inlineText(child));
          }
          pushBlock('listItem', ownParts.join(' '), node);
          if (nested.length) walk(nested);
          break;
        }
        case 'code':
        case 'math': {
          if (opts.codeBlocks === 'read' && node.type === 'code') {
            pushBlock('code', String(node.value || ''), node);
          } else if (opts.codeBlocks !== 'skip') {
            pushBlock('code', codePhrase, node);
          }
          break;
        }
        case 'table': {
          if (opts.tables === 'read') {
            const rows = (node.children || []).map((row: any) =>
              (row.children || []).map((cell: any) => inlineText(cell)).filter(Boolean).join(', ')
            );
            pushBlock('table', rows.filter(Boolean).join('. '), node);
          }
          break;
        }
        case 'html': {
          const stripped = String(node.value || '').replace(/<[^>]+>/g, ' ');
          if (stripped.trim()) pushBlock('para', stripped, node);
          break;
        }
        case 'thematicBreak':
        case 'definition':
        case 'footnoteDefinition':
          break;
        default:
          if (Array.isArray(node.children)) walk(node.children);
      }
    }
  };

  walk(tree.children || []);
  return { blocks, frontmatterLang };
}

/** Recursively collect speakable text from inline (and some block) children. */
function inlineText(node: any): string {
  if (!node) return '';
  switch (node.type) {
    case 'text':
      return String(node.value || '');
    case 'inlineCode':
      return String(node.value || '');
    case 'break':
      return ' ';
    case 'image':
    case 'imageReference':
      return node.alt ? String(node.alt) : '';
    case 'html':
      return String(node.value || '').replace(/<[^>]+>/g, ' ');
    case 'footnoteReference':
      return '';
    case 'inlineMath':
      return '';
    default:
      if (Array.isArray(node.children)) {
        return node.children.map(inlineText).join('');
      }
      return '';
  }
}
