/** Minimal XLSX writer (one sheet, stored ZIP, no dependency). Numbers stay numbers, everything else is text. */

const enc = new TextEncoder();
const MAX_ROWS = 1_048_576;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const xmlText = (t: string) =>
  // control characters other than tab, LF and CR are not allowed in XML 1.0
  // eslint-disable-next-line no-control-regex
  t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '<c/>';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c><v>${v}</v></c>`;
  return `<c t="inlineStr"><is><t xml:space="preserve">${xmlText(String(v))}</t></is></c>`;
}

function sheetChunks(head: string[], rows: unknown[][]): Uint8Array[] {
  const chunks: Uint8Array[] = [
    enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'),
  ];
  const all = [head, ...rows.slice(0, MAX_ROWS - 1)];
  for (let i = 0; i < all.length; i += 2000) {
    const block = all.slice(i, i + 2000).map((r) => `<row>${r.map(cell).join('')}</row>`);
    chunks.push(enc.encode(block.join('')));
  }
  chunks.push(enc.encode('</sheetData></worksheet>'));
  return chunks;
}

interface Entry {
  name: string;
  parts: Uint8Array[];
}

function zip(entries: Entry[]): Blob {
  const out: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: DataView, o: number, x: number) => v.setUint16(o, x, true);
  const u32 = (v: DataView, o: number, x: number) => v.setUint32(o, x, true);
  for (const e of entries) {
    const name = enc.encode(e.name);
    const size = e.parts.reduce((s, p) => s + p.length, 0);
    const crc = crc32(e.parts);
    const local = new DataView(new ArrayBuffer(30));
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 6, 0x0800); // UTF-8 names
    u16(local, 12, 0x21); // 1980-01-01
    u32(local, 14, crc);
    u32(local, 18, size);
    u32(local, 22, size);
    u16(local, 26, name.length);
    out.push(local.buffer, name as BlobPart, ...(e.parts as BlobPart[]));
    const c = new DataView(new ArrayBuffer(46));
    u32(c, 0, 0x02014b50);
    u16(c, 4, 20);
    u16(c, 6, 20);
    u16(c, 8, 0x0800);
    u16(c, 14, 0x21);
    u32(c, 16, crc);
    u32(c, 20, size);
    u32(c, 24, size);
    u16(c, 28, name.length);
    u32(c, 42, offset);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  u32(end, 0, 0x06054b50);
  u16(end, 8, entries.length);
  u16(end, 10, entries.length);
  u32(end, 12, cdSize);
  u32(end, 16, offset);
  out.push(...(central as BlobPart[]), end.buffer);
  return new Blob(out, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function buildXlsx(sheetName: string, head: string[], rows: unknown[][]): Blob {
  const text = (s: string): Entry['parts'] => [enc.encode(s)];
  const hdr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheet = xmlText(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Data');
  return zip([
    {
      name: '[Content_Types].xml',
      parts: text(
        `${hdr}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      parts: text(`${hdr}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      parts: text(`${hdr}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      parts: text(`${hdr}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    },
    { name: 'xl/worksheets/sheet1.xml', parts: sheetChunks(head, rows) },
  ]);
}
