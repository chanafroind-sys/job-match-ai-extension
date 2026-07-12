// Pure JS DOCX builder — no external libraries, works in browser/extension context

// ── Shared layout profiles ──────────────────────────────────────────────────────
// Single source of truth for font size / margins / line spacing, consumed by BOTH the DOCX
// path in this file and the PDF/print path in popup.js (buildCvPrintHtml), so the two export
// formats can't silently disagree about what "fits one page" means. `normal` is byte-identical
// to the values this file used before profiles existed. `tight`/`compact` are the adaptive
// fallback tiers estimateCvOverflow()/pickFittingProfile() step down into when content doesn't
// fit at `normal` — real code doing the shrinking, instead of relying on the LLM word budget
// alone.
const LAYOUT_PROFILES = {
  normal:  { name: 'normal',  bodySize: 21, fontPt: 10.5, marginTwips: 720, marginCm: 1.27, lineSpacing: 252, bulletLineSpacing: 240 },
  tight:   { name: 'tight',   bodySize: 20, fontPt: 10,   marginTwips: 620, marginCm: 1.09, lineSpacing: 236, bulletLineSpacing: 224 },
  compact: { name: 'compact', bodySize: 19, fontPt: 9.5,  marginTwips: 560, marginCm: 0.99, lineSpacing: 220, bulletLineSpacing: 210 },
};

// Set by buildDocx()/buildCvPrintHtml() right before rendering; read as the default body font
// size/line-spacing by the low-level paragraph builders below so the whole document renders
// under one consistent profile without threading a parameter through every function.
let _activeProfile = LAYOUT_PROFILES.normal;

// ── Page-fit estimation (pure, DOM-free — no Blob/document dependency, so it's testable in
// plain Node in addition to the extension) ──────────────────────────────────────────────────
const _A4_HEIGHT_PT = 841.89; // 29.7cm
const _A4_WIDTH_PT  = 595.28; // 21cm

function _estimateLinesForText(text, charsPerLine, indentChars = 0) {
  const usable = Math.max(10, charsPerLine - indentChars);
  return text.split('\n').filter(l => l.trim()).reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.trim().length / usable)), 0);
}

function estimateCvOverflow(sections, isRtl, profile = _activeProfile) {
  const marginPt    = profile.marginTwips / 20; // 1 twip = 1/20 pt
  const lineHeightPt = profile.fontPt * 1.25;    // rough single-line height incl. leading
  const maxLines     = Math.floor((_A4_HEIGHT_PT - marginPt * 2) / lineHeightPt);

  const usableWidthPt = _A4_WIDTH_PT - marginPt * 2;
  const avgGlyphWidthPt = profile.fontPt * 0.5;  // Calibri average glyph width ≈ 0.5em
  const charsPerLine = Math.max(20, Math.floor(usableWidthPt / avgGlyphWidthPt));

  let lines = 0;
  if (sections['[NAME]']) lines += 1;
  if (sections['[HEADLINE]']) lines += 1;
  if (sections['[CONTACT]']) {
    const ctLines = (sections['[CONTACT]'].split('\n').filter(l => l.trim()) || []).length;
    lines += ctLines > 2 ? 2 : 1;
  }
  lines += 1; // spacing buffer below header block

  const addSection = (marker, isExperience) => {
    const content = sections[marker];
    if (!content) return;
    lines += 1; // section heading line
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const isBullet = isExperience && !line.startsWith('**') &&
        (line.startsWith('$ ') || /^[•\-–—]\s/.test(line) || line.startsWith('* '));
      lines += _estimateLinesForText(line, charsPerLine, isBullet ? 4 : 0);
    }
  };
  addSection('[PROFILE]', false);
  addSection('[EXPERIENCE]', true);
  addSection('[EDUCATION]', true);
  addSection('[SKILLS]', false);
  addSection('[LANGUAGES]', false);

  return { estimatedLines: lines, maxLines, overflow: lines > maxLines, ratio: lines / maxLines };
}

