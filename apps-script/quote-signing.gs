/**
 * 沃克思｜報價單寄送與簽回（第 1 期）。
 *
 * 和 document-import.gs 放在同一個 Apps Script 專案（新增一個指令碼檔案，貼上本檔全部內容）。
 * 必須由寄信的帳號安裝觸發器與部署網頁應用程式，信才會從該信箱寄出（目前為試算表擁有者 mamba20230501）。
 * 安裝步驟見 QUOTE-SIGNING-zh-TW.md。
 *
 * 分工（避免兩邊同時寫入互相覆蓋）：
 * - Claude 對話只「新增列」：報價版本、文件、簽署（簽署狀態 = 待寄送）。
 * - 本程式負責「待寄送」之後的所有狀態，以及簽回時寫入案件的欄位。
 *
 * 狀態：草稿 → 待寄送 → 已寄送 → 已檢視 → 已簽回／已拒絕／已過期；任何未完成的狀態都可能變成已作廢。
 *
 * 報價調整：
 * - 寄出後、簽回前改版：Claude 登記同案件的新版本；新版寄出時舊連結自動作廢，信件標明「更新版」。
 * - 簽回後改版：同案件新版本；簽回時填最新改版簽回日，新版成為有效成交版本，舊版改為否。
 * - 簽回後追加：另開追加案件（原案ID 指向原案件），獨立寄送與簽回，不影響原案件。
 */

var SIGN_SHEET = '簽署';
var SIGN_EVENT_SHEET = '簽署事件';
var SIGN_HEADERS = {
  id: '簽署ID', quoteId: '報價ID', caseId: '案件ID', sourceId: '來源文件ID',
  recipientName: '收件人姓名', recipientEmail: '收件人Email', cc: '副本',
  sha256: '原檔SHA256', status: '簽署狀態', tokenHash: 'token雜湊',
  sentAt: '寄送時間', dueDate: '到期日', viewedAt: '檢視時間', reminders: '提醒次數',
  signedAt: '簽回時間', signer: '簽署人', signerTitle: '職稱', signedDocId: '簽回文件ID',
  declineReason: '拒絕原因', notes: '備註'
};
var SIGN_EVENT_HEADERS = ['事件ID', '簽署ID', '事件類型', '時間', '觸發者', '瀏覽器資訊', '備註'];
var SIGN_STATUS = {
  draft: '草稿', queued: '待寄送', sent: '已寄送', viewed: '已檢視',
  signed: '已簽回', declined: '已拒絕', expired: '已過期', voided: '已作廢'
};
var OPEN_STATUSES = ['已寄送', '已檢視'];
var SIGN_VALID_WORKDAYS = 10;
var CASE_SIGN_HEADERS = {
  id: '案件ID', number: '原案號', status: '商機狀態', decisionDate: '成交決策日',
  signedSourceId: '簽回文件ID', revisionSignedDate: '最新改版簽回日',
  revisionSignedSourceId: '最新改版簽回文件ID', reviewNotes: '待核對事項'
};
var QUOTE_SIGN_HEADERS = {
  id: '報價ID', caseId: '案件ID', date: '報價日', title: '報價名稱', version: '版本', role: '原案互補追加',
  groupId: '報價組ID', gross: '含稅金額', effective: '有效成交版本'
};
var COMPANY_NAME = '沃克思國際有限公司';

// ---------- Pure logic (tested in tests/quote-signing.test.mjs) ----------

/** field -> column index for the given header spec. Throws naming the sheet when a header is missing. */
function headerIndex(headers, spec, sheetName) {
  var trimmed = headers.map(function (h) { return String(h == null ? '' : h).trim(); });
  var index = {};
  Object.keys(spec).forEach(function (key) {
    var i = trimmed.indexOf(spec[key]);
    if (i < 0) throw new Error('「' + sheetName + '」分頁找不到欄位「' + spec[key] + '」，請保留第 1 列欄名。');
    index[key] = i;
  });
  return index;
}

