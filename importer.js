'use strict';
/*
 * Reads a student schedule file and turns it into students. No outside libraries.
 *
 * Accepted files: Excel .xls (the older format) and .xlsx, CSV or tab-separated text,
 * and a PDF printed from a spreadsheet. Every reader works on a size-limited buffer, checks
 * every offset it reads, and caps its loops, so a damaged or hostile file can only produce
 * an error, never a hang or a crash.
 *
 * Expected columns (any order, header row anywhere near the top):
 *   StudentID | FirstName | LastName | Subject | Monday | Thursday
 * One row per student per subject. A student with two subjects has two rows.
 * Times look like "6:30pm", "4:30" (afternoon assumed) or "n/a".
 */

const zlib = require('zlib');

const MAX_ROWS = 20000;
const MAX_COLS = 60;
const SLOT_MIN = 30; // each subject is a 30-minute slot

class ImportError extends Error {}
const fail = (msg) => { throw new ImportError(msg); };

// ---------------------------------------------------------------- format detection

function readTable(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) fail('The file is empty.');
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig === 'd0cf11e0a1b11ae1') return readXls(buf);
  if (sig.startsWith('504b0304')) return readXlsx(buf);
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return readPdf(buf);
  return readText(buf);
}

// ---------------------------------------------------------------- CSV / TSV / pasted text

function readText(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4000))) fail('This file type is not supported. Use .xls, .xlsx, .csv or .pdf.');
  const firstLines = text.split(/\r?\n/, 5).join('\n');
  const delim = (firstLines.match(/\t/g) || []).length >= (firstLines.match(/,/g) || []).length && firstLines.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > MAX_ROWS) fail('The file has too many rows.');
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- .xls (OLE compound file + BIFF8)

function readXls(buf) {
  const u16 = (o) => (o + 2 <= buf.length ? buf.readUInt16LE(o) : fail('The Excel file is damaged.'));
  const u32 = (o) => (o + 4 <= buf.length ? buf.readUInt32LE(o) : fail('The Excel file is damaged.'));
  const sectorShift = u16(0x1e), miniShift = u16(0x20);
  if (sectorShift !== 9 && sectorShift !== 12) fail('The Excel file is damaged.');
  const secSize = 1 << sectorShift, miniSize = 1 << miniShift;
  const secOff = (n) => (n + 1) * secSize;
  const ENDCHAIN = 0xfffffffe;

  // the FAT is listed in the header (109 entries) and then in DIFAT sectors
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = u32(0x4c + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
  let difat = u32(0x44), guard = 0;
  while (difat < 0xfffffffa && guard++ < 1000) {
    const per = secSize / 4 - 1;
    for (let i = 0; i < per; i++) { const s = u32(secOff(difat) + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
    difat = u32(secOff(difat) + per * 4);
  }
  const fat = [];
  for (const s of fatSectors) for (let i = 0; i < secSize / 4; i++) fat.push(u32(secOff(s) + i * 4));

  const chain = (start, table) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== ENDCHAIN && s < table.length; s = table[s]) {
      if (seen.has(s) || out.length > 200000) fail('The Excel file is damaged.');
      seen.add(s); out.push(s);
    }
    return out;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).map((s) => {
    const o = secOff(s);
    if (o + secSize > buf.length) return buf.subarray(Math.min(o, buf.length));
    return buf.subarray(o, o + secSize);
  }));

  const dir = readChain(u32(0x30));
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = Math.min(64, dir.readUInt16LE(o + 64));
    entries.push({
      name: dir.subarray(o, o + Math.max(0, nameLen - 2)).toString('utf16le'),
      type: dir[o + 66], start: dir.readUInt32LE(o + 116), size: dir.readUInt32LE(o + 120),
    });
  }
  const root = entries.find((e) => e.type === 5);
  const book = entries.find((e) => e.type === 2 && /^(Workbook|Book)$/i.test(e.name));
  if (!root || !book) fail('No worksheet was found in the Excel file.');

  let stream;
  if (book.size < u32(0x38)) { // small streams live in the "mini stream"
    const miniFat = [];
    const mf = readChain(u32(0x3c));
    for (let o = 0; o + 4 <= mf.length; o += 4) miniFat.push(mf.readUInt32LE(o));
    const mini = readChain(root.start);
    stream = Buffer.concat(chain(book.start, miniFat).map((s) => mini.subarray(s * miniSize, s * miniSize + miniSize)));
  } else stream = readChain(book.start);
  stream = stream.subarray(0, Math.min(book.size, stream.length));
  return readBiff(stream);
}

