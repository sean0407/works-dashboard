/**
 * 沃克思｜自動把雲端資料夾裡的新文件登記到「文件」分頁。
 *
 * 安裝：在試算表「擴充功能 → Apps Script」貼上本檔全部內容並儲存，
 * 重新開啟試算表後，用「沃克思」選單執行。說明見 ADD-DATA-zh-TW.md。
 *
 * 這支程式只會新增資料，不會刪除或改寫已填的內容：
 * 1. 讀取指定資料夾的檔案清單與內容雜湊，在「文件」分頁新增列或補上空白的連結欄。
 * 2. 讀出新匯入的報價單／發票 PDF 文字，在「報價版本」或「發票」分頁新增一列（標記待核對）。
 *    需要先在 Apps Script 編輯器左側「服務」加入「Drive API」；沒加的話只會略過這一步。
 * 3. 每天早上寄一封摘要信：今天該追的案件、未來 7 天的活動、逾期應收。
 */

var DOC_SHEET = '文件';
var SETTINGS_SHEET = '設定';
// 「設定」分頁的資料夾設定：報價單、發票各一個資料夾，類型直接依資料夾決定；documents_folder_id 為其他文件（類型依檔名推測）。
var FOLDER_KEYS = [
  { key: 'quotes_folder_id', kind: '報價單' },
  { key: 'invoices_folder_id', kind: '發票' },
  { key: 'documents_folder_id', kind: '' }
];
var HEADERS = {
  id: '文件ID', kind: '文件類型', filename: '原始檔名', url: '文件連結', sha256: 'SHA256',
  caseNumber: '原案號', reviewNotes: '待核對事項', reviewStatus: '核對狀態'
};
var AUTO_NOTE = '自動匯入：請確認文件類型與原案號';
var AUTO_STATUS = '待核對';
var ACCEPTED_MIME = /^(application\/pdf|image\/)/;
var MAX_DEPTH = 8;

// ---------- Pure logic (tested in tests/document-import.test.mjs) ----------

/** 報價單 / 發票 / 其他, judged from the file name and its folder name. */
function guessKind(name, folderName) {
  var text = String(name || '') + ' ' + String(folderName || '');
  if (/報價|quot(e|ation)/i.test(text)) return '報價單';
  if (/發票|invoice/i.test(text) || /(^|[^A-Za-z])[A-Z]{2}-?\d{8}(?!\d)/.test(String(name || ''))) return '發票';
  return '其他';
}

/** First standalone case number like A280 in the file name, else in the folder name. */
function guessCaseNumber(name, folderName) {
  var pattern = /(?:^|[^A-Za-z0-9])(A\d{3})(?!\d)/;
  var m = pattern.exec(String(name || '')) || pattern.exec(String(folderName || ''));
  return m ? m[1] : '';
}

/** Stable ID: the same Drive file always gets the same 文件ID. */
function docIdFor(fileId) {
  return 'doc_' + String(fileId).slice(0, 16);
}

/** Drive file ID inside a sharing URL, or '' when the cell is not a Drive file link. */
function driveFileIdFromUrl(url) {
  var s = String(url || '');
  var m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  return m ? m[1] : '';
}

/** Map of field -> column index, by row-1 header text. Throws if a required header is missing. */
function columnIndex(headers) {
  var trimmed = headers.map(function (h) { return String(h == null ? '' : h).trim(); });
  var index = {};
  Object.keys(HEADERS).forEach(function (key) {
    var i = trimmed.indexOf(HEADERS[key]);
    if (i < 0) throw new Error('「' + DOC_SHEET + '」分頁找不到欄位「' + HEADERS[key] + '」，請保留第 1 列欄名。');
    index[key] = i;
  });
  return index;
}

/** The folder's fixed kind wins; otherwise guess from the names. */
function kindFor(file, name) {
  return file.kind || guessKind(name, file.folder);
}

