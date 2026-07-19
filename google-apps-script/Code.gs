// ─────────────────────────────────────────────────────────────
// 논문 번역 앱 - 이용권 코드 관리 (구글시트 Apps Script)
//
// 시트 구성 (자동으로 만들어집니다):
//  · "코드" 시트: A열=코드, B열=남은장수, C열=메모, D열=마지막사용
//  · "사용기록" 시트: 사용할 때마다 한 줄씩 기록
//
// 코드를 새로 발급하려면 "코드" 시트에 한 줄만 추가하면 됩니다.
//  예)  HAPPY123 | 23 | 김선생님 7/20 입금
// ─────────────────────────────────────────────────────────────

// ★ 아래 비밀값을 Vercel의 APP_SECRET과 똑같이 맞춰 주세요
const SECRET = 'CHANGE_ME_SECRET';

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ error: '요청을 읽지 못했습니다.' });
  }
  if (body.secret !== SECRET) {
    return respond({ error: '허가되지 않은 요청입니다.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const codeSheet = getOrCreateCodeSheet();
    const code = String(body.code || '').trim();
    if (!code) return respond({ error: '코드가 비어 있습니다.' });

    const row = findCodeRow(codeSheet, code);
    if (row === -1) {
      return respond({ error: '등록되지 않은 코드입니다. 코드를 다시 확인해 주세요.' });
    }
    const remaining = Number(codeSheet.getRange(row, 2).getValue()) || 0;

    if (body.action === 'check') {
      return respond({ ok: true, remaining: remaining });
    }

    if (body.action === 'deduct') {
      const pages = Math.floor(Number(body.pages)) || 0;
      if (pages < 1) return respond({ error: '차감할 장수가 올바르지 않습니다.' });
      if (remaining < pages) {
        return respond({ error: '남은 장수가 부족합니다. (남은 장수: ' + remaining + '장)' });
      }
      const after = remaining - pages;
      codeSheet.getRange(row, 2).setValue(after);
      codeSheet.getRange(row, 4).setValue(new Date());
      logUsage(code, pages, after);
      return respond({ ok: true, remaining: after });
    }

    // 번역이 통째로 실패했을 때 차감분을 되돌린다 (같은 건은 한 번만)
    if (body.action === 'refund') {
      const pages = Math.floor(Number(body.pages)) || 0;
      const refundId = String(body.refundId || '').trim();
      if (pages < 1 || !refundId) return respond({ error: '환불 요청이 올바르지 않습니다.' });
      if (alreadyRefunded(refundId)) {
        return respond({ error: '이미 환불 처리된 건입니다.' });
      }
      const after = remaining + pages;
      codeSheet.getRange(row, 2).setValue(after);
      codeSheet.getRange(row, 4).setValue(new Date());
      logRefund(code, pages, after, refundId);
      return respond({ ok: true, remaining: after });
    }

    return respond({ error: '알 수 없는 요청입니다.' });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateCodeSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('코드');
  if (!sheet) {
    sheet = ss.insertSheet('코드');
    sheet.appendRow(['코드', '남은장수', '메모', '마지막사용']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findCodeRow(sheet, code) {
  // 대문자/소문자가 달라도 같은 코드로 인정한다 (HAPPY123 = happy123)
  const target = String(code).trim().toUpperCase();
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const values = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() === target) return i + 2;
  }
  return -1;
}

function logUsage(code, pages, remainingAfter) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('사용기록');
  if (!sheet) {
    sheet = ss.insertSheet('사용기록');
    sheet.appendRow(['시각', '코드', '사용장수', '남은장수']);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([new Date(), code, pages, remainingAfter]);
}

function getRefundSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('환불기록');
  if (!sheet) {
    sheet = ss.insertSheet('환불기록');
    sheet.appendRow(['시각', '코드', '돌려준장수', '남은장수', '처리번호']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function alreadyRefunded(refundId) {
  const sheet = getRefundSheet();
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const values = sheet.getRange(2, 5, last - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === refundId) return true;
  }
  return false;
}

function logRefund(code, pages, remainingAfter, refundId) {
  getRefundSheet().appendRow([new Date(), code, pages, remainingAfter, refundId]);
  // 사용기록에도 마이너스로 남겨서 흐름을 한눈에 볼 수 있게 한다
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usage = ss.getSheetByName('사용기록');
  if (usage) usage.appendRow([new Date(), code, -pages, remainingAfter]);
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
