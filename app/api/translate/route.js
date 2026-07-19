// 두 가지 요청을 받는다:
// 1) { blocks: [{id, text}], token } — 위치 조각별 번역 (원본 위에 덮어쓰기용)
// 2) { text, token } — 통짜 텍스트를 문단 짝으로 번역 (예전 방식 호환)
// token = /api/redeem 에서 장수를 차감하고 받은 번역 통행증
import { verifyToken } from '../_utils';

export async function POST(req) {
  try {
    const body = await req.json();
    if (!verifyToken(body.token)) {
      return Response.json(
        { error: '이용권 확인이 필요합니다. 코드를 입력하고 번역을 시작해 주세요.' },
        { status: 401 }
      );
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: 'AI 비밀키가 설정되지 않았습니다. .env.local 파일을 확인해주세요.' },
        { status: 500 }
      );
    }

    if (Array.isArray(body.blocks) && body.blocks.length > 0) {
      return await translateBlocks(body.blocks, apiKey);
    }
    if (body.text && body.text.trim()) {
      return await translatePairs(body.text, apiKey);
    }
    return Response.json({ error: '번역할 내용이 비어 있습니다.' }, { status: 400 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: '서버 오류가 발생했습니다.' }, { status: 500 });
  }
}

async function callClaude(prompt, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 12000,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error('Anthropic API error:', res.status, errBody);
    return null;
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---------- 새 방식: 번호 붙은 조각별 번역 ----------

async function translateBlocks(blocks, apiKey) {
  const list = blocks
    .map((b) => `@@${b.id}@@\n${b.text}`)
    .join('\n\n');

  const prompt = `다음은 영어 학술 문서의 한 쪽에서 위치별로 뽑아낸 글 조각들입니다.
각 조각은 @@번호@@ 아래에 적혀 있습니다. 줄바꿈 때문에 단어가 어색하게 붙어 있을 수 있습니다.

작업: 각 조각을 학술 문서에 어울리는 정확하고 자연스러운 한국어로 번역하세요.

규칙:
1. 조각마다 반드시 하나의 답을 내고, 조각을 합치거나 나누지 마세요.
2. 참고문헌 항목, 사람 이름, 순수한 숫자·기호·URL처럼 번역이 무의미한 조각은 원문을 그대로 출력하세요.
3. 번역문 길이는 원문과 비슷하게, 불필요한 설명을 덧붙이지 마세요.

출력 형식 (이 형식 외의 말은 한 글자도 추가하지 마세요):
@@번호@@
(그 조각의 한국어 번역)

조각들:
${list}`;

  const raw = await callClaude(prompt, apiKey);
  if (raw === null) {
    return Response.json({ error: 'AI 번역 중 오류가 났습니다.' }, { status: 502 });
  }

  const translations = {};
  const parts = raw.split(/@@(\d+)@@/);
  // parts: [앞말, id, 내용, id, 내용, ...]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const id = parts[i];
    const ko = (parts[i + 1] || '').trim();
    if (ko) translations[id] = ko;
  }
  if (Object.keys(translations).length === 0) {
    console.error('블록 파싱 실패. AI 응답 앞부분:', raw.slice(0, 500));
    return Response.json({ error: 'AI 응답을 해석하지 못했습니다.' }, { status: 502 });
  }
  return Response.json({ translations });
}

// ---------- 예전 방식: 문단 짝 번역 (호환용) ----------

async function translatePairs(text, apiKey) {
  const prompt = `다음은 영어 학술 논문 PDF에서 추출한 텍스트의 일부입니다.
줄이 어색하게 끊겨 있거나 하이픈으로 단어가 나뉘어 있을 수 있습니다.

작업:
1. 끊긴 줄과 나뉜 단어를 이어 붙여 자연스러운 문단으로 복원하세요.
2. 각 문단을 학술 논문에 어울리는 정확하고 자연스러운 한국어로 번역하세요.
3. 제목·소제목은 그 자체로 하나의 문단으로 다루고, 영어 원문 줄 맨 앞에 "## "를 붙이세요.
4. 참고문헌(References) 목록 항목은 번역하지 말고 한국어 자리에도 영어 원문을 그대로 두세요.
5. 머리글/바닥글, 쪽 번호, 깨진 조각은 건너뛰세요.

출력 형식 (이 형식 외의 말은 한 글자도 추가하지 마세요):
각 문단마다 아래 세 줄 구조를 반복합니다.

@@EN@@
(영어 원문 문단)
@@KO@@
(한국어 번역 문단)

텍스트:
${text}`;

  const raw = await callClaude(prompt, apiKey);
  if (raw === null) {
    return Response.json({ error: 'AI 번역 중 오류가 났습니다.' }, { status: 502 });
  }

  const pairs = parsePairs(raw);
  if (pairs.length === 0) {
    console.error('파싱 실패. AI 응답 앞부분:', raw.slice(0, 500));
    return Response.json({ error: 'AI 응답을 해석하지 못했습니다.' }, { status: 502 });
  }
  return Response.json({ pairs });
}

function parsePairs(raw) {
  const pairs = [];
  const blocks = raw.split('@@EN@@');
  for (const block of blocks) {
    if (!block.includes('@@KO@@')) continue;
    const [enPart, koPart] = block.split('@@KO@@');
    let en = (enPart || '').trim();
    let ko = (koPart || '').trim();
    if (!en || !ko) continue;
    let heading = false;
    if (en.startsWith('## ')) {
      heading = true;
      en = en.slice(3).trim();
    }
    if (ko.startsWith('## ')) ko = ko.slice(3).trim();
    if (!heading && looksLikeHeading(en)) heading = true;
    pairs.push({ en, ko, heading });
  }
  return pairs;
}

function looksLikeHeading(en) {
  if (en.length > 80) return false;
  if (/[.?!;:,]$/.test(en)) return false;
  return en.split(/\s+/).length <= 8;
}