/**
 * Decide what to write. Never removes or overwrites a filled cell.
 * headers: row 1; rows: existing data rows (row 2 onward); files: [{id, name, url, folder, kind?, sha256?}].
 * hash(file) returns the SHA256 hex for files that will be written (defaults to file.sha256).
 * Returns {append: [rowValues], update: [{row: sheetRowNumber, values: rowValues}], skipped: n}.
 */
function planChanges(headers, rows, files, hash) {
  hash = hash || function (f) { return f.sha256 || ''; };
  var col = columnIndex(headers);
  var linked = {}, knownIds = {}, unlinkedByName = {}, knownSha = {};
  rows.forEach(function (row, i) {
    var sha = String(row[col.sha256] || '').trim();
    if (sha) knownSha[sha] = true;
    var fid = driveFileIdFromUrl(row[col.url]);
    if (fid) linked[fid] = true;
    var id = String(row[col.id] || '').trim();
    if (id) knownIds[id] = true;
    var name = String(row[col.filename] || '').trim();
    if (name && !String(row[col.url] || '').trim() && !(name in unlinkedByName)) unlinkedByName[name] = i;
  });
  var result = { append: [], update: [], skipped: 0, duplicates: 0 };
  var seen = {};
  files.forEach(function (file) {
    if (seen[file.id] || linked[file.id] || knownIds[docIdFor(file.id)]) { result.skipped++; return; }
    seen[file.id] = true;
    var name = String(file.name || '').trim();
    if (name in unlinkedByName) {
      // An older row that only has the file name: attach the cloud link instead of duplicating it.
      var i = unlinkedByName[name];
      delete unlinkedByName[name];
      var values = rows[i].slice();
      while (values.length < headers.length) values.push('');
      values[col.url] = file.url;
      if (!String(values[col.sha256] || '').trim()) values[col.sha256] = hash(file);
      if (!String(values[col.id] || '').trim()) values[col.id] = docIdFor(file.id);
      if (!String(values[col.kind] || '').trim()) values[col.kind] = kindFor(file, name);
      if (!String(values[col.caseNumber] || '').trim()) values[col.caseNumber] = guessCaseNumber(name, file.folder);
      result.update.push({ row: i + 2, values: values });
      return;
    }
    // A second copy of a file that is already registered (same content hash) is not a new document.
    var sha = hash(file);
    if (sha && knownSha[sha]) { result.skipped++; result.duplicates++; return; }
    if (sha) knownSha[sha] = true;
    var row = headers.map(function () { return ''; });
    row[col.id] = docIdFor(file.id);
    row[col.kind] = kindFor(file, name);
    row[col.filename] = name;
    row[col.url] = file.url;
    row[col.sha256] = sha;
    row[col.caseNumber] = guessCaseNumber(name, file.folder);
    row[col.reviewNotes] = AUTO_NOTE;
    row[col.reviewStatus] = AUTO_STATUS;
    result.append.push(row);
  });
  return result;
}

/** Bare folder ID, or the ID inside a Drive folder URL. */
function folderIdFrom(value) {
  var s = String(value || '').trim();
  var m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  return m ? m[1] : s;
}

// ---------- 讀出報價單／發票內容（純函式，tests/document-extract.test.mjs） ----------

var QUOTE_SHEET = '報價版本', INVOICE_SHEET = '發票', CASE_SHEET = '案件商機';
var EXTRACT_NOTE = '自動匯入：金額由 PDF 文字讀出，請對照原件後再採用';
var EXTRACT_INVOICE_STATUS = '待核對';
var EXTRACT_LIMIT = 15;
var DASHBOARD_URL = 'https://sean0407.github.io/works-dashboard/';
var DEFAULT_TERM_DAYS = 30;