function readBiff(b) {
  const sst = [];
  const cells = [];
  let bofCount = 0, inSheet = false, done = false, pendingFormula = null;
  const put = (r, c, v) => { if (r < MAX_ROWS && c < MAX_COLS) { (cells[r] = cells[r] || [])[c] = v; } };

  let o = 0;
  const records = [];
  while (o + 4 <= b.length) {
    const type = b.readUInt16LE(o), len = b.readUInt16LE(o + 2);
    if (o + 4 + len > b.length) break;
    records.push({ type, data: b.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }

  for (let i = 0; i < records.length && !done; i++) {
    const { type, data } = records[i];
    if (type === 0x0809) { bofCount++; inSheet = bofCount === 2; continue; } // 2nd BOF = first worksheet
    if (type === 0x000a && inSheet) { done = true; continue; }
    if (type === 0x00fc) { // shared strings, possibly spread over CONTINUE records
      const segs = [data.subarray(8)];
      while (records[i + 1] && records[i + 1].type === 0x003c) segs.push(records[++i].data);
      readSst(segs, data.length >= 8 ? data.readUInt32LE(4) : 0, sst);
      continue;
    }
    if (!inSheet || data.length < 6) continue;
    const r = data.readUInt16LE(0), c = data.readUInt16LE(2);
    if (type === 0x00fd && data.length >= 10) put(r, c, sst[data.readUInt32LE(6)] ?? '');
    else if (type === 0x0203 && data.length >= 14) put(r, c, data.readDoubleLE(6));
    else if (type === 0x027e && data.length >= 10) put(r, c, rk(data.readUInt32LE(6)));
    else if (type === 0x00bd) {
      const last = data.readUInt16LE(data.length - 2);
      for (let k = 0, col = c; col <= last && 4 + k * 6 + 6 <= data.length - 2; k++, col++) put(r, col, rk(data.readUInt32LE(4 + k * 6 + 2)));
    } else if (type === 0x0204 && data.length >= 9) {
      const cch = data.readUInt16LE(6), hi = data[8] & 1;
      put(r, c, hi ? data.subarray(9, 9 + cch * 2).toString('utf16le') : data.subarray(9, 9 + cch).toString('latin1'));
    } else if (type === 0x0006 && data.length >= 14) {
      if (data.readUInt16LE(12) === 0xffff) { if (data[6] === 0) pendingFormula = { r, c }; else if (data[6] === 1) put(r, c, data[8] ? 'TRUE' : 'FALSE'); }
      else put(r, c, data.readDoubleLE(6));
    }
    if (type === 0x0207 && pendingFormula) {
      const cch = data.readUInt16LE(0), hi = data[2] & 1;
      put(pendingFormula.r, pendingFormula.c, hi ? data.subarray(3, 3 + cch * 2).toString('utf16le') : data.subarray(3, 3 + cch).toString('latin1'));
      pendingFormula = null;
    }
  }
  const rows = [];
  for (let r = 0; r < cells.length; r++) rows.push((cells[r] || []).map((v) => (v == null ? '' : v)));
  return rows;
}

function rk(v) {
  let n;
  if (v & 2) n = v >> 2;
  else { const t = Buffer.alloc(8); t.writeUInt32LE(v & 0xfffffffc, 4); n = t.readDoubleLE(0); }
  return v & 1 ? n / 100 : n;
}

// Strings in the shared string table can break across CONTINUE records; each new record
// restarts with a flag byte saying whether the characters are 1 or 2 bytes wide.
function readSst(segs, count, out) {
  let si = 0, pos = 0;
  const avail = () => { while (si < segs.length && pos >= segs[si].length) { si++; pos = 0; } return si < segs.length; };
  const u8 = () => (avail() ? segs[si][pos++] : 0);
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n) => { while (n > 0 && avail()) { const k = Math.min(n, segs[si].length - pos); pos += k; n -= k; } };
  for (let s = 0; s < count && s < 200000 && avail(); s++) {
    const cch = u16(); let flags = u8();
    const runs = flags & 8 ? u16() : 0;
    const ext = flags & 4 ? u32() : 0;
    let str = '', left = cch;
    while (left > 0) {
      if (!avail()) break;
      if (pos === 0 && str.length) flags = u8(); // continuation: new width flag
      const wide = flags & 1;
      const fit = Math.min(left, Math.floor((segs[si].length - pos) / (wide ? 2 : 1)));
      if (fit <= 0) { pos = segs[si].length; continue; }
      const bytes = segs[si].subarray(pos, pos + fit * (wide ? 2 : 1));
      str += wide ? bytes.toString('utf16le') : bytes.toString('latin1');
      pos += bytes.length; left -= fit;
      if (left > 0 && pos >= segs[si].length) { si++; pos = 0; if (si < segs.length) flags = segs[si][pos++]; }
    }
    skip(runs * 4); skip(ext);
    out.push(str);
  }
}

// ---------------------------------------------------------------- .xlsx (zip of XML files)

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('The .xlsx file is damaged.');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let k = 0; k < n && k < 5000; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('The .xlsx file is damaged.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^(xl\/(sharedStrings|workbook)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/[^/]+\.xml)$/.test(name)) continue;
    if (local + 30 > buf.length) fail('The .xlsx file is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, Math.min(buf.length, start + csize));
    // maxOutputLength stops "zip bombs" that expand to gigabytes
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 40 * 1024 * 1024 }) : fail('The .xlsx file uses an unsupported compression.');
    total += data.length;
    if (total > 80 * 1024 * 1024) fail('The .xlsx file is too large.');
    files.set(name, data.toString('utf8'));
  }
  return files;
}

