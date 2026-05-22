/**
 * Minimal dependency-free PDF writer.
 *
 * Generates a multi-page PDF from a list of styled lines using the built-in
 * Helvetica / Helvetica-Bold fonts (two of the 14 standard PDF fonts — no
 * font embedding required). Enough for clean text documents: playbooks,
 * reports, exports.
 *
 * Public API:
 *   renderPdf(blocks) → Buffer
 *     blocks: array of { kind, text }
 *       kind ∈ 'title' | 'h2' | 'body' | 'bullet' | 'rule' | 'spacer' | 'kv'
 *
 * Why hand-rolled: the VPS has no wkhtmltopdf/chromium and the project keeps
 * a zero-npm-dependency policy. PDF's text format is simple enough to emit
 * directly.
 */

const PAGE_W = 612;   // US Letter, 72 dpi
const PAGE_H = 792;
const MARGIN = 56;
const CONTENT_W = PAGE_W - 2 * MARGIN;

// Approximate Helvetica glyph width as a fraction of font size. Good enough
// for word-wrap; exact AFM metrics aren't worth the bulk here.
const CHAR_W = 0.52;

const STYLES = {
  title:  { size: 22, font: 'F2', lead: 30, gap: 6,  color: '0.10 0.10 0.12' },
  h2:     { size: 13, font: 'F2', lead: 19, gap: 10, color: '0.15 0.25 0.45' },
  body:   { size: 10.5, font: 'F1', lead: 15, gap: 2, color: '0.15 0.15 0.15' },
  bullet: { size: 10.5, font: 'F1', lead: 15, gap: 2, color: '0.15 0.15 0.15' },
  kv:     { size: 10.5, font: 'F1', lead: 15, gap: 2, color: '0.15 0.15 0.15' },
  small:  { size: 8.5, font: 'F1', lead: 12, gap: 2, color: '0.45 0.45 0.45' },
};

// Map common typographic Unicode to their WinAnsiEncoding byte values so
// they render instead of getting stripped.
const WINANSI_MAP = {
  '•': '\x95', // bullet
  '‘': '\x91', '’': '\x92', // single quotes
  '“': '\x93', '”': '\x94', // double quotes
  '–': '\x96', '—': '\x97', // en/em dash
  '…': '\x85', // ellipsis
  '·': '\xB7', // middle dot
  '→': '->',   // right arrow (no WinAnsi glyph)
};

function escapePdfText(s) {
  return String(s)
    .replace(/[•‘’“”–—…·→]/g, (c) => WINANSI_MAP[c])
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // Keep printable ASCII + WinAnsi high range; strip everything else.
    .replace(/[^\x20-\x7E\x80-\xFF]/g, '');
}

function wrap(text, maxWidth, size) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const fits = (s) => s.length * CHAR_W * size <= maxWidth;
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w;
    if (fits(candidate) || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * Render blocks to a PDF Buffer.
 * @param {Array<{kind:string,text?:string}>} blocks
 */
export function renderPdf(blocks) {
  // ── Layout pass: turn blocks into positioned text ops across pages ──
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => { pages.push(ops); ops = []; y = PAGE_H - MARGIN; };

  for (const block of blocks) {
    const kind = block.kind || 'body';
    if (kind === 'spacer') { y -= 10; continue; }
    if (kind === 'rule') {
      if (y < MARGIN + 20) newPage();
      ops.push({ type: 'rule', y: y - 4 });
      y -= 12;
      continue;
    }
    const style = STYLES[kind] || STYLES.body;
    const indent = (kind === 'bullet') ? 14 : 0;
    const prefix = (kind === 'bullet') ? '•  ' : '';
    const usableW = CONTENT_W - indent - (prefix.length * CHAR_W * style.size);
    const wrapped = wrap(block.text || '', usableW, style.size);

    y -= style.gap;
    for (let i = 0; i < wrapped.length; i++) {
      if (y < MARGIN + style.lead) newPage();
      const text = (i === 0 ? prefix : '   ') + wrapped[i];
      ops.push({
        type: 'text', x: MARGIN + indent, y,
        text, size: style.size, font: style.font, color: style.color,
      });
      y -= style.lead;
    }
  }
  pages.push(ops);

  // ── Emit pass: build the PDF object graph ──
  const objects = [];
  const addObj = (body) => { objects.push(body); return objects.length; };

  // Reserve: 1=Catalog, 2=Pages. Fonts + per-page (Page + Contents) follow.
  const catalogId = 1;
  const pagesId = 2;
  objects.push(null, null); // placeholders

  const fontRegular = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold    = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageIds = [];
  for (const pageOps of pages) {
    // Build the content stream
    let stream = '';
    for (const op of pageOps) {
      if (op.type === 'rule') {
        stream += `0.80 0.80 0.84 RG 0.7 w ${MARGIN} ${op.y.toFixed(1)} m ${(PAGE_W - MARGIN)} ${op.y.toFixed(1)} l S\n`;
      } else if (op.type === 'text') {
        stream += `BT /${op.font} ${op.size} Tf ${op.color} rg `;
        stream += `${op.x.toFixed(1)} ${op.y.toFixed(1)} Td (${escapePdfText(op.text)}) Tj ET\n`;
      }
    }
    const contentId = addObj(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  // Fill in the reserved Catalog + Pages objects
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // ── Serialize with xref table ──
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Parse a markdown-ish playbook string into PDF blocks.
 * Supports: # title, ## heading, - bullet, 1. numbered, --- rule, plain text.
 */
export function markdownToBlocks(md) {
  const blocks = [];
  const lines = String(md).split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) { blocks.push({ kind: 'spacer' }); continue; }
    if (trimmed === '---') { blocks.push({ kind: 'rule' }); continue; }
    if (trimmed.startsWith('# ')) { blocks.push({ kind: 'title', text: strip(trimmed.slice(2)) }); continue; }
    if (trimmed.startsWith('## ')) { blocks.push({ kind: 'h2', text: strip(trimmed.slice(3)) }); continue; }
    if (trimmed.startsWith('### ')) { blocks.push({ kind: 'h2', text: strip(trimmed.slice(4)) }); continue; }
    if (/^[-*]\s+/.test(trimmed)) { blocks.push({ kind: 'bullet', text: strip(trimmed.replace(/^[-*]\s+/, '')) }); continue; }
    if (/^\d+\.\s+/.test(trimmed)) { blocks.push({ kind: 'bullet', text: strip(trimmed.replace(/^\d+\.\s+/, '')) }); continue; }
    blocks.push({ kind: 'body', text: strip(trimmed) });
  }
  return blocks;
}

// Strip markdown emphasis markers — the PDF renders plain text.
function strip(s) {
  return String(s).replace(/\*\*/g, '').replace(/`/g, '').replace(/\*/g, '');
}