function normalizeText(text) {
  return String(text || '').normalize('NFKC').replace(/\$/g, '').replace(/\s+/g, ' ');
}
function amountFrom(match) {
  if (!match) return null;
  var n = Number(String(match[1]).replace(/,/g, ''));
  return isFinite(n) && n > 0 && Math.floor(n) === n ? n : null;
}
function isoDate(y, m, d) {
  var date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  var ok = date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
  return ok ? date.toISOString().slice(0, 10) : null;
}

/** 報價單文字 → {caseNumber, date, net, tax, gross, feeRate}; anything not found stays null. */
function extractQuote(text, filename) {
  var t = normalizeText(text);
  var net = amountFrom(/合計\s*\(未稅[^)]*\)\s*([\d,]+)/.exec(t));
  var taxMatch = /營業稅\s*\(\d+(?:\.\d+)?%\)\s*([\d,]+)(?:\s*([\d,]+))?/.exec(t);
  var tax = amountFrom(taxMatch);
  var gross = taxMatch && taxMatch[2] ? amountFrom([null, taxMatch[2]]) : null;
  if (net === null) {
    // Google's PDF conversion lists the five labels first and the five amounts after them.
    // Accept the run of numbers only when 小計＋服務費＝合計 and 合計＋營業稅＝總計.
    var at = t.search(/合計\s*\(未稅/), n = at < 0 ? [] : (t.slice(at, at + 400).match(/\d[\d,]*/g) || []).map(function (x) { return Number(x.replace(/,/g, '')); });
    for (var i = 0; i + 4 < n.length; i++) {
      if (n[i + 2] > 100 && Math.abs(n[i] + n[i + 1] - n[i + 2]) <= 2 && Math.abs(n[i + 2] + n[i + 3] - n[i + 4]) <= 2) { net = n[i + 2]; tax = n[i + 3]; gross = n[i + 4]; break; }
    }
  }
  if (net !== null && tax !== null && (gross === null || Math.abs(net + tax - gross) > 2)) gross = net + tax;
  var rate = /服務費\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)/.exec(t);
  var made = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*\/\s*\S*製表/.exec(t);
  var number = /專案編號\s*(A\d{3})(?!\d)/.exec(t) || /(?:^|[^A-Za-z0-9])(A\d{3})(?!\d)/.exec(String(filename || ''));
  var version = /V\s*(\d+)/i.exec(String(filename || ''));
  return {
    caseNumber: number ? number[1] : '', date: made ? isoDate(made[1], made[2], made[3]) : null,
    net: net, tax: tax, gross: gross, feeRate: rate ? Number(rate[1]) / 100 : null,
    version: version ? 'V' + version[1] : '', addition: /追加/.test(String(filename || ''))
  };
}

/** 電子發票證明聯文字 → {number, caseNumber, date, net, tax, gross}. */
function extractInvoice(text, filename) {
  var t = normalizeText(text), name = String(filename || '');
  var number = /發票號碼\s*:?\s*([A-Z]{2}\d{8})/.exec(t) || /(?:^|[^A-Za-z0-9])([A-Z]{2}\d{8})(?!\d)/.exec(name);
  var date = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  var net = amountFrom(/銷售額合計\s*([\d,]+)/.exec(t));
  var gross = amountFrom(/總計\s*([\d,]+)/.exec(t));
  var caseNumber = /(?:^|[^A-Za-z0-9])(A\d{3})(?!\d)/.exec(name);
  if (net !== null && (gross === null || gross < net || gross - net > net * 0.06)) {
    // Converted text can separate 總計 from its figure: take the tax and total that add up after 銷售額合計.
    var after = t.slice(t.indexOf('銷售額合計')), found = (after.match(/\d[\d,]*/g) || []).slice(1, 12).map(function (x) { return Number(x.replace(/,/g, '')); });
    gross = null;
    for (var a = 0; a < found.length && gross === null; a++) for (var b = 0; b < found.length; b++) {
      if (a !== b && found[a] > 0 && found[a] <= net * 0.06 && net + found[a] === found[b]) { gross = found[b]; break; }
    }
  }
  var consistent = net !== null && gross !== null && gross >= net && gross - net <= net * 0.06;
  return {
    number: number ? number[1] : '', caseNumber: caseNumber ? caseNumber[1] : '', date: date ? isoDate(date[1], date[2], date[3]) : null,
    net: net, tax: consistent ? gross - net : null, gross: consistent ? gross : null,
    type: /訂金/.test(name) ? '訂金' : /尾款/.test(name) ? '尾款' : /追加/.test(name) ? '追加' : /全款/.test(name) ? '全款' : ''
  };
}

