import './globals.css';

export const metadata = {
  title: '논문 번역 비교',
  description: '영어 논문 PDF를 올리면 원문과 한국어 번역을 나란히 비교해 보는 개인용 도구',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
