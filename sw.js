/* K-Digital & AI Health Watch — service worker
 *
 * 갱신이 잦은 사이트라 "옛날 내용이 보이는 사고"를 막는 것이 이 파일의 최우선 목표다.
 *   - HTML(페이지 이동): 네트워크 우선. 새 리뷰·새 호가 즉시 보인다. 오프라인일 때만 캐시.
 *   - 이미지·아이콘 등 정적 자산: 캐시 우선 + 뒤에서 조용히 갱신(stale-while-revalidate).
 * 내용을 바꿔 배포할 때는 CACHE 버전을 올릴 것.
 */

var CACHE = "kdh-v2";

// 오프라인 최소 동작에 필요한 것만. HTML은 방문하면서 자연히 쌓인다.
var PRECACHE = [
  "/",
  "/papers/",
  "/archive/",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.json"
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

  // HTML 판별은 세 가지를 모두 본다.
  // mode/accept만 보면 스크립트가 fetch("/papers/")로 페이지를 가져올 때
  // Accept가 */* 라서 정적 자산으로 오인돼 캐시 우선이 걸리고, 내용이 낡는다.
  // 경로까지 함께 보므로 갱신되는 페이지가 캐시에 갇히지 않는다.
  var isHTML =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").indexOf("text/html") !== -1 ||
    url.pathname.charAt(url.pathname.length - 1) === "/" ||
    /\.html?$/i.test(url.pathname);

  if (isHTML) {
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
