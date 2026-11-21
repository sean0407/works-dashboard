/**
 * 沃克思｜報價單寄送與線上簽回。
 *
 * 和 document-import.gs 放在同一個 Apps Script 專案（新增一個指令碼檔案，貼上本檔全部內容）。
 * 必須由寄信的帳號安裝觸發器與部署網頁應用程式，信才會從該信箱寄出（應為試算表擁有者）。
 * 安裝步驟見 QUOTE-SIGNING-zh-TW.md。
 *
 * 分工（避免兩邊同時寫入互相覆蓋）：
 * - Claude 對話只「新增列」：報價版本、文件、簽署。信由 Claude 用當下連接的 Gmail 建立草稿，老闆決定是否寄出；
 *   Claude 自己產生連結的 token，簽署列直接寫成「已寄送」，並填好 token雜湊（token 的 SHA256）、寄送時間、到期日。
 * - 本程式負責之後的所有狀態（檢視、簽回、過期、作廢），以及簽回時寫入案件的欄位。
 * - 簽署狀態寫「待寄送」的列仍會由本程式從安裝者的 Gmail 自動寄出（備用路徑，Claude 流程不使用）。
 *
 * 狀態：草稿 → 待寄送 → 寄送中 → 已寄送 → 已檢視 → 已簽回／已拒絕／已過期；任何未完成的狀態都可能變成已作廢。
 * 寄送中：寄信前先寫入，信寄出後才改已寄送；執行中斷時留在這個狀態，不會自動重寄（避免客戶收到重複信）。
 * 寄送失敗：連續 3 次寄不出去，或上次寄送中斷。確認原因後用選單「重新寄出寄送失敗的報價」放回佇列。
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
  draft: '草稿', queued: '待寄送', sending: '寄送中', failed: '寄送失敗', sent: '已寄送', viewed: '已檢視',
  signed: '已簽回', declined: '已拒絕', expired: '已過期', voided: '已作廢'
};
var OPEN_STATUSES = ['已寄送', '已檢視'];
var SIGN_VALID_WORKDAYS = 10;
var SIGN_MAX_SEND_ATTEMPTS = 3;
var SIGN_IMAGE_MAX_BASE64 = 600000;
var SIGNED_DOC_KIND = '簽回';
/** Statuses a quote can be marked signed from. 已過期 is allowed: a client may reply after the link lapsed. */
var SIGNABLE_STATUSES = ['已寄送', '已檢視', '已過期'];
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
 * Returns {send: [rowIndex], void: [{index, by, caseId}], expire: [rowIndex], invalid: [{index, reason}], interrupted: [rowIndex]}.
 * A newer queued quote for the same case voids that case's links still open, but only once the new one has
 * actually been sent: the caller applies a void entry after a successful send for its caseId (see voidsForCase).
 * Open links past their due date expire. Rows left in 寄送中 come from a run that died mid-send.
 */
function planSendQueue(headers, rows, today) {
  var col = headerIndex(headers, SIGN_HEADERS, SIGN_SHEET);
  var plan = { send: [], void: [], expire: [], invalid: [], interrupted: [] };
  var queuedCases = {};
  rows.forEach(function (row, i) {
    if (String(row[col.status]).trim() === SIGN_STATUS.sending) { plan.interrupted.push(i); return; }
    if (String(row[col.status]).trim() !== SIGN_STATUS.queued) return;
    var reason = '';
    if (!String(row[col.id]).trim()) reason = '缺少簽署ID';
    else if (!String(row[col.quoteId]).trim()) reason = '缺少報價ID';
    else if (!String(row[col.caseId]).trim()) reason = '缺少案件ID';
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
    if (caseId && queuedCases[caseId]) { plan.void.push({ index: i, by: queuedCases[caseId], caseId: caseId }); return; }
    var due = isoDay(row[col.dueDate]);
    if (due && due < today) plan.expire.push(i);
  });
  return plan;
}

/** 報價ID -> key of the quotes that replace one another: same case and 報價組ID. A 互補 quote only replaces itself. */
function quoteGroupKeys(headers, rows) {
  var col = headerIndex(headers, QUOTE_SIGN_HEADERS, '報價版本');
  var keys = {};
  rows.forEach(function (r) {
    var id = String(r[col.id]).trim();
    if (!id) return;
    keys[id] = String(r[col.role]).trim() === '互補' ? 'quote|' + id
      : String(r[col.caseId]).trim() + '|' + String(r[col.groupId] || '').trim();
  });
  return keys;
}