// Tries normal → tight → compact, returns the first tier that fits; falls back to compact
// (the readable floor) if even that overflows — never silently renders unmeasured.
function pickFittingProfile(sections, isRtl) {
  const order = ['normal', 'tight', 'compact'];
  let last = null;
  for (const key of order) {
    const profile = LAYOUT_PROFILES[key];
    const estimate = estimateCvOverflow(sections, isRtl, profile);
    last = { profile, estimate };
    if (!estimate.overflow) return last;
  }
  return last; // compact, even if still over — smallest readable tier is the floor
}

function parseCVSections(cvText) {
  const markers = ['[NAME]', '[HEADLINE]', '[CONTACT]', '[PROFILE]', '[EXPERIENCE]', '[EDUCATION]', '[SKILLS]', '[LANGUAGES]'];
  const sections = {};
  let currentMarker = null;
  let currentLines = [];

  const normalized = cvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  // Normalize a raw line to strip # / ## / ** so we can detect markers regardless of Claude's formatting
  function stripDecoration(line) {
    return line.trim()
      .replace(/^#{1,3}\s*/, '')   // strip leading # ## ###
      .replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '')  // strip ** or *
      .trim();
  }

  for (const line of lines) {
    const clean = stripDecoration(line);
    const foundMarker = markers.find(m => clean === m || clean.startsWith(m + ' '));
    if (foundMarker) {
      if (currentMarker) sections[currentMarker] = currentLines.join('\n').trim();
      currentMarker = foundMarker;
      currentLines = [];
    } else if (currentMarker) {
      // Skip lines that are just the marker text repeated (Claude sometimes echoes it)
      const isMarkerEcho = markers.some(m => clean === m || stripDecoration(line) === m);
      if (!isMarkerEcho) currentLines.push(line);
    }
  }
  if (currentMarker) sections[currentMarker] = currentLines.join('\n').trim();

  const hasContent = Object.values(sections).some(v => v.length > 0);
  if (!hasContent) sections['[PROFILE]'] = normalized.trim();

  return sections;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function makeRun(text, opts = {}) {
  const { bold = false, size = _activeProfile.bodySize, color = '1f2937', italic = false } = opts;
  const rPr = `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function makeParagraph(runs, opts = {}) {
  const { align = 'left', isRtl = false, spacingAfter = 60, spacingLine = _activeProfile.lineSpacing } = opts;
  const pPr = `<w:pPr><w:jc w:val="${align}"/>${isRtl ? '<w:bidi/>' : ''}<w:spacing w:after="${spacingAfter}" w:line="${spacingLine}" w:lineRule="auto"/></w:pPr>`;
  return `<w:p>${pPr}${runs}</w:p>`;
}

function makeSectionHeading(title, isRtl) {
  const align = isRtl ? 'right' : 'left';
  const run = makeRun(title.toUpperCase(), { bold: true, size: 22, color: '7c3aed' });
  const border = `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="7c3aed"/></w:pBdr>`;
  const pPr = `<w:pPr><w:jc w:val="${align}"/>${isRtl ? '<w:bidi/>' : ''}<w:spacing w:before="100" w:after="40"/>${border}</w:pPr>`;
  return `<w:p>${pPr}${run}</w:p>`;
}

// === Hyperlink relationship registry (reset per build) ===
let _hyperlinkRels = [];

function _resetRels() { _hyperlinkRels = []; }

function _addRel(url) {
  const ex = _hyperlinkRels.find(r => r.url === url);
  if (ex) return ex.rId;
  const rId = `rHyp${_hyperlinkRels.length}`;
  _hyperlinkRels.push({ rId, url });
  return rId;
}

function makeHyperlinkXml(displayText, url, opts = {}) {
  const rId = _addRel(url);
  const sz = opts.size || 21;
  const rPr = `<w:rPr><w:rStyle w:val="Hyperlink"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr>`;
  return `<w:hyperlink r:id="${rId}" w:history="1"><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(displayText)}</w:t></w:r></w:hyperlink>`;
}

// Parse a line that may contain **bold** and [LINK:display|url] into DOCX runs
function makeRichRuns(text, baseOpts = {}) {
  const tokens = [];
  const re = /(\[LINK:[^\|]*\|[^\]]*\]|\*\*[^*]+\*\*)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ t: 'text', v: text.slice(last, m.index) });
    tokens.push({ t: 'special', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ t: 'text', v: text.slice(last) });
  if (!tokens.length) tokens.push({ t: 'text', v: text });

  return tokens.map(tok => {
    if (!tok.v) return '';
    if (tok.t === 'text') return makeRun(tok.v, baseOpts);
    if (tok.v.startsWith('[LINK:')) {
      const inner = tok.v.slice(6, -1);
      const sep = inner.indexOf('|');
      return makeHyperlinkXml(inner.slice(0, sep), inner.slice(sep + 1), baseOpts);
    }
    if (tok.v.startsWith('**')) return makeRun(tok.v.slice(2, -2), { ...baseOpts, bold: true });
    return makeRun(tok.v, baseOpts);
  }).join('');
}

function makeBulletParagraph(text, isRtl) {
  const align = isRtl ? 'right' : 'left';
  // RTL: indent from right with hanging so bullet hangs at the right margin.
  // The hanging value (180 twips ≈ 0.25 cm) keeps the bullet flush-right while
  // wrapped lines indent inward — matching standard Word RTL bullet layout.
  const indent = isRtl
    ? `<w:ind w:right="360" w:hanging="180"/>`
    : `<w:ind w:left="360" w:hanging="180"/>`;
  const pPr = `<w:pPr><w:jc w:val="${align}"/>${isRtl ? '<w:bidi/>' : ''}${indent}<w:spacing w:after="30" w:line="${_activeProfile.bulletLineSpacing}" w:lineRule="auto"/></w:pPr>`;
  const bulletRun = makeRun('• ', { color: '1f2937' });
  const contentRuns = makeRichRuns(text, { color: '1f2937' });
  // In RTL paragraphs Word renders runs right-to-left, so bullet run (first in XML)
  // appears on the right side — correct for Hebrew layout.
  return `<w:p>${pPr}${bulletRun}${contentRuns}</w:p>`;
}

function textToDocxParagraphs(text, isRtl, isBullet = false) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  return lines.map(line => {
    // Detect bullet lines — but ignore lines that start with ** (bold, not bullet)
    const isBulletLine = isBullet ||
      line.startsWith('•') ||
      line.startsWith('- ') ||
      (line.startsWith('* ') && !line.startsWith('**'));
    if (isBulletLine) {
      const clean = line.replace(/^[•\-]\s*|^\*\s+/, '');
      return makeBulletParagraph(clean, isRtl);
    }
    const align = isRtl ? 'right' : 'left';
    const runs = makeRichRuns(line, { color: '1f2937' });
    return makeParagraph(runs, { align, isRtl, spacingAfter: 60 });
  }).join('');
}

function buildExperienceXml(text, isRtl) {
  const align = isRtl ? 'right' : 'left';
  const bidi = isRtl ? '<w:bidi/>' : '';
  const lines = text.split('\n');
  let xml = '';
  let firstEntry = true;
  let inEntry = false; // true after seeing the header line of a job block

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      inEntry = false; // blank line signals end of current job block
      continue;
    }

    // Strip outer **...** that Claude sometimes wraps around an entire bullet line
    // e.g. "**• Built FastAPI backend**" → "• Built FastAPI backend"
    const stripped = line.replace(/^\*\*(.+)\*\*$/, '$1').trim();

    // Bullet detection — $ is the canonical marker; also accept •, -, –, —, * as fallback
    const isBullet = stripped.startsWith('$ ') || /^[•\-–—]\s/.test(stripped) ||
      (stripped.startsWith('* ') && !stripped.startsWith('**'));

    // Job-header heuristic: a non-bullet line that contains " | " or a 4-digit year
    // is almost certainly a new entry header, even if no blank line preceded it.
    const isJobHeader = !isBullet && (/\s\|\s/.test(stripped) || /\b(19|20)\d{2}\b/.test(stripped));

    if (isBullet) {
      inEntry = true;
      const clean = stripped.replace(/^\$\s+|^[•\-–—]\s+|^\*\s+/, '');
      xml += makeBulletParagraph(clean, isRtl);
    } else if (!inEntry || isJobHeader) {
      // Job entry header — reset state so next non-bullet/non-header becomes description
      const spacingBefore = firstEntry ? 0 : 160;
      firstEntry = false;
      inEntry = true;
      const runs = makeRichRuns(line, { color: '1f2937' });
      const pPr = `<w:pPr><w:jc w:val="${align}"/>${bidi}<w:spacing w:before="${spacingBefore}" w:after="20" w:line="${_activeProfile.bulletLineSpacing}" w:lineRule="auto"/></w:pPr>`;
      xml += `<w:p>${pPr}${runs}</w:p>`;
    } else {
      // Description text directly under a job header — indented
      const indent = isRtl ? `<w:ind w:right="360"/>` : `<w:ind w:left="360"/>`;
      const runs = makeRichRuns(line, { color: '1f2937' });
      const pPr = `<w:pPr><w:jc w:val="${align}"/>${bidi}${indent}<w:spacing w:before="0" w:after="20" w:line="${_activeProfile.bulletLineSpacing}" w:lineRule="auto"/></w:pPr>`;
      xml += `<w:p>${pPr}${runs}</w:p>`;
    }
  }

  return xml;
}

function buildEducationXml(text, isRtl) {
  const align = isRtl ? 'right' : 'left';
  const bidi = isRtl ? '<w:bidi/>' : '';
  const lines = text.split('\n');
  let xml = '';
  let firstEntry = true;
  let inEntry = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      inEntry = false;
      continue;
    }

    const stripped = line.replace(/^\*\*(.+)\*\*$/, '$1').trim();

    const isBullet = /^[•\-–—]\s/.test(stripped) ||
      (stripped.startsWith('* ') && !stripped.startsWith('**'));
    const isEntryHeader = !isBullet && (/\s\|\s/.test(stripped) || /\b(19|20)\d{2}\b/.test(stripped));

    if (isBullet) {
      inEntry = true;
      const clean = stripped.replace(/^\$\s+|^[•\-–—]\s+|^\*\s+/, '');
      xml += makeBulletParagraph(clean, isRtl);
    } else if (!inEntry || isEntryHeader) {
      // Institution / degree / year header — no indent
      const spacingBefore = firstEntry ? 0 : 120;
      firstEntry = false;
      inEntry = true;
      const runs = makeRichRuns(line, { color: '1f2937' });
      const pPr = `<w:pPr><w:jc w:val="${align}"/>${bidi}<w:spacing w:before="${spacingBefore}" w:after="20" w:line="${_activeProfile.bulletLineSpacing}" w:lineRule="auto"/></w:pPr>`;
      xml += `<w:p>${pPr}${runs}</w:p>`;
    } else {
      // Description under institution header — indented
      const indent = isRtl ? `<w:ind w:right="360"/>` : `<w:ind w:left="360"/>`;
      const runs = makeRichRuns(line, { color: '1f2937' });
      const pPr = `<w:pPr><w:jc w:val="${align}"/>${bidi}${indent}<w:spacing w:before="0" w:after="20" w:line="${_activeProfile.bulletLineSpacing}" w:lineRule="auto"/></w:pPr>`;
      xml += `<w:p>${pPr}${runs}</w:p>`;
    }
  }

  return xml;
}

function buildDocumentXml(sections, isRtl) {
  const align = isRtl ? 'right' : 'left';
  const bidi = isRtl ? '<w:bidi/>' : '';
  let body = '';

  // Name
  if (sections['[NAME]']) {
    const run = makeRun(sections['[NAME]'], { bold: true, size: 40, color: '1a1a2e' });
    body += makeParagraph(run, { align: 'center', isRtl, spacingAfter: 30 });
  }

  // Headline
  if (sections['[HEADLINE]']) {
    const run = makeRun(sections['[HEADLINE]'], { size: 24, color: '7c3aed' });
    body += makeParagraph(run, { align: 'center', isRtl, spacingAfter: 30 });
  }

  // Contact — use makeRichRuns so [LINK:...] tokens become real hyperlinks
  if (sections['[CONTACT]']) {
    const lines = sections['[CONTACT]'].split('\n').filter(l => l.trim());
    const sepRun = makeRun('  |  ', { size: 20, color: '8b949e' });
    const contactRuns = lines.map((l, i) => (i > 0 ? sepRun : '') + makeRichRuns(l, { size: 20, color: '8b949e' })).join('');
    body += makeParagraph(contactRuns, { align: 'center', isRtl, spacingAfter: 80 });
  }

  const labels = isRtl
    ? { profile: 'פרופיל', experience: 'ניסיון', education: 'השכלה', skills: 'כישורים', languages: 'שפות' }
    : { profile: 'Profile', experience: 'Experience', education: 'Education', skills: 'Skills', languages: 'Languages' };

  // Profile
  if (sections['[PROFILE]']) {
    body += makeSectionHeading(labels.profile, isRtl);
    body += textToDocxParagraphs(sections['[PROFILE]'], isRtl);
  }

  // Experience
  if (sections['[EXPERIENCE]']) {
    body += makeSectionHeading(labels.experience, isRtl);
    body += buildExperienceXml(sections['[EXPERIENCE]'], isRtl);
  }

  // Education
  if (sections['[EDUCATION]']) {
    body += makeSectionHeading(labels.education, isRtl);
    body += buildEducationXml(sections['[EDUCATION]'], isRtl);
  }

  // Skills
  if (sections['[SKILLS]']) {
    body += makeSectionHeading(labels.skills, isRtl);
    body += textToDocxParagraphs(sections['[SKILLS]'], isRtl);
  }

  // Languages (always last)
  if (sections['[LANGUAGES]']) {
    body += makeSectionHeading(labels.languages, isRtl);
    body += textToDocxParagraphs(sections['[LANGUAGES]'], isRtl);
  }

  // Page size A4, margins from the active layout profile (narrow, to help fit one page).
  const m = _activeProfile.marginTwips;
  const sectPr = `<w:sectPr>${bidi}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${m}" w:right="${m}" w:bottom="${m}" w:left="${m}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"
  xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
  xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml"
  xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash"
  xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14">
  <w:body>${body}${sectPr}</w:body>
</w:document>`;
}

// CRC32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function strToBytes(str) {
  return new TextEncoder().encode(str);
}

function uint16LE(n) {
  return [n & 0xFF, (n >> 8) & 0xFF];
}

function uint32LE(n) {
  return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF];
}

function buildZip(files) {
  // files: [{name, data: Uint8Array}]
  const entries = [];
  let offset = 0;
  const parts = [];

  for (const file of files) {
    const nameBytes = strToBytes(file.name);
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    const localHeader = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, // signature
      0x14, 0x00,             // version needed
      0x00, 0x00,             // flags
      0x00, 0x00,             // compression: stored
      0x00, 0x00,             // mod time
      0x00, 0x00,             // mod date
      ...uint32LE(crc),
      ...uint32LE(size),
      ...uint32LE(size),
      ...uint16LE(nameBytes.length),
      0x00, 0x00,             // extra field length
      ...nameBytes
    ]);

    entries.push({ nameBytes, crc, size, offset });
    parts.push(localHeader, data);
    offset += localHeader.length + data.length;
  }

  // Central directory
  const centralParts = [];
  for (const e of entries) {
    const cd = new Uint8Array([
      0x50, 0x4B, 0x01, 0x02, // signature
      0x14, 0x00,             // version made by
      0x14, 0x00,             // version needed
      0x00, 0x00,             // flags
      0x00, 0x00,             // compression
      0x00, 0x00,             // mod time
      0x00, 0x00,             // mod date
      ...uint32LE(e.crc),
      ...uint32LE(e.size),
      ...uint32LE(e.size),
      ...uint16LE(e.nameBytes.length),
      0x00, 0x00,             // extra field length
      0x00, 0x00,             // comment length
      0x00, 0x00,             // disk number start
      0x00, 0x00,             // internal attrs
      0x00, 0x00, 0x00, 0x00, // external attrs
      ...uint32LE(e.offset),
      ...e.nameBytes
    ]);
    centralParts.push(cd);
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, // signature
    0x00, 0x00,             // disk number
    0x00, 0x00,             // disk with central dir
    ...uint16LE(entries.length),
    ...uint16LE(entries.length),
    ...uint32LE(centralSize),
    ...uint32LE(offset),
    0x00, 0x00              // comment length
  ]);

  const allParts = [...parts, ...centralParts, eocd];
  const totalSize = allParts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of allParts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

const RELATIONSHIPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// WORD_RELS_XML is built dynamically in buildDocx to include hyperlinks

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;

const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="708"/>
  <w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" w:docDefaults="1">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial Unicode MS" w:eastAsia="Arial"/>
        <w:sz w:val="21"/>
        <w:szCs w:val="21"/>
        <w:lang w:val="he-IL" w:eastAsia="he-IL" w:bidi="he-IL"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="60" w:line="252" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="60" w:line="252" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="character" w:styleId="Hyperlink">
    <w:name w:val="Hyperlink"/>
    <w:rPr><w:color w:val="2563eb"/><w:u w:val="single"/></w:rPr>
  </w:style>
</w:styles>`;

function buildDocx(cvText, isRtl = false, profile = null) {
  _resetRels(); // clear hyperlink registry for this build
  const sections = parseCVSections(cvText);
  // Adaptive layout: measure first, only step down to a tighter profile if the normal one
  // would actually overflow one page — never shrinks content that already fits.
  const chosen = profile || pickFittingProfile(sections, isRtl).profile;
  _activeProfile = chosen;
  const documentXml = buildDocumentXml(sections, isRtl);

  // Build dynamic rels with any hyperlinks found during document construction
  const hyperlinkEntries = _hyperlinkRels.map(r =>
    `  <Relationship Id="${r.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(r.url)}" TargetMode="External"/>`
  ).join('\n');
  const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${hyperlinkEntries}
</Relationships>`;

  const files = [
    { name: '[Content_Types].xml', data: strToBytes(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: strToBytes(RELATIONSHIPS_XML) },
    { name: 'word/document.xml', data: strToBytes(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: strToBytes(wordRelsXml) },
    { name: 'word/styles.xml', data: strToBytes(STYLES_XML) },
    { name: 'word/settings.xml', data: strToBytes(SETTINGS_XML) },
  ];

  const zipData = buildZip(files);
  return new Blob([zipData], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function downloadDocx(cvText, filename, isRtl = false) {
  const blob = buildDocx(cvText, isRtl);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Inert in the extension (no `module` global in a browser content/popup script) — lets the
// pure, DOM-free layout functions be exercised from plain Node for testing without a browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCVSections, LAYOUT_PROFILES, estimateCvOverflow, pickFittingProfile };
}
