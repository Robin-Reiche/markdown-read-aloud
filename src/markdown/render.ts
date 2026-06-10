import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';

/**
 * Render Markdown to a clean, sanitized HTML string for the reader webview.
 *
 * The webview is the source of truth for sentence segmentation: it wraps each
 * sentence in this HTML in a `<span data-seg>` (via Intl.Segmenter, matching
 * src/segmenter.ts) and requests audio per sentence. So this pass only needs to
 * produce safe, well-formed display HTML — no speech text, no ids.
 *
 * Block elements carry `data-line` (1-based source line) so the webview can
 * offer "Alt+Click → open this sentence in the editor".
 *
 * rehype-sanitize (GitHub schema) is the security boundary: the document is
 * untrusted, markdown-derived content rendered into a scripted webview, so we
 * strip scripts/handlers/styles and keep only standard prose elements.
 */
const LINED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'table', 'td', 'th']);

function rehypeSourceLines() {
  return (tree: any) => {
    visit(tree, 'element', (node: any) => {
      const line = node.position?.start?.line;
      if (line && LINED.has(node.tagName)) {
        node.properties = node.properties || {};
        node.properties.dataLine = String(line);
      }
    });
  };
}

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataLine'],
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml', 'toml']) // parsed so it is NOT rendered as text
  .use(remarkRehype)
  .use(rehypeSourceLines)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

export function renderMarkdownHtml(source: string): string {
  return String(processor.processSync(source));
}
