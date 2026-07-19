// 번역 시작: 이용권에서 장수를 차감하고 번역 통행증(토큰)을 발급한다
// { code, pages } → { ok, token, remaining }
import { sheetRequest, issueToken } from '../_utils';

export async function POST(req) {
  try {
    const { code, pages } = await req.json();
    const trimmed = String(code || '').trim();
    const n = Math.floor(Number(pages));
    if (!trimmed || !n || n < 1 || n > 2000) {
      return Response.json({ error: '요청 내용이 올바르지 않습니다.' }, { status: 400 });
    }
    const result = await sheetRequest('deduct', trimmed, n);
    if (result.error) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json({
      ok: true,
      token: issueToken(trimmed, n),
      remaining: result.remaining,
    });
  } catch (e) {
    console.error(e);
    return Response.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
