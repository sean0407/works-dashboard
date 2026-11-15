/**
 * 沃克思｜自動把雲端資料夾裡的新文件登記到「文件」分頁。
 *
 * 安裝：在試算表「擴充功能 → Apps Script」貼上本檔全部內容並儲存，
 * 重新開啟試算表後，用「沃克思」選單執行。說明見 ADD-DATA-zh-TW.md。
 *
 * 這支程式只會：讀取指定資料夾的檔案清單與內容雜湊、在「文件」分頁新增列或補上空白的連結欄。
 * 不會刪除或改寫已填的資料，也不會動其他分頁。
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
  var linked = {}, knownIds = {}, unlinkedByName = {};
  rows.forEach(function (row, i) {
    var fid = driveFileIdFromUrl(row[col.url]);
    if (fid) linked[fid] = true;
    var id = String(row[col.id] || '').trim();
    if (id) knownIds[id] = true;
    var name = String(row[col.filename] || '').trim();
    if (name && !String(row[col.url] || '').trim() && !(name in unlinkedByName)) unlinkedByName[name] = i;
  });
  var result = { append: [], update: [], skipped: 0 };
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
    var row = headers.map(function () { return ''; });
    row[col.id] = docIdFor(file.id);
    row[col.kind] = kindFor(file, name);
    row[col.filename] = name;
    row[col.url] = file.url;
    row[col.sha256] = hash(file);
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

// ---------- Apps Script runtime ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('沃克思')
    .addItem('匯入新文件', 'importDocuments')
    .addItem('安裝每小時自動匯入', 'installHourlyImport')
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
    ss.toast('新增 ' + plan.append.length + ' 列、補上連結 ' + plan.update.length + ' 列。', '沃克思文件匯入', 8);
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
