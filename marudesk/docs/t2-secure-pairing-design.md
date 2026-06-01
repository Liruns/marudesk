# T2 — Secure pairing + end-to-end encryption (direct LAN/Tailscale bridge)

> 작성: 2026-06-01. 사용자 지시(요약): T2 이어가기 — ① Settings 후보 URL + 공용 Wi-Fi 경고
> (done, `050be80`) → ② **E2E 암호화** → ③ **QR + 승인 페어링** → ④ 모바일 클라 연결 +
> Tailscale dogfood. 보안 방식 결정(2026-06-01): **앱-레벨 E2E (X25519 + AES-256-GCM,
> WebCrypto + node:crypto, 새 의존성 0)**.

이 문서는 직결(direct) 경로 — 폰이 cloud relay를 거치지 않고 LAN/Tailscale로 PC에 **직접**
붙는 경로 — 의 보안을 다룬다. Model B(cloud relay)와 독립적이며, M4 SSE+REST 라우터
(`electron/server/router.ts`) 위에 **암호화 봉투(envelope)** 한 겹과 **물리 페어링** 한 겹을
얹는다. 두 경로는 전송(SSE+REST)·agent 중계 계층을 공유한다.

---

## 0. 위협 모델 & 결정

- **신뢰**: PC 화면(QR 표시)과 사람(폰을 들고 PC 앞에 있음)은 신뢰. → QR이 **대역외(OOB)
  인증 채널**. 네트워크(LAN/Tailscale 중간자)는 **불신**.
- **막아야 할 것**: 같은 LAN의 도청/변조, 토큰 탈취 시 영구 접근, QR 스크린샷 후 재사용,
  미승인 기기 접속.
- **핵심 결정**:
  | # | 결정 | 선택 | 근거 |
  |---|---|---|---|
  | E1 | 키 교환 | **X25519 ECDH**, QR은 PC **공개키**만 운반 | 공유 비밀은 전송되지 않음 → QR 스샷도 키를 안 줌. WebCrypto/node:crypto 기본 지원(새 의존성 0). |
  | E2 | 대칭 암호 | **AES-256-GCM**, 12B 랜덤 nonce/메시지, 128b tag | 양측 WebCrypto 보편 지원. 랜덤 nonce는 ~2³² msg/키까지 안전(개인용 충분). |
  | E3 | 키 유도 | **HKDF-SHA256**(salt = pairing code, info = `marudesk-e2e-v1`) | code가 salt → 같은 기기라도 페어링마다 키 분리. |
  | E4 | 기기 인증 | **키 소유 = 인증**. 평문 bearer 대신 봉투를 열 수 있으면 인증됨. `deviceId`(비밀 아님)는 키 조회용. | 정적 공유 토큰 탈취 위험 제거. 기기별 폐기 가능. |
  | E5 | 페어링 승인 | `/pair`는 1회용 code로 보호 + **데스크톱 승인 카드** 필수 | "PC 앞 사람만" 강제. relay 백엔드 0. |
  | E6 | 호환 | E2E는 **추가 인증 경로**. 기존 `Authorization: Bearer <serverToken>`(loopback 동반앱/테스트)는 유지 | M4 표면·하니스 무파괴. |

---

## 1. 암호 핵심 (`shared/e2e.ts`) — 양측 공용, `globalThis.crypto.subtle`만 사용

PC(node 22+, webcrypto)와 모바일(Chromium WebView)에서 **동일 코드**가 돈다. node:crypto
직접 호출 없이 표준 SubtleCrypto만 써서 한 모듈로 양측을 커버한다(검증: node v22 X25519+
HKDF+AES-GCM round-trip OK).

```
generateKeyPair()                         → { publicKeyRaw:32B, privateKey:CryptoKey }  (X25519)
deriveSessionKey(privKey, peerPubRaw, code) → AES-GCM CryptoKey   (ECDH → HKDF(salt=code))
seal(key, obj, aad)                       → { n, ct }            (JSON → AES-GCM)
open(key, env, aad)                       → obj                  (throws on auth/tamper fail)
makePairProof(key, code) / verifyPairProof(key, code, proof)     (폰이 그 QR을 스캔했음을 증명)
```

**봉투(Envelope)** `{ n: b64url(12B nonce), ct: b64url(ciphertext‖tag) }`. AAD로 맥락 고정:
- pair proof: `pair-confirm:<code>`  · 요청 본문: `req:<METHOD> <path>`  · 응답: `res:<path>`
  · SSE 프레임: `sse`.  AAD 불일치는 복호 실패 → 봉투 재사용/엔드포인트 횡단 차단.

## 2. 페어링 핸드셰이크 (③)

```
PC Settings "기기 추가" ──┐
  pcKeys = X25519();  code = rand8;  exp = now+90s
  QR = b64({ v:1, code, pcPub:b64url(pcKeys.pub), urls:[candidates], name:<PC>, exp })
        │ (PC 화면에 표시 — 신뢰 OOB)
폰: QR 스캔 ─────────────┘
  phKeys = X25519();  key = deriveSessionKey(phKeys.priv, pcPub, code)
  proof  = makePairProof(key, code)
  POST /pair  { code, phPub:b64url, deviceName, proof, nonce }   (평문, code-gated, rate-limit)
PC /pair:
  세션(code) 조회 → key = deriveSessionKey(pcKeys.priv, phPub, code) → verifyPairProof
  OK → renderer 'server:pairing-request' 이벤트 → **승인 카드**(기기명 + phPub 지문)
  승인 → deviceId = rand;  store.put({ deviceId, name, phPub, key, createdAt })  (safeStorage)
        응답 = seal(key, { deviceId }, 'res:/pair')          (이미 E2E)
  거절/만료 → 403.  세션은 1회 소비.
폰: { deviceId, key, baseUrl } 보안 저장 → 이후 모든 호출에 봉투 사용.
```

