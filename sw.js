/* AI & Digital Healthcare Watch — service worker
 *
 * 갱신이 잦은 사이트라 "옛날 내용이 보이는 사고"를 막는 것이 이 파일의 최우선 목표다.
 *   - HTML(페이지 이동): 네트워크 우선. 새 리뷰·새 호가 즉시 보인다. 오프라인일 때만 캐시.
 *   - 이미지·아이콘 등 정적 자산: 캐시 우선 + 뒤에서 조용히 갱신(stale-while-revalidate).
 * 내용을 바꿔 배포할 때는 CACHE 버전을 올릴 것.
 *
 * 아이콘을 교체할 때는 CACHE 버전만으로 부족하다. 브라우저의 파비콘 캐시는
 * URL 단위로 매우 오래 남기 때문에, 파일 내용만 바꾸고 경로를 그대로 두면
 * 옛 아이콘이 계속 보인다. HTML·manifest의 ?v= 값과 아래 ICON_V를 함께 올릴 것.
 */

var CACHE = "kdh-v11";
var ICON_V = "?v=2";
// 앱 이름(short_name)만 바뀌어도 manifest는 새로 받아야 하므로 아이콘과 따로 관리한다.
var MANIFEST_V = "?v=3";
// CSS는 파일명이 고정이라 GitHub Pages의 max-age=600에 걸려 최대 10분간 옛 파일이
// 나온다(서비스워커가 네트워크 우선이어도 그 아래 HTTP 캐시가 먼저 답한다).
// 디자인을 고칠 때마다 이 번호와 각 HTML의 ?v= 를 함께 올릴 것.
var CSS_V = "?v=2";

// 오프라인 최소 동작에 필요한 것만. HTML은 방문하면서 자연히 쌓인다.
var PRECACHE = [
  "/",
  "/papers/",
  "/products/",
  "/archive/",
  "/about/",
  "/install/",
  "/assets/site.css" + CSS_V,
  "/favicon.ico" + ICON_V,
  "/icon-32.png" + ICON_V,
  "/icon-192.png" + ICON_V,
  "/icon-512.png" + ICON_V,
  "/icon-maskable-192.png" + ICON_V,
  "/icon-maskable-512.png" + ICON_V,
  "/apple-touch-icon.png" + ICON_V,
  "/manifest.json" + MANIFEST_V
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 하나라도 실패하면 설치 전체가 실패하므로 개별적으로 담는다.
      return Promise.all(
        PRECACHE.map(function (url) {
          return cache.add(new Request(url, { cache: "reload" })).catch(function () {});
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;

  // GET만, 그리고 같은 출처만 다룬다.
  // (Cloudflare 애널리틱스 비콘 같은 외부 요청은 건드리지 않는다.)
  if (req.method !== "GET") return;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // CSS도 HTML과 같이 네트워크 우선으로 다룬다.
  // 파일명이 고정된 공통 스타일시트라 캐시 우선으로 두면 디자인을 고쳐도
  // 기존 방문자에게는 옛 CSS가 계속 나간다(실제로 겪음). 크기가 작아 비용도 적다.
  var isCSS = url.pathname.slice(-4) === ".css";

  // HTML 판별은 세 가지를 모두 본다.
  // mode/accept만 보면 스크립트가 fetch("/papers/")로 페이지를 가져올 때
  // Accept가 */* 라서 정적 자산으로 오인돼 캐시 우선이 걸리고, 내용이 낡는다.
  // 경로까지 함께 보므로 갱신되는 페이지가 캐시에 갇히지 않는다.
  var isHTML =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").indexOf("text/html") !== -1 ||
    url.pathname.charAt(url.pathname.length - 1) === "/" ||
    /\.html?$/i.test(url.pathname);

  if (isHTML || isCSS) {
    // 네트워크 우선 — 최신 내용이 항상 이긴다.
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(req, copy);
          });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            // 해당 페이지가 캐시에 없으면 첫 화면이라도 보여준다.
            return hit || caches.match("/");
          });
        })
    );
    return;
  }

  // 그 외(이미지·아이콘 등): 캐시 우선, 뒤에서 갱신.
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req)
        .then(function (res) {
          if (res && res.status === 200 && res.type === "basic") {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) {
              cache.put(req, copy);
            });
          }
          return res;
        })
        .catch(function () {
          return hit;
        });
      return hit || network;
    })
  );
});

/* ═══ 푸시 알림 ═══════════════════════════════════════════════
 * Worker는 본문 없이 "깨우기"만 보낸다. 문구는 여기서 /push-latest.json을
 * 읽어 만든다. 그래서 알림 문구를 바꿀 때 Worker를 다시 배포할 필요가 없다.
 * iOS는 푸시를 받으면 반드시 알림을 하나 띄워야 하므로(userVisibleOnly),
 * 파일을 못 읽어도 기본 문구로 반드시 표시한다.
 */
self.addEventListener("push", function (event) {
  event.waitUntil(
    (async function () {
      var title = "AI & Digital Healthcare Watch";
      var body = "새 소식이 올라왔습니다.";
      var url = "/";

      try {
        var res = await fetch("/push-latest.json?t=" + Date.now(), { cache: "no-store" });
        if (res.ok) {
          var d = await res.json();
          if (d.title) title = d.title;
          if (d.body) body = d.body;
          if (d.url) url = d.url;
        }
      } catch (e) {
        // 오프라인이거나 파일이 없어도 기본 문구로 알림은 띄운다.
      }

      await self.registration.showNotification(title, {
        body: body,
        icon: "/icon-192.png" + ICON_V,
        badge: "/icon-192.png" + ICON_V,
        tag: "kdh-update",          // 같은 태그는 덮어써서 알림이 쌓이지 않는다
        renotify: true,
        data: { url: url }
      });
    })()
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      // 이미 열려 있는 창이 있으면 그 창을 쓴다.
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          c.navigate(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