const xmlText = (s) => s.replace(/<[^>]*>/g, '').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
});

function readXlsx(buf) {
  const files = unzip(buf);
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml') || '';
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  // first sheet in the workbook's tab order
  let sheetPath = '';
  const wb = files.get('xl/workbook.xml') || '';
  const rels = files.get('xl/_rels/workbook.xml.rels') || '';
  const first = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
  if (first) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${first[1]}"`));
    const target = rel && rel.match(/Target="([^"]+)"/);
    if (target) sheetPath = 'xl/' + target[1].replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const sheet = files.get(sheetPath) || [...files.entries()].filter(([k]) => k.startsWith('xl/worksheets/')).sort()[0]?.[1];
  if (!sheet) fail('No worksheet was found in the .xlsx file.');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rAttr = rm[1].match(/\br="(\d+)"/);
    const ri = rAttr ? Number(rAttr[1]) - 1 : rows.length;
    if (ri >= MAX_ROWS) break;
    const row = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (cm[1].match(/\br="([A-Z]+)\d+"/) || [])[1];
      let ci = row.length;
      if (ref) { ci = 0; for (const ch of ref) ci = ci * 26 + ch.charCodeAt(0) - 64; ci--; }
      if (ci >= MAX_COLS) continue;
      const t = (cm[1].match(/\bt="(\w+)"/) || [])[1];
      const inner = cm[2] || '';
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = xmlText((inner.match(/<is>([\s\S]*?)<\/is>/) || ['', ''])[1]);
      else if (t === 'str' || t === 'b' || t === 'e') val = v != null ? xmlText(v) : '';
      else if (v != null && v !== '') val = Number(v);
      row[ci] = val;
    }
    rows[ri] = Array.from(row, (v) => (v == null ? '' : v));
  }
  return Array.from(rows, (r) => r || []);
}

// ---------------------------------------------------------------- PDF printed from a spreadsheet

