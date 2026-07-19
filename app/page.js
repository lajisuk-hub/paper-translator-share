'use client';

import { useEffect, useRef, useState } from 'react';
import { PRICE_PER_PAGE, BANK_INFO, KAKAO_LINK, CONTACT_PHONE } from './config';

const LEGACY_KEY = 'paper-translator-papers-v1';

// ---------- 저장소 (IndexedDB — 쪽 사진까지 저장하려면 용량이 커서 localStorage 대신 사용) ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('paper-translator', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('papers', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('papers').objectStore('papers').getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

async function dbPut(paper) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('papers', 'readwrite');
    tx.objectStore('papers').put(paper);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('papers', 'readwrite');
    tx.objectStore('papers').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 예전 버전(글자만 저장)의 자료도 계속 보이게 한다
function loadLegacy() {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveLegacy(papers) {
  localStorage.setItem(LEGACY_KEY, JSON.stringify(papers));
}

async function loadAllPapers() {
  const idb = await dbAll().catch(() => []);
  const legacy = loadLegacy().map((p) => ({ ...p, legacy: true }));
  return [...idb, ...legacy].sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || '')
  );
}

// ---------- PDF 읽기: 쪽마다 (사진 + 위치가 붙은 글 조각)를 뽑는다 ----------

async function extractPdfPages(file, onProgress) {
  const pdfjs = await import('pdfjs-dist');
  // 작업 도우미 파일은 public 폴더에 복사해 둔 것을 쓴다 (webpack이 못 읽는 문제 회피)
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];

  for (let p = 1; p <= doc.numPages; p++) {
    onProgress && onProgress(p, doc.numPages);
    const page = await doc.getPage(p);

    const baseViewport = page.getViewport({ scale: 1 });
    const pageW = baseViewport.width;
    const pageH = baseViewport.height;

    // 1) 쪽 사진 찍기
    const scale = Math.min(2, 1100 / pageW);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    // intent: 'print' — 창이 최소화되거나 다른 탭을 보는 중에도 멈추지 않고 그려진다
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    const image = canvas.toDataURL('image/jpeg', 0.82);

    // 2) 글 조각(문단 덩어리)과 위치 뽑기 — PDF 좌표는 왼쪽 아래가 원점
    const content = await page.getTextContent();
    const lines = [];
    let cur = null;
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const h = Math.abs(item.transform[3]) || Math.hypot(item.transform[2], item.transform[3]) || 10;
      const w = item.width || 0;
      if (cur && Math.abs(y - cur.y) <= 2.5) {
        const sep = cur.text.endsWith(' ') || item.str.startsWith(' ') ? '' : ' ';
        cur.text += sep + item.str;
        cur.x1 = Math.max(cur.x1, x + w);
        cur.x0 = Math.min(cur.x0, x);
        cur.h = Math.max(cur.h, h);
      } else {
        if (cur) lines.push(cur);
        cur = { y, x0: x, x1: x + w, h, text: item.str };
      }
    }
    if (cur) lines.push(cur);

    // 줄들을 문단 덩어리로 묶는다 (세로 간격이 좁고 같은 기둥(칼럼)이면 같은 덩어리)
    const rawBlocks = [];
    let blk = null;
    for (const ln of lines) {
      const gap = blk ? blk.lastY - ln.y : 0;
      const sameCol = blk ? !(ln.x0 > blk.x1 + 15 || ln.x1 < blk.x0 - 15) : false;
      if (blk && gap > 0 && gap < Math.max(blk.avgH, ln.h) * 1.7 && sameCol) {
        // 줄 끝 하이픈으로 나뉜 단어는 붙인다
        if (blk.text.endsWith('-')) blk.text = blk.text.slice(0, -1) + ln.text.trimStart();
        else blk.text += ' ' + ln.text;
        blk.x0 = Math.min(blk.x0, ln.x0);
        blk.x1 = Math.max(blk.x1, ln.x1);
        blk.lastY = ln.y;
        blk.lastH = ln.h;
        blk.n++;
        blk.avgH = (blk.avgH * (blk.n - 1) + ln.h) / blk.n;
      } else {
        if (blk) rawBlocks.push(blk);
        blk = {
          text: ln.text,
          x0: ln.x0,
          x1: ln.x1,
          firstY: ln.y,
          firstH: ln.h,
          lastY: ln.y,
          lastH: ln.h,
          avgH: ln.h,
          n: 1,
        };
      }
    }
    if (blk) rawBlocks.push(blk);

    // 화면 비율(0~1) 좌표로 바꾼다
    const blocks = rawBlocks
      .map((b) => {
        const topPdf = b.firstY + b.firstH * 0.85;
        const botPdf = b.lastY - b.lastH * 0.3;
        return {
          x: b.x0 / pageW,
          y: (pageH - topPdf) / pageH,
          w: (b.x1 - b.x0) / pageW,
          h: (topPdf - botPdf) / pageH,
          fs: b.avgH / pageW, // 글자 크기 (쪽 너비 대비 비율)
          en: b.text.replace(/\s+/g, ' ').trim(),
          ko: null,
        };
      })
      .filter((b) => b.en.length > 0 && b.w > 0.005);

    pages.push({ page: p, image, blocks });
  }
  return pages;
}

