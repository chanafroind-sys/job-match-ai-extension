// Daily Matches — DOCX → text for the CV library.
//
// A physical copy of popup.js's inflateRaw + extractDocxText (V1 is never
// imported from: popup.js is one 3,800-line script with load-time side
// effects). Keep the two in step if V1's extractor ever gets a fix.
(function (root) {
  'use strict';

  async function inflateRaw(compressedBytes) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
  }

  async function extractDocxText(arrayBuffer) {
    try {
      const bytes = new Uint8Array(arrayBuffer);
      const findFile = async (name) => {
        for (let i = 0; i < bytes.length - 30; i++) {
          if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
            const compression = bytes[i + 8] | (bytes[i + 9] << 8);
            const compressedSize = bytes[i + 18] | (bytes[i + 19] << 8) | (bytes[i + 20] << 16) | (bytes[i + 21] << 24);
            const fnLen = bytes[i + 26] | (bytes[i + 27] << 8);
            const extraLen = bytes[i + 28] | (bytes[i + 29] << 8);
            const fnStart = i + 30;
            const fn = new TextDecoder().decode(bytes.slice(fnStart, fnStart + fnLen));
            if (fn === name) {
              const dataStart = fnStart + fnLen + extraLen;
              const data = bytes.slice(dataStart, dataStart + compressedSize);
              return compression === 8 ? await inflateRaw(data) : data;
            }
          }
        }
        return null;
      };

      const relsMap = {};
      const relsBytes = await findFile('word/_rels/document.xml.rels');
      if (relsBytes) {
        const relsXml = new TextDecoder('utf-8').decode(relsBytes);
        for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="(https?:[^"]+)"/g)) relsMap[m[1]] = m[2];
      }
      const xmlBytes = await findFile('word/document.xml');
      if (!xmlBytes) return null;
      let xml = new TextDecoder('utf-8').decode(xmlBytes);
      xml = xml.replace(/<w:hyperlink\b[^>]*\br:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/g, (_, rId, inner) => {
        const url = relsMap[rId];
        if (!url) return inner;
        const lastClose = inner.lastIndexOf('</w:t>');
        if (lastClose === -1) return inner;
        return inner.slice(0, lastClose) + ' ' + url + inner.slice(lastClose);
      });
      const paras = xml.split(/<w:p[ >\/]/);
      let result = '';
      for (const para of paras) {
        const tMatches = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
        if (tMatches.length > 0) result += tMatches.map(m => m[1]).join('') + '\n';
      }
      return result.trim();
    } catch (e) {
      console.error('[JMA:DM] DOCX extract error:', e);
      return null;
    }
  }

  root.JMA_DM = root.JMA_DM || {};
  root.JMA_DM.extractDocxText = extractDocxText;
})(typeof globalThis !== 'undefined' ? globalThis : self);