function signTime_(value, fallback) {
  if (value && typeof value.getTime === 'function' && !isNaN(value.getTime())) return value.getTime();
  var t = Date.parse(String(value || ''));
  return isNaN(t) ? fallback : t;
}

/**
 * Open links replaced by a later one. Among the rows of one quote group that reached the client
 * (已寄送／已檢視／已簽回), every 已寄送／已檢視 row older than the newest is void. Returns [{index, by}].
 * Rows whose quote is unknown fall back to grouping by 案件ID.
 */
function planSuperseded(headers, rows, keys) {
  var col = headerIndex(headers, SIGN_HEADERS, SIGN_SHEET);
  var newest = {}, live = [];
  rows.forEach(function (row, i) {
    var status = String(row[col.status]).trim();
    if (OPEN_STATUSES.indexOf(status) < 0 && status !== SIGN_STATUS.signed) return;
    var caseId = String(row[col.caseId]).trim();
    var key = (keys || {})[String(row[col.quoteId]).trim()] || (caseId ? caseId + '|' : '');
    if (!key) return;
    var entry = { index: i, key: key, time: signTime_(row[col.sentAt], 0), open: status !== SIGN_STATUS.signed };
    live.push(entry);
    var best = newest[key];
    if (!best || entry.time > best.time || (entry.time === best.time && i > best.index)) newest[key] = entry;
  });
  return live.filter(function (e) { return e.open && newest[e.key].index !== e.index; })
    .map(function (e) { return { index: e.index, by: String(rows[newest[e.key].index][col.id]).trim() }; });
}

/** Void entries of the plan to apply now that a quote for caseId has been sent. */
function voidsForCase(plan, caseId) {
  return caseId ? plan.void.filter(function (v) { return v.caseId === caseId; }) : [];
}

/**
 * 備註 after a failed send. Keeps whatever was in the cell and replaces the previous failure marker.
 * Returns {notes, attempts, giveUp}; giveUp once the attempts reach max.
 */
function sendFailureNote(notes, message, max) {
  var marker = /\s*｜?寄送失敗 (\d+)\/\d+：[\s\S]*$/;
  var text = String(notes == null ? '' : notes);
  var m = marker.exec(text);
  var attempts = (m ? Number(m[1]) : 0) + 1;
  var base = text.replace(marker, '').trim();
  var note = '寄送失敗 ' + attempts + '/' + max + '：' + String(message || '').slice(0, 200);
  return { notes: base ? base + ' ｜' + note : note, attempts: attempts, giveUp: attempts >= max };
}

/** 備註 with the failure marker removed (after a successful send or a manual retry). */
function clearSendFailureNote(notes) {
  return String(notes == null ? '' : notes).replace(/\s*｜?寄送失敗 (\d+)\/\d+：[\s\S]*$/, '').trim();
}

/** '' when a row in this status may be marked signed, else why not. */
function signBlockReason(status) {
  status = String(status || '').trim();
  if (SIGNABLE_STATUSES.indexOf(status) >= 0) return '';
  if (status === SIGN_STATUS.voided) return '這個連結已作廢（通常是已寄出新版），請改標記最新版本的簽署ID。';
  return '狀態為「' + (status || '空白') + '」，報價尚未寄達客戶，不能標記已簽回。';
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
  // A link must carry a readable expiry; without one it would stay signable for ever.
  if (!due) return 'invalid';
  if (due < today) return 'expired';
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

/**
 * Checks what the signing page submitted. Returns {error} or the cleaned {name, title, imageBase64, agent}.
 * The signature must be a PNG data URL drawn on the page; the consent box must be ticked.
 */
function validateSignature(payload) {
  var p = payload || {};
  var name = String(p.name || '').trim(), title = String(p.title || '').trim();
  if (!name) return { error: '請填寫簽署人姓名。' };
  if (name.length > 60 || title.length > 60) return { error: '姓名或職稱過長。' };
  if (p.consent !== true) return { error: '請勾選同意以電子簽名確認本報價單。' };
  var m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(p.image || ''));
  if (!m || m[1].length < 200) return { error: '請先在簽名欄簽名。' };
  if (m[1].length > SIGN_IMAGE_MAX_BASE64) return { error: '簽名圖檔過大，請清除後重簽。' };
  return { name: name, title: title, imageBase64: m[1], agent: String(p.agent || '').slice(0, 300) };
}

