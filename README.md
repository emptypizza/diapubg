# DIAPUBG · 산길 너머

혼자 산길 훈련소에서 시작해 공용 쉼터로 나가고, 폐보급소에서 물자를 챙겨 탈출하는 브라우저 PvE 게임입니다. PC에서 `WASD` 또는 방향키로 걷고, 마우스로 조준·사격하고, `E`로 상자와 출입구를 사용합니다. 탈출한 물자는 쉼터 보관함에 저장됩니다. 게스트 기록은 브라우저 쿠키로 이어집니다.

## 로컬 실행

Node 버전은 `.nvmrc`, pnpm 버전은 `package.json`에 고정되어 있습니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

[http://127.0.0.1:8787](http://127.0.0.1:8787)을 엽니다. 온라인 동작을 확인하려면 별도 브라우저 프로필 또는 시크릿 창을 사용합니다. 같은 프로필의 탭은 게스트 한 명을 공유합니다.

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

macOS에 Google Chrome이 설치되어 있으면 브라우저 테스트에서 자동으로 사용합니다. 배포본은 `DIAPUBG_TEST_URL=https://<worker>.workers.dev pnpm test:e2e`로 검증할 수 있습니다.

## 공개 알파 운영

Cloudflare Workers Free 계정과 Wrangler 인증이 준비되면 검증된 `main`에서 `pnpm deploy`를 실행합니다. 정적 화면과 `/api/world` WebSocket은 같은 주소를 사용합니다. 최초 배포에서 SQLite Durable Object가 만들어집니다. 기존 Worker나 Durable Object를 삭제하면 게스트 기록을 잃을 수 있습니다.

전체 동시 8명, 폐보급소 4명입니다. 접속자가 있는 시간을 하루 2시간까지 합산합니다. 남은 5분에는 신규 탐험과 신규 입장을 닫고, 오전 9시(KST)에 한도를 초기화합니다. 월드 이벤트 로그에서 `rejected`, `disconnected`, `extracted` 건수를 확인할 수 있습니다. 긴급 점검 시 Worker 변수 `ONLINE_ENABLED`를 `false`로 설정합니다.

[PPI](https://github.com/emptypizza/ppi/tree/7b6e1a376e80f1dae1d9221effec026edf69e821)의 웹 게임 이력과 Canvas2D 조작을 기반으로 하며, [PPI.io](https://github.com/emptypizza/ppi-io)의 입력 처리와 WebSocket 방식을 참고했습니다.
