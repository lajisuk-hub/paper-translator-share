// 서버 전용 도우미: 이용권 확인/차감(구글시트)과 번역 통행증(토큰) 발급/검사
import crypto from 'crypto';

const TOKEN_HOURS = 6; // 통행증 유효 시간 (긴 논문도 넉넉히)

function secret() {
  return process.env.APP_SECRET || '';
}

// ── 번역 통행증: "차감을 마친 사용자"임을 증명하는 서명된 문자열 ──
// 안에 코드와 차감한 장수가 들어 있어서, 환불할 때 그대로 믿고 쓸 수 있다.

export function issueToken(code, pages) {
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  const payload = `${code}|${pages}|${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

// 유효하면 { code, pages }를, 아니면 null을 돌려준다
export function parseToken(token) {
  try {
    if (!token || !secret()) return null;
    const [b64, sig] = String(token).split('.');
    const payload = Buffer.from(b64, 'base64url').toString();
    const expect = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
    if (sig.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const parts = payload.split('|');
    const exp = Number(parts[parts.length - 1]);
    if (Date.now() >= exp) return null;
    return { code: parts[0], pages: Number(parts[1]) || 0 };
  } catch {
    return null;
  }
}

export function verifyToken(token) {
  return parseToken(token) !== null;
}

// 같은 통행증으로 환불을 두 번 받지 못하게 하는 고유 번호
export function tokenId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
}

// ── 구글시트(Apps Script)와 통신 ──
// action: 'check' → { ok, remaining } / 'deduct' → { ok, remaining }

export async function sheetRequest(action, code, pages, refundId) {
  // 관리자 전용 마스터 코드: 시트 없이 무제한 사용 (원장님 본인용)
  const master = process.env.MASTER_CODE;
  if (master && code === master) {
    return { ok: true, remaining: 99999, master: true };
  }

  const url = process.env.SHEET_API_URL;
  if (!url) {
    return { error: '이용권 확인 장치가 아직 연결되지 않았습니다. 관리자에게 문의해 주세요.' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: secret(), action, code, pages, refundId }),
      redirect: 'follow', // Apps Script는 302로 응답을 넘겨준다
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      console.error('Apps Script 응답 해석 실패:', text.slice(0, 300));
      return { error: '이용권 확인 중 오류가 났습니다. 잠시 후 다시 시도해 주세요.' };
    }
  } catch (e) {
    console.error('Apps Script 통신 실패:', e);
    return { error: '이용권 확인 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