/** HTML of the signing certificate (converted to PDF). Binds the signature to the quote PDF by its SHA256. */
function buildCertificateHtml(info) {
  var rows = [
    ['報價名稱', info.title], ['報價日', info.date], ['含稅總計', formatTwd(info.gross)],
    ['簽署人', info.name], ['職稱', info.signerTitle], ['簽署時間', info.signedAt],
    ['收件 Email', info.recipientEmail], ['簽署編號', info.signId],
    ['報價單檔名', info.filename], ['報價單 SHA256', info.sha256], ['瀏覽器資訊', info.agent]
  ].map(function (r) {
    return '<tr><td style="width:120px;color:#555;padding:6px 8px;border:1px solid #ccc">' + escapeHtml(r[0]) +
      '</td><td style="padding:6px 8px;border:1px solid #ccc;word-break:break-all">' + escapeHtml(r[1]) + '</td></tr>';
  }).join('');
  return '<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;font-size:12px;color:#111">' +
    '<h2 style="margin:0 0 4px">報價單簽回證明</h2><div style="color:#555;margin-bottom:12px">' + COMPANY_NAME + '</div>' +
    '<p>簽署人已檢視下列報價單，並同意以電子簽名確認其內容。本證明以 SHA256 對應原報價單檔案，檔案內容如有任何變更，雜湊值即不相符。</p>' +
    '<table style="border-collapse:collapse;width:100%">' + rows + '</table>' +
    '<p style="margin-top:16px;color:#555">簽名</p>' +
    '<div style="border:1px solid #ccc;padding:8px;width:320px"><img src="data:image/png;base64,' + info.imageBase64 + '" style="width:300px"></div>' +
    '</body></html>';
}

/** 文件 row for the signed certificate, in the sheet's own column order. */
function signedDocumentRow(headers, doc) {
  var col = columnIndex(headers);
  var row = headers.map(function () { return ''; });
  row[col.id] = doc.id;
  row[col.kind] = SIGNED_DOC_KIND;
  row[col.filename] = doc.filename;
  row[col.url] = doc.url;
  row[col.sha256] = doc.sha256;
  row[col.caseNumber] = doc.caseNumber || '';
  row[col.reviewStatus] = '已處理';
  return row;
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
    .addItem('重新寄出寄送失敗的報價…', 'retrySendFromMenu')
    .addItem('標記報價已簽回…', 'markSignedFromMenu')
    .addItem('作廢簽署連結…', 'voidSignatureFromMenu');
}

function installSigning() {
  requireAdmin_();
  var ss = SpreadsheetApp.getActive();
  // The public page opens the workbook by id: a web app has no "active" spreadsheet to fall back on.
  PropertiesService.getScriptProperties().setProperty('SIGN_BOOK_ID', ss.getId());
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

/**
 * The workbook. Menus and triggers have the spreadsheet the script is bound to; the public web app may not, so it
 * opens the id installSigning saved. The bound one comes first: a copied spreadsheet must never act on the original.
 */
function book_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActive(); } catch (e) { ss = null; }
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SIGN_BOOK_ID');
  if (!id) throw new Error('找不到試算表：請在試算表選單執行一次「安裝報價簽署」。');
  return SpreadsheetApp.openById(id);
}

function settingValue_(key) {
  var sheet = book_().getSheetByName(SETTINGS_SHEET);
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
  table.sheet.getRange(index + 2, 1, 1, table.headers.length).setValues([sheetSafeRow(table.rows[index].slice(0, table.headers.length))]);
}