/** 原案號 → 案件ID, preferring the original case over its additions. */
function caseIdsByNumber(caseValues) {
  var head = caseValues[0].map(function (h) { return String(h).trim(); });
  var id = head.indexOf('案件ID'), number = head.indexOf('原案號'), parent = head.indexOf('原案ID');
  var map = {};
  for (var i = 1; i < caseValues.length; i++) {
    var n = String(caseValues[i][number] || '').trim(), cid = String(caseValues[i][id] || '').trim();
    if (!n || !cid) continue;
    if (!map[n] || (parent >= 0 && !String(caseValues[i][parent] || '').trim())) map[n] = cid;
  }
  return map;
}

/**
 * Rows to append to 報價版本 or 發票 for newly imported documents.
 * docs: [{docId, kind, filename, fields}] where fields came from extractQuote / extractInvoice.
 * Skips a document already referenced in 來源文件ID, and an invoice whose number is already listed.
 */
function planRecordRows(kind, headers, rows, docs, caseIds) {
  var head = headers.map(function (h) { return String(h).trim(); });
  var col = function (name) { return head.indexOf(name); };
  var source = col('來源文件ID'), numberCol = col('發票號碼');
  var seen = {}, numbers = {};
  rows.forEach(function (r) { if (r[source]) seen[String(r[source]).trim()] = true; if (numberCol >= 0 && r[numberCol]) numbers[String(r[numberCol]).trim()] = true; });
  var out = [];
  docs.forEach(function (d) {
    var f = d.fields;
    if (d.kind !== kind || seen[d.docId]) return;
    if (kind === '發票' && (!f.number || numbers[f.number])) return;
    if (f.net === null && f.gross === null) return;
    var row = head.map(function () { return ''; });
    var set = function (name, value) { var i = col(name); if (i >= 0 && value !== null && value !== undefined && value !== '') row[i] = value; };
    var suffix = d.docId.replace(/^doc_/, '');
    set('案件ID', caseIds[f.caseNumber] || '');
    set('來源文件ID', d.docId);
    set('備註', EXTRACT_NOTE + (caseIds[f.caseNumber] ? '' : '；找不到案號 ' + (f.caseNumber || '（檔名無案號）') + '，請補案件ID'));
    if (kind === '報價單') {
      set('報價ID', 'quo_' + suffix); set('報價日', f.date); set('報價名稱', d.filename.replace(/\.[A-Za-z0-9]+$/, ''));
      set('版本', f.version); set('原案互補追加', f.addition ? '追加' : '');
      set('未稅金額', f.net); set('稅額', f.tax); set('含稅金額', f.gross); set('服務費率', f.feeRate);
    } else {
      set('發票ID', 'inv_' + suffix); set('發票號碼', f.number); set('開票日', f.date);
      set('銷售額', f.net); set('稅額', f.tax); set('含稅總額', f.gross);
      set('全款訂金尾款追加', f.type); set('發票狀態', EXTRACT_INVOICE_STATUS);
      numbers[f.number] = true;
    }
    seen[d.docId] = true;
    out.push(row);
  });
  return out;
}

// ---------- 每日摘要（純函式） ----------

function toIso(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return isNaN(value.getTime()) ? null : isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(String(value || '').trim());
  return m ? isoDate(m[1], m[2], m[3]) : null;
}
function addDaysIso(iso, days) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function isCollected(value) {
  return value === true || ['是', '已收', '已收款', 'y', 'yes', 'v', '✓', 'true'].indexOf(String(value == null ? '' : value).trim().toLowerCase()) >= 0;
}