/** yyyy-mm-dd after adding n working days (Mon–Fri) to an ISO date. */
function addWorkingDays(iso, n) {
  var d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  var left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    var day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/** yyyy-mm-dd from a Date, an ISO string or a sheet value like 5/20/2026; '' when it is not a date. */
function isoDay(value) {
  if (value instanceof Date || (value && typeof value.getTime === 'function')) {
    if (isNaN(value.getTime())) return '';
    var y = value.getFullYear(), m = value.getMonth() + 1, d = value.getDate();
    return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
  }
  var s = String(value || '').trim();
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return iso[1] + '-' + ('0' + iso[2]).slice(-2) + '-' + ('0' + iso[3]).slice(-2);
  var us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);
  return '';
}

/** Rough but sufficient e-mail check for the recipient cell (one address). */
function isEmail(value) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(value || '').trim());
}

/**
 * What the send queue should do now.
 * rows: 簽署 data rows (row 2 onward); today: yyyy-mm-dd.
 * Returns {send: [rowIndex], void: [{index, by}], expire: [rowIndex], invalid: [{index, reason}]}.
 * A newer queued quote for the same case voids that case's links still open; open links past their due date expire.
 */
function planSendQueue(headers, rows, today) {
  var col = headerIndex(headers, SIGN_HEADERS, SIGN_SHEET);
  var plan = { send: [], void: [], expire: [], invalid: [] };
  var queuedCases = {};
  rows.forEach(function (row, i) {
    if (String(row[col.status]).trim() !== SIGN_STATUS.queued) return;
    var reason = '';
    if (!String(row[col.id]).trim()) reason = '缺少簽署ID';
    else if (!String(row[col.quoteId]).trim()) reason = '缺少報價ID';
    else if (!String(row[col.sourceId]).trim()) reason = '缺少來源文件ID';
    else if (!isEmail(row[col.recipientEmail])) reason = '收件人Email 格式不正確';
    if (reason) { plan.invalid.push({ index: i, reason: reason }); return; }
    plan.send.push(i);
    var caseId = String(row[col.caseId]).trim();
    if (caseId) queuedCases[caseId] = String(row[col.id]).trim();
  });
  rows.forEach(function (row, i) {
    var status = String(row[col.status]).trim();
    if (OPEN_STATUSES.indexOf(status) < 0) return;
    var caseId = String(row[col.caseId]).trim();
    if (caseId && queuedCases[caseId]) { plan.void.push({ index: i, by: queuedCases[caseId] }); return; }
    var due = isoDay(row[col.dueDate]);
    if (due && due < today) plan.expire.push(i);
  });
  return plan;
}

/**
 * The most recent earlier send for the same case (any status past 待寄送), or null.
 * Used to tell the client that a new e-mail replaces an earlier quote.
 */
function previousSendFor(headers, rows, index) {
  var col = headerIndex(headers, SIGN_HEADERS, SIGN_SHEET);
  var caseId = String(rows[index][col.caseId]).trim();
  if (!caseId) return null;
  var best = null;
  rows.forEach(function (row, i) {
    if (i === index || String(row[col.caseId]).trim() !== caseId) return;
    var status = String(row[col.status]).trim();
    if (status === SIGN_STATUS.queued || status === SIGN_STATUS.draft || !row[col.sentAt]) return;
    var sent = isoDay(row[col.sentAt]);
    if (!best || sent > best.sentDay) best = { id: String(row[col.id]).trim(), sentDay: sent, status: status };
  });
  return best;
}

/**
 * 有效成交版本 after a quote is signed: the signed quote becomes 是, and any other 是 quote of the same
 * case and the same 報價組ID becomes 否 (a revision replaces it). 互補 quotes are left alone because a
 * complementary bundle is meant to have several effective quotes.
 * Returns [{index, value}] for rows that change.
 */