function logSignEvent_(ss, signId, type, actor, agent, note) {
  var sheet = ss.getSheetByName(SIGN_EVENT_SHEET) || ensureSheet_(ss, SIGN_EVENT_SHEET, SIGN_EVENT_HEADERS);
  sheet.appendRow(sheetSafeRow(['evt_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), signId, type, new Date(), actor || '', agent || '', note || '']));
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

/** Voids every open link that a later one replaces. Runs in the sweep and whenever a link is opened or signed. */
function applySuperseded_(ss, table) {
  var col = table.col;
  var qData = ss.getSheetByName('報價版本').getDataRange().getValues();
  planSuperseded(table.headers, table.rows, quoteGroupKeys(qData[0], qData.slice(1))).forEach(function (v) {
    table.rows[v.index][col.status] = SIGN_STATUS.voided;
    writeSignRow_(table, v.index);
    logSignEvent_(ss, table.rows[v.index][col.id], '作廢', 'system', '', '已有較新的報價 ' + v.by);
  });
}

function processSendQueue(e) {
  requireAdmin_(e);
  withSignLock_(function () {
    var ss = book_();
    var table = signTable_(ss);
    var col = table.col, today = todayIso_();
    var plan = planSendQueue(table.headers, table.rows, today);
    plan.invalid.forEach(function (p) {
      var row = table.rows[p.index];
      if (String(row[col.notes]).indexOf(p.reason) >= 0) return;
      row[col.notes] = (String(row[col.notes] || '') + ' 無法寄送：' + p.reason).trim();
      writeSignRow_(table, p.index);
    });
    plan.interrupted.forEach(function (i) {
      var row = table.rows[i];
      row[col.status] = SIGN_STATUS.failed; // token雜湊 and 到期日 stay: the e-mail may have gone out
      row[col.notes] = (clearSendFailureNote(row[col.notes]) + ' ｜寄送中斷：請到寄件備份確認信是否已寄出，再決定是否重新寄出').replace(/^ ｜/, '');
      writeSignRow_(table, i);
      logSignEvent_(ss, row[col.id], '寄送失敗', 'system', '', '上次寄送中斷，未自動重寄');
    });
    plan.expire.forEach(function (i) {
      table.rows[i][col.status] = SIGN_STATUS.expired;
      writeSignRow_(table, i);
      logSignEvent_(ss, table.rows[i][col.id], '過期', 'system', '', '');
    });
    applySuperseded_(ss, table);
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
        // Record 寄送中 before the e-mail leaves: if this run dies after Gmail accepted the message,
        // the next run finds 寄送中 and stops instead of mailing the client again.
        row[col.status] = SIGN_STATUS.sending;
        row[col.tokenHash] = sha256Text_(token);
        row[col.dueDate] = due;
        writeSignRow_(table, i);
        SpreadsheetApp.flush();
        GmailApp.sendEmail(String(row[col.recipientEmail]).trim(), mail.subject, mail.text, options);
      } catch (e) {
        var failure = sendFailureNote(row[col.notes], e.message, SIGN_MAX_SEND_ATTEMPTS);
        row[col.status] = failure.giveUp ? SIGN_STATUS.failed : SIGN_STATUS.queued;
        row[col.tokenHash] = '';
        row[col.dueDate] = '';
        row[col.notes] = failure.notes;
        writeSignRow_(table, i);
        logSignEvent_(ss, signId, '寄送失敗', 'system', '', '第 ' + failure.attempts + ' 次：' + e.message);
        return;
      }
      // The e-mail is out. Nothing below may put the row back in the queue.
      row[col.status] = SIGN_STATUS.sent;
      row[col.sentAt] = new Date();
      row[col.reminders] = 0;
      row[col.notes] = clearSendFailureNote(row[col.notes]);
      writeSignRow_(table, i);
      logSignEvent_(ss, signId, '寄送', Session.getEffectiveUser().getEmail(), '', '寄給 ' + row[col.recipientEmail]);
      voidsForCase(plan, String(row[col.caseId]).trim()).forEach(function (v) {
        if (String(table.rows[v.index][col.status]).trim() === SIGN_STATUS.voided) return;
        table.rows[v.index][col.status] = SIGN_STATUS.voided;
        writeSignRow_(table, v.index);
        logSignEvent_(ss, table.rows[v.index][col.id], '作廢', 'system', '', '同案件新版報價 ' + signId + ' 寄出');
      });
    });
  });
}

/** Signing page: quote summary, PDF download and the handwritten signature form. */
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
  var ss = book_();
  var table = signTable_(ss);
  var col = table.col;
  var i = findSignatureByTokenHash(table.headers, table.rows, sha256Text_(token));
  if (i < 0) return { state: 'invalid' };
  applySuperseded_(ss, table);
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
  var ss = book_();
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
    '.note{background:#fdf1ea;border-radius:6px;padding:12px;font-size:14px;margin-top:16px}' +
    'h2{font-size:17px;margin:24px 0 4px}label{display:block;font-size:14px;color:#444;margin-top:12px}' +
    'input:not([type=checkbox]){display:block;width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:6px;margin-top:4px}' +
    'canvas{display:block;width:100%;height:180px;border:1px dashed #999;border-radius:6px;background:#fff;touch-action:none;margin-top:4px}' +
    '.ck{display:flex;gap:8px;align-items:flex-start;margin:14px 0}.ghost{background:#fff;color:#e8743b;border:1px solid #e8743b}' +
    '.btn{display:block;text-align:center;background:#e8743b;color:#fff;border-radius:6px;padding:12px 18px;text-decoration:none}.err{color:#b3261e;font-size:14px;margin-top:8px;min-height:1em}button:disabled{opacity:.6}';
  var body;
  if (view.state !== 'open') {
    body = '<h1>報價單確認</h1><p>' + escapeHtml(messages[view.state] || messages.invalid) + '</p>';
  } else {
    body = '<h1>' + escapeHtml(view.title) + '</h1><div class="muted">' + COMPANY_NAME + '</div>' +
      '<table><tr><td>報價日</td><td>' + escapeHtml(view.date) + '</td></tr>' +
      '<tr><td>含稅總計</td><td><b>' + escapeHtml(formatTwd(view.gross)) + '</b></td></tr>' +
      '<tr><td>有效期限</td><td>' + escapeHtml(view.due) + '</td></tr></table>' +
      '<button id="dl" class="ghost" onclick="dl()">下載報價單 PDF</button>' +
      '<h2>線上簽回</h2>' +
      '<label>簽署人姓名<input id="nm" maxlength="60" autocomplete="name"></label>' +
      '<label>職稱（選填）<input id="tt" maxlength="60" autocomplete="organization-title"></label>' +
      '<div class="muted" style="margin-top:12px">請在下方框內簽名</div>' +
      '<canvas id="pad"></canvas>' +
      '<div style="text-align:right"><a href="#" onclick="clearPad();return false" class="muted">清除重簽</a></div>' +
      '<label class="ck"><input type="checkbox" id="ok"> 我已閱讀報價單內容，並同意以此電子簽名確認本報價。</label>' +
      '<button id="go" onclick="send()">確認簽回</button><div id="msg" class="err"></div>' +
      '<div class="note">送出後可下載簽回證明留存。如有問題，直接回覆寄給您的信件即可。</div>' +
      '<script>var T=' + JSON.stringify(token) + ';' + SIGN_PAGE_SCRIPT + '</script>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div class="card">' + body + '</div></body></html>';
}

/** Browser script of the signing page: PDF download, signature pad, submit. */
var SIGN_PAGE_SCRIPT = [
  'function dl(){var b=document.getElementById("dl");b.disabled=true;b.textContent="準備中…";',
  'google.script.run.withSuccessHandler(function(f){var bin=atob(f.data),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);',
  'var u=URL.createObjectURL(new Blob([a],{type:"application/pdf"}));var l=document.createElement("a");l.href=u;l.download=f.name;document.body.appendChild(l);l.click();',
  'b.disabled=false;b.textContent="下載報價單 PDF";}).withFailureHandler(function(e){b.disabled=false;b.textContent=e.message;}).downloadQuotePdf(T);}',
  'var c=document.getElementById("pad"),x=c.getContext("2d"),drawn=false,down=false;',
  'function fit(){var r=c.getBoundingClientRect();c.width=r.width*2;c.height=r.height*2;x.setTransform(2,0,0,2,0,0);x.lineWidth=2.2;x.lineCap="round";x.lineJoin="round";x.strokeStyle="#111";drawn=false;}',
  'fit();',
  'function pos(e){var r=c.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top];}',
  'c.addEventListener("pointerdown",function(e){down=true;try{c.setPointerCapture(e.pointerId);}catch(_){}var p=pos(e);x.beginPath();x.moveTo(p[0],p[1]);e.preventDefault();});',
  'c.addEventListener("pointermove",function(e){if(!down)return;var p=pos(e);x.lineTo(p[0],p[1]);x.stroke();drawn=true;e.preventDefault();});',
  '["pointerup","pointercancel","pointerleave"].forEach(function(n){c.addEventListener(n,function(){down=false;});});',
  'function clearPad(){x.save();x.setTransform(1,0,0,1,0,0);x.clearRect(0,0,c.width,c.height);x.restore();drawn=false;}',
  'function send(){var m=document.getElementById("msg"),b=document.getElementById("go"),n=document.getElementById("nm").value.trim();m.textContent="";',
  'if(!n){m.textContent="請填寫簽署人姓名。";return;}if(!drawn){m.textContent="請先在簽名欄簽名。";return;}',
  'if(!document.getElementById("ok").checked){m.textContent="請勾選同意以電子簽名確認本報價單。";return;}',
  'b.disabled=true;b.textContent="送出中…";',
  'google.script.run.withSuccessHandler(function(f){var k=document.querySelector(".card");k.innerHTML="<h1>簽回完成</h1><p>謝謝您，我們已收到您的簽回。</p>";',
  'if(f&&f.data){var bin=atob(f.data),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);var l=document.createElement("a");',
  'l.href=URL.createObjectURL(new Blob([a],{type:"application/pdf"}));l.download=f.name;l.textContent="下載簽回證明 PDF";l.className="btn";k.appendChild(l);}})',
  '.withFailureHandler(function(e){b.disabled=false;b.textContent="確認簽回";m.textContent=e.message;})',
  '.submitSignature(T,{name:n,title:document.getElementById("tt").value.trim(),consent:true,image:c.toDataURL("image/png"),agent:navigator.userAgent});}'
].join('');

/**
 * Called from the signing page. Saves the certificate PDF, registers it in 文件, writes the case and quote
 * fields by the same rules as the menu, marks the row 已簽回, hands the certificate back to the page and
 * notifies the owner. No owner action needed.
 */
function submitSignature(token, payload) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new Error('連結無效');
  var input = validateSignature(payload);
  if (input.error) throw new Error(input.error);
  return withSignLock_(function () {
    var ss = book_();
    var table = signTable_(ss);
    var col = table.col;
    var i = findSignatureByTokenHash(table.headers, table.rows, sha256Text_(token));
    if (i < 0) throw new Error('連結無效');
    applySuperseded_(ss, table);
    var row = table.rows[i];
    var signId = String(row[col.id]).trim();
    var state = pageStateFor(row[col.status], isoDay(row[col.dueDate]), todayIso_());
    if (state === 'signed') return { ok: true };
    if (state !== 'open') throw new Error('這個連結已無法簽回，請回覆原信件與我們聯絡。');
    var quoteId = String(row[col.quoteId]).trim(), caseId = String(row[col.caseId]).trim();
    // Checked before anything is created: a link whose case or quote is missing must not end up 已簽回.
    if (!caseId || !quoteId || !caseRowExists_(ss, caseId) || !quoteInfo_(ss, quoteId)) {
      logSignEvent_(ss, signId, '簽回失敗', String(row[col.recipientEmail]), input.agent, '找不到案件 ' + caseId + ' 或報價 ' + quoteId);
      throw new Error('這份報價的資料有誤，暫時無法簽回，請回覆原信件與我們聯絡。');
    }
    var fileId = documentFileIds_(ss)[String(row[col.sourceId]).trim()];
    if (!fileId) throw new Error('找不到報價單檔案，請回覆原信件與我們聯絡。');
    var original = DriveApp.getFileById(fileId);
    var blob = original.getBlob();
    var sha = sha256Hex_(blob);
    var expected = String(row[col.sha256] || '').trim().toLowerCase();
    if (expected && sha !== expected) {
      logSignEvent_(ss, signId, '簽回失敗', String(row[col.recipientEmail]), input.agent, 'PDF 內容與原檔SHA256 不符');
      throw new Error('報價單檔案已變更，無法簽回，請回覆原信件與我們聯絡。');
    }
    var quote = quoteInfo_(ss, quoteId) || {};
    var title = quote.title || '報價單';
    var now = new Date(), day = todayIso_();
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    var html = buildCertificateHtml({
      title: title, date: quote.date || '', gross: quote.gross, name: input.name, signerTitle: input.title,
      signedAt: Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss') + '（' + tz + '）',
      recipientEmail: String(row[col.recipientEmail]).trim(), signId: signId, filename: original.getName(),
      sha256: sha, agent: input.agent, imageBase64: input.imageBase64
    });
    var certName = title + '-簽回證明-' + day.replace(/-/g, '') + '.pdf';
    var cert = Utilities.newBlob(html, 'text/html', 'certificate.html').getAs('application/pdf').setName(certName);
    var folderId = folderIdFrom(settingValue_('signed_folder_id'));
    var parents = original.getParents();
    var folder = folderId ? DriveApp.getFolderById(folderId) : (parents.hasNext() ? parents.next() : DriveApp.getRootFolder());
    var saved = folder.createFile(cert);
    var docId = docIdFor(saved.getId());
    var docSheet = ss.getSheetByName(DOC_SHEET);
    var docHeaders = docSheet.getRange(1, 1, 1, docSheet.getLastColumn()).getValues()[0];
    docSheet.appendRow(sheetSafeRow(signedDocumentRow(docHeaders, {
      id: docId, filename: certName, url: saved.getUrl(), sha256: sha256Hex_(saved.getBlob()), caseNumber: guessCaseNumber(title, '')
    })));
    // Case first, then the row: if the case write throws, the link stays open and the client can submit again.
    applySignedToCase_(ss, caseId, quoteId, day, docId);
    row[col.status] = SIGN_STATUS.signed;
    row[col.signedAt] = now;
    row[col.signer] = input.name;
    row[col.signerTitle] = input.title;
    row[col.signedDocId] = docId;
    writeSignRow_(table, i);
    logSignEvent_(ss, signId, '簽回', String(row[col.recipientEmail]), input.agent, '線上簽名：' + input.name + '，簽回文件 ' + docId);
    // The client gets the certificate from the page. Only the owner is e-mailed: nothing is sent to a client
    // without the owner deciding to.
    try {
      var notify = settingValue_('digest_email') || Session.getEffectiveUser().getEmail();
      if (notify) GmailApp.sendEmail(notify, '【簽回】' + title + '（' + input.name + '）',
        '客戶已在線上簽回「' + title + '」。\n簽署人：' + input.name + (input.title ? '／' + input.title : '') +
        '\n簽署編號：' + signId + '\n案件與報價欄位已自動寫入試算表，附件是簽回證明。', { attachments: [cert], name: COMPANY_NAME });
    } catch (e) {
      logSignEvent_(ss, signId, '通知失敗', 'system', '', '簽回通知信未寄出：' + e.message);
    }
    return { ok: true, name: certName, data: Utilities.base64Encode(cert.getBytes()) };
  });
}

