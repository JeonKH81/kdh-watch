# 푸시 알림 Worker 배포

새 브리핑·논문 리뷰가 올라오면 구독자에게 알림을 보내는 Cloudflare Worker.
**교수님이 직접 하셔야 하는 부분만** 정리했습니다. 순서대로 복사해 실행하시면 됩니다.

작업 위치: `kdh-watch/push-worker`

## 0. 준비

Cloudflare 계정이 필요합니다. 사이트에 이미 Cloudflare Web Analytics를 쓰고 있으니
같은 계정으로 로그인하시면 됩니다. 무료 요금제로 충분합니다.

## 1. 로그인

브라우저가 열리고 승인 화면이 뜹니다.

```bash
cd "push-worker 폴더" && npx wrangler login
```

## 2. 구독자 저장소(KV) 만들기

```bash
npx wrangler kv namespace create SUBS
```

출력에 나오는 `id = "..."` 값을 복사해 `wrangler.toml`의
`여기에_KV_네임스페이스_ID를_붙여넣으세요` 자리에 붙여넣으세요.

## 3. 시크릿 두 개 넣기

**VAPID 개인키** — 저장소 밖 `Digital_Health/kdh-push-secrets.txt` 의
`VAPID_PRIVATE_KEY=` 뒤 값을 붙여넣습니다.

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

**발송 비밀번호** — 아무나 알림을 쏘지 못하게 막는 값입니다. 아래로 새로 만드세요.

```bash
openssl rand -base64 32
```

```bash
npx wrangler secret put SEND_SECRET
```

생성한 값은 `kdh-push-secrets.txt`에도 `SEND_SECRET=` 줄로 적어두세요.
주간 스케줄 태스크가 발송할 때 이 값을 씁니다.

## 4. 배포

```bash
npx wrangler deploy
```

끝나면 `https://kdh-push.<계정이름>.workers.dev` 주소가 출력됩니다.
**이 주소를 알려주세요** — 사이트 쪽 코드에 넣어야 구독 버튼이 살아납니다.

## 5. 동작 확인 (구독자 0명 상태)

`<주소>`와 `<SEND_SECRET>`을 바꿔 실행하세요.

```bash
curl -s -H "Authorization: Bearer <SEND_SECRET>" https://kdh-push.<계정이름>.workers.dev/count
```

`{"count":0}` 이 나오면 정상입니다.

---

## 참고: 이 Worker가 하는 일

| 경로 | 용도 | 인증 |
|---|---|---|
| `POST /subscribe` | 알림 켠 사람 저장 | 없음(사이트에서 호출) |
| `POST /unsubscribe` | 알림 끈 사람 삭제 | 없음 |
| `POST /send` | 전체 발송 | `Bearer SEND_SECRET` |
| `GET /count` | 구독자 수 | `Bearer SEND_SECRET` |

발송은 **본문 없이** 보냅니다. 알림 문구는 서비스워커가 사이트의
`/push-latest.json`을 읽어 만들기 때문에, 문구를 바꾸려고 Worker를
다시 배포할 필요가 없습니다.

만료된 구독(404·410)은 발송 시 자동으로 목록에서 지워집니다.

## 비용

무료 한도 안에서 동작합니다 — Worker 요청 10만/일, KV 읽기 10만/일·쓰기 1,000/일.
구독자 등록이 쓰기 1회, 주 1~2회 발송이 구독자 수만큼의 읽기라 한도 근처도 가지 않습니다.