function planEffectiveQuotes(headers, rows, caseId, quoteId) {
  var col = headerIndex(headers, QUOTE_SIGN_HEADERS, '報價版本');
  var signed = -1;
  rows.forEach(function (r, i) { if (String(r[col.id]).trim() === quoteId) signed = i; });
  if (signed < 0) return [];
  var group = String(rows[signed][col.groupId] || '').trim();
  var changes = [];
  rows.forEach(function (r, i) {
    var yesNow = r[col.effective] === true || String(r[col.effective]).trim() === '是';
    if (i === signed) { if (!yesNow) changes.push({ index: i, value: '是' }); return; }
    if (String(r[col.caseId]).trim() !== caseId || !yesNow) return;
    if (String(r[col.groupId] || '').trim() !== group) return;
    if (String(r[col.role]).trim() === '互補') return;
    changes.push({ index: i, value: '否' });
  });
  return changes;
}

/** Index of the 簽署 row whose token hash matches, or -1. */
function findSignatureByTokenHash(headers, rows, tokenHash) {
  if (!tokenHash) return -1;
  var col = headerIndex(headers, SIGN_HEADERS, SIGN_SHEET);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][col.tokenHash]).trim() === tokenHash) return i;
  }
  return -1;
}

/** What the signing page should show for a row in this status. */
function pageStateFor(status, due, today) {
  status = String(status || '').trim();
  if (status === SIGN_STATUS.signed) return 'signed';
  if (status === SIGN_STATUS.voided) return 'voided';
  if (status === SIGN_STATUS.declined) return 'declined';
  if (status === SIGN_STATUS.expired) return 'expired';
  if (OPEN_STATUSES.indexOf(status) < 0) return 'invalid';
  if (due && due < today) return 'expired';
  return 'open';
}

/**
 * Case fields to write when a quote comes back signed. Only fills blank cells; a cell that already
 * holds a different value is left alone and reported in 待核對事項.
 * First signature: 簽回文件ID, 成交決策日, 商機狀態=已成交.
 * Case already signed (both 簽回文件ID and 成交決策日 present): 最新改版簽回日 + 最新改版簽回文件ID.
 * Returns {set: {field: value}, conflicts: [text], revision: bool}.
 */