## 3. 암호화된 채널 (②, 라우터 통합은 ③)

기존 M4 라우트(`/agent/*`, `/health`)에 **봉투 인증 경로** 추가:
- 요청 헤더 `X-Marudesk-Device: <deviceId>`(공개) → PC가 키 조회. 본문 = `seal(key, body, 'req:M path')`.
- 응답 본문 = `seal(key, result, 'res:path')`. 401/403/413 등 에러도 가능하면 봉투로.
- **SSE**: 각 `data:` = `seal(key, RemoteEvent, 'sse')`의 `{n,ct}` JSON. 폰이 프레임마다 open.
- bearer 경로와 상호 배타: `Authorization` 있으면 기존 검사, `X-Marudesk-Device` 있으면 봉투 검사.
- 모바일 WebView는 헤더 없는 `EventSource` 불가 → **fetch-stream으로 SSE 수신**(헤더 가능).

## 4. PC UI (Settings → Remote)

- 서버 ON일 때(①에 이어): **"기기 추가"** 버튼 → QR 카드(코드/만료 카운트다운/수동 코드 fallback).
- 페어링 시도 시 **승인 카드**(기기명 + 지문, 승인/거절).
- **페어링된 기기 목록**: 이름·마지막 접속·**폐기(revoke)**.
- 새 IPC: `server:pairing-start`(QR payload 반환) · `server:pairing-approve`/`reject` ·
  `server:list-devices` · `server:revoke-device` · 이벤트 `server:pairing-request`.

## 5. 모바일 (④)

- `mobile/src/transport/DirectTransport.ts`: 봉투 클라이언트. `connect(baseUrl, {deviceId,key})`,
  REST = fetch+seal/open, SSE = fetch-stream+프레임 open. 기존 `Transport` 인터페이스 구현 →
  화면 무수정. `transport/index.ts`에 direct 선택지 추가.
- `ConnectScreen`: QR 스캔(Capacitor barcode) → QR payload 파싱 → 페어링 핸드셰이크 →
  성공 시 direct 모드로 Chat. 수동 URL+코드 fallback 유지.
- WebCrypto X25519 capability 체크 → 미지원 WebView는 명확한 에러(최소 Chromium 버전 안내).
- **Tailscale dogfood 체크리스트**(§7).

## 6. 마이그레이션 맵

**추가**: `shared/e2e.ts`, `electron/server/e2e-session.ts`(DeviceKeyStore + 봉투 미들웨어),
`electron/server/pairing.ts`(세션·승인·`/pair`), `electron/server/e2e-harness.ts`,
`mobile/src/transport/DirectTransport.ts`, PC Settings 페어링/기기 UI.
**수정**: `electron/server/router.ts`(봉투 인증 경로), `electron/server/index.ts`(devices 노출),
`shared/ipc.ts`(`server:pairing-*`/`*-device(s)` 채널), `electron/secrets.ts`(기기 레코드 저장),
`mobile/src/transport/index.ts`·`ConnectScreen.tsx`.

## 7. 단계 & 검증

| 단계 | 내용 | 검증 | 상태 |
|---|---|---|---|
| ② | `shared/e2e.ts` 크립토 핵심 + 봉투 + 핸드셰이크 헬퍼 + 헤드리스 하니스(전체 핸드셰이크·봉투 왕복·변조/AAD-불일치 거부) | `harness:e2e`, tsc/lint 0 | ⬜ |
| ③ | `/pair` + DeviceKeyStore(safeStorage) + 승인 IPC/UI + 기기목록/폐기 + 라우터 봉투 통합 | harness:server 확장, e2e, build | ⬜ |
| ④ | 모바일 DirectTransport + QR 스캔 + 결선 + Tailscale dogfood | mobile tsc/build, 실기기 | ⬜ |

## 8. 보안 체크리스트 (직결 노출 시)
- [ ] `/pair` 외 모든 직결 라우트는 봉투 인증(키 소유) 또는 기존 bearer 필수.
- [ ] pairing code: 고엔트로피·90s 만료·1회 소비·rate-limit·승인 없이는 토큰 미발급.
- [ ] 기기 레코드(키 포함)는 safeStorage만. 키는 렌더러/네트워크로 평문 유출 금지.
- [ ] AAD로 봉투 맥락 고정(엔드포인트 횡단·proof 재사용 차단). 변조 = 복호 실패.
- [ ] 기기 폐기 즉시 효력(키 삭제 → 이후 봉투 복호 불가).
- [ ] L-1(원격 self-approval): 서버 ON 시 gated 도구 승인은 데스크톱 UI 고정 — §M5 정책 유지.
- [ ] nonce는 메시지마다 랜덤 12B. (재전송 방지는 v1 비목표 — 채널은 기밀·인증됨, 명시.)
- [ ] X25519 WebCrypto 미지원 WebView는 graceful 실패 + 안내(평문 폴백 금지).

## 9. Non-goals (v1)
- 재전송(replay) 완전 차단(모노토닉 카운터) — 후속.
- Perfect forward secrecy 세션 로테이션 — 페어링당 키 분리까지(연결당 로테이션은 후속).
- 다중 소유자/팀. iOS 빌드 서명 파이프라인.
