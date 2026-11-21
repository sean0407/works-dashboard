/**
 * 沃克思｜報價單簽署連結與線上簽回。
 *
 * 和 document-import.gs 放在同一個 Apps Script 專案（新增一個指令碼檔案，貼上本檔全部內容）。
 * 由試算表擁有者安裝與部署網頁應用程式。安裝步驟見 QUOTE-SIGNING-zh-TW.md。
 *
 * 寄信規則：給客戶的報價信一律是 Gmail 草稿，由老闆自己決定是否寄出；本程式不會自動寄出報價信，也沒有排程。
 * 唯一的例外是驗證碼信：客戶在簽署頁按「寄送驗證碼」時，寄一封只有 6 位數驗證碼的信到「簽署」列登記的收件人Email。
 *
 * 分工（避免兩邊同時寫入互相覆蓋）：
 * - Claude 對話只「新增列」：報價版本、文件、簽署。
 *   建議：簽署列寫「待寄送」，老闆按選單「建立待寄送報價的 Gmail 草稿」，由本程式產生連結、快照與草稿。
 *   也可由 Claude 直接寫「已寄送」，但必須照 QUOTE-SIGNING-zh-TW.md 的公式填好 token雜湊、原檔SHA256 與快照雜湊。
 * - 本程式負責之後的所有狀態（檢視、簽回、過期、作廢），以及簽回時寫入案件的欄位。
 *
 * 狀態：草稿 → 待寄送 → 寄送中 → 已寄送 → 已檢視 → 已簽回／已拒絕／已過期；任何未完成的狀態都可能變成已作廢。
 * 「已寄送」表示連結已產生、草稿已建立；連結從這一刻起有效。
 * 寄送中：建立草稿前先寫入，草稿建好才改已寄送；執行中斷時留在這個狀態，下次改為寄送失敗，不會自動重建。
 *
 * 安全規則：
 * - 快照：產生連結時把報價、案件、PDF、金額、版本與收件人算成「快照雜湊」。開頁、下載、寄驗證碼、簽回時重算，不符就拒絕。
 * - 版本：同一報價組依「版本」的數字排序。只要較高版本發出過連結，較低版本就永久不能簽，即使新版之後作廢。
 *   作廢與簽回以「簽署事件」為準，手動改回狀態欄也不會讓連結重新可用。
 * - 簽署人：簽回前必須輸入寄到收件人信箱的驗證碼。
 * - 冪等：簽回證明的檔名帶簽署ID。重試時沿用已建立的證明與「文件」列，不會重複產生。
 */

var SIGN_SHEET = '簽署';
var SIGN_EVENT_SHEET = '簽署事件';
var SIGN_HEADERS = {
  id: '簽署ID', quoteId: '報價ID', caseId: '案件ID', sourceId: '來源文件ID',
  recipientName: '收件人姓名', recipientEmail: '收件人Email', cc: '副本',
  sha256: '原檔SHA256', status: '簽署狀態', tokenHash: 'token雜湊',
  sentAt: '寄送時間', dueDate: '到期日', viewedAt: '檢視時間', reminders: '提醒次數',
  signedAt: '簽回時間', signer: '簽署人', signerTitle: '職稱', signedDocId: '簽回文件ID',
  declineReason: '拒絕原因', notes: '備註', snapshot: '快照雜湊', versionRecord: '版本紀錄'
};
var SIGN_EVENT_HEADERS = ['事件ID', '簽署ID', '事件類型', '時間', '觸發者', '瀏覽器資訊', '備註'];
var SIGN_STATUS = {
  draft: '草稿', queued: '待寄送', sending: '寄送中', failed: '寄送失敗', sent: '已寄送', viewed: '已檢視',
  signed: '已簽回', declined: '已拒絕', expired: '已過期', voided: '已作廢'
};
var OPEN_STATUSES = ['已寄送', '已檢視'];
/** A row in one of these statuses (or with a token) has had a link issued to the client. */
var ISSUED_STATUSES = ['已寄送', '已檢視', '已簽回', '已拒絕', '已過期'];
var SIGN_VALID_WORKDAYS = 10;
var SIGN_MAX_SEND_ATTEMPTS = 3;
var SIGN_IMAGE_MAX_BASE64 = 600000;
var SIGNED_DOC_KIND = '簽回';
var SIGN_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
var SNAPSHOT_FORMAT = 'quote-sign-v1';
var OTP_TTL_MS = 10 * 60 * 1000;
var OTP_MAX_TRIES = 5;
var OTP_MAX_PER_DAY = 5;
var OTP_COOLDOWN_MS = 60 * 1000;
var OTP_EVENT = '寄驗證碼';
/** Statuses a quote can be marked signed from. 已過期 is allowed: a client may reply after the link lapsed. */
var SIGNABLE_STATUSES = ['已寄送', '已檢視', '已過期'];
var CASE_SIGN_HEADERS = {
  id: '案件ID', number: '原案號', status: '商機狀態', decisionDate: '成交決策日',
  signedSourceId: '簽回文件ID', revisionSignedDate: '最新改版簽回日',
  revisionSignedSourceId: '最新改版簽回文件ID', reviewNotes: '待核對事項'
};
var QUOTE_SIGN_HEADERS = {
  id: '報價ID', caseId: '案件ID', date: '報價日', title: '報價名稱', version: '版本', role: '原案互補追加',
  groupId: '報價組ID', gross: '含稅金額', effective: '有效成交版本', sourceId: '來源文件ID'
};
var COMPANY_NAME = '沃克思國際有限公司';
var BLOCKED_MESSAGE = '這份報價的資料需要我們重新確認，暫時無法簽回，請回覆原信件與我們聯絡。';

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
  // Public pages can call this by name: keep the loop bounded.
  if (!(n >= 0 && n <= 366)) throw new Error('工作天數超出範圍');
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

/** b***@example.com: enough for the client to recognise the mailbox without showing the address to a link holder. */
function maskEmail(value) {
  var s = String(value || '').trim();
  var at = s.indexOf('@');
  if (at < 1) return '';
  return s.charAt(0) + '***' + s.slice(at);
}

/**
 * What the draft run should do now.
 * rows: 簽署 data rows (row 2 onward); today: yyyy-mm-dd.
 * Returns {send: [rowIndex], expire: [rowIndex], invalid: [{index, reason}], interrupted: [rowIndex]}.
 * Older links are closed by the version rules (planSuperseded) once the new link exists, not here.
 * Open links past their due date expire. Rows left in 寄送中 come from a run that died mid-way.
 */
