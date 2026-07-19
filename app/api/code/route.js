// 이용권 코드 확인: { code } → { ok, remaining }
import { sheetRequest } from '../_utils';

export async function POST(req) {
  try {
    const { code } = await req.json();
    const trimmed = String(code || '').trim();
    if (!trimmed) {
      return Response.json({ error: '코드를 입력해 주세요.' }, { status: 400 });
    }
    const result = await sheetRequest('check', trimmed);
    if (result.error) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json({ ok: true, remaining: result.remaining });
  } catch (e) {
    console.error(e);
    return Response.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}