function planSignedCase(headers, row, signedDay, signedDocId) {
  var col = headerIndex(headers, CASE_SIGN_HEADERS, '案件商機');
  var cell = function (k) { return row[col[k]]; };
  var filled = function (k) { var v = cell(k); return v !== '' && v != null && !(typeof v === 'string' && !v.trim()); };
  var set = {}, conflicts = [];
  var put = function (k, value) {
    if (!filled(k)) { set[k] = value; return; }
    var existing = col[k] === undefined ? '' : (k === 'decisionDate' || k === 'revisionSignedDate' ? isoDay(cell(k)) : String(cell(k)).trim());
    if (existing !== value) conflicts.push(CASE_SIGN_HEADERS[k] + '已有「' + existing + '」，線上簽回為「' + value + '」');
  };
  var revision = filled('signedSourceId') && filled('decisionDate') && String(cell('signedSourceId')).trim() !== signedDocId;
  if (revision) {
    put('revisionSignedDate', signedDay);
    put('revisionSignedSourceId', signedDocId);
  } else {
    put('signedSourceId', signedDocId);
    put('decisionDate', signedDay);
    var status = String(cell('status') || '').trim();
    if (status !== '已成交') {
      if (!status || ['需求接洽', '準備報價', '已報價待確認', '待核對'].indexOf(status) >= 0) set.status = '已成交';
      else conflicts.push('商機狀態為「' + status + '」，線上簽回後請確認是否改為已成交');
    }
  }
  return { set: set, conflicts: conflicts, revision: revision };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function formatTwd(value) {
  var n = Number(String(value == null ? '' : value).replace(/[^\d.-]/g, ''));
  return isFinite(n) && String(value).trim() !== '' ? 'NT$ ' + Math.round(n).toLocaleString('en-US') : '';
}

/** Subject, plain text and HTML of the e-mail that carries the signing link. */
function buildSignEmail(info) {
  var subject = '【' + COMPANY_NAME + '】報價單' + (info.replaces ? '更新版' : '') + '簽署：' + info.title;
  var greet = info.recipientName ? info.recipientName + ' 您好：' : '您好：';
  var amount = formatTwd(info.gross);
  var replaces = info.replaces ? '這份報價取代 ' + info.replaces + ' 寄出的版本，先前的確認連結已失效。' : '';
  var text = [
    greet, '',
    '附件是「' + info.title + '」報價單' + (amount ? '（含稅總計 ' + amount + '）' : '') + '。',
  ].concat(replaces ? [replaces] : []).concat([
    '請點以下連結確認報價內容：', info.link, '',
    '連結有效期限至 ' + info.due + '。如有任何問題，直接回覆這封信即可。', '',
    COMPANY_NAME
  ]).join('\n');
  var html = '<p>' + escapeHtml(greet) + '</p>' +
    '<p>附件是「' + escapeHtml(info.title) + '」報價單' + (amount ? '（含稅總計 ' + escapeHtml(amount) + '）' : '') + '。</p>' +
    (replaces ? '<p><b>' + escapeHtml(replaces) + '</b></p>' : '') +
    '<p><a href="' + escapeHtml(info.link) + '" style="display:inline-block;padding:10px 18px;background:#e8743b;color:#fff;border-radius:6px;text-decoration:none">開啟報價單簽署頁</a></p>' +
    '<p style="color:#666">連結有效期限至 ' + escapeHtml(info.due) + '。如有任何問題，直接回覆這封信即可。</p>' +
    '<p>' + COMPANY_NAME + '</p>';
  return { subject: subject, text: text, html: html };
}

// ---------- Apps Script runtime ----------

/** Menu items; onOpen in document-import.gs adds them when this file is installed. */
function addSigningMenu_(menu) {
  return menu.addSeparator()
    .addItem('安裝報價簽署（建立分頁、每 5 分鐘寄送）', 'installSigning')
    .addItem('立即寄出待寄送報價', 'processSendQueue')
    .addItem('標記報價已簽回…', 'markSignedFromMenu')
    .addItem('作廢簽署連結…', 'voidSignatureFromMenu');
}

function installSigning() {
  var ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, SIGN_SHEET, Object.keys(SIGN_HEADERS).map(function (k) { return SIGN_HEADERS[k]; }));
  ensureSheet_(ss, SIGN_EVENT_SHEET, SIGN_EVENT_HEADERS);
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'processSendQueue'; });
  if (!exists) ScriptApp.newTrigger('processSendQueue').timeBased().everyMinutes(5).create();
  var url = webAppUrl_();
  ss.toast((exists ? '寄送排程早已安裝。' : '已安裝：每 5 分鐘寄出待寄送的報價。') +
    (url ? '' : '尚未設定 sign_webapp_url，請先部署網頁應用程式。'), '沃克思報價簽署', 10);
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** The deployed /exec URL from 設定 sign_webapp_url, else the running deployment's URL. */
function webAppUrl_() {
  var fromSettings = settingValue_('sign_webapp_url');
  if (fromSettings) return fromSettings;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function settingValue_(key) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET);
  if (!sheet) return '';
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) if (String(values[i][0]).trim() === key) return String(values[i][1] || '').trim();
  return '';
}

function withSignLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('另一個寫入正在進行，請稍後再試。');
  try { return fn(); } finally { lock.releaseLock(); }
}

function signTable_(ss) {
  var sheet = ss.getSheetByName(SIGN_SHEET);
  if (!sheet) throw new Error('找不到「' + SIGN_SHEET + '」分頁，請先執行「安裝報價簽署」。');
  var data = sheet.getDataRange().getValues();
  return { sheet: sheet, headers: data[0], rows: data.slice(1), col: headerIndex(data[0], SIGN_HEADERS, SIGN_SHEET) };
}