function planSendQueue(headers, rows, today) {
  var col = headerIndex(headers, SIGN_HEADERS, SIGN_SHEET);
  var plan = { send: [], expire: [], invalid: [], interrupted: [] };
  var seen = signIdCounts(headers, rows);
  rows.forEach(function (row, i) {
    if (String(row[col.status]).trim() === SIGN_STATUS.sending) { plan.interrupted.push(i); return; }
    if (String(row[col.status]).trim() !== SIGN_STATUS.queued) return;
    var reason = '';
    if (!String(row[col.id]).trim()) reason = '缺少簽署ID';
    else if (!SIGN_ID_PATTERN.test(String(row[col.id]).trim())) reason = '簽署ID 只能用英數字、底線、連字號';
    else if (seen[String(row[col.id]).trim()] > 1) reason = '簽署ID 重複';
    else if (!String(row[col.quoteId]).trim()) reason = '缺少報價ID';
    else if (!String(row[col.caseId]).trim()) reason = '缺少案件ID';
    else if (!String(row[col.sourceId]).trim()) reason = '缺少來源文件ID';
    else if (!isEmail(row[col.recipientEmail])) reason = '收件人Email 格式不正確';
    if (reason) { plan.invalid.push({ index: i, reason: reason }); return; }
    plan.send.push(i);
  });
  rows.forEach(function (row, i) {
    if (OPEN_STATUSES.indexOf(String(row[col.status]).trim()) < 0) return;
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

/** The number in a 版本 cell: V2, v2, 2 and 第2版 are all 2. NaN when there is no number. */
function versionNumber(value) {
  var m = /(\d+)/.exec(String(value == null ? '' : value));
  return m ? Number(m[1]) : NaN;
}

function signTime_(value, fallback) {
  if (value && typeof value.getTime === 'function' && !isNaN(value.getTime())) return value.getTime();
  var t = Date.parse(String(value || ''));
  return isNaN(t) ? fallback : t;
}

/**
 * Whether a link was ever issued for this 簽署 row. A voided row that had a token still counts, and so does a row put
 * back in the queue after an interrupted run: its 版本紀錄 stays, because its draft may already have gone out.
 */
function isIssued(row, col) {
  return !!String(row[col.tokenHash] || '').trim() || ISSUED_STATUSES.indexOf(String(row[col.status]).trim()) >= 0 ||
    (col.versionRecord !== undefined && !!String(row[col.versionRecord] || '').trim());
}

/** 簽署ID -> how many rows carry it. A link must have a 簽署ID of its own: code, audit log and certificate hang on it. */
function signIdCounts(headers, rows) {
  var col = headerIndex(headers, SIGN_HEADERS, SIGN_SHEET);
  var counts = {};
  rows.forEach(function (r) {
    var id = String(r[col.id]).trim();
    if (id) counts[id] = (counts[id] || 0) + 1;
  });
  return counts;
}

/** 版本紀錄 written when a link is issued: the quote group and version number as they were then. */
function versionRecordFor(groupKey, version) {
  return JSON.stringify({ k: String(groupKey), v: isNaN(version) ? null : version });
}

/** {key, version} from a 版本紀錄 cell, or null. version is NaN when it was unreadable at issue time. */
function parseVersionRecord(value) {
  try {
    var r = JSON.parse(String(value || ''));
    if (!r || typeof r.k !== 'string' || !r.k) return null;
    return { key: r.k, version: typeof r.v === 'number' ? r.v : NaN };
  } catch (e) {
    return null;
  }
}

/**
 * Why the 簽署 row at index may not be signed (or issued) under the version rules, or reason ''.
 * - The quote must exist in 報價版本 and belong to the row's case.
 * - Among rows of the same quote, only the newest issued one counts.
 * - Within a quote group, a quote whose version is lower than any issued version of another quote is closed for good,
 *   even if that newer link was voided later. Issued rows are compared by their 版本紀錄 (group and version at issue
 *   time), so editing or deleting the newer quote later does not reopen the older one.
 * - The candidate's own version must be readable and unique in its group whenever the group has other quotes.
 * Returns {reason, superseded, by}: superseded is true when a newer link clearly replaces this one (by = its 簽署ID).
 */
function versionBlockReason(signHeaders, signRows, index, quoteHeaders, quoteRows) {
  var col = headerIndex(signHeaders, SIGN_HEADERS, SIGN_SHEET);
  var qcol = headerIndex(quoteHeaders, QUOTE_SIGN_HEADERS, '報價版本');
  var quotes = {};
  quoteRows.forEach(function (r) {
    var id = String(r[qcol.id]).trim();
    if (id) quotes[id] = { caseId: String(r[qcol.caseId]).trim(), version: r[qcol.version] };
  });
  var keys = quoteGroupKeys(quoteHeaders, quoteRows);
  var row = signRows[index];
  var quoteId = String(row[col.quoteId]).trim();
  var quote = quotes[quoteId];
  var newer = { reason: '', superseded: false, by: '' };
  if (!quote) return { reason: '「報價版本」找不到報價 ' + quoteId, superseded: false, by: '' };
  if (quote.caseId !== String(row[col.caseId]).trim()) {
    return { reason: '簽署列的案件ID 與報價 ' + quoteId + ' 的案件ID 不同', superseded: false, by: '' };
  }
  var mine = signTime_(row[col.sentAt], 0);
  for (var k = 0; k < signRows.length; k++) {
    var other = signRows[k];
    if (k === index || String(other[col.quoteId]).trim() !== quoteId || !isIssued(other, col)) continue;
    var t = signTime_(other[col.sentAt], 0);
    if (t > mine || (t === mine && k > index)) {
      return { reason: '同一份報價已有較新的連結 ' + String(other[col.id]).trim(), superseded: true, by: String(other[col.id]).trim() };
    }
  }
  var key = keys[quoteId];
  var n = versionNumber(quote.version);
  var own = parseVersionRecord(row[col.versionRecord]);
  if (own) {
    // Once issued, a link is judged by the group and version it was issued under; moving it is refused.
    if (own.key !== key || !(own.version === n || (isNaN(own.version) && isNaN(n)))) {
      return { reason: '報價 ' + quoteId + ' 的報價組、原案互補追加或版本在連結產生後變更', superseded: false, by: '' };
    }
  }
  var problem = '';
  signRows.forEach(function (other, k) {
    var id = String(other[col.quoteId]).trim();
    if (k === index || id === quoteId || !isIssued(other, col) || newer.superseded) return;
    var rec = parseVersionRecord(other[col.versionRecord]);
    var otherKey = rec ? rec.key : keys[id];
    if (otherKey !== key) return;
    var m = rec ? rec.version : versionNumber(quotes[id] ? quotes[id].version : '');
    var signId = String(other[col.id]).trim();
    if (!isNaN(n) && !isNaN(m) && m > n) {
      newer = { reason: '同報價組已有較新版本 ' + id + '（' + signId + '）', superseded: true, by: signId };
      return;
    }
    if (problem) return;
    if (isNaN(m)) problem = '同報價組的報價 ' + id + ' 版本無法辨識';
    else if (m === n) problem = '同報價組的報價 ' + id + ' 與 ' + quoteId + ' 版本相同';
  });
  if (newer.superseded) return newer;
  Object.keys(quotes).forEach(function (id) {
    if (problem || id === quoteId || keys[id] !== key) return;
    var m = versionNumber(quotes[id].version);
    if (isNaN(n)) problem = '報價 ' + quoteId + ' 的版本「' + String(quote.version == null ? '' : quote.version) + '」無法辨識，同報價組還有其他報價';
    else if (isNaN(m)) problem = '同報價組的報價 ' + id + ' 版本無法辨識';
    else if (m === n) problem = '同報價組的報價 ' + id + ' 與 ' + quoteId + ' 版本相同';
  });
  return { reason: problem, superseded: false, by: '' };
}

/** Open links replaced by a later one under the version rules. Returns [{index, by}]. Ambiguous rows are left alone. */
function planSuperseded(signHeaders, signRows, quoteHeaders, quoteRows) {
  var col = headerIndex(signHeaders, SIGN_HEADERS, SIGN_SHEET);
  var out = [];
  signRows.forEach(function (row, i) {
    if (OPEN_STATUSES.indexOf(String(row[col.status]).trim()) < 0) return;
    var v = versionBlockReason(signHeaders, signRows, i, quoteHeaders, quoteRows);
    if (v.superseded) out.push({ index: i, by: v.by });
  });
  return out;
}

/**
 * The status the audit log fixes for a 簽署ID: 已簽回 or 已作廢 once such an event exists, else ''.
 * eventRows are 簽署事件 data rows (SIGN_EVENT_HEADERS order). A status cell edited back by hand does not reopen a link.
 */
function statusFromEvents(eventRows, signId) {
  var signed = false, voided = false;
  (eventRows || []).forEach(function (r) {
    if (String(r[1]).trim() !== signId) return;
    var type = String(r[2]).trim();
    if (type === '簽回') signed = true;
    if (type === '作廢') voided = true;
  });
  return signed ? SIGN_STATUS.signed : voided ? SIGN_STATUS.voided : '';
}

/** The 簽回文件ID the latest 簽回 event of signId recorded ('簽回文件 doc_…' in its note), or ''. */
function signedEventDocId(eventRows, signId) {
  var doc = '';
  (eventRows || []).forEach(function (r) {
    if (String(r[1]).trim() !== signId || String(r[2]).trim() !== '簽回') return;
    var m = /簽回文件 (doc_[A-Za-z0-9_-]+)/.exec(String(r[6] || ''));
    if (m) doc = m[1];
  });
  return doc;
}

/**
 * Why the 有效成交版本 may not move to quoteId, or ''. A lower version must never become effective again
 * once a higher version of the same group is effective. A quote without a readable version cannot replace one.
 */
function effectiveBlockReason(headers, rows, caseId, quoteId) {
  var col = headerIndex(headers, QUOTE_SIGN_HEADERS, '報價版本');
  var keys = quoteGroupKeys(headers, rows);
  var me = null;
  rows.forEach(function (r) { if (String(r[col.id]).trim() === quoteId) me = r; });
  if (!me) return '';
  var n = versionNumber(me[col.version]);
  var reason = '';
  rows.forEach(function (r) {
    var id = String(r[col.id]).trim();
    if (reason || id === quoteId || keys[id] !== keys[quoteId]) return;
    if (!(r[col.effective] === true || String(r[col.effective]).trim() === '是')) return;
    var m = versionNumber(r[col.version]);
    if (isNaN(m)) return; // a legacy quote without a version is treated as older
    if (isNaN(n)) reason = '報價 ' + quoteId + ' 沒有可辨識的版本，不能取代有效版本 ' + id;
    else if (m > n) reason = '報價 ' + id + '（版本 ' + m + '）已是有效成交版本，較舊的 ' + quoteId + ' 不能再成為有效版本';
    else if (m === n) reason = '報價 ' + id + ' 與 ' + quoteId + ' 版本相同，且已是有效成交版本';
  });
  return reason;
}

/** Amount as the snapshot stores it: whole NT dollars, digits only; '' when the cell holds no number. */
function normalizeAmount(value) {
  var s = String(value == null ? '' : value).replace(/[^\d.-]/g, '');
  if (!s) return '';
  var n = Number(s);
  return isFinite(n) ? String(Math.round(n)) : '';
}

/**
 * The text whose SHA256 is the 快照雜湊: the fields a client agrees to, one per line, in this order.
 * The same formula is in QUOTE-SIGNING-zh-TW.md for links created outside this script.
 */
function signSnapshotText(f) {
  var clean = function (v) { return String(v == null ? '' : v).trim(); };
  return [
    SNAPSHOT_FORMAT, clean(f.signId), clean(f.quoteId), clean(f.caseId), clean(f.sourceId),
    clean(f.pdfSha256).toLowerCase(), normalizeAmount(f.gross), clean(f.version), clean(f.groupId),
    clean(f.recipientEmail).toLowerCase()
  ].join('\n');
}

/**
 * Why the stored snapshot does not hold any more, or ''.
 * info: {rowSha, pdfSha, storedSnapshot, computedSnapshot, caseId, quoteCaseId, sourceId, quoteSourceId}.
 */
function snapshotProblem(info) {
  var rowSha = String(info.rowSha || '').trim().toLowerCase();
  var stored = String(info.storedSnapshot || '').trim().toLowerCase();
  if (!rowSha) return '缺少原檔SHA256';
  if (!stored) return '缺少快照雜湊';
  if (rowSha !== String(info.pdfSha || '').toLowerCase()) return 'PDF 內容與原檔SHA256 不符';
  if (String(info.quoteCaseId || '').trim() !== String(info.caseId || '').trim()) return '報價的案件ID 與簽署列不同';
  var qs = String(info.quoteSourceId || '').trim();
  if (qs && qs !== String(info.sourceId || '').trim()) return '報價的來源文件ID 與簽署列不同';
  if (stored !== String(info.computedSnapshot || '').toLowerCase()) return '報價、金額、版本、案件或收件人已在連結產生後變更（快照雜湊不符）';
  return '';
}

/** Six digits from a random hex string (Utilities.getUuid). */
function otpCodeFrom(hex) {
  var n = parseInt(String(hex || '').replace(/[^0-9a-f]/gi, '').slice(0, 12), 16);
  return ('000000' + (isNaN(n) ? 0 : n % 1000000)).slice(-6);
}

/**
 * Checks a code typed on the page against the stored {hash, exp, tries}. codeHash is SHA256(簽署ID|code).
 * Returns {ok: true} or {error, stored}: stored is what to keep (null = delete it, the code is spent).
 */
function otpVerify(stored, codeHash, now) {
  if (!stored || !stored.hash) return { error: '請先按「寄送驗證碼」，收信後輸入驗證碼。', stored: null };
  if (now > Number(stored.exp)) return { error: '驗證碼已過期，請重新寄送。', stored: null };
  if (stored.hash !== codeHash) {
    var tries = (Number(stored.tries) || 0) + 1;
    if (tries >= OTP_MAX_TRIES) return { error: '驗證碼錯誤次數過多，請重新寄送。', stored: null };
    var kept = {};
    Object.keys(stored).forEach(function (k) { kept[k] = stored[k]; });
    kept.tries = tries;
    return { error: '驗證碼不正確，請再確認一次。', stored: kept };
  }
  return { ok: true };
}

/** '' when another code may be mailed for signId now, else why not. Counts 寄驗證碼 events of the last 24 hours. */
function otpSendBlock(eventRows, signId, now) {
  var recent = 0, last = 0;
  (eventRows || []).forEach(function (r) {
    if (String(r[1]).trim() !== signId || String(r[2]).trim() !== OTP_EVENT) return;
    var t = signTime_(r[3], 0);
    if (now - t < 24 * 3600 * 1000) recent++;
    if (t > last) last = t;
  });
  if (last && now - last < OTP_COOLDOWN_MS) return '驗證碼剛寄出，請等一分鐘再重新寄送。';
  if (recent >= OTP_MAX_PER_DAY) return '今天已寄出 ' + OTP_MAX_PER_DAY + ' 次驗證碼，請明天再試，或回覆原信件與我們聯絡。';
  return '';
}

/** The verification e-mail: only the code, nothing about the quote. */
function buildOtpEmail(code) {
  return {
    subject: '【' + COMPANY_NAME + '】報價簽回驗證碼',
    text: ['您好：', '', '您的報價簽回驗證碼是 ' + code + '，10 分鐘內有效。', '如果不是您本人操作，請忽略這封信。', '', COMPANY_NAME].join('\n')
  };
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
 * complementary bundle is meant to have several effective quotes, and signing one switches nothing else off.
 * Callers check effectiveBlockReason first.
 * Returns [{index, value}] for rows that change.
 */
function planEffectiveQuotes(headers, rows, caseId, quoteId) {
  var col = headerIndex(headers, QUOTE_SIGN_HEADERS, '報價版本');
  var keys = quoteGroupKeys(headers, rows);
  var signed = -1;
  rows.forEach(function (r, i) { if (String(r[col.id]).trim() === quoteId) signed = i; });
  if (signed < 0) return [];
  var changes = [];
  rows.forEach(function (r, i) {
    var yesNow = r[col.effective] === true || String(r[col.effective]).trim() === '是';
    if (i === signed) { if (!yesNow) changes.push({ index: i, value: '是' }); return; }
    if (String(r[col.caseId]).trim() !== caseId || !yesNow) return;
    // Same group key: a 互補 quote (its own group) never switches off another quote, nor is switched off.
    if (keys[String(r[col.id]).trim()] !== keys[quoteId]) return;
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
 * Checks what the signing page submitted. Returns {error} or the cleaned {name, title, imageBase64, agent, code}.
 * The signature must be a PNG data URL drawn on the page; the consent box must be ticked; the code is the one mailed.
 */
function validateSignature(payload) {
  var p = payload || {};
  var name = String(p.name || '').trim(), title = String(p.title || '').trim();
  if (!name) return { error: '請填寫簽署人姓名。' };
  if (name.length > 60 || title.length > 60) return { error: '姓名或職稱過長。' };
  if (p.consent !== true) return { error: '請勾選同意以電子簽名確認本報價單。' };
  var m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(p.image || ''));
  // A real PNG starts with its signature and IHDR chunk (base64 iVBORw0KGgoAAAANSUhEUg); the runtime also checks
  // the decoded bytes end with IEND (isPngBytes).
  if (!m || m[1].length < 200 || m[1].length % 4 !== 0 || m[1].indexOf('iVBORw0KGgoAAAANSUhEUg') !== 0) return { error: '請先在簽名欄簽名。' };
  if (m[1].length > SIGN_IMAGE_MAX_BASE64) return { error: '簽名圖檔過大，請清除後重簽。' };
  var code = String(p.code || '').trim();
  if (!/^\d{6}$/.test(code)) return { error: '請輸入信箱收到的 6 位數驗證碼。' };
  return { name: name, title: title, imageBase64: m[1], agent: String(p.agent || '').slice(0, 300), code: code };
}

/** Whether decoded bytes look like a whole PNG: signature, IHDR first, IEND chunk last. Bytes may be signed (Java). */
function isPngBytes(bytes) {
  var b = (bytes || []).map(function (x) { return x & 0xff; });
  var head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
  var tail = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  if (b.length < head.length + tail.length) return false;
  for (var i = 0; i < head.length; i++) if (b[i] !== head[i]) return false;
  for (var j = 0; j < tail.length; j++) if (b[b.length - tail.length + j] !== tail[j]) return false;
  return true;
}

/** HTML of the signing certificate (converted to PDF). Binds the signature to the quote PDF by its SHA256. */
function buildCertificateHtml(info) {
  var rows = [
    ['報價名稱', info.title], ['報價日', info.date], ['含稅總計', formatTwd(info.gross)],
    ['簽署人', info.name], ['職稱', info.signerTitle], ['簽署時間', info.signedAt],
    ['收件 Email', info.recipientEmail], ['身分驗證', info.verifiedBy || ''], ['簽署編號', info.signId],
    ['報價單檔名', info.filename], ['報價單 SHA256', info.sha256], ['快照雜湊', info.snapshot || ''], ['瀏覽器資訊', info.agent]
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

/**
 * File name of the certificate. It starts with the 簽署ID so a retry finds the file it already made: Drive's
 * "title contains" search matches the start of a name, not any substring.
 */
function certificateFileName(title, signId) {
  return signId + '-簽回證明-' + String(title || '報價單') + '.pdf';
}

function isCertificateFileFor(name, signId) {
  var s = String(name || '');
  return s.indexOf(signId + '-簽回證明-') === 0 && /\.pdf$/.test(s);
}

/** Index of the 文件 data row holding the certificate of signId, or -1. */
function findCertificateDoc(docHeaders, docRows, signId) {
  var col = columnIndex(docHeaders);
  for (var i = 0; i < docRows.length; i++) {
    if (String(docRows[i][col.kind]).trim() === SIGNED_DOC_KIND && isCertificateFileFor(String(docRows[i][col.filename]).trim(), signId)) return i;
  }
  return -1;
}

/** Signer details kept in the certificate file's description; null when they are not there or belong elsewhere. */
function parseCertificateMeta(description, signId) {
  try {
    var m = JSON.parse(String(description || ''));
    if (!m || m.signId !== signId || !m.name || !m.signedAt) return null;
    return {
      name: String(m.name), title: String(m.title || ''), signedAt: String(m.signedAt), agent: String(m.agent || ''),
      signedAtIso: String(m.signedAtIso || ''), snapshot: String(m.snapshot || '')
    };
  } catch (e) {
    return null;
  }
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
  var verify = '簽回時，系統會寄一組 6 位數驗證碼到這個信箱，以確認是您本人簽署。';
  var text = [
    greet, '',
    '附件是「' + info.title + '」報價單' + (amount ? '（含稅總計 ' + amount + '）' : '') + '。',
  ].concat(replaces ? [replaces] : []).concat([
    '請點以下連結確認報價內容：', info.link, verify, '',
    '連結有效期限至 ' + info.due + '。如有任何問題，直接回覆這封信即可。', '',
    COMPANY_NAME
  ]).join('\n');
  var html = '<p>' + escapeHtml(greet) + '</p>' +
    '<p>附件是「' + escapeHtml(info.title) + '」報價單' + (amount ? '（含稅總計 ' + escapeHtml(amount) + '）' : '') + '。</p>' +
    (replaces ? '<p><b>' + escapeHtml(replaces) + '</b></p>' : '') +
    '<p><a href="' + escapeHtml(info.link) + '" style="display:inline-block;padding:10px 18px;background:#e8743b;color:#fff;border-radius:6px;text-decoration:none">開啟報價單簽署頁</a></p>' +
    '<p style="color:#666">' + escapeHtml(verify) + '</p>' +
    '<p style="color:#666">連結有效期限至 ' + escapeHtml(info.due) + '。如有任何問題，直接回覆這封信即可。</p>' +
    '<p>' + COMPANY_NAME + '</p>';
  return { subject: subject, text: text, html: html };
}

// ---------- Apps Script runtime ----------

/** Menu items; onOpen in document-import.gs adds them when this file is installed. */
function addSigningMenu_(menu) {
  return menu.addSeparator()
    .addItem('安裝報價簽署（建立分頁、移除舊排程）', 'installSigning')
    .addItem('建立待寄送報價的 Gmail 草稿', 'createSignDrafts')
    .addItem('重新處理寄送失敗的報價…', 'retrySendFromMenu')
    .addItem('標記報價已簽回…', 'markSignedFromMenu')
    .addItem('作廢簽署連結…', 'voidSignatureFromMenu');
}

/** Handlers of the old automatic send. installSigning removes their triggers: nothing mails a client on a schedule. */
var RETIRED_SIGN_TRIGGERS = ['processSendQueue', 'createSignDrafts'];

function installSigning() {
  requireAdmin_();
  var ss = SpreadsheetApp.getActive();
  // The public page opens the workbook by id: a web app has no "active" spreadsheet to fall back on.
  PropertiesService.getScriptProperties().setProperty('SIGN_BOOK_ID', ss.getId());
  ensureSheet_(ss, SIGN_SHEET, Object.keys(SIGN_HEADERS).map(function (k) { return SIGN_HEADERS[k]; }));
  ensureSheet_(ss, SIGN_EVENT_SHEET, SIGN_EVENT_HEADERS);
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (RETIRED_SIGN_TRIGGERS.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); removed++; }
  });
  var url = webAppUrl_();
  ss.toast('已建立分頁。' + (removed ? '已移除 ' + removed + ' 個舊的自動寄送排程。' : '') +
    '報價信請用「建立待寄送報價的 Gmail 草稿」。' + (url ? '' : '尚未設定 sign_webapp_url，請先部署網頁應用程式。'), '沃克思報價簽署', 10);
}

/** Creates the sheet with its headers, or adds headers a newer version of this script needs at the end of row 1. */
function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }
  var last = sheet.getLastColumn();
  var have = last ? sheet.getRange(1, 1, 1, last).getValues()[0] : [];
  var missing = missingHeaders(have, headers);
  if (missing.length) sheet.getRange(1, last + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
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
  try {
    return fn();
  } finally {
    // Make this run's writes (also those of a run that threw, e.g. a logged code request) visible before the next
    // request can take the lock; release the lock even if flushing fails.
    try { SpreadsheetApp.flush(); } catch (e) { console.log('withSignLock_: flush failed: ' + e.message); }
    lock.releaseLock();
  }
}

function signTable_(ss) {
  var sheet = ss.getSheetByName(SIGN_SHEET);
  if (!sheet) throw new Error('找不到「' + SIGN_SHEET + '」分頁，請先執行「安裝報價簽署」。');
  var data = sheet.getDataRange().getValues();
  return { sheet: sheet, headers: data[0], rows: data.slice(1), col: headerIndex(data[0], SIGN_HEADERS, SIGN_SHEET) };
}

function quoteTable_(ss) {
  var data = ss.getSheetByName('報價版本').getDataRange().getValues();
  return { headers: data[0], rows: data.slice(1), col: headerIndex(data[0], QUOTE_SIGN_HEADERS, '報價版本') };
}

function eventRows_(ss) {
  var sheet = ss.getSheetByName(SIGN_EVENT_SHEET);
  return sheet ? sheet.getDataRange().getValues().slice(1) : [];
}

function writeSignRow_(table, index) {
  table.sheet.getRange(index + 2, 1, 1, table.headers.length).setValues([sheetSafeRow(table.rows[index].slice(0, table.headers.length))]);
}

function logSignEvent_(ss, signId, type, actor, agent, note) {
  var sheet = ss.getSheetByName(SIGN_EVENT_SHEET) || ensureSheet_(ss, SIGN_EVENT_SHEET, SIGN_EVENT_HEADERS);
  sheet.appendRow(sheetSafeRow(['evt_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), signId, type, new Date(), actor || '', agent || '', note || '']));
}

/**
 * Puts back the 已簽回／已作廢 the audit log fixed, where the status cell was edited by hand. A terminal status whose
 * event is missing (the run stopped between the two writes) gets its event now: 已作廢 always, 已簽回 only when the
 * online certificate in 文件 backs it. An 已簽回 typed by hand stays unconfirmed and cannot be repaired from the menu.
 * Also records the 版本紀錄 of issued rows that have none yet (links written directly into the sheet).
 */
/** 版本紀錄 for an issued row from 報價版本 as it is now (first time the script sees a directly written link). */
function backfillVersionRecord_(ss, table, i) {
  var col = table.col, row = table.rows[i];
  var q = quoteInfo_(ss, String(row[col.quoteId]).trim());
  if (!q) return;
  var qt = quoteTable_(ss);
  row[col.versionRecord] = versionRecordFor(quoteGroupKeys(qt.headers, qt.rows)[q.id], versionNumber(q.version));
  writeSignRow_(table, i);
}

function syncStatusesFromEvents_(ss, table, events) {
  var col = table.col;
  var counts = signIdCounts(table.headers, table.rows);
  var certDocs = null;
  table.rows.forEach(function (row, i) {
    var id = String(row[col.id]).trim();
    // A duplicated 簽署ID is left alone: an event written now would bind every row that carries it.
    if (!id || counts[id] > 1) return;
    var fixed = statusFromEvents(events, id);
    var status = String(row[col.status]).trim();
    if (fixed && status !== fixed) {
      row[col.status] = fixed;
      writeSignRow_(table, i);
      return;
    }
    if (fixed) return;
    if (isIssued(row, col) && !parseVersionRecord(row[col.versionRecord])) backfillVersionRecord_(ss, table, i);
    var type = '', note = '';
    if (status === SIGN_STATUS.voided) type = '作廢';
    if (status === SIGN_STATUS.signed) {
      // Only an online signature leaves durable evidence: its certificate row in 文件 under the same 文件ID.
      var doc = String(row[col.signedDocId] || '').trim();
      if (certDocs === null) certDocs = ss.getSheetByName(DOC_SHEET).getDataRange().getValues();
      var k = doc ? findCertificateDoc(certDocs[0], certDocs.slice(1), id) : -1;
      if (k >= 0 && String(certDocs[k + 1][columnIndex(certDocs[0]).id]).trim() === doc) { type = '簽回'; note = '，簽回文件 ' + doc; }
    }
    if (!type) return;
    logSignEvent_(ss, id, type, 'system', '', '補記：狀態已是' + status + '，事件紀錄缺少' + note);
    events.push(['', id, type, new Date(), 'system', '', '補記' + note]);
  });
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

/** 報價ID -> {title, date, gross, version, groupId, caseId, sourceId} from 報價版本. */
function quoteInfo_(ss, quoteId) {
  var q = quoteTable_(ss);
  var col = q.col;
  for (var i = 0; i < q.rows.length; i++) {
    var r = q.rows[i];
    if (String(r[col.id]).trim() === quoteId) {
      return {
        id: quoteId, title: String(r[col.title]).trim(), date: isoDay(r[col.date]), gross: r[col.gross],
        version: String(r[col.version] == null ? '' : r[col.version]).trim(), groupId: String(r[col.groupId] || '').trim(),
        caseId: String(r[col.caseId]).trim(), sourceId: String(r[col.sourceId] || '').trim()
      };
    }
  }
  return null;
}

function snapshotFor_(row, col, quote, pdfSha) {
  return sha256Text_(signSnapshotText({
    signId: row[col.id], quoteId: row[col.quoteId], caseId: row[col.caseId], sourceId: row[col.sourceId],
    pdfSha256: pdfSha, gross: quote.gross, version: quote.version, groupId: quote.groupId, recipientEmail: row[col.recipientEmail]
  }));
}

/** Recomputes the snapshot of an open link from the sheet and the PDF as they are now. Returns {reason, file, blob}. */
function checkSnapshot_(ss, row, col, quote) {
  var fileId = documentFileIds_(ss)[String(row[col.sourceId]).trim()];
  if (!fileId) return { reason: '「文件」分頁找不到來源文件 ' + row[col.sourceId] };
  var file = DriveApp.getFileById(fileId);
  var blob = file.getBlob();
  var pdfSha = sha256Hex_(blob);
  var reason = snapshotProblem({
    rowSha: row[col.sha256], pdfSha: pdfSha, storedSnapshot: row[col.snapshot], computedSnapshot: snapshotFor_(row, col, quote, pdfSha),
    caseId: row[col.caseId], quoteCaseId: quote.caseId, sourceId: row[col.sourceId], quoteSourceId: quote.sourceId
  });
  return { reason: reason, file: file, blob: blob, pdfSha: pdfSha };
}

/** Voids every open link that a later one replaces under the version rules. */
function applySuperseded_(ss, table, quotes) {
  var col = table.col;
  var q = quotes || quoteTable_(ss);
  var counts = signIdCounts(table.headers, table.rows);
  planSuperseded(table.headers, table.rows, q.headers, q.rows).forEach(function (v) {
    if (counts[String(table.rows[v.index][col.id]).trim()] > 1) return;
    table.rows[v.index][col.status] = SIGN_STATUS.voided;
    writeSignRow_(table, v.index);
    logSignEvent_(ss, table.rows[v.index][col.id], '作廢', 'system', '', '已有較新的報價 ' + v.by);
  });
}

/**
 * Everything the public page needs to know about a token, after closing replaced links and repairing hand-edited
 * statuses. state is a pageStateFor value, or 'blocked' when the link is open but the version or snapshot check fails.
 */
function signState_(ss, token) {
  var table = signTable_(ss);
  var col = table.col;
  var tokenHash = sha256Text_(token);
  var i = findSignatureByTokenHash(table.headers, table.rows, tokenHash);
  if (i < 0) return { state: 'invalid', index: -1 };
  var sameToken = table.rows.filter(function (r) { return String(r[table.col.tokenHash]).trim() === tokenHash; }).length;
  if (sameToken > 1) return { state: 'blocked', index: i, reason: 'token雜湊 重複', ss: ss, table: table, col: table.col, row: table.rows[i], signId: String(table.rows[i][table.col.id]).trim() };
  var events = eventRows_(ss);
  syncStatusesFromEvents_(ss, table, events);
  var quotes = quoteTable_(ss);
  applySuperseded_(ss, table, quotes);
  var row = table.rows[i];
  var c = {
    ss: ss, table: table, col: col, index: i, row: row, signId: String(row[col.id]).trim(), events: events, quotes: quotes,
    state: pageStateFor(row[col.status], isoDay(row[col.dueDate]), todayIso_()), reason: ''
  };
  if (c.state !== 'open') return c;
  var blocked = function (reason) { c.state = 'blocked'; c.reason = reason; return c; };
  if (!SIGN_ID_PATTERN.test(c.signId)) return blocked('簽署ID 格式不正確');
  if (signIdCounts(table.headers, table.rows)[c.signId] > 1) return blocked('簽署ID 重複');
  if (!isEmail(row[col.recipientEmail])) return blocked('收件人Email 格式不正確');
  var v = versionBlockReason(table.headers, table.rows, i, quotes.headers, quotes.rows);
  if (v.reason) return blocked(v.reason);
  var quote = quoteInfo_(ss, String(row[col.quoteId]).trim());
  if (!quote) return blocked('「報價版本」找不到報價 ' + row[col.quoteId]);
  var snap = checkSnapshot_(ss, row, col, quote);
  if (snap.reason) return blocked(snap.reason);
  if (!parseVersionRecord(row[col.versionRecord])) {
    // A link written directly as 已寄送 gets its record once its snapshot is verified, i.e. the quote is as issued.
    row[col.versionRecord] = versionRecordFor(quoteGroupKeys(quotes.headers, quotes.rows)[quote.id], versionNumber(quote.version));
    writeSignRow_(table, i);
  }
  c.quote = quote;
  c.file = snap.file;
  c.blob = snap.blob;
  c.pdfSha = snap.pdfSha;
  return c;
}

/**
 * Menu: for each 待寄送 row, seal the snapshot, make the link and put the e-mail with the PDF in the owner's Gmail
 * drafts. The owner reads and sends each draft. Nothing is sent from here, and there is no trigger for this.
 */
function createSignDrafts(e) {
  if (e && e.triggerUid) throw new Error('建立草稿只能從試算表選單執行。');
  requireAdmin_();
  var report = withSignLock_(function () {
    var ss = book_();
    var table = signTable_(ss);
    var col = table.col, today = todayIso_();
    syncStatusesFromEvents_(ss, table, eventRows_(ss));
    var plan = planSendQueue(table.headers, table.rows, today);
    var done = 0, failed = 0;
    plan.invalid.forEach(function (p) {
      var row = table.rows[p.index];
      failed++;
      if (String(row[col.notes]).indexOf(p.reason) >= 0) return;
      row[col.notes] = (String(row[col.notes] || '') + ' 無法建立草稿：' + p.reason).trim();
      writeSignRow_(table, p.index);
    });
    plan.interrupted.forEach(function (i) {
      var row = table.rows[i];
      row[col.status] = SIGN_STATUS.failed; // token雜湊 and 到期日 stay: the draft may exist
      row[col.notes] = (clearSendFailureNote(row[col.notes]) + ' ｜寄送中斷：請到 Gmail 草稿匣確認草稿是否已建立，再決定是否重新處理').replace(/^ ｜/, '');
      writeSignRow_(table, i);
      logSignEvent_(ss, row[col.id], '寄送失敗', 'system', '', '上次建立草稿中斷，未自動重建');
    });
    plan.expire.forEach(function (i) {
      table.rows[i][col.status] = SIGN_STATUS.expired;
      writeSignRow_(table, i);
      logSignEvent_(ss, table.rows[i][col.id], '過期', 'system', '', '');
    });
    var quotes = quoteTable_(ss);
    applySuperseded_(ss, table, quotes);
    if (!plan.send.length) return { done: done, failed: failed };
    var url = webAppUrl_();
    if (!url) throw new Error('尚未設定 sign_webapp_url：請先部署網頁應用程式，並把網址填入「設定」分頁。');
    var files = documentFileIds_(ss);
    plan.send.forEach(function (i) {
      var row = table.rows[i];
      var signId = String(row[col.id]).trim();
      var before = row.slice();
      try {
        var fileId = files[String(row[col.sourceId]).trim()];
        if (!fileId) throw new Error('「文件」分頁找不到來源文件 ' + row[col.sourceId] + ' 的連結');
        var blob = DriveApp.getFileById(fileId).getBlob();
        var pdfSha = sha256Hex_(blob);
        var expected = String(row[col.sha256] || '').trim().toLowerCase();
        if (expected && pdfSha !== expected) throw new Error('PDF 內容與原檔SHA256 不符，可能已被修改');
        var quote = quoteInfo_(ss, String(row[col.quoteId]).trim());
        if (!quote) throw new Error('「報價版本」找不到報價 ' + row[col.quoteId]);
        if (quote.caseId !== String(row[col.caseId]).trim()) throw permanent_('報價 ' + row[col.quoteId] + ' 屬於案件 ' + quote.caseId + '，與簽署列不同');
        if (quote.sourceId && quote.sourceId !== String(row[col.sourceId]).trim()) throw permanent_('報價的來源文件ID 是 ' + quote.sourceId + '，與簽署列不同');
        var token = newToken_();
        var due = addWorkingDays(today, SIGN_VALID_WORKDAYS);
        row[col.sha256] = pdfSha;
        row[col.tokenHash] = sha256Text_(token);
        row[col.dueDate] = due;
        row[col.sentAt] = new Date();
        row[col.snapshot] = snapshotFor_(row, col, quote, pdfSha);
        row[col.versionRecord] = versionRecordFor(quoteGroupKeys(quotes.headers, quotes.rows)[quote.id], versionNumber(quote.version));
        // A lower version must not get a link once a higher one has been issued: it could never be signed.
        var v = versionBlockReason(table.headers, table.rows, i, quotes.headers, quotes.rows);
        if (v.reason) throw permanent_(v.reason);
        var prev = previousSendFor(table.headers, table.rows, i);
        var mail = buildSignEmail({ title: quote.title, gross: quote.gross, recipientName: row[col.recipientName], link: url + '?t=' + token, due: due, replaces: prev ? prev.sentDay : '' });
        var options = { htmlBody: mail.html, attachments: [blob.setName(quote.title + '.pdf')], name: COMPANY_NAME };
        if (String(row[col.cc] || '').trim()) options.cc = String(row[col.cc]).trim();
        // Record 寄送中 before the draft is made: if this run dies after Gmail saved it, the next run stops
        // instead of making a second draft with a second link.
        row[col.status] = SIGN_STATUS.sending;
        writeSignRow_(table, i);
        SpreadsheetApp.flush();
        GmailApp.createDraft(String(row[col.recipientEmail]).trim(), mail.subject, mail.text, options);
      } catch (err) {
        var failure = sendFailureNote(before[col.notes], err.message, SIGN_MAX_SEND_ATTEMPTS);
        table.rows[i] = before;
        row = before;
        row[col.status] = failure.giveUp || err.permanent ? SIGN_STATUS.failed : SIGN_STATUS.queued;
        row[col.notes] = failure.notes;
        writeSignRow_(table, i);
        logSignEvent_(ss, signId, '寄送失敗', 'system', '', '第 ' + failure.attempts + ' 次：' + err.message);
        failed++;
        return;
      }
      // The draft exists and its link is live. Nothing below may put the row back in the queue.
      row[col.status] = SIGN_STATUS.sent;
      row[col.reminders] = 0;
      row[col.notes] = clearSendFailureNote(row[col.notes]);
      writeSignRow_(table, i);
      logSignEvent_(ss, signId, '建立草稿', Session.getEffectiveUser().getEmail(), '', '草稿收件人 ' + row[col.recipientEmail]);
      done++;
    });
    applySuperseded_(ss, table, quotes);
    return { done: done, failed: failed };
  });
  book_().toast('已建立 ' + report.done + ' 份草稿' + (report.failed ? '，' + report.failed + ' 份未完成（見「簽署」備註）' : '') +
    '。請到 Gmail 草稿匣確認後寄出。', '沃克思報價簽署', 10);
  return report;
}

function permanent_(message) {
  var err = new Error(message);
  err.permanent = true;
  return err;
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
  var c = signState_(ss, token);
  if (c.index < 0) return { state: 'invalid' };
  var row = c.row, col = c.col;
  if (c.state === 'expired' && String(row[col.status]).trim() !== SIGN_STATUS.expired) {
    row[col.status] = SIGN_STATUS.expired;
    writeSignRow_(c.table, c.index);
    logSignEvent_(ss, c.signId, '過期', 'system', '', '開啟時已逾期');
  }
  if (c.state === 'open' && String(row[col.status]).trim() === SIGN_STATUS.sent) {
    row[col.status] = SIGN_STATUS.viewed;
    row[col.viewedAt] = new Date();
    writeSignRow_(c.table, c.index);
    logSignEvent_(ss, c.signId, '檢視', '連結開啟者（未驗證）', '', '');
  }
  if (c.state !== 'open') return { state: c.state };
  return {
    state: 'open', title: c.quote.title, date: c.quote.date, gross: c.quote.gross, due: isoDay(row[col.dueDate]),
    recipientName: row[col.recipientName], maskedEmail: maskEmail(row[col.recipientEmail])
  };
}

/**
 * Called from the page: the quote PDF as base64, only while the link is open and its snapshot holds, so the bytes are
 * the ones sealed at issue time. A signed client keeps the certificate; the link serves nothing afterwards.
 */
function downloadQuotePdf(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new Error('連結無效');
  return withSignLock_(function () {
    var c = signState_(book_(), token);
    if (c.state !== 'open') throw new Error('這個連結已無法下載');
    return { name: (c.quote.title || '報價單') + '.pdf', data: Utilities.base64Encode(c.blob.getBytes()) };
  });
}

/** The code belongs to one link (its token hash), not to a 簽署ID a second row might share. */
function otpKey_(tokenHash) { return 'sign_otp_' + tokenHash; }

/** The stored code for this link, or null when there is none or it was mailed for another row or snapshot. */
function storedCode_(cache, tokenHash, signId, snapshot) {
  var stored = null;
  try { stored = JSON.parse(cache.get(otpKey_(tokenHash)) || 'null'); } catch (e) { stored = null; }
  if (!stored || stored.signId !== signId || stored.snapshot !== snapshot) return null;
  return stored;
}

/** Saves the code state otpVerify returned, keeping its original expiry; null deletes it. */
function keepCode_(cache, tokenHash, stored) {
  if (!stored) { cache.remove(otpKey_(tokenHash)); return; }
  cache.put(otpKey_(tokenHash), JSON.stringify(stored), Math.max(1, Math.ceil((Number(stored.exp) - Date.now()) / 1000)));
}

/**
 * Called from the page: mails a 6-digit code to the recipient e-mail on the 簽署 row (never an address from the page).
 * Limits: one per minute, OTP_MAX_PER_DAY per link per 24 hours. Returns the masked address.
 */
function requestSignCode(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new Error('連結無效');
  var tokenHash = sha256Text_(String(token));
  return withSignLock_(function () {
    var ss = book_();
    // The rate limit is checked before the heavier state check (Drive read, reconciliation).
    var t = signTable_(ss);
    var k = findSignatureByTokenHash(t.headers, t.rows, tokenHash);
    if (k < 0) throw new Error('連結無效');
    var early = otpSendBlock(eventRows_(ss), String(t.rows[k][t.col.id]).trim(), Date.now());
    if (early) throw new Error(early);
    var c = signState_(ss, token);
    if (c.state === 'blocked') {
      logSignEvent_(ss, c.signId, '簽回受阻', 'system', '', c.reason);
      throw new Error(BLOCKED_MESSAGE);
    }
    if (c.state !== 'open') throw new Error('這個連結已無法簽回，請回覆原信件與我們聯絡。');
    var email = String(c.row[c.col.recipientEmail]).trim();
    var block = otpSendBlock(c.events, c.signId, Date.now());
    if (block) throw new Error(block);
    var code = otpCodeFrom(Utilities.getUuid());
    var exp = Date.now() + OTP_TTL_MS;
    // Logged first so a failing mail server still counts toward the daily limit.
    logSignEvent_(ss, c.signId, OTP_EVENT, 'system', '', '寄到 ' + email);
    CacheService.getScriptCache().put(otpKey_(tokenHash), JSON.stringify({
      hash: sha256Text_(tokenHash + '|' + code), exp: exp, tries: 0, signId: c.signId, snapshot: String(c.row[c.col.snapshot]).trim()
    }), OTP_TTL_MS / 1000);
    var mail = buildOtpEmail(code);
    GmailApp.sendEmail(email, mail.subject, mail.text, { name: COMPANY_NAME });
    return { sentTo: maskEmail(email) };
  });
}

function signPageHtml_(view, token) {
  var messages = {
    invalid: '這個連結無效。請確認網址完整，或回覆原信件與我們聯絡。',
    voided: '這份報價已有更新版本，這個連結已失效。請以最新寄出的報價單為準。',
    expired: '這個連結已過期。如仍需要這份報價，請回覆原信件與我們聯絡。',
    declined: '您已婉拒這份報價。如有變更，請回覆原信件與我們聯絡。',
    signed: '這份報價已完成簽回，謝謝您。',
    blocked: BLOCKED_MESSAGE
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
      '<div class="muted">為確認是本人簽署，請按下方按鈕，驗證碼會寄到 ' + escapeHtml(view.maskedEmail) + '。</div>' +
      '<button id="sc" class="ghost" style="margin-top:8px" onclick="sendCode()">寄送驗證碼</button>' +
      '<label>驗證碼（6 位數）<input id="cd" maxlength="6" inputmode="numeric" autocomplete="one-time-code"></label>' +
      '<button id="go" style="margin-top:16px" onclick="send()">確認簽回</button><div id="msg" class="err"></div>' +
      '<div class="note">送出後可下載簽回證明留存。如有問題，直接回覆寄給您的信件即可。</div>' +
      '<script>var T=' + JSON.stringify(token) + ';' + SIGN_PAGE_SCRIPT + '</script>';
  }
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body><div class="card">' + body + '</div></body></html>';
}

/** Browser script of the signing page: PDF download, signature pad, verification code, submit. */
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
  'function sendCode(){var b=document.getElementById("sc"),m=document.getElementById("msg");m.textContent="";b.disabled=true;b.textContent="寄送中…";',
  'google.script.run.withSuccessHandler(function(r){b.textContent="已寄到 "+r.sentTo+"（一分鐘後可重寄）";setTimeout(function(){b.disabled=false;b.textContent="重新寄送驗證碼";},60000);})',
  '.withFailureHandler(function(e){b.disabled=false;b.textContent="寄送驗證碼";m.textContent=e.message;}).requestSignCode(T);}',
  'function send(){var m=document.getElementById("msg"),b=document.getElementById("go"),n=document.getElementById("nm").value.trim(),cd=document.getElementById("cd").value.trim();m.textContent="";',
  'if(!n){m.textContent="請填寫簽署人姓名。";return;}if(!drawn){m.textContent="請先在簽名欄簽名。";return;}',
  'if(!document.getElementById("ok").checked){m.textContent="請勾選同意以電子簽名確認本報價單。";return;}',
  'if(!/^\\d{6}$/.test(cd)){m.textContent="請輸入信箱收到的 6 位數驗證碼。";return;}',
  'b.disabled=true;b.textContent="送出中…";',
  'google.script.run.withSuccessHandler(function(f){var k=document.querySelector(".card");k.innerHTML="<h1>簽回完成</h1><p>謝謝您，我們已收到您的簽回。</p>";',
  'if(f&&f.data){var bin=atob(f.data),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);var l=document.createElement("a");',
  'l.href=URL.createObjectURL(new Blob([a],{type:"application/pdf"}));l.download=f.name;l.textContent="下載簽回證明 PDF";l.className="btn";k.appendChild(l);}})',
  '.withFailureHandler(function(e){b.disabled=false;b.textContent="確認簽回";m.textContent=e.message;})',
  '.submitSignature(T,{name:n,title:document.getElementById("tt").value.trim(),consent:true,image:c.toDataURL("image/png"),agent:navigator.userAgent,code:cd});}'
].join('');

/** The online certificate of a signed row (its 文件 row matches the row's 簽回文件ID), or null. */
function certificateOf_(ss, row, col, signId) {
  var docId = String(row[col.signedDocId] || '').trim();
  if (!docId) return null;
  var data = ss.getSheetByName(DOC_SHEET).getDataRange().getValues();
  var k = findCertificateDoc(data[0], data.slice(1), signId);
  if (k < 0 || String(data[k + 1][columnIndex(data[0]).id]).trim() !== docId) return null;
  return DriveApp.getFileById(driveFileIdFromUrl(data[k + 1][columnIndex(data[0]).url]));
}

/**
 * The certificate of a signature, made at most once per 簽署ID. A retry after a failure part-way reuses the 文件 row,
 * else the Drive file whose name starts with the 簽署ID, and only creates a new file when neither exists.
 * A reused file must carry this 簽署ID and this link's snapshot in its description, or the run stops for a person to
 * reconcile. A file left without a description (the run stopped right after creating it, before any row pointed at it)
 * is trashed and made again. The signer details of the first complete submission win. Returns {docId, file, name, meta}.
 */
function signedCertificate_(ss, c, input, quote) {
  var signId = c.signId, row = c.row, col = c.col;
  var snapshot = String(row[col.snapshot]).trim();
  var docSheet = ss.getSheetByName(DOC_SHEET);
  var docData = docSheet.getDataRange().getValues();
  var dcol = columnIndex(docData[0]);
  var trusted = function (file) {
    var meta = parseCertificateMeta(file.getDescription(), signId);
    return meta && meta.snapshot === snapshot && isCertificateFileFor(file.getName(), signId) ? meta : null;
  };
  var k = findCertificateDoc(docData[0], docData.slice(1), signId);
  if (k >= 0) {
    var found = docData[k + 1];
    var existing = DriveApp.getFileById(driveFileIdFromUrl(found[dcol.url]));
    var known = trusted(existing);
    if (!known || sha256Hex_(existing.getBlob()) !== String(found[dcol.sha256]).trim().toLowerCase()) {
      throw new Error('「文件」分頁的簽回證明 ' + found[dcol.id] + ' 與這個連結不符，請人工核對。');
    }
    return { docId: String(found[dcol.id]).trim(), file: existing, name: existing.getName(), meta: known, reused: true };
  }
  var file = null, meta = null;
  var folderId = folderIdFrom(settingValue_('signed_folder_id'));
  var parents = c.file.getParents();
  var folder = folderId ? DriveApp.getFolderById(folderId) : (parents.hasNext() ? parents.next() : DriveApp.getRootFolder());
  // Only the certificate folder is searched, so a file elsewhere in the owner's Drive is never touched.
  // signId matches SIGN_ID_PATTERN (checked in signState_), so it cannot break out of the quoted query.
  var it = folder.searchFiles('title contains "' + signId + '" and trashed = false');
  while (it.hasNext()) {
    var f = it.next();
    if (!isCertificateFileFor(f.getName(), signId)) continue;
    var m = trusted(f);
    if (m) { file = f; meta = m; break; }
    if (!String(f.getDescription() || '').trim()) { f.setTrashed(true); continue; }
    throw new Error('雲端硬碟裡的簽回證明 ' + f.getName() + ' 與這個連結不符，請人工核對。');
  }
  var reused = !!file;
  if (!file) {
    var now = new Date();
    var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
    var signedAt = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss') + '（' + tz + '）';
    var html = buildCertificateHtml({
      title: quote.title || '報價單', date: quote.date || '', gross: quote.gross, name: input.name, signerTitle: input.title,
      signedAt: signedAt, recipientEmail: String(row[col.recipientEmail]).trim(),
      verifiedBy: '驗證碼寄至收件人 Email，輸入正確', signId: signId, filename: c.file.getName(),
      sha256: c.pdfSha, snapshot: snapshot, agent: input.agent, imageBase64: input.imageBase64
    });
    var certName = certificateFileName(quote.title, signId);
    var cert = Utilities.newBlob(html, 'text/html', 'certificate.html').getAs('application/pdf').setName(certName);
    file = folder.createFile(cert);
    var description = { signId: signId, snapshot: snapshot, name: input.name, title: input.title, signedAt: signedAt, signedAtIso: now.toISOString(), agent: input.agent };
    file.setDescription(JSON.stringify(description));
    meta = parseCertificateMeta(JSON.stringify(description), signId);
  }
  var docId = docIdFor(file.getId());
  docSheet.appendRow(sheetSafeRow(signedDocumentRow(docData[0], {
    id: docId, filename: file.getName(), url: file.getUrl(), sha256: sha256Hex_(file.getBlob()), caseNumber: guessCaseNumber(quote.title, '')
  })));
  return { docId: docId, file: file, name: file.getName(), meta: meta, reused: reused };
}

/**
 * Called from the signing page. Checks the link, the version, the snapshot and the mailed code; then saves the
 * certificate (once per 簽署ID), registers it in 文件, writes the case and quote fields, marks the row 已簽回, hands
 * the certificate back to the page and notifies the owner. Safe to call again after a failure part-way.
 */
function submitSignature(token, payload) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new Error('連結無效');
  var input = validateSignature(payload);
  if (input.error) throw new Error(input.error);
  return withSignLock_(function () {
    var ss = book_();
    var c = signState_(ss, token);
    if (c.index < 0) throw new Error('連結無效');
    var tokenHash = sha256Text_(String(token));
    var cache = CacheService.getScriptCache();
    var row = c.row, col = c.col, signId = c.signId;
    // Until the code is verified, whoever holds the link is not known to be the recipient.
    var actor = '連結開啟者（未驗證）';
    if (c.state === 'signed') {
      // The response of a completed signature may have been lost: the same verified code (still within its
      // 10 minutes) gets the certificate again. Nothing else is served from a signed link.
      var again = storedCode_(cache, tokenHash, signId, String(row[col.snapshot]).trim());
      var ok = again && otpVerify(again, sha256Text_(tokenHash + '|' + input.code), Date.now());
      if (ok && !ok.ok) keepCode_(cache, tokenHash, ok.stored);
      var receipt = ok && ok.ok ? certificateOf_(ss, row, col, signId) : null;
      return receipt ? { ok: true, name: receipt.getName(), data: Utilities.base64Encode(receipt.getBlob().getBytes()) } : { ok: true };
    }
    if (c.state === 'blocked') {
      logSignEvent_(ss, signId, '簽回失敗', actor, input.agent, c.reason);
      throw new Error(BLOCKED_MESSAGE);
    }
    if (c.state !== 'open') throw new Error('這個連結已無法簽回，請回覆原信件與我們聯絡。');
    var quoteId = String(row[col.quoteId]).trim(), caseId = String(row[col.caseId]).trim();
    // Checked before anything is created: a link whose case is missing must not end up 已簽回.
    if (!caseId || !caseRowExists_(ss, caseId)) {
      logSignEvent_(ss, signId, '簽回失敗', actor, input.agent, '找不到案件 ' + caseId);
      throw new Error(BLOCKED_MESSAGE);
    }
    var stored = storedCode_(cache, tokenHash, signId, String(row[col.snapshot]).trim());
    var check = otpVerify(stored, sha256Text_(tokenHash + '|' + input.code), Date.now());
    if (!check.ok) {
      keepCode_(cache, tokenHash, check.stored);
      logSignEvent_(ss, signId, '驗證失敗', actor, input.agent, check.error);
      throw new Error(check.error);
    }
    actor = String(row[col.recipientEmail]).trim();
    if (!isPngBytes(Utilities.base64Decode(input.imageBase64))) throw new Error('簽名圖檔無法讀取，請清除後重簽。');
    var effectiveBlock = effectiveBlockReason(c.quotes.headers, c.quotes.rows, caseId, quoteId);
    if (effectiveBlock) {
      logSignEvent_(ss, signId, '簽回失敗', actor, input.agent, effectiveBlock);
      throw new Error(BLOCKED_MESSAGE);
    }
    var cert = signedCertificate_(ss, c, input, c.quote);
    var meta = cert.meta;
    var day = isoDay(String(meta.signedAt).slice(0, 10)) || todayIso_();
    var signedTime = meta.signedAtIso ? new Date(meta.signedAtIso) : new Date();
    // Case first, then the row: if the case write throws, the link stays open and the client can submit again.
    applySignedToCase_(ss, caseId, quoteId, day, cert.docId);
    row[col.status] = SIGN_STATUS.signed;
    row[col.signedAt] = isNaN(signedTime.getTime()) ? new Date() : signedTime;
    row[col.signer] = meta.name;
    row[col.signerTitle] = meta.title;
    row[col.signedDocId] = cert.docId;
    writeSignRow_(c.table, c.index);
    logSignEvent_(ss, signId, '簽回', actor, meta.agent, '線上簽名：' + meta.name + '，驗證碼通過，簽回文件 ' + cert.docId + (cert.reused ? '（沿用先前產生的證明）' : ''));
    var certBlob = cert.file.getBlob();
    // The client gets the certificate from the page. Only the owner's own account is e-mailed (not a configurable
    // address that could be a client's): nothing but the verification code goes to a client without the owner.
    try {
      var notify = Session.getEffectiveUser().getEmail();
      if (notify) GmailApp.sendEmail(notify, '【簽回】' + c.quote.title + '（' + meta.name + '）',
        '客戶已在線上簽回「' + c.quote.title + '」。\n簽署人：' + meta.name + (meta.title ? '／' + meta.title : '') +
        '\n簽署編號：' + signId + '\n案件與報價欄位已自動寫入試算表，附件是簽回證明。', { attachments: [certBlob], name: COMPANY_NAME });
    } catch (e) {
      logSignEvent_(ss, signId, '通知失敗', 'system', '', '簽回通知信未寄出：' + e.message);
    }
    return { ok: true, name: cert.name, data: Utilities.base64Encode(certBlob.getBytes()) };
  });
}

/** Menu: mark a quote signed (client replied by e-mail). Writes the case fields by the same rules as the page. */
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
  syncStatusesFromEvents_(ss, table, eventRows_(ss));
  var i = -1;
  table.rows.forEach(function (r, k) { if (String(r[col.id]).trim() === signId) i = k; });
  if (i < 0) return '找不到簽署ID ' + signId;
  if (!/^doc_/.test(docId)) return '簽回文件ID 須為 doc_ 開頭';
  if (signIdCounts(table.headers, table.rows)[signId] > 1) return signId + ' 未標記：簽署ID 重複，請先修正「簽署」分頁。';
  var row = table.rows[i];
  var caseId = String(row[col.caseId]).trim(), quoteId = String(row[col.quoteId]).trim();
  var quotes = quoteTable_(ss);
  // Same version rules as the page: an older or ambiguous version is never marked signed, nor re-applied.
  var v = versionBlockReason(table.headers, table.rows, i, quotes.headers, quotes.rows);
  if (v.reason) return signId + ' 未標記：' + v.reason + '。';
  var effective = effectiveBlockReason(quotes.headers, quotes.rows, caseId, quoteId);
  if (effective) return signId + ' 未標記：' + effective + '。';
  var quote = quoteInfo_(ss, quoteId);
  if (!quote) return signId + ' 未標記：「報價版本」找不到報價 ' + quoteId + '。';
  if (!caseRowExists_(ss, caseId)) return signId + ' 未標記：「案件商機」找不到案件 ' + caseId + '。';
  if (String(row[col.status]).trim() === SIGN_STATUS.signed) {
    // Already signed: re-apply the case fields so a run that failed half-way can be repaired. Writes are idempotent.
    // Only a signature the audit log confirms, with its own 簽回文件ID, on terms that still match the snapshot.
    var storedDoc = String(row[col.signedDocId] || '').trim();
    var events = eventRows_(ss);
    if (statusFromEvents(events, signId) !== SIGN_STATUS.signed || !storedDoc) return signId + ' 的「已簽回」沒有簽回事件或簽回文件ID，未變更，請人工核對。';
    if (signedEventDocId(events, signId) !== storedDoc) return signId + ' 的簽回文件ID 與簽回事件記錄的不同，未變更，請人工核對。';
    if (storedDoc !== docId) return signId + ' 已經是已簽回（簽回文件 ' + storedDoc + '），與輸入的 ' + docId + ' 不同，未變更。';
    if (!(storedDoc in documentFileIds_(ss))) return '「文件」分頁找不到文件ID ' + storedDoc + '，未變更。';
    var held = checkSnapshot_(ss, row, col, quote);
    if (held.reason) return signId + ' 未變更：' + held.reason + '。';
    return signId + ' 已經是已簽回。' + applySignedToCase_(ss, caseId, quoteId, isoDay(row[col.signedAt]) || todayIso_(), storedDoc);
  }
  var blocked = signBlockReason(row[col.status]);
  if (blocked) return signId + ' 未標記：' + blocked;
  if (!(docId in documentFileIds_(ss))) return '「文件」分頁找不到文件ID ' + docId + '，未標記。';
  // The client confirmed what the link showed: refuse when the quote, amount, PDF or case changed since.
  var snap = checkSnapshot_(ss, row, col, quote);
  if (snap.reason) return signId + ' 未標記：' + snap.reason + '。';
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

/** Writes the case + quote fields for a signed quote. Returns a short report. Refuses to revive an older version. */
function applySignedToCase_(ss, caseId, quoteId, day, docId) {
  var qSheet = ss.getSheetByName('報價版本');
  var qData = qSheet.getDataRange().getValues();
  var qCol = headerIndex(qData[0], QUOTE_SIGN_HEADERS, '報價版本');
  var block = effectiveBlockReason(qData[0], qData.slice(1), caseId, quoteId);
  if (block) throw new Error(block);
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
    var note = '線上簽回 ' + day + '：' + plan.conflicts.join('；');
    // A retry after a failure part-way must not append the same note twice.
    if (prev.indexOf(note) < 0) sheet.getRange(r + 1, col.reviewNotes + 1).setValue(sheetSafe((prev ? prev + '；' : '') + note));
  }
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
    syncStatusesFromEvents_(ss, table, eventRows_(ss));
    for (var i = 0; i < table.rows.length; i++) {
      if (String(table.rows[i][col.id]).trim() !== signId) continue;
      var status = String(table.rows[i][col.status]).trim();
      if ([SIGN_STATUS.queued, SIGN_STATUS.sending, SIGN_STATUS.failed, SIGN_STATUS.sent, SIGN_STATUS.viewed, SIGN_STATUS.draft].indexOf(status) < 0) return signId + ' 狀態為' + status + '，不能作廢。';
      table.rows[i][col.status] = SIGN_STATUS.voided;
      writeSignRow_(table, i);
      logSignEvent_(ss, signId, '作廢', Session.getActiveUser().getEmail() || 'owner', '', '手動作廢');
      return signId + ' 已作廢，連結立即失效，之後也不能再改回。';
    }
    return '找不到簽署ID ' + signId;
  });
  ui.alert(msg);
}

/** Menu: put a 寄送失敗 row back in the queue, or confirm its draft already exists, after the owner checked why. */
function retrySendFromMenu() {
  requireAdmin_();
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('重新處理寄送失敗的報價', '輸入簽署ID（sig_ 開頭）。\n若備註寫「寄送中斷」，請先到 Gmail 草稿匣確認草稿是否已建立，以免客戶收到兩個連結。', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var signId = a.getResponseText().trim();
  var choice = ui.alert('重新建立草稿？', '「是」：放回待寄送，之後重新建立草稿（舊連結作廢）。\n「否」：草稿其實已建立，只把狀態改為已寄送，草稿中的連結照常可用。', ui.ButtonSet.YES_NO_CANCEL);
  if (choice !== ui.Button.YES && choice !== ui.Button.NO) return;
  var alreadySent = choice === ui.Button.NO;
  var msg = withSignLock_(function () {
    var ss = SpreadsheetApp.getActive();
    var table = signTable_(ss);
    var col = table.col;
    syncStatusesFromEvents_(ss, table, eventRows_(ss));
    for (var i = 0; i < table.rows.length; i++) {
      if (String(table.rows[i][col.id]).trim() !== signId) continue;
      var status = String(table.rows[i][col.status]).trim();
      if (status !== SIGN_STATUS.failed) return signId + ' 狀態為' + status + '，不需要重新處理。';
      var row = table.rows[i];
      var notes = clearSendFailureNote(row[col.notes]).replace(/\s*｜?寄送中斷：[\s\S]*$/, '').trim();
      var actor = Session.getActiveUser().getEmail() || 'owner';
      if (alreadySent) {
        if (!String(row[col.tokenHash] || '').trim() || !String(row[col.snapshot] || '').trim()) return signId + ' 沒有已產生的連結，無法標記為已寄送；請選擇重新建立。';
        row[col.status] = SIGN_STATUS.sent;
        row[col.reminders] = 0;
        row[col.notes] = notes;
        writeSignRow_(table, i);
        logSignEvent_(ss, signId, '建立草稿', actor, '', '中斷後人工確認草稿已建立');
        applySuperseded_(ss, table);
        return signId + ' 已標記為已寄送，草稿中的連結有效。';
      }
      row[col.status] = SIGN_STATUS.queued;
      row[col.tokenHash] = '';
      row[col.dueDate] = '';
      row[col.sentAt] = '';
      row[col.snapshot] = '';
      // 版本紀錄 stays: the interrupted draft may have reached the client, so its version still closes older ones.
      row[col.notes] = notes;
      writeSignRow_(table, i);
      logSignEvent_(ss, signId, '重新寄送', actor, '', '手動放回佇列');
      return signId + ' 已放回待寄送，請按「建立待寄送報價的 Gmail 草稿」。';
    }
    return '找不到簽署ID ' + signId;
  });
  ui.alert(msg);
}