/** {followups, activities, overdue, overdueTotal} for one day, from the raw sheet values (header row first). */
function buildDigest(caseValues, invoiceValues, today) {
  var ch = caseValues[0].map(function (h) { return String(h).trim(); });
  var c = function (row, name) { var i = ch.indexOf(name); return i < 0 ? '' : row[i]; };
  var numbers = {}, followups = [], activities = [], weekEnd = addDaysIso(today, 7);
  caseValues.slice(1).forEach(function (r) {
    var id = String(c(r, '案件ID') || '').trim(); if (!id) return;
    var label = String(c(r, '原案號') || '') + ' ' + String(c(r, '案名') || '');
    numbers[id] = label;
    var status = String(c(r, '商機狀態') || '').trim(), next = toIso(c(r, '下次追案日'));
    if (next && next <= today && ['已成交', '未成交', '取消'].indexOf(status) < 0) followups.push({ label: label, date: next, action: String(c(r, '下一步') || '') });
    var start = toIso(c(r, '活動開始日')), end = toIso(c(r, '活動結束日')) || start;
    if (start && ['未成交', '取消'].indexOf(status) < 0 && end >= today && start <= weekEnd) activities.push({ label: label, start: start, end: end });
  });
  var ih = invoiceValues[0].map(function (h) { return String(h).trim(); });
  var v = function (row, name) { var i = ih.indexOf(name); return i < 0 ? '' : row[i]; };
  var overdue = [];
  invoiceValues.slice(1).forEach(function (r) {
    if (String(v(r, '發票狀態') || '').trim() !== '有效' || isCollected(v(r, '已收款'))) return;
    var gross = Number(String(v(r, '含稅總額') || '').replace(/,/g, '')), issued = toIso(v(r, '開票日'));
    var due = toIso(v(r, '收款到期日')) || (issued ? addDaysIso(issued, DEFAULT_TERM_DAYS) : null);
    if (!due || due >= today || !isFinite(gross) || gross <= 0) return;
    overdue.push({ number: String(v(r, '發票號碼') || ''), label: numbers[String(v(r, '案件ID') || '').trim()] || '', due: due, gross: gross });
  });
  followups.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  activities.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  overdue.sort(function (a, b) { return a.due < b.due ? -1 : 1; });
  return { followups: followups, activities: activities, overdue: overdue, overdueTotal: overdue.reduce(function (t, o) { return t + o.gross; }, 0) };
}

/** Plain-text mail body; null when there is nothing to report. */
function digestBody(digest, today) {
  if (!digest.followups.length && !digest.activities.length && !digest.overdue.length) return null;
  var lines = ['沃克思每日摘要 ' + today, ''];
  lines.push('【今天該追】' + digest.followups.length + ' 案');
  digest.followups.forEach(function (f) { lines.push('・' + f.label + '（追案日 ' + f.date + '）' + (f.action ? '：' + f.action : '')); });
  lines.push('', '【未來 7 天活動】' + digest.activities.length + ' 場');
  digest.activities.forEach(function (a) { lines.push('・' + a.start + (a.end !== a.start ? ' ～ ' + a.end : '') + '　' + a.label); });
  lines.push('', '【逾期應收】' + digest.overdue.length + ' 張，合計 NT$ ' + Math.round(digest.overdueTotal).toLocaleString('en-US'));
  digest.overdue.slice(0, 20).forEach(function (o) { lines.push('・' + o.number + '　NT$ ' + Math.round(o.gross).toLocaleString('en-US') + '　到期 ' + o.due + (o.label ? '　' + o.label : '')); });
  if (digest.overdue.length > 20) lines.push('・⋯其餘 ' + (digest.overdue.length - 20) + ' 張請到儀表板查看');
  lines.push('', '儀表板：' + DASHBOARD_URL);
  return lines.join('\n');
}

