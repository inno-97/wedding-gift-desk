# 축의대 (축의금 장부)

결혼식 축의대에서 여러 명이 폰으로 동시에 봉투를 등록하는 웹 앱.
정적 웹(HTML/JS/CSS, 빌드 없음) + Firebase Firestore. 서버 코드 없음.

- 운영: https://wedding-ledger-505b1.web.app
- `public/` — 화면
- `firestore.rules` — 접근 규칙
- `docs/` — 현장 운영 PDF (실명 포함 → 저장소에는 올리지 않음)

## 기능
- 장부(신랑 측 / 신부 측)마다 UUID 링크 → 링크를 아는 사람만 접근
- 봉투번호 자동 증가, 이름(필수)·식권(−/+)·관계(빠른 선택)·메모, 축의금(빠른 금액, ±5만)
- 목록: 검색, 금액 미입력/삭제됨 필터, 금액 입력 시 다음 미입력 봉투로 자동 이동, 합계(눌러서 보기)
- 수정·번호 변경(중복 불가)·소프트 삭제/복구, 동명이인 표시, CSV 내려받기
- 장부 설정: 처음 받은 식권 수(잔여 계산), 기본 식권 수, 기본 금액

## 보안·데이터 원칙
- 장부 목록 조회 불가, 실제 삭제 불가(`deleted` 표시만)
- 봉투번호 = 문서 ID → 같은 번호 동시 등록 시 서버가 하나만 받음 (운영 서버에서 3대 동시 × 20회 검증)
- 서버 연결이 있을 때만 저장, 기기에는 명부를 남기지 않음(메모리 캐시)

## 데이터 구조
```
ledgers/{uuid}                 title, ticketsInitial, defaultTickets, defaultAmount, createdAt, updatedAt
ledgers/{uuid}/entries/{no}    no, name, relation, tickets, amount, memo,
                               deleted, movedTo, createdAt, updatedAt
```

## 로컬 실행 (에뮬레이터, JDK 21 필요)
```sh
PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH firebase emulators:start --project demo-wedding --only firestore,hosting
# → http://127.0.0.1:5050  (localhost에서 열면 자동으로 에뮬레이터 사용)
```
※ 에뮬레이터는 동시 요청의 규칙 평가가 운영과 달라, 동시 등록 테스트는 운영 서버에서 해야 함.

## 배포
```sh
firebase deploy --only firestore:rules,hosting
```

## DB 조회
Firebase 콘솔 → Firestore → `ledgers / {장부ID} / entries`
https://console.firebase.google.com/project/wedding-ledger-505b1/firestore/databases/-default-/data