// 영어 단어가 들어 있어 번역할 가치가 있는 조각인지
function needsTranslation(text) {
  return /[A-Za-z]{2}/.test(text);
}

// ---------- PDF로 내려받기: 각 쪽 사진 위에 번역을 그려서 PDF로 묶는다 ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// 캔버스에서 글을 상자 너비에 맞게 줄바꿈한다
function wrapText(ctx, text, maxW) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const test = cur ? cur + ' ' + word : word;
    if (ctx.measureText(test).width <= maxW) {
      cur = test;
      continue;
    }
    if (cur) {
      lines.push(cur);
      cur = '';
    }
    // 단어 하나가 한 줄보다 길면 글자 단위로 자른다
    let piece = '';
    for (const ch of word) {
      if (piece && ctx.measureText(piece + ch).width > maxW) {
        lines.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    cur = piece;
  }
  if (cur) lines.push(cur);
  return lines;
}

// 화면과 같은 모양(원본 사진 + 글자 자리에 한국어)으로 한 쪽을 그린다
async function renderTranslatedPage(pg) {
  const img = await loadImage(pg.image);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const W = canvas.width;
  const H = canvas.height;
  for (const b of pg.blocks) {
    if (!b.ko) continue;
    const x = b.x * W;
    const y = b.y * H;
    const w = b.w * W;
    const minH = b.h * H;
    const fs = Math.max(10, b.fs * W * 0.8);
    const lineH = fs * 1.32;
    ctx.font = `${fs}px 'Malgun Gothic', sans-serif`;
    const lines = wrapText(ctx, b.ko, w);
    const boxH = Math.max(minH, lines.length * lineH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 1, y, w + 2, boxH);
    ctx.fillStyle = '#14181f';
    ctx.textBaseline = 'top';
    lines.forEach((ln, i) => {
      ctx.fillText(ln, x, y + i * lineH + (lineH - fs) / 2);
    });
  }
  return canvas;
}

async function translateBlockBatch(items, token) {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blocks: items, token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '번역 요청이 실패했습니다.');
  return data.translations || {};
}