// ---------- Apps Script runtime ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('沃克思')
    .addItem('匯入新文件', 'importDocuments')
    .addItem('安裝每小時自動匯入', 'installHourlyImport')
    .addSeparator()
    .addItem('讀出新文件的金額', 'extractRecords')
    .addItem('立即寄出今日摘要', 'sendDailyDigest')
    .addItem('安裝每日摘要信（早上 8 點）', 'installDailyDigest')
    .addToUi();
}

function installHourlyImport() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'importDocuments'; });
  if (!exists) ScriptApp.newTrigger('importDocuments').timeBased().everyHours(1).create();
  SpreadsheetApp.getActive().toast(exists ? '每小時自動匯入早已安裝。' : '已安裝：每小時會自動匯入一次。', '沃克思', 6);
}

function importDocuments() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var ss = SpreadsheetApp.getActive();
    var folders = readFolders_(ss);
    var sheet = ss.getSheetByName(DOC_SHEET);
    if (!sheet) throw new Error('找不到「' + DOC_SHEET + '」分頁。');
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var rows = data.slice(1);
    var files = [];
    folders.forEach(function (f) { collectFiles_(DriveApp.getFolderById(f.id), '', files, 0, f.kind); });
    var plan = planChanges(headers, rows, files, function (f) { return sha256Hex_(f.blob()); });
    plan.update.forEach(function (u) { sheet.getRange(u.row, 1, 1, headers.length).setValues([u.values.slice(0, headers.length)]); });
    if (plan.append.length) sheet.getRange(sheet.getLastRow() + 1, 1, plan.append.length, headers.length).setValues(plan.append);
    ss.toast('新增 ' + plan.append.length + ' 列、補上連結 ' + plan.update.length + ' 列' + (plan.duplicates ? '、略過重複檔案 ' + plan.duplicates + ' 個' : '') + '。', '沃克思文件匯入', 8);
    console.log('importDocuments: append=' + plan.append.length + ' update=' + plan.update.length + ' duplicates=' + plan.duplicates + ' skipped=' + plan.skipped);
    if (plan.append.length) extractRecords_(ss);
  } finally {
    lock.releaseLock();
  }
}

/** Pure: [{id, kind}] from the 設定 sheet values (header row first). */
function foldersFromSettings(values) {
  var head = values[0].map(function (h) { return String(h).trim(); });
  var keyCol = head.indexOf('設定項目'), valueCol = head.indexOf('設定值');
  var out = [];
  FOLDER_KEYS.forEach(function (spec) {
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][keyCol]).trim() !== spec.key) continue;
      var id = folderIdFrom(values[i][valueCol]);
      if (id) out.push({ id: id, kind: spec.kind });
    }
  });
  return out;
}

function readFolders_(ss) {
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) throw new Error('找不到「' + SETTINGS_SHEET + '」分頁。');
  var folders = foldersFromSettings(sheet.getDataRange().getValues());
  if (!folders.length) throw new Error('請在「設定」分頁新增 quotes_folder_id（報價單資料夾）和 invoices_folder_id（發票資料夾），設定值貼資料夾網址。');
  return folders;
}

function collectFiles_(folder, folderName, out, depth, kind) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!ACCEPTED_MIME.test(f.getMimeType())) continue;
    (function (file) {
      out.push({ id: file.getId(), name: file.getName(), url: file.getUrl(), folder: folderName, kind: kind, blob: function () { return file.getBlob(); } });
    })(f);
  }
  if (depth >= MAX_DEPTH) return;
  var sub = folder.getFolders();
  while (sub.hasNext()) {
    var child = sub.next();
    collectFiles_(child, child.getName(), out, depth + 1, kind);
  }
}

function sha256Hex_(blob) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, blob.getBytes())
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}


