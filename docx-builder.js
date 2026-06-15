// Pure JS DOCX builder — no external libraries, works in browser/extension context

function parseCVSections(cvText) {
  const markers = ['[NAME]', '[HEADLINE]', '[CONTACT]', '[PROFILE]', '[EXPERIENCE]', '[EDUCATION]', '[SKILLS]', '[LANGUAGES]'];
  const sections = {};
  let currentMarker = null;
  let currentLines = [];

  // Normalize line endings
  const normalized = cvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Match marker even if AI added ** or other formatting around it
    const foundMarker = markers.find(m => trimmed === m || trimmed === `**${m}**` || trimmed.startsWith(m));
    if (foundMarker) {
      if (currentMarker) {
        sections[currentMarker] = currentLines.join('\n').trim();
      }
      currentMarker = foundMarker;
      currentLines = [];
    } else if (currentMarker) {
      currentLines.push(line);
    }
  }
  if (currentMarker) {
    sections[currentMarker] = currentLines.join('\n').trim();
  }

  // Fallback: if no markers found at all, put everything as raw content
  const hasContent = Object.values(sections).some(v => v.length > 0);
  if (!hasContent) {
    sections['[PROFILE]'] = normalized.trim();
  }

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
  const { bold = false, size = 21, color = '1f2937', italic = false } = opts;
  const rPr = `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function makeParagraph(runs, opts = {}) {
  const { align = 'left', isRtl = false, spacingAfter = 80, spacingLine = 276 } = opts;
  const pPr = `<w:pPr><w:jc w:val="${align}"/>${isRtl ? '<w:bidi/>' : ''}<w:spacing w:after="${spacingAfter}" w:line="${spacingLine}" w:lineRule="auto"/></w:pPr>`;
  return `<w:p>${pPr}${runs}</w:p>`;
}

function makeSectionHeading(title, isRtl) {
  const align = isRtl ? 'right' : 'left';
  const run = makeRun(title.toUpperCase(), { bold: true, size: 22, color: '7c3aed' });
  const underlineRun = `<w:r><w:rPr><w:color w:val="7c3aed"/><w:sz w:val="4"/><w:szCs w:val="4"/></w:rPr><w:t> </w:t></w:r>`;
  const border = `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="7c3aed"/></w:pBdr>`;
  const pPr = `<w:pPr><w:jc w:val="${align}"/>${isRtl ? '<w:bidi/>' : ''}<w:spacing w:before="120" w:after="60"/>${border}</w:pPr>`;
  return `<w:p>${pPr}${run}</w:p>`;
}

function makeBulletParagraph(text, isRtl) {
  const align = isRtl ? 'right' : 'left';
  const indent = isRtl ? `<w:ind w:right="360"/>` : `<w:ind w:left="360" w:hanging="180"/>`;
  const bullet = isRtl ? '•' : '•';
  const pPr = `<w:pPr><w:jc w:val="${align}"/>${isRtl ? '<w:bidi/>' : ''}${indent}<w:spacing w:after="40" w:line="252" w:lineRule="auto"/></w:pPr>`;
  const run = makeRun(`${bullet} ${text}`, { size: 21, color: '1f2937' });
  return `<w:p>${pPr}${run}</w:p>`;
}

function textToDocxParagraphs(text, isRtl, isBullet = false) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  return lines.map(line => {
    if (isBullet || line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
      const clean = line.replace(/^[•\-\*]\s*/, '');
      return makeBulletParagraph(clean, isRtl);
    }
    const align = isRtl ? 'right' : 'left';
    const run = makeRun(line, { size: 21, color: '1f2937' });
    return makeParagraph(run, { align, isRtl, spacingAfter: 60 });
  }).join('');
}

function buildDocumentXml(sections, isRtl) {
  const align = isRtl ? 'right' : 'left';
  const bidi = isRtl ? '<w:bidi/>' : '';
  let body = '';

  // Name
  if (sections['[NAME]']) {
    const run = makeRun(sections['[NAME]'], { bold: true, size: 40, color: '1a1a2e' });
    body += makeParagraph(run, { align: 'center', isRtl, spacingAfter: 40 });
  }

  // Headline
  if (sections['[HEADLINE]']) {
    const run = makeRun(sections['[HEADLINE]'], { size: 24, color: '7c3aed' });
    body += makeParagraph(run, { align: 'center', isRtl, spacingAfter: 40 });
  }

  // Contact
  if (sections['[CONTACT]']) {
    const lines = sections['[CONTACT]'].split('\n').filter(l => l.trim());
    const contactText = lines.join('  |  ');
    const run = makeRun(contactText, { size: 20, color: '8b949e' });
    body += makeParagraph(run, { align: 'center', isRtl, spacingAfter: 120 });
  }

  // Profile
  if (sections['[PROFILE]']) {
    body += makeSectionHeading('Profile', isRtl);
    body += textToDocxParagraphs(sections['[PROFILE]'], isRtl);
  }

  // Experience
  if (sections['[EXPERIENCE]']) {
    body += makeSectionHeading('Experience', isRtl);
    body += textToDocxParagraphs(sections['[EXPERIENCE]'], isRtl);
  }

  // Education
  if (sections['[EDUCATION]']) {
    body += makeSectionHeading('Education', isRtl);
    body += textToDocxParagraphs(sections['[EDUCATION]'], isRtl);
  }

  // Skills
  if (sections['[SKILLS]']) {
    body += makeSectionHeading('Skills', isRtl);
    body += textToDocxParagraphs(sections['[SKILLS]'], isRtl);
  }

  // Languages (always last)
  if (sections['[LANGUAGES]']) {
    body += makeSectionHeading('Languages', isRtl);
    body += textToDocxParagraphs(sections['[LANGUAGES]'], isRtl);
  }

  // Page size A4, margins 1.8cm = ~1021 twips
  const sectPr = `<w:sectPr>${bidi}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1021" w:right="1021" w:bottom="1021" w:left="1021" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;

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

const WORD_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

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
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>
        <w:sz w:val="21"/>
        <w:szCs w:val="21"/>
        <w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="he-IL"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr>
  </w:style>
</w:styles>`;

function buildDocx(cvText, isRtl = false) {
  const sections = parseCVSections(cvText);
  const documentXml = buildDocumentXml(sections, isRtl);

  const files = [
    { name: '[Content_Types].xml', data: strToBytes(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: strToBytes(RELATIONSHIPS_XML) },
    { name: 'word/document.xml', data: strToBytes(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: strToBytes(WORD_RELS_XML) },
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
