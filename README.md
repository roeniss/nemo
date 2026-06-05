# quick-memo

velog 스타일 좌 editor / 우 markdown 미니 메모장. Cloudflare Worker + D1 단일 워커. 비용 $0.

## 스택
- **배포**: Cloudflare Worker + Static Assets, D1(SQLite), 도메인 `memo.roeni.ss`
- **구현**: Vite + React 19 + TS, Hono API, react-markdown, JWT 쿠키 인증

## 로컬 개발
```bash
npm install

# D1 DB 생성 (최초 1회) → 출력된 database_id를 wrangler.jsonc에 반영
npx wrangler d1 create quick-memo-db

# 스키마 적용 (로컬)
npm run db:local

npm run dev          # http://localhost:5173
```
로컬 인증 정보는 `.dev.vars` (AUTH_USER / AUTH_PASS / JWT_SECRET)에서 수정.

## 배포
```bash
# 운영 시크릿 등록 (최초 1회)
npx wrangler secret put AUTH_USER
npx wrangler secret put AUTH_PASS
npx wrangler secret put JWT_SECRET

# 운영 D1에 스키마 적용 (최초 1회)
npm run db:remote

npm run deploy
```
도메인 `memo.roeni.ss`는 `wrangler.jsonc`의 routes(custom_domain)로 자동 연결 (roeni.ss zone이 같은 CF 계정에 있어야 함).