// ---------- 讀出金額並新增報價／發票列 ----------

function extractRecords() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try { extractRecords_(SpreadsheetApp.getActive()); } finally { lock.releaseLock(); }
}

/** Only documents this script imported (still 待核對 with the auto note) and not yet referenced are read. */
function extractRecords_(ss) {
  if (typeof Drive === 'undefined') { ss.toast('尚未加入「Drive API」服務，略過讀取金額。', '沃克思', 8); return; }
  var docSheet = ss.getSheetByName(DOC_SHEET), quoteSheet = ss.getSheetByName(QUOTE_SHEET), invoiceSheet = ss.getSheetByName(INVOICE_SHEET), caseSheet = ss.getSheetByName(CASE_SHEET);
  if (!docSheet || !quoteSheet || !invoiceSheet || !caseSheet) throw new Error('找不到文件、報價版本、發票或案件商機分頁。');
  var docValues = docSheet.getDataRange().getValues(), col = columnIndex(docValues[0]);
  var quoteValues = quoteSheet.getDataRange().getValues(), invoiceValues = invoiceSheet.getDataRange().getValues();
  var referenced = {};
  [quoteValues, invoiceValues].forEach(function (values) {
    var i = values[0].map(function (h) { return String(h).trim(); }).indexOf('來源文件ID');
    values.slice(1).forEach(function (r) { if (r[i]) referenced[String(r[i]).trim()] = true; });
  });
  var docs = [], failed = 0, firstBySha = {};
  for (var r = 1; r < docValues.length && docs.length < EXTRACT_LIMIT; r++) {
    var row = docValues[r], kind = String(row[col.kind] || '').trim(), docId = String(row[col.id] || '').trim();
    // A duplicate copy of an already registered file must not create a second quote or invoice row.
    var sha = String(row[col.sha256] || '').trim();
    if (sha) { if (firstBySha[sha]) continue; firstBySha[sha] = true; }
    if ((kind !== '報價單' && kind !== '發票') || !docId || referenced[docId]) continue;
    if (String(row[col.reviewStatus] || '').trim() !== AUTO_STATUS || String(row[col.reviewNotes] || '').indexOf(AUTO_NOTE) !== 0) continue;
    var fileId = driveFileIdFromUrl(row[col.url]); if (!fileId) continue;
    var name = String(row[col.filename] || '');
    try {
      var text = pdfText_(fileId);
      docs.push({ docId: docId, kind: kind, filename: name, fields: kind === '報價單' ? extractQuote(text, name) : extractInvoice(text, name) });
    } catch (e) { failed++; console.log('extractRecords: ' + name + ' 讀取失敗：' + e); }
  }
  var caseIds = caseIdsByNumber(caseSheet.getDataRange().getValues());
  var added = 0;
  [['報價單', quoteSheet, quoteValues], ['發票', invoiceSheet, invoiceValues]].forEach(function (spec) {
    var rows = planRecordRows(spec[0], spec[2][0], spec[2].slice(1), docs, caseIds).map(function (row, index) {
      // Date columns must be real dates so the dashboard can read them.
      return row.map(function (value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))) : value; });
    });
    if (rows.length) spec[1].getRange(spec[1].getLastRow() + 1, 1, rows.length, spec[2][0].length).setValues(rows);
    added += rows.length;
  });
  ss.toast('讀出並新增 ' + added + ' 列報價／發票（均標記待核對）' + (failed ? '；' + failed + ' 份讀取失敗' : '') + '。', '沃克思', 8);
  console.log('extractRecords: candidates=' + docs.length + ' added=' + added + ' failed=' + failed);
}

