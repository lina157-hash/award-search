const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { readSheet, isZip } = require('../lib/sheet');
const F = require('../lib/flightdata');

// A ZIP of { name: text } (deflated), enough for readSheet.
function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

test('readSheet: XLSX shared and inline strings, gaps kept by column letter, sheets in order', () => {
  const buf = zip({
    'xl/sharedStrings.xml': '<sst><si><t>航線</t></si><si><t>航空公司</t></si><si><r><t>東京</t></r><r><t>(成田)</t></r></si><si><t>長榮&amp;航空</t></si></sst>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二頁</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"/><row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3" t="s"><v>3</v></c><c r="D3"><v>0.85</v></c></row></sheetData></worksheet>',
  });
  assert.ok(isZip(buf));
  assert.deepEqual(readSheet(buf), [['航線', '', '航空公司'], ['東京(成田)', '', '長榮&航空', '0.85'], ['第二頁']]);
});

test('readSheet: ODS repeated cells, values without text, the empty tail counted once', () => {
  const buf = zip({
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'content.xml': '<office:document-content><table:table><table:table-row><table:table-cell><text:p>航線</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16000"/></table:table-row>'
      + '<table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>'
      + '<table:table-row><table:table-cell office:value-type="float" office:value="81.5"/><table:table-cell><text:p>a &lt; b</text:p></table:table-cell></table:table-row></table:table></office:document-content>',
  });
  assert.deepEqual(readSheet(buf), [['航線', 'x', 'x', ''], ['81.5', 'a < b']]);
  assert.throws(() => readSheet(new Uint8Array([1, 2, 3])), /不是 XLSX/);
});

test('民航局 47492: the file list names the route-and-airline file; spreadsheet rows parse like the CSV', () => {
  const list = '名稱,版本,時間,路徑\n國際及兩岸定期航線班機載客率－按機場分,115年8月,115年9月29日,https://www.caa.gov.tw/FileAtt.ashx?lang=1&id=1\n國際及兩岸定期航線班機載客率－按航線及航空公司分,115年8月,115年9月29日,https://www.caa.gov.tw/FileAtt.ashx?lang=1&id=41543';
  assert.equal(F.lfFileLink(list), 'https://www.caa.gov.tw/FileAtt.ashx?lang=1&id=41543');
  assert.equal(F.lfFileLink('航線,航空公司,載客率\n香港,中華航空,80%'), '');
  const rows = [['表 3 臺灣桃園國際機場 2025 年'], ['航線', '航空公司', '載客率'], ['香港', '中華航空', '0.815']];
  const r = F.parseLoadFactor(rows, { airportNames: [['香港', 'HKG']], airlineZh: { CI: '中華航空' } });
  assert.deepEqual(r.routes, { 'TPE-HKG': { CI: [82] } });
  assert.throws(() => F.parseLoadFactor([['甲'], ['乙', '丙']], {}), /開頭：甲｜乙\|丙/);
});

test('民航局 9973: DepartureDateTime and ArrivalDateTime columns (the CSV as published in 2026-10; names after ArrivalAirport assumed)', () => {
  const head = ['Airline', 'FlightNumber', 'CodeShareInfo', 'DepartureAirport', 'DepartureDateTime',
    ...[1, 2, 3, 4, 5].flatMap((i) => [`TransitAirport_${i}`, `TransitAirportArrival_${i}`, `TransitAirportDeparture_${i}`]),
    'ArrivalAirport', 'ArrivalDateTime', 'ScheduleStartDate', 'ScheduleEndDate', 'Weekday', 'AircraftType'];
  const row = ['B7', 'B7501', 'BR2399', 'PVG', '1120', ...Array(15).fill(''), 'TSA', '1310', '2026/09/29', '2026/10/04', '0204007', '321'];
  const csv = [head, ...Array(25).fill(row)].map((r) => r.join(',')).join('\n');
  const p = F.parseCaaSchedule(csv, { tzOf: (c) => ({ PVG: 'Asia/Shanghai', TSA: 'Asia/Taipei' })[c] || '' });
  assert.equal(p.rows.length, 25);
  assert.deepEqual({ ...p.rows[0] }, { fn: 'B7501', o: 'PVG', d: 'TSA', dep: '11:20', arr: '13:10', ad: 0, days: 0b1001010, from: '2026-09-29', to: '2026-10-04', ac: '321', t: '', cs: ['BR2399'] });
});
