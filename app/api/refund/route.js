// 번역이 통째로 실패했을 때: 차감했던 장수를 자동으로 되돌려준다
// { token } → { ok, remaining }
// 통행증(token) 안에 코드와 장수가 들어 있어 그대로 믿고 쓰며,
// 같은 통행증으로는 한 번만 환불된다 (구글시트에 환불기록 남김).
import { parseToken, tokenId, sheetRequest } from '../_utils';

export async function POST(req) {
  try {
    const { token } = await req.json();
    const info = parseToken(token);
    if (!info || !info.pages) {
      return Response.json({ error: '환불 요청이 올바르지 않습니다.' }, { status: 400 });
    }
    const result = await sheetRequest('refund', info.code, info.pages, tokenId(token));
    if (result.error) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json({ ok: true, remaining: result.remaining });
  } catch (e) {
    console.error(e);
    return Response.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