/** Menu: mark a quote signed (client replied by e-mail). Writes the case fields by the same rules phase 2 will use. */
function markSignedFromMenu() {
  requireAdmin_();
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
  var caseId = String(row[col.caseId]).trim(), quoteId = String(row[col.quoteId]).trim();
  if (String(row[col.status]).trim() === SIGN_STATUS.signed) {
    // Already signed: re-apply the case fields so a run that failed half-way can be repaired. Writes are idempotent.
    var storedDoc = String(row[col.signedDocId] || '').trim();
    if (storedDoc && storedDoc !== docId) return signId + ' 已經是已簽回（簽回文件 ' + storedDoc + '），與輸入的 ' + docId + ' 不同，未變更。';
    return signId + ' 已經是已簽回。' + applySignedToCase_(ss, caseId, quoteId, isoDay(row[col.signedAt]) || todayIso_(), storedDoc || docId);
  }
  var blocked = signBlockReason(row[col.status]);
  if (blocked) return signId + ' 未標記：' + blocked;
  if (!(docId in documentFileIds_(ss))) return '「文件」分頁找不到文件ID ' + docId + '，未標記。';
  var day = todayIso_();
  // Case first: if it throws, the row is still open and the menu can simply be run again.
  var caseNote = applySignedToCase_(ss, caseId, quoteId, day, docId);
  row[col.status] = SIGN_STATUS.signed;
  row[col.signedAt] = new Date();
  row[col.signedDocId] = docId;
  writeSignRow_(table, i);
  logSignEvent_(ss, signId, '簽回', actor, '', '手動標記，簽回文件 ' + docId);
  return signId + ' 已標記為已簽回。' + caseNote;
}

