/**
 * K-Digital & AI Health Watch — 푸시 알림 Worker
 *
 * 설계 결정: 페이로드 없는(payload-less) 푸시를 보낸다.
 *   웹푸시에서 본문을 실어 보내려면 구독자마다 aes128gcm 암호화가 필요하다.
 *   대신 본문 없이 "깨워만" 주고, 서비스워커가 사이트의 /push-latest.json을
 *   읽어 알림 문구를 만든다. 암호화 코드가 통째로 없어져 깨질 구석이 줄고,
 *   알림 문구를 고치려고 Worker를 다시 배포할 필요도 없다.
 *
 * 엔드포인트
 *   POST /subscribe    {subscription}         구독 저장
 *   POST /unsubscribe  {endpoint}             구독 삭제
 *   POST /send         Bearer SEND_SECRET     전체 발송
 *   GET  /count        Bearer SEND_SECRET     구독자 수
 */

const ALLOW_ORIGINS = ["https://docgpt.ai.kr"];
const SUB_PREFIX = "sub:";

function cors(origin) {
  const allowed = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors(origin))
  });
}

/* ── base64url 도구 ─────────────────────────────────────────── */
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ── VAPID 서명 ─────────────────────────────────────────────
 * 개인키는 d(32바이트)만 시크릿으로 받고, x·y는 공개키(0x04||x||y)에서 뽑아
 * JWK를 다시 조립한다. 시크릿에 담을 값을 최소로 유지하기 위함.
 */
async function importVapidKey(publicKeyB64, privateKeyD) {
  // 시크릿을 붙여넣다 보면 줄바꿈·공백이 섞이기 쉽고, 그러면 키 import가
  // 조용히 실패해 발송이 전부 죽는다. 들어오는 값을 항상 정리한다.
  publicKeyB64 = String(publicKeyB64 || "").trim();
  privateKeyD = String(privateKeyD || "").trim();
  if (!privateKeyD) throw new Error("VAPID_PRIVATE_KEY 시크릿이 비어 있음");

  const pub = b64urlToBytes(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID 공개키 형식 오류");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKeyD,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true
  };
  return crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || "mailto:doctorgpt23@gmail.com"
  };
  const enc = new TextEncoder();
  const signingInput =
    bytesToB64url(enc.encode(JSON.stringify(header))) + "." +
    bytesToB64url(enc.encode(JSON.stringify(payload)));

  const key = await importVapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  // ECDSA/SHA-256 서명은 raw r||s(64바이트)로 나오며 JWS ES256이 요구하는 형식과 같다.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));

  const jwt = signingInput + "." + bytesToB64url(sig);
  return "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY;
}

/* ── 구독 키: endpoint를 SHA-256으로 줄여 KV 키로 쓴다 ────────── */
async function subKey(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return SUB_PREFIX + bytesToB64url(digest).slice(0, 32);
}

/* ── 발송 ────────────────────────────────────────────────── */
async function sendOne(endpoint, env) {
  const res = await fetch(endpoint, {
    method: "POST",
    // 본문 없음. Content-Length는 Fetch 규격상 직접 지정할 수 없는 헤더라
    // 런타임이 알아서 붙이도록 둔다.
    headers: {
      Authorization: await vapidHeader(endpoint, env),
      TTL: "86400",
      Urgency: "normal"
    }
  });
  return res.status;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    /* 구독 등록 */
    if (path === "/subscribe" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "잘못된 JSON" }, 400, origin); }
      const sub = body && body.subscription;
      if (!sub || !sub.endpoint || !/^https:\/\//.test(sub.endpoint)) {
        return json({ error: "구독 정보 없음" }, 400, origin);
      }
      const key = await subKey(sub.endpoint);
      await env.SUBS.put(key, JSON.stringify({
        endpoint: sub.endpoint,
        created: new Date().toISOString()
      }));
      return json({ ok: true }, 201, origin);
    }

    /* 구독 해제 */
    if (path === "/unsubscribe" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "잘못된 JSON" }, 400, origin); }
      if (!body || !body.endpoint) return json({ error: "endpoint 없음" }, 400, origin);
      await env.SUBS.delete(await subKey(body.endpoint));
      return json({ ok: true }, 200, origin);
    }

    /* 아래는 관리자 전용 */
    const auth = request.headers.get("Authorization") || "";
    const authed = env.SEND_SECRET && auth === "Bearer " + env.SEND_SECRET;

    if (path === "/count" && request.method === "GET") {
      if (!authed) return json({ error: "권한 없음" }, 401, origin);
      let count = 0, cursor;
      do {
        const list = await env.SUBS.list({ prefix: SUB_PREFIX, cursor });
        count += list.keys.length;
        cursor = list.list_complete ? null : list.cursor;
      } while (cursor);
      return json({ count }, 200, origin);
    }

    /* 구독 전체 삭제.
     * 구독은 VAPID 공개키에 묶여 있어 키를 교체하면 기존 구독이 전부 무효가 된다.
     * 그런 구독은 404·410이 아니라 403을 돌려주므로 발송 중 자동 정리에 걸리지
     * 않는다. 키 교체 시 이 엔드포인트로 목록을 비운다. */
    if (path === "/purge" && request.method === "POST") {
      if (!authed) return json({ error: "권한 없음" }, 401, origin);
      let deleted = 0, cursor;
      do {
        const list = await env.SUBS.list({ prefix: SUB_PREFIX, cursor });
        for (const k of list.keys) {
          await env.SUBS.delete(k.name);
          deleted++;
        }
        cursor = list.list_complete ? null : list.cursor;
      } while (cursor);
      return json({ deleted }, 200, origin);
    }

    if (path === "/send" && request.method === "POST") {
      if (!authed) return json({ error: "권한 없음" }, 401, origin);

      const result = { sent: 0, removed: 0, failed: 0, statuses: {} };
      let cursor;
      do {
        const list = await env.SUBS.list({ prefix: SUB_PREFIX, cursor });
        for (const k of list.keys) {
          const raw = await env.SUBS.get(k.name);
          if (!raw) continue;
          let rec;
          try { rec = JSON.parse(raw); } catch (e) { continue; }
          let status;
          try {
            status = await sendOne(rec.endpoint, env);
          } catch (e) {
            // 왜 실패했는지 남기지 않으면 statuses가 빈 채로 실패만 세어져
            // 원인을 알 수 없다. 관리자만 보는 응답이므로 사유를 실어 보낸다.
            result.failed++;
            result.errors = result.errors || {};
            const msg = (e && e.message) ? e.message : String(e);
            result.errors[msg] = (result.errors[msg] || 0) + 1;
            continue;
          }
          result.statuses[status] = (result.statuses[status] || 0) + 1;
          if (status === 404 || status === 410) {
            // 구독이 만료·해지됨 — 목록에서 정리한다.
            await env.SUBS.delete(k.name);
            result.removed++;
          } else if (status >= 200 && status < 300) {
            result.sent++;
          } else {
            result.failed++;
          }
        }
        cursor = list.list_complete ? null : list.cursor;
      } while (cursor);

      return json(result, 200, origin);
    }

    return json({ error: "없는 경로" }, 404, origin);
  }
};