function writeSignRow_(table, index) {
  table.sheet.getRange(index + 2, 1, 1, table.headers.length).setValues([table.rows[index].slice(0, table.headers.length)]);
}

function logSignEvent_(ss, signId, type, actor, agent, note) {
  var sheet = ss.getSheetByName(SIGN_EVENT_SHEET) || ensureSheet_(ss, SIGN_EVENT_SHEET, SIGN_EVENT_HEADERS);
  sheet.appendRow(['evt_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), signId, type, new Date(), actor || '', agent || '', note || '']);
}

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function sha256Text_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Map of 文件ID -> Drive file ID from the 文件 sheet. */
function documentFileIds_(ss) {
  var data = ss.getSheetByName(DOC_SHEET).getDataRange().getValues();
  var col = columnIndex(data[0]);
  var out = {};
  data.slice(1).forEach(function (r) {
    var id = String(r[col.id]).trim();
    if (id) out[id] = driveFileIdFromUrl(r[col.url]);
  });
  return out;
}

/** 報價ID -> {title, date, gross} from 報價版本. */
function quoteInfo_(ss, quoteId) {
  var data = ss.getSheetByName('報價版本').getDataRange().getValues();
  var col = headerIndex(data[0], QUOTE_SIGN_HEADERS, '報價版本');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col.id]).trim() === quoteId) {
      return { title: String(data[i][col.title]).trim(), date: isoDay(data[i][col.date]), gross: data[i][col.gross], row: i + 1, col: col };
    }
  }
  return null;
}

function processSendQueue() {
  withSignLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var table = signTable_(ss);
    var col = table.col, today = todayIso_();
    var plan = planSendQueue(table.headers, table.rows, today);
    plan.invalid.forEach(function (p) {
      var row = table.rows[p.index];
      if (String(row[col.notes]).indexOf(p.reason) >= 0) return;
      row[col.notes] = (String(row[col.notes] || '') + ' 無法寄送：' + p.reason).trim();
      writeSignRow_(table, p.index);
    });
    plan.void.forEach(function (v) {
      table.rows[v.index][col.status] = SIGN_STATUS.voided;
      writeSignRow_(table, v.index);
      logSignEvent_(ss, table.rows[v.index][col.id], '作廢', 'system', '', '同案件新版報價 ' + v.by + ' 寄出');
    });
    plan.expire.forEach(function (i) {
      table.rows[i][col.status] = SIGN_STATUS.expired;
      writeSignRow_(table, i);
      logSignEvent_(ss, table.rows[i][col.id], '過期', 'system', '', '');
    });
    if (!plan.send.length) return;
    var url = webAppUrl_();
    if (!url) throw new Error('尚未設定 sign_webapp_url：請先部署網頁應用程式，並把網址填入「設定」分頁。');
    var files = documentFileIds_(ss);
    plan.send.forEach(function (i) {
      var row = table.rows[i];
      var signId = String(row[col.id]).trim();
      try {
        var fileId = files[String(row[col.sourceId]).trim()];
        if (!fileId) throw new Error('「文件」分頁找不到來源文件 ' + row[col.sourceId] + ' 的連結');
        var blob = DriveApp.getFileById(fileId).getBlob();
        var expected = String(row[col.sha256] || '').trim().toLowerCase();
        if (expected && sha256Hex_(blob) !== expected) throw new Error('PDF 內容與原檔SHA256 不符，可能已被修改');
        var quote = quoteInfo_(ss, String(row[col.quoteId]).trim());
        if (!quote) throw new Error('「報價版本」找不到報價 ' + row[col.quoteId]);
        var token = newToken_();
        var due = addWorkingDays(today, SIGN_VALID_WORKDAYS);
        var prev = previousSendFor(table.headers, table.rows, i);
        var mail = buildSignEmail({ title: quote.title, gross: quote.gross, recipientName: row[col.recipientName], link: url + '?t=' + token, due: due, replaces: prev ? prev.sentDay : '' });
        var options = { htmlBody: mail.html, attachments: [blob.setName(quote.title + '.pdf')], name: COMPANY_NAME };
        if (String(row[col.cc] || '').trim()) options.cc = String(row[col.cc]).trim();
        GmailApp.sendEmail(String(row[col.recipientEmail]).trim(), mail.subject, mail.text, options);
        row[col.status] = SIGN_STATUS.sent;
        row[col.tokenHash] = sha256Text_(token);
        row[col.sentAt] = new Date();
        row[col.dueDate] = due;
        row[col.reminders] = 0;
        writeSignRow_(table, i);
        logSignEvent_(ss, signId, '寄送', Session.getEffectiveUser().getEmail(), '', '寄給 ' + row[col.recipientEmail]);
      } catch (e) {
        row[col.notes] = ('寄送失敗：' + e.message).slice(0, 300);
        writeSignRow_(table, i);
        logSignEvent_(ss, signId, '寄送失敗', 'system', '', e.message);
      }
    });
  });
}