function caseRowExists_(ss, caseId) {
  if (!caseId) return false;
  var data = ss.getSheetByName('案件商機').getDataRange().getValues();
  var col = headerIndex(data[0], CASE_SIGN_HEADERS, '案件商機');
  for (var k = 1; k < data.length; k++) if (String(data[k][col.id]).trim() === caseId) return true;
  return false;
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
    sheet.getRange(r + 1, col[key] + 1).setValue(sheetSafe(value));
  });
  if (plan.conflicts.length) {
    var prev = String(data[r][col.reviewNotes] || '').trim();
    sheet.getRange(r + 1, col.reviewNotes + 1).setValue(sheetSafe((prev ? prev + '；' : '') + '線上簽回 ' + day + '：' + plan.conflicts.join('；')));
  }
  var qSheet = ss.getSheetByName('報價版本');
  var qData = qSheet.getDataRange().getValues();
  var qCol = headerIndex(qData[0], QUOTE_SIGN_HEADERS, '報價版本');
  var effective = planEffectiveQuotes(qData[0], qData.slice(1), caseId, quoteId);
  effective.forEach(function (c) { qSheet.getRange(c.index + 2, qCol.effective + 1).setValue(c.value); });
  var replaced = effective.filter(function (c) { return c.value === '否'; }).length;
  if (!Object.keys(plan.set).length && !plan.conflicts.length && !effective.length) return '案件與報價欄位已是最新，無需變更。';
  return (plan.revision ? '案件已有原簽回，已填最新改版簽回欄位，原成交決策日不變。' : '已寫入案件簽回文件ID與成交決策日。') +
    (replaced ? '新版設為有效成交版本，' + replaced + ' 份舊版改為否。' : '') +
    (plan.conflicts.length ? '有 ' + plan.conflicts.length + ' 項與既有資料不同，已記在待核對事項。' : '');
}