export default function Home() {
  const [papers, setPapers] = useState([]);
  const [current, setCurrent] = useState(null); // 보고 있는 논문
  const [working, setWorking] = useState(null); // {stage, done, total}
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [fontSize, setFontSize] = useState(15.5);
  const [showEn, setShowEn] = useState(false);
  const [hideOverlay, setHideOverlay] = useState(false); // 오른쪽 번역 덮개 잠깐 끄기
  const [saving, setSaving] = useState(null); // PDF 저장 진행 {done, total}
  const [pending, setPending] = useState(null); // 번역 대기 중인 논문 {title, pages}
  const [code, setCode] = useState(''); // 이용권 코드 입력값
  const [codeInfo, setCodeInfo] = useState(null); // {checking} | {remaining} | {error}
  const fileRef = useRef(null);

  useEffect(() => {
    loadAllPapers().then(setPapers);
  }, []);

  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('PDF 파일만 올릴 수 있어요.');
      return;
    }
    setError('');

    try {
      // 1) PDF에서 쪽 사진 + 글 조각 추출
      setWorking({ stage: 'PDF를 읽고 있어요…', done: 0, total: 1 });
      const pages = await extractPdfPages(file, (p, total) =>
        setWorking({ stage: 'PDF를 읽고 있어요…', done: p, total })
      );
      const totalChars = pages.reduce(
        (n, pg) => n + pg.blocks.reduce((m, b) => m + b.en.length, 0),
        0
      );
      if (totalChars < 50) {
        throw new Error(
          '이 PDF에서 글자를 찾지 못했어요. 스캔한 이미지 PDF일 수 있어요. (글자를 마우스로 선택할 수 있는 PDF만 가능합니다)'
        );
      }

      // 2) 바로 번역하지 않고, 장수와 비용을 먼저 안내한다
      setCode('');
      setCodeInfo(null);
      setPending({ title: file.name.replace(/\.pdf$/i, ''), pages });
    } catch (e) {
      setError(e.message || '작업 중 오류가 났습니다.');
    } finally {
      setWorking(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // 이용권 코드의 남은 장수를 확인한다
  async function checkCode() {
    const trimmed = code.trim();
    if (!trimmed) {
      setCodeInfo({ error: '코드를 입력해 주세요.' });
      return;
    }
    setCodeInfo({ checking: true });
    try {
      const res = await fetch('/api/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) setCodeInfo({ error: data.error || '코드를 확인하지 못했습니다.' });
      else setCodeInfo({ remaining: data.remaining });
    } catch {
      setCodeInfo({ error: '확인 중 오류가 났습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  // 장수를 차감하고 번역을 시작한다
  async function startTranslation() {
    if (!pending || working) return;
    const pages = pending.pages;
    const n = pages.length;
    setError('');
    try {
      // 1) 이용권에서 장수 차감 + 번역 통행증 받기
      setWorking({ stage: '이용권을 확인하고 있어요…', done: 0, total: 1 });
      const res = await fetch('/api/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), pages: n }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '이용권 확인에 실패했습니다.');
      const token = data.token;

      // 2) 조각들을 적당한 크기의 묶음으로 나눠 AI 번역
      const jobs = []; // {refs: [블록 참조], items: [{id, text}]}
      let curJob = { refs: [], items: [], chars: 0 };
      let nextId = 1;
      for (const pg of pages) {
        for (const b of pg.blocks) {
          if (!needsTranslation(b.en)) continue;
          if (curJob.chars + b.en.length > 3200 && curJob.items.length > 0) {
            jobs.push(curJob);
            curJob = { refs: [], items: [], chars: 0 };
          }
          const id = String(nextId++);
          curJob.refs.push(b);
          curJob.items.push({ id, text: b.en });
          curJob.chars += b.en.length;
        }
      }
      if (curJob.items.length > 0) jobs.push(curJob);

      let failed = 0;
      for (let i = 0; i < jobs.length; i++) {
        setWorking({ stage: 'AI가 번역하고 있어요…', done: i, total: jobs.length });
        let translations = null;
        try {
          translations = await translateBlockBatch(jobs[i].items, token);
        } catch (e1) {
          try {
            translations = await translateBlockBatch(jobs[i].items, token); // 한 번 더 시도
          } catch (e2) {
            failed++;
          }
        }
        if (translations) {
          jobs[i].items.forEach((item, k) => {
            const ko = translations[item.id];
            // 번역이 원문과 사실상 같으면(참고문헌 등) 덮지 않고 원본을 그대로 보여준다
            if (ko && ko.replace(/\s+/g, '') !== item.text.replace(/\s+/g, '')) {
              jobs[i].refs[k].ko = ko;
            }
          });
        }
      }

      // 3) 저장 (이 컴퓨터의 브라우저 안에만 저장됩니다)
      const paper = {
        id: Date.now().toString(36),
        title: pending.title,
        createdAt: new Date().toISOString(),
        overlay: true,
        pages,
      };
      try {
        await dbPut(paper);
      } catch {
        setError('저장 공간이 부족해서 목록에는 저장하지 못했어요. 화면으로는 볼 수 있습니다.');
      }
      setPapers(await loadAllPapers());
      setPending(null);
      setCurrent(paper);
      if (failed > 0) {
        setError(
          `일부 묶음(${failed}곳) 번역에 실패했어요. 해당 부분은 원본 그대로 보입니다. 궁금한 점은 관리자에게 문의해 주세요.`
        );
      }
    } catch (e) {
      setError(e.message || '작업 중 오류가 났습니다.');
    } finally {
      setWorking(null);
    }
  }

  async function downloadPdf() {
    if (!current || !Array.isArray(current.pages) || saving) return;
    const pages = current.pages;
    setError('');
    setSaving({ done: 0, total: pages.length });
    try {
      const { jsPDF } = await import('jspdf');
      let pdf = null;
      for (let i = 0; i < pages.length; i++) {
        setSaving({ done: i, total: pages.length });
        // 화면이 멈추지 않게 한 쪽 그릴 때마다 잠깐 쉬어준다
        await new Promise((r) => setTimeout(r, 0));
        const canvas = await renderTranslatedPage(pages[i]);
        const wMM = 210;
        const hMM = Math.round((canvas.height / canvas.width) * wMM * 100) / 100;
        const orientation = hMM >= wMM ? 'portrait' : 'landscape';
        if (!pdf) {
          pdf = new jsPDF({ unit: 'mm', format: [wMM, hMM], orientation });
        } else {
          pdf.addPage([wMM, hMM], orientation);
        }
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, wMM, hMM);
      }
      pdf.save(`${current.title} (한국어 번역).pdf`);
    } catch (e) {
      setError('PDF 저장 중 오류가 났어요: ' + (e.message || e));
    } finally {
      setSaving(null);
    }
  }

  async function updateTitle(paper, title) {
    const updated = { ...paper, title };
    if (paper.legacy) {
      saveLegacy(loadLegacy().map((p) => (p.id === paper.id ? { ...p, title } : p)));
    } else {
      const { legacy, ...toSave } = updated;
      await dbPut(toSave).catch(() => {});
    }
    setPapers(await loadAllPapers());
    if (current && current.id === paper.id) setCurrent(updated);
  }

  async function deletePaper(paper) {
    if (!confirm('이 논문 번역을 목록에서 지울까요? (되돌릴 수 없어요)')) return;
    if (paper.legacy) {
      saveLegacy(loadLegacy().filter((p) => p.id !== paper.id));
    } else {
      await dbDelete(paper.id).catch(() => {});
    }
    setPapers(await loadAllPapers());
    if (current && current.id === paper.id) setCurrent(null);
  }

  // ---------- 화면 ----------

  if (working) {
    const pct = working.total ? Math.round((working.done / working.total) * 100) : 0;
    return (
      <div className="wrap">
        <Header />
        <div className="progress-card">
          <div className="stage">{working.stage}</div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: pct + '%' }} />
          </div>
          <div className="detail">
            {working.done} / {working.total} ({pct}%)
          </div>
          <div className="progress-note">
            논문 길이에 따라 몇 분 걸릴 수 있어요. 이 창을 닫지 말고 기다려주세요.
          </div>
        </div>
      </div>
    );
  }

  if (pending) {
    const n = pending.pages.length;
    const cost = n * PRICE_PER_PAGE;
    const canStart = codeInfo && codeInfo.remaining >= n;
    const notEnough = codeInfo && typeof codeInfo.remaining === 'number' && codeInfo.remaining < n;
    return (
      <div className="wrap">
        <Header />
        {error && <div className="error-box">{error}</div>}
        <div className="pay-card">
          <div className="pay-title">📄 {pending.title}</div>
          <div className="pay-summary">
            이 논문은 <b>{n}장</b>입니다. 번역 비용은{' '}
            <b className="pay-cost">{cost.toLocaleString('ko-KR')}원</b>입니다.
            <span className="pay-unit"> (1장당 {PRICE_PER_PAGE}원)</span>
          </div>

          <div className="pay-steps">
            <div className="pay-step">
              <span className="pay-step-num">1</span>
              <div>
                아래 계좌로 <b>{cost.toLocaleString('ko-KR')}원</b>을 입금해 주세요.
                <div className="pay-bank">{BANK_INFO}</div>
              </div>
            </div>
            <div className="pay-step">
              <span className="pay-step-num">2</span>
              <div>
                입금 후 카카오톡으로 알려 주시면 <b>이용권 코드</b>를 보내드립니다.
                <div>
                  <a className="kakao-btn" href={KAKAO_LINK} target="_blank" rel="noreferrer">
                    💬 카카오톡으로 입금 알리기
                  </a>
                </div>
                <div className="pay-alt">카카오톡이 어려우면 {CONTACT_PHONE}</div>
              </div>
            </div>
            <div className="pay-step">
              <span className="pay-step-num">3</span>
              <div>받은 코드를 아래에 입력하고 번역을 시작하세요.</div>
            </div>
          </div>

          <div className="code-row">
            <input
              className="code-input"
              placeholder="이용권 코드 입력"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeInfo(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && checkCode()}
            />
            <button
              className="btn-ghost"
              onClick={checkCode}
              disabled={codeInfo && codeInfo.checking}
            >
              {codeInfo && codeInfo.checking ? '확인 중…' : '코드 확인'}
            </button>
          </div>
          {codeInfo && codeInfo.error && <div className="code-msg bad">{codeInfo.error}</div>}
          {codeInfo && typeof codeInfo.remaining === 'number' && (
            <div className={'code-msg ' + (canStart ? 'good' : 'bad')}>
              {canStart
                ? `확인되었습니다. (남은 장수: ${codeInfo.remaining}장)`
                : `남은 장수가 부족합니다. (남은 장수: ${codeInfo.remaining}장, 필요: ${n}장)`}
            </div>
          )}
          {notEnough && (
            <div className="code-msg">
              추가 이용이 필요하면{' '}
              <a href={KAKAO_LINK} target="_blank" rel="noreferrer">
                카카오톡 상담
              </a>
              으로 문의해 주세요.
            </div>
          )}

          <div className="pay-actions">
            <button className="btn-primary" onClick={startTranslation} disabled={!canStart}>
              {n}장 번역 시작하기
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                setPending(null);
                setError('');
              }}
            >
              취소
            </button>
          </div>
          <div className="pay-note">
            번역을 시작하면 이용권에서 {n}장이 차감됩니다. 번역이 끝나면 결과가 이 화면의 목록에
            저장되고, PDF 파일로도 내려받을 수 있어요.
          </div>
        </div>
      </div>
    );
  }

  if (current) {
    const isOverlay = current.overlay && Array.isArray(current.pages);
    const isParas = !current.overlay && Array.isArray(current.pages);
    return (
      <div className="wrap wrap-wide" style={{ '--reading-size': fontSize + 'px' }}>
        <div className="viewer-head">
          <button className="btn-ghost" onClick={() => setCurrent(null)}>
            ← 목록으로
          </button>
          <input
            className="title-edit"
            value={current.title}
            onChange={(e) => updateTitle(current, e.target.value)}
            title="제목을 눌러서 바꿀 수 있어요"
          />
          {isOverlay && (
            <button
              className={'btn-ghost' + (hideOverlay ? ' active' : '')}
              onClick={() => setHideOverlay((v) => !v)}
              title="누르고 있는 동안이 아니라, 누를 때마다 켜졌다 꺼졌다 합니다"
            >
              {hideOverlay ? '번역 다시 보기' : '번역 잠깐 끄기'}
            </button>
          )}
          {isOverlay && (
            <button
              className="btn-ghost"
              onClick={downloadPdf}
              disabled={!!saving}
              title="번역된 페이지들을 PDF 파일로 저장해요"
            >
              {saving ? `PDF 만드는 중… ${saving.done + 1}/${saving.total}` : '📥 PDF로 내려받기'}
            </button>
          )}
          {isParas && (
            <button
              className={'btn-ghost' + (showEn ? ' active' : '')}
              onClick={() => setShowEn((v) => !v)}
            >
              {showEn ? '영어 문장 숨기기' : '영어 문장도 보기'}
            </button>
          )}
          {!isOverlay && (
            <div className="font-controls">
              <button onClick={() => setFontSize((s) => Math.max(12, s - 1))} title="글자 작게">
                가−
              </button>
              <button onClick={() => setFontSize((s) => Math.min(24, s + 1))} title="글자 크게">
                가＋
              </button>
            </div>
          )}
          <button className="btn-danger" onClick={() => deletePaper(current)}>
            삭제
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}

        {isOverlay ? (
          // 새 방식: 왼쪽 = 원본, 오른쪽 = 원본 모양 그대로 + 글자 자리에 한국어
          <div>
            <div className="col-labels">
              <div>원본 (PDF 그대로)</div>
              <div>한국어 번역 (마우스를 올리면 영어 원문이 떠요)</div>
            </div>
            <div className="page-sections">
              {current.pages.map((pg) => (
                <div className="page-section" key={pg.page}>
                  <div className="page-label">📄 {pg.page}쪽</div>
                  <div className="page-grid">
                    <div className="page-img">
                      <img src={pg.image} alt={pg.page + '쪽 원본'} />
                    </div>
                    <div className="page-img">
                      <div className="overlay-wrap">
                        <img src={pg.image} alt={pg.page + '쪽 번역'} />
                        {!hideOverlay &&
                          pg.blocks
                            .filter((b) => b.ko)
                            .map((b, i) => (
                              <div
                                key={i}
                                className="tblock"
                                title={b.en}
                                style={{
                                  left: b.x * 100 + '%',
                                  top: b.y * 100 + '%',
                                  width: b.w * 100 + '%',
                                  minHeight: b.h * 100 + '%',
                                  fontSize: Math.max(1.05, b.fs * 100 * 0.8) + 'cqw',
                                }}
                              >
                                {b.ko}
                              </div>
                            ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : isParas ? (
          // 중간 버전: 왼쪽 = 원본 쪽 사진, 오른쪽 = 번역 문단 목록
          <div>
            <div className="col-labels">
              <div>원본 (PDF 그대로)</div>
              <div>한국어 번역</div>
            </div>
            <div className="page-sections">
              {current.pages.map((pg) => (
                <div className="page-section" key={pg.page}>
                  <div className="page-label">📄 {pg.page}쪽</div>
                  <div className="page-grid">
                    <div className="page-img">
                      <img src={pg.image} alt={pg.page + '쪽 원본'} />
                    </div>
                    <div className="page-paras">
                      {(pg.paras || []).length === 0 ? (
                        <div className="para-empty">(이 쪽에는 번역할 글자가 없어요)</div>
                      ) : (
                        pg.paras.map((para, i) => (
                          <div key={i} className={'para' + (para.heading ? ' heading' : '')}>
                            <div className="ko">{para.ko}</div>
                            {showEn && para.en && <div className="en-sub">{para.en}</div>}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          // 예전 방식(글자만 저장된 자료): 영어/한국어 나란히
          <div>
            <div className="col-labels">
              <div>영어 원문</div>
              <div>한국어 번역</div>
            </div>
            <div className="pair-table">
              {current.pairs.map((pair, i) => {
                const prevPage = i > 0 ? current.pairs[i - 1].page : null;
                const showDivider = pair.page && pair.page !== prevPage;
                return (
                  <div key={i}>
                    {showDivider && <div className="page-divider">📄 원본 {pair.page}쪽</div>}
                    <div className={'pair-row' + (pair.heading ? ' heading' : '')}>
                      <div className="en">{pair.en}</div>
                      <div className="ko">{pair.ko}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wrap">
      <Header />
      {error && <div className="error-box">{error}</div>}
      <div
        className={'upload-card' + (dragging ? ' dragging' : '')}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer.files[0]);
        }}
      >
        <div className="big">영어 논문 PDF를 여기에 끌어다 놓으세요</div>
        <div className="hint">
          또는 아래 버튼을 눌러 파일을 고르세요 · 올리면 장수와 비용을 먼저 알려드려요
        </div>
        <button className="btn-primary" onClick={() => fileRef.current?.click()}>
          PDF 파일 고르기
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files[0])}
        />
      </div>

      <div className="price-note">
        💡 <b>이용 안내</b> — 번역 비용은 <b>1장당 {PRICE_PER_PAGE}원</b>입니다. PDF를 올리면
        장수와 금액을 먼저 보여드리고, 입금 확인 후 받은 <b>이용권 코드</b>를 입력하면 번역이
        시작됩니다. 번역 결과는 지금 쓰고 있는 이 컴퓨터(브라우저)에만 저장됩니다.
      </div>

      <div className="section-title">저장된 논문</div>
      {papers.length === 0 ? (
        <div className="empty-note">
          아직 번역한 논문이 없어요. 위에서 PDF를 올리면 여기에 차곡차곡 쌓입니다.
        </div>
      ) : (
        <div className="paper-list">
          {papers.map((p) => (
            <div
              className="paper-item"
              key={p.id}
              onClick={() => {
                setError('');
                setCurrent(p);
              }}
            >
              <div>
                <div className="title">{p.title}</div>
                <div className="meta">
                  {new Date(p.createdAt).toLocaleDateString('ko-KR')} ·{' '}
                  {Array.isArray(p.pages)
                    ? `${p.pages.length}쪽`
                    : `문단 ${p.pairs.length}개 (예전 방식)`}
                </div>
              </div>
              <button
                className="btn-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  deletePaper(p);
                }}
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="topbar">
      <div>
        <h1>
          논문 <span>번역 비교</span>
        </h1>
        <div className="subtitle">영어 논문 PDF를 올리면 원본과 한국어 번역을 나란히 보여드려요</div>
      </div>
    </div>
  );
}