/** PDF → text through Drive's OCR conversion; the temporary Google Doc is trashed right away. */
function pdfText_(fileId) {
  var temp, name = 'tmp-ocr-' + fileId;
  if (Drive.Files.insert) {
    // Drive v2. Copy-and-convert first; if Google throttles that, upload the bytes with OCR instead.
    try { temp = Drive.Files.copy({ title: name }, fileId, { convert: true, ocr: true, ocrLanguage: 'zh-TW' }); }
    catch (e) {
      var blob = DriveApp.getFileById(fileId).getBlob();
      temp = Drive.Files.insert({ title: name, mimeType: blob.getContentType() }, blob, { ocr: true, ocrLanguage: 'zh-TW' });
    }
  } else {
    temp = Drive.Files.copy({ name: name, mimeType: 'application/vnd.google-apps.document' }, fileId, { ocrLanguage: 'zh-TW' });
  }
  try { return DocumentApp.openById(temp.id).getBody().getText(); }
  finally { DriveApp.getFileById(temp.id).setTrashed(true); }
}

// ---------- 每日摘要信 ----------

function installDailyDigest() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sendDailyDigest'; });
  if (!exists) ScriptApp.newTrigger('sendDailyDigest').timeBased().everyDays(1).atHour(8).create();
  SpreadsheetApp.getActive().toast(exists ? '每日摘要信早已安裝。' : '已安裝：每天早上 8 點左右寄出摘要信。', '沃克思', 6);
}

/** Recipient: 設定 `digest_email`, otherwise the account that installed the script. */
function sendDailyDigest() {
  var ss = SpreadsheetApp.getActive();
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var digest = buildDigest(ss.getSheetByName(CASE_SHEET).getDataRange().getValues(), ss.getSheetByName(INVOICE_SHEET).getDataRange().getValues(), today);
  var body = digestBody(digest, today);
  if (!body) return;
  var to = '';
  var settings = ss.getSheetByName(SETTINGS_SHEET);
  if (settings) settings.getDataRange().getValues().forEach(function (r) { if (String(r[0]).trim() === 'digest_email') to = String(r[1] || '').trim(); });
  MailApp.sendEmail(to || Session.getEffectiveUser().getEmail(), '沃克思每日摘要 ' + today + '｜該追 ' + digest.followups.length + '・活動 ' + digest.activities.length + '・逾期 ' + digest.overdue.length, body);
}


/** 檢查用：讀最新一份報價單與發票 PDF，把讀到的欄位寫進執行記錄，不會改動試算表。 */
function debugExtract() {
  var values = SpreadsheetApp.getActive().getSheetByName(DOC_SHEET).getDataRange().getValues(), col = columnIndex(values[0]);
  ['報價單', '發票'].forEach(function (kind) {
    for (var r = values.length - 1; r >= 1; r--) {
      var fileId = driveFileIdFromUrl(values[r][col.url]);
      if (String(values[r][col.kind]).trim() !== kind || !fileId) continue;
      var name = String(values[r][col.filename] || ''), text = pdfText_(fileId);
      var fields = kind === '報價單' ? extractQuote(text, name) : extractInvoice(text, name);
      console.log('debugExtract ' + kind + ': 第 ' + (r + 1) + ' 列，文字長度 ' + text.length + '，欄位 ' + JSON.stringify(fields));
      console.log('debugExtract ' + kind + ' 文字: ' + normalizeText(text).slice(0, 600));
      return;
    }
    console.log('debugExtract: 找不到有連結的' + kind);
  });
}

/** 檢查用：把今天的摘要內容寫進執行記錄，不寄信、不改動試算表。 */
function debugDigest() {
  var ss = SpreadsheetApp.getActive();
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var digest = buildDigest(ss.getSheetByName(CASE_SHEET).getDataRange().getValues(), ss.getSheetByName(INVOICE_SHEET).getDataRange().getValues(), today);
  console.log('debugDigest ' + today + ': 該追 ' + digest.followups.length + '、活動 ' + digest.activities.length + '、逾期 ' + digest.overdue.length + ' 張，合計 ' + Math.round(digest.overdueTotal));
  console.log(digestBody(digest, today) || '（三項都沒有，今天不會寄信）');
}