/** Signing page. Phase 1: quote summary + PDF download; the client confirms by replying to the e-mail. */
function doGet(e) {
  var token = String((e && e.parameter && e.parameter.t) || '');
  var view = { state: 'invalid' };
  if (/^[0-9a-f]{64}$/.test(token)) {
    view = withSignLock_(function () { return openSignature_(token); });
  }
  return HtmlService.createHtmlOutput(signPageHtml_(view, token))
    .setTitle('報價單確認｜' + COMPANY_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function openSignature_(token) {
  var ss = SpreadsheetApp.getActive();
  var table = signTable_(ss);
  var col = table.col;
  var i = findSignatureByTokenHash(table.headers, table.rows, sha256Text_(token));
  if (i < 0) return { state: 'invalid' };
  var row = table.rows[i];
  var state = pageStateFor(row[col.status], isoDay(row[col.dueDate]), todayIso_());
  if (state === 'expired' && String(row[col.status]).trim() !== SIGN_STATUS.expired) {
    row[col.status] = SIGN_STATUS.expired;
    writeSignRow_(table, i);
    logSignEvent_(ss, row[col.id], '過期', 'system', '', '開啟時已逾期');
  }
  if (state === 'open' && String(row[col.status]).trim() === SIGN_STATUS.sent) {
    row[col.status] = SIGN_STATUS.viewed;
    row[col.viewedAt] = new Date();
    writeSignRow_(table, i);
    logSignEvent_(ss, row[col.id], '檢視', String(row[col.recipientEmail]), '', '');
  }
  var quote = quoteInfo_(ss, String(row[col.quoteId]).trim()) || {};
  return { state: state, title: quote.title || '', date: quote.date || '', gross: quote.gross, due: isoDay(row[col.dueDate]), recipientName: row[col.recipientName] };
}

/** Called from the page: the quote PDF as base64, only while the link is open. */
function downloadQuotePdf(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new Error('連結無效');
  var ss = SpreadsheetApp.getActive();
  var table = signTable_(ss);
  var col = table.col;
  var i = findSignatureByTokenHash(table.headers, table.rows, sha256Text_(token));
  if (i < 0) throw new Error('連結無效');
  var row = table.rows[i];
  var state = pageStateFor(row[col.status], isoDay(row[col.dueDate]), todayIso_());
  if (state !== 'open' && state !== 'signed') throw new Error('這個連結已無法下載');
  var fileId = documentFileIds_(ss)[String(row[col.sourceId]).trim()];
  var blob = DriveApp.getFileById(fileId).getBlob();
  var quote = quoteInfo_(ss, String(row[col.quoteId]).trim()) || {};
  return { name: (quote.title || '報價單') + '.pdf', data: Utilities.base64Encode(blob.getBytes()) };
}

function signPageHtml_(view, token) {
  var messages = {
    invalid: '這個連結無效。請確認網址完整，或回覆原信件與我們聯絡。',
    voided: '這份報價已有更新版本，這個連結已失效。請以最新寄出的報價單為準。',
    expired: '這個連結已過期。如仍需要這份報價，請回覆原信件與我們聯絡。',
    declined: '您已婉拒這份報價。如有變更，請回覆原信件與我們聯絡。',
    signed: '這份報價已完成簽回，謝謝您。'
  };
  var css = 'body{font-family:-apple-system,"Microsoft JhengHei","PingFang TC",sans-serif;margin:0;background:#f6f6f4;color:#222}' +
    '.card{max-width:560px;margin:24px auto;background:#fff;border-radius:10px;padding:24px 20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
    'h1{font-size:20px;margin:0 0 4px}.muted{color:#666;font-size:14px}table{width:100%;border-collapse:collapse;margin:16px 0}' +
    'td{padding:8px 0;border-bottom:1px solid #eee}td:first-child{color:#666;width:96px}' +
    'button{background:#e8743b;color:#fff;border:0;border-radius:6px;padding:12px 18px;font-size:16px;width:100%;cursor:pointer}' +
    '.note{background:#fdf1ea;border-radius:6px;padding:12px;font-size:14px;margin-top:16px}';
  var body;
  if (view.state !== 'open') {
    body = '<h1>報價單確認</h1><p>' + escapeHtml(messages[view.state] || messages.invalid) + '</p>';
  } else {
    body = '<h1>' + escapeHtml(view.title) + '</h1><div class="muted">' + COMPANY_NAME + '</div>' +
      '<table><tr><td>報價日</td><td>' + escapeHtml(view.date) + '</td></tr>' +
      '<tr><td>含稅總計</td><td><b>' + escapeHtml(formatTwd(view.gross)) + '</b></td></tr>' +
      '<tr><td>有效期限</td><td>' + escapeHtml(view.due) + '</td></tr></table>' +
      '<button id="dl" onclick="dl()">下載報價單 PDF</button>' +
      '<div class="note">確認內容無誤後，請直接回覆寄給您的信件告知「確認簽回」。線上簽名功能即將開放。</div>' +
      '<script>function dl(){var b=document.getElementById("dl");b.disabled=true;b.textContent="準備中…";' +
      'google.script.run.withSuccessHandler(function(f){var bin=atob(f.data),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);' +
      'var u=URL.createObjectURL(new Blob([a],{type:"application/pdf"}));var l=document.createElement("a");l.href=u;l.download=f.name;document.body.appendChild(l);l.click();' +
      'b.disabled=false;b.textContent="下載報價單 PDF";}).withFailureHandler(function(e){b.disabled=false;b.textContent=e.message;})' +
      '.downloadQuotePdf(' + JSON.stringify(token) + ');}</script>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div class="card">' + body + '</div></body></html>';
}

/** Menu: mark a quote signed (client replied by e-mail). Writes the case fields by the same rules phase 2 will use. */
function markSignedFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('標記報價已簽回', '輸入簽署ID（sig_ 開頭）：', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var b = ui.prompt('簽回文件ID', '客戶簽回檔在「文件」分頁的文件ID（doc_ 開頭）。\n回信確認沒有附檔時，填原報價單的文件ID。', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  var result = withSignLock_(function () { return markSigned_(a.getResponseText().trim(), b.getResponseText().trim(), Session.getActiveUser().getEmail() || 'owner'); });
  ui.alert(result);
}

function markSigned_(signId, docId, actor) {
  var ss = SpreadsheetApp.getActive();
  var table = signTable_(ss);
  var col = table.col;
  var i = -1;
  table.rows.forEach(function (r, k) { if (String(r[col.id]).trim() === signId) i = k; });
  if (i < 0) return '找不到簽署ID ' + signId;
  if (!/^doc_/.test(docId)) return '簽回文件ID 須為 doc_ 開頭';
  var row = table.rows[i];
  if (String(row[col.status]).trim() === SIGN_STATUS.signed) return signId + ' 已經是已簽回。';
  var day = todayIso_();
  row[col.status] = SIGN_STATUS.signed;
  row[col.signedAt] = new Date();
  row[col.signedDocId] = docId;
  writeSignRow_(table, i);
  logSignEvent_(ss, signId, '簽回', actor, '', '手動標記，簽回文件 ' + docId);
  var caseNote = applySignedToCase_(ss, String(row[col.caseId]).trim(), String(row[col.quoteId]).trim(), day, docId);
  return signId + ' 已標記為已簽回。' + caseNote;
}

/** Writes the case + quote fields for a signed quote. Returns a short report. */
function applySignedToCase_(ss, caseId, quoteId, day, docId) {
  var sheet = ss.getSheetByName('案件商機');
  var data = sheet.getDataRange().getValues();
  var col = headerIndex(data[0], CASE_SIGN_HEADERS, '案件商機');
  var r = -1;
  for (var k = 1; k < data.length; k++) if (String(data[k][col.id]).trim() === caseId) { r = k; break; }
  if (r < 0) return '「案件商機」找不到案件 ' + caseId + '，請手動補上簽回欄位。';
  var plan = planSignedCase(data[0], data[r], day, docId);
  Object.keys(plan.set).forEach(function (key) {
    var value = /Date$/.test(key) ? new Date(plan.set[key] + 'T00:00:00') : plan.set[key];
    sheet.getRange(r + 1, col[key] + 1).setValue(value);
  });
  if (plan.conflicts.length) {
    var prev = String(data[r][col.reviewNotes] || '').trim();
    sheet.getRange(r + 1, col.reviewNotes + 1).setValue((prev ? prev + '；' : '') + '線上簽回 ' + day + '：' + plan.conflicts.join('；'));
  }
  var qSheet = ss.getSheetByName('報價版本');
  var qData = qSheet.getDataRange().getValues();
  var qCol = headerIndex(qData[0], QUOTE_SIGN_HEADERS, '報價版本');
  var effective = planEffectiveQuotes(qData[0], qData.slice(1), caseId, quoteId);
  effective.forEach(function (c) { qSheet.getRange(c.index + 2, qCol.effective + 1).setValue(c.value); });
  var replaced = effective.filter(function (c) { return c.value === '否'; }).length;
  return (plan.revision ? '案件已有原簽回，已填最新改版簽回欄位，原成交決策日不變。' : '已寫入案件簽回文件ID與成交決策日。') +
    (replaced ? '新版設為有效成交版本，' + replaced + ' 份舊版改為否。' : '') +
    (plan.conflicts.length ? '有 ' + plan.conflicts.length + ' 項與既有資料不同，已記在待核對事項。' : '');
}

function voidSignatureFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('作廢簽署連結', '輸入簽署ID（sig_ 開頭）：', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var signId = a.getResponseText().trim();
  var msg = withSignLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var table = signTable_(ss);
    var col = table.col;
    for (var i = 0; i < table.rows.length; i++) {
      if (String(table.rows[i][col.id]).trim() !== signId) continue;
      var status = String(table.rows[i][col.status]).trim();
      if ([SIGN_STATUS.queued, SIGN_STATUS.sent, SIGN_STATUS.viewed, SIGN_STATUS.draft].indexOf(status) < 0) return signId + ' 狀態為' + status + '，不能作廢。';
      table.rows[i][col.status] = SIGN_STATUS.voided;
      writeSignRow_(table, i);
      logSignEvent_(ss, signId, '作廢', Session.getActiveUser().getEmail() || 'owner', '', '手動作廢');
      return signId + ' 已作廢，連結立即失效。';
    }
    return '找不到簽署ID ' + signId;
  });
  ui.alert(msg);
}