function readPdf(buf) {
  const src = buf.toString('latin1');
  // index "N G obj ... endobj"
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m, guard = 0;
  while ((m = re.exec(src)) && guard++ < 100000) {
    const end = src.indexOf('endobj', re.lastIndex);
    if (end < 0) break;
    objs.set(Number(m[1]), { start: re.lastIndex, end });
    re.lastIndex = end + 6;
  }
  if (!objs.size) fail('This PDF could not be read. Upload the spreadsheet (.xls, .xlsx or .csv) instead.');

  const dictOf = (n) => { const o = objs.get(n); if (!o) return ''; const body = src.slice(o.start, o.end); const s = body.search(/\bstream\b/); return s >= 0 ? body.slice(0, s) : body; };
  const refIn = (dict, key) => { const r = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`)); return r ? Number(r[1]) : null; };
  const streamOf = (n) => {
    const o = objs.get(n); if (!o) return Buffer.alloc(0);
    const body = src.slice(o.start, o.end);
    const s = body.search(/\bstream\r?\n/);
    if (s < 0) return Buffer.alloc(0);
    const dict = body.slice(0, s);
    let start = o.start + s + body.slice(s).match(/^stream\r?\n/)[0].length;
    let len = null;
    const direct = dict.match(/\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/);
    if (direct) len = Number(direct[1]);
    else { const lr = refIn(dict, 'Length'); if (lr != null) { const v = dictOf(lr).match(/\d+/); if (v) len = Number(v[0]); } }
    let end = len != null ? start + len : src.indexOf('endstream', start);
    if (end > o.end || end < start) end = src.indexOf('endstream', start);
    const raw = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { return zlib.inflateSync(raw, { maxOutputLength: 20 * 1024 * 1024 }); } catch (_) { return zlib.inflateSync(raw.subarray(0, raw.length - 1), { maxOutputLength: 20 * 1024 * 1024 }); }
    }
    return raw;
  };

  // pages in order, following the Pages tree
  const pages = [];
  const catalog = [...objs.keys()].find((n) => /\/Type\s*\/Catalog/.test(dictOf(n)));
  const walk = (n, depth) => {
    if (depth > 20 || pages.length > 2000) return;
    const d = dictOf(n);
    if (/\/Type\s*\/Page\b/.test(d)) { pages.push(n); return; }
    const kids = d.match(/\/Kids\s*\[([^\]]*)\]/);
    if (kids) for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
  };
  if (catalog != null) { const root = refIn(dictOf(catalog), 'Pages'); if (root != null) walk(root, 0); }
  if (!pages.length) fail('This PDF has no pages that could be read.');

  const cmapCache = new Map();
  const toUnicode = (fontObj) => {
    if (cmapCache.has(fontObj)) return cmapCache.get(fontObj);
    const map = new Map();
    const tu = refIn(dictOf(fontObj), 'ToUnicode');
    if (tu != null) {
      const cm = streamOf(tu).toString('latin1');
      const hexStr = (hx) => { let s = ''; for (let i = 0; i + 4 <= hx.length; i += 4) s += String.fromCharCode(parseInt(hx.slice(i, i + 4), 16)); return s; };
      for (const blk of cm.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const e of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(e[1], 16), hexStr(e[2]));
      }
      for (const blk of cm.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const e of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
          const lo = parseInt(e[1], 16), hi = Math.min(parseInt(e[2], 16), lo + 65535);
          if (e[3][0] === '<') { const base = hexStr(e[3].slice(1, -1)); for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo))); }
          else { const list = [...e[3].matchAll(/<([0-9a-fA-F]+)>/g)]; list.forEach((x, k) => map.set(lo + k, hexStr(x[1]))); }
        }
      }
    }
    const wide = /Identity-H|Identity-V/.test(dictOf(fontObj));
    const res = { map, wide };
    cmapCache.set(fontObj, res);
    return res;
  };

  const allRows = [];
  for (const pg of pages) {
    const pd = dictOf(pg);
    let resDict = pd;
    const resRef = refIn(pd, 'Resources');
    if (resRef != null) resDict = dictOf(resRef);
    const fonts = new Map();
    let fontDict = resDict;
    const fr = refIn(resDict, 'Font');
    if (fr != null) fontDict = dictOf(fr);
    for (const f of fontDict.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) if (/\/Type\s*\/Font/.test(dictOf(Number(f[2])))) fonts.set(f[1], Number(f[2]));

    let contentRefs = [];
    const arr = pd.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arr) contentRefs = [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));
    else { const c = refIn(pd, 'Contents'); if (c != null) contentRefs = [c]; }
    const content = Buffer.concat(contentRefs.map(streamOf)).toString('latin1');
    allRows.push(...pdfPageRows(content, (name) => (fonts.has(name) ? toUnicode(fonts.get(name)) : { map: new Map(), wide: false })));
  }
  return allRows;
}

// Runs a page's drawing commands far enough to know where each piece of text sits,
// then rebuilds the table: same height = same row, left-to-right = columns.
function pdfPageRows(content, fontFor) {
  const items = [];
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm, font = { map: new Map(), wide: false }, leading = 0;
  const ops = [];
  const tokRe = /\s*(?:(\((?:\\[\s\S]|[^\\)])*\))|(<[0-9a-fA-F\s]*>)|(\[)|(\])|(\/[^\s/<>()[\]]+)|([-+]?\d*\.?\d+)|([A-Za-z'"*]+[0-9]?)|(<<|>>)|(\S))/g;
  let t, guard = 0;
  while ((t = tokRe.exec(content)) && guard++ < 2000000) {
    if (t[0].trim() === '') { if (tokRe.lastIndex >= content.length) break; continue; }
    if (t[1]) ops.push({ s: unescapePdf(t[1].slice(1, -1)) });
    else if (t[2]) ops.push({ h: t[2].slice(1, -1).replace(/\s+/g, '') });
    else if (t[3]) ops.push({ a: true });
    else if (t[4]) { const list = []; while (ops.length && !ops[ops.length - 1].a) list.unshift(ops.pop()); ops.pop(); ops.push({ arr: list }); }
    else if (t[5]) ops.push({ n: t[5].slice(1) });
    else if (t[6]) ops.push({ v: Number(t[6]) });
    else if (t[7]) { run(t[7], ops.splice(0)); }
  }
  function decode(op) {
    if (op.h != null) {
      let s = '';
      const hx = op.h.length % 2 ? op.h + '0' : op.h;
      const step = font.wide ? 4 : 2;
      for (let i = 0; i + step <= hx.length; i += step) { const code = parseInt(hx.slice(i, i + step), 16); s += font.map.get(code) ?? (font.wide ? '' : String.fromCharCode(code)); }
      return s;
    }
    if (op.s != null) {
      let s = '';
      if (font.wide) { for (let i = 0; i + 1 < op.s.length; i += 2) s += font.map.get((op.s.charCodeAt(i) << 8) | op.s.charCodeAt(i + 1)) ?? ''; }
      else for (const ch of op.s) s += font.map.get(ch.charCodeAt(0)) ?? ch;
      return s;
    }
    return '';
  }
  function show(text) {
    if (!text) return;
    const m = mul(tm, ctm);
    items.push({ x: m[4], y: m[5], text });
  }
  function run(op, args) {
    const nums = args.filter((a) => a.v != null).map((a) => a.v);
    switch (op) {
      case 'q': if (stack.length < 100) stack.push(ctm); break;
      case 'Q': ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case 'cm': if (nums.length === 6) ctm = mul(nums, ctm); break;
      case 'BT': tm = tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': { const n = args.find((a) => a.n); if (n) font = fontFor(n.n); break; }
      case 'TL': leading = nums[0] || 0; break;
      case 'Tm': if (nums.length === 6) tm = tlm = nums; break;
      case 'Td': tm = tlm = mul([1, 0, 0, 1, nums[0] || 0, nums[1] || 0], tlm); break;
      case 'TD': leading = -(nums[1] || 0); tm = tlm = mul([1, 0, 0, 1, nums[0] || 0, nums[1] || 0], tlm); break;
      case 'T*': tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); break;
      case 'Tj': show(args.map(decode).join('')); break;
      case "'": tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); show(args.map(decode).join('')); break;
      case 'TJ': { const a = args.find((x) => x.arr); if (a) show(a.arr.map((x) => (x.v != null ? (x.v < -200 ? ' ' : '') : decode(x))).join('')); break; }
      default: break;
    }
  }
  // group into lines (a little tolerance for baseline jitter)
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < 5);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  // y may grow down or up depending on the page transform; keep reading order top to bottom
  const flipped = items.length > 1 && lines.length > 1 && lines[0].y < lines[lines.length - 1].y;
  if (flipped) lines.reverse();
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    return { pdf: true, cells: l.items };
  });
}

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (m, e) => {
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (map[e] != null) return map[e];
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return '';
  });
}

// PDF lines carry x positions; turn them into cells using the header row's column positions.
function pdfToGrid(lines) {
  const grid = [];
  let cols = null;
  for (const line of lines) {
    const texts = line.cells.map((c) => c.text.trim()).filter(Boolean);
    if (isHeader(texts)) {
      cols = line.cells.filter((c) => c.text.trim()).map((c) => c.x);
      grid.push(texts);
      continue;
    }
    if (!cols) { grid.push(texts); continue; }
    const row = cols.map(() => '');
    for (const c of line.cells) {
      const txt = c.text.trim();
      if (!txt) continue;
      let k = 0;
      for (let i = 0; i < cols.length; i++) if (c.x >= cols[i] - 4) k = i;
      row[k] = row[k] ? `${row[k]} ${txt}` : txt;
    }
    grid.push(row);
  }
  return grid;
}

// ---------------------------------------------------------------- table -> students

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function isHeader(cells) {
  const n = cells.map(norm);
  const hits = ['studentid', 'firstname', 'lastname', 'subject', 'monday', 'thursday', 'name', 'id'].filter((h) => n.includes(h)).length;
  return hits >= 3;
}

function findColumns(header) {
  const n = header.map(norm);
  const pick = (...names) => { for (const nm of names) { const i = n.indexOf(nm); if (i >= 0) return i; } return -1; };
  const fuzzy = (re) => n.findIndex((x) => re.test(x));
  return {
    id: pick('studentid', 'id', 'studentnumber', 'kumonid') >= 0 ? pick('studentid', 'id', 'studentnumber', 'kumonid') : fuzzy(/id$/),
    first: pick('firstname', 'first'),
    last: pick('lastname', 'last', 'surname'),
    name: pick('name', 'studentname', 'fullname'),
    subject: pick('subject', 'subjects', 'class'),
    mon: pick('monday', 'mon'),
    thu: pick('thursday', 'thu', 'thur', 'thurs'),
  };
}

function cellText(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

// "6:30pm" "6:30 PM" "4:30" "18:30" "6pm" or an Excel time (fraction of a day) -> "HH:MM"
function parseTime(v) {
  if (typeof v === 'number') {
    if (!(v > 0 && v < 1)) return null;
    let mins = Math.round(v * 1440);
    if (mins >= 60 && mins < 10 * 60) mins += 12 * 60; // typed as "4:30" without PM
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || /^(n\/?a|none|-+|—|x|off|no)$/.test(s)) return '';
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) return null;
  let hh = Number(m[1]); const mm = Number(m[2] || 0);
  if (hh > 23 || mm > 59) return null;
  const ap = m[3] ? m[3][0] : '';
  if (ap === 'p' && hh < 12) hh += 12;
  else if (ap === 'a' && hh === 12) hh = 0;
  else if (!ap && hh >= 1 && hh <= 9) hh += 12; // classes run in the afternoon: "4:30" means 4:30 PM
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt12 = (t) => { const h = Number(t.slice(0, 2)), m = t.slice(3); return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`; };

function titleSubject(s) {
  const t = cellText(s);
  if (/^math/i.test(t)) return 'Math';
  if (/^read/i.test(t)) return 'Reading';
  return t.slice(0, 20);
}

/**
 * Turns a schedule file into students.
 * Returns { students: [{kumonId, name, subjects, sched:{1:{in,out},4:{in,out}}}], warnings: [], rows }
 */
function parseSchedule(buf) {
  let table = readTable(buf);
  if (table.length && table[0] && table[0].pdf) table = pdfToGrid(table);
  const hi = table.slice(0, 30).findIndex((r) => r && isHeader(r.map(cellText)));
  if (hi < 0) fail('Could not find the header row. The first row should have StudentID, FirstName, LastName, Subject, Monday and Thursday.');
  const col = findColumns(table[hi].map(cellText));
  if (col.first < 0 && col.name < 0) fail('Could not find a name column (FirstName/LastName or Name).');
  if (col.mon < 0 && col.thu < 0) fail('Could not find a Monday or Thursday column.');

  const warnings = [];
  const byKey = new Map();
  const idNames = new Map();
  let rowsRead = 0;
  for (let r = hi + 1; r < table.length; r++) {
    const row = table[r] || [];
    if (isHeader(row.map(cellText))) continue; // repeated header on each printed page
    const get = (i) => (i >= 0 ? row[i] : '');
    const first = cellText(get(col.first)), last = cellText(get(col.last));
    const name = (col.first >= 0 ? `${first} ${last}` : cellText(get(col.name))).replace(/\s+/g, ' ').trim().slice(0, 60);
    let kumonId = cellText(get(col.id)).replace(/\s+/g, '');
    if (/^\d+\.0+$/.test(kumonId)) kumonId = kumonId.replace(/\.0+$/, '');
    if (!name && !kumonId) continue;
    rowsRead++;
    const line = r + 1;
    if (!name) { warnings.push(`Row ${line}: no name, skipped.`); continue; }
    if (kumonId && !/^[A-Za-z0-9-]{1,24}$/.test(kumonId)) { warnings.push(`Row ${line} (${name}): ID "${kumonId.slice(0, 30)}" is not valid, left blank.`); kumonId = ''; }

    const key = `${kumonId}|${name.toLowerCase()}`;
    let st = byKey.get(key);
    if (!st) {
      st = { kumonId, name, subjects: [], times: { 1: [], 4: [] } };
      byKey.set(key, st);
      if (kumonId) { const names = idNames.get(kumonId) || new Set(); names.add(name); idNames.set(kumonId, names); }
    }
    const subject = titleSubject(get(col.subject));
    if (subject && !st.subjects.includes(subject)) st.subjects.push(subject);
    for (const [day, ci, label] of [[1, col.mon, 'Monday'], [4, col.thu, 'Thursday']]) {
      if (ci < 0) continue;
      const raw = get(ci);
      const t = parseTime(raw);
      if (t === null) { warnings.push(`Row ${line} (${name}): ${label} time "${cellText(raw).slice(0, 20)}" was not understood, left out.`); continue; }
      if (!t) continue;
      if (toMin(t) < 15 * 60 || toMin(t) > 19 * 60 + 30) warnings.push(`Row ${line} (${name}): ${label} at ${fmt12(t)} is outside class hours.`);
      st.times[day].push(t);
    }
  }

  for (const [id, names] of idNames) {
    if (names.size > 1) warnings.push(`ID ${id} is used by ${[...names].join(' and ')}. Each was added as a separate student; check the sheet.`);
  }

  const students = [];
  for (const st of byKey.values()) {
    const sched = {};
    for (const d of [1, 4]) {
      const ts = st.times[d].map(toMin);
      if (!ts.length) continue;
      // arrive for the first subject, leave 30 minutes after the last one starts
      sched[d] = { in: fromMin(Math.min(...ts)), out: fromMin(Math.max(...ts) + SLOT_MIN) };
    }
    if (!Object.keys(sched).length) warnings.push(`${st.name} has no Monday or Thursday time, so they are added without a schedule.`);
    students.push({ kumonId: st.kumonId, name: st.name, subjects: st.subjects.sort(), sched });
  }
  students.sort((a, b) => a.name.localeCompare(b.name));
  if (!students.length) fail('No students were found under the header row.');
  return { students, warnings, rows: rowsRead };
}

module.exports = { parseSchedule, parseTime, ImportError };