function voidSignatureFromMenu() {
  requireAdmin_();
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
      if ([SIGN_STATUS.queued, SIGN_STATUS.sending, SIGN_STATUS.failed, SIGN_STATUS.sent, SIGN_STATUS.viewed, SIGN_STATUS.draft].indexOf(status) < 0) return signId + ' 狀態為' + status + '，不能作廢。';
      table.rows[i][col.status] = SIGN_STATUS.voided;
      writeSignRow_(table, i);
      logSignEvent_(ss, signId, '作廢', Session.getActiveUser().getEmail() || 'owner', '', '手動作廢');
      return signId + ' 已作廢，連結立即失效。';
    }
    return '找不到簽署ID ' + signId;
  });
  ui.alert(msg);
}

/** Menu: put a 寄送失敗 row back in the queue after the owner has checked why it failed. */
function retrySendFromMenu() {
  requireAdmin_();
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('重新寄出寄送失敗的報價', '輸入簽署ID（sig_ 開頭）。\n若備註寫「寄送中斷」，請先到寄件備份確認信沒有寄出，以免客戶收到兩封。', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var signId = a.getResponseText().trim();
  var choice = ui.alert('重新寄出？', '「是」：重新寄一封（舊信的連結失效）。\n「否」：信其實已寄出，只把狀態改為已寄送，信中的連結照常可用。', ui.ButtonSet.YES_NO_CANCEL);
  if (choice !== ui.Button.YES && choice !== ui.Button.NO) return;
  var alreadySent = choice === ui.Button.NO;
  var msg = withSignLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var table = signTable_(ss);
    var col = table.col;
    for (var i = 0; i < table.rows.length; i++) {
      if (String(table.rows[i][col.id]).trim() !== signId) continue;
      var status = String(table.rows[i][col.status]).trim();
      if (status !== SIGN_STATUS.failed) return signId + ' 狀態為' + status + '，不需要重新寄出。';
      var row = table.rows[i];
      var notes = clearSendFailureNote(row[col.notes]).replace(/\s*｜?寄送中斷：[\s\S]*$/, '').trim();
      var actor = Session.getActiveUser().getEmail() || 'owner';
      if (alreadySent) {
        if (!String(row[col.tokenHash] || '').trim()) return signId + ' 沒有已產生的連結，無法標記為已寄送；請選擇重新寄出。';
        row[col.status] = SIGN_STATUS.sent;
        row[col.sentAt] = new Date();
        row[col.reminders] = 0;
        row[col.notes] = notes;
        writeSignRow_(table, i);
        logSignEvent_(ss, signId, '寄送', actor, '', '寄送中斷後人工確認信已寄出');
        var caseId = String(row[col.caseId]).trim();
        table.rows.forEach(function (other, k) {
          if (k === i || !caseId || String(other[col.caseId]).trim() !== caseId) return;
          if (OPEN_STATUSES.indexOf(String(other[col.status]).trim()) < 0) return;
          other[col.status] = SIGN_STATUS.voided;
          writeSignRow_(table, k);
          logSignEvent_(ss, other[col.id], '作廢', 'system', '', '同案件新版報價 ' + signId + ' 寄出');
        });
        return signId + ' 已標記為已寄送，信中的連結有效。';
      }
      row[col.status] = SIGN_STATUS.queued;
      row[col.tokenHash] = '';
      row[col.dueDate] = '';
      row[col.notes] = notes;
      writeSignRow_(table, i);
      logSignEvent_(ss, signId, '重新寄送', actor, '', '手動放回佇列');
      return signId + ' 已放回佇列，5 分鐘內寄出。';
    }
    return '找不到簽署ID ' + signId;
  });
  ui.alert(msg);
}
