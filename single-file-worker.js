/**
 * iOS Location Spoofer — stateless picker, single-file Cloudflare Worker (AUTO-GENERATED).
 * DO NOT EDIT BY HAND. Source of truth: worker/src/*. Regenerate:
 *   cd worker && node scripts/build-single.mjs
 * Mirrors the Hono build (src/index.js) exactly: landing + /picker + /api/parse +
 * PWA manifest/icons + self-hosted module scripts & manifests. Stateless.
 */

/* ---- minimal Hono shim (so this single-file mirrors src/index.js one-to-one) ---- */
class Hono {
  constructor() { this._routes = []; this._err = null; }
  get(p, h) { this._routes.push(["GET", p, h]); return this; }
  post(p, h) { this._routes.push(["POST", p, h]); return this; }
  onError(fn) { this._err = fn; }
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = {
      env, executionCtx: ctx,
      req: {
        url: request.url,
        method: request.method,
        query: (k) => url.searchParams.get(k),
        header: (k) => request.headers.get(k),
        json: () => request.json(),
        raw: request,
      },
      _h: {},
      header(k, v) { this._h[k] = v; },
      html(s) { return new Response(s, { headers: { "Content-Type": "text/html;charset=utf-8", ...this._h } }); },
      json(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { "Content-Type": "application/json", ...this._h } }); },
      text(s, status) { return new Response(s, { status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...this._h } }); },
      body(b, status, headers) { return new Response(b, { status: status || 200, headers: { ...this._h, ...(headers || {}) } }); },
    };
    try {
      for (const [m, p, h] of this._routes) { if (m === request.method && url.pathname === p) return await h(c); }
      return new Response("Not found", { status: 404 });
    } catch (e) { if (this._err) return this._err(e, c); throw e; }
  }
}

/* ==== inlined from src/parse.js ==== */

// 坐标解析: 接受地图链接(苹果地图 / 高德 / 百度, 含短链), 抠出经纬度+名称。
// 高德为 GCJ-02; 苹果地图在中国大陆同为 GCJ-02。两者都转 WGS84 再喂给 wloc;
// gcj02ToWgs84 内含 out_of_china 判断, 境外坐标原样返回(无操作)。
//
// 本文件与上游 Yu9191/wloc v1.1 (worker/src/parse.js) 保持同步：inRange 值域校验、
// 高德 position=/lnglat= 经纬度反序、港澳台(苹果/Google 直发 WGS84 不做 GCJ 反算)、
// 百度 BD09MC 正文解析、以及 fetch 的 SSRF/资源上限加固。

function safeDecode(s) {
  if (!s) return "";
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch (e) {
    return String(s);
  }
}

// 从一段字符串里提取经纬度+名称。兼容:
//  苹果地图 coordinate=/ll=/sll=纬度,经度  (名称在 name=...)
//  高德 ?p=POIID,纬度,经度,名称,城市  (逗号或 %2C)
//  高德 ?q=纬度,经度,名称           (新版分享链, 逗号或 %2C)
//  纯文本 纬度,经度
//  高德 URI ?lnglat=/?position=经度,纬度  (与上面几条顺序相反)
// opts.allowBare=false 时不启用"两个裸小数"兜底。扫描页面正文必须关掉它:
// 正文里任何一对小数都会命中(百度页面的 "view_dir":"-0.8477,0.0000" 就是如此),
// 结果是静默返回一个错误坐标 —— 比解析失败危险得多。
function extractFromString(s, opts) {
  const hit = extractRaw(s, opts);
  // 值域是最后一道闸。上面的兜底规则不带语义, 匹配到什么就返回什么, 经纬颠倒
  // (lat=113.9)或纯粹的垃圾数字都能一路走到调用方。这里拦掉的是"解析成了错的",
  // 它比"解析失败"危险得多 —— 后者会提示用户, 前者会把设备定位挪到别处。
  return hit && inRange(hit.lat, hit.lon) ? hit : null;
}

// 纬度绝对值 <= 90, 经度 <= 180; NaN / Infinity 一并挡掉。
function inRange(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

function extractRaw(s, opts) {
  if (!s) return null;
  const allowBare = !opts || opts.allowBare !== false;
  const str = String(s);
  let m;
  // 前缀 (?:^|[?&]) 是必需的: 无锚定时 "ll=" 会匹配任何以 ll 结尾的参数名,
  // 例如 scroll=1.5,2.5 / pull=... 都会被当成坐标。
  m = str.match(/(?:^|[?&])(?:coordinate|ll|sll)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[1], lon: +m[2], name: queryName(str), src: "apple" };
  // Google: !3d<lat>!4d<lon> 是地点针脚的真实坐标, 必须优先于 @lat,lon —— 后者是
  // 相机视口中心, 与缩放级别绑定, 可以离目标十几公里。
  m = str.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };
  m = str.match(
    /[?&]p=[^,&%]*(?:,|%2C)(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i
  );
  if (m) return { lat: +m[1], lon: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };
  m = str.match(
    /[?&]q=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)(?:(?:,|%2C)((?:(?!,|%2C|&).)+))?/i
  );
  if (m) return { lat: +m[1], lon: +m[2], name: m[3] ? safeDecode(m[3]) : "", src: "amap" };
  // 高德 URI API 的 lnglat= / position= 是「经度,纬度」序, 与上面所有规则相反。
  // 不要照搬旧页面里的 location=/center= 规则: 那条也按 lon,lat 解, 但百度的
  // location= 实际是 lat,lng, 搬过来会把百度链接解颠倒。宁可少认一种也不要认错。
  m = str.match(/(?:^|[?&])(?:lnglat|position)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i);
  if (m) return { lat: +m[2], lon: +m[1], name: queryName(str), src: "amap" };
  // 百度网页版把 BD09MC 米制坐标写进路径: /poi/名称/@12709535.375,2529761.45,19z
  // 位数(6~9)本身就把它和经纬度形式的 @ 区分开了。
  // 这是港澳台百度链接在服务端唯一能拿到坐标的形式 —— 那些地区的分享短链展开后
  // 正文里没有坐标, 得由页面脚本带反爬令牌去查 detailConInfo, Worker 复现不了。
  m = str.match(/baidu\.com\/[^\s]*?@(-?\d{6,9}(?:\.\d+)?)(?:,|%2C)(-?\d{6,9}(?:\.\d+)?)/i);
  if (m) {
    const bd = bd09mcToBd09(+m[1], +m[2]);
    if (bd) return { lat: bd.lat, lon: bd.lon, name: baiduPathName(str), src: "baidu" };
  }
  // 只有在没有针脚坐标时才退而求其次用视口中心。
  m = str.match(/\/maps\/[^\s]*@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2], name: googleName(str), src: "google" };
  if (allowBare) {
    m = str.match(/(-?\d{1,3}\.\d{4,})\s*(?:,|%2C)\s*(-?\d{1,3}\.\d{4,})/);
    if (m) return { lat: +m[1], lon: +m[2], name: "", src: "text" };
  }
  return null;
}

// 查询串里的 ?name=/ &name= —— 苹果地图和高德 URI 都用这个键。
function queryName(str) {
  const m = str.match(/[?&]name=([^&]+)/i);
  return m ? safeDecode(m[1]) : "";
}

// 百度网页版的地名在路径里: /poi/Apple台北101/@...
function baiduPathName(str) {
  const m = str.match(/\/poi\/([^/@?]+)/);
  return m ? safeDecode(m[1]).trim() : "";
}

// Google 的地名在路径里: /maps/place/Apple+Park/@...
function googleName(str) {
  const m = str.match(/\/maps\/place\/([^/@?]+)/);
  return m ? safeDecode(m[1]).replace(/\+/g, " ").trim() : "";
}

// /api/parse 会去 fetch 调用方给的任意 URL。Workers 出网到不了内网, 所以经典的
// SSRF(打内网/元数据服务)基本不成立, 剩下的风险是资源耗尽 —— 一个永不结束的响应
// 能把子请求挂死, 一个几百 MB 的响应能把 128 MB 的 Worker 内存打爆。下面两个常量
// 和 isFetchable() 挡的就是这个, 而不是"防止访问某些站点"。
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512 * 1024;

function isFetchable(u) {
  let url;
  try {
    url = new URL(u);
  } catch (e) {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) return false; // IP 字面量
  return true;
}

// 只读前 MAX_BODY_BYTES, 读满就掐掉连接。坐标总在页面靠前的位置, 读全文没有收益。
async function readCapped(resp) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    return (await resp.text()).slice(0, MAX_BODY_BYTES);
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch (e) {}
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function isBaiduHost(u) {
  try {
    return /(^|\.)baidu\.com$/i.test(new URL(u).hostname);
  } catch (e) {
    return false;
  }
}

// 接受原文(可能含中文地名+链接), 抠出 URL, 必要时跟随重定向展开短链, 提取坐标。
async function parseCoords(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("空输入");

  const urlMatch = text.match(/https?:\/\/[^\s'"<>]+/i);
  let target = urlMatch ? urlMatch[0] : text;

  let hit = extractFromString(target);
  if (hit) return hit;

  if (urlMatch) {
    let cur = target;
    for (let i = 0; i < 5; i++) {
      if (!isFetchable(cur)) break;
      let resp;
      try {
        resp = await fetch(cur, {
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "user-agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/24A5370h Safari/604.1",
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh-Hans;q=0.9",
          },
        });
      } catch (e) {
        break;
      }
      const loc = resp.headers.get("location");
      if (loc) {
        hit = extractFromString(loc);
        if (hit) return hit;
        cur = new URL(loc, cur).toString();
        hit = extractFromString(cur);
        if (hit) return hit;
        continue;
      }
      hit = extractFromString(resp.url);
      if (hit) return hit;
      try {
        const body = await readCapped(resp);
        hit = extractFromString(body, { allowBare: false });
        if (hit) return hit;
        // 百度分享链展开后 URL 里只有 uid, 坐标以 BD09MC 墨卡托米制藏在正文中。
        if (isBaiduHost(cur)) {
          hit = extractBaiduFromBody(body);
          if (hit) return hit;
        }
      } catch (e) {}
      break;
    }
  }
  // 百度对大陆 POI 会把坐标直出在移动版页面里, 港澳台的则不会 —— 那边要靠页面
  // 脚本带 auth/seckey 反爬令牌去查 detailConInfo, 服务端无法复现。与其只说一句
  // "解析不了", 不如告诉用户那条确实走得通的路。
  if (urlMatch && isBaiduHost(target)) {
    throw new Error(
      "百度这条链接的坐标要靠网页脚本才能取到(港澳台的 POI 多为此类)。" +
        "请在浏览器打开该链接, 等地址栏变成 map.baidu.com/poi/名称/@数字,数字,19z 之后, 复制整条地址再粘贴。"
    );
  }
  throw new Error("未能从链接中解析出经纬度");
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

// ---- 百度: BD09MC(墨卡托米制) -> BD09(经纬度) ----
// 百度用的不是标准 Web 墨卡托, 而是按纬度分 6 段的高次多项式拟合。
// 用标准墨卡托逆算会差约 10 公里, 必须用下面这张系数表。
const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 8.98305509648872e-6, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 1.73379812e7],
  [-7.435856389565537e-9, 8.983055097726239e-6, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 1.026014486e7],
  [-3.030883460898826e-8, 8.98305509983578e-6, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6.85681737e6],
  [-1.981981304930552e-8, 8.983055099779535e-6, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4.48277706e6],
  [3.09191371068437e-9, 8.983055096812155e-6, 6.995724062e-5, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2.5551644e6],
  [2.890871144776878e-9, 8.983055095805407e-6, -3.068298e-8, 7.47137025468032, -3.53937994e-6, -0.02145144861037, -1.234426596e-5, 0.00010322952773, -3.23890364e-6, 8.260885e5],
];

function bd09mcToBd09(x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  let f = null;
  for (let i = 0; i < MCBAND.length; i++) {
    if (ay >= MCBAND[i]) { f = MC2LL[i]; break; }
  }
  if (!f) return null;
  const c = ay / f[9];
  let lon = f[0] + f[1] * ax;
  let lat = f[2] + f[3] * c + f[4] * c ** 2 + f[5] * c ** 3 + f[6] * c ** 4 + f[7] * c ** 5 + f[8] * c ** 6;
  lon *= x < 0 ? -1 : 1;
  lat *= y < 0 ? -1 : 1;
  return { lat, lon };
}

// BD09 -> GCJ02 (百度在 GCJ 之上再加了一层自有偏移)
const X_PI = (Math.PI * 3000) / 180;
function bd09ToGcj02(lat, lon) {
  const x = lon - 0.0065, y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(t), lon: z * Math.cos(t) };
}

// ---- 港澳台: 苹果/Google 在这三地发的是 WGS84 ----
//
// GCJ-02 的偏移只施加于中国大陆, 但 gcjOutOfChina 是个粗矩形, 把港澳台整个圈在
// 里面, 于是对本来就是 WGS84 的坐标白做一次反算, 实测偏约 570~600 米。
//
// 关键在于: 这不是一个纯地理判断, 必须按来源区分。高德在香港的瓦片实测仍是
// GCJ-02(把卫星图和高德图放在同一坐标上比对, 差 596 米, 与大陆同量级), 百度的
// BD-09 建在 GCJ 之上同理。所以只有 apple/google 才在港澳台跳过换算。
//
// 实测基准(链接原始值即真值, 与设备 GPS 逐位相同):
//   香港 ifc mall       22.284774, 114.159437
//   澳门 Galaxy Macau   22.148148, 113.555399
//   台北 101            25.033626, 121.564215

// 香港必须用多边形而不是矩形: 任何包住香港的矩形都会把深圳南山/福田一起圈进去,
// 而深圳正是本项目最常用的坐标区域。北界沿深圳河与深圳湾, 自西向东抬升。
// 这条线是近似的, 口岸一带(罗湖/落马洲/沙头角)两侧约 1 公里内可能判错 ——
// 那些地方本身就骑在边界上, 无法用几个折点分清。
const HK_POLY = [
  [113.8, 22.1],
  [113.8, 22.43],
  [113.9, 22.455],
  [113.98, 22.487],
  [114.05, 22.507],
  [114.11, 22.527],
  [114.17, 22.543],
  [114.24, 22.552],
  [114.32, 22.545],
  [114.5, 22.45],
  [114.5, 22.1],
];

// 射线法。poly 的点是 [经度, 纬度]。
function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 澳门与珠海拱北只隔一道关闸(约 250 米), 矩形分不开; 北界取关闸纬度, 误判范围
// 限于口岸那一小片。
function inMacau(lat, lon) {
  return lat >= 22.1 && lat <= 22.215 && lon >= 113.525 && lon <= 113.605;
}

// 台湾本岛 + 澎湖。金门/马祖紧贴厦门与福州, 用矩形圈会误伤大陆, 故不含。
function inTaiwan(lat, lon) {
  return lat >= 21.85 && lat <= 25.35 && lon >= 119.3 && lon <= 122.1;
}

// 该来源在该位置是否直接提供 WGS84(即不需要做 GCJ 反算)。
function usesWgs84Locally(lat, lon, src) {
  if (src !== "apple" && src !== "google") return false;
  return inMacau(lat, lon) || inTaiwan(lat, lon) || pointInPoly(lat, lon, HK_POLY);
}

// 按来源把坐标统一换算到 WGS84。text 源(用户直接输入的裸坐标)视为已是 WGS84。
//
// 注意换算与分派的分工: gcj02ToWgs84 回答"这两个坐标系在此处相差多少", 这个关系
// 在香港同样成立(高德就在用), 所以港澳台的例外不能塞进那个函数里 —— 否则就没法
// 让苹果走一条路、高德走另一条路了。
function toWgs84(lat, lon, src) {
  if (src === "baidu") {
    const g = bd09ToGcj02(lat, lon);
    return gcj02ToWgs84(g.lat, g.lon);
  }
  if (src === "amap" || src === "apple" || src === "google") {
    if (usesWgs84Locally(lat, lon, src)) return { lat, lon };
    return gcj02ToWgs84(lat, lon);
  }
  return { lat, lon };
}

// 百度页面正文里的 "x":"12686385.66","y":"2560876.53" —— BD09MC 米制。
// 量级校验用于把它和页面里其它同名字段(像素坐标等)区分开。
function extractBaiduFromBody(body) {
  const m = String(body).match(/"x"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*,\s*"y"\s*:\s*"?(-?\d+(?:\.\d+)?)"?/);
  if (!m) return null;
  const x = +m[1], y = +m[2];
  if (!(Math.abs(x) > 1e5 && Math.abs(y) > 1e5)) return null;
  const bd = bd09mcToBd09(x, y);
  if (!bd || Math.abs(bd.lat) > 90 || Math.abs(bd.lon) > 180) return null;
  const nm = String(body).match(/<title>[^<]*?【([^】]{1,40})】/);
  return { lat: bd.lat, lon: bd.lon, name: nm ? nm[1] : "", src: "baidu" };
}

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function gcjOutOfChina(lng, la) {
  return lng < 72.004 || lng > 137.8347 || la < 0.8293 || la > 55.8271;
}

function gcjDeltaLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function gcjDeltaLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}

// WGS84 -> GCJ-02 (正向偏移), 与高德/苹果中国所用偏移一致。
function wgs84ToGcj02(lat, lon) {
  if (gcjOutOfChina(lon, lat)) return { lat, lon };
  let dLat = gcjDeltaLat(lon - 105.0, lat - 35.0);
  let dLon = gcjDeltaLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

// GCJ-02 -> WGS84 (迭代反算, 亚米级)。
// 单程反算在偏移梯度大的地区会残留 1~2m, 这里用不动点迭代收敛到 <0.1m,
// 与高德自身的 WGS84->GCJ 逆运算严格对齐, 消除回看时的残差。
function gcj02ToWgs84(lat, lon) {
  if (gcjOutOfChina(lon, lat)) return { lat, lon };
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 6; i++) {
    const g = wgs84ToGcj02(wgsLat, wgsLon);
    const errLat = g.lat - lat;
    const errLon = g.lon - lon;
    if (Math.abs(errLat) < 1e-9 && Math.abs(errLon) < 1e-9) break;
    wgsLat -= errLat;
    wgsLon -= errLon;
  }
  return { lat: wgsLat, lon: wgsLon };
}

/* ==== inlined from src/icons.js ==== */

// Auto-generated PWA app icons. Regenerate with scripts/gen_icons.py.
// Blue square + white location pin; apple-touch-icon (180) and web manifest (512).
const ICON_180_B64 = "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";
const ICON_512_B64 = "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";

// Inline vector icon (favicon + manifest 'any' purpose).
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2E9BFF"/><stop offset="1" stop-color="#0A66FF"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><path fill="#fff" d="M256 120a96 96 0 0 0-96 96c0 66 96 176 96 176s96-110 96-176a96 96 0 0 0-96-96z"/><circle cx="256" cy="216" r="40" fill="#0A66FF"/></svg>`;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ==== inlined from src/modules.js ==== */

// Auto-generated: the on-device module scripts, base64 (UTF-8 bytes). DO NOT EDIT BY HAND.
// Regenerate with: cd stateless-picker/worker && node scripts/gen-modules.mjs
// The worker serves these at /location-spoofer.js, /location-settings.js and
// /location-spoofer-qx.js so the whole stateless setup runs from the worker (no GitHub dep).
const LOCATION_SPOOFER_B64 = "LyoKICog5oum5oiqIEFwcGxlIC9jbGxzL3dsb2Mg5o6l5Y+j55qE5Zue5bqU77yM6KejIEFSUEMg5bCB5YyF77yM5pS5IFdpRmkg54Ot54K55ZKM5Z+656uZ5Z2Q5qCH77yMCiAqIOWGjeaMiSBBcHBsZSDnmoTmoLzlvI/lsIHlm57ljrvov5Tlm57nu5nns7vnu5/jgIIKICoKICog5Li76KaB5rWB56iL77yaCiAqICAgQVJQQyDmi4bljIUg4oaSIHByb3RvYnVmIOino+Wtl+autSDihpIg5pu/5o2iIExvY2F0aW9uIOWtkOa2iOaBr+eahOWdkOaghy/nsr7luqYv6L+Q5Yqo54q25oCBCiAqICAg4oaSIHByb3RvYnVmIOmHjeaWsOaJk+WMhSDihpIg5oyJ5Y6f5qC85byP77yIQVJQQyAvIG1hcmtlciAvIHN5bnRoZXRpY++8ieWwgeWbngogKi8KKGZ1bmN0aW9uICgpIHsKICAidXNlIHN0cmljdCI7CgogIHZhciBERUZBVUxUX0NPTkZJRyA9IHsKICAgIC8vIFN0YXRlbGVzcyBkZWZhdWx0OiBPRkYgdW50aWwgYSBjb29yZGluYXRlIGlzIHdyaXR0ZW4gdG8gdGhlIGRldmljZSdzIG93bgogICAgLy8gJHBlcnNpc3RlbnRTdG9yZSAoYnkgdGhlIHBpY2tlcidzIHNhdmUtaW50ZXJjZXB0b3IpIG9yIGVuYWJsZWQ9dHJ1ZSBpcyBwYXNzZWQKICAgIC8vIGFzIGEgbW9kdWxlIGFyZ3VtZW50LiBUaGlzIG1ha2VzICJub3RoaW5nIHBpY2tlZCB5ZXQiIGZhbGwgdGhyb3VnaCB0byB0aGUgcmVhbAogICAgLy8gbG9jYXRpb24gaW5zdGVhZCBvZiB0aGUgYnVpbHQtaW4gQXBwbGUgUGFyayBkZWZhdWx0LiBTdGF0ZWZ1bCBtb2R1bGUgbWFuaWZlc3RzCiAgICAvLyBwYXNzIGVuYWJsZWQ9dHJ1ZSBleHBsaWNpdGx5IHRvIGtlZXAgdGhlaXIgYWx3YXlzLW9uIGJlaGF2aW9yLgogICAgZW5hYmxlZDogZmFsc2UsCiAgICBtb2RlOiAicmVzcG9uc2UiLAogICAgbGF0aXR1ZGU6IDM3LjMzNDksCiAgICBsb25naXR1ZGU6IC0xMjIuMDA5MDIsCiAgICBob3Jpem9udGFsQWNjdXJhY3k6IDM5LAogICAgdmVydGljYWxBY2N1cmFjeTogMTAwMCwKICAgIC8vIFJhbmRvbSBwZXJ0dXJiYXRpb24gcmFkaXVzIGluIG1ldHJlcyAoWXU5MTkxIHYxLjEgIuaJsOWKqOWNiuW+hCIpLiAwID0gb2ZmLiBUaGUKICAgIC8vIHJlYWwgdmFsdWUgaXMgd3JpdHRlbiBwZXItZGV2aWNlIGJ5IHRoZSBwaWNrZXIgKHNlZSBsb2NhdGlvbi1zZXR0aW5ncy5qcykuCiAgICByYW5kb21SYWRpdXM6IDAsCiAgICBhbHRpdHVkZTogNTMwLAogICAgdW5rbm93blZhbHVlNDogMywKICAgIG1vdGlvbkFjdGl2aXR5VHlwZTogNjMsCiAgICBtb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2U6IDQ2NywKICAgIGZhaWxPcGVuOiB0cnVlLAogICAgZGVidWc6IGZhbHNlLAogICAgZHVtcFJhdzogZmFsc2UsCiAgICBkdW1wSGVhZGVyczogZmFsc2UsCiAgICBwcmVwYXJlSGVhZGVyczogZmFsc2UsCiAgICByYXdMaW1pdDogMAogIH07CgogIC8vIFByZWZpeCBwcmVwZW5kZWQgdG8gYSBTUE9PRkVEIChzeW50aGVzaXplZCkgcmVzcG9uc2UuIE1pcnJvcnMgdGhlIG9yaWdpbmFsIEdvCiAgLy8gYGluaXRpYWxCeXRlcyA9IDAwMDEwMDAwMDAwMTAwMDBgIGZyb20gbWFpbi5nbzoyNTMuCiAgdmFyIEFQUExFX1dMT0NfUFJFRklYID0gYnl0ZXNGcm9tQXJyYXkoWzB4MDAsIDB4MDEsIDB4MDAsIDB4MDAsIDB4MDAsIDB4MDEsIDB4MDAsIDB4MDBdKTsKCiAgLy8gU3RhYmxlIG1hcmtlciB0aGF0IHByZWNlZGVzIHRoZSBBcHBsZVdMb2MgcHJvdG9idWYgaW5zaWRlIGEgUkVBTCBBcHBsZSAvY2xscy93bG9jCiAgLy8gcmVzcG9uc2UuIEFmdGVyIHRoZSBtYXJrZXIgY29tZSAyIGJ5dGVzICh1aW50MTYgQkUgcGF5bG9hZCBsZW5ndGgpIHRoZW4gdGhlIHBheWxvYWQuCiAgdmFyIEFQUExFX1dMT0NfTUFSS0VSID0gYnl0ZXNGcm9tQXJyYXkoWzB4MDAsIDB4MDAsIDB4MDAsIDB4MDEsIDB4MDAsIDB4MDBdKTsKICB2YXIgUk9PVF9EUk9QX0ZJRUxEUyA9IHsgMzogdHJ1ZSwgNDogdHJ1ZSwgMzM6IHRydWUgfTsKICB2YXIgQ0VMTF9SRVNQT05TRV9GSUVMRFMgPSB7IDIyOiB0cnVlLCAyNDogdHJ1ZSB9OwogIHZhciBMT0NBVElPTl9SRVBMQUNFRF9GSUVMRFMgPSB7CiAgICAxOiB0cnVlLAogICAgMjogdHJ1ZSwKICAgIDM6IHRydWUsCiAgICA0OiB0cnVlLAogICAgNTogdHJ1ZSwKICAgIDY6IHRydWUsCiAgICAxMTogdHJ1ZSwKICAgIDEyOiB0cnVlCiAgfTsKCiAgZnVuY3Rpb24gYnl0ZXNGcm9tQXJyYXkodmFsdWVzKSB7CiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkodmFsdWVzKTsKICB9CgogIGZ1bmN0aW9uIGNvbmNhdEJ5dGVzKHBhcnRzKSB7CiAgICB2YXIgdG90YWwgPSAwOwogICAgdmFyIGk7CiAgICBmb3IgKGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdG90YWwgKz0gcGFydHNbaV0ubGVuZ3RoOwogICAgfQoKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh0b3RhbCk7CiAgICB2YXIgb2Zmc2V0ID0gMDsKICAgIGZvciAoaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkgKz0gMSkgewogICAgICBvdXQuc2V0KHBhcnRzW2ldLCBvZmZzZXQpOwogICAgICBvZmZzZXQgKz0gcGFydHNbaV0ubGVuZ3RoOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIGZ1bmN0aW9uIGJ5dGVzRXF1YWxQcmVmaXgoYnl0ZXMsIHByZWZpeCkgewogICAgaWYgKCFieXRlcyB8fCBieXRlcy5sZW5ndGggPCBwcmVmaXgubGVuZ3RoKSB7CiAgICAgIHJldHVybiBmYWxzZTsKICAgIH0KICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcHJlZml4Lmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmIChieXRlc1tpXSAhPT0gcHJlZml4W2ldKSB7CiAgICAgICAgcmV0dXJuIGZhbHNlOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gdHJ1ZTsKICB9CgogIC8vIFNlYXJjaCBmb3IgYSBieXRlIHNlcXVlbmNlIHdpdGhpbiBieXRlczsgcmV0dXJucyBmaXJzdCBpbmRleCBvciAtMS4KICAvLyBTZWFyY2hlcyBmb3J3YXJkIHRvIHByZWZlciB0aGUgZWFybGllc3QgKG1vc3QgbGlrZWx5IGNvcnJlY3QpIG1hdGNoLgogIGZ1bmN0aW9uIGZpbmRCeXRlcyhieXRlcywgbWFya2VyKSB7CiAgICBpZiAoIWJ5dGVzIHx8ICFtYXJrZXIgfHwgbWFya2VyLmxlbmd0aCA9PT0gMCkgewogICAgICByZXR1cm4gLTE7CiAgICB9CiAgICBmb3IgKHZhciBpID0gMDsgaSA8PSBieXRlcy5sZW5ndGggLSBtYXJrZXIubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdmFyIG9rID0gdHJ1ZTsKICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBtYXJrZXIubGVuZ3RoOyBqICs9IDEpIHsKICAgICAgICBpZiAoYnl0ZXNbaSArIGpdICE9PSBtYXJrZXJbal0pIHsKICAgICAgICAgIG9rID0gZmFsc2U7CiAgICAgICAgICBicmVhazsKICAgICAgICB9CiAgICAgIH0KICAgICAgaWYgKG9rKSB7CiAgICAgICAgcmV0dXJuIGk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiAtMTsKICB9CgogIC8vIFRyeSB0byBwYXJzZSBieXRlcyBhcyBwcm90b2J1ZiBmaWVsZHMuIFJldHVybnMgZmllbGRzIGFycmF5IG9yIG51bGwgb24gZmFpbHVyZS4KICBmdW5jdGlvbiB0cnlQYXJzZUZpZWxkcyhieXRlcykgewogICAgdHJ5IHsKICAgICAgaWYgKCFieXRlcyB8fCBieXRlcy5sZW5ndGggPT09IDApIHsKICAgICAgICByZXR1cm4gbnVsbDsKICAgICAgfQogICAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMoYnl0ZXMpOwogICAgICByZXR1cm4gZmllbGRzLmxlbmd0aCA+IDAgPyBmaWVsZHMgOiBudWxsOwogICAgfSBjYXRjaCAoZSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGJpbmFyeVN0cmluZ1RvQnl0ZXModmFsdWUpIHsKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh2YWx1ZS5sZW5ndGgpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkgKz0gMSkgewogICAgICBvdXRbaV0gPSB2YWx1ZS5jaGFyQ29kZUF0KGkpICYgMHhmZjsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBieXRlc1RvQmluYXJ5U3RyaW5nKGJ5dGVzKSB7CiAgICB2YXIgY2h1bmtTaXplID0gMHg4MDAwOwogICAgdmFyIGNodW5rcyA9IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBieXRlcy5sZW5ndGg7IGkgKz0gY2h1bmtTaXplKSB7CiAgICAgIHZhciBjaHVuayA9IGJ5dGVzLnN1YmFycmF5KGksIGkgKyBjaHVua1NpemUpOwogICAgICBjaHVua3MucHVzaChTdHJpbmcuZnJvbUNoYXJDb2RlLmFwcGx5KG51bGwsIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGNodW5rKSkpOwogICAgfQogICAgcmV0dXJuIGNodW5rcy5qb2luKCIiKTsKICB9CgogIGZ1bmN0aW9uIGJ5dGVzVG9CYXNlNjQoYnl0ZXMpIHsKICAgIHZhciBhbHBoYWJldCA9ICJBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvIjsKICAgIHZhciBvdXQgPSAiIjsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYnl0ZXMubGVuZ3RoOyBpICs9IDMpIHsKICAgICAgdmFyIGIwID0gYnl0ZXNbaV07CiAgICAgIHZhciBiMSA9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYnl0ZXNbaSArIDFdIDogMDsKICAgICAgdmFyIGIyID0gaSArIDIgPCBieXRlcy5sZW5ndGggPyBieXRlc1tpICsgMl0gOiAwOwogICAgICB2YXIgdHJpcGxldCA9IChiMCA8PCAxNikgfCAoYjEgPDwgOCkgfCBiMjsKICAgICAgb3V0ICs9IGFscGhhYmV0Wyh0cmlwbGV0ID4+IDE4KSAmIDB4M2ZdOwogICAgICBvdXQgKz0gYWxwaGFiZXRbKHRyaXBsZXQgPj4gMTIpICYgMHgzZl07CiAgICAgIG91dCArPSBpICsgMSA8IGJ5dGVzLmxlbmd0aCA/IGFscGhhYmV0Wyh0cmlwbGV0ID4+IDYpICYgMHgzZl0gOiAiPSI7CiAgICAgIG91dCArPSBpICsgMiA8IGJ5dGVzLmxlbmd0aCA/IGFscGhhYmV0W3RyaXBsZXQgJiAweDNmXSA6ICI9IjsKICAgIH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBoZXhQcmV2aWV3KGJ5dGVzLCBsaW1pdCkgewogICAgaWYgKCFieXRlcykgewogICAgICByZXR1cm4gIjxub25lPiI7CiAgICB9CiAgICB2YXIgb3V0ID0gW107CiAgICB2YXIgbWF4ID0gTWF0aC5taW4oYnl0ZXMubGVuZ3RoLCBsaW1pdCB8fCAxNik7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1heDsgaSArPSAxKSB7CiAgICAgIG91dC5wdXNoKCgiMCIgKyBieXRlc1tpXS50b1N0cmluZygxNikpLnNsaWNlKC0yKSk7CiAgICB9CiAgICByZXR1cm4gb3V0LmpvaW4oIiIpOwogIH0KCiAgZnVuY3Rpb24gYm9keVRvQnl0ZXMoYm9keSkgewogICAgaWYgKGJvZHkgPT0gbnVsbCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmIChib2R5IGluc3RhbmNlb2YgVWludDhBcnJheSkgewogICAgICByZXR1cm4gYm9keTsKICAgIH0KICAgIGlmICh0eXBlb2YgQXJyYXlCdWZmZXIgIT09ICJ1bmRlZmluZWQiICYmIGJvZHkgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgewogICAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYm9keSk7CiAgICB9CiAgICBpZiAodHlwZW9mIGJvZHkgPT09ICJzdHJpbmciKSB7CiAgICAgIHJldHVybiBiaW5hcnlTdHJpbmdUb0J5dGVzKGJvZHkpOwogICAgfQogICAgaWYgKHR5cGVvZiBib2R5ID09PSAib2JqZWN0IiAmJiB0eXBlb2YgYm9keS5sZW5ndGggPT09ICJudW1iZXIiKSB7CiAgICAgIHJldHVybiBuZXcgVWludDhBcnJheShib2R5KTsKICAgIH0KICAgIGlmICh0eXBlb2YgYm9keSA9PT0gIm9iamVjdCIgJiYgYm9keS5ieXRlcyAmJiB0eXBlb2YgYm9keS5ieXRlcy5sZW5ndGggPT09ICJudW1iZXIiKSB7CiAgICAgIHJldHVybiBuZXcgVWludDhBcnJheShib2R5LmJ5dGVzKTsKICAgIH0KICAgIGlmICh0eXBlb2YgYm9keSA9PT0gIm9iamVjdCIgJiYgYm9keS5kYXRhICYmIHR5cGVvZiBib2R5LmRhdGEubGVuZ3RoID09PSAibnVtYmVyIikgewogICAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYm9keS5kYXRhKTsKICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gbWVzc2FnZUJvZHlUb0J5dGVzKG1lc3NhZ2UpIHsKICAgIGlmICghbWVzc2FnZSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIHJldHVybiAoCiAgICAgIGJvZHlUb0J5dGVzKG1lc3NhZ2UuYm9keUJ5dGVzKSB8fAogICAgICBib2R5VG9CeXRlcyhtZXNzYWdlLmJvZHkpIHx8CiAgICAgIGJvZHlUb0J5dGVzKG1lc3NhZ2UucmF3Qm9keSkgfHwKICAgICAgYm9keVRvQnl0ZXMobWVzc2FnZS5iaW5hcnlCb2R5KQogICAgKTsKICB9CgogIGZ1bmN0aW9uIHJlYWRVSW50MTZCRShieXRlcywgb2Zmc2V0KSB7CiAgICBpZiAob2Zmc2V0ICsgMiA+IGJ5dGVzLmxlbmd0aCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoInVpbnQxNiBvdXQgb2YgcmFuZ2UiKTsKICAgIH0KICAgIHJldHVybiAoYnl0ZXNbb2Zmc2V0XSA8PCA4KSB8IGJ5dGVzW29mZnNldCArIDFdOwogIH0KCiAgZnVuY3Rpb24gcmVhZFVJbnQzMkJFKGJ5dGVzLCBvZmZzZXQpIHsKICAgIGlmIChvZmZzZXQgKyA0ID4gYnl0ZXMubGVuZ3RoKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigidWludDMyIG91dCBvZiByYW5nZSIpOwogICAgfQogICAgcmV0dXJuICgKICAgICAgKGJ5dGVzW29mZnNldF0gKiAweDEwMDAwMDApICsKICAgICAgKChieXRlc1tvZmZzZXQgKyAxXSA8PCAxNikgfCAoYnl0ZXNbb2Zmc2V0ICsgMl0gPDwgOCkgfCBieXRlc1tvZmZzZXQgKyAzXSkKICAgICkgPj4+IDA7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVVJbnQxNkJFKHZhbHVlKSB7CiAgICBpZiAodmFsdWUgPCAwIHx8IHZhbHVlID4gMHhmZmZmKSB7CiAgICAgIHRocm93IG5ldyBFcnJvcigidWludDE2IHZhbHVlIG91dCBvZiByYW5nZTogIiArIHZhbHVlKTsKICAgIH0KICAgIHJldHVybiBieXRlc0Zyb21BcnJheShbKHZhbHVlID4+IDgpICYgMHhmZiwgdmFsdWUgJiAweGZmXSk7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVVJbnQzMkJFKHZhbHVlKSB7CiAgICByZXR1cm4gYnl0ZXNGcm9tQXJyYXkoWwogICAgICAodmFsdWUgPj4+IDI0KSAmIDB4ZmYsCiAgICAgICh2YWx1ZSA+Pj4gMTYpICYgMHhmZiwKICAgICAgKHZhbHVlID4+PiA4KSAmIDB4ZmYsCiAgICAgIHZhbHVlICYgMHhmZgogICAgXSk7CiAgfQoKICBmdW5jdGlvbiBhc2NpaUJ5dGVzKHZhbHVlKSB7CiAgICB2YXIgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodmFsdWUubGVuZ3RoKTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgb3V0W2ldID0gdmFsdWUuY2hhckNvZGVBdChpKSAmIDB4N2Y7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gZW5jb2RlVmFyaW50VW5zaWduZWQodmFsdWUpIHsKICAgIHZhciB2ID0gdHlwZW9mIHZhbHVlID09PSAiYmlnaW50IiA/IHZhbHVlIDogQmlnSW50KHZhbHVlKTsKICAgIGlmICh2IDwgMG4pIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJuZWdhdGl2ZSB1bnNpZ25lZCB2YXJpbnQiKTsKICAgIH0KCiAgICB2YXIgb3V0ID0gW107CiAgICB3aGlsZSAodiA+PSAweDgwbikgewogICAgICBvdXQucHVzaChOdW1iZXIoKHYgJiAweDdmbikgfCAweDgwbikpOwogICAgICB2ID4+PSA3bjsKICAgIH0KICAgIG91dC5wdXNoKE51bWJlcih2KSk7CiAgICByZXR1cm4gYnl0ZXNGcm9tQXJyYXkob3V0KTsKICB9CgogIGZ1bmN0aW9uIGVuY29kZVZhcmludFNpZ25lZEludDY0KHZhbHVlKSB7CiAgICB2YXIgdiA9IHR5cGVvZiB2YWx1ZSA9PT0gImJpZ2ludCIgPyB2YWx1ZSA6IEJpZ0ludChNYXRoLnRydW5jKHZhbHVlKSk7CiAgICBpZiAodiA8IDBuKSB7CiAgICAgIHYgPSBCaWdJbnQuYXNVaW50Tig2NCwgdik7CiAgICB9CiAgICByZXR1cm4gZW5jb2RlVmFyaW50VW5zaWduZWQodik7CiAgfQoKICBmdW5jdGlvbiBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCkgewogICAgdmFyIHJlc3VsdCA9IDBuOwogICAgdmFyIHNoaWZ0ID0gMG47CiAgICB2YXIgY3VycmVudCA9IG9mZnNldDsKCiAgICB3aGlsZSAoY3VycmVudCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIgYiA9IGJ5dGVzW2N1cnJlbnRdOwogICAgICBjdXJyZW50ICs9IDE7CiAgICAgIHJlc3VsdCB8PSBCaWdJbnQoYiAmIDB4N2YpIDw8IHNoaWZ0OwogICAgICBpZiAoKGIgJiAweDgwKSA9PT0gMCkgewogICAgICAgIHJldHVybiB7IHZhbHVlOiByZXN1bHQsIG9mZnNldDogY3VycmVudCB9OwogICAgICB9CiAgICAgIHNoaWZ0ICs9IDduOwogICAgICBpZiAoc2hpZnQgPiA3MG4pIHsKICAgICAgICB0aHJvdyBuZXcgRXJyb3IoInZhcmludCB0b28gbG9uZyIpOwogICAgICB9CiAgICB9CgogICAgdGhyb3cgbmV3IEVycm9yKCJ1bnRlcm1pbmF0ZWQgdmFyaW50Iik7CiAgfQoKICBmdW5jdGlvbiBtYWtlS2V5KGZpZWxkTnVtYmVyLCB3aXJlVHlwZSkgewogICAgcmV0dXJuIGVuY29kZVZhcmludFVuc2lnbmVkKChCaWdJbnQoZmllbGROdW1iZXIpIDw8IDNuKSB8IEJpZ0ludCh3aXJlVHlwZSkpOwogIH0KCiAgZnVuY3Rpb24gbWFrZVZhcmludEZpZWxkKGZpZWxkTnVtYmVyLCB2YWx1ZSkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFttYWtlS2V5KGZpZWxkTnVtYmVyLCAwKSwgZW5jb2RlVmFyaW50U2lnbmVkSW50NjQodmFsdWUpXSk7CiAgfQoKICBmdW5jdGlvbiBtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoZmllbGROdW1iZXIsIHBheWxvYWQpIHsKICAgIHJldHVybiBjb25jYXRCeXRlcyhbbWFrZUtleShmaWVsZE51bWJlciwgMiksIGVuY29kZVZhcmludFVuc2lnbmVkKHBheWxvYWQubGVuZ3RoKSwgcGF5bG9hZF0pOwogIH0KCiAgZnVuY3Rpb24gcGFyc2VGaWVsZHMoYnl0ZXMpIHsKICAgIHZhciBmaWVsZHMgPSBbXTsKICAgIHZhciBvZmZzZXQgPSAwOwoKICAgIHdoaWxlIChvZmZzZXQgPCBieXRlcy5sZW5ndGgpIHsKICAgICAgdmFyIGtleVN0YXJ0ID0gb2Zmc2V0OwogICAgICB2YXIga2V5ID0gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpOwogICAgICBvZmZzZXQgPSBrZXkub2Zmc2V0OwoKICAgICAgdmFyIGZpZWxkTnVtYmVyID0gTnVtYmVyKGtleS52YWx1ZSA+PiAzbik7CiAgICAgIHZhciB3aXJlVHlwZSA9IE51bWJlcihrZXkudmFsdWUgJiAweDduKTsKICAgICAgaWYgKGZpZWxkTnVtYmVyID09PSAwKSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCJwcm90b2J1ZiBmaWVsZCBudW1iZXIgMCIpOwogICAgICB9CgogICAgICB2YXIgdmFsdWVTdGFydCA9IG9mZnNldDsKICAgICAgdmFyIHZhbHVlRW5kOwogICAgICBpZiAod2lyZVR5cGUgPT09IDApIHsKICAgICAgICB2YWx1ZUVuZCA9IGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KS5vZmZzZXQ7CiAgICAgIH0gZWxzZSBpZiAod2lyZVR5cGUgPT09IDEpIHsKICAgICAgICB2YWx1ZUVuZCA9IG9mZnNldCArIDg7CiAgICAgIH0gZWxzZSBpZiAod2lyZVR5cGUgPT09IDIpIHsKICAgICAgICB2YXIgbGVuZ3RoSW5mbyA9IGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KTsKICAgICAgICB2YXIgbGVuZ3RoID0gTnVtYmVyKGxlbmd0aEluZm8udmFsdWUpOwogICAgICAgIHZhbHVlU3RhcnQgPSBsZW5ndGhJbmZvLm9mZnNldDsKICAgICAgICB2YWx1ZUVuZCA9IHZhbHVlU3RhcnQgKyBsZW5ndGg7CiAgICAgIH0gZWxzZSBpZiAod2lyZVR5cGUgPT09IDUpIHsKICAgICAgICB2YWx1ZUVuZCA9IG9mZnNldCArIDQ7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCJ1bnN1cHBvcnRlZCBwcm90b2J1ZiB3aXJlIHR5cGU6ICIgKyB3aXJlVHlwZSk7CiAgICAgIH0KCiAgICAgIGlmICh2YWx1ZUVuZCA+IGJ5dGVzLmxlbmd0aCkgewogICAgICAgIHRocm93IG5ldyBFcnJvcigicHJvdG9idWYgZmllbGQgZXhjZWVkcyBidWZmZXIiKTsKICAgICAgfQoKICAgICAgZmllbGRzLnB1c2goewogICAgICAgIGZpZWxkTnVtYmVyOiBmaWVsZE51bWJlciwKICAgICAgICB3aXJlVHlwZTogd2lyZVR5cGUsCiAgICAgICAga2V5U3RhcnQ6IGtleVN0YXJ0LAogICAgICAgIHZhbHVlU3RhcnQ6IHZhbHVlU3RhcnQsCiAgICAgICAgdmFsdWVFbmQ6IHZhbHVlRW5kLAogICAgICAgIGVuZDogdmFsdWVFbmQsCiAgICAgICAgcmF3OiBieXRlcy5zbGljZShrZXlTdGFydCwgdmFsdWVFbmQpLAogICAgICAgIHZhbHVlQnl0ZXM6IGJ5dGVzLnNsaWNlKHZhbHVlU3RhcnQsIHZhbHVlRW5kKQogICAgICB9KTsKICAgICAgb2Zmc2V0ID0gdmFsdWVFbmQ7CiAgICB9CgogICAgcmV0dXJuIGZpZWxkczsKICB9CgogIGZ1bmN0aW9uIGZpcnN0RmllbGRCeU51bWJlcihmaWVsZHMsIGZpZWxkTnVtYmVyKSB7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICBpZiAoZmllbGRzW2ldLmZpZWxkTnVtYmVyID09PSBmaWVsZE51bWJlcikgewogICAgICAgIHJldHVybiBmaWVsZHNbaV07CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gc2lnbmVkVmFyaW50RmllbGRWYWx1ZShmaWVsZCkgewogICAgaWYgKCFmaWVsZCB8fCBmaWVsZC53aXJlVHlwZSAhPT0gMCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIHJldHVybiBCaWdJbnQuYXNJbnROKDY0LCBkZWNvZGVWYXJpbnQoZmllbGQudmFsdWVCeXRlcywgMCkudmFsdWUpOwogIH0KCiAgZnVuY3Rpb24gbG9jYXRpb25TdW1tYXJ5KGxvY2F0aW9uUGF5bG9hZCkgewogICAgdHJ5IHsKICAgICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKGxvY2F0aW9uUGF5bG9hZCk7CiAgICAgIHZhciBsYXQgPSBzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihmaWVsZHMsIDEpKTsKICAgICAgdmFyIGxvbiA9IHNpZ25lZFZhcmludEZpZWxkVmFsdWUoZmlyc3RGaWVsZEJ5TnVtYmVyKGZpZWxkcywgMikpOwogICAgICBpZiAobGF0ID09IG51bGwgfHwgbG9uID09IG51bGwpIHsKICAgICAgICByZXR1cm4gIjxtaXNzaW5nPiI7CiAgICAgIH0KICAgICAgcmV0dXJuIChOdW1iZXIobGF0KSAvIDEwMDAwMDAwMCkudG9GaXhlZCg4KSArICIsIiArIChOdW1iZXIobG9uKSAvIDEwMDAwMDAwMCkudG9GaXhlZCg4KTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICByZXR1cm4gIjxwYXJzZS1mYWlsZWQ6IiArIGVyci5tZXNzYWdlICsgIj4iOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcGF0Y2hlZFBheWxvYWRTdW1tYXJ5KHBheWxvYWQpIHsKICAgIHRyeSB7CiAgICAgIHZhciByb290RmllbGRzID0gcGFyc2VGaWVsZHMocGF5bG9hZCk7CiAgICAgIHZhciBwYXJ0cyA9IFtdOwogICAgICB2YXIgd2lmaSA9IGZpcnN0RmllbGRCeU51bWJlcihyb290RmllbGRzLCAyKTsKICAgICAgaWYgKHdpZmkgJiYgd2lmaS53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHZhciB3aWZpTG9jYXRpb24gPSBmaXJzdEZpZWxkQnlOdW1iZXIocGFyc2VGaWVsZHMod2lmaS52YWx1ZUJ5dGVzKSwgMik7CiAgICAgICAgcGFydHMucHVzaCgiZmlyc3RXaWZpPSIgKyAod2lmaUxvY2F0aW9uID8gbG9jYXRpb25TdW1tYXJ5KHdpZmlMb2NhdGlvbi52YWx1ZUJ5dGVzKSA6ICI8bWlzc2luZz4iKSk7CiAgICAgIH0KICAgICAgdmFyIGNlbGwgPSBmaXJzdENlbGxSZXNwb25zZUZpZWxkKHJvb3RGaWVsZHMpOwogICAgICBpZiAoY2VsbCAmJiBjZWxsLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgdmFyIGNlbGxMb2NhdGlvbiA9IGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyhjZWxsLnZhbHVlQnl0ZXMpLCA1KTsKICAgICAgICBwYXJ0cy5wdXNoKCJmaXJzdENlbGw9IiArIChjZWxsTG9jYXRpb24gPyBsb2NhdGlvblN1bW1hcnkoY2VsbExvY2F0aW9uLnZhbHVlQnl0ZXMpIDogIjxtaXNzaW5nPiIpKTsKICAgICAgfQogICAgICByZXR1cm4gcGFydHMubGVuZ3RoID8gcGFydHMuam9pbigiLCAiKSA6ICJubyB3aWZpL2NlbGwgbG9jYXRpb24gZmllbGRzIjsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICByZXR1cm4gInN1bW1hcnkgZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2U7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkTnVtYmVyKSB7CiAgICByZXR1cm4gQ0VMTF9SRVNQT05TRV9GSUVMRFNbZmllbGROdW1iZXJdID09PSB0cnVlOwogIH0KCiAgZnVuY3Rpb24gZmlyc3RDZWxsUmVzcG9uc2VGaWVsZChmaWVsZHMpIHsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmIChpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkc1tpXS5maWVsZE51bWJlcikpIHsKICAgICAgICByZXR1cm4gZmllbGRzW2ldOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gbnVsbDsKICB9CgogIGZ1bmN0aW9uIGNvb3JkVG9JbnQodmFsdWUpIHsKICAgIC8vIOS9v+eUqCBNYXRoLnRydW5jIOeyvuehruWMuemFjSBHbzogaW50NjQoY29vcmQgKiAxZTgpCiAgICByZXR1cm4gTWF0aC50cnVuYyhOdW1iZXIodmFsdWUpICogMTAwMDAwMDAwKTsKICB9CgogIGZ1bmN0aW9uIHBhcnNlQm9vbGVhbih2YWx1ZSwgZGVmYXVsdFZhbHVlKSB7CiAgICBpZiAodmFsdWUgPT09IHRydWUgfHwgdmFsdWUgPT09IGZhbHNlKSB7CiAgICAgIHJldHVybiB2YWx1ZTsKICAgIH0KICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICJzdHJpbmciKSB7CiAgICAgIHZhciBub3JtYWxpemVkID0gdmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmIChub3JtYWxpemVkID09PSAidHJ1ZSIgfHwgbm9ybWFsaXplZCA9PT0gIjEiIHx8IG5vcm1hbGl6ZWQgPT09ICJ5ZXMiIHx8IG5vcm1hbGl6ZWQgPT09ICJvbiIpIHsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfQogICAgICBpZiAobm9ybWFsaXplZCA9PT0gImZhbHNlIiB8fCBub3JtYWxpemVkID09PSAiMCIgfHwgbm9ybWFsaXplZCA9PT0gIm5vIiB8fCBub3JtYWxpemVkID09PSAib2ZmIikgewogICAgICAgIHJldHVybiBmYWxzZTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIGRlZmF1bHRWYWx1ZTsKICB9CgogIGZ1bmN0aW9uIG5vcm1hbGl6ZUNvbmZpZyhpbnB1dCkgewogICAgdmFyIGNmZyA9IHt9OwogICAgdmFyIGtleTsKICAgIGZvciAoa2V5IGluIERFRkFVTFRfQ09ORklHKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoREVGQVVMVF9DT05GSUcsIGtleSkpIHsKICAgICAgICBjZmdba2V5XSA9IERFRkFVTFRfQ09ORklHW2tleV07CiAgICAgIH0KICAgIH0KICAgIGlucHV0ID0gaW5wdXQgfHwge307CiAgICBmb3IgKGtleSBpbiBpbnB1dCkgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGlucHV0LCBrZXkpKSB7CiAgICAgICAgY2ZnW2tleV0gPSBpbnB1dFtrZXldOwogICAgICB9CiAgICB9CgogICAgY2ZnLmVuYWJsZWQgPSBwYXJzZUJvb2xlYW4oY2ZnLmVuYWJsZWQsIHRydWUpOwogICAgY2ZnLmZhaWxPcGVuID0gcGFyc2VCb29sZWFuKGNmZy5mYWlsT3BlbiwgdHJ1ZSk7CiAgICB2YXIgbW9kZSA9IFN0cmluZyhjZmcubW9kZSB8fCAicmVzcG9uc2UiKS50b0xvd2VyQ2FzZSgpOwogICAgY2ZnLm1vZGUgPSBtb2RlID09PSAicmVxdWVzdCIgfHwgbW9kZSA9PT0gInByZXBhcmUiIHx8IG1vZGUgPT09ICJwcm9iZSIgfHwgbW9kZSA9PT0gImluc3BlY3QiID8gbW9kZSA6ICJyZXNwb25zZSI7CiAgICBjZmcubGF0aXR1ZGUgPSBOdW1iZXIoY2ZnLmxhdGl0dWRlKTsKICAgIGNmZy5sb25naXR1ZGUgPSBOdW1iZXIoY2ZnLmxvbmdpdHVkZSk7CiAgICBjZmcuaG9yaXpvbnRhbEFjY3VyYWN5ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLmhvcml6b250YWxBY2N1cmFjeSkpOwogICAgY2ZnLnZlcnRpY2FsQWNjdXJhY3kgPSBNYXRoLnRydW5jKE51bWJlcihjZmcudmVydGljYWxBY2N1cmFjeSkpOwogICAgY2ZnLmFsdGl0dWRlID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLmFsdGl0dWRlKSk7CiAgICBjZmcudW5rbm93blZhbHVlNCA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy51bmtub3duVmFsdWU0KSk7CiAgICBjZmcubW90aW9uQWN0aXZpdHlUeXBlID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLm1vdGlvbkFjdGl2aXR5VHlwZSkpOwogICAgY2ZnLm1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UpKTsKICAgIGNmZy5kdW1wUmF3ID0gY2ZnLmR1bXBSYXcgPT09IHRydWUgfHwgU3RyaW5nKGNmZy5kdW1wUmF3KS50b0xvd2VyQ2FzZSgpID09PSAidHJ1ZSI7CiAgICBjZmcuZHVtcEhlYWRlcnMgPSBjZmcuZHVtcEhlYWRlcnMgPT09IHRydWUgfHwgU3RyaW5nKGNmZy5kdW1wSGVhZGVycykudG9Mb3dlckNhc2UoKSA9PT0gInRydWUiOwogICAgY2ZnLnByZXBhcmVIZWFkZXJzID0gY2ZnLnByZXBhcmVIZWFkZXJzID09PSB0cnVlIHx8IFN0cmluZyhjZmcucHJlcGFyZUhlYWRlcnMpLnRvTG93ZXJDYXNlKCkgPT09ICJ0cnVlIjsKICAgIGNmZy5yYXdMaW1pdCA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5yYXdMaW1pdCB8fCAwKSk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmF3TGltaXQpIHx8IGNmZy5yYXdMaW1pdCA8IDApIHsKICAgICAgY2ZnLnJhd0xpbWl0ID0gMDsKICAgIH0KICAgIGNmZy5yYW5kb21SYWRpdXMgPSBOdW1iZXIoY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmFuZG9tUmFkaXVzKSB8fCBjZmcucmFuZG9tUmFkaXVzIDwgMCkgewogICAgICBjZmcucmFuZG9tUmFkaXVzID0gMDsKICAgIH0KCiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubGF0aXR1ZGUpIHx8IGNmZy5sYXRpdHVkZSA8IC05MCB8fCBjZmcubGF0aXR1ZGUgPiA5MCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgbGF0aXR1ZGUiKTsKICAgIH0KICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGNmZy5sb25naXR1ZGUpIHx8IGNmZy5sb25naXR1ZGUgPCAtMTgwIHx8IGNmZy5sb25naXR1ZGUgPiAxODApIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIGxvbmdpdHVkZSIpOwogICAgfQogICAgLy8gQXBwbHkgdGhlIHJhbmRvbSBvZmZzZXQgbGFzdCwgb25jZSBwZXIgcmVzcG9uc2UsIHNvIGV2ZXJ5IHBhdGNoZWQgV2lGaS9jZWxsCiAgICAvLyBsb2NhdGlvbiBpbiB0aGlzIHJlc3BvbnNlIHNoYXJlcyB0aGUgc2FtZSBqaXR0ZXJlZCBwb2ludC4KICAgIGlmIChjZmcucmFuZG9tUmFkaXVzID4gMCkgewogICAgICB2YXIgaml0dGVyZWQgPSBhcHBseVJhbmRvbVJhZGl1cyhjZmcubGF0aXR1ZGUsIGNmZy5sb25naXR1ZGUsIGNmZy5yYW5kb21SYWRpdXMpOwogICAgICBjZmcubGF0aXR1ZGUgPSBqaXR0ZXJlZC5sYXRpdHVkZTsKICAgICAgY2ZnLmxvbmdpdHVkZSA9IGppdHRlcmVkLmxvbmdpdHVkZTsKICAgICAgY2ZnLnJhbmRvbURpc3RhbmNlID0gaml0dGVyZWQuZGlzdGFuY2U7CiAgICB9CiAgICByZXR1cm4gY2ZnOwogIH0KCiAgLy8gUmFuZG9tIHBlcnR1cmJhdGlvbiAoWXU5MTkxIHYxLjEgIuaJsOWKqOWNiuW+hCIpOiBvZmZzZXQgdGhlIHBvaW50IGJ5IGEgcmFuZG9tIGRpc3RhbmNlLAogIC8vIHVuaWZvcm0gb3ZlciBhIGRpc2Mgb2YgdGhlIGdpdmVuIHJhZGl1cyBpbiBtZXRyZXMgKGRpc3RhbmNlID0gc3FydChyYW5kKSpSKSwgdXNpbmcgdGhlCiAgLy8gc3BoZXJpY2FsIGRlc3RpbmF0aW9uLXBvaW50IGZvcm11bGEgc28gcmVwZWF0ZWQgcG9zaXRpb25pbmcgbmV2ZXIgcmV0dXJucyBpZGVudGljYWwKICAvLyBjb29yZGluYXRlcy4gTWlycm9ycyBkaXN0L3dsb2MuanMgaW4gWXU5MTkxL3dsb2MgZXhhY3RseS4KICBmdW5jdGlvbiBhcHBseVJhbmRvbVJhZGl1cyhsYXQsIGxvbiwgcmFkaXVzTWV0ZXJzKSB7CiAgICB2YXIgciA9IE51bWJlcihyYWRpdXNNZXRlcnMpOwogICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocikgfHwgciA8PSAwKSB7CiAgICAgIHJldHVybiB7IGxhdGl0dWRlOiBsYXQsIGxvbmdpdHVkZTogbG9uLCBkaXN0YW5jZTogMCB9OwogICAgfQogICAgdmFyIGRpc3RhbmNlID0gTWF0aC5zcXJ0KE1hdGgucmFuZG9tKCkpICogcjsKICAgIHZhciBiZWFyaW5nID0gMiAqIE1hdGgucmFuZG9tKCkgKiBNYXRoLlBJOwogICAgdmFyIGFuZ3VsYXIgPSBkaXN0YW5jZSAvIDYzNzgxMzc7CiAgICB2YXIgbGF0UmFkID0gKGxhdCAqIE1hdGguUEkpIC8gMTgwOwogICAgdmFyIGxvblJhZCA9IChsb24gKiBNYXRoLlBJKSAvIDE4MDsKICAgIHZhciBuZXdMYXQgPSBNYXRoLmFzaW4oCiAgICAgIE1hdGguc2luKGxhdFJhZCkgKiBNYXRoLmNvcyhhbmd1bGFyKSArCiAgICAgICAgTWF0aC5jb3MobGF0UmFkKSAqIE1hdGguc2luKGFuZ3VsYXIpICogTWF0aC5jb3MoYmVhcmluZykKICAgICk7CiAgICB2YXIgbmV3TG9uID0KICAgICAgKChsb25SYWQgKwogICAgICAgIE1hdGguYXRhbjIoCiAgICAgICAgICBNYXRoLnNpbihiZWFyaW5nKSAqIE1hdGguc2luKGFuZ3VsYXIpICogTWF0aC5jb3MobGF0UmFkKSwKICAgICAgICAgIE1hdGguY29zKGFuZ3VsYXIpIC0gTWF0aC5zaW4obGF0UmFkKSAqIE1hdGguc2luKG5ld0xhdCkKICAgICAgICApICsKICAgICAgICAzICogTWF0aC5QSSkgJQogICAgICAgICgyICogTWF0aC5QSSkpIC0KICAgICAgTWF0aC5QSTsKICAgIHJldHVybiB7CiAgICAgIGxhdGl0dWRlOiBOdW1iZXIoKChuZXdMYXQgKiAxODApIC8gTWF0aC5QSSkudG9GaXhlZCg4KSksCiAgICAgIGxvbmdpdHVkZTogTnVtYmVyKCgobmV3TG9uICogMTgwKSAvIE1hdGguUEkpLnRvRml4ZWQoOCkpLAogICAgICBkaXN0YW5jZTogZGlzdGFuY2UKICAgIH07CiAgfQoKICBmdW5jdGlvbiBwYXRjaExvY2F0aW9uKGxvY2F0aW9uUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgcGFydHMgPSBbXTsKICAgIHZhciBmaWVsZHMgPSBsb2NhdGlvblBheWxvYWQubGVuZ3RoID8gcGFyc2VGaWVsZHMobG9jYXRpb25QYXlsb2FkKSA6IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgaWYgKCFMT0NBVElPTl9SRVBMQUNFRF9GSUVMRFNbZmllbGRzW2ldLmZpZWxkTnVtYmVyXSkgewogICAgICAgIHBhcnRzLnB1c2goZmllbGRzW2ldLnJhdyk7CiAgICAgIH0KICAgIH0KCiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxLCBjb29yZFRvSW50KGNvbmZpZy5sYXRpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDIsIGNvb3JkVG9JbnQoY29uZmlnLmxvbmdpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDMsIGNvbmZpZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDQsIGNvbmZpZy51bmtub3duVmFsdWU0KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCg1LCBjb25maWcuYWx0aXR1ZGUpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDYsIGNvbmZpZy52ZXJ0aWNhbEFjY3VyYWN5KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxMSwgY29uZmlnLm1vdGlvbkFjdGl2aXR5VHlwZSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMTIsIGNvbmZpZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaFdpZmlEZXZpY2Uod2lmaVBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKHdpZmlQYXlsb2FkKTsKICAgIHZhciBwYXJ0cyA9IFtdOwogICAgdmFyIHBhdGNoZWRMb2NhdGlvbiA9IGZhbHNlOwoKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIHZhciBmaWVsZCA9IGZpZWxkc1tpXTsKICAgICAgaWYgKGZpZWxkLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hMb2NhdGlvbihmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7CiAgICAgICAgcGF0Y2hlZExvY2F0aW9uID0gdHJ1ZTsKICAgICAgfSBlbHNlIHsKICAgICAgICBwYXJ0cy5wdXNoKGZpZWxkLnJhdyk7CiAgICAgIH0KICAgIH0KCiAgICBpZiAoIXBhdGNoZWRMb2NhdGlvbikgewogICAgICBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCgyLCBwYXRjaExvY2F0aW9uKGJ5dGVzRnJvbUFycmF5KFtdKSwgY29uZmlnKSkpOwogICAgfQoKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaENlbGxUb3dlcihjZWxsUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMoY2VsbFBheWxvYWQpOwogICAgdmFyIHBhcnRzID0gW107CiAgICB2YXIgcGF0Y2hlZExvY2F0aW9uID0gZmFsc2U7CgogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgdmFyIGZpZWxkID0gZmllbGRzW2ldOwogICAgICBpZiAoZmllbGQuZmllbGROdW1iZXIgPT09IDUgJiYgZmllbGQud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCg1LCBwYXRjaExvY2F0aW9uKGZpZWxkLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsKICAgICAgICBwYXRjaGVkTG9jYXRpb24gPSB0cnVlOwogICAgICB9IGVsc2UgewogICAgICAgIHBhcnRzLnB1c2goZmllbGQucmF3KTsKICAgICAgfQogICAgfQoKICAgIGlmICghcGF0Y2hlZExvY2F0aW9uKSB7CiAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDUsIHBhdGNoTG9jYXRpb24oYnl0ZXNGcm9tQXJyYXkoW10pLCBjb25maWcpKSk7CiAgICB9CgogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKHBhcnRzKTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoQXBwbGVXTG9jUGF5bG9hZChwYXlsb2FkLCBjb25maWcpIHsKICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKTsKICAgIHZhciBwYXJ0cyA9IFtdOwogICAgdmFyIHdpZmlDb3VudCA9IDA7CiAgICB2YXIgY2VsbENvdW50ID0gMDsKCiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIgZmllbGQgPSBmaWVsZHNbaV07CiAgICAgIGlmIChmaWVsZC5maWVsZE51bWJlciA9PT0gMiAmJiBmaWVsZC53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoV2lmaURldmljZShmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7CiAgICAgICAgd2lmaUNvdW50ICs9IDE7CiAgICAgIH0gZWxzZSBpZiAoaXNDZWxsUmVzcG9uc2VGaWVsZChmaWVsZC5maWVsZE51bWJlcikgJiYgZmllbGQud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZChmaWVsZC5maWVsZE51bWJlciwgcGF0Y2hDZWxsVG93ZXIoZmllbGQudmFsdWVCeXRlcywgY29uZmlnKSkpOwogICAgICAgIGNlbGxDb3VudCArPSAxOwogICAgICB9IGVsc2UgaWYgKCFST09UX0RST1BfRklFTERTW2ZpZWxkLmZpZWxkTnVtYmVyXSkgewogICAgICAgIHBhcnRzLnB1c2goZmllbGQucmF3KTsKICAgICAgfQogICAgfQoKICAgIHJldHVybiB7IHBheWxvYWQ6IGNvbmNhdEJ5dGVzKHBhcnRzKSwgd2lmaUNvdW50OiB3aWZpQ291bnQsIGNlbGxDb3VudDogY2VsbENvdW50IH07CiAgfQoKICBmdW5jdGlvbiByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSkgewogICAgdmFyIGxlbmd0aCA9IHJlYWRVSW50MTZCRShieXRlcywgc3RhdGUub2Zmc2V0KTsKICAgIHN0YXRlLm9mZnNldCArPSAyOwogICAgaWYgKHN0YXRlLm9mZnNldCArIGxlbmd0aCA+IGJ5dGVzLmxlbmd0aCkgewogICAgICB0aHJvdyBuZXcgRXJyb3IoIkFSUEMgcGFzY2FsIHN0cmluZyBleGNlZWRzIGJ1ZmZlciIpOwogICAgfQoKICAgIHZhciBjaGFycyA9IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkgKz0gMSkgewogICAgICBjaGFycy5wdXNoKFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbc3RhdGUub2Zmc2V0ICsgaV0pKTsKICAgIH0KICAgIHN0YXRlLm9mZnNldCArPSBsZW5ndGg7CiAgICByZXR1cm4gY2hhcnMuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVBhc2NhbFN0cmluZyh2YWx1ZSkgewogICAgdmFyIGJ5dGVzID0gYXNjaWlCeXRlcyh2YWx1ZSk7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoW3dyaXRlVUludDE2QkUoYnl0ZXMubGVuZ3RoKSwgYnl0ZXNdKTsKICB9CgogIGZ1bmN0aW9uIHBhcnNlQXJwYyhieXRlcykgewogICAgdmFyIHN0YXRlID0geyBvZmZzZXQ6IDAgfTsKICAgIHZhciB2ZXJzaW9uID0gcmVhZFVJbnQxNkJFKGJ5dGVzLCBzdGF0ZS5vZmZzZXQpOwogICAgc3RhdGUub2Zmc2V0ICs9IDI7CiAgICB2YXIgbG9jYWxlID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGFwcElkZW50aWZpZXIgPSByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSk7CiAgICB2YXIgb3NWZXJzaW9uID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGZ1bmN0aW9uSWQgPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7CiAgICBzdGF0ZS5vZmZzZXQgKz0gNDsKICAgIHZhciBwYXlsb2FkTGVuZ3RoID0gcmVhZFVJbnQzMkJFKGJ5dGVzLCBzdGF0ZS5vZmZzZXQpOwogICAgc3RhdGUub2Zmc2V0ICs9IDQ7CgogICAgaWYgKHN0YXRlLm9mZnNldCArIHBheWxvYWRMZW5ndGggPiBieXRlcy5sZW5ndGgpIHsKICAgICAgdGhyb3cgbmV3IEVycm9yKCJBUlBDIHBheWxvYWQgZXhjZWVkcyBidWZmZXIiKTsKICAgIH0KCiAgICByZXR1cm4gewogICAgICB2ZXJzaW9uOiB2ZXJzaW9uLAogICAgICBsb2NhbGU6IGxvY2FsZSwKICAgICAgYXBwSWRlbnRpZmllcjogYXBwSWRlbnRpZmllciwKICAgICAgb3NWZXJzaW9uOiBvc1ZlcnNpb24sCiAgICAgIGZ1bmN0aW9uSWQ6IGZ1bmN0aW9uSWQsCiAgICAgIHBheWxvYWQ6IGJ5dGVzLnNsaWNlKHN0YXRlLm9mZnNldCwgc3RhdGUub2Zmc2V0ICsgcGF5bG9hZExlbmd0aCkKICAgIH07CiAgfQoKICBmdW5jdGlvbiBzZXJpYWxpemVBcnBjKGFycGMpIHsKICAgIHJldHVybiBjb25jYXRCeXRlcyhbCiAgICAgIHdyaXRlVUludDE2QkUoYXJwYy52ZXJzaW9uKSwKICAgICAgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5sb2NhbGUpLAogICAgICB3cml0ZVBhc2NhbFN0cmluZyhhcnBjLmFwcElkZW50aWZpZXIpLAogICAgICB3cml0ZVBhc2NhbFN0cmluZyhhcnBjLm9zVmVyc2lvbiksCiAgICAgIHdyaXRlVUludDMyQkUoYXJwYy5mdW5jdGlvbklkKSwKICAgICAgd3JpdGVVSW50MzJCRShhcnBjLnBheWxvYWQubGVuZ3RoKSwKICAgICAgYXJwYy5wYXlsb2FkCiAgICBdKTsKICB9CgogIGZ1bmN0aW9uIGJ1aWxkQXBwbGVXTG9jUmVzcG9uc2UocGF5bG9hZCwgcHJlZml4KSB7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoW3ByZWZpeCB8fCBBUFBMRV9XTE9DX1BSRUZJWCwgd3JpdGVVSW50MTZCRShwYXlsb2FkLmxlbmd0aCksIHBheWxvYWRdKTsKICB9CgogIGZ1bmN0aW9uIGV4dHJhY3RQcmVmaXhlZEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcykgewogICAgaWYgKCFyZXNwb25zZUJ5dGVzIHx8IHJlc3BvbnNlQnl0ZXMubGVuZ3RoIDwgMTApIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgICBpZiAocmVzcG9uc2VCeXRlc1swXSAhPT0gMHgwMCB8fCByZXNwb25zZUJ5dGVzWzFdICE9PSAweDAxKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgaWYgKHJlc3BvbnNlQnl0ZXNbNl0gIT09IDB4MDAgfHwgcmVzcG9uc2VCeXRlc1s3XSAhPT0gMHgwMCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KCiAgICB2YXIgcGF5bG9hZExlbmd0aCA9IHJlYWRVSW50MTZCRShyZXNwb25zZUJ5dGVzLCA4KTsKICAgIHZhciBwYXlsb2FkT2Zmc2V0ID0gMTA7CiAgICBpZiAocGF5bG9hZExlbmd0aCA8PSAwIHx8IHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoID4gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CgogICAgdmFyIHBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHBheWxvYWRPZmZzZXQsIHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoKTsKICAgIGlmICh0cnlQYXJzZUZpZWxkcyhwYXlsb2FkKSA9PT0gbnVsbCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KCiAgICByZXR1cm4gewogICAgICBraW5kOiAic3ludGhldGljIiwKICAgICAgcGF5bG9hZDogcGF5bG9hZCwKICAgICAgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIDgpLAogICAgICBzdWZmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UocGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGgpCiAgICB9OwogIH0KCiAgLy8gRXh0cmFjdCB0aGUgQXBwbGVXTG9jIHByb3RvYnVmIHBheWxvYWQgZnJvbSBhIC9jbGxzL3dsb2MgcmVzcG9uc2UgYm9keS4KICAvLyBSZXR1cm5zIGEgdHlwZWQgcmVzdWx0OiB7IGtpbmQsIHBheWxvYWQsIC4uLiB9IHNvIHRoZSBjYWxsZXIgY2FuIHdyaXRlIGJhY2sKICAvLyBpbiB0aGUgY29ycmVjdCBmb3JtYXQuCiAgLy8KICAvLyBTdXBwb3J0ZWQgc2hhcGVzOgogIC8vICAgImFycGMiICAgICAg4oCTIEZ1bGwgQVJQQyBlbnZlbG9wZSAoc2FtZSBmb3JtYXQgYXMgcmVxdWVzdHMpLiBUaGUgcmVhbCBBcHBsZQogIC8vICAgICAgICAgICAgICAgICByZXNwb25zZSB1c2VzIHRoaXMuIENvbnRhaW5zIGFycGMgbWV0YWRhdGEgZm9yIHdyaXRlLWJhY2suCiAgLy8gICAic3ludGhldGljIiDigJMgT3VyIG93biBzcG9vZmVkIHJlc3BvbnNlOiBBUFBMRV9XTE9DX1BSRUZJWCAoOCBieXRlcykgKyB1aW50MTYgbGVuLgogIC8vICAgIm1hcmtlciIgICAg4oCTIEZhbGxiYWNrOiBtYXJrZXIgc2VhcmNoIDAwIDAwIDAwIDAxIDAwIDAwICsgdWludDE2IGxlbi4KICAvLyAgICAgICAgICAgICAgICAgS2VlcHMgdGhlIHByZWZpeC9zdWZmaXggYnl0ZXMgZm9yIHdyaXRlLWJhY2suCiAgLy8gICAiYmFyZSIgICAgICDigJMgQmFyZSBwcm90b2J1ZiBwYXlsb2FkIChmaWVsZCB0YWcgMHgxMiA9IHdpZmkgZGV2aWNlLCB3aXJlIHR5cGUgMikuCiAgZnVuY3Rpb24gZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcykgewogICAgaWYgKCFyZXNwb25zZUJ5dGVzIHx8IHJlc3BvbnNlQnl0ZXMubGVuZ3RoIDwgMikgewogICAgICB0aHJvdyBuZXcgRXJyb3IoIkFwcGxlIFdMb2MgcmVzcG9uc2UgdG9vIHNob3J0Iik7CiAgICB9CgogICAgLy8gU2hhcGUgMTogcHJlZml4ZWQgV0xvYyByZXNwb25zZS4gVGhlIG9yaWdpbmFsIEdvIGltcGxlbWVudGF0aW9uIGVtaXRzCiAgICAvLyAwMDAxMDAwMDAwMDEwMDAwLCB3aGlsZSBBcHBsZSdzIGxpdmUgcmVzcG9uc2VzIG1heSB1c2UgMDAwMTAwMDAwMDAzMDAwMC4KICAgIHZhciBwcmVmaXhlZCA9IGV4dHJhY3RQcmVmaXhlZEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcyk7CiAgICBpZiAocHJlZml4ZWQpIHsKICAgICAgcmV0dXJuIHByZWZpeGVkOwogICAgfQoKICAgIC8vIFNoYXBlIDI6IEFSUEMgZW52ZWxvcGUg4oCTIHRyeSB0aGUgcHJvcGVyIHN0cnVjdHVyZWQgcGFyc2VyIGZpcnN0LgogICAgLy8gVGhlIEFwcGxlIC9jbGxzL3dsb2MgcmVzcG9uc2UgdXNlcyB0aGUgc2FtZSBBUlBDIGZyYW1pbmcgYXMgdGhlIHJlcXVlc3QuCiAgICB0cnkgewogICAgICB2YXIgYXJwYyA9IHBhcnNlQXJwYyhyZXNwb25zZUJ5dGVzKTsKICAgICAgaWYgKGFycGMucGF5bG9hZC5sZW5ndGggPiAwICYmIHRyeVBhcnNlRmllbGRzKGFycGMucGF5bG9hZCkgIT09IG51bGwpIHsKICAgICAgICByZXR1cm4gewogICAgICAgICAga2luZDogImFycGMiLAogICAgICAgICAgcGF5bG9hZDogYXJwYy5wYXlsb2FkLAogICAgICAgICAgYXJwYzogYXJwYwogICAgICAgIH07CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgLy8gQVJQQyBwYXJzZSBmYWlsZWQg4oCTIGNvbnRpbnVlIHdpdGggZmFsbGJhY2sgc3RyYXRlZ2llcy4KICAgIH0KCiAgICAvLyBTaGFwZSAzOiBtYXJrZXIgc2VhcmNoIGZhbGxiYWNrLiBUaGUgQVJQQyBmdW5jdGlvbklkICgwMCAwMCAwMCAwMSkgbWF5IGJlCiAgICAvLyBmb2xsb3dlZCBieSB1aW50MTYvdWludDMyIHBheWxvYWQgbGVuZ3RoLiBUcnkgdG8gZmluZCBhbmQgdmFsaWRhdGUuCiAgICB2YXIgbWFya2VySWR4ID0gZmluZEJ5dGVzKHJlc3BvbnNlQnl0ZXMsIEFQUExFX1dMT0NfTUFSS0VSKTsKICAgIGlmIChtYXJrZXJJZHggPj0gMCkgewogICAgICB2YXIgbGVuT2Zmc2V0ID0gbWFya2VySWR4ICsgQVBQTEVfV0xPQ19NQVJLRVIubGVuZ3RoOwogICAgICBpZiAobGVuT2Zmc2V0ICsgMiA8PSByZXNwb25zZUJ5dGVzLmxlbmd0aCkgewogICAgICAgIHZhciByZWFsTGVuID0gcmVhZFVJbnQxNkJFKHJlc3BvbnNlQnl0ZXMsIGxlbk9mZnNldCk7CiAgICAgICAgdmFyIHJlYWxQYXlsb2FkT2Zmc2V0ID0gbGVuT2Zmc2V0ICsgMjsKICAgICAgICBpZiAocmVhbExlbiA+IDAgJiYgcmVhbFBheWxvYWRPZmZzZXQgKyByZWFsTGVuIDw9IHJlc3BvbnNlQnl0ZXMubGVuZ3RoKSB7CiAgICAgICAgICB2YXIgY2FuZGlkYXRlUGF5bG9hZCA9IHJlc3BvbnNlQnl0ZXMuc2xpY2UocmVhbFBheWxvYWRPZmZzZXQsIHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbik7CiAgICAgICAgICAvLyBPbmx5IGFjY2VwdCBpZiB0aGUgY2FuZGlkYXRlIHBhcnNlcyBhcyB2YWxpZCBwcm90b2J1Zi4KICAgICAgICAgIGlmICh0cnlQYXJzZUZpZWxkcyhjYW5kaWRhdGVQYXlsb2FkKSAhPT0gbnVsbCkgewogICAgICAgICAgICByZXR1cm4gewogICAgICAgICAgICAgIGtpbmQ6ICJtYXJrZXIiLAogICAgICAgICAgICAgIHBheWxvYWQ6IGNhbmRpZGF0ZVBheWxvYWQsCiAgICAgICAgICAgICAgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIG1hcmtlcklkeCksCiAgICAgICAgICAgICAgbWFya2VyQW5kTGVuOiByZXNwb25zZUJ5dGVzLnNsaWNlKG1hcmtlcklkeCwgcmVhbFBheWxvYWRPZmZzZXQpLAogICAgICAgICAgICAgIHN1ZmZpeDogcmVzcG9uc2VCeXRlcy5zbGljZShyZWFsUGF5bG9hZE9mZnNldCArIHJlYWxMZW4pCiAgICAgICAgICAgIH07CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9CiAgICB9CgogICAgLy8gU2hhcGUgNDogYmFyZSBwcm90b2J1ZiBwYXlsb2FkIChiZXN0IGVmZm9ydCkuCiAgICBpZiAobG9va3NMaWtlQXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKSkgewogICAgICByZXR1cm4gewogICAgICAgIGtpbmQ6ICJiYXJlIiwKICAgICAgICBwYXlsb2FkOiByZXNwb25zZUJ5dGVzCiAgICAgIH07CiAgICB9CgogICAgdGhyb3cgbmV3IEVycm9yKCJtaXNzaW5nIEFwcGxlIFdMb2MgcmVzcG9uc2UgcHJlZml4Iik7CiAgfQoKICAvLyBIZXVyaXN0aWM6IGEgdmFsaWQgQXBwbGVXTG9jIHBheWxvYWQgc3RhcnRzIHdpdGggYSBwcm90b2J1ZiB0YWcgd2hvc2Ugd2lyZSB0eXBlCiAgLy8gaXMgMCBvciAyIGFuZCBmaWVsZCBudW1iZXIgaXMgPiAwLiBGaWVsZCAyICh3aWZpKSB0YWcgaXMgMHgxMi4KICBmdW5jdGlvbiBsb29rc0xpa2VBcHBsZVdMb2NQYXlsb2FkKGJ5dGVzKSB7CiAgICBpZiAoIWJ5dGVzIHx8IGJ5dGVzLmxlbmd0aCA9PT0gMCkgewogICAgICByZXR1cm4gZmFsc2U7CiAgICB9CiAgICB2YXIgdGFnID0gYnl0ZXNbMF07CiAgICB2YXIgZmllbGROdW1iZXIgPSB0YWcgPj4gMzsKICAgIHZhciB3aXJlVHlwZSA9IHRhZyAmIDB4NzsKICAgIHJldHVybiBmaWVsZE51bWJlciA+IDAgJiYgKHdpcmVUeXBlID09PSAwIHx8IHdpcmVUeXBlID09PSAyKTsKICB9CgogIGZ1bmN0aW9uIHNwb29mQXJwY1JlcXVlc3QocmVxdWVzdEJ5dGVzLCBjb25maWdJbnB1dCkgewogICAgdmFyIGNvbmZpZyA9IG5vcm1hbGl6ZUNvbmZpZyhjb25maWdJbnB1dCk7CiAgICB2YXIgYXJwYyA9IHBhcnNlQXJwYyhyZXF1ZXN0Qnl0ZXMpOwogICAgdmFyIHBhdGNoZWQgPSBwYXRjaEFwcGxlV0xvY1BheWxvYWQoYXJwYy5wYXlsb2FkLCBjb25maWcpOwogICAgcmV0dXJuIHsKICAgICAgcmVzcG9uc2U6IGJ1aWxkQXBwbGVXTG9jUmVzcG9uc2UocGF0Y2hlZC5wYXlsb2FkKSwKICAgICAgcGF5bG9hZDogcGF0Y2hlZC5wYXlsb2FkLAogICAgICB3aWZpQ291bnQ6IHBhdGNoZWQud2lmaUNvdW50LAogICAgICBjZWxsQ291bnQ6IHBhdGNoZWQuY2VsbENvdW50LAogICAgICBhcnBjOiBhcnBjCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gc3Bvb2ZBcHBsZVJlc3BvbnNlKHJlc3BvbnNlQnl0ZXMsIGNvbmZpZ0lucHV0KSB7CiAgICB2YXIgY29uZmlnID0gbm9ybWFsaXplQ29uZmlnKGNvbmZpZ0lucHV0KTsKICAgIHZhciBleHRyYWN0aW9uID0gZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcyk7CiAgICB2YXIgcGF0Y2hlZCA9IHBhdGNoQXBwbGVXTG9jUGF5bG9hZChleHRyYWN0aW9uLnBheWxvYWQsIGNvbmZpZyk7CiAgICB2YXIgcmVzcG9uc2U7CgogICAgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gImFycGMiKSB7CiAgICAgIC8vIFdyaXRlIGJhY2sgaW4gQVJQQyBmb3JtYXQsIHByZXNlcnZpbmcgdGhlIG9yaWdpbmFsIGVudmVsb3BlIG1ldGFkYXRhLgogICAgICB2YXIgYXJwY091dCA9IHsKICAgICAgICB2ZXJzaW9uOiBleHRyYWN0aW9uLmFycGMudmVyc2lvbiwKICAgICAgICBsb2NhbGU6IGV4dHJhY3Rpb24uYXJwYy5sb2NhbGUsCiAgICAgICAgYXBwSWRlbnRpZmllcjogZXh0cmFjdGlvbi5hcnBjLmFwcElkZW50aWZpZXIsCiAgICAgICAgb3NWZXJzaW9uOiBleHRyYWN0aW9uLmFycGMub3NWZXJzaW9uLAogICAgICAgIGZ1bmN0aW9uSWQ6IGV4dHJhY3Rpb24uYXJwYy5mdW5jdGlvbklkLAogICAgICAgIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZAogICAgICB9OwogICAgICByZXNwb25zZSA9IHNlcmlhbGl6ZUFycGMoYXJwY091dCk7CiAgICB9IGVsc2UgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gIm1hcmtlciIpIHsKICAgICAgLy8gUmVidWlsZDogb3JpZ2luYWwgcHJlZml4ICsgbWFya2VyIGJ5dGVzICsgbmV3IHVpbnQxNiBsZW4gKyBwYXRjaGVkIHBheWxvYWQgKyBzdWZmaXguCiAgICAgIHZhciBuZXdMZW5CeXRlcyA9IHdyaXRlVUludDE2QkUocGF0Y2hlZC5wYXlsb2FkLmxlbmd0aCk7CiAgICAgIHJlc3BvbnNlID0gY29uY2F0Qnl0ZXMoWwogICAgICAgIGV4dHJhY3Rpb24ucHJlZml4LAogICAgICAgIGV4dHJhY3Rpb24ubWFya2VyQW5kTGVuLnNsaWNlKDAsIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aCksCiAgICAgICAgbmV3TGVuQnl0ZXMsCiAgICAgICAgcGF0Y2hlZC5wYXlsb2FkLAogICAgICAgIGV4dHJhY3Rpb24uc3VmZml4CiAgICAgIF0pOwogICAgfSBlbHNlIHsKICAgICAgLy8gc3ludGhldGljIC8gYmFyZSDigJMgdXNlIHRoZSBzaW1wbGUgcHJlZml4IGZvcm1hdC4KICAgICAgcmVzcG9uc2UgPSBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlKHBhdGNoZWQucGF5bG9hZCwgZXh0cmFjdGlvbi5wcmVmaXgpOwogICAgfQoKICAgIHJldHVybiB7CiAgICAgIHJlc3BvbnNlOiByZXNwb25zZSwKICAgICAgcGF5bG9hZDogcGF0Y2hlZC5wYXlsb2FkLAogICAgICB3aWZpQ291bnQ6IHBhdGNoZWQud2lmaUNvdW50LAogICAgICBjZWxsQ291bnQ6IHBhdGNoZWQuY2VsbENvdW50LAogICAgICBraW5kOiBleHRyYWN0aW9uLmtpbmQsCiAgICAgIHByZWZpeDogZXh0cmFjdGlvbi5wcmVmaXggPyBoZXhQcmV2aWV3KGV4dHJhY3Rpb24ucHJlZml4LCA4KSA6ICIiCiAgICB9OwogIH0KCiAgZnVuY3Rpb24gcGFyc2VBcmd1bWVudFN0cmluZyhhcmd1bWVudCkgewogICAgdmFyIHJlc3VsdCA9IHt9OwogICAgaWYgKCFhcmd1bWVudCB8fCB0eXBlb2YgYXJndW1lbnQgIT09ICJzdHJpbmciKSB7CiAgICAgIHJldHVybiByZXN1bHQ7CiAgICB9CgogICAgdmFyIHRhaWxLZXlzID0gWwogICAgICAiZGVidWciLAogICAgICAibW9kZSIsCiAgICAgICJlbmFibGVkIiwKICAgICAgImxhdGl0dWRlIiwKICAgICAgImxvbmdpdHVkZSIsCiAgICAgICJhbHRpdHVkZSIsCiAgICAgICJhZGRyZXNzIiwKICAgICAgImNvbmZpZ0hvc3QiLAogICAgICAiY29uZmlnVG9rZW4iLAogICAgICAiaG9yaXpvbnRhbEFjY3VyYWN5IiwKICAgICAgInZlcnRpY2FsQWNjdXJhY3kiLAogICAgICAicmFuZG9tUmFkaXVzIiwKICAgICAgInVua25vd25WYWx1ZTQiLAogICAgICAibW90aW9uQWN0aXZpdHlUeXBlIiwKICAgICAgIm1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZSIsCiAgICAgICJmYWlsT3BlbiIsCiAgICAgICJkdW1wUmF3IiwKICAgICAgImR1bXBIZWFkZXJzIiwKICAgICAgInByZXBhcmVIZWFkZXJzIiwKICAgICAgInJhd0xpbWl0IgogICAgXTsKICAgIHZhciBjb25maWdVcmxLZXkgPSAiY29uZmlnVXJsPSI7CiAgICB2YXIgY29uZmlnVXJsSWR4ID0gYXJndW1lbnQuaW5kZXhPZihjb25maWdVcmxLZXkpOwogICAgaWYgKGNvbmZpZ1VybElkeCA+PSAwKSB7CiAgICAgIHZhciB2YWx1ZVN0YXJ0ID0gY29uZmlnVXJsSWR4ICsgY29uZmlnVXJsS2V5Lmxlbmd0aDsKICAgICAgdmFyIHRhaWwgPSBhcmd1bWVudC5zbGljZSh2YWx1ZVN0YXJ0KTsKICAgICAgdmFyIGVuZCA9IC0xOwogICAgICB2YXIgaTsKICAgICAgZm9yIChpID0gMDsgaSA8IHRhaWxLZXlzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgICAgdmFyIG1hcmtlciA9ICImIiArIHRhaWxLZXlzW2ldICsgIj0iOwogICAgICAgIHZhciBwb3MgPSB0YWlsLmluZGV4T2YobWFya2VyKTsKICAgICAgICBpZiAocG9zID49IDAgJiYgKGVuZCA8IDAgfHwgcG9zIDwgZW5kKSkgewogICAgICAgICAgZW5kID0gcG9zOwogICAgICAgIH0KICAgICAgfQogICAgICB2YXIgY29uZmlnVXJsVmFsdWUgPSBlbmQgPj0gMCA/IHRhaWwuc2xpY2UoMCwgZW5kKSA6IHRhaWw7CiAgICAgIHRyeSB7CiAgICAgICAgcmVzdWx0LmNvbmZpZ1VybCA9IGRlY29kZVVSSUNvbXBvbmVudChjb25maWdVcmxWYWx1ZSk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIHJlc3VsdC5jb25maWdVcmwgPSBjb25maWdVcmxWYWx1ZTsKICAgICAgfQogICAgICBhcmd1bWVudCA9IGFyZ3VtZW50LnNsaWNlKDAsIGNvbmZpZ1VybElkeCkgKyAoZW5kID49IDAgPyB0YWlsLnNsaWNlKGVuZCArIDEpIDogIiIpOwogICAgfQoKICAgIHZhciBwYWlycyA9IGFyZ3VtZW50LnNwbGl0KC9bJjtdLyk7CiAgICBmb3IgKHZhciBqID0gMDsgaiA8IHBhaXJzLmxlbmd0aDsgaiArPSAxKSB7CiAgICAgIHZhciBwYXJ0ID0gcGFpcnNbal07CiAgICAgIGlmICghcGFydCkgewogICAgICAgIGNvbnRpbnVlOwogICAgICB9CiAgICAgIHZhciBlcSA9IHBhcnQuaW5kZXhPZigiPSIpOwogICAgICB2YXIga2V5ID0gZXEgPj0gMCA/IHBhcnQuc2xpY2UoMCwgZXEpIDogcGFydDsKICAgICAgdmFyIHZhbHVlID0gZXEgPj0gMCA/IHBhcnQuc2xpY2UoZXEgKyAxKSA6ICJ0cnVlIjsKICAgICAgdHJ5IHsKICAgICAgICByZXN1bHRbZGVjb2RlVVJJQ29tcG9uZW50KGtleSldID0gZGVjb2RlVVJJQ29tcG9uZW50KHZhbHVlKTsKICAgICAgfSBjYXRjaCAoZXJyMikgewogICAgICAgIHJlc3VsdFtrZXldID0gdmFsdWU7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiByZXN1bHQ7CiAgfQoKICBmdW5jdGlvbiByZXNvbHZlQ29uZmlnVXJsKGFyZ3MpIHsKICAgIGFyZ3MgPSBhcmdzIHx8IHt9OwogICAgdmFyIGRpcmVjdCA9IFN0cmluZyhhcmdzLmNvbmZpZ1VybCB8fCBhcmdzLmNmZyB8fCBhcmdzLnVybCB8fCAiIikudHJpbSgpOwogICAgaWYgKGRpcmVjdCkgewogICAgICByZXR1cm4gZGlyZWN0OwogICAgfQogICAgdmFyIGhvc3QgPSBTdHJpbmcoYXJncy5jb25maWdIb3N0IHx8ICIiKS50cmltKCkucmVwbGFjZSgvXC8rJC8sICIiKTsKICAgIHZhciB0b2tlbiA9IFN0cmluZyhhcmdzLmNvbmZpZ1Rva2VuIHx8ICIiKS50cmltKCk7CiAgICBpZiAoaG9zdCAmJiB0b2tlbikgewogICAgICByZXR1cm4gaG9zdCArICIvbG9jLmpzb24/dG9rZW49IiArIGVuY29kZVVSSUNvbXBvbmVudCh0b2tlbik7CiAgICB9CiAgICByZXR1cm4gIiI7CiAgfQoKICBmdW5jdGlvbiBpc1BsYWNlaG9sZGVyVmFsdWUodmFsdWUpIHsKICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICJzdHJpbmciICYmIC9eXHtbXn1dK1x9JC8udGVzdCh2YWx1ZS50cmltKCkpOwogIH0KCiAgZnVuY3Rpb24gcmVhZFBsdWdpblN0b3JlQXJnKG5hbWUpIHsKICAgIGlmICh0eXBlb2YgJHBlcnNpc3RlbnRTdG9yZSA9PT0gInVuZGVmaW5lZCIgfHwgISRwZXJzaXN0ZW50U3RvcmUucmVhZCkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIHRyeSB7CiAgICAgIHZhciB2YWx1ZSA9ICRwZXJzaXN0ZW50U3RvcmUucmVhZChuYW1lKTsKICAgICAgaWYgKHZhbHVlID09IG51bGwgfHwgdmFsdWUgPT09ICIiKSB7CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICAgIH0KICAgICAgcmV0dXJuIFN0cmluZyh2YWx1ZSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBlbnJpY2hBcmdzRnJvbVBsdWdpblN0b3JlKGFyZ3MpIHsKICAgIHZhciBrZXlzID0gWwogICAgICAiZW5hYmxlZCIsCiAgICAgICJsYXRpdHVkZSIsCiAgICAgICJsb25naXR1ZGUiLAogICAgICAiYWx0aXR1ZGUiLAogICAgICAiaG9yaXpvbnRhbEFjY3VyYWN5IiwKICAgICAgInZlcnRpY2FsQWNjdXJhY3kiLAogICAgICAicmFuZG9tUmFkaXVzIiwKICAgICAgImFkZHJlc3MiLAogICAgICAiY29uZmlnSG9zdCIsCiAgICAgICJjb25maWdUb2tlbiIsCiAgICAgICJjb25maWdVcmwiLAogICAgICAiZGVidWciCiAgICBdOwogICAgdmFyIGk7CiAgICBhcmdzID0gYXJncyB8fCB7fTsKICAgIGZvciAoaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIHZhciBrZXkgPSBrZXlzW2ldOwogICAgICB2YXIgY3VycmVudCA9IGFyZ3Nba2V5XTsKICAgICAgaWYgKGN1cnJlbnQgPT0gbnVsbCB8fCBjdXJyZW50ID09PSAiIiB8fCBpc1BsYWNlaG9sZGVyVmFsdWUoY3VycmVudCkpIHsKICAgICAgICB2YXIgc3RvcmVkID0gcmVhZFBsdWdpblN0b3JlQXJnKGtleSk7CiAgICAgICAgaWYgKHN0b3JlZCAhPSBudWxsICYmICFpc1BsYWNlaG9sZGVyVmFsdWUoc3RvcmVkKSkgewogICAgICAgICAgYXJnc1trZXldID0gc3RvcmVkOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgcmV0dXJuIGFyZ3M7CiAgfQoKICBmdW5jdGlvbiByZWFkU2NyaXB0QXJndW1lbnRzKCkgewogICAgdmFyIG91dCA9IHt9OwogICAgaWYgKHR5cGVvZiAkYXJndW1lbnQgIT09ICJ1bmRlZmluZWQiICYmICRhcmd1bWVudCAhPSBudWxsKSB7CiAgICAgIGlmICh0eXBlb2YgJGFyZ3VtZW50ID09PSAic3RyaW5nIikgewogICAgICAgIG91dCA9IHBhcnNlQXJndW1lbnRTdHJpbmcoJGFyZ3VtZW50KTsKICAgICAgfSBlbHNlIGlmICh0eXBlb2YgJGFyZ3VtZW50ID09PSAib2JqZWN0IikgewogICAgICAgIHZhciBrZXk7CiAgICAgICAgZm9yIChrZXkgaW4gJGFyZ3VtZW50KSB7CiAgICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKCRhcmd1bWVudCwga2V5KSkgewogICAgICAgICAgICB2YXIgdmFsdWUgPSAkYXJndW1lbnRba2V5XTsKICAgICAgICAgICAgb3V0W2tleV0gPSB2YWx1ZSA9PSBudWxsID8gIiIgOiBTdHJpbmcodmFsdWUpOwogICAgICAgICAgfQogICAgICAgIH0KICAgICAgfSBlbHNlIHsKICAgICAgICBvdXQgPSBwYXJzZUFyZ3VtZW50U3RyaW5nKFN0cmluZygkYXJndW1lbnQpKTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIGVucmljaEFyZ3NGcm9tUGx1Z2luU3RvcmUob3V0KTsKICB9CgogIGZ1bmN0aW9uIGxvZ1NjcmlwdEFyZ3VtZW50cyhkZWJ1ZykgewogICAgaWYgKCFkZWJ1ZykgewogICAgICByZXR1cm47CiAgICB9CiAgICB2YXIgYXJncyA9IHJlYWRTY3JpcHRBcmd1bWVudHMoKTsKICAgIHZhciByYXcgPQogICAgICB0eXBlb2YgJGFyZ3VtZW50ID09PSAidW5kZWZpbmVkIiB8fCAkYXJndW1lbnQgPT0gbnVsbAogICAgICAgID8gIjxub25lPiIKICAgICAgICA6IHR5cGVvZiAkYXJndW1lbnQgPT09ICJvYmplY3QiCiAgICAgICAgICA/IEpTT04uc3RyaW5naWZ5KCRhcmd1bWVudCkKICAgICAgICAgIDogU3RyaW5nKCRhcmd1bWVudCk7CiAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciAkYXJndW1lbnQgcmF3OiAiICsgcmF3KTsKICAgIGNvbnNvbGUubG9nKAogICAgICAiTG9jYXRpb24gc3Bvb2ZlciBhcmdzIHBhcnNlZDogbGF0PSIgKwogICAgICAgIGFyZ3MubGF0aXR1ZGUgKwogICAgICAgICIsIGxuZz0iICsKICAgICAgICBhcmdzLmxvbmdpdHVkZSArCiAgICAgICAgIiwgY29uZmlnVXJsPSIgKwogICAgICAgIChyZXNvbHZlQ29uZmlnVXJsKGFyZ3MpIHx8ICI8bm9uZT4iKQogICAgKTsKICB9CgogIGZ1bmN0aW9uIGRldGVjdFJ1bnRpbWUoKSB7CiAgICBpZiAodHlwZW9mICRlbnZpcm9ubWVudCAhPT0gInVuZGVmaW5lZCIgJiYgJGVudmlyb25tZW50ICYmICRlbnZpcm9ubWVudC5wcm9kdWN0KSB7CiAgICAgIHJldHVybiBTdHJpbmcoJGVudmlyb25tZW50LnByb2R1Y3QpOwogICAgfQogICAgaWYgKHR5cGVvZiAkbG9vbiAhPT0gInVuZGVmaW5lZCIpIHsKICAgICAgcmV0dXJuICJMb29uIjsKICAgIH0KICAgIHJldHVybiAiVW5rbm93biI7CiAgfQoKICBmdW5jdGlvbiBpc0xvb25SdW50aW1lKCkgewogICAgcmV0dXJuIGRldGVjdFJ1bnRpbWUoKSA9PT0gIkxvb24iOwogIH0KCiAgZnVuY3Rpb24gaXNHemlwQnl0ZXMoYnl0ZXMpIHsKICAgIHJldHVybiBieXRlcyAmJiBieXRlcy5sZW5ndGggPj0gMiAmJiBieXRlc1swXSA9PT0gMHgxZiAmJiBieXRlc1sxXSA9PT0gMHg4YjsKICB9CgogIGZ1bmN0aW9uIHJlYWRHZW9jb2RlQ2FjaGUoKSB7CiAgICBpZiAodHlwZW9mICRwZXJzaXN0ZW50U3RvcmUgPT09ICJ1bmRlZmluZWQiIHx8ICEkcGVyc2lzdGVudFN0b3JlLnJlYWQpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgICB0cnkgewogICAgICB2YXIgcmF3ID0gJHBlcnNpc3RlbnRTdG9yZS5yZWFkKCJsb2NhdGlvbl9zcG9vZmVyX2dlb2NvZGUiKTsKICAgICAgcmV0dXJuIHJhdyA/IEpTT04ucGFyc2UocmF3KSA6IG51bGw7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgcmV0dXJuIG51bGw7CiAgICB9CiAgfQoKICBmdW5jdGlvbiB3cml0ZUdlb2NvZGVDYWNoZShlbnRyeSkgewogICAgaWYgKHR5cGVvZiAkcGVyc2lzdGVudFN0b3JlID09PSAidW5kZWZpbmVkIiB8fCAhJHBlcnNpc3RlbnRTdG9yZS53cml0ZSkgewogICAgICByZXR1cm47CiAgICB9CiAgICB0cnkgewogICAgICAkcGVyc2lzdGVudFN0b3JlLndyaXRlKCJsb2NhdGlvbl9zcG9vZmVyX2dlb2NvZGUiLCBKU09OLnN0cmluZ2lmeShlbnRyeSkpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIC8vIGlnbm9yZSBjYWNoZSB3cml0ZSBmYWlsdXJlcwogICAgfQogIH0KCiAgZnVuY3Rpb24gZmV0Y2hFbGV2YXRpb24obGF0LCBsbmcsIGNhbGxiYWNrKSB7CiAgICBpZiAodHlwZW9mICRodHRwQ2xpZW50ID09PSAidW5kZWZpbmVkIiB8fCAhJGh0dHBDbGllbnQuZ2V0KSB7CiAgICAgIGNhbGxiYWNrKG51bGwpOwogICAgICByZXR1cm47CiAgICB9CiAgICB2YXIgdXJsID0KICAgICAgImh0dHBzOi8vYXBpLm9wZW4tbWV0ZW8uY29tL3YxL2VsZXZhdGlvbj9sYXRpdHVkZT0iICsKICAgICAgZW5jb2RlVVJJQ29tcG9uZW50KFN0cmluZyhsYXQpKSArCiAgICAgICImbG9uZ2l0dWRlPSIgKwogICAgICBlbmNvZGVVUklDb21wb25lbnQoU3RyaW5nKGxuZykpOwogICAgJGh0dHBDbGllbnQuZ2V0KHsgdXJsOiB1cmwsIHRpbWVvdXQ6IDQwMDAgfSwgZnVuY3Rpb24gKGVycm9yLCByZXNwb25zZSwgYm9keSkgewogICAgICBpZiAoZXJyb3IgfHwgIWJvZHkpIHsKICAgICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgdHJ5IHsKICAgICAgICB2YXIgZGF0YSA9IEpTT04ucGFyc2UoYm9keSk7CiAgICAgICAgaWYgKGRhdGEgJiYgZGF0YS5lbGV2YXRpb24gJiYgZGF0YS5lbGV2YXRpb24ubGVuZ3RoKSB7CiAgICAgICAgICBjYWxsYmFjayhNYXRoLnJvdW5kKE51bWJlcihkYXRhLmVsZXZhdGlvblswXSkpKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIC8vIGlnbm9yZSBwYXJzZSBmYWlsdXJlcwogICAgICB9CiAgICAgIGNhbGxiYWNrKG51bGwpOwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBnZW9jb2RlQWRkcmVzcyhhZGRyZXNzLCBkZWJ1ZywgY2FsbGJhY2spIHsKICAgIHZhciBxdWVyeSA9IFN0cmluZyhhZGRyZXNzIHx8ICIiKS50cmltKCk7CiAgICBpZiAoIXF1ZXJ5KSB7CiAgICAgIGNhbGxiYWNrKG51bGwpOwogICAgICByZXR1cm47CiAgICB9CgogICAgdmFyIGNhY2hlZCA9IHJlYWRHZW9jb2RlQ2FjaGUoKTsKICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLmFkZHJlc3MgPT09IHF1ZXJ5ICYmIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoY2FjaGVkLmxhdGl0dWRlKSkgJiYgTnVtYmVyLmlzRmluaXRlKE51bWJlcihjYWNoZWQubG9uZ2l0dWRlKSkpIHsKICAgICAgaWYgKGRlYnVnKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSBjYWNoZSBoaXQ6ICIgKyBxdWVyeSArICIgLT4gIiArIGNhY2hlZC5sYXRpdHVkZSArICIsIiArIGNhY2hlZC5sb25naXR1ZGUpOwogICAgICB9CiAgICAgIGNhbGxiYWNrKGNhY2hlZCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAodHlwZW9mICRodHRwQ2xpZW50ID09PSAidW5kZWZpbmVkIiB8fCAhJGh0dHBDbGllbnQuZ2V0KSB7CiAgICAgIGlmIChkZWJ1ZykgewogICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgc2tpcHBlZDogJGh0dHBDbGllbnQgdW5hdmFpbGFibGUiKTsKICAgICAgfQogICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIHZhciB1cmwgPQogICAgICAiaHR0cHM6Ly9ub21pbmF0aW0ub3BlbnN0cmVldG1hcC5vcmcvc2VhcmNoP2Zvcm1hdD1qc29uJmxpbWl0PTEmYWRkcmVzc2RldGFpbHM9MCZxPSIgKwogICAgICBlbmNvZGVVUklDb21wb25lbnQocXVlcnkpOwogICAgJGh0dHBDbGllbnQuZ2V0KAogICAgICB7CiAgICAgICAgdXJsOiB1cmwsCiAgICAgICAgdGltZW91dDogODAwMCwKICAgICAgICBoZWFkZXJzOiB7ICJVc2VyLUFnZW50IjogImlvcy1sb2NhdGlvbi1zcG9vZmVyLzEuMCAoTG9vbiBwbHVnaW4pIiB9CiAgICAgIH0sCiAgICAgIGZ1bmN0aW9uIChlcnJvciwgcmVzcG9uc2UsIGJvZHkpIHsKICAgICAgICBpZiAoZXJyb3IgfHwgIWJvZHkpIHsKICAgICAgICAgIGlmIChkZWJ1ZykgewogICAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBnZW9jb2RlIGZhaWxlZDogIiArIChlcnJvciB8fCAiZW1wdHkgYm9keSIpKTsKICAgICAgICAgIH0KICAgICAgICAgIGNhbGxiYWNrKG51bGwpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICB0cnkgewogICAgICAgICAgdmFyIHJlc3VsdHMgPSBKU09OLnBhcnNlKGJvZHkpOwogICAgICAgICAgaWYgKCFyZXN1bHRzIHx8ICFyZXN1bHRzLmxlbmd0aCkgewogICAgICAgICAgICBpZiAoZGVidWcpIHsKICAgICAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBnZW9jb2RlIG5vIHJlc3VsdCBmb3I6ICIgKyBxdWVyeSk7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgY2FsbGJhY2sobnVsbCk7CiAgICAgICAgICAgIHJldHVybjsKICAgICAgICAgIH0KICAgICAgICAgIHZhciBoaXQgPSByZXN1bHRzWzBdOwogICAgICAgICAgdmFyIGxhdCA9IE51bWJlcihoaXQubGF0KTsKICAgICAgICAgIHZhciBsbmcgPSBOdW1iZXIoaGl0Lmxvbik7CiAgICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShsYXQpIHx8ICFOdW1iZXIuaXNGaW5pdGUobG5nKSkgewogICAgICAgICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgICAgICAgcmV0dXJuOwogICAgICAgICAgfQogICAgICAgICAgdmFyIGVudHJ5ID0gewogICAgICAgICAgICBhZGRyZXNzOiBxdWVyeSwKICAgICAgICAgICAgbGF0aXR1ZGU6IGxhdCwKICAgICAgICAgICAgbG9uZ2l0dWRlOiBsbmcsCiAgICAgICAgICAgIGRpc3BsYXlOYW1lOiBoaXQuZGlzcGxheV9uYW1lIHx8IHF1ZXJ5CiAgICAgICAgICB9OwogICAgICAgICAgZmV0Y2hFbGV2YXRpb24obGF0LCBsbmcsIGZ1bmN0aW9uIChhbHRpdHVkZSkgewogICAgICAgICAgICBpZiAoYWx0aXR1ZGUgIT0gbnVsbCkgewogICAgICAgICAgICAgIGVudHJ5LmFsdGl0dWRlID0gYWx0aXR1ZGU7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgd3JpdGVHZW9jb2RlQ2FjaGUoZW50cnkpOwogICAgICAgICAgICBpZiAoZGVidWcpIHsKICAgICAgICAgICAgICBjb25zb2xlLmxvZygKICAgICAgICAgICAgICAgICJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgcmVzb2x2ZWQ6ICIgKwogICAgICAgICAgICAgICAgICBxdWVyeSArCiAgICAgICAgICAgICAgICAgICIgLT4gIiArCiAgICAgICAgICAgICAgICAgIGxhdCArCiAgICAgICAgICAgICAgICAgICIsIiArCiAgICAgICAgICAgICAgICAgIGxuZyArCiAgICAgICAgICAgICAgICAgIChhbHRpdHVkZSAhPSBudWxsID8gIiwgYWx0PSIgKyBhbHRpdHVkZSA6ICIiKQogICAgICAgICAgICAgICk7CiAgICAgICAgICAgIH0KICAgICAgICAgICAgY2FsbGJhY2soZW50cnkpOwogICAgICAgICAgfSk7CiAgICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgICBpZiAoZGVidWcpIHsKICAgICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgZ2VvY29kZSBwYXJzZSBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZSk7CiAgICAgICAgICB9CiAgICAgICAgICBjYWxsYmFjayhudWxsKTsKICAgICAgICB9CiAgICAgIH0KICAgICk7CiAgfQoKICBmdW5jdGlvbiBtZXJnZUNvbmZpZyhiYXNlLCBleHRyYSkgewogICAgdmFyIG91dCA9IHt9OwogICAgdmFyIGtleTsKICAgIGZvciAoa2V5IGluIGJhc2UpIHsKICAgICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChiYXNlLCBrZXkpKSB7CiAgICAgICAgb3V0W2tleV0gPSBiYXNlW2tleV07CiAgICAgIH0KICAgIH0KICAgIGV4dHJhID0gZXh0cmEgfHwge307CiAgICBmb3IgKGtleSBpbiBleHRyYSkgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGV4dHJhLCBrZXkpKSB7CiAgICAgICAgb3V0W2tleV0gPSBleHRyYVtrZXldOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gZGVjb2RlQmFzZTY0KHZhbHVlKSB7CiAgICBpZiAodHlwZW9mIGF0b2IgPT09ICJmdW5jdGlvbiIpIHsKICAgICAgcmV0dXJuIGF0b2IodmFsdWUpOwogICAgfQogICAgaWYgKHR5cGVvZiBCdWZmZXIgIT09ICJ1bmRlZmluZWQiKSB7CiAgICAgIHJldHVybiBCdWZmZXIuZnJvbSh2YWx1ZSwgImJhc2U2NCIpLnRvU3RyaW5nKCJ1dGY4Iik7CiAgICB9CiAgICB0aHJvdyBuZXcgRXJyb3IoImJhc2U2NCBkZWNvZGVyIHVuYXZhaWxhYmxlIik7CiAgfQoKICBmdW5jdGlvbiBjb25maWdGcm9tQXJncyhhcmdzKSB7CiAgICB2YXIgY2ZnID0ge307CiAgICB2YXIgc2NhbGFyS2V5cyA9IFsKICAgICAgImVuYWJsZWQiLAogICAgICAibW9kZSIsCiAgICAgICJsYXRpdHVkZSIsCiAgICAgICJsb25naXR1ZGUiLAogICAgICAiYWRkcmVzcyIsCiAgICAgICJob3Jpem9udGFsQWNjdXJhY3kiLAogICAgICAidmVydGljYWxBY2N1cmFjeSIsCiAgICAgICJyYW5kb21SYWRpdXMiLAogICAgICAiYWx0aXR1ZGUiLAogICAgICAidW5rbm93blZhbHVlNCIsCiAgICAgICJtb3Rpb25BY3Rpdml0eVR5cGUiLAogICAgICAibW90aW9uQWN0aXZpdHlDb25maWRlbmNlIiwKICAgICAgImZhaWxPcGVuIiwKICAgICAgImRlYnVnIiwKICAgICAgImR1bXBSYXciLAogICAgICAiZHVtcEhlYWRlcnMiLAogICAgICAicHJlcGFyZUhlYWRlcnMiLAogICAgICAicmF3TGltaXQiCiAgICBdOwoKICAgIGlmIChhcmdzLmNvbmZpZykgewogICAgICBjZmcgPSBtZXJnZUNvbmZpZyhjZmcsIEpTT04ucGFyc2UoYXJncy5jb25maWcpKTsKICAgIH0KICAgIGlmIChhcmdzLmNvbmZpZ0Jhc2U2NCkgewogICAgICBjZmcgPSBtZXJnZUNvbmZpZyhjZmcsIEpTT04ucGFyc2UoZGVjb2RlQmFzZTY0KGFyZ3MuY29uZmlnQmFzZTY0KSkpOwogICAgfQogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzY2FsYXJLZXlzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIHZhciBrZXkgPSBzY2FsYXJLZXlzW2ldOwogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGFyZ3MsIGtleSkpIHsKICAgICAgICBjZmdba2V5XSA9IGFyZ3Nba2V5XTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIGNmZzsKICB9CgogIGZ1bmN0aW9uIHJlYWRSZW1vdGVDb25maWdDYWNoZSh1cmwpIHsKICAgIGlmICghdXJsIHx8IHR5cGVvZiAkcGVyc2lzdGVudFN0b3JlID09PSAidW5kZWZpbmVkIiB8fCAhJHBlcnNpc3RlbnRTdG9yZS5yZWFkKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgdHJ5IHsKICAgICAgdmFyIHJhdyA9ICRwZXJzaXN0ZW50U3RvcmUucmVhZCgibG9jYXRpb25fc3Bvb2Zlcl9yZW1vdGVfY2ZnIik7CiAgICAgIGlmICghcmF3KSB7CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICAgIH0KICAgICAgdmFyIGVudHJ5ID0gSlNPTi5wYXJzZShyYXcpOwogICAgICBpZiAoIWVudHJ5IHx8IGVudHJ5LnVybCAhPT0gdXJsIHx8ICFlbnRyeS5kYXRhKSB7CiAgICAgICAgcmV0dXJuIG51bGw7CiAgICAgIH0KICAgICAgaWYgKERhdGUubm93KCkgLSBlbnRyeS50cyA+IDMwMDAwMCkgewogICAgICAgIHJldHVybiBudWxsOwogICAgICB9CiAgICAgIHJldHVybiBlbnRyeS5kYXRhOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogIH0KCiAgZnVuY3Rpb24gd3JpdGVSZW1vdGVDb25maWdDYWNoZSh1cmwsIGRhdGEpIHsKICAgIGlmICghdXJsIHx8IHR5cGVvZiAkcGVyc2lzdGVudFN0b3JlID09PSAidW5kZWZpbmVkIiB8fCAhJHBlcnNpc3RlbnRTdG9yZS53cml0ZSkgewogICAgICByZXR1cm47CiAgICB9CiAgICB0cnkgewogICAgICAkcGVyc2lzdGVudFN0b3JlLndyaXRlKAogICAgICAgICJsb2NhdGlvbl9zcG9vZmVyX3JlbW90ZV9jZmciLAogICAgICAgIEpTT04uc3RyaW5naWZ5KHsgdXJsOiB1cmwsIGRhdGE6IGRhdGEsIHRzOiBEYXRlLm5vdygpIH0pCiAgICAgICk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgLy8gaWdub3JlIGNhY2hlIHdyaXRlIGZhaWx1cmVzCiAgICB9CiAgfQoKICBmdW5jdGlvbiBmZXRjaFJlbW90ZUNvbmZpZyh1cmwsIHRpbWVvdXQsIGRlYnVnLCBjYWxsYmFjaykgewogICAgaWYgKCF1cmwgfHwgdHlwZW9mICRodHRwQ2xpZW50ID09PSAidW5kZWZpbmVkIiB8fCAhJGh0dHBDbGllbnQuZ2V0KSB7CiAgICAgIGNhbGxiYWNrKG51bGwsICJodHRwIGNsaWVudCB1bmF2YWlsYWJsZSIpOwogICAgICByZXR1cm47CiAgICB9CiAgICAkaHR0cENsaWVudC5nZXQoeyB1cmw6IHVybCwgdGltZW91dDogdGltZW91dCB8fCAzMDAwIH0sIGZ1bmN0aW9uIChlcnJvciwgcmVzcG9uc2UsIGJvZHkpIHsKICAgICAgaWYgKGVycm9yIHx8ICFib2R5KSB7CiAgICAgICAgY2FsbGJhY2sobnVsbCwgZXJyb3IgfHwgImVtcHR5IGJvZHkiKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgdHJ5IHsKICAgICAgICBjYWxsYmFjayhKU09OLnBhcnNlKGJvZHkpLCBudWxsKTsKICAgICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgICAgY2FsbGJhY2sobnVsbCwgZXJyLm1lc3NhZ2UpOwogICAgICB9CiAgICB9KTsKICB9CgogIGZ1bmN0aW9uIHJlZnJlc2hSZW1vdGVDb25maWdDYWNoZSh1cmwsIGRlYnVnKSB7CiAgICBmZXRjaFJlbW90ZUNvbmZpZyh1cmwsIDUwMDAsIGRlYnVnLCBmdW5jdGlvbiAoZGF0YSwgZXJyKSB7CiAgICAgIGlmIChkYXRhKSB7CiAgICAgICAgd3JpdGVSZW1vdGVDb25maWdDYWNoZSh1cmwsIGRhdGEpOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBpZiAoZGVidWcpIHsKICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZW1vdGUgY29uZmlnIHJlZnJlc2ggZmFpbGVkOiAiICsgZXJyKTsKICAgICAgfQogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBhcHBseUFkZHJlc3NGcm9tQ2FjaGUoY2ZnLCBhZGRyZXNzLCBkZWJ1ZykgewogICAgaWYgKCFhZGRyZXNzKSB7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHZhciBjYWNoZWQgPSByZWFkR2VvY29kZUNhY2hlKCk7CiAgICBpZiAoY2FjaGVkICYmIGNhY2hlZC5hZGRyZXNzID09PSBhZGRyZXNzICYmIE51bWJlci5pc0Zpbml0ZShOdW1iZXIoY2FjaGVkLmxhdGl0dWRlKSkgJiYgTnVtYmVyLmlzRmluaXRlKE51bWJlcihjYWNoZWQubG9uZ2l0dWRlKSkpIHsKICAgICAgY2ZnLmxhdGl0dWRlID0gY2FjaGVkLmxhdGl0dWRlOwogICAgICBjZmcubG9uZ2l0dWRlID0gY2FjaGVkLmxvbmdpdHVkZTsKICAgICAgaWYgKGNhY2hlZC5hbHRpdHVkZSAhPSBudWxsKSB7CiAgICAgICAgY2ZnLmFsdGl0dWRlID0gY2FjaGVkLmFsdGl0dWRlOwogICAgICB9CiAgICAgIGlmIChkZWJ1ZykgewogICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgY2FjaGUgaGl0OiAiICsgYWRkcmVzcyk7CiAgICAgIH0KICAgICAgcmV0dXJuOwogICAgfQogICAgaWYgKGRlYnVnKSB7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGdlb2NvZGUgY2FjaGUgbWlzczogIiArIGFkZHJlc3MgKyAiICh1c2UgbWFudWFsIGxhdC9sbmcgdW50aWwgY3JvbiByZWZyZXNoZXMpIik7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBsb2FkUnVudGltZUNvbmZpZ1N5bmMoKSB7CiAgICB2YXIgYXJncyA9IHJlYWRTY3JpcHRBcmd1bWVudHMoKTsKICAgIHZhciBjZmcgPSBtZXJnZUNvbmZpZyhERUZBVUxUX0NPTkZJRywgY29uZmlnRnJvbUFyZ3MoYXJncykpOwogICAgdmFyIGNvbmZpZ1VybCA9IHJlc29sdmVDb25maWdVcmwoYXJncyk7CiAgICB2YXIgZGVidWcgPSBwYXJzZUJvb2xlYW4oY2ZnLmRlYnVnLCBmYWxzZSk7CiAgICB2YXIgYWRkcmVzcyA9IFN0cmluZyhhcmdzLmFkZHJlc3MgfHwgIiIpLnRyaW0oKTsKCiAgICBhcHBseUFkZHJlc3NGcm9tQ2FjaGUoY2ZnLCBhZGRyZXNzLCBkZWJ1Zyk7CgogICAgaWYgKGNvbmZpZ1VybCkgewogICAgICB2YXIgcmVtb3RlQ2ZnID0gcmVhZFJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCk7CiAgICAgIGlmIChyZW1vdGVDZmcpIHsKICAgICAgICBjZmcgPSBtZXJnZUNvbmZpZyhjZmcsIHJlbW90ZUNmZyk7CiAgICAgICAgaWYgKGRlYnVnKSB7CiAgICAgICAgICBjb25zb2xlLmxvZygKICAgICAgICAgICAgIkxvY2F0aW9uIHNwb29mZXIgcmVtb3RlIGNvbmZpZyBjYWNoZSBoaXQgLT4gIiArCiAgICAgICAgICAgICAgcmVtb3RlQ2ZnLmxhdGl0dWRlICsKICAgICAgICAgICAgICAiLCIgKwogICAgICAgICAgICAgIHJlbW90ZUNmZy5sb25naXR1ZGUKICAgICAgICAgICk7CiAgICAgICAgfQogICAgICB9CiAgICB9CgogICAgcmV0dXJuIHsgY2ZnOiBjZmcsIGNvbmZpZ1VybDogY29uZmlnVXJsLCBkZWJ1ZzogZGVidWcgfTsKICB9CgogIGZ1bmN0aW9uIGxvYWRSdW50aW1lQ29uZmlnKGNhbGxiYWNrKSB7CiAgICB2YXIgbG9hZGVkID0gbG9hZFJ1bnRpbWVDb25maWdTeW5jKCk7CiAgICB2YXIgY2ZnID0gbG9hZGVkLmNmZzsKICAgIHZhciBjb25maWdVcmwgPSBsb2FkZWQuY29uZmlnVXJsOwogICAgdmFyIGRlYnVnID0gbG9hZGVkLmRlYnVnOwoKICAgIGZ1bmN0aW9uIGZpbmlzaCgpIHsKICAgICAgdHJ5IHsKICAgICAgICBjYWxsYmFjayhub3JtYWxpemVDb25maWcoY2ZnKSk7CiAgICAgIH0gY2F0Y2ggKGVycikgewogICAgICAgIGlmIChkZWJ1ZykgewogICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgY29uZmlnIGludmFsaWQ6ICIgKyBlcnIubWVzc2FnZSArICIgfCBjZmcgbGF0L2xuZz0iICsgY2ZnLmxhdGl0dWRlICsgIiwiICsgY2ZnLmxvbmdpdHVkZSk7CiAgICAgICAgfQogICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKE51bWJlcihjZmcubGF0aXR1ZGUpKSB8fCAhTnVtYmVyLmlzRmluaXRlKE51bWJlcihjZmcubG9uZ2l0dWRlKSkpIHsKICAgICAgICAgIGNmZy5sYXRpdHVkZSA9IERFRkFVTFRfQ09ORklHLmxhdGl0dWRlOwogICAgICAgICAgY2ZnLmxvbmdpdHVkZSA9IERFRkFVTFRfQ09ORklHLmxvbmdpdHVkZTsKICAgICAgICB9CiAgICAgICAgY2FsbGJhY2sobm9ybWFsaXplQ29uZmlnKGNmZykpOwogICAgICB9CiAgICB9CgogICAgbG9nU2NyaXB0QXJndW1lbnRzKGRlYnVnKTsKCiAgICBpZiAoIWNvbmZpZ1VybCkgewogICAgICBmaW5pc2goKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGlmIChyZWFkUmVtb3RlQ29uZmlnQ2FjaGUoY29uZmlnVXJsKSkgewogICAgICByZWZyZXNoUmVtb3RlQ29uZmlnQ2FjaGUoY29uZmlnVXJsLCBkZWJ1Zyk7CiAgICAgIGZpbmlzaCgpOwogICAgICByZXR1cm47CiAgICB9CgogICAgaWYgKGRlYnVnKSB7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlbW90ZSBjb25maWcgZmV0Y2hpbmc6ICIgKyBjb25maWdVcmwpOwogICAgfQogICAgZmV0Y2hSZW1vdGVDb25maWcoY29uZmlnVXJsLCAzMDAwLCBkZWJ1ZywgZnVuY3Rpb24gKGRhdGEsIGVycikgewogICAgICBpZiAoZGF0YSkgewogICAgICAgIHdyaXRlUmVtb3RlQ29uZmlnQ2FjaGUoY29uZmlnVXJsLCBkYXRhKTsKICAgICAgICBjZmcgPSBtZXJnZUNvbmZpZyhjZmcsIGRhdGEpOwogICAgICAgIGlmIChkZWJ1ZykgewogICAgICAgICAgY29uc29sZS5sb2coCiAgICAgICAgICAgICJMb2NhdGlvbiBzcG9vZmVyIHJlbW90ZSBjb25maWcgbG9hZGVkIC0+ICIgKyBkYXRhLmxhdGl0dWRlICsgIiwiICsgZGF0YS5sb25naXR1ZGUKICAgICAgICAgICk7CiAgICAgICAgfQogICAgICB9IGVsc2UgaWYgKGRlYnVnKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVtb3RlIGNvbmZpZyBmZXRjaCBmYWlsZWQ6ICIgKyBlcnIgKyAiICh1c2luZyBtYW51YWwgbGF0L2xuZykiKTsKICAgICAgfQogICAgICBmaW5pc2goKTsKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcnVuTWFpbnRlbmFuY2VDcm9uKCkgewogICAgdmFyIGFyZ3MgPSByZWFkU2NyaXB0QXJndW1lbnRzKCk7CiAgICB2YXIgZGVidWcgPSBwYXJzZUJvb2xlYW4oYXJncy5kZWJ1ZywgZmFsc2UpOwogICAgdmFyIHBlbmRpbmcgPSAwOwoKICAgIGZ1bmN0aW9uIG1heWJlRG9uZSgpIHsKICAgICAgcGVuZGluZyAtPSAxOwogICAgICBpZiAocGVuZGluZyA8PSAwKSB7CiAgICAgICAgJGRvbmUoe30pOwogICAgICB9CiAgICB9CgogICAgdmFyIGNvbmZpZ1VybCA9IHJlc29sdmVDb25maWdVcmwoYXJncyk7CiAgICBpZiAoY29uZmlnVXJsKSB7CiAgICAgIHBlbmRpbmcgKz0gMTsKICAgICAgZmV0Y2hSZW1vdGVDb25maWcoY29uZmlnVXJsLCA4MDAwLCBkZWJ1ZywgZnVuY3Rpb24gKGRhdGEsIGVycikgewogICAgICAgIGlmIChkYXRhKSB7CiAgICAgICAgICB3cml0ZVJlbW90ZUNvbmZpZ0NhY2hlKGNvbmZpZ1VybCwgZGF0YSk7CiAgICAgICAgICBpZiAoZGVidWcpIHsKICAgICAgICAgICAgY29uc29sZS5sb2coCiAgICAgICAgICAgICAgIkxvY2F0aW9uIHNwb29mZXIgY29uZmlnIGNyb24gY2FjaGVkIC0+ICIgKyBkYXRhLmxhdGl0dWRlICsgIiwiICsgZGF0YS5sb25naXR1ZGUKICAgICAgICAgICAgKTsKICAgICAgICAgIH0KICAgICAgICB9IGVsc2UgaWYgKGRlYnVnKSB7CiAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBjb25maWcgY3JvbiBmYWlsZWQ6ICIgKyBlcnIpOwogICAgICAgIH0KICAgICAgICBtYXliZURvbmUoKTsKICAgICAgfSk7CiAgICB9CgogICAgdmFyIGFkZHJlc3MgPSBTdHJpbmcoYXJncy5hZGRyZXNzIHx8ICIiKS50cmltKCk7CiAgICBpZiAoYWRkcmVzcykgewogICAgICBwZW5kaW5nICs9IDE7CiAgICAgIGdlb2NvZGVBZGRyZXNzKGFkZHJlc3MsIGRlYnVnLCBmdW5jdGlvbiAoKSB7CiAgICAgICAgbWF5YmVEb25lKCk7CiAgICAgIH0pOwogICAgfQoKICAgIGlmIChwZW5kaW5nID09PSAwKSB7CiAgICAgICRkb25lKHt9KTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIHJ1bkdlb2NvZGVDcm9uKCkgewogICAgcnVuTWFpbnRlbmFuY2VDcm9uKCk7CiAgfQoKICBmdW5jdGlvbiBoZWFkZXJzV2l0aEJpbmFyeUJvZHkoc291cmNlSGVhZGVycywgbGVuZ3RoKSB7CiAgICB2YXIgaGVhZGVycyA9IHt9OwogICAgdmFyIGtleTsKICAgIHNvdXJjZUhlYWRlcnMgPSBzb3VyY2VIZWFkZXJzIHx8IHt9OwogICAgZm9yIChrZXkgaW4gc291cmNlSGVhZGVycykgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHNvdXJjZUhlYWRlcnMsIGtleSkpIHsKICAgICAgICB2YXIgbG93ZXIgPSBrZXkudG9Mb3dlckNhc2UoKTsKICAgICAgICBpZiAobG93ZXIgIT09ICJjb250ZW50LWxlbmd0aCIgJiYgbG93ZXIgIT09ICJjb250ZW50LWVuY29kaW5nIiAmJiBsb3dlciAhPT0gInRyYW5zZmVyLWVuY29kaW5nIikgewogICAgICAgICAgaGVhZGVyc1trZXldID0gc291cmNlSGVhZGVyc1trZXldOwogICAgICAgIH0KICAgICAgfQogICAgfQogICAgaGVhZGVyc1siQ29udGVudC1UeXBlIl0gPSAiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtIjsKICAgIGhlYWRlcnNbIkNvbnRlbnQtTGVuZ3RoIl0gPSBTdHJpbmcobGVuZ3RoKTsKICAgIHJldHVybiBoZWFkZXJzOwogIH0KCiAgZnVuY3Rpb24gc2V0SGVhZGVyKGhlYWRlcnMsIG5hbWUsIHZhbHVlKSB7CiAgICBoZWFkZXJzID0gaGVhZGVycyB8fCB7fTsKICAgIHZhciBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTsKICAgIHZhciBleGlzdGluZ0tleSA9IG51bGw7CiAgICBmb3IgKHZhciBrZXkgaW4gaGVhZGVycykgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGhlYWRlcnMsIGtleSkgJiYga2V5LnRvTG93ZXJDYXNlKCkgPT09IGxvd2VyKSB7CiAgICAgICAgZXhpc3RpbmdLZXkgPSBrZXk7CiAgICAgICAgYnJlYWs7CiAgICAgIH0KICAgIH0KICAgIGhlYWRlcnNbZXhpc3RpbmdLZXkgfHwgbmFtZV0gPSB2YWx1ZTsKICAgIHJldHVybiBoZWFkZXJzOwogIH0KCiAgZnVuY3Rpb24gcHJlcGFyZVJlcXVlc3RIZWFkZXJzKGhlYWRlcnMpIHsKICAgIHJldHVybiBzZXRIZWFkZXIoaGVhZGVycyB8fCB7fSwgIkFjY2VwdC1FbmNvZGluZyIsICJpZGVudGl0eSIpOwogIH0KCiAgZnVuY3Rpb24gZG9uZVByZXBhcmVkUmVxdWVzdFBhc3NUaHJvdWdoKCkgewogICAgdmFyIGhlYWRlcnMgPSBwcmVwYXJlUmVxdWVzdEhlYWRlcnMoKHR5cGVvZiAkcmVxdWVzdCAhPT0gInVuZGVmaW5lZCIgJiYgJHJlcXVlc3QuaGVhZGVycykgfHwge30pOwogICAgJGRvbmUoewogICAgICBoZWFkZXJzOiBoZWFkZXJzCiAgICB9KTsKICB9CgogIC8vIERlY29kZSBhbiBIVFRQIHJlc3BvbnNlIGJvZHkgdGhhdCBtYXkgYmUgZ3ppcC9kZWZsYXRlL2JyIGVuY29kZWQuCiAgLy8gU2hhZG93cm9ja2V0L1N1cmdlIGV4cG9zZSAkdXRpbHMudW5nemlwOyBMb29uIGZhbGxzIGJhY2sgdG8gRGVjb21wcmVzc2lvblN0cmVhbS4KICBmdW5jdGlvbiBkZWNvbXByZXNzQm9keShib2R5LCBjb250ZW50RW5jb2RpbmcpIHsKICAgIGlmIChib2R5ID09IG51bGwpIHsKICAgICAgcmV0dXJuIGJvZHk7CiAgICB9CiAgICB2YXIgZW5jID0gY29udGVudEVuY29kaW5nID8gU3RyaW5nKGNvbnRlbnRFbmNvZGluZykudG9Mb3dlckNhc2UoKSA6ICIiOwogICAgaWYgKGVuYyA9PT0gImlkZW50aXR5IiB8fCBlbmMgPT09ICIiKSB7CiAgICAgIHJldHVybiBib2R5OwogICAgfQogICAgdHJ5IHsKICAgICAgaWYgKGVuYy5pbmRleE9mKCJnemlwIikgPj0gMCAmJiB0eXBlb2YgJHV0aWxzICE9PSAidW5kZWZpbmVkIiAmJiAkdXRpbHMudW5nemlwKSB7CiAgICAgICAgcmV0dXJuICR1dGlscy51bmd6aXAoYm9keSk7CiAgICAgIH0KICAgICAgaWYgKGVuYy5pbmRleE9mKCJkZWZsYXRlIikgPj0gMCAmJiB0eXBlb2YgJHV0aWxzICE9PSAidW5kZWZpbmVkIiAmJiAkdXRpbHMuaW5mbGF0ZSkgewogICAgICAgIHJldHVybiAkdXRpbHMuaW5mbGF0ZShib2R5KTsKICAgICAgfQogICAgICBpZiAoZW5jLmluZGV4T2YoImJyIikgPj0gMCAmJiB0eXBlb2YgJHV0aWxzICE9PSAidW5kZWZpbmVkIiAmJiAkdXRpbHMuYnJvdGxpRGVjb21wcmVzcykgewogICAgICAgIHJldHVybiAkdXRpbHMuYnJvdGxpRGVjb21wcmVzcyhib2R5KTsKICAgICAgfQogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIGlmICh0eXBlb2YgY29uc29sZSAhPT0gInVuZGVmaW5lZCIpIHsKICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBkZWNvbXByZXNzIGZhaWxlZCAoIiArIGVuYyArICIpOiAiICsgZXJyLm1lc3NhZ2UpOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gYm9keTsKICB9CgogIGZ1bmN0aW9uIHByZXBhcmVSZXNwb25zZUJvZHlTeW5jKGNvbmZpZykgewogICAgdmFyIHJlc3BIZWFkZXJzID0gKCRyZXNwb25zZSAmJiAkcmVzcG9uc2UuaGVhZGVycykgfHwge307CiAgICB2YXIgY29udGVudEVuY29kaW5nID0gaGVhZGVyVmFsdWUocmVzcEhlYWRlcnMsICJDb250ZW50LUVuY29kaW5nIik7CiAgICB2YXIgcmF3UmVzcEJvZHkgPSAkcmVzcG9uc2UgJiYgKCRyZXNwb25zZS5ib2R5ICE9IG51bGwgPyAkcmVzcG9uc2UuYm9keSA6ICRyZXNwb25zZS5ib2R5Qnl0ZXMpOwogICAgbG9nSHR0cER1bXAoInJlc3BvbnNlLXdpcmUtb3JpZ2luYWwiLCAkcmVzcG9uc2UsIGNvbmZpZyk7CiAgICBsb2dSYXdEdW1wKCJyZXNwb25zZS13aXJlLW9yaWdpbmFsIiwgYm9keVRvQnl0ZXMocmF3UmVzcEJvZHkpLCBjb25maWcpOwoKICAgIHZhciBieXRlcyA9IGJvZHlUb0J5dGVzKHJhd1Jlc3BCb2R5KTsKICAgIGlmICghYnl0ZXMgfHwgYnl0ZXMubGVuZ3RoIDwgMikgewogICAgICByZXR1cm47CiAgICB9CgogICAgaWYgKGlzR3ppcEJ5dGVzKGJ5dGVzKSB8fCAoY29udGVudEVuY29kaW5nICYmIFN0cmluZyhjb250ZW50RW5jb2RpbmcpLnRvTG93ZXJDYXNlKCkuaW5kZXhPZigiZ3ppcCIpID49IDApKSB7CiAgICAgIHZhciBkZWNvZGVkID0gYm9keVRvQnl0ZXMoZGVjb21wcmVzc0JvZHkocmF3UmVzcEJvZHksIGNvbnRlbnRFbmNvZGluZyB8fCAiZ3ppcCIpKTsKICAgICAgaWYgKGRlY29kZWQgJiYgZGVjb2RlZC5sZW5ndGggPiAyICYmICFpc0d6aXBCeXRlcyhkZWNvZGVkKSkgewogICAgICAgICRyZXNwb25zZS5ib2R5ID0gZGVjb2RlZDsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBkZWNvbXByZXNzZWQgYm9keTogIiArIGJ5dGVzLmxlbmd0aCArICIgLT4gIiArIGRlY29kZWQubGVuZ3RoICsgIiBieXRlcyIpOwogICAgICAgIH0KICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICAgIGNvbnNvbGUubG9nKAogICAgICAgICAgIkxvY2F0aW9uIHNwb29mZXIgZ3ppcCBib2R5IHN0aWxsIGNvbXByZXNzZWQgKGxlbj0iICsKICAgICAgICAgICAgYnl0ZXMubGVuZ3RoICsKICAgICAgICAgICAgIik7IGVuc3VyZSBodHRwLXJlcXVlc3QgcHJlcGFyZSBzY3JpcHQgaXMgZW5hYmxlZCIKICAgICAgICApOwogICAgICB9CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAoY29udGVudEVuY29kaW5nKSB7CiAgICAgIHZhciBwbGFpbiA9IGJvZHlUb0J5dGVzKGRlY29tcHJlc3NCb2R5KHJhd1Jlc3BCb2R5LCBjb250ZW50RW5jb2RpbmcpKTsKICAgICAgaWYgKHBsYWluKSB7CiAgICAgICAgJHJlc3BvbnNlLmJvZHkgPSBwbGFpbjsKICAgICAgfQogICAgfQogIH0KCiAgZnVuY3Rpb24gaGVhZGVyVmFsdWUoaGVhZGVycywgbmFtZSkgewogICAgaWYgKCFoZWFkZXJzKSB7CiAgICAgIHJldHVybiB1bmRlZmluZWQ7CiAgICB9CiAgICB2YXIgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7CiAgICBmb3IgKHZhciBrZXkgaW4gaGVhZGVycykgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGhlYWRlcnMsIGtleSkgJiYga2V5LnRvTG93ZXJDYXNlKCkgPT09IGxvd2VyKSB7CiAgICAgICAgcmV0dXJuIGhlYWRlcnNba2V5XTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIHVuZGVmaW5lZDsKICB9CgogIGZ1bmN0aW9uIGRvbmVQYXNzVGhyb3VnaCgpIHsKICAgICRkb25lKHt9KTsKICB9CgogIGZ1bmN0aW9uIHZhbHVlVHlwZSh2YWx1ZSkgewogICAgaWYgKHZhbHVlID09IG51bGwpIHsKICAgICAgcmV0dXJuIFN0cmluZyh2YWx1ZSk7CiAgICB9CiAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBVaW50OEFycmF5KSB7CiAgICAgIHJldHVybiAiVWludDhBcnJheSI7CiAgICB9CiAgICBpZiAodHlwZW9mIEFycmF5QnVmZmVyICE9PSAidW5kZWZpbmVkIiAmJiB2YWx1ZSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7CiAgICAgIHJldHVybiAiQXJyYXlCdWZmZXIiOwogICAgfQogICAgcmV0dXJuIHR5cGVvZiB2YWx1ZTsKICB9CgogIGZ1bmN0aW9uIHZhbHVlTGVuZ3RoKHZhbHVlKSB7CiAgICBpZiAodmFsdWUgPT0gbnVsbCkgewogICAgICByZXR1cm4gMDsKICAgIH0KICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICJzdHJpbmciIHx8IHR5cGVvZiB2YWx1ZS5sZW5ndGggPT09ICJudW1iZXIiKSB7CiAgICAgIHJldHVybiB2YWx1ZS5sZW5ndGg7CiAgICB9CiAgICBpZiAodHlwZW9mIEFycmF5QnVmZmVyICE9PSAidW5kZWZpbmVkIiAmJiB2YWx1ZSBpbnN0YW5jZW9mIEFycmF5QnVmZmVyKSB7CiAgICAgIHJldHVybiB2YWx1ZS5ieXRlTGVuZ3RoOwogICAgfQogICAgcmV0dXJuIDA7CiAgfQoKICBmdW5jdGlvbiBvYmplY3RLZXlzKHZhbHVlKSB7CiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gIm9iamVjdCIpIHsKICAgICAgcmV0dXJuICIiOwogICAgfQogICAgdmFyIGtleXMgPSBbXTsKICAgIGZvciAodmFyIGtleSBpbiB2YWx1ZSkgewogICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHZhbHVlLCBrZXkpKSB7CiAgICAgICAga2V5cy5wdXNoKGtleSk7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBrZXlzLmpvaW4oIiwiKTsKICB9CgogIGZ1bmN0aW9uIGZpZWxkSGlzdG9ncmFtKGZpZWxkcykgewogICAgdmFyIGNvdW50cyA9IHt9OwogICAgdmFyIG9yZGVyID0gW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkgKz0gMSkgewogICAgICB2YXIga2V5ID0gU3RyaW5nKGZpZWxkc1tpXS5maWVsZE51bWJlcikgKyAiLyIgKyBTdHJpbmcoZmllbGRzW2ldLndpcmVUeXBlKTsKICAgICAgaWYgKCFjb3VudHNba2V5XSkgewogICAgICAgIGNvdW50c1trZXldID0gMDsKICAgICAgICBvcmRlci5wdXNoKGtleSk7CiAgICAgIH0KICAgICAgY291bnRzW2tleV0gKz0gMTsKICAgIH0KICAgIHZhciBwYXJ0cyA9IFtdOwogICAgZm9yICh2YXIgaiA9IDA7IGogPCBvcmRlci5sZW5ndGg7IGogKz0gMSkgewogICAgICBwYXJ0cy5wdXNoKG9yZGVyW2pdICsgIngiICsgY291bnRzW29yZGVyW2pdXSk7CiAgICB9CiAgICByZXR1cm4gcGFydHMuam9pbigiLCIpOwogIH0KCiAgZnVuY3Rpb24gY291bnRGaWVsZHMoZmllbGRzLCBmaWVsZE51bWJlcikgewogICAgdmFyIGNvdW50ID0gMDsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7CiAgICAgIGlmIChmaWVsZHNbaV0uZmllbGROdW1iZXIgPT09IGZpZWxkTnVtYmVyKSB7CiAgICAgICAgY291bnQgKz0gMTsKICAgICAgfQogICAgfQogICAgcmV0dXJuIGNvdW50OwogIH0KCiAgZnVuY3Rpb24gY291bnRDZWxsUmVzcG9uc2VGaWVsZHMoZmllbGRzKSB7CiAgICB2YXIgY291bnQgPSAwOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgaWYgKGlzQ2VsbFJlc3BvbnNlRmllbGQoZmllbGRzW2ldLmZpZWxkTnVtYmVyKSkgewogICAgICAgIGNvdW50ICs9IDE7CiAgICAgIH0KICAgIH0KICAgIHJldHVybiBjb3VudDsKICB9CgogIGZ1bmN0aW9uIGFwcGxlV0xvY1BheWxvYWRJbnNwZWN0KHBheWxvYWQpIHsKICAgIHRyeSB7CiAgICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKTsKICAgICAgdmFyIHBhcnRzID0gWwogICAgICAgICJwYXlsb2FkTGVuPSIgKyBwYXlsb2FkLmxlbmd0aCwKICAgICAgICAiZmllbGRzPSIgKyBmaWVsZEhpc3RvZ3JhbShmaWVsZHMpLAogICAgICAgICJ3aWZpPSIgKyBjb3VudEZpZWxkcyhmaWVsZHMsIDIpLAogICAgICAgICJjZWxsUmVzcD0iICsgY291bnRDZWxsUmVzcG9uc2VGaWVsZHMoZmllbGRzKSwKICAgICAgICAiY2VsbFJlcT0iICsgY291bnRGaWVsZHMoZmllbGRzLCAyNSksCiAgICAgICAgImhhc0NvdW50cz0iICsgKGNvdW50RmllbGRzKGZpZWxkcywgMykgKyAiLyIgKyBjb3VudEZpZWxkcyhmaWVsZHMsIDQpKSwKICAgICAgICAiZGV2aWNlVHlwZT0iICsgY291bnRGaWVsZHMoZmllbGRzLCAzMyksCiAgICAgICAgcGF0Y2hlZFBheWxvYWRTdW1tYXJ5KHBheWxvYWQpCiAgICAgIF07CiAgICAgIHJldHVybiBwYXJ0cy5qb2luKCIsICIpOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIHJldHVybiAicGF5bG9hZCBwYXJzZSBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZTsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGxvZ1Jhd0R1bXAobGFiZWwsIGJ5dGVzLCBjb25maWcpIHsKICAgIGlmICghY29uZmlnLmR1bXBSYXcgfHwgIWJ5dGVzKSB7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHZhciBsaW1pdCA9IGNvbmZpZy5yYXdMaW1pdCB8fCAwOwogICAgdmFyIGVtaXR0ZWQgPSBsaW1pdCA+IDAgJiYgYnl0ZXMubGVuZ3RoID4gbGltaXQgPyBieXRlcy5zbGljZSgwLCBsaW1pdCkgOiBieXRlczsKICAgIHZhciBlbmNvZGVkID0gYnl0ZXNUb0Jhc2U2NChlbWl0dGVkKTsKICAgIHZhciBjaHVua1NpemUgPSAzMDAwOwogICAgdmFyIGNodW5rcyA9IE1hdGgubWF4KDEsIE1hdGguY2VpbChlbmNvZGVkLmxlbmd0aCAvIGNodW5rU2l6ZSkpOwogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmF3ICIgKyBsYWJlbCArICIgYmFzZTY0IGJlZ2luOiBsZW49IiArIGJ5dGVzLmxlbmd0aCArICIsIGVtaXR0ZWQ9IiArIGVtaXR0ZWQubGVuZ3RoICsgIiwgY2h1bmtzPSIgKyBjaHVua3MgKyAiLCB0cnVuY2F0ZWQ9IiArIChlbWl0dGVkLmxlbmd0aCAhPT0gYnl0ZXMubGVuZ3RoKSk7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGVuY29kZWQubGVuZ3RoOyBpICs9IGNodW5rU2l6ZSkgewogICAgICB2YXIgY2h1bmtJbmRleCA9IE1hdGguZmxvb3IoaSAvIGNodW5rU2l6ZSkgKyAxOwogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByYXcgIiArIGxhYmVsICsgIiBiYXNlNjQgY2h1bmsgIiArIGNodW5rSW5kZXggKyAiLyIgKyBjaHVua3MgKyAiOiAiICsgZW5jb2RlZC5zbGljZShpLCBpICsgY2h1bmtTaXplKSk7CiAgICB9CiAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByYXcgIiArIGxhYmVsICsgIiBiYXNlNjQgZW5kIik7CiAgfQoKICBmdW5jdGlvbiBqc29uU3RyaW5nKHZhbHVlKSB7CiAgICB0cnkgewogICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUgfHwge30pOwogICAgfSBjYXRjaCAoZXJyKSB7CiAgICAgIHJldHVybiAiPGpzb24tZmFpbGVkOiIgKyBlcnIubWVzc2FnZSArICI+IjsKICAgIH0KICB9CgogIGZ1bmN0aW9uIGxvZ0h0dHBEdW1wKGxhYmVsLCBtZXNzYWdlLCBjb25maWcpIHsKICAgIGlmICghY29uZmlnLmR1bXBIZWFkZXJzICYmICFjb25maWcuZHVtcFJhdykgewogICAgICByZXR1cm47CiAgICB9CiAgICBtZXNzYWdlID0gbWVzc2FnZSB8fCB7fTsKICAgIHZhciByZXF1ZXN0ID0gdHlwZW9mICRyZXF1ZXN0ICE9PSAidW5kZWZpbmVkIiA/ICRyZXF1ZXN0IDoge307CiAgICB2YXIgbWV0aG9kID0gbWVzc2FnZS5tZXRob2QgfHwgcmVxdWVzdC5tZXRob2QgfHwgIjxub25lPiI7CiAgICB2YXIgdXJsID0gbWVzc2FnZS51cmwgfHwgcmVxdWVzdC51cmwgfHwgIjxub25lPiI7CiAgICB2YXIgc3RhdHVzID0gbWVzc2FnZS5zdGF0dXMgfHwgbWVzc2FnZS5zdGF0dXNDb2RlIHx8ICI8bm9uZT4iOwogICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmF3ICIgKyBsYWJlbCArICIgbWV0YTogbWV0aG9kPSIgKyBtZXRob2QgKyAiLCB1cmw9IiArIHVybCArICIsIHN0YXR1cz0iICsgc3RhdHVzKTsKICAgIGlmIChjb25maWcuZHVtcEhlYWRlcnMpIHsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmF3ICIgKyBsYWJlbCArICIgaGVhZGVyczogIiArIGpzb25TdHJpbmcobWVzc2FnZS5oZWFkZXJzIHx8IHt9KSk7CiAgICB9CiAgfQoKICBmdW5jdGlvbiBpbnNwZWN0UmVzcG9uc2VCeXRlcyhieXRlcywgY29uZmlnKSB7CiAgICBpZiAoIWJ5dGVzKSB7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVzcG9uc2UgYm9keSB1bmF2YWlsYWJsZSIpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlc3BvbnNlIGJvZHk6IGxlbj0iICsgYnl0ZXMubGVuZ3RoICsgIiwgaGVhZD0iICsgaGV4UHJldmlldyhieXRlcywgNDgpKTsKICAgIGxvZ1Jhd0R1bXAoInJlc3BvbnNlIiwgYnl0ZXMsIGNvbmZpZyk7CiAgICB0cnkgewogICAgICB2YXIgZXh0cmFjdGlvbiA9IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkKGJ5dGVzKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBleHRyYWN0aW9uOiBraW5kPSIgKyBleHRyYWN0aW9uLmtpbmQgKyAiLCBwcmVmaXg9IiArIChleHRyYWN0aW9uLnByZWZpeCA/IGhleFByZXZpZXcoZXh0cmFjdGlvbi5wcmVmaXgsIDgpIDogIjxub25lPiIpICsgIiwgcGF5bG9hZExlbj0iICsgZXh0cmFjdGlvbi5wYXlsb2FkLmxlbmd0aCArICIsIHN1ZmZpeExlbj0iICsgKGV4dHJhY3Rpb24uc3VmZml4ID8gZXh0cmFjdGlvbi5zdWZmaXgubGVuZ3RoIDogMCkpOwogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlc3BvbnNlIHBheWxvYWQ6ICIgKyBhcHBsZVdMb2NQYXlsb2FkSW5zcGVjdChleHRyYWN0aW9uLnBheWxvYWQpKTsKICAgIH0gY2F0Y2ggKGVycikgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlc3BvbnNlIGV4dHJhY3Rpb24gZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2UpOwogICAgICB2YXIgZGlyZWN0RmllbGRzID0gdHJ5UGFyc2VGaWVsZHMoYnl0ZXMpOwogICAgICBpZiAoZGlyZWN0RmllbGRzKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXNwb25zZSBkaXJlY3QgZmllbGRzOiAiICsgZmllbGRIaXN0b2dyYW0oZGlyZWN0RmllbGRzKSk7CiAgICAgIH0KICAgIH0KICB9CgogIGZ1bmN0aW9uIGluc3BlY3RSZXF1ZXN0Qnl0ZXMoYnl0ZXMsIGNvbmZpZykgewogICAgaWYgKCFieXRlcykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlcXVlc3QgYm9keSB1bmF2YWlsYWJsZSIpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlcXVlc3QgYm9keTogbGVuPSIgKyBieXRlcy5sZW5ndGggKyAiLCBoZWFkPSIgKyBoZXhQcmV2aWV3KGJ5dGVzLCA0OCkpOwogICAgbG9nUmF3RHVtcCgicmVxdWVzdCIsIGJ5dGVzLCBjb25maWcpOwogICAgdHJ5IHsKICAgICAgdmFyIGFycGMgPSBwYXJzZUFycGMoYnl0ZXMpOwogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBpbnNwZWN0IHJlcXVlc3QgYXJwYzogdmVyc2lvbj0iICsgYXJwYy52ZXJzaW9uICsgIiwgZnVuY3Rpb25JZD0iICsgYXJwYy5mdW5jdGlvbklkICsgIiwgbG9jYWxlPSIgKyBhcnBjLmxvY2FsZSArICIsIGFwcD0iICsgYXJwYy5hcHBJZGVudGlmaWVyICsgIiwgb3M9IiArIGFycGMub3NWZXJzaW9uICsgIiwgcGF5bG9hZExlbj0iICsgYXJwYy5wYXlsb2FkLmxlbmd0aCk7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGluc3BlY3QgcmVxdWVzdCBwYXlsb2FkOiAiICsgYXBwbGVXTG9jUGF5bG9hZEluc3BlY3QoYXJwYy5wYXlsb2FkKSk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXF1ZXN0IGFycGMgZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2UpOwogICAgICB2YXIgZGlyZWN0RmllbGRzID0gdHJ5UGFyc2VGaWVsZHMoYnl0ZXMpOwogICAgICBpZiAoZGlyZWN0RmllbGRzKSB7CiAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgaW5zcGVjdCByZXF1ZXN0IGRpcmVjdCBmaWVsZHM6ICIgKyBmaWVsZEhpc3RvZ3JhbShkaXJlY3RGaWVsZHMpKTsKICAgICAgfQogICAgfQogIH0KCiAgZnVuY3Rpb24gZG9uZUluc3BlY3QoY29uZmlnLCBoYXNSZXNwb25zZSkgewogICAgaWYgKGhhc1Jlc3BvbnNlKSB7CiAgICAgIGxvZ0h0dHBEdW1wKCJyZXNwb25zZSIsICRyZXNwb25zZSwgY29uZmlnKTsKICAgICAgaW5zcGVjdFJlc3BvbnNlQnl0ZXMobWVzc2FnZUJvZHlUb0J5dGVzKCRyZXNwb25zZSksIGNvbmZpZyk7CiAgICB9IGVsc2UgewogICAgICBsb2dIdHRwRHVtcCgicmVxdWVzdCIsICRyZXF1ZXN0LCBjb25maWcpOwogICAgICBpbnNwZWN0UmVxdWVzdEJ5dGVzKG1lc3NhZ2VCb2R5VG9CeXRlcygkcmVxdWVzdCksIGNvbmZpZyk7CiAgICAgIGlmIChjb25maWcucHJlcGFyZUhlYWRlcnMpIHsKICAgICAgICBkb25lUHJlcGFyZWRSZXF1ZXN0UGFzc1Rocm91Z2goKTsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgIH0KICAgIGRvbmVQYXNzVGhyb3VnaCgpOwogIH0KCiAgZnVuY3Rpb24gZG9uZVJlc3BvbnNlUHJvYmUoY29uZmlnKSB7CiAgICB2YXIgcmVzcG9uc2UgPSB0eXBlb2YgJHJlc3BvbnNlICE9PSAidW5kZWZpbmVkIiA/ICRyZXNwb25zZSA6IHt9OwogICAgdmFyIGhlYWRlcnMgPSByZXNwb25zZS5oZWFkZXJzIHx8IHt9OwogICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwcm9iZSByZXNwb25zZSBrZXlzOiAiICsgb2JqZWN0S2V5cyhyZXNwb25zZSkpOwogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwcm9iZSBoZWFkZXJzOiBzdGF0dXM9IiArIChyZXNwb25zZS5zdGF0dXMgfHwgcmVzcG9uc2Uuc3RhdHVzQ29kZSB8fCAiPG5vbmU+IikgKyAiLCBjb250ZW50LWxlbmd0aD0iICsgKGhlYWRlclZhbHVlKGhlYWRlcnMsICJDb250ZW50LUxlbmd0aCIpIHx8ICI8bm9uZT4iKSArICIsIGNvbnRlbnQtdHlwZT0iICsgKGhlYWRlclZhbHVlKGhlYWRlcnMsICJDb250ZW50LVR5cGUiKSB8fCAiPG5vbmU+IikgKyAiLCBjb250ZW50LWVuY29kaW5nPSIgKyAoaGVhZGVyVmFsdWUoaGVhZGVycywgIkNvbnRlbnQtRW5jb2RpbmciKSB8fCAibm9uZSIpKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcHJvYmUgYm9keSBzbG90czogYm9keT0iICsgdmFsdWVUeXBlKHJlc3BvbnNlLmJvZHkpICsgIi8iICsgdmFsdWVMZW5ndGgocmVzcG9uc2UuYm9keSkgKyAiLCBib2R5Qnl0ZXM9IiArIHZhbHVlVHlwZShyZXNwb25zZS5ib2R5Qnl0ZXMpICsgIi8iICsgdmFsdWVMZW5ndGgocmVzcG9uc2UuYm9keUJ5dGVzKSArICIsIHJhd0JvZHk9IiArIHZhbHVlVHlwZShyZXNwb25zZS5yYXdCb2R5KSArICIvIiArIHZhbHVlTGVuZ3RoKHJlc3BvbnNlLnJhd0JvZHkpICsgIiwgYmluYXJ5Qm9keT0iICsgdmFsdWVUeXBlKHJlc3BvbnNlLmJpbmFyeUJvZHkpICsgIi8iICsgdmFsdWVMZW5ndGgocmVzcG9uc2UuYmluYXJ5Qm9keSkpOwogICAgICB2YXIgYnl0ZXMgPSBtZXNzYWdlQm9keVRvQnl0ZXMocmVzcG9uc2UpOwogICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwcm9iZSBzZWxlY3RlZCBib2R5OiAiICsgKGJ5dGVzID8gYnl0ZXMubGVuZ3RoIDogMCkgKyAiIGJ5dGVzLCBoZWFkPSIgKyAoYnl0ZXMgPyBoZXhQcmV2aWV3KGJ5dGVzLCAzMikgOiAiPG5vbmU+IikpOwogICAgfQogICAgZG9uZVBhc3NUaHJvdWdoKCk7CiAgfQoKICBmdW5jdGlvbiBkb25lU3ludGhldGljUmVzcG9uc2UoYnl0ZXMsIGluZm8pIHsKICAgIHZhciBoZWFkZXJzID0gaGVhZGVyc1dpdGhCaW5hcnlCb2R5KHt9LCBieXRlcy5sZW5ndGgpOwogICAgaWYgKGluZm8gJiYgaW5mby5kZWJ1ZykgewogICAgICBoZWFkZXJzWyJYLUxvY2F0aW9uLVNwb29mZXItV2lmaS1Db3VudCJdID0gU3RyaW5nKGluZm8ud2lmaUNvdW50KTsKICAgICAgaGVhZGVyc1siWC1Mb2NhdGlvbi1TcG9vZmVyLUNlbGwtQ291bnQiXSA9IFN0cmluZyhpbmZvLmNlbGxDb3VudCB8fCAwKTsKICAgIH0KICAgIGlmIChpc0xvb25SdW50aW1lKCkpIHsKICAgICAgJGRvbmUoewogICAgICAgIHN0YXR1czogMjAwLAogICAgICAgIGhlYWRlcnM6IGhlYWRlcnMsCiAgICAgICAgYm9keTogYnl0ZXMKICAgICAgfSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgICRkb25lKHsKICAgICAgcmVzcG9uc2U6IHsKICAgICAgICBzdGF0dXM6IDIwMCwKICAgICAgICBoZWFkZXJzOiBoZWFkZXJzLAogICAgICAgIGJvZHk6IGJ5dGVzCiAgICAgIH0KICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gZG9uZVJld3JpdGVSZXNwb25zZShieXRlcywgaW5mbykgewogICAgdmFyIHNvdXJjZUhlYWRlcnMgPSB0eXBlb2YgJHJlc3BvbnNlICE9PSAidW5kZWZpbmVkIiA/ICRyZXNwb25zZS5oZWFkZXJzIDoge307CiAgICB2YXIgaGVhZGVycyA9IGhlYWRlcnNXaXRoQmluYXJ5Qm9keShzb3VyY2VIZWFkZXJzLCBieXRlcy5sZW5ndGgpOwogICAgaWYgKGluZm8gJiYgaW5mby5kZWJ1ZykgewogICAgICBoZWFkZXJzWyJYLUxvY2F0aW9uLVNwb29mZXItV2lmaS1Db3VudCJdID0gU3RyaW5nKGluZm8ud2lmaUNvdW50KTsKICAgICAgaGVhZGVyc1siWC1Mb2NhdGlvbi1TcG9vZmVyLUNlbGwtQ291bnQiXSA9IFN0cmluZyhpbmZvLmNlbGxDb3VudCB8fCAwKTsKICAgIH0KICAgIGlmIChpbmZvICYmIGluZm8udGFyZ2V0TGF0ICE9IG51bGwgJiYgaW5mby50YXJnZXRMbmcgIT0gbnVsbCkgewogICAgICBoZWFkZXJzWyJYLUxvY2F0aW9uLVNwb29mZXItVGFyZ2V0Il0gPSBTdHJpbmcoaW5mby50YXJnZXRMYXQpICsgIiwiICsgU3RyaW5nKGluZm8udGFyZ2V0TG5nKTsKICAgIH0KICAgIGlmIChpc0xvb25SdW50aW1lKCkpIHsKICAgICAgJGRvbmUoewogICAgICAgIHN0YXR1czogKCRyZXNwb25zZSAmJiAkcmVzcG9uc2Uuc3RhdHVzKSB8fCAyMDAsCiAgICAgICAgaGVhZGVyczogaGVhZGVycywKICAgICAgICBib2R5OiBieXRlcwogICAgICB9KTsKICAgICAgcmV0dXJuOwogICAgfQogICAgJGRvbmUoewogICAgICBoZWFkZXJzOiBoZWFkZXJzLAogICAgICBib2R5OiBieXRlcwogICAgfSk7CiAgfQoKICBmdW5jdGlvbiBjb250aW51ZVJlc3BvbnNlUmV3cml0ZShjb25maWcpIHsKICAgIHZhciByZXNwb25zZUJvZHkgPSBtZXNzYWdlQm9keVRvQnl0ZXMoJHJlc3BvbnNlKTsKICAgIGlmICghcmVzcG9uc2VCb2R5IHx8IHJlc3BvbnNlQm9keS5sZW5ndGggPCAyKSB7CiAgICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgICBjb25zb2xlLmxvZygKICAgICAgICAgICJMb2NhdGlvbiBzcG9vZmVyIHJlc3BvbnNlIGJvZHkgdG9vIHNob3J0OiAiICsKICAgICAgICAgICAgKHJlc3BvbnNlQm9keSA/IHJlc3BvbnNlQm9keS5sZW5ndGggOiAwKSArCiAgICAgICAgICAgICIgYnl0ZXMsIGhlYWQ9IiArCiAgICAgICAgICAgIChyZXNwb25zZUJvZHkgPyBoZXhQcmV2aWV3KHJlc3BvbnNlQm9keSkgOiAiPG5vbmU+IikKICAgICAgICApOwogICAgICB9CiAgICAgIGRvbmVQYXNzVGhyb3VnaCgpOwogICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHJlc3BvbnNlIGJvZHk6ICIgKyByZXNwb25zZUJvZHkubGVuZ3RoICsgIiBieXRlcywgaGVhZD0iICsgaGV4UHJldmlldyhyZXNwb25zZUJvZHksIDMyKSk7CiAgICAgIGlmIChpc0xvb25SdW50aW1lKCkpIHsKICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBydW50aW1lOiBMb29uIik7CiAgICAgIH0KICAgIH0KICAgIGxvZ0h0dHBEdW1wKCJyZXNwb25zZS1vcmlnaW5hbCIsICRyZXNwb25zZSwgY29uZmlnKTsKICAgIGxvZ1Jhd0R1bXAoInJlc3BvbnNlLW9yaWdpbmFsIiwgcmVzcG9uc2VCb2R5LCBjb25maWcpOwogICAgdmFyIHJlc3BvbnNlUmVzdWx0ID0gc3Bvb2ZBcHBsZVJlc3BvbnNlKHJlc3BvbnNlQm9keSwgY29uZmlnKTsKICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgY29uc29sZS5sb2coCiAgICAgICAgIkxvY2F0aW9uIHNwb29mZXIgcGF0Y2hlZCAiICsKICAgICAgICAgIHJlc3BvbnNlUmVzdWx0LndpZmlDb3VudCArCiAgICAgICAgICAiIHdpZmkgZGV2aWNlcywgIiArCiAgICAgICAgICByZXNwb25zZVJlc3VsdC5jZWxsQ291bnQgKwogICAgICAgICAgIiBjZWxsIHRvd2Vycywga2luZD0iICsKICAgICAgICAgIHJlc3BvbnNlUmVzdWx0LmtpbmQgKwogICAgICAgICAgIiwgcHJlZml4PSIgKwogICAgICAgICAgKHJlc3BvbnNlUmVzdWx0LnByZWZpeCB8fCAiPG5vbmU+IikgKwogICAgICAgICAgIiwgcmVzcG9uc2U9IiArCiAgICAgICAgICByZXNwb25zZVJlc3VsdC5yZXNwb25zZS5sZW5ndGggKwogICAgICAgICAgIiBieXRlcyIKICAgICAgKTsKICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcGF0Y2hlZCBsb2NhdGlvbnM6ICIgKyBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocmVzcG9uc2VSZXN1bHQucGF5bG9hZCkpOwogICAgfQogICAgbG9nUmF3RHVtcCgicmVzcG9uc2UtcGF0Y2hlZCIsIHJlc3BvbnNlUmVzdWx0LnJlc3BvbnNlLCBjb25maWcpOwogICAgZG9uZVJld3JpdGVSZXNwb25zZShyZXNwb25zZVJlc3VsdC5yZXNwb25zZSwgewogICAgICB3aWZpQ291bnQ6IHJlc3BvbnNlUmVzdWx0LndpZmlDb3VudCwKICAgICAgY2VsbENvdW50OiByZXNwb25zZVJlc3VsdC5jZWxsQ291bnQsCiAgICAgIGRlYnVnOiBjb25maWcuZGVidWcsCiAgICAgIHRhcmdldExhdDogY29uZmlnLmxhdGl0dWRlLAogICAgICB0YXJnZXRMbmc6IGNvbmZpZy5sb25naXR1ZGUKICAgIH0pOwogIH0KCiAgZnVuY3Rpb24gcHJlcGFyZVJlc3BvbnNlQm9keShjb25maWcpIHsKICAgIHByZXBhcmVSZXNwb25zZUJvZHlTeW5jKGNvbmZpZyk7CiAgfQoKICBmdW5jdGlvbiBydW5TaGFkb3dyb2NrZXQoKSB7CiAgICB2YXIgaGFzUmVxdWVzdCA9IHR5cGVvZiAkcmVxdWVzdCAhPT0gInVuZGVmaW5lZCIgJiYgJHJlcXVlc3QgIT0gbnVsbDsKICAgIHZhciBoYXNSZXNwb25zZSA9IHR5cGVvZiAkcmVzcG9uc2UgIT09ICJ1bmRlZmluZWQiICYmICRyZXNwb25zZSAhPSBudWxsOwoKICAgIGlmICghaGFzUmVxdWVzdCAmJiAhaGFzUmVzcG9uc2UpIHsKICAgICAgcnVuTWFpbnRlbmFuY2VDcm9uKCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAoaGFzUmVxdWVzdCAmJiAhaGFzUmVzcG9uc2UpIHsKICAgICAgdmFyIHByZXBBcmdzID0gcmVhZFNjcmlwdEFyZ3VtZW50cygpOwogICAgICBpZiAocGFyc2VCb29sZWFuKHByZXBBcmdzLmRlYnVnLCBmYWxzZSkpIHsKICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwcmVwYXJlIC0+IEFjY2VwdC1FbmNvZGluZzogaWRlbnRpdHkiKTsKICAgICAgfQogICAgICBkb25lUHJlcGFyZWRSZXF1ZXN0UGFzc1Rocm91Z2goKTsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGxvYWRSdW50aW1lQ29uZmlnKGZ1bmN0aW9uIChjb25maWcpIHsKICAgICAgdHJ5IHsKICAgICAgICBpZiAoIWNvbmZpZy5lbmFibGVkKSB7CiAgICAgICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CgogICAgICAgIGlmIChjb25maWcubW9kZSA9PT0gImluc3BlY3QiKSB7CiAgICAgICAgICBkb25lSW5zcGVjdChjb25maWcsIGhhc1Jlc3BvbnNlKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CgogICAgICAgIGlmIChoYXNSZXNwb25zZSkgewogICAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICAgICAgICBjb25zb2xlLmxvZygKICAgICAgICAgICAgICAiTG9jYXRpb24gc3Bvb2ZlciBpbnRlcmNlcHQgLT4gbGF0PSIgKwogICAgICAgICAgICAgICAgY29uZmlnLmxhdGl0dWRlICsKICAgICAgICAgICAgICAgICIsIGxuZz0iICsKICAgICAgICAgICAgICAgIGNvbmZpZy5sb25naXR1ZGUgKwogICAgICAgICAgICAgICAgIiwgdXJsPSIgKwogICAgICAgICAgICAgICAgKCgkcmVxdWVzdCAmJiAkcmVxdWVzdC51cmwpIHx8ICI8bm9uZT4iKQogICAgICAgICAgICApOwogICAgICAgICAgfQogICAgICAgICAgaWYgKGNvbmZpZy5tb2RlID09PSAicHJvYmUiKSB7CiAgICAgICAgICAgIGRvbmVSZXNwb25zZVByb2JlKGNvbmZpZyk7CiAgICAgICAgICAgIHJldHVybjsKICAgICAgICAgIH0KICAgICAgICAgIGlmIChjb25maWcubW9kZSAhPT0gInJlc3BvbnNlIikgewogICAgICAgICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgICAgICAgcmV0dXJuOwogICAgICAgICAgfQogICAgICAgICAgcHJlcGFyZVJlc3BvbnNlQm9keShjb25maWcpOwogICAgICAgICAgY29udGludWVSZXNwb25zZVJld3JpdGUoY29uZmlnKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CgogICAgICAgIGlmIChjb25maWcubW9kZSAhPT0gInJlcXVlc3QiKSB7CiAgICAgICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgdmFyIHJlcXVlc3RCb2R5ID0gbWVzc2FnZUJvZHlUb0J5dGVzKCRyZXF1ZXN0KTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciByZXF1ZXN0IG1vZGUgYm9keSBsZW5ndGg6ICIgKyAocmVxdWVzdEJvZHkgPyByZXF1ZXN0Qm9keS5sZW5ndGggOiAwKSk7CiAgICAgICAgfQogICAgICAgIGlmICghcmVxdWVzdEJvZHkpIHsKICAgICAgICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVxdWVzdCBib2R5IHVuYXZhaWxhYmxlIik7CiAgICAgICAgICB9CiAgICAgICAgICBkb25lUGFzc1Rocm91Z2goKTsKICAgICAgICAgIHJldHVybjsKICAgICAgICB9CiAgICAgICAgaWYgKHJlcXVlc3RCb2R5Lmxlbmd0aCA8IDIpIHsKICAgICAgICAgIGlmIChjb25maWcuZGVidWcpIHsKICAgICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVxdWVzdCBib2R5IHRvbyBzaG9ydDogIiArIHJlcXVlc3RCb2R5Lmxlbmd0aCArICIgYnl0ZXMsIGhlYWQ9IiArIGhleFByZXZpZXcocmVxdWVzdEJvZHkpKTsKICAgICAgICAgIH0KICAgICAgICAgIGRvbmVQYXNzVGhyb3VnaCgpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICBsb2dIdHRwRHVtcCgicmVxdWVzdC1vcmlnaW5hbCIsICRyZXF1ZXN0LCBjb25maWcpOwogICAgICAgIGxvZ1Jhd0R1bXAoInJlcXVlc3Qtb3JpZ2luYWwiLCByZXF1ZXN0Qm9keSwgY29uZmlnKTsKICAgICAgICB2YXIgcmVxdWVzdFJlc3VsdCA9IHNwb29mQXJwY1JlcXVlc3QocmVxdWVzdEJvZHksIGNvbmZpZyk7CiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZykgewogICAgICAgICAgY29uc29sZS5sb2coIkxvY2F0aW9uIHNwb29mZXIgcmVxdWVzdCBzeW50aGV0aWMgcmVzcG9uc2U6IHBhdGNoZWQgIiArIHJlcXVlc3RSZXN1bHQud2lmaUNvdW50ICsgIiB3aWZpIGRldmljZXMsICIgKyByZXF1ZXN0UmVzdWx0LmNlbGxDb3VudCArICIgY2VsbCB0b3dlcnMsIHJlc3BvbnNlPSIgKyByZXF1ZXN0UmVzdWx0LnJlc3BvbnNlLmxlbmd0aCArICIgYnl0ZXMiKTsKICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIHBhdGNoZWQgbG9jYXRpb25zOiAiICsgcGF0Y2hlZFBheWxvYWRTdW1tYXJ5KHJlcXVlc3RSZXN1bHQucGF5bG9hZCkpOwogICAgICAgIH0KICAgICAgICBsb2dSYXdEdW1wKCJyZXF1ZXN0LXN5bnRoZXRpYy1yZXNwb25zZSIsIHJlcXVlc3RSZXN1bHQucmVzcG9uc2UsIGNvbmZpZyk7CiAgICAgICAgZG9uZVN5bnRoZXRpY1Jlc3BvbnNlKHJlcXVlc3RSZXN1bHQucmVzcG9uc2UsIHsKICAgICAgICAgIHdpZmlDb3VudDogcmVxdWVzdFJlc3VsdC53aWZpQ291bnQsCiAgICAgICAgICBjZWxsQ291bnQ6IHJlcXVlc3RSZXN1bHQuY2VsbENvdW50LAogICAgICAgICAgZGVidWc6IGNvbmZpZy5kZWJ1ZwogICAgICAgIH0pOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSB7CiAgICAgICAgICB2YXIgZGlhZ0JvZHkgPSBoYXNSZXNwb25zZSA/IG1lc3NhZ2VCb2R5VG9CeXRlcygkcmVzcG9uc2UpIDogbWVzc2FnZUJvZHlUb0J5dGVzKCRyZXF1ZXN0KTsKICAgICAgICAgIGNvbnNvbGUubG9nKCJMb2NhdGlvbiBzcG9vZmVyIGZhaWxlZDogIiArIGVyci5tZXNzYWdlICsgIiB8IGJvZHlMZW49IiArIChkaWFnQm9keSA/IGRpYWdCb2R5Lmxlbmd0aCA6IDApICsgIiBoZWFkPSIgKyAoZGlhZ0JvZHkgPyBoZXhQcmV2aWV3KGRpYWdCb2R5LCAzMikgOiAiPG5vbmU+IikpOwogICAgICAgIH0KICAgICAgICBpZiAoY29uZmlnLmZhaWxPcGVuICE9PSBmYWxzZSkgewogICAgICAgICAgZG9uZVBhc3NUaHJvdWdoKCk7CiAgICAgICAgICByZXR1cm47CiAgICAgICAgfQogICAgICAgICRkb25lKHsKICAgICAgICAgIHJlc3BvbnNlOiB7CiAgICAgICAgICAgIHN0YXR1czogIkhUVFAvMS4xIDUwMCBJbnRlcm5hbCBTZXJ2ZXIgRXJyb3IiLAogICAgICAgICAgICBoZWFkZXJzOiB7ICJDb250ZW50LVR5cGUiOiAidGV4dC9wbGFpbiIgfSwKICAgICAgICAgICAgYm9keTogImxvY2F0aW9uIHNwb29mZXIgZmFpbGVkOiAiICsgZXJyLm1lc3NhZ2UKICAgICAgICAgIH0KICAgICAgICB9KTsKICAgICAgfQogICAgfSk7CiAgfQoKICB2YXIgYXBpID0gewogICAgREVGQVVMVF9DT05GSUc6IERFRkFVTFRfQ09ORklHLAogICAgQVBQTEVfV0xPQ19QUkVGSVg6IEFQUExFX1dMT0NfUFJFRklYLAogICAgQVBQTEVfV0xPQ19NQVJLRVI6IEFQUExFX1dMT0NfTUFSS0VSLAogICAgYm9keVRvQnl0ZXM6IGJvZHlUb0J5dGVzLAogICAgbWVzc2FnZUJvZHlUb0J5dGVzOiBtZXNzYWdlQm9keVRvQnl0ZXMsCiAgICBoZXhQcmV2aWV3OiBoZXhQcmV2aWV3LAogICAgYnl0ZXNUb0JpbmFyeVN0cmluZzogYnl0ZXNUb0JpbmFyeVN0cmluZywKICAgIGJ5dGVzVG9CYXNlNjQ6IGJ5dGVzVG9CYXNlNjQsCiAgICBiaW5hcnlTdHJpbmdUb0J5dGVzOiBiaW5hcnlTdHJpbmdUb0J5dGVzLAogICAgY29uY2F0Qnl0ZXM6IGNvbmNhdEJ5dGVzLAogICAgcmVhZFVJbnQxNkJFOiByZWFkVUludDE2QkUsCiAgICB3cml0ZVVJbnQxNkJFOiB3cml0ZVVJbnQxNkJFLAogICAgZW5jb2RlVmFyaW50VW5zaWduZWQ6IGVuY29kZVZhcmludFVuc2lnbmVkLAogICAgZW5jb2RlVmFyaW50U2lnbmVkSW50NjQ6IGVuY29kZVZhcmludFNpZ25lZEludDY0LAogICAgZGVjb2RlVmFyaW50OiBkZWNvZGVWYXJpbnQsCiAgICBtYWtlVmFyaW50RmllbGQ6IG1ha2VWYXJpbnRGaWVsZCwKICAgIG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZDogbWFrZUxlbmd0aERlbGltaXRlZEZpZWxkLAogICAgcGFyc2VGaWVsZHM6IHBhcnNlRmllbGRzLAogICAgdHJ5UGFyc2VGaWVsZHM6IHRyeVBhcnNlRmllbGRzLAogICAgZmlyc3RGaWVsZEJ5TnVtYmVyOiBmaXJzdEZpZWxkQnlOdW1iZXIsCiAgICBsb2NhdGlvblN1bW1hcnk6IGxvY2F0aW9uU3VtbWFyeSwKICAgIHBhdGNoZWRQYXlsb2FkU3VtbWFyeTogcGF0Y2hlZFBheWxvYWRTdW1tYXJ5LAogICAgY29vcmRUb0ludDogY29vcmRUb0ludCwKICAgIG5vcm1hbGl6ZUNvbmZpZzogbm9ybWFsaXplQ29uZmlnLAogICAgcGF0Y2hMb2NhdGlvbjogcGF0Y2hMb2NhdGlvbiwKICAgIHBhdGNoV2lmaURldmljZTogcGF0Y2hXaWZpRGV2aWNlLAogICAgcGF0Y2hDZWxsVG93ZXI6IHBhdGNoQ2VsbFRvd2VyLAogICAgcGF0Y2hBcHBsZVdMb2NQYXlsb2FkOiBwYXRjaEFwcGxlV0xvY1BheWxvYWQsCiAgICBwYXJzZUFycGM6IHBhcnNlQXJwYywKICAgIHNlcmlhbGl6ZUFycGM6IHNlcmlhbGl6ZUFycGMsCiAgICBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlOiBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlLAogICAgZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQ6IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkLAogICAgc3Bvb2ZBcnBjUmVxdWVzdDogc3Bvb2ZBcnBjUmVxdWVzdCwKICAgIHNwb29mQXBwbGVSZXNwb25zZTogc3Bvb2ZBcHBsZVJlc3BvbnNlLAogICAgcGFyc2VBcmd1bWVudFN0cmluZzogcGFyc2VBcmd1bWVudFN0cmluZywKICAgIHJlYWRTY3JpcHRBcmd1bWVudHM6IHJlYWRTY3JpcHRBcmd1bWVudHMsCiAgICBnZW9jb2RlQWRkcmVzczogZ2VvY29kZUFkZHJlc3MsCiAgICBwcmVwYXJlUmVxdWVzdEhlYWRlcnM6IHByZXBhcmVSZXF1ZXN0SGVhZGVycwogIH07CgogIGlmICh0eXBlb2YgbW9kdWxlICE9PSAidW5kZWZpbmVkIiAmJiBtb2R1bGUuZXhwb3J0cykgewogICAgbW9kdWxlLmV4cG9ydHMgPSBhcGk7CiAgfSBlbHNlIHsKICAgIHJ1blNoYWRvd3JvY2tldCgpOwogIH0KfSgpKTsK";
const LOCATION_SETTINGS_B64 = "LyoKICogbG9jYXRpb24tc2V0dGluZ3MuanMg4oCUIHN0YXRlbGVzcyBzYXZlLWludGVyY2VwdG9yIGZvciBpT1MgTG9jYXRpb24gU3Bvb2Zlci4KICoKICogUnVucyBhcyBhbiBodHRwLVJFUVVFU1Qgc2NyaXB0IG9uIGdzLWxvYy5hcHBsZS5jb20vaWxzLXNldHRpbmdzL+KApiBhbmQgYW5zd2VycyB0aGUKICogcmVxdWVzdCBpdHNlbGYgKG5ldmVyIGhpdHMgQXBwbGUpLiBJdCB3cml0ZXMgdGhlIHBpY2tlZCBwb2ludCBpbnRvIFRISVMgZGV2aWNlJ3Mgb3duCiAqICRwZXJzaXN0ZW50U3RvcmUsIHVzaW5nIHRoZSBleGFjdCBrZXlzIGxvY2F0aW9uLXNwb29mZXIuanMgYWxyZWFkeSByZWFkcyB2aWEKICogZW5yaWNoQXJnc0Zyb21QbHVnaW5TdG9yZTogYGxhdGl0dWRlYCwgYGxvbmdpdHVkZWAsIGBhbHRpdHVkZWAsIGBlbmFibGVkYC4KICoKICogTm90aGluZyBpcyBzdG9yZWQgc2VydmVyLXNpZGUsIHNvIG9uZSBwdWJsaWMgcGlja2VyIHBhZ2UgY2FuIGJlIHNoYXJlZCBieSBhbnkgbnVtYmVyIG9mCiAqIHBlb3BsZSDigJQgZWFjaCBwZXJzb24gd3JpdGVzIG9ubHkgdGhlaXIgb3duIGRldmljZS4gYGVuYWJsZWRgIGdhdGVzIHNwb29maW5nOiBjbGVhcmVkIC8KICogbmV2ZXItcGlja2VkIOKGkiBlbmFibGVkPWZhbHNlIOKGkiBsb2NhdGlvbi1zcG9vZmVyLmpzIHBhc3NlcyB0aHJvdWdoIHRoZSByZWFsIGxvY2F0aW9uCiAqICh0aGlzIHBhaXJzIHdpdGggREVGQVVMVF9DT05GSUcuZW5hYmxlZD1mYWxzZSBpbiBsb2NhdGlvbi1zcG9vZmVyLmpzKS4KICoKICogICBHRVQg4oCmL2lscy1zZXR0aW5ncy9zYXZlP2xhdD0mbG9uPSZhbHQ9ICAg4oaSIHN0b3JlIGNvb3JkcyAoK2FsdGl0dWRlKSBhbmQgZW5hYmxlCiAqICAgR0VUIOKApi9pbHMtc2V0dGluZ3Mvc2F2ZT9hY3Rpb249cXVlcnkgICAgICDihpIgcmV0dXJuIHRoZSBkZXZpY2UncyBjdXJyZW50IHN0b3JlZCBwb2ludAogKiAgIEdFVCDigKYvaWxzLXNldHRpbmdzL3NhdmU/YWN0aW9uPWNsZWFyICAgICAg4oaSIGVuYWJsZWQ9ZmFsc2UgKHJlc3RvcmUgcmVhbCBsb2NhdGlvbikKICoKICogU3VwcG9ydGVkIGNsaWVudHM6IFN1cmdlIC8gU2hhZG93cm9ja2V0IC8gTG9vbiAvIFN0YXNoIC8gRWdlcm4gKCRwZXJzaXN0ZW50U3RvcmUpIGFuZAogKiBRdWFudHVtdWx0IFggKCRwcmVmcykuCiAqLwooZnVuY3Rpb24gKCkgewogICJ1c2Ugc3RyaWN0IjsKCiAgdmFyIGlzUXVhblggPSB0eXBlb2YgJHRhc2sgIT09ICJ1bmRlZmluZWQiOwoKICBmdW5jdGlvbiByZWFkS2V5KGspIHsKICAgIHRyeSB7CiAgICAgIHJldHVybiBpc1F1YW5YID8gJHByZWZzLnZhbHVlRm9yS2V5KGspIDogJHBlcnNpc3RlbnRTdG9yZS5yZWFkKGspOwogICAgfSBjYXRjaCAoZSkgewogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CiAgZnVuY3Rpb24gd3JpdGVLZXkoaywgdikgewogICAgdHJ5IHsKICAgICAgcmV0dXJuIGlzUXVhblggPyAkcHJlZnMuc2V0VmFsdWVGb3JLZXkoU3RyaW5nKHYpLCBrKSA6ICRwZXJzaXN0ZW50U3RvcmUud3JpdGUoU3RyaW5nKHYpLCBrKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgcmV0dXJuIGZhbHNlOwogICAgfQogIH0KCiAgZnVuY3Rpb24gcGFyc2VRdWVyeSh1cmwpIHsKICAgIHZhciBvdXQgPSB7fTsKICAgIHZhciBxaSA9IHVybC5pbmRleE9mKCI/Iik7CiAgICBpZiAocWkgPCAwKSByZXR1cm4gb3V0OwogICAgdmFyIHBhcnRzID0gdXJsLnNsaWNlKHFpICsgMSkuc3BsaXQoIiYiKTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpICs9IDEpIHsKICAgICAgaWYgKCFwYXJ0c1tpXSkgY29udGludWU7CiAgICAgIHZhciBlcSA9IHBhcnRzW2ldLmluZGV4T2YoIj0iKTsKICAgICAgdmFyIGsgPSBlcSA8IDAgPyBwYXJ0c1tpXSA6IHBhcnRzW2ldLnNsaWNlKDAsIGVxKTsKICAgICAgdmFyIHYgPSBlcSA8IDAgPyAiIiA6IHBhcnRzW2ldLnNsaWNlKGVxICsgMSk7CiAgICAgIHRyeSB7IGsgPSBkZWNvZGVVUklDb21wb25lbnQoay5yZXBsYWNlKC9cKy9nLCAiICIpKTsgfSBjYXRjaCAoZSkge30KICAgICAgdHJ5IHsgdiA9IGRlY29kZVVSSUNvbXBvbmVudCh2LnJlcGxhY2UoL1wrL2csICIgIikpOyB9IGNhdGNoIChlKSB7fQogICAgICBpZiAoIShrIGluIG91dCkpIG91dFtrXSA9IHY7CiAgICB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gZmluaXRlTnVtKHMpIHsKICAgIGlmIChzID09IG51bGwgfHwgcyA9PT0gIiIpIHJldHVybiBOYU47CiAgICB2YXIgbiA9IHBhcnNlRmxvYXQocyk7CiAgICByZXR1cm4gaXNGaW5pdGUobikgPyBuIDogTmFOOwogIH0KCiAgdmFyIHVybCA9ICh0eXBlb2YgJHJlcXVlc3QgIT09ICJ1bmRlZmluZWQiICYmICRyZXF1ZXN0ICYmICRyZXF1ZXN0LnVybCkgfHwgIiI7CiAgdmFyIHEgPSBwYXJzZVF1ZXJ5KHVybCk7CiAgdmFyIGFjdGlvbiA9IHEuYWN0aW9uIHx8ICJzYXZlIjsKICB2YXIgcmVzdWx0OwoKICBpZiAoYWN0aW9uID09PSAicXVlcnkiKSB7CiAgICB2YXIgcWxhdCA9IHJlYWRLZXkoImxhdGl0dWRlIik7CiAgICB2YXIgcWxvbiA9IHJlYWRLZXkoImxvbmdpdHVkZSIpOwogICAgdmFyIHFhbHQgPSByZWFkS2V5KCJhbHRpdHVkZSIpOwogICAgdmFyIHFlbiA9IHJlYWRLZXkoImVuYWJsZWQiKTsKICAgIHZhciBxaGFjYyA9IHJlYWRLZXkoImhvcml6b250YWxBY2N1cmFjeSIpOwogICAgdmFyIHF2YWNjID0gcmVhZEtleSgidmVydGljYWxBY2N1cmFjeSIpOwogICAgdmFyIHFyciA9IHJlYWRLZXkoInJhbmRvbVJhZGl1cyIpOwogICAgaWYgKHFsYXQgIT0gbnVsbCAmJiBxbGF0ICE9PSAiIiAmJiBxbG9uICE9IG51bGwgJiYgcWxvbiAhPT0gIiIpIHsKICAgICAgcmVzdWx0ID0gewogICAgICAgIHN1Y2Nlc3M6IHRydWUsCiAgICAgICAgbGF0aXR1ZGU6IE51bWJlcihxbGF0KSwKICAgICAgICBsb25naXR1ZGU6IE51bWJlcihxbG9uKSwKICAgICAgICBhbHRpdHVkZTogcWFsdCAhPSBudWxsICYmIHFhbHQgIT09ICIiID8gTnVtYmVyKHFhbHQpIDogbnVsbCwKICAgICAgICBob3Jpem9udGFsQWNjdXJhY3k6IHFoYWNjICE9IG51bGwgJiYgcWhhY2MgIT09ICIiID8gTnVtYmVyKHFoYWNjKSA6IG51bGwsCiAgICAgICAgdmVydGljYWxBY2N1cmFjeTogcXZhY2MgIT0gbnVsbCAmJiBxdmFjYyAhPT0gIiIgPyBOdW1iZXIocXZhY2MpIDogbnVsbCwKICAgICAgICByYW5kb21SYWRpdXM6IHFyciAhPSBudWxsICYmIHFyciAhPT0gIiIgPyBOdW1iZXIocXJyKSA6IG51bGwsCiAgICAgICAgZW5hYmxlZDogU3RyaW5nKHFlbikgPT09ICJ0cnVlIgogICAgICB9OwogICAgfSBlbHNlIHsKICAgICAgcmVzdWx0ID0geyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6ICJObyBzYXZlZCBjb29yZGluYXRlcyIgfTsKICAgIH0KICB9IGVsc2UgaWYgKGFjdGlvbiA9PT0gImNsZWFyIikgewogICAgd3JpdGVLZXkoImVuYWJsZWQiLCAiZmFsc2UiKTsKICAgIHJlc3VsdCA9IHsgc3VjY2VzczogdHJ1ZSB9OwogIH0gZWxzZSB7CiAgICB2YXIgbG9uID0gZmluaXRlTnVtKHEubG9uICE9IG51bGwgPyBxLmxvbiA6IHEubG9uZ2l0dWRlKTsKICAgIHZhciBsYXQgPSBmaW5pdGVOdW0ocS5sYXQgIT0gbnVsbCA/IHEubGF0IDogcS5sYXRpdHVkZSk7CiAgICB2YXIgYWx0ID0gZmluaXRlTnVtKHEuYWx0ICE9IG51bGwgPyBxLmFsdCA6IHEuYWx0aXR1ZGUpOwogICAgdmFyIGhhY2MgPSBmaW5pdGVOdW0ocS5oYWNjICE9IG51bGwgPyBxLmhhY2MgOiBxLmhvcml6b250YWxBY2N1cmFjeSk7CiAgICB2YXIgdmFjYyA9IGZpbml0ZU51bShxLnZhY2MgIT0gbnVsbCA/IHEudmFjYyA6IHEudmVydGljYWxBY2N1cmFjeSk7CiAgICB2YXIgcnIgPSBmaW5pdGVOdW0ocS5yciAhPSBudWxsID8gcS5yciA6IHEucmFuZG9tUmFkaXVzKTsKICAgIGlmIChpc0Zpbml0ZShsb24pICYmIGlzRmluaXRlKGxhdCkpIHsKICAgICAgd3JpdGVLZXkoImxhdGl0dWRlIiwgU3RyaW5nKGxhdCkpOwogICAgICB3cml0ZUtleSgibG9uZ2l0dWRlIiwgU3RyaW5nKGxvbikpOwogICAgICBpZiAoaXNGaW5pdGUoYWx0KSkgd3JpdGVLZXkoImFsdGl0dWRlIiwgU3RyaW5nKE1hdGgucm91bmQoYWx0KSkpOwogICAgICBpZiAoaXNGaW5pdGUoaGFjYykpIHdyaXRlS2V5KCJob3Jpem9udGFsQWNjdXJhY3kiLCBTdHJpbmcoTWF0aC5yb3VuZChoYWNjKSkpOwogICAgICBpZiAoaXNGaW5pdGUodmFjYykpIHdyaXRlS2V5KCJ2ZXJ0aWNhbEFjY3VyYWN5IiwgU3RyaW5nKE1hdGgucm91bmQodmFjYykpKTsKICAgICAgLy8gcmFuZG9tUmFkaXVzOiAwIGlzIGEgdmFsaWQgdmFsdWUgKG9mZiksIHNvIHdyaXRlIHdoZW5ldmVyIHRoZSBwaWNrZXIgc2VuZHMgaXQuCiAgICAgIGlmIChpc0Zpbml0ZShycikpIHdyaXRlS2V5KCJyYW5kb21SYWRpdXMiLCBTdHJpbmcoTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChycikpKSk7CiAgICAgIHdyaXRlS2V5KCJlbmFibGVkIiwgInRydWUiKTsKICAgICAgcmVzdWx0ID0geyBzdWNjZXNzOiB0cnVlLCBsYXRpdHVkZTogbGF0LCBsb25naXR1ZGU6IGxvbiB9OwogICAgICBpZiAoaXNGaW5pdGUoYWx0KSkgcmVzdWx0LmFsdGl0dWRlID0gTWF0aC5yb3VuZChhbHQpOwogICAgICBpZiAoaXNGaW5pdGUoaGFjYykpIHJlc3VsdC5ob3Jpem9udGFsQWNjdXJhY3kgPSBNYXRoLnJvdW5kKGhhY2MpOwogICAgICBpZiAoaXNGaW5pdGUodmFjYykpIHJlc3VsdC52ZXJ0aWNhbEFjY3VyYWN5ID0gTWF0aC5yb3VuZCh2YWNjKTsKICAgICAgaWYgKGlzRmluaXRlKHJyKSkgcmVzdWx0LnJhbmRvbVJhZGl1cyA9IE1hdGgubWF4KDAsIE1hdGgucm91bmQocnIpKTsKICAgIH0gZWxzZSB7CiAgICAgIHJlc3VsdCA9IHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiAibWlzc2luZyBsYXQvbG9uIHBhcmFtZXRlcnMiIH07CiAgICB9CiAgfQoKICB2YXIgaGVhZGVycyA9IHsKICAgICJDb250ZW50LVR5cGUiOiAiYXBwbGljYXRpb24vanNvbiIsCiAgICAiQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luIjogIioiLAogICAgIkFjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMiOiAiR0VULCBPUFRJT05TIgogIH07CiAgdmFyIGJvZHkgPSBKU09OLnN0cmluZ2lmeShyZXN1bHQpOwoKICBpZiAoaXNRdWFuWCkgewogICAgJGRvbmUoeyBzdGF0dXM6ICJIVFRQLzEuMSAyMDAgT0siLCBoZWFkZXJzOiBoZWFkZXJzLCBib2R5OiBib2R5IH0pOwogIH0gZWxzZSB7CiAgICAkZG9uZSh7IHJlc3BvbnNlOiB7IHN0YXR1czogMjAwLCBoZWFkZXJzOiBoZWFkZXJzLCBib2R5OiBib2R5IH0gfSk7CiAgfQp9KSgpOwo=";
const LOCATION_SPOOFER_QX_B64 = "LyoKICogUVgg55qEICRyZXNwb25zZS5ib2R5IOe7meeahOaYryBiYXNlNjQg5a2X56ym5Liy77yI5LiN5pivIFVpbnQ4QXJyYXnvvInvvIwKICog5omA5Lul6L+Z54mI5aSa5LqG5LiA5q2lIGJhc2U2NCDihpQgYnl0ZXMg55qE6L2s5o2i77yM5YW25LuW6YC76L6R5ZKM5Li754mI5LiA5qC344CCCiAqLwooZnVuY3Rpb24gKCkgewogICJ1c2Ugc3RyaWN0IjsKCiAgdmFyIERFRkFVTFRfQ09ORklHID0gewogICAgLy8gU3RhdGVsZXNzIGRlZmF1bHQ6IE9GRiB1bnRpbCB0aGUgcGlja2VyIHdyaXRlcyBjb29yZGluYXRlcyB0byB0aGlzIGRldmljZSdzIG93bgogICAgLy8gJHByZWZzLiAiTm90aGluZyBwaWNrZWQgeWV0IiB0aGVuIGZhbGxzIHRocm91Z2ggdG8gdGhlIHJlYWwgbG9jYXRpb24uCiAgICBlbmFibGVkOiBmYWxzZSwKICAgIGxhdGl0dWRlOiAzNy4zMzQ5LAogICAgbG9uZ2l0dWRlOiAtMTIyLjAwOTAyLAogICAgaG9yaXpvbnRhbEFjY3VyYWN5OiAzOSwKICAgIHZlcnRpY2FsQWNjdXJhY3k6IDEwMDAsCiAgICAvLyBSYW5kb20gcGVydHVyYmF0aW9uIHJhZGl1cyBpbiBtZXRyZXMgKFl1OTE5MSB2MS4xICLmibDliqjljYrlvoQiKS4gMCA9IG9mZi4gV3JpdHRlbgogICAgLy8gcGVyLWRldmljZSBieSB0aGUgcGlja2VyIHZpYSBsb2NhdGlvbi1zZXR0aW5ncy5qcyAoJHByZWZzKS4KICAgIHJhbmRvbVJhZGl1czogMCwKICAgIGFsdGl0dWRlOiA1MzAsCiAgICB1bmtub3duVmFsdWU0OiAzLAogICAgbW90aW9uQWN0aXZpdHlUeXBlOiA2MywKICAgIG1vdGlvbkFjdGl2aXR5Q29uZmlkZW5jZTogNDY3LAogICAgZmFpbE9wZW46IHRydWUsCiAgICBkZWJ1ZzogZmFsc2UKICB9OwoKICB2YXIgQVBQTEVfV0xPQ19QUkVGSVggPSBuZXcgVWludDhBcnJheShbMHgwMCwgMHgwMSwgMHgwMCwgMHgwMCwgMHgwMCwgMHgwMSwgMHgwMCwgMHgwMF0pOwogIHZhciBBUFBMRV9XTE9DX01BUktFUiA9IG5ldyBVaW50OEFycmF5KFsweDAwLCAweDAwLCAweDAwLCAweDAxLCAweDAwLCAweDAwXSk7CiAgdmFyIFJPT1RfRFJPUF9GSUVMRFMgPSB7IDM6IHRydWUsIDQ6IHRydWUsIDMzOiB0cnVlIH07CiAgdmFyIENFTExfUkVTUE9OU0VfRklFTERTID0geyAyMjogdHJ1ZSwgMjQ6IHRydWUgfTsKICB2YXIgTE9DQVRJT05fUkVQTEFDRURfRklFTERTID0geyAxOiB0cnVlLCAyOiB0cnVlLCAzOiB0cnVlLCA0OiB0cnVlLCA1OiB0cnVlLCA2OiB0cnVlLCAxMTogdHJ1ZSwgMTI6IHRydWUgfTsKCiAgLy8gPT09PT09PT09PSBCeXRlIFV0aWxpdGllcyA9PT09PT09PT09CgogIGZ1bmN0aW9uIGNvbmNhdEJ5dGVzKHBhcnRzKSB7CiAgICB2YXIgdG90YWwgPSAwLCBpOwogICAgZm9yIChpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB0b3RhbCArPSBwYXJ0c1tpXS5sZW5ndGg7CiAgICB2YXIgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodG90YWwpLCBvZmZzZXQgPSAwOwogICAgZm9yIChpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7IG91dC5zZXQocGFydHNbaV0sIG9mZnNldCk7IG9mZnNldCArPSBwYXJ0c1tpXS5sZW5ndGg7IH0KICAgIHJldHVybiBvdXQ7CiAgfQoKICBmdW5jdGlvbiBmaW5kQnl0ZXMoYnl0ZXMsIG1hcmtlcikgewogICAgaWYgKCFieXRlcyB8fCAhbWFya2VyIHx8IG1hcmtlci5sZW5ndGggPT09IDApIHJldHVybiAtMTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDw9IGJ5dGVzLmxlbmd0aCAtIG1hcmtlci5sZW5ndGg7IGkrKykgewogICAgICB2YXIgb2sgPSB0cnVlOwogICAgICBmb3IgKHZhciBqID0gMDsgaiA8IG1hcmtlci5sZW5ndGg7IGorKykgeyBpZiAoYnl0ZXNbaSArIGpdICE9PSBtYXJrZXJbal0pIHsgb2sgPSBmYWxzZTsgYnJlYWs7IH0gfQogICAgICBpZiAob2spIHJldHVybiBpOwogICAgfQogICAgcmV0dXJuIC0xOwogIH0KCiAgZnVuY3Rpb24gaGV4UHJldmlldyhieXRlcywgbGltaXQpIHsKICAgIGlmICghYnl0ZXMpIHJldHVybiAiPG5vbmU+IjsKICAgIHZhciBvdXQgPSBbXSwgbWF4ID0gTWF0aC5taW4oYnl0ZXMubGVuZ3RoLCBsaW1pdCB8fCAxNik7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG1heDsgaSsrKSBvdXQucHVzaCgoIjAiICsgYnl0ZXNbaV0udG9TdHJpbmcoMTYpKS5zbGljZSgtMikpOwogICAgcmV0dXJuIG91dC5qb2luKCIiKTsKICB9CgogIC8vID09PT09PT09PT0gQmFzZTY0IChRWCDkuJPnlKgpID09PT09PT09PT0KCiAgZnVuY3Rpb24gYmFzZTY0VG9CeXRlcyhiNjQpIHsKICAgIHZhciBhbHBoYWJldCA9ICJBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvIjsKICAgIHZhciBsb29rdXAgPSB7fSwgaTsKICAgIGZvciAoaSA9IDA7IGkgPCBhbHBoYWJldC5sZW5ndGg7IGkrKykgbG9va3VwW2FscGhhYmV0W2ldXSA9IGk7CiAgICBiNjQgPSBiNjQucmVwbGFjZSgvW15BLVphLXowLTlcK1wvXS9nLCAiIik7CiAgICB2YXIgbGVuID0gYjY0Lmxlbmd0aCwgb3V0ID0gW10sIHBhZGRpbmcgPSAwOwogICAgaWYgKGxlbiA+IDAgJiYgYjY0W2xlbiAtIDFdID09PSAiPSIpIHBhZGRpbmcrKzsKICAgIGlmIChsZW4gPiAxICYmIGI2NFtsZW4gLSAyXSA9PT0gIj0iKSBwYWRkaW5nKys7CiAgICB2YXIgYnVmTGVuID0gKGxlbiAvIDQpICogMyAtIHBhZGRpbmc7CiAgICB2YXIgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnVmTGVuKSwgcG9zID0gMDsKICAgIGZvciAoaSA9IDA7IGkgPCBsZW47IGkgKz0gNCkgewogICAgICB2YXIgZW5jMSA9IGxvb2t1cFtiNjRbaV1dLCBlbmMyID0gbG9va3VwW2I2NFtpICsgMV1dLCBlbmMzID0gbG9va3VwW2I2NFtpICsgMl1dLCBlbmM0ID0gbG9va3VwW2I2NFtpICsgM11dOwogICAgICB2YXIgY2hyMSA9IChlbmMxIDw8IDIpIHwgKGVuYzIgPj4gNCk7CiAgICAgIHZhciBjaHIyID0gKChlbmMyICYgMTUpIDw8IDQpIHwgKGVuYzMgPj4gMik7CiAgICAgIHZhciBjaHIzID0gKChlbmMzICYgMykgPDwgNikgfCBlbmM0OwogICAgICBidWZbcG9zKytdID0gY2hyMTsKICAgICAgaWYgKGVuYzMgIT09IDY0KSBidWZbcG9zKytdID0gY2hyMjsKICAgICAgaWYgKGVuYzQgIT09IDY0KSBidWZbcG9zKytdID0gY2hyMzsKICAgIH0KICAgIHJldHVybiBidWY7CiAgfQoKICBmdW5jdGlvbiBieXRlc1RvQmFzZTY0KGJ5dGVzKSB7CiAgICB2YXIgYWxwaGFiZXQgPSAiQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLyI7CiAgICB2YXIgb3V0ID0gIiI7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSAzKSB7CiAgICAgIHZhciBiMCA9IGJ5dGVzW2ldLCBiMSA9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYnl0ZXNbaSArIDFdIDogMCwgYjIgPSBpICsgMiA8IGJ5dGVzLmxlbmd0aCA/IGJ5dGVzW2kgKyAyXSA6IDA7CiAgICAgIHZhciB0cmlwbGV0ID0gKGIwIDw8IDE2KSB8IChiMSA8PCA4KSB8IGIyOwogICAgICBvdXQgKz0gYWxwaGFiZXRbKHRyaXBsZXQgPj4gMTgpICYgMHgzZl0gKyBhbHBoYWJldFsodHJpcGxldCA+PiAxMikgJiAweDNmXTsKICAgICAgb3V0ICs9IGkgKyAxIDwgYnl0ZXMubGVuZ3RoID8gYWxwaGFiZXRbKHRyaXBsZXQgPj4gNikgJiAweDNmXSA6ICI9IjsKICAgICAgb3V0ICs9IGkgKyAyIDwgYnl0ZXMubGVuZ3RoID8gYWxwaGFiZXRbdHJpcGxldCAmIDB4M2ZdIDogIj0iOwogICAgfQogICAgcmV0dXJuIG91dDsKICB9CgogIC8vID09PT09PT09PT0gVmFyaW50IC8gUHJvdG9idWYgPT09PT09PT09PQoKICBmdW5jdGlvbiBlbmNvZGVWYXJpbnRVbnNpZ25lZCh2YWx1ZSkgewogICAgdmFyIHYgPSB0eXBlb2YgdmFsdWUgPT09ICJiaWdpbnQiID8gdmFsdWUgOiBCaWdJbnQodmFsdWUpOwogICAgaWYgKHYgPCAwbikgdGhyb3cgbmV3IEVycm9yKCJuZWdhdGl2ZSB1bnNpZ25lZCB2YXJpbnQiKTsKICAgIHZhciBvdXQgPSBbXTsKICAgIHdoaWxlICh2ID49IDB4ODBuKSB7IG91dC5wdXNoKE51bWJlcigodiAmIDB4N2ZuKSB8IDB4ODBuKSk7IHYgPj49IDduOyB9CiAgICBvdXQucHVzaChOdW1iZXIodikpOwogICAgcmV0dXJuIG5ldyBVaW50OEFycmF5KG91dCk7CiAgfQoKICBmdW5jdGlvbiBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSkgewogICAgdmFyIHYgPSB0eXBlb2YgdmFsdWUgPT09ICJiaWdpbnQiID8gdmFsdWUgOiBCaWdJbnQoTWF0aC50cnVuYyh2YWx1ZSkpOwogICAgaWYgKHYgPCAwbikgdiA9IEJpZ0ludC5hc1VpbnROKDY0LCB2KTsKICAgIHJldHVybiBlbmNvZGVWYXJpbnRVbnNpZ25lZCh2KTsKICB9CgogIGZ1bmN0aW9uIGRlY29kZVZhcmludChieXRlcywgb2Zmc2V0KSB7CiAgICB2YXIgcmVzdWx0ID0gMG4sIHNoaWZ0ID0gMG4sIGN1cnJlbnQgPSBvZmZzZXQ7CiAgICB3aGlsZSAoY3VycmVudCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIgYiA9IGJ5dGVzW2N1cnJlbnRdOyBjdXJyZW50ICs9IDE7CiAgICAgIHJlc3VsdCB8PSBCaWdJbnQoYiAmIDB4N2YpIDw8IHNoaWZ0OwogICAgICBpZiAoKGIgJiAweDgwKSA9PT0gMCkgcmV0dXJuIHsgdmFsdWU6IHJlc3VsdCwgb2Zmc2V0OiBjdXJyZW50IH07CiAgICAgIHNoaWZ0ICs9IDduOwogICAgICBpZiAoc2hpZnQgPiA3MG4pIHRocm93IG5ldyBFcnJvcigidmFyaW50IHRvbyBsb25nIik7CiAgICB9CiAgICB0aHJvdyBuZXcgRXJyb3IoInVudGVybWluYXRlZCB2YXJpbnQiKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VLZXkoZmllbGROdW1iZXIsIHdpcmVUeXBlKSB7CiAgICByZXR1cm4gZW5jb2RlVmFyaW50VW5zaWduZWQoKEJpZ0ludChmaWVsZE51bWJlcikgPDwgM24pIHwgQmlnSW50KHdpcmVUeXBlKSk7CiAgfQoKICBmdW5jdGlvbiBtYWtlVmFyaW50RmllbGQoZmllbGROdW1iZXIsIHZhbHVlKSB7CiAgICByZXR1cm4gY29uY2F0Qnl0ZXMoW21ha2VLZXkoZmllbGROdW1iZXIsIDApLCBlbmNvZGVWYXJpbnRTaWduZWRJbnQ2NCh2YWx1ZSldKTsKICB9CgogIGZ1bmN0aW9uIG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZChmaWVsZE51bWJlciwgcGF5bG9hZCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFttYWtlS2V5KGZpZWxkTnVtYmVyLCAyKSwgZW5jb2RlVmFyaW50VW5zaWduZWQocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBwYXJzZUZpZWxkcyhieXRlcykgewogICAgdmFyIGZpZWxkcyA9IFtdLCBvZmZzZXQgPSAwOwogICAgd2hpbGUgKG9mZnNldCA8IGJ5dGVzLmxlbmd0aCkgewogICAgICB2YXIga2V5U3RhcnQgPSBvZmZzZXQ7CiAgICAgIHZhciBrZXkgPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7CiAgICAgIG9mZnNldCA9IGtleS5vZmZzZXQ7CiAgICAgIHZhciBmaWVsZE51bWJlciA9IE51bWJlcihrZXkudmFsdWUgPj4gM24pLCB3aXJlVHlwZSA9IE51bWJlcihrZXkudmFsdWUgJiAweDduKTsKICAgICAgaWYgKGZpZWxkTnVtYmVyID09PSAwKSB0aHJvdyBuZXcgRXJyb3IoInByb3RvYnVmIGZpZWxkIG51bWJlciAwIik7CiAgICAgIHZhciB2YWx1ZVN0YXJ0ID0gb2Zmc2V0LCB2YWx1ZUVuZDsKICAgICAgaWYgKHdpcmVUeXBlID09PSAwKSB7IHZhbHVlRW5kID0gZGVjb2RlVmFyaW50KGJ5dGVzLCBvZmZzZXQpLm9mZnNldDsgfQogICAgICBlbHNlIGlmICh3aXJlVHlwZSA9PT0gMSkgeyB2YWx1ZUVuZCA9IG9mZnNldCArIDg7IH0KICAgICAgZWxzZSBpZiAod2lyZVR5cGUgPT09IDIpIHsgdmFyIGxlbkluZm8gPSBkZWNvZGVWYXJpbnQoYnl0ZXMsIG9mZnNldCk7IHZhbHVlU3RhcnQgPSBsZW5JbmZvLm9mZnNldDsgdmFsdWVFbmQgPSB2YWx1ZVN0YXJ0ICsgTnVtYmVyKGxlbkluZm8udmFsdWUpOyB9CiAgICAgIGVsc2UgaWYgKHdpcmVUeXBlID09PSA1KSB7IHZhbHVlRW5kID0gb2Zmc2V0ICsgNDsgfQogICAgICBlbHNlIHRocm93IG5ldyBFcnJvcigidW5zdXBwb3J0ZWQgd2lyZSB0eXBlOiAiICsgd2lyZVR5cGUpOwogICAgICBpZiAodmFsdWVFbmQgPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiZmllbGQgZXhjZWVkcyBidWZmZXIiKTsKICAgICAgZmllbGRzLnB1c2goeyBmaWVsZE51bWJlcjogZmllbGROdW1iZXIsIHdpcmVUeXBlOiB3aXJlVHlwZSwga2V5U3RhcnQ6IGtleVN0YXJ0LCB2YWx1ZVN0YXJ0OiB2YWx1ZVN0YXJ0LCB2YWx1ZUVuZDogdmFsdWVFbmQsIHJhdzogYnl0ZXMuc2xpY2Uoa2V5U3RhcnQsIHZhbHVlRW5kKSwgdmFsdWVCeXRlczogYnl0ZXMuc2xpY2UodmFsdWVTdGFydCwgdmFsdWVFbmQpIH0pOwogICAgICBvZmZzZXQgPSB2YWx1ZUVuZDsKICAgIH0KICAgIHJldHVybiBmaWVsZHM7CiAgfQoKICBmdW5jdGlvbiBmaXJzdEZpZWxkQnlOdW1iZXIoZmllbGRzLCBmaWVsZE51bWJlcikgewogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBmaWVsZHMubGVuZ3RoOyBpKyspIHsgaWYgKGZpZWxkc1tpXS5maWVsZE51bWJlciA9PT0gZmllbGROdW1iZXIpIHJldHVybiBmaWVsZHNbaV07IH0KICAgIHJldHVybiBudWxsOwogIH0KCiAgZnVuY3Rpb24gc2lnbmVkVmFyaW50RmllbGRWYWx1ZShmaWVsZCkgewogICAgaWYgKCFmaWVsZCB8fCBmaWVsZC53aXJlVHlwZSAhPT0gMCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4gQmlnSW50LmFzSW50Tig2NCwgZGVjb2RlVmFyaW50KGZpZWxkLnZhbHVlQnl0ZXMsIDApLnZhbHVlKTsKICB9CgogIGZ1bmN0aW9uIHRyeVBhcnNlRmllbGRzKGJ5dGVzKSB7CiAgICB0cnkgeyBpZiAoIWJ5dGVzIHx8IGJ5dGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7IHZhciBmID0gcGFyc2VGaWVsZHMoYnl0ZXMpOyByZXR1cm4gZi5sZW5ndGggPiAwID8gZiA6IG51bGw7IH0KICAgIGNhdGNoIChlKSB7IHJldHVybiBudWxsOyB9CiAgfQoKICBmdW5jdGlvbiBpc0NlbGxSZXNwb25zZUZpZWxkKGZpZWxkTnVtYmVyKSB7IHJldHVybiBDRUxMX1JFU1BPTlNFX0ZJRUxEU1tmaWVsZE51bWJlcl0gPT09IHRydWU7IH0KCiAgLy8gPT09PT09PT09PSBBUlBDID09PT09PT09PT0KCiAgZnVuY3Rpb24gcmVhZFVJbnQxNkJFKGJ5dGVzLCBvZmZzZXQpIHsgcmV0dXJuIChieXRlc1tvZmZzZXRdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgMV07IH0KICBmdW5jdGlvbiByZWFkVUludDMyQkUoYnl0ZXMsIG9mZnNldCkgeyByZXR1cm4gKChieXRlc1tvZmZzZXRdICogMHgxMDAwMDAwKSArICgoYnl0ZXNbb2Zmc2V0ICsgMV0gPDwgMTYpIHwgKGJ5dGVzW29mZnNldCArIDJdIDw8IDgpIHwgYnl0ZXNbb2Zmc2V0ICsgM10pKSA+Pj4gMDsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDE2QkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4gOCkgJiAweGZmLCB2YWx1ZSAmIDB4ZmZdKTsgfQogIGZ1bmN0aW9uIHdyaXRlVUludDMyQkUodmFsdWUpIHsgcmV0dXJuIG5ldyBVaW50OEFycmF5KFsodmFsdWUgPj4+IDI0KSAmIDB4ZmYsICh2YWx1ZSA+Pj4gMTYpICYgMHhmZiwgKHZhbHVlID4+PiA4KSAmIDB4ZmYsIHZhbHVlICYgMHhmZl0pOyB9CgogIGZ1bmN0aW9uIGFzY2lpQnl0ZXModmFsdWUpIHsKICAgIHZhciBvdXQgPSBuZXcgVWludDhBcnJheSh2YWx1ZS5sZW5ndGgpOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkrKykgb3V0W2ldID0gdmFsdWUuY2hhckNvZGVBdChpKSAmIDB4N2Y7CiAgICByZXR1cm4gb3V0OwogIH0KCiAgZnVuY3Rpb24gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpIHsKICAgIHZhciBsZW5ndGggPSByZWFkVUludDE2QkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSAyOwogICAgdmFyIGNoYXJzID0gW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSBjaGFycy5wdXNoKFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbc3RhdGUub2Zmc2V0ICsgaV0pKTsKICAgIHN0YXRlLm9mZnNldCArPSBsZW5ndGg7CiAgICByZXR1cm4gY2hhcnMuam9pbigiIik7CiAgfQoKICBmdW5jdGlvbiB3cml0ZVBhc2NhbFN0cmluZyh2YWx1ZSkgeyByZXR1cm4gY29uY2F0Qnl0ZXMoW3dyaXRlVUludDE2QkUodmFsdWUubGVuZ3RoKSwgYXNjaWlCeXRlcyh2YWx1ZSldKTsgfQoKICBmdW5jdGlvbiBwYXJzZUFycGMoYnl0ZXMpIHsKICAgIHZhciBzdGF0ZSA9IHsgb2Zmc2V0OiAwIH07CiAgICB2YXIgdmVyc2lvbiA9IHJlYWRVSW50MTZCRShieXRlcywgc3RhdGUub2Zmc2V0KTsgc3RhdGUub2Zmc2V0ICs9IDI7CiAgICB2YXIgbG9jYWxlID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGFwcElkZW50aWZpZXIgPSByZWFkUGFzY2FsU3RyaW5nKGJ5dGVzLCBzdGF0ZSk7CiAgICB2YXIgb3NWZXJzaW9uID0gcmVhZFBhc2NhbFN0cmluZyhieXRlcywgc3RhdGUpOwogICAgdmFyIGZ1bmN0aW9uSWQgPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgdmFyIHBheWxvYWRMZW5ndGggPSByZWFkVUludDMyQkUoYnl0ZXMsIHN0YXRlLm9mZnNldCk7IHN0YXRlLm9mZnNldCArPSA0OwogICAgaWYgKHN0YXRlLm9mZnNldCArIHBheWxvYWRMZW5ndGggPiBieXRlcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcigiQVJQQyBwYXlsb2FkIGV4Y2VlZHMgYnVmZmVyIik7CiAgICByZXR1cm4geyB2ZXJzaW9uOiB2ZXJzaW9uLCBsb2NhbGU6IGxvY2FsZSwgYXBwSWRlbnRpZmllcjogYXBwSWRlbnRpZmllciwgb3NWZXJzaW9uOiBvc1ZlcnNpb24sIGZ1bmN0aW9uSWQ6IGZ1bmN0aW9uSWQsIHBheWxvYWQ6IGJ5dGVzLnNsaWNlKHN0YXRlLm9mZnNldCwgc3RhdGUub2Zmc2V0ICsgcGF5bG9hZExlbmd0aCkgfTsKICB9CgogIGZ1bmN0aW9uIHNlcmlhbGl6ZUFycGMoYXJwYykgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFt3cml0ZVVJbnQxNkJFKGFycGMudmVyc2lvbiksIHdyaXRlUGFzY2FsU3RyaW5nKGFycGMubG9jYWxlKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5hcHBJZGVudGlmaWVyKSwgd3JpdGVQYXNjYWxTdHJpbmcoYXJwYy5vc1ZlcnNpb24pLCB3cml0ZVVJbnQzMkJFKGFycGMuZnVuY3Rpb25JZCksIHdyaXRlVUludDMyQkUoYXJwYy5wYXlsb2FkLmxlbmd0aCksIGFycGMucGF5bG9hZF0pOwogIH0KCiAgLy8gPT09PT09PT09PSBMb2NhdGlvbiBQYXRjaGluZyA9PT09PT09PT09CgogIGZ1bmN0aW9uIGNvb3JkVG9JbnQodmFsdWUpIHsgcmV0dXJuIE1hdGgudHJ1bmMoTnVtYmVyKHZhbHVlKSAqIDEwMDAwMDAwMCk7IH0KCiAgZnVuY3Rpb24gcGF0Y2hMb2NhdGlvbihsb2NhdGlvblBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIHBhcnRzID0gW10sIGZpZWxkcyA9IGxvY2F0aW9uUGF5bG9hZC5sZW5ndGggPyBwYXJzZUZpZWxkcyhsb2NhdGlvblBheWxvYWQpIDogW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkrKykgeyBpZiAoIUxPQ0FUSU9OX1JFUExBQ0VEX0ZJRUxEU1tmaWVsZHNbaV0uZmllbGROdW1iZXJdKSBwYXJ0cy5wdXNoKGZpZWxkc1tpXS5yYXcpOyB9CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxLCBjb29yZFRvSW50KGNvbmZpZy5sYXRpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDIsIGNvb3JkVG9JbnQoY29uZmlnLmxvbmdpdHVkZSkpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDMsIGNvbmZpZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDQsIGNvbmZpZy51bmtub3duVmFsdWU0KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCg1LCBjb25maWcuYWx0aXR1ZGUpKTsKICAgIHBhcnRzLnB1c2gobWFrZVZhcmludEZpZWxkKDYsIGNvbmZpZy52ZXJ0aWNhbEFjY3VyYWN5KSk7CiAgICBwYXJ0cy5wdXNoKG1ha2VWYXJpbnRGaWVsZCgxMSwgY29uZmlnLm1vdGlvbkFjdGl2aXR5VHlwZSkpOwogICAgcGFydHMucHVzaChtYWtlVmFyaW50RmllbGQoMTIsIGNvbmZpZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaFdpZmlEZXZpY2Uod2lmaVBheWxvYWQsIGNvbmZpZykgewogICAgdmFyIGZpZWxkcyA9IHBhcnNlRmllbGRzKHdpZmlQYXlsb2FkKSwgcGFydHMgPSBbXSwgcGF0Y2hlZExvY2F0aW9uID0gZmFsc2U7CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZpZWxkcy5sZW5ndGg7IGkrKykgewogICAgICBpZiAoZmllbGRzW2ldLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkc1tpXS53aXJlVHlwZSA9PT0gMikgewogICAgICAgIHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoTG9jYXRpb24oZmllbGRzW2ldLnZhbHVlQnl0ZXMsIGNvbmZpZykpKTsgcGF0Y2hlZExvY2F0aW9uID0gdHJ1ZTsKICAgICAgfSBlbHNlIHBhcnRzLnB1c2goZmllbGRzW2ldLnJhdyk7CiAgICB9CiAgICBpZiAoIXBhdGNoZWRMb2NhdGlvbikgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoMiwgcGF0Y2hMb2NhdGlvbihuZXcgVWludDhBcnJheShbXSksIGNvbmZpZykpKTsKICAgIHJldHVybiBjb25jYXRCeXRlcyhwYXJ0cyk7CiAgfQoKICBmdW5jdGlvbiBwYXRjaENlbGxUb3dlcihjZWxsUGF5bG9hZCwgY29uZmlnKSB7CiAgICB2YXIgZmllbGRzID0gcGFyc2VGaWVsZHMoY2VsbFBheWxvYWQpLCBwYXJ0cyA9IFtdLCBwYXRjaGVkTG9jYXRpb24gPSBmYWxzZTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIGlmIChmaWVsZHNbaV0uZmllbGROdW1iZXIgPT09IDUgJiYgZmllbGRzW2ldLndpcmVUeXBlID09PSAyKSB7CiAgICAgICAgcGFydHMucHVzaChtYWtlTGVuZ3RoRGVsaW1pdGVkRmllbGQoNSwgcGF0Y2hMb2NhdGlvbihmaWVsZHNbaV0udmFsdWVCeXRlcywgY29uZmlnKSkpOyBwYXRjaGVkTG9jYXRpb24gPSB0cnVlOwogICAgICB9IGVsc2UgcGFydHMucHVzaChmaWVsZHNbaV0ucmF3KTsKICAgIH0KICAgIGlmICghcGF0Y2hlZExvY2F0aW9uKSBwYXJ0cy5wdXNoKG1ha2VMZW5ndGhEZWxpbWl0ZWRGaWVsZCg1LCBwYXRjaExvY2F0aW9uKG5ldyBVaW50OEFycmF5KFtdKSwgY29uZmlnKSkpOwogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKHBhcnRzKTsKICB9CgogIGZ1bmN0aW9uIHBhdGNoQXBwbGVXTG9jUGF5bG9hZChwYXlsb2FkLCBjb25maWcpIHsKICAgIHZhciBmaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKSwgcGFydHMgPSBbXSwgd2lmaUNvdW50ID0gMCwgY2VsbENvdW50ID0gMDsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSsrKSB7CiAgICAgIHZhciBmaWVsZCA9IGZpZWxkc1tpXTsKICAgICAgaWYgKGZpZWxkLmZpZWxkTnVtYmVyID09PSAyICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7IHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKDIsIHBhdGNoV2lmaURldmljZShmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7IHdpZmlDb3VudCArPSAxOyB9CiAgICAgIGVsc2UgaWYgKGlzQ2VsbFJlc3BvbnNlRmllbGQoZmllbGQuZmllbGROdW1iZXIpICYmIGZpZWxkLndpcmVUeXBlID09PSAyKSB7IHBhcnRzLnB1c2gobWFrZUxlbmd0aERlbGltaXRlZEZpZWxkKGZpZWxkLmZpZWxkTnVtYmVyLCBwYXRjaENlbGxUb3dlcihmaWVsZC52YWx1ZUJ5dGVzLCBjb25maWcpKSk7IGNlbGxDb3VudCArPSAxOyB9CiAgICAgIGVsc2UgaWYgKCFST09UX0RST1BfRklFTERTW2ZpZWxkLmZpZWxkTnVtYmVyXSkgcGFydHMucHVzaChmaWVsZC5yYXcpOwogICAgfQogICAgcmV0dXJuIHsgcGF5bG9hZDogY29uY2F0Qnl0ZXMocGFydHMpLCB3aWZpQ291bnQ6IHdpZmlDb3VudCwgY2VsbENvdW50OiBjZWxsQ291bnQgfTsKICB9CgogIC8vID09PT09PT09PT0gUmVzcG9uc2UgRXh0cmFjdGlvbiA9PT09PT09PT09CgogIGZ1bmN0aW9uIGV4dHJhY3RQcmVmaXhlZEFwcGxlV0xvY1BheWxvYWQocmVzcG9uc2VCeXRlcykgewogICAgaWYgKCFyZXNwb25zZUJ5dGVzIHx8IHJlc3BvbnNlQnl0ZXMubGVuZ3RoIDwgMTApIHJldHVybiBudWxsOwogICAgaWYgKHJlc3BvbnNlQnl0ZXNbMF0gIT09IDB4MDAgfHwgcmVzcG9uc2VCeXRlc1sxXSAhPT0gMHgwMSkgcmV0dXJuIG51bGw7CiAgICBpZiAocmVzcG9uc2VCeXRlc1s2XSAhPT0gMHgwMCB8fCByZXNwb25zZUJ5dGVzWzddICE9PSAweDAwKSByZXR1cm4gbnVsbDsKICAgIHZhciBwYXlsb2FkTGVuZ3RoID0gcmVhZFVJbnQxNkJFKHJlc3BvbnNlQnl0ZXMsIDgpLCBwYXlsb2FkT2Zmc2V0ID0gMTA7CiAgICBpZiAocGF5bG9hZExlbmd0aCA8PSAwIHx8IHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoID4gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHJldHVybiBudWxsOwogICAgdmFyIHBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHBheWxvYWRPZmZzZXQsIHBheWxvYWRPZmZzZXQgKyBwYXlsb2FkTGVuZ3RoKTsKICAgIGlmICh0cnlQYXJzZUZpZWxkcyhwYXlsb2FkKSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7CiAgICByZXR1cm4geyBraW5kOiAic3ludGhldGljIiwgcGF5bG9hZDogcGF5bG9hZCwgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIDgpLCBzdWZmaXg6IHJlc3BvbnNlQnl0ZXMuc2xpY2UocGF5bG9hZE9mZnNldCArIHBheWxvYWRMZW5ndGgpIH07CiAgfQoKICBmdW5jdGlvbiBleHRyYWN0QXBwbGVXTG9jUGF5bG9hZChyZXNwb25zZUJ5dGVzKSB7CiAgICBpZiAoIXJlc3BvbnNlQnl0ZXMgfHwgcmVzcG9uc2VCeXRlcy5sZW5ndGggPCAyKSB0aHJvdyBuZXcgRXJyb3IoIkFwcGxlIFdMb2MgcmVzcG9uc2UgdG9vIHNob3J0Iik7CiAgICB2YXIgcHJlZml4ZWQgPSBleHRyYWN0UHJlZml4ZWRBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgaWYgKHByZWZpeGVkKSByZXR1cm4gcHJlZml4ZWQ7CiAgICB0cnkgewogICAgICB2YXIgYXJwYyA9IHBhcnNlQXJwYyhyZXNwb25zZUJ5dGVzKTsKICAgICAgaWYgKGFycGMucGF5bG9hZC5sZW5ndGggPiAwICYmIHRyeVBhcnNlRmllbGRzKGFycGMucGF5bG9hZCkgIT09IG51bGwpIHJldHVybiB7IGtpbmQ6ICJhcnBjIiwgcGF5bG9hZDogYXJwYy5wYXlsb2FkLCBhcnBjOiBhcnBjIH07CiAgICB9IGNhdGNoIChlKSB7fQogICAgdmFyIG1hcmtlcklkeCA9IGZpbmRCeXRlcyhyZXNwb25zZUJ5dGVzLCBBUFBMRV9XTE9DX01BUktFUik7CiAgICBpZiAobWFya2VySWR4ID49IDApIHsKICAgICAgdmFyIGxlbk9mZnNldCA9IG1hcmtlcklkeCArIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aDsKICAgICAgaWYgKGxlbk9mZnNldCArIDIgPD0gcmVzcG9uc2VCeXRlcy5sZW5ndGgpIHsKICAgICAgICB2YXIgcmVhbExlbiA9IHJlYWRVSW50MTZCRShyZXNwb25zZUJ5dGVzLCBsZW5PZmZzZXQpLCByZWFsUGF5bG9hZE9mZnNldCA9IGxlbk9mZnNldCArIDI7CiAgICAgICAgaWYgKHJlYWxMZW4gPiAwICYmIHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbiA8PSByZXNwb25zZUJ5dGVzLmxlbmd0aCkgewogICAgICAgICAgdmFyIGNhbmRpZGF0ZVBheWxvYWQgPSByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0LCByZWFsUGF5bG9hZE9mZnNldCArIHJlYWxMZW4pOwogICAgICAgICAgaWYgKHRyeVBhcnNlRmllbGRzKGNhbmRpZGF0ZVBheWxvYWQpICE9PSBudWxsKSByZXR1cm4geyBraW5kOiAibWFya2VyIiwgcGF5bG9hZDogY2FuZGlkYXRlUGF5bG9hZCwgcHJlZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKDAsIG1hcmtlcklkeCksIG1hcmtlckFuZExlbjogcmVzcG9uc2VCeXRlcy5zbGljZShtYXJrZXJJZHgsIHJlYWxQYXlsb2FkT2Zmc2V0KSwgc3VmZml4OiByZXNwb25zZUJ5dGVzLnNsaWNlKHJlYWxQYXlsb2FkT2Zmc2V0ICsgcmVhbExlbikgfTsKICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIGlmIChyZXNwb25zZUJ5dGVzLmxlbmd0aCA+IDApIHsgdmFyIHRhZyA9IHJlc3BvbnNlQnl0ZXNbMF07IHZhciBmbiA9IHRhZyA+PiAzLCB3dCA9IHRhZyAmIDB4NzsgaWYgKGZuID4gMCAmJiAod3QgPT09IDAgfHwgd3QgPT09IDIpKSByZXR1cm4geyBraW5kOiAiYmFyZSIsIHBheWxvYWQ6IHJlc3BvbnNlQnl0ZXMgfTsgfQogICAgdGhyb3cgbmV3IEVycm9yKCJtaXNzaW5nIEFwcGxlIFdMb2MgcmVzcG9uc2UgcHJlZml4Iik7CiAgfQoKICBmdW5jdGlvbiBidWlsZEFwcGxlV0xvY1Jlc3BvbnNlKHBheWxvYWQsIHByZWZpeCkgewogICAgcmV0dXJuIGNvbmNhdEJ5dGVzKFtwcmVmaXggfHwgQVBQTEVfV0xPQ19QUkVGSVgsIHdyaXRlVUludDE2QkUocGF5bG9hZC5sZW5ndGgpLCBwYXlsb2FkXSk7CiAgfQoKICBmdW5jdGlvbiBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCeXRlcywgY29uZmlnKSB7CiAgICB2YXIgZXh0cmFjdGlvbiA9IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkKHJlc3BvbnNlQnl0ZXMpOwogICAgdmFyIHBhdGNoZWQgPSBwYXRjaEFwcGxlV0xvY1BheWxvYWQoZXh0cmFjdGlvbi5wYXlsb2FkLCBjb25maWcpOwogICAgdmFyIHJlc3BvbnNlOwogICAgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gImFycGMiKSB7CiAgICAgIHJlc3BvbnNlID0gc2VyaWFsaXplQXJwYyh7IHZlcnNpb246IGV4dHJhY3Rpb24uYXJwYy52ZXJzaW9uLCBsb2NhbGU6IGV4dHJhY3Rpb24uYXJwYy5sb2NhbGUsIGFwcElkZW50aWZpZXI6IGV4dHJhY3Rpb24uYXJwYy5hcHBJZGVudGlmaWVyLCBvc1ZlcnNpb246IGV4dHJhY3Rpb24uYXJwYy5vc1ZlcnNpb24sIGZ1bmN0aW9uSWQ6IGV4dHJhY3Rpb24uYXJwYy5mdW5jdGlvbklkLCBwYXlsb2FkOiBwYXRjaGVkLnBheWxvYWQgfSk7CiAgICB9IGVsc2UgaWYgKGV4dHJhY3Rpb24ua2luZCA9PT0gIm1hcmtlciIpIHsKICAgICAgdmFyIG5ld0xlbkJ5dGVzID0gd3JpdGVVSW50MTZCRShwYXRjaGVkLnBheWxvYWQubGVuZ3RoKTsKICAgICAgcmVzcG9uc2UgPSBjb25jYXRCeXRlcyhbZXh0cmFjdGlvbi5wcmVmaXgsIGV4dHJhY3Rpb24ubWFya2VyQW5kTGVuLnNsaWNlKDAsIEFQUExFX1dMT0NfTUFSS0VSLmxlbmd0aCksIG5ld0xlbkJ5dGVzLCBwYXRjaGVkLnBheWxvYWQsIGV4dHJhY3Rpb24uc3VmZml4XSk7CiAgICB9IGVsc2UgewogICAgICByZXNwb25zZSA9IGJ1aWxkQXBwbGVXTG9jUmVzcG9uc2UocGF0Y2hlZC5wYXlsb2FkLCBleHRyYWN0aW9uLnByZWZpeCk7CiAgICB9CiAgICByZXR1cm4geyByZXNwb25zZTogcmVzcG9uc2UsIHBheWxvYWQ6IHBhdGNoZWQucGF5bG9hZCwgd2lmaUNvdW50OiBwYXRjaGVkLndpZmlDb3VudCwgY2VsbENvdW50OiBwYXRjaGVkLmNlbGxDb3VudCwga2luZDogZXh0cmFjdGlvbi5raW5kIH07CiAgfQoKICBmdW5jdGlvbiBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocGF5bG9hZCkgewogICAgdHJ5IHsKICAgICAgdmFyIHJvb3RGaWVsZHMgPSBwYXJzZUZpZWxkcyhwYXlsb2FkKSwgcGFydHMgPSBbXTsKICAgICAgdmFyIHdpZmkgPSBmaXJzdEZpZWxkQnlOdW1iZXIocm9vdEZpZWxkcywgMik7CiAgICAgIGlmICh3aWZpICYmIHdpZmkud2lyZVR5cGUgPT09IDIpIHsKICAgICAgICB2YXIgd2lmaUxvYyA9IGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpLnZhbHVlQnl0ZXMpLCAyKTsKICAgICAgICBwYXJ0cy5wdXNoKCJmaXJzdFdpZmk9IiArICh3aWZpTG9jID8gKE51bWJlcihzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpTG9jLnZhbHVlQnl0ZXMpLCAxKSkpIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpICsgIiwiICsgKE51bWJlcihzaWduZWRWYXJpbnRGaWVsZFZhbHVlKGZpcnN0RmllbGRCeU51bWJlcihwYXJzZUZpZWxkcyh3aWZpTG9jLnZhbHVlQnl0ZXMpLCAyKSkpIC8gMTAwMDAwMDAwKS50b0ZpeGVkKDgpIDogIjxtaXNzaW5nPiIpKTsKICAgICAgfQogICAgICByZXR1cm4gcGFydHMubGVuZ3RoID8gcGFydHMuam9pbigiLCAiKSA6ICJubyBsb2NhdGlvbiBmaWVsZHMiOwogICAgfSBjYXRjaCAoZXJyKSB7IHJldHVybiAic3VtbWFyeSBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZTsgfQogIH0KCiAgLy8gPT09PT09PT09PSBDb25maWcgPT09PT09PT09PQoKICBmdW5jdGlvbiBub3JtYWxpemVDb25maWcoaW5wdXQpIHsKICAgIHZhciBjZmcgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gREVGQVVMVF9DT05GSUcpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChERUZBVUxUX0NPTkZJRywga2V5KSkgY2ZnW2tleV0gPSBERUZBVUxUX0NPTkZJR1trZXldOyB9CiAgICBpbnB1dCA9IGlucHV0IHx8IHt9OwogICAgZm9yIChrZXkgaW4gaW5wdXQpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChpbnB1dCwga2V5KSkgY2ZnW2tleV0gPSBpbnB1dFtrZXldOyB9CiAgICBjZmcuZW5hYmxlZCA9ICEoY2ZnLmVuYWJsZWQgPT09IGZhbHNlIHx8IGNmZy5lbmFibGVkID09PSAiZmFsc2UiIHx8IGNmZy5lbmFibGVkID09PSAiMCIgfHwgY2ZnLmVuYWJsZWQgPT09ICJvZmYiIHx8IGNmZy5lbmFibGVkID09PSAibm8iIHx8IGNmZy5lbmFibGVkID09PSAwKTsKICAgIGNmZy5sYXRpdHVkZSA9IE51bWJlcihjZmcubGF0aXR1ZGUpOyBjZmcubG9uZ2l0dWRlID0gTnVtYmVyKGNmZy5sb25naXR1ZGUpOwogICAgY2ZnLmhvcml6b250YWxBY2N1cmFjeSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5ob3Jpem9udGFsQWNjdXJhY3kpKTsKICAgIGNmZy52ZXJ0aWNhbEFjY3VyYWN5ID0gTWF0aC50cnVuYyhOdW1iZXIoY2ZnLnZlcnRpY2FsQWNjdXJhY3kpKTsKICAgIGNmZy5hbHRpdHVkZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5hbHRpdHVkZSkpOwogICAgY2ZnLnVua25vd25WYWx1ZTQgPSBNYXRoLnRydW5jKE51bWJlcihjZmcudW5rbm93blZhbHVlNCkpOwogICAgY2ZnLm1vdGlvbkFjdGl2aXR5VHlwZSA9IE1hdGgudHJ1bmMoTnVtYmVyKGNmZy5tb3Rpb25BY3Rpdml0eVR5cGUpKTsKICAgIGNmZy5tb3Rpb25BY3Rpdml0eUNvbmZpZGVuY2UgPSBNYXRoLnRydW5jKE51bWJlcihjZmcubW90aW9uQWN0aXZpdHlDb25maWRlbmNlKSk7CiAgICBjZmcuZmFpbE9wZW4gPSBjZmcuZmFpbE9wZW4gIT09IGZhbHNlOwogICAgY2ZnLmRlYnVnID0gY2ZnLmRlYnVnID09PSB0cnVlIHx8IFN0cmluZyhjZmcuZGVidWcpLnRvTG93ZXJDYXNlKCkgPT09ICJ0cnVlIjsKICAgIGNmZy5yYW5kb21SYWRpdXMgPSBOdW1iZXIoY2ZnLnJhbmRvbVJhZGl1cyk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcucmFuZG9tUmFkaXVzKSB8fCBjZmcucmFuZG9tUmFkaXVzIDwgMCkgY2ZnLnJhbmRvbVJhZGl1cyA9IDA7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubGF0aXR1ZGUpIHx8IGNmZy5sYXRpdHVkZSA8IC05MCB8fCBjZmcubGF0aXR1ZGUgPiA5MCkgdGhyb3cgbmV3IEVycm9yKCJpbnZhbGlkIGxhdGl0dWRlIik7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjZmcubG9uZ2l0dWRlKSB8fCBjZmcubG9uZ2l0dWRlIDwgLTE4MCB8fCBjZmcubG9uZ2l0dWRlID4gMTgwKSB0aHJvdyBuZXcgRXJyb3IoImludmFsaWQgbG9uZ2l0dWRlIik7CiAgICBpZiAoY2ZnLnJhbmRvbVJhZGl1cyA+IDApIHsKICAgICAgdmFyIGppdHRlcmVkID0gYXBwbHlSYW5kb21SYWRpdXMoY2ZnLmxhdGl0dWRlLCBjZmcubG9uZ2l0dWRlLCBjZmcucmFuZG9tUmFkaXVzKTsKICAgICAgY2ZnLmxhdGl0dWRlID0gaml0dGVyZWQubGF0aXR1ZGU7CiAgICAgIGNmZy5sb25naXR1ZGUgPSBqaXR0ZXJlZC5sb25naXR1ZGU7CiAgICAgIGNmZy5yYW5kb21EaXN0YW5jZSA9IGppdHRlcmVkLmRpc3RhbmNlOwogICAgfQogICAgcmV0dXJuIGNmZzsKICB9CgogIC8vIFJhbmRvbSBwZXJ0dXJiYXRpb24gKFl1OTE5MSB2MS4xICLmibDliqjljYrlvoQiKSDigJQgc2VlIGxvY2F0aW9uLXNwb29mZXIuanMgZm9yIGRldGFpbHMuCiAgZnVuY3Rpb24gYXBwbHlSYW5kb21SYWRpdXMobGF0LCBsb24sIHJhZGl1c01ldGVycykgewogICAgdmFyIHIgPSBOdW1iZXIocmFkaXVzTWV0ZXJzKTsKICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHIpIHx8IHIgPD0gMCkgcmV0dXJuIHsgbGF0aXR1ZGU6IGxhdCwgbG9uZ2l0dWRlOiBsb24sIGRpc3RhbmNlOiAwIH07CiAgICB2YXIgZGlzdGFuY2UgPSBNYXRoLnNxcnQoTWF0aC5yYW5kb20oKSkgKiByOwogICAgdmFyIGJlYXJpbmcgPSAyICogTWF0aC5yYW5kb20oKSAqIE1hdGguUEk7CiAgICB2YXIgYW5ndWxhciA9IGRpc3RhbmNlIC8gNjM3ODEzNzsKICAgIHZhciBsYXRSYWQgPSAobGF0ICogTWF0aC5QSSkgLyAxODA7CiAgICB2YXIgbG9uUmFkID0gKGxvbiAqIE1hdGguUEkpIC8gMTgwOwogICAgdmFyIG5ld0xhdCA9IE1hdGguYXNpbihNYXRoLnNpbihsYXRSYWQpICogTWF0aC5jb3MoYW5ndWxhcikgKyBNYXRoLmNvcyhsYXRSYWQpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhiZWFyaW5nKSk7CiAgICB2YXIgbmV3TG9uID0gKChsb25SYWQgKyBNYXRoLmF0YW4yKE1hdGguc2luKGJlYXJpbmcpICogTWF0aC5zaW4oYW5ndWxhcikgKiBNYXRoLmNvcyhsYXRSYWQpLCBNYXRoLmNvcyhhbmd1bGFyKSAtIE1hdGguc2luKGxhdFJhZCkgKiBNYXRoLnNpbihuZXdMYXQpKSArIDMgKiBNYXRoLlBJKSAlICgyICogTWF0aC5QSSkpIC0gTWF0aC5QSTsKICAgIHJldHVybiB7CiAgICAgIGxhdGl0dWRlOiBOdW1iZXIoKChuZXdMYXQgKiAxODApIC8gTWF0aC5QSSkudG9GaXhlZCg4KSksCiAgICAgIGxvbmdpdHVkZTogTnVtYmVyKCgobmV3TG9uICogMTgwKSAvIE1hdGguUEkpLnRvRml4ZWQoOCkpLAogICAgICBkaXN0YW5jZTogZGlzdGFuY2UKICAgIH07CiAgfQoKICBmdW5jdGlvbiBsb2FkQ29uZmlnKCkgewogICAgLy8g5peg54q25oCB77ya5LuO5pys5py6ICRwcmVmcyDor7vlj5bpgInngrnpobXlhpnlhaXnmoTlnZDmoIfvvIjkuI3lj5Hotbfku7vkvZXlpJbpg6jnvZHnu5zor7fmsYLvvInjgIIKICAgIC8vIOmUruS4jiBsb2NhdGlvbi1zZXR0aW5ncy5qcyDlhpnlhaXnmoTkuIDoh7TvvJplbmFibGVkL2xhdGl0dWRlL2xvbmdpdHVkZS9hbHRpdHVkZS9ob3Jpem9udGFsQWNjdXJhY3kvdmVydGljYWxBY2N1cmFjeeOAggogICAgdmFyIGNmZyA9IHt9OwogICAgZm9yICh2YXIgayBpbiBERUZBVUxUX0NPTkZJRykgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKERFRkFVTFRfQ09ORklHLCBrKSkgY2ZnW2tdID0gREVGQVVMVF9DT05GSUdba107IH0KICAgIHZhciBrZXlzID0gWyJlbmFibGVkIiwgImxhdGl0dWRlIiwgImxvbmdpdHVkZSIsICJhbHRpdHVkZSIsICJob3Jpem9udGFsQWNjdXJhY3kiLCAidmVydGljYWxBY2N1cmFjeSIsICJyYW5kb21SYWRpdXMiXTsKICAgIGlmICh0eXBlb2YgJHByZWZzICE9PSAidW5kZWZpbmVkIiAmJiAkcHJlZnMudmFsdWVGb3JLZXkpIHsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIHYgPSAkcHJlZnMudmFsdWVGb3JLZXkoa2V5c1tpXSk7CiAgICAgICAgaWYgKHYgIT0gbnVsbCAmJiB2ICE9PSAiIikgY2ZnW2tleXNbaV1dID0gdjsKICAgICAgfQogICAgfQogICAgcmV0dXJuIG5vcm1hbGl6ZUNvbmZpZyhjZmcpOwogIH0KCiAgZnVuY3Rpb24gbWVyZ2VDb25maWcoYmFzZSwgZXh0cmEpIHsKICAgIHZhciBvdXQgPSB7fSwga2V5OwogICAgZm9yIChrZXkgaW4gYmFzZSkgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGJhc2UsIGtleSkpIG91dFtrZXldID0gYmFzZVtrZXldOyB9CiAgICBleHRyYSA9IGV4dHJhIHx8IHt9OwogICAgZm9yIChrZXkgaW4gZXh0cmEpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChleHRyYSwga2V5KSkgb3V0W2tleV0gPSBleHRyYVtrZXldOyB9CiAgICByZXR1cm4gb3V0OwogIH0KCiAgLy8gPT09PT09PT09PSBRWCBFbnRyeSBQb2ludCA9PT09PT09PT09CgogIGZ1bmN0aW9uIHJ1blFYKCkgewogICAgdmFyIGhhc1Jlc3BvbnNlID0gdHlwZW9mICRyZXNwb25zZSAhPT0gInVuZGVmaW5lZCI7CgogICAgaWYgKGhhc1Jlc3BvbnNlKSB7CiAgICAgIHZhciBjb25maWcgPSBsb2FkQ29uZmlnKCk7CiAgICAgIHRyeSB7CiAgICAgICAgaWYgKCFjb25maWcuZW5hYmxlZCkgeyAkZG9uZSh7fSk7IHJldHVybjsgfQogICAgICAgIC8vIFFYIHYxLjAuMTkrIOi1t+S6jOi/m+WItuWTjeW6lOi1sCAkcmVzcG9uc2UuYm9keUJ5dGVzKEFycmF5QnVmZmVyKe+8jAogICAgICAgIC8vICRyZXNwb25zZS5ib2R5IOWvueS6jOi/m+WItuaYr+epui/kubHnoIHmlofmnKzjgILor6bop4EgY3Jvc3N1dGlsaXR5L1F1YW50dW11bHQtWAogICAgICAgIC8vIOeahCBzYW1wbGUtYnl0ZXMtcmV3cml0ZS5qc+OAggogICAgICAgIHZhciByYXdCdWYgPSAkcmVzcG9uc2UuYm9keUJ5dGVzOwogICAgICAgIGlmICghcmF3QnVmIHx8IChyYXdCdWYuYnl0ZUxlbmd0aCAhPT0gdW5kZWZpbmVkICYmIHJhd0J1Zi5ieXRlTGVuZ3RoID09PSAwKSkgewogICAgICAgICAgJGRvbmUoe30pOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KICAgICAgICB2YXIgcmVzcG9uc2VCeXRlcyA9IHJhd0J1ZiBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkgPyByYXdCdWYgOiBuZXcgVWludDhBcnJheShyYXdCdWYpOwogICAgICAgIGlmIChyZXNwb25zZUJ5dGVzLmxlbmd0aCA8IDIpIHsgJGRvbmUoe30pOyByZXR1cm47IH0KICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBRWCByZXNwb25zZTogIiArIHJlc3BvbnNlQnl0ZXMubGVuZ3RoICsgIiBieXRlcywgaGVhZD0iICsgaGV4UHJldmlldyhyZXNwb25zZUJ5dGVzLCAzMikpOwogICAgICAgIHZhciByZXN1bHQgPSBzcG9vZkFwcGxlUmVzcG9uc2UocmVzcG9uc2VCeXRlcywgY29uZmlnKTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBwYXRjaGVkICIgKyByZXN1bHQud2lmaUNvdW50ICsgIiB3aWZpLCAiICsgcmVzdWx0LmNlbGxDb3VudCArICIgY2VsbCwga2luZD0iICsgcmVzdWx0LmtpbmQgKyAiLCByZXNwb25zZT0iICsgcmVzdWx0LnJlc3BvbnNlLmxlbmd0aCArICIgYnl0ZXMiKTsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBsb2NhdGlvbnM6ICIgKyBwYXRjaGVkUGF5bG9hZFN1bW1hcnkocmVzdWx0LnBheWxvYWQpKTsKICAgICAgICAvLyBRWDog5LqM6L+b5Yi25pS55ZCO5ZON5bqU5b+F6aG755SoICRkb25lKHtib2R5Qnl0ZXM6IEFycmF5QnVmZmVyfSkg5Zue5YaZCiAgICAgICAgJGRvbmUoewogICAgICAgICAgYm9keUJ5dGVzOiByZXN1bHQucmVzcG9uc2UuYnVmZmVyLnNsaWNlKAogICAgICAgICAgICByZXN1bHQucmVzcG9uc2UuYnl0ZU9mZnNldCwKICAgICAgICAgICAgcmVzdWx0LnJlc3BvbnNlLmJ5dGVPZmZzZXQgKyByZXN1bHQucmVzcG9uc2UuYnl0ZUxlbmd0aAogICAgICAgICAgKQogICAgICAgIH0pOwogICAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgICBpZiAoY29uZmlnLmRlYnVnKSBjb25zb2xlLmxvZygiTG9jYXRpb24gc3Bvb2ZlciBmYWlsZWQ6ICIgKyBlcnIubWVzc2FnZSk7CiAgICAgICAgJGRvbmUoe30pOwogICAgICB9CiAgICB9IGVsc2UgewogICAgICAkZG9uZSh7fSk7CiAgICB9CiAgfQoKICB2YXIgYXBpID0gewogICAgREVGQVVMVF9DT05GSUc6IERFRkFVTFRfQ09ORklHLAogICAgYmFzZTY0VG9CeXRlczogYmFzZTY0VG9CeXRlcywKICAgIGJ5dGVzVG9CYXNlNjQ6IGJ5dGVzVG9CYXNlNjQsCiAgICBwYXRjaEFwcGxlV0xvY1BheWxvYWQ6IHBhdGNoQXBwbGVXTG9jUGF5bG9hZCwKICAgIHNwb29mQXBwbGVSZXNwb25zZTogc3Bvb2ZBcHBsZVJlc3BvbnNlLAogICAgZXh0cmFjdEFwcGxlV0xvY1BheWxvYWQ6IGV4dHJhY3RBcHBsZVdMb2NQYXlsb2FkLAogICAgcGFyc2VBcnBjOiBwYXJzZUFycGMsCiAgICBjb29yZFRvSW50OiBjb29yZFRvSW50LAogICAgbm9ybWFsaXplQ29uZmlnOiBub3JtYWxpemVDb25maWcsCiAgICBsb2FkQ29uZmlnOiBsb2FkQ29uZmlnCiAgfTsKCiAgaWYgKHR5cGVvZiBtb2R1bGUgIT09ICJ1bmRlZmluZWQiICYmIG1vZHVsZS5leHBvcnRzKSB7CiAgICBtb2R1bGUuZXhwb3J0cyA9IGFwaTsKICB9IGVsc2UgewogICAgcnVuUVgoKTsKICB9Cn0oKSk7Cg==";

/* ==== inlined from src/page.js ==== */

function getPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>iOS Location Spoofer</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="iOSLoc">
<meta name="theme-color" content="#0a0c11">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
:root {
  --bg:#0a0c11; --card:#12161d; --card2:#191e28; --line:#242b38; --inset:rgba(255,255,255,.045);
  --cyan:#17c3cf; --cyan2:#0e97a1; --green:#22c55e; --red:#ff5b60; --orange:#f5a623;
  --txt:#eef2f8; --muted:#8a93a5; --mono:#7fe3ea;
  /* legacy aliases kept so inline styles / JS class hooks keep working */
  --blue:#17c3cf; --gray:#8a93a5;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family:-apple-system,system-ui,"SF Pro","Helvetica Neue",sans-serif;
  color:var(--txt);
  background:
    radial-gradient(900px 380px at 50% -120px, rgba(23,195,207,.14), transparent 70%),
    radial-gradient(600px 300px at 92% 6%, rgba(34,197,94,.07), transparent 65%),
    var(--bg);
  background-attachment:fixed;
}
::placeholder { color:#5d6675; }
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-thumb { background:#2b3342; border-radius:3px; }

/* ---- top bar: sticky glass ---- */
.topbar { position:sticky; top:0; z-index:1200; display:flex; align-items:center; gap:10px; padding:9px 12px; background:rgba(10,12,17,.82); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); border-bottom:1px solid var(--line); font-size:11px; color:var(--muted); }
.topbar .back { flex:none; color:var(--cyan); font-weight:700; text-decoration:none; }
.topbar .topcredit { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.topbar .topcredit a { color:#8fe0e6; text-decoration:none; font-weight:700; }
.topbar .topcredit .ytname { font-size:13.5px; font-weight:800; color:#ff6b70; text-shadow:0 0 14px rgba(255,91,96,.4); }
.topbar .topcredit .forkline { font-size:10.5px; color:#6b7484; }
.topbar .topcredit .forkline .v11 { color:#22c55e; font-weight:700; }
.topbar .tg { flex:none; color:#5cb8e8; font-weight:700; text-decoration:none; padding:3px 9px; border:1px solid rgba(42,171,238,.45); border-radius:20px; }
.topbar .tg:active { background:rgba(42,171,238,.14); }

/* ---- video tutorial CTA ---- */
.vidbtn { display:flex; align-items:center; justify-content:center; gap:8px; margin:12px 12px 0; padding:15px; border-radius:13px; background:transparent; color:#ff6b70; border:1.5px solid rgba(255,91,96,.6); font-size:16px; font-weight:800; text-decoration:none; letter-spacing:.3px; transition:all .12s; }
.vidbtn:active { background:rgba(255,91,96,.12); transform:scale(.98); }

/* ---- anti-resale box: red bar + tint (matches landing) ---- */
.redbox { margin:12px 12px 0; padding:14px 16px; background:linear-gradient(180deg,rgba(255,91,96,.16),rgba(255,91,96,.06)); border:1px solid rgba(255,91,96,.5); border-left:5px solid var(--red); border-radius:12px; }
.redbox .rt { color:#ff6b70; font-size:17px; font-weight:800; line-height:1.4; letter-spacing:.3px; }
.redbox .rb { color:#ffdcdc; font-size:13.5px; font-weight:700; line-height:1.7; margin-top:8px; }

/* ---- map + its glass controls ---- */
#map { height:50vh; width:100%; min-height:250px; background:#0a0c11; border-bottom:1px solid var(--line); }
.leaflet-container { background:#0a0c11; }
.leaflet-control-zoom a { background:rgba(18,22,29,.9)!important; color:var(--txt)!important; border-color:var(--line)!important; -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
.leaflet-control-zoom a:hover { background:var(--card2)!important; }
.leaflet-bar { border:1px solid var(--line)!important; box-shadow:0 4px 18px rgba(0,0,0,.5)!important; }
.leaflet-control-attribution { background:rgba(10,12,17,.7)!important; color:#6b7484!important; }
.leaflet-control-attribution a { color:#8a93a5!important; }

.panel { padding:16px; max-width:600px; margin:0 auto; padding-bottom:calc(16px + env(safe-area-inset-bottom)); }

/* ---- glass cards ---- */
.card { background:linear-gradient(180deg,rgba(25,30,40,.72),rgba(18,22,29,.72)); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:12px; box-shadow:0 8px 28px rgba(0,0,0,.34); }
.card h3 { font-size:15px; font-weight:700; margin-bottom:12px; color:var(--txt); display:flex; align-items:center; gap:8px; }
.card h3::before { content:""; width:3px; height:14px; border-radius:2px; background:linear-gradient(180deg,var(--cyan),var(--green)); flex:none; }

.coords { font-family:"SF Mono",ui-monospace,monospace; font-size:13.5px; color:var(--muted); padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; word-break:break-all; }
.crow { display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; }
.crow .ck { font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--cyan); width:34px; flex:none; }
.crow .cv { flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); word-break:break-all; }
.copybtn { flex:none; }

/* ---- buttons (positions unchanged, look upgraded) ---- */
.row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.btn { flex:1; min-width:100px; padding:12px 16px; border:none; border-radius:11px; font-size:14px; font-weight:700; cursor:pointer; transition:all .15s; }
.btn-primary { background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; box-shadow:0 6px 18px rgba(23,195,207,.28); }
.btn-primary:active { filter:brightness(1.12); transform:scale(.97); }
.btn-secondary { background:var(--card2); color:#c3ccdb; border:1px solid var(--line); font-weight:600; }
.btn-secondary:active { background:#2a3140; transform:scale(.97); }
.btn-danger { background:transparent; color:#ff6b70; border:1px solid rgba(255,91,96,.55); }
.btn-danger:active { background:rgba(255,91,96,.12); transform:scale(.97); }
.btn.success { background:linear-gradient(135deg,#2ee06a,#129a44); color:#04240f; border:none; box-shadow:0 6px 18px rgba(34,197,94,.3); }
.btn-sm { flex:none; min-width:auto; padding:6px 12px; font-size:12px; border-radius:8px; }

/* ---- inputs ---- */
.input-row { display:flex; gap:8px; margin-top:10px; }
.input-row input { flex:1; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:14px; color:var(--txt); outline:none; min-width:0; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.cvi { flex:1; min-width:0; width:100%; font-family:"SF Mono",ui-monospace,monospace; font-size:14px; color:var(--mono); padding:6px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.accfield input { width:100%; padding:8px 10px; background:var(--inset); border:1px solid var(--line); border-radius:8px; font-size:14px; color:var(--txt); outline:none; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.input-row input:focus, .cvi:focus, .accfield input:focus, .modal input:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(23,195,207,.16); }
.acc-row { display:flex; gap:8px; margin-bottom:6px; }
.accfield { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.acclbl { font-size:11px; color:var(--muted); }

.status { font-size:12px; color:var(--muted); margin-top:8px; text-align:center; }
.hint { font-size:11px; color:#6b7484; margin-top:8px; line-height:1.6; }
.accnote { margin-top:10px; padding:11px 13px; background:var(--inset); border:1px solid var(--line); border-left:3px solid var(--cyan); border-radius:9px; font-size:11.5px; color:#a8b1c0; line-height:1.85; }
.accnote b { display:block; color:var(--cyan); font-weight:800; font-size:12px; margin-bottom:6px; letter-spacing:.3px; }
.accnote code { font-family:"SF Mono",ui-monospace,monospace; color:var(--mono); font-size:11px; }
.accnote em { color:var(--txt); font-style:normal; font-weight:800; }
.accnote .src { display:block; margin-top:7px; color:#5d6675; font-size:10.5px; }

/* ---- lists ---- */
.search-results { margin-top:8px; max-height:260px; overflow-y:auto; }
.search-item { padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.search-item:active { background:#232a37; border-color:var(--cyan); }
.search-item .si-name { font-size:14px; color:var(--txt); font-weight:600; }
.search-item .si-sub { font-size:11px; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.error-banner { background:linear-gradient(180deg,rgba(255,91,96,.18),rgba(255,91,96,.08)); border:1px solid rgba(255,91,96,.5); border-left:4px solid var(--red); color:#ffdcdc; padding:14px 16px; border-radius:12px; margin-bottom:12px; font-size:13.5px; line-height:1.6; display:none; }
.error-banner b { display:block; margin-bottom:4px; color:#ff6b70; font-size:14.5px; }

/* --- tiled diagonal watermark (continuous, self-restoring, never blocks the map) --- */
.wm { position:fixed; inset:0; z-index:9998; pointer-events:none; overflow:hidden; user-select:none; -webkit-user-select:none; }
.wm-i { position:absolute; inset:-60%; display:flex; flex-wrap:wrap; align-content:flex-start; transform:rotate(-24deg); opacity:.11; }
.wm-i span { flex:none; padding:26px 30px; font-size:17.5px; font-weight:800; white-space:nowrap; color:#8fe0e6; letter-spacing:.4px; text-shadow:0 1px 3px rgba(0,0,0,.5); }

.toast { position:fixed; top:60px; left:50%; transform:translateX(-50%); background:rgba(8,10,14,.92); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); color:#fff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:opacity .3s; pointer-events:none; z-index:9999; max-width:90vw; text-align:center; box-shadow:0 8px 28px rgba(0,0,0,.5); }
.toast.show { opacity:1; }

.active-loc { background:var(--inset); border:1px solid var(--line); border-radius:10px; padding:11px 12px; font-size:13px; color:var(--txt); }
.active-loc .label { font-size:11px; color:var(--muted); margin-bottom:5px; }
.active-loc .value { font-family:"SF Mono",ui-monospace,monospace; font-size:13px; color:var(--mono); }

.fav-list { max-height:240px; overflow-y:auto; }
.fav-item { display:flex; align-items:center; gap:8px; padding:10px 12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; margin-bottom:6px; cursor:pointer; transition:all .15s; }
.fav-item:active { background:#232a37; border-color:var(--cyan); }
.fav-item .fav-info { flex:1; min-width:0; }
.fav-item .fav-name { font-size:14px; font-weight:600; color:var(--txt); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fav-item .fav-coords { font-size:11px; color:var(--muted); font-family:"SF Mono",ui-monospace,monospace; margin-top:2px; }
.fav-item .fav-active { font-size:10px; color:var(--green); font-weight:700; margin-top:2px; }
.fav-item .fav-del { flex:none; width:28px; height:28px; border:none; border-radius:50%; background:transparent; color:var(--red); font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s; }
.fav-item .fav-del:hover { background:rgba(255,91,96,.14); }
.fav-empty { text-align:center; color:var(--muted); font-size:13px; padding:16px 0; }
.fav-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.fav-header h3 { margin-bottom:0; }

/* ---- modal ---- */
.modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(4,6,10,.66); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); z-index:10000; display:none; align-items:center; justify-content:center; padding:20px; }
.modal-overlay.show { display:flex; }
.modal { background:linear-gradient(180deg,#1a1f29,#12161d); border:1px solid var(--line); border-radius:18px; padding:20px; width:100%; max-width:340px; box-shadow:0 20px 60px rgba(0,0,0,.6); }
.modal h3 { font-size:17px; font-weight:700; margin-bottom:16px; text-align:center; color:var(--txt); }
.modal input { width:100%; padding:12px; background:var(--inset); border:1px solid var(--line); border-radius:10px; font-size:15px; color:var(--txt); outline:none; margin-bottom:12px; -webkit-appearance:none; transition:border-color .15s,box-shadow .15s; }
.modal .modal-btns { display:flex; gap:8px; }
.modal .modal-btns .btn { padding:12px; }

/* ---- map overlay switches: dark glass pills ---- */
.layer-switch { position:absolute; top:10px; right:10px; z-index:1000; display:flex; gap:4px; background:rgba(10,12,17,.74); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 4px 18px rgba(0,0,0,.45); }
.layer-btn { border:none; background:transparent; padding:6px 10px; border-radius:7px; font-size:12px; font-weight:600; color:#a8b1c0; cursor:pointer; transition:all .15s; white-space:nowrap; }
.layer-btn.active { background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; font-weight:700; }
.layer-btn:active { transform:scale(.95); }
.lang-switch { position:absolute; top:10px; left:10px; z-index:1000; display:flex; gap:2px; background:rgba(10,12,17,.74); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); border:1px solid var(--line); border-radius:10px; padding:4px; box-shadow:0 4px 18px rgba(0,0,0,.45); }
.lang-btn { border:none; background:transparent; padding:6px 11px; border-radius:7px; font-size:12px; font-weight:700; color:#a8b1c0; cursor:pointer; transition:all .15s; }
.lang-btn.active { background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; }
.lang-btn:active { transform:scale(.95); }

@media(max-width:480px) { #map { height:44vh; } .panel { padding:12px; } .layer-btn { padding:5px 7px; font-size:11px; } }
</style>
</head>
<body>
<div class="topbar">
  <a class="back" href="/">← 主页</a>
  <span class="topcredit">📺 <a class="ytname" href="https://www.youtube.com/@CyberHandyman/videos" target="_blank" rel="noopener">YouTube CyberHandyman 赛博工具人</a><span class="forkline"> · fork from 鸣谢贡献者: Yu9191 / mekos2772 / acheong08 <span class="v11">· 已同步 Yu9191 v1.1</span></span></span>
  <a class="tg" href="https://t.me/cyberhandymancngroup" target="_blank" rel="noopener">✈️ TG群</a>
</div>
<div class="redbox">
  <div class="rt">⚠️ 免费开源 · 禁止售卖</div>
  <div class="rb"><b>如果你是通过付款来到本页面，请立即联系退款。</b>任何售卖本项目/模块的都是骗子，一经发现立即删库，血本无归！！！！<br>仅供学习研究，禁止违法用途，后果自负、与作者无关，与 Apple 无关。</div>
</div>
<a class="vidbtn" href="https://youtu.be/EspuRlKWUxc" target="_blank" rel="noopener" data-i18n="video_btn">▶️ 视频教程（YouTube）</a>
<div style="position:relative">
<div id="map"></div>
<div class="lang-switch">
  <button class="lang-btn" data-lang="zh" onclick="setLang('zh')">中</button>
  <button class="lang-btn" data-lang="en" onclick="setLang('en')">EN</button>
</div>
<div class="layer-switch">
  <button class="layer-btn active" data-layer="satellite" data-i18n="layer_satellite" onclick="switchLayer('satellite')">Satellite</button>
  <button class="layer-btn" data-layer="wgs84" onclick="switchLayer('wgs84')">WGS84</button>
  <button class="layer-btn" data-layer="amap" data-i18n="layer_amap" onclick="switchLayer('amap')">Amap</button>
  <button class="layer-btn" data-layer="voyager" data-i18n="layer_color" onclick="switchLayer('voyager')">Color</button>
  <button class="layer-btn" data-layer="standard" data-i18n="layer_standard" onclick="switchLayer('standard')">Standard</button>
  <button class="layer-btn" data-layer="dark" data-i18n="layer_dark" onclick="switchLayer('dark')">Dark</button>
</div>
</div>
<div class="panel">
  <div class="error-banner" id="errorBanner" data-i18n-html="err_html"></div>
  <div class="card">
    <h3 data-i18n="choose_title">Choose target location</h3>
    <div class="coords" id="coords" data-i18n="coords_hint">Tap the map or use the tools below to pick a location</div>
    <div id="coordGrid" style="display:none">
      <div class="crow"><span class="ck" data-i18n="lat">Lat</span><span class="cv" id="cvLat"></span><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lat',this)">Copy</button></div>
      <div class="crow"><span class="ck" data-i18n="lon">Lon</span><span class="cv" id="cvLon"></span><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('lon',this)">Copy</button></div>
      <div class="crow"><span class="ck" data-i18n="alt">Alt</span><input class="cvi" id="altInput" type="number" inputmode="decimal" step="1" /><button class="btn btn-sm btn-secondary copybtn" data-i18n="copy" onclick="copyField('alt',this)">Copy</button></div>
      <div class="acc-row">
        <div class="accfield"><span class="acclbl" data-i18n="hacc">H. accuracy</span><input id="haccInput" type="number" inputmode="numeric" step="1" min="1" value="39" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="vacc">V. accuracy</span><input id="vaccInput" type="number" inputmode="numeric" step="1" min="1" value="1000" /></div>
        <div class="accfield"><span class="acclbl" data-i18n="jitter">Jitter radius</span><input id="jitterInput" type="number" inputmode="numeric" step="1" min="0" value="0" /></div>
      </div>
    </div>
    <div class="row">
      <button class="btn btn-primary" id="saveBtn" data-i18n="save" onclick="save()">Save to Device</button>
      <button class="btn btn-secondary" data-i18n="restore" onclick="restoreReal()">Restore real</button>
    </div>
    <div class="row">
      <button class="btn btn-secondary" data-i18n="copy_params" onclick="copyParams(this)">Copy module params</button>
      <button class="btn btn-secondary" data-i18n="add_fav" onclick="addFav()">Add Favorite</button>
      <button class="btn btn-secondary" data-i18n="locate" onclick="locateMe()">Current Location</button>
    </div>
    <div class="hint" data-i18n="alt_hint">Altitude is auto-filled from Open-Meteo (WGS-84) and editable. It is written to the device on Save and applied by the module.</div>
    <div class="accnote" data-i18n-html="acc_note_html"></div>
  </div>
  <div class="card">
    <div class="fav-header">
      <h3 data-i18n="fav_title">Favorites</h3>
      <button class="btn btn-sm btn-secondary" data-i18n="clear_all" onclick="clearAllFav()" id="clearAllBtn" style="display:none">Clear All</button>
    </div>
    <div id="favList" class="fav-list"></div>
  </div>
  <div class="card">
    <h3 data-i18n="active_title">Active coordinates</h3>
    <div class="active-loc" id="activeLoc">
      <div class="label" data-i18n="active_label">On-device coordinates (latitude/longitude/altitude)</div>
      <div class="value" id="activeValue">Querying...</div>
    </div>
    <div class="row">
      <button class="btn btn-sm btn-secondary" data-i18n="refresh" onclick="queryActive()">Refresh</button>
      <button class="btn btn-sm btn-danger" data-i18n="clear_data" onclick="clearActive()">Clear Data</button>
    </div>
  </div>
  <div class="card">
    <h3 data-i18n="paste_title">Paste map link</h3>
    <div class="input-row">
      <input id="urlInput" data-i18n-ph="paste_ph" placeholder="Apple/Google/Amap/Baidu map link or coordinates" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="parse" onclick="parseUrl()">Parse</button>
    </div>
    <div style="font-size:11px;color:var(--gray);margin-top:6px" data-i18n="paste_hint">Supports Apple Maps · Google Maps · Amap · Baidu · coordinate text (auto-converted to WGS-84)</div>
  </div>
  <div class="card">
    <h3 data-i18n="search_title">Search place</h3>
    <div class="input-row">
      <input id="searchInput" data-i18n-ph="search_ph" placeholder="Search a place, Enter to list candidates (preview only)" />
      <button class="btn btn-secondary" style="flex:none;min-width:56px" data-i18n="search" onclick="searchPlace()">Search</button>
    </div>
    <div id="searchResults" class="search-results"></div>
  </div>
  <div class="status" id="status">Pick a location, then tap "Save to Device" to write it to your proxy tool</div>
</div>
<div class="wm" id="wm" aria-hidden="true"><div class="wm-i" id="wmi"></div></div>
<div class="toast" id="toast"></div>
<div class="modal-overlay" id="favModal">
  <div class="modal">
    <h3 data-i18n="modal_title">Add this location to favorites</h3>
    <input id="favNameInput" data-i18n-ph="modal_ph" placeholder="Enter a label (e.g. Office, Home)" maxlength="30" />
    <div style="font-size:12px;color:var(--gray);margin-bottom:12px;text-align:center" id="favModalCoords"></div>
    <div class="modal-btns">
      <button class="btn btn-secondary" data-i18n="cancel" onclick="closeFavModal()">Cancel</button>
      <button class="btn btn-primary" data-i18n="save_short" onclick="confirmFav()">Save</button>
    </div>
  </div>
</div>
<script>
const SAVE_API = 'https://gs-loc.apple.com/ils-settings/save';
const PARSE_API = '/api/parse';
const ELEV_API = 'https://api.open-meteo.com/v1/elevation';
const FAV_KEY = 'ils_favorites';
const LANG_KEY = 'ils_lang';
let lat = 0, lon = 0;          // no hard-coded home city: nothing is "default" until the user picks
let didInitialCenter = false;  // auto-center once, only if the device already has coordinates
let selected = false;
let elev = null, elevState = 'idle'; // idle | loading | ok | fail
let elevSeq = 0, elevTimer = null;
const elevCache = new Map();
let activeLon = null, activeLat = null, activeAcc = null, activeAlt = null, activeStatus = 'querying';
let savedLon = null, savedLat = null, savedTimeStr = '';

/* ---- i18n ---- */
const I18N = {
  zh: {
    title: 'iOS 虚拟定位',
    layer_satellite: '卫星', layer_amap: '高德', layer_color: '彩色', layer_standard: '标准', layer_dark: '暗色',
    err_html: '<b>模块未生效</b>请检查以下配置：<br>1. 已安装并启用 iOS Location Spoofer 模块<br>2. MITM 已开启且信任证书<br>3. MITM 主机名包含 gs-loc.apple.com<br>4. 当前网络已走代理',
    choose_title: '选择目标位置',
    coords_hint: '点击地图或使用下方工具选择位置',
    save: '储存到设备', add_fav: '收藏位置', locate: '当前位置',
    copy: '复制', copy_params: '复制模块参数',
    lat: '纬度', lon: '经度', alt: '海拔',
    alt_querying: '海拔查询中…', alt_na: '海拔不可用',
    alt_hint: '海拔由 Open-Meteo 自动查询（WGS-84），储存到设备时随经纬度一并写入，由 iOS Location Spoofer 模块生效。',
    acc_note_html: '<b>精度参数怎么填</b>' +
      '<code>horizontalAccuracy</code> 水平精度（米），默认 <em>39</em>，越小越「精准」—— 想更像 GPS 可设 <em>5~15</em>；保持 <em>39</em> 也正常。<br>' +
      '<code>verticalAccuracy</code> 垂直精度（米），默认 <em>1000</em> —— 本页已自动填入目标点真实海拔，可调小到 <em>10~30</em>，让海拔显得更可信。<br>' +
      '<code>扰动半径</code>（米），默认 <em>0</em>（关闭）—— 设为 <em>N</em> 后，每次定位在目标点周围 <em>N</em> 米内随机偏移，避免每次结果一模一样。想固定在精确坐标就留 <em>0</em>。' +
      '<span class="src">参数建议来自上游项目 mekos2772 / ios-location-spoofer</span>',
    fav_title: '收藏的位置', clear_all: '清空全部',
    active_title: '当前生效坐标', active_label: '设备本地坐标 (latitude/longitude/altitude)',
    refresh: '刷新', clear_data: '清除数据',
    paste_title: '粘贴地图链接', paste_ph: 'Apple/Google/高德/百度地图链接 或 经纬度', parse: '解析',
    paste_hint: '支持 Apple Maps · Google Maps · 高德 · 百度 · 坐标文本（自动换算为 WGS-84）',
    search_title: '搜索地点', search_ph: '搜地名，回车列出候选（只预览，不改定位）', search: '搜索',
    status_hint: '选好位置后点击「储存到设备」写入代理工具',
    modal_title: '收藏此位置', modal_ph: '输入备注名称（如: 公司、家）', cancel: '取消', save_short: '保存',
    acc: '精度', restore: '恢复真实定位', restored: '✓ 虚拟定位已清除，定位服务开关关闭后，关掉代理开关，等待至少 10 秒钟，再次开启生效', hacc: '水平精度', vacc: '垂直精度', jitter: '扰动半径(米)',
    querying: '查询中...', no_saved: '无已保存的坐标', query_failed: '查询失败 (需要代理模块支持)', cleared: '已清除',
    fav_empty: '暂无收藏，选好位置后点击「收藏位置」',
    active_now: '✓ 当前生效', del: '删除',
    pick_first: '请先在地图上选择一个位置',
    enter_label: '请输入备注名称',
    added: function(n){ return '已收藏: ' + n; },
    deleted: function(n){ return '已删除: ' + n; },
    clear_fav_confirm: '确定清空所有收藏？', all_cleared: '已清空所有收藏',
    clear_confirm: '确定清除设备上已保存的坐标？清除后将使用模块默认参数或停止修改定位。',
    dev_cleared: '已清除设备坐标',
    clear_failed: function(e){ return '清除失败: ' + e; },
    clear_failed_cfg: '清除失败 - 请检查模块配置',
    saving: '储存中...', saved: '✓ 已储存',
    written: function(lo, la, ts){ return '✓ 已写入: ' + lo.toFixed(6) + ', ' + la.toFixed(6) + ' · ' + ts; },
    saved_toast: '✓ 坐标已成功写入模块，定位服务关闭开关，等待至少 10 秒钟，再次开启生效',
    video_btn: '▶️ 视频教程（YouTube）',
    save_failed: '✗ 储存失败 - 请检查模块配置', write_failed: '写入失败',
    no_geo: '浏览器不支持定位', getting_loc: '获取位置中...', got_loc: '已获取当前位置',
    loc_failed: function(m){ return '定位失败: ' + m; },
    paste_first: '请粘贴地图链接或坐标', parse_failed: '无法解析坐标，请检查链接格式', parsing: '解析中...',
    parsed: function(lo, la){ return '已解析: ' + lo.toFixed(4) + ', ' + la.toFixed(4); },
    enter_place: '请输入地名', searching: '搜索中...',
    not_found: function(q){ return '未找到: ' + q; }, search_failed: '搜索失败',
    copied: function(x){ return '已复制: ' + x; }, copy_failed: '复制失败，请手动选择',
    alt_unknown_copy: '海拔尚未获取，仅复制经纬度'
  },
  en: {
    title: 'iOS Location Spoofer',
    layer_satellite: 'Satellite', layer_amap: 'Amap', layer_color: 'Color', layer_standard: 'Standard', layer_dark: 'Dark',
    err_html: '<b>Module not active</b>Please check the following:<br>1. The iOS Location Spoofer module is installed and enabled<br>2. MITM is on and the certificate is trusted<br>3. The MITM hostname list includes gs-loc.apple.com<br>4. The current network is routed through the proxy',
    choose_title: 'Choose target location',
    coords_hint: 'Tap the map or use the tools below to pick a location',
    save: 'Save to Device', add_fav: 'Add Favorite', locate: 'Current Location',
    copy: 'Copy', copy_params: 'Copy module params',
    lat: 'Lat', lon: 'Lon', alt: 'Alt',
    alt_querying: 'querying altitude…', alt_na: 'altitude unavailable',
    alt_hint: 'Altitude is auto-filled from Open-Meteo (WGS-84), written to the device on Save, and applied by the iOS Location Spoofer module.',
    acc_note_html: '<b>Choosing the accuracy values</b>' +
      '<code>horizontalAccuracy</code> in metres, default <em>39</em> — the smaller, the more "precise" it looks. Set <em>5–15</em> to look more like GPS; <em>39</em> is perfectly fine too.<br>' +
      '<code>verticalAccuracy</code> in metres, default <em>1000</em> — this page already fills in the target\\'s real altitude, so lowering it to <em>10–30</em> makes that altitude look more credible.<br>' +
      '<code>Jitter radius</code> in metres, default <em>0</em> (off) — set to <em>N</em> and each positioning is randomly offset within <em>N</em> m of the target, so results are never identical. Leave <em>0</em> to stay pinned to the exact point.' +
      '<span class="src">Guidance from the upstream project mekos2772 / ios-location-spoofer</span>',
    fav_title: 'Favorites', clear_all: 'Clear All',
    active_title: 'Active coordinates', active_label: 'On-device coordinates (latitude/longitude/altitude)',
    refresh: 'Refresh', clear_data: 'Clear Data',
    paste_title: 'Paste map link', paste_ph: 'Apple / Google / Amap / Baidu map link or coordinates', parse: 'Parse',
    paste_hint: 'Supports Apple Maps · Google Maps · Amap · Baidu · coordinate text (auto-converted to WGS-84)',
    search_title: 'Search place', search_ph: 'Search a place, Enter to list candidates (preview only)', search: 'Search',
    status_hint: 'Pick a location, then tap "Save to Device" to write it to your proxy tool',
    modal_title: 'Add this location to favorites', modal_ph: 'Enter a label (e.g. Office, Home)', cancel: 'Cancel', save_short: 'Save',
    acc: 'Accuracy', restore: 'Restore real location', restored: '✓ Spoofed location cleared. Turn Location Services OFF, switch your proxy off, wait at least 10 seconds, then turn it back ON to take effect.', hacc: 'H. accuracy', vacc: 'V. accuracy', jitter: 'Jitter radius(m)',
    querying: 'Querying...', no_saved: 'No saved coordinates', query_failed: 'Query failed (requires the proxy module)', cleared: 'Cleared',
    fav_empty: 'No favorites yet. Pick a location and tap "Add Favorite".',
    active_now: '✓ Active now', del: 'Delete',
    pick_first: 'Please pick a location on the map first',
    enter_label: 'Please enter a label',
    added: function(n){ return 'Added: ' + n; },
    deleted: function(n){ return 'Deleted: ' + n; },
    clear_fav_confirm: 'Clear all favorites?', all_cleared: 'All favorites cleared',
    clear_confirm: 'Clear the coordinates saved on the device? After clearing, the module default parameters will be used or location spoofing will stop.',
    dev_cleared: 'Device coordinates cleared',
    clear_failed: function(e){ return 'Clear failed: ' + e; },
    clear_failed_cfg: 'Clear failed - please check the module configuration',
    saving: 'Saving...', saved: '✓ Saved',
    written: function(lo, la, ts){ return '✓ Written: ' + lo.toFixed(6) + ', ' + la.toFixed(6) + ' · ' + ts; },
    saved_toast: '✓ Coordinates written to the module. Turn Location Services OFF, wait at least 10 seconds, then turn it back ON to take effect.',
    video_btn: '▶️ Video tutorial (YouTube)',
    save_failed: '✗ Save failed - please check the module configuration', write_failed: 'Write failed',
    no_geo: 'Browser does not support geolocation', getting_loc: 'Getting location...', got_loc: 'Current location acquired',
    loc_failed: function(m){ return 'Location failed: ' + m; },
    paste_first: 'Please paste a map link or coordinates', parse_failed: 'Could not parse coordinates, please check the link format', parsing: 'Parsing...',
    parsed: function(lo, la){ return 'Parsed: ' + lo.toFixed(4) + ', ' + la.toFixed(4); },
    enter_place: 'Please enter a place name', searching: 'Searching...',
    not_found: function(q){ return 'Not found: ' + q; }, search_failed: 'Search failed',
    copied: function(x){ return 'Copied: ' + x; }, copy_failed: 'Copy failed, please select manually',
    alt_unknown_copy: 'Altitude not ready, copied lat/lon only'
  }
};

function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch(e) {}
  return 'zh'; // default to Chinese; tap EN to switch (remembered per browser)
}
let lang = detectLang();

function t(key) {
  const v = I18N[lang][key];
  if (typeof v === 'function') return v.apply(null, Array.prototype.slice.call(arguments, 1));
  return v === undefined ? key : v;
}

function applyI18n() {
  document.documentElement.lang = (lang === 'zh' ? 'zh-CN' : 'en');
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach(function(el){ el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function(el){ el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-html]').forEach(function(el){ el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  document.querySelectorAll('.lang-btn').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-lang') === lang); });
  updateCoords();
  updateStatus();
  renderActive();
  renderFavs();
}

function setLang(l) {
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch(e) {}
  applyI18n();
}

const map = L.map('map').setView([20, 0], 2);  // neutral world view — implies no default location
const tiles = {
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS'}),
  wgs84: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'ArcGIS WGS84'}),
  standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'\\u00a9 OSM'}),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'\\u00a9 Carto'}),
  amap: L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {maxZoom:18, subdomains:'1234', attribution:'\\u00a9 Amap'}),
  voyager: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {maxZoom:19, attribution:'\\u00a9 Carto'})
};
let currentLayer = tiles.satellite;
currentLayer.addTo(map);
function switchLayer(name) {
  map.removeLayer(currentLayer);
  currentLayer = tiles[name];
  currentLayer.addTo(map);
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
}
let marker = L.marker([lat, lon], {draggable:true});
let markerShown = false;
function showMarker() { if (!markerShown) { marker.addTo(map); markerShown = true; } }

marker.on('dragend', e => { const p=e.target.getLatLng(); setPos(p.lat, p.lng); });
map.on('click', e => { setPos(e.latlng.lat, e.latlng.lng); });

/* Altitude is an editable field (auto-filled from Open-Meteo, user can override). */
function currentAlt() {
  const el = document.getElementById('altInput');
  if (!el) return null;
  const n = parseFloat(el.value);
  return isFinite(n) ? Math.round(n) : null;
}
function haccVal() { const n = parseInt((document.getElementById('haccInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 39; }
function vaccVal() { const n = parseInt((document.getElementById('vaccInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 1000; }
// randomRadius (Yu9191 v1.1 "扰动半径"): metres of random jitter per positioning. 0 = off.
function jitterVal() { const n = parseInt((document.getElementById('jitterInput')||{}).value, 10); return isFinite(n) && n > 0 ? n : 0; }
function setAltInput(v) {
  const el = document.getElementById('altInput');
  if (!el) return;
  if (v === null) { el.value = ''; el.placeholder = t('alt_na'); }
  else { el.value = v; el.placeholder = ''; }
}

function updateCoords() {
  const grid = document.getElementById('coordGrid');
  const coords = document.getElementById('coords');
  if (!selected) {
    grid.style.display = 'none';
    coords.style.display = '';
    coords.textContent = t('coords_hint');
    return;
  }
  coords.style.display = 'none';
  grid.style.display = '';
  document.getElementById('cvLat').textContent = lat.toFixed(6);
  document.getElementById('cvLon').textContent = lon.toFixed(6);
}

function updateStatus() {
  document.getElementById('status').textContent = (savedLon !== null)
    ? t('written', savedLon, savedLat, savedTimeStr)
    : t('status_hint');
}

function setPos(newLat, newLon, knownAlt) {
  lat = newLat; lon = newLon; selected = true;
  showMarker();
  marker.setLatLng([lat, lon]);
  if (typeof knownAlt === 'number') { elev = Math.round(knownAlt); elevState = 'ok'; elevCache.set(elevKey(lat, lon), elev); }
  updateCoords();
  fetchElevation(lat, lon);
}

function moveTo(newLat, newLon, zoom, knownAlt) {
  setPos(newLat, newLon, knownAlt);
  map.setView([lat, lon], zoom || 15);
}

/* ---- Elevation (Open-Meteo): debounced + cached, WGS-84 native ---- */
function elevKey(la, lo) { return la.toFixed(4) + ',' + lo.toFixed(4); }
function fetchElevation(la, lo) {
  const key = elevKey(la, lo);
  if (elevCache.has(key)) { elev = elevCache.get(key); elevState = (elev === null ? 'fail' : 'ok'); setAltInput(elev); return; }
  elevState = 'loading'; elev = null;
  const el = document.getElementById('altInput'); if (el) { el.value = ''; el.placeholder = t('alt_querying'); }
  const seq = ++elevSeq;
  clearTimeout(elevTimer);
  elevTimer = setTimeout(function(){
    fetch(ELEV_API + '?latitude=' + la + '&longitude=' + lo, { cache:'no-store' })
      .then(r => r.json())
      .then(d => {
        const e = (d && d.elevation && d.elevation.length && d.elevation[0] !== null) ? Math.round(d.elevation[0]) : null;
        elevCache.set(key, e);
        if (seq === elevSeq) { elev = e; elevState = (e === null ? 'fail' : 'ok'); setAltInput(e); }
      })
      .catch(() => { if (seq === elevSeq) { elev = null; elevState = 'fail'; setAltInput(null); } });
  }, 500);
}

let toastTimer = null;
function toast(msg, ms) {
  const t2 = document.getElementById('toast');
  t2.textContent = msg; t2.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t2.classList.remove('show'), ms || 2500);
}

function showError(show) {
  document.getElementById('errorBanner').style.display = show ? 'block' : 'none';
}

/* ---- Clipboard ---- */
function copyText(str) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(str);
  }
  return new Promise(function(resolve, reject){
    try {
      const ta = document.createElement('textarea');
      ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand failed'));
    } catch(e) { reject(e); }
  });
}

function copyField(which, btn) {
  if (!selected) { toast(t('pick_first')); return; }
  let val;
  if (which === 'lat') val = lat.toFixed(6);
  else if (which === 'lon') val = lon.toFixed(6);
  else { const a = currentAlt(); if (a === null) { toast(t('alt_na')); return; } val = String(a); }
  copyText(val).then(() => {
    toast(t('copied', val));
    if (btn) { const o = btn.textContent; btn.classList.add('success'); btn.textContent = '✓'; setTimeout(() => { btn.textContent = o; btn.classList.remove('success'); }, 1200); }
  }).catch(() => toast(t('copy_failed'), 3000));
}

function moduleParamString() {
  let s = 'latitude=' + lat.toFixed(6) + '&longitude=' + lon.toFixed(6);
  const a = currentAlt(); if (a !== null) s += '&altitude=' + a;
  s += '&horizontalAccuracy=' + haccVal() + '&verticalAccuracy=' + vaccVal();
  const j = jitterVal(); if (j > 0) s += '&randomRadius=' + j;
  return s;
}

function copyParams(btn) {
  if (!selected) { toast(t('pick_first')); return; }
  const s = moduleParamString();
  copyText(s).then(() => {
    toast(t('copied', s));
    if (currentAlt() === null) toast(t('alt_unknown_copy'), 3000);
    if (btn) { const o = btn.textContent; btn.classList.add('success'); btn.textContent = t('saved'); setTimeout(() => { btn.textContent = o; btn.classList.remove('success'); }, 1200); }
  }).catch(() => toast(t('copy_failed'), 3000));
}

/* ---- Favorites (localStorage) ---- */
function getFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch(e) { return []; }
}
function saveFavs(favs) {
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
}

function renderFavs() {
  const favs = getFavs();
  const el = document.getElementById('favList');
  const clearBtn = document.getElementById('clearAllBtn');
  clearBtn.style.display = favs.length ? '' : 'none';
  if (!favs.length) {
    el.innerHTML = '<div class="fav-empty">' + escHtml(t('fav_empty')) + '<\\/div>';
    return;
  }
  el.innerHTML = favs.map((f, i) => {
    const isActive = activeLon !== null && Math.abs(f.lon - activeLon) < 0.000001 && Math.abs(f.lat - activeLat) < 0.000001;
    const altStr = (typeof f.alt === 'number') ? ('  ·  ' + f.alt + ' m') : '';
    return '<div class="fav-item" onclick="loadFav(' + i + ')">' +
      '<div class="fav-info">' +
        '<div class="fav-name">' + escHtml(f.name) + '<\\/div>' +
        '<div class="fav-coords">' + f.lon.toFixed(6) + ', ' + f.lat.toFixed(6) + altStr + '<\\/div>' +
        (isActive ? '<div class="fav-active">' + escHtml(t('active_now')) + '<\\/div>' : '') +
      '<\\/div>' +
      '<button class="fav-del" onclick="event.stopPropagation();delFav(' + i + ')" title="' + escHtml(t('del')) + '">\\u00d7<\\/button>' +
    '<\\/div>';
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function addFav() {
  if (!selected) { toast(t('pick_first')); return; }
  var _fa = currentAlt();
  document.getElementById('favModalCoords').textContent = lon.toFixed(6) + ', ' + lat.toFixed(6) + (_fa !== null ? ('  ·  ' + _fa + ' m') : '');
  document.getElementById('favNameInput').value = '';
  document.getElementById('favModal').classList.add('show');
  setTimeout(() => document.getElementById('favNameInput').focus(), 100);
}

function closeFavModal() {
  document.getElementById('favModal').classList.remove('show');
}

function confirmFav() {
  const name = document.getElementById('favNameInput').value.trim();
  if (!name) { toast(t('enter_label')); return; }
  const favs = getFavs();
  const rec = { name, lon, lat, time: new Date().toISOString() };
  const _ca = currentAlt(); if (_ca !== null) rec.alt = _ca;
  favs.push(rec);
  saveFavs(favs);
  closeFavModal();
  renderFavs();
  toast(t('added', name));
}

function loadFav(i) {
  const favs = getFavs();
  if (!favs[i]) return;
  moveTo(favs[i].lat, favs[i].lon, 15, typeof favs[i].alt === 'number' ? favs[i].alt : undefined);
  toast(favs[i].name + ' (' + favs[i].lon.toFixed(4) + ', ' + favs[i].lat.toFixed(4) + ')');
}

function delFav(i) {
  const favs = getFavs();
  if (!favs[i]) return;
  const name = favs[i].name;
  favs.splice(i, 1);
  saveFavs(favs);
  renderFavs();
  toast(t('deleted', name));
}

function clearAllFav() {
  if (!confirm(t('clear_fav_confirm'))) return;
  saveFavs([]);
  renderFavs();
  toast(t('all_cleared'));
}

/* ---- Active location query ---- */
function renderActive() {
  const el = document.getElementById('activeValue');
  if (activeStatus === 'ok') {
    el.textContent = t('lon') + ' ' + activeLon.toFixed(6) + '  ' + t('lat') + ' ' + activeLat.toFixed(6)
      + (activeAcc ? ('  ' + t('acc') + ' ' + activeAcc + 'm') : '')
      + (activeAlt !== null && activeAlt !== undefined ? ('  ' + t('alt') + ' ' + activeAlt + 'm') : '');
  } else if (activeStatus === 'none') {
    el.textContent = t('no_saved');
  } else if (activeStatus === 'failed') {
    el.textContent = t('query_failed');
  } else if (activeStatus === 'cleared') {
    el.textContent = t('cleared');
  } else {
    el.textContent = t('querying');
  }
}

function queryActive() {
  activeStatus = 'querying';
  renderActive();
  fetch(SAVE_API + '?action=query', { method:'GET', mode:'cors', cache:'no-store' })
    .then(r => r.json())
    .then(d => {
      if (d.success && d.longitude && d.latitude) {
        activeLon = parseFloat(d.longitude);
        activeLat = parseFloat(d.latitude);
        activeAcc = (d.horizontalAccuracy != null ? d.horizontalAccuracy : (d.accuracy || null));
        activeAlt = (d.altitude !== undefined && d.altitude !== null) ? d.altitude : null;
        // Reflect the device's stored jitter radius back into the input (Yu9191 v1.1).
        if (d.randomRadius != null) { const ji = document.getElementById('jitterInput'); if (ji) ji.value = d.randomRadius; }
        activeStatus = 'ok';
        if (!didInitialCenter && !selected) {
          didInitialCenter = true;
          moveTo(activeLat, activeLon, 15, (activeAlt !== null && activeAlt !== undefined) ? activeAlt : undefined);
        }
      } else {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'none';
      }
      renderActive();
      renderFavs();
    })
    .catch(() => { activeStatus = 'failed'; renderActive(); });
}

function clearActive() {
  if (!confirm(t('clear_confirm'))) return;
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store' })
    .then(r => r.json())
    .then(d => {
      if (d.success) {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'cleared';
        renderActive();
        renderFavs();
        toast(t('dev_cleared'));
      } else { toast(t('clear_failed', d.error || ''), 3000); }
    })
    .catch(() => { toast(t('clear_failed_cfg'), 3000); });
}

/* ---- Save to device ---- */
async function save() {
  if (!selected) { toast(t('pick_first')); return; }
  const btn = document.getElementById('saveBtn');
  btn.textContent = t('saving'); btn.disabled = true;
  showError(false);
  try {
    let url = SAVE_API + '?lon=' + lon + '&lat=' + lat;
    const a = currentAlt(); if (a !== null) url += '&alt=' + a;
    url += '&hacc=' + haccVal() + '&vacc=' + vaccVal() + '&randomRadius=' + jitterVal();
    const r = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
    const d = await r.json();
    if (d.success) {
      activeLon = lon; activeLat = lat; activeAcc = haccVal();
      activeAlt = currentAlt();
      activeStatus = 'ok';
      savedLon = lon; savedLat = lat; savedTimeStr = new Date().toLocaleTimeString();
      btn.textContent = t('saved'); btn.className = 'btn btn-primary success';
      updateStatus();
      renderActive();
      renderFavs();
      toast(t('saved_toast'), 30000);
      setTimeout(() => { btn.textContent = t('save'); btn.className='btn btn-primary'; btn.disabled=false; }, 2500);
    } else {
      throw new Error(d.error || t('write_failed'));
    }
  } catch(e) {
    btn.textContent = t('save'); btn.className = 'btn btn-primary'; btn.disabled = false;
    showError(true);
    toast(t('save_failed'), 4000);
  }
}

function locateMe() {
  if (!navigator.geolocation) return toast(t('no_geo'));
  toast(t('getting_loc'));
  navigator.geolocation.getCurrentPosition(
    pos => { moveTo(pos.coords.latitude, pos.coords.longitude, 16); toast(t('got_loc')); },
    err => toast(t('loc_failed', err.message), 3000),
    { enableHighAccuracy:true, timeout:10000 }
  );
}

/* Local fallback for plain "lat, lon" text when the parse API is unreachable. */
function parseLocalCoords(text) {
  const m = text.match(/(-?[0-9]+\\.[0-9]+)[,\\s]+(-?[0-9]+\\.[0-9]+)/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a };
  return { lat: a, lon: b };
}

async function parseUrl() {
  const input = document.getElementById('urlInput').value.trim();
  if (!input) return toast(t('paste_first'));
  toast(t('parsing'));
  try {
    const r = await fetch(PARSE_API + '?format=json&u=' + encodeURIComponent(input), { cache:'no-store' });
    const d = await r.json();
    if (d && typeof d.lat === 'number' && typeof d.lon === 'number') {
      moveTo(d.lat, d.lon, 15);
      toast(d.name ? (d.name + ' (' + d.lon.toFixed(4) + ', ' + d.lat.toFixed(4) + ')') : t('parsed', d.lon, d.lat));
      return;
    }
    throw new Error(d && d.error ? d.error : 'parse failed');
  } catch(e) {
    const local = parseLocalCoords(input);
    if (local) { moveTo(local.lat, local.lon, 15); toast(t('parsed', local.lon, local.lat)); return; }
    toast(t('parse_failed'), 3000);
  }
}

let searchResults = [];
async function searchPlace() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return toast(t('enter_place'));
  const box = document.getElementById('searchResults');
  box.innerHTML = '<div class="search-item">' + escHtml(t('searching')) + '<\\/div>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q='+encodeURIComponent(q), { headers: { 'Accept-Language': (lang === 'zh' ? 'zh-CN' : 'en') } });
    searchResults = await r.json();
    if (!searchResults.length) { box.innerHTML = ''; toast(t('not_found', q), 3000); return; }
    box.innerHTML = searchResults.map(function(p, i){
      const name = p.display_name || '';
      return '<div class="search-item" onclick="selectSearchResult(' + i + ')">' +
        '<div class="si-name">' + escHtml(name.split(',')[0]) + '<\\/div>' +
        '<div class="si-sub">' + escHtml(name) + '<\\/div>' +
      '<\\/div>';
    }).join('');
  } catch(e) { box.innerHTML = ''; toast(t('search_failed'), 3000); }
}
function selectSearchResult(i) {
  const p = searchResults[i];
  if (!p) return;
  moveTo(parseFloat(p.lat), parseFloat(p.lon), 15);
  toast((p.display_name || '').slice(0, 40));
}
function restoreReal() {
  fetch(SAVE_API + '?action=clear', { method:'GET', mode:'cors', cache:'no-store' })
    .then(r => r.json())
    .then(d => {
      if (d.success) {
        activeLon = null; activeLat = null; activeAcc = null; activeAlt = null;
        activeStatus = 'cleared'; savedLon = null;
        updateStatus(); renderActive(); renderFavs();
        toast(t('restored'), 30000);
      } else { toast(t('clear_failed_cfg'), 3000); }
    })
    .catch(() => toast(t('clear_failed_cfg'), 3000));
}

document.addEventListener('paste', e => {
  const text = (e.clipboardData||window.clipboardData).getData('text');
  if (text && (text.includes('map') || text.includes('loc') || text.includes('lnglat') || text.includes('baidu') || /[0-9]+\\.[0-9]+/.test(text))) {
    document.getElementById('urlInput').value = text;
    setTimeout(parseUrl, 200);
  }
});
document.getElementById('searchInput').addEventListener('keydown', e => { if(e.key==='Enter') searchPlace(); });
document.getElementById('urlInput').addEventListener('keydown', e => { if(e.key==='Enter') parseUrl(); });
document.getElementById('favNameInput').addEventListener('keydown', e => { if(e.key==='Enter') confirmFav(); });

/* ---- Watermark: tiled, non-interactive, rebuilt if tampered with ---- */
const WM_TEXT = 'YouTube：赛博工具人 @CyberHandyman 根据GitHub开源项目制作';
function buildWM() {
  let host = document.getElementById('wm');
  if (!host) { host = document.createElement('div'); host.id = 'wm'; host.className = 'wm'; host.setAttribute('aria-hidden','true'); document.body.appendChild(host); }
  host.className = 'wm'; host.removeAttribute('style');
  const n = Math.ceil((window.innerWidth * window.innerHeight) / 12000) + 40;
  let s = '';
  for (let i = 0; i < n; i++) s += '<span>' + WM_TEXT + '<\\/span>';
  host.innerHTML = '<div class="wm-i" id="wmi">' + s + '<\\/div>';
}
function ensureWM() {
  const host = document.getElementById('wm'), inner = document.getElementById('wmi');
  if (!host || !inner || inner.textContent.indexOf('CyberHandyman') < 0) { buildWM(); return; }
  const ch = getComputedStyle(host), ci = getComputedStyle(inner);
  if (ch.display === 'none' || ch.visibility === 'hidden' || ch.position !== 'fixed' || parseFloat(ci.opacity) < 0.03) {
    host.removeAttribute('style'); inner.removeAttribute('style'); buildWM();
  }
}
buildWM();
try { new MutationObserver(ensureWM).observe(document.body, { childList: true }); } catch(e) {}
setInterval(ensureWM, 1500);
window.addEventListener('resize', buildWM);

applyI18n();
queryActive();
<\/script>
</body>
</html>`;
}

/* ==== inlined from src/landing.js ==== */

function getLandingHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>iOS Location Spoofer · 虚拟定位</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0a0c11">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
:root{
  --bg:#0a0c11; --card:#12161d; --card2:#191e28; --line:#242b38;
  --cyan:#17c3cf; --cyan2:#0e97a1; --green:#22c55e; --green2:#159a45;
  --red:#ff5b60; --amber:#f5a623; --txt:#eef2f8; --muted:#8a93a5; --mono:#7fe3ea;
}
*{ margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
body{
  font-family:-apple-system,system-ui,"SF Pro","Helvetica Neue",sans-serif;
  color:var(--txt); line-height:1.5;
  background:
    radial-gradient(1100px 420px at 50% -140px, rgba(23,195,207,.16), transparent 70%),
    radial-gradient(700px 360px at 90% 8%, rgba(34,197,94,.08), transparent 65%),
    var(--bg);
  background-attachment:fixed;
}
.wrap{ max-width:600px; margin:0 auto; padding:20px 16px calc(44px + env(safe-area-inset-bottom)); }

/* --- top warning: red accent bar + tint --- */
.warn{ position:relative; background:linear-gradient(180deg,rgba(255,91,96,.16),rgba(255,91,96,.06)); border:1px solid rgba(255,91,96,.5); border-left:5px solid var(--red); border-radius:12px; padding:15px 18px; margin-bottom:12px; }
.warn .t{ color:#ff6b70; font-size:20px; font-weight:800; letter-spacing:.4px; line-height:1.4; }
.warn .b{ color:#ffdcdc; font-size:15.5px; font-weight:700; line-height:1.7; margin-top:9px; }

/* --- disclaimer --- */
.disc{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:13px 16px; margin-bottom:18px; }
.disc-t{ font-size:13px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--cyan); margin-bottom:9px; }
.disc-list{ margin:0; padding-left:17px; }
.disc-list li{ font-size:12px; color:var(--muted); line-height:1.75; margin-bottom:6px; }
.disc-list li b{ color:#c3ccdb; }

/* --- header / branding --- */
header{ text-align:center; padding:8px 0 6px; }
header .logowrap{ position:relative; width:74px; margin:0 auto 14px; }
header .logo{ width:74px; height:74px; border-radius:20px; display:block; box-shadow:0 0 0 1px var(--line),0 10px 30px rgba(23,195,207,.28); }
h1{ font-size:23px; font-weight:800; letter-spacing:.3px; background:linear-gradient(92deg,#eafcff,#7fe3ea 55%,#22c55e); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.ytline{ margin-top:13px; font-size:17.5px; font-weight:800; letter-spacing:.3px; line-height:1.5; }
.ytline .yt{ color:#ff6b70; text-decoration:none; text-shadow:0 0 18px rgba(255,91,96,.45); }
.credit{ font-size:12px; color:var(--muted); margin-top:9px; line-height:1.7; }
.credit a{ color:#8fe0e6; text-decoration:none; }
.synced{ font-size:12px; color:#22c55e; font-weight:700; margin-top:8px; }
.synced a{ color:#22c55e; text-decoration:underline; }

/* --- primary CTAs (green picker + video) --- */
.ctas{ display:flex; gap:10px; margin:18px 0 4px; }
.enter{ flex:1; display:flex; align-items:center; justify-content:center; gap:8px; padding:17px 14px; border:none; border-radius:14px; font-size:16px; font-weight:800; cursor:pointer; text-decoration:none; transition:transform .12s,box-shadow .12s; }
.enter:active{ transform:scale(.97); }
.enter.go{ background:linear-gradient(135deg,#2ee06a,#129a44); color:#04240f; box-shadow:0 10px 26px rgba(34,197,94,.34); }
.enter.video{ background:transparent; color:#ff6b70; border:1.5px solid rgba(255,91,96,.6); flex:0 0 44%; }
.enter.video:active{ background:rgba(255,91,96,.1); }
.enter.tg{ width:100%; margin:10px 0 4px; background:transparent; color:#5cb8e8; border:1.5px solid rgba(42,171,238,.55); }
.enter.tg:active{ background:rgba(42,171,238,.12); }

.divider{ height:1px; background:linear-gradient(90deg,transparent,var(--line),transparent); margin:24px 0 20px; }

/* --- section heads with accent bar --- */
h2{ font-size:16px; font-weight:800; margin-bottom:4px; display:flex; align-items:center; gap:9px; }
h2::before{ content:""; width:4px; height:16px; border-radius:2px; background:linear-gradient(180deg,var(--cyan),var(--green)); }
.sub{ font-size:12.5px; color:var(--muted); margin:0 0 14px 13px; }
.note{ background:var(--card); border:1px solid var(--line); border-left:4px solid var(--cyan); border-radius:11px; padding:12px 14px; font-size:12.5px; color:#c3ccdb; margin-bottom:16px; }
.note b{ color:var(--txt); }

/* --- platform cards --- */
.plat{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; }
.plat .big{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:14px; border:none; border-radius:11px; background:linear-gradient(135deg,var(--cyan),var(--cyan2)); color:#022a2d; font-size:15.5px; font-weight:800; cursor:pointer; text-align:center; text-decoration:none; transition:filter .12s,transform .12s; }
.plat .big:active{ filter:brightness(1.1); transform:scale(.98); }
.plat .line{ display:flex; align-items:center; gap:8px; margin-top:9px; }
.plat .url{ flex:1; min-width:0; font-family:"SF Mono",ui-monospace,monospace; font-size:11px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plat .copy{ flex:none; padding:8px 15px; border:1px solid var(--line); border-radius:8px; background:var(--card2); color:var(--txt); font-size:12.5px; font-weight:600; cursor:pointer; transition:all .12s; }
.plat .copy:active{ background:#2a3140; }
.plat .copy.ok{ background:var(--green); border-color:var(--green); color:#04240f; }
.plat .pnote{ font-size:11.5px; color:var(--muted); margin-top:7px; line-height:1.6; }

/* --- info boxes --- */
.mitm{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:13px 15px; font-size:12.5px; color:#c3ccdb; margin-top:16px; }
.mitm b{ color:var(--txt); }
.mitm code{ display:inline-block; font-family:"SF Mono",ui-monospace,monospace; font-size:11.5px; color:var(--mono); word-break:break-all; line-height:2; }
.mitm .hosts{ margin-top:8px; padding:10px 12px; background:var(--bg); border:1px solid var(--line); border-radius:9px; }
.mitm .hosts code{ line-height:2.1; }

/* --- tiled diagonal watermark (continuous, self-restoring) --- */
.wm{ position:fixed; inset:0; z-index:90; pointer-events:none; overflow:hidden; user-select:none; -webkit-user-select:none; }
.wm-i{ position:absolute; inset:-60%; display:flex; flex-wrap:wrap; align-content:flex-start; transform:rotate(-24deg); opacity:.11; }
.wm-i span{ flex:none; padding:26px 30px; font-size:17.5px; font-weight:800; white-space:nowrap; color:#8fe0e6; letter-spacing:.4px; }

.toast{ position:fixed; left:50%; bottom:40px; transform:translateX(-50%) translateY(20px); background:rgba(8,10,14,.92); color:#fff; padding:11px 20px; border-radius:22px; font-size:14px; opacity:0; transition:all .25s; pointer-events:none; z-index:99; border:1px solid var(--line); }
.toast.show{ opacity:1; transform:translateX(-50%) translateY(0); }
footer{ text-align:center; font-size:11.5px; color:var(--muted); margin-top:26px; line-height:1.9; }
footer b{ color:#8fe0e6; }
</style>
</head>
<body>
<div class="wrap">
  <div class="warn">
    <div class="t">⚠️ 免费开源项目 · 禁止售卖</div>
    <div class="b"><b>如果你是通过付款来到本页面，请立即联系退款。</b><br>任何售卖本项目 / 模块的都是骗子。一经发现立即删库，血本无归。</div>
  </div>
  <div class="disc">
    <div class="disc-t">免责声明</div>
    <ol class="disc-list">
      <li>本项目为免费开源工具，<b>仅供个人学习、研究与技术测试之用</b>，请勿用于任何违反所在国家/地区法律法规的用途。</li>
      <li>使用本项目（含模块、脚本、选点页）所引发的<b>一切风险与后果，由使用者自行承担</b>，与开源项目原作者、贡献者及本页面维护者无关。</li>
      <li>本项目与 <b>Apple Inc.</b> 无任何关联，不隶属、不代表 Apple，亦未获其授权或认可。</li>
      <li>本项目<b>不在中国大陆提供服务</b>。</li>
      <li>下载、安装或使用本项目，即视为你已阅读并同意本声明；如不同意，请立即停止使用。</li>
    </ol>
  </div>

  <header>
    <div class="logowrap"><img class="logo" src="/icon.svg" alt=""></div>
    <h1>iOS Location Spoofer · 虚拟定位</h1>
    <p class="ytline">📺 <a class="yt" href="https://www.youtube.com/@CyberHandyman/videos" target="_blank" rel="noopener">YouTube：CyberHandyman 赛博工具人</a></p>
    <p class="credit">
      fork from 鸣谢贡献者：<a href="https://github.com/Yu9191/wloc" target="_blank" rel="noopener">Yu9191</a> ·
      <a href="https://github.com/mekos2772/ios-location-spoofer" target="_blank" rel="noopener">mekos2772</a> ·
      <a href="https://github.com/acheong08/ios-location-spoofer" target="_blank" rel="noopener">acheong08</a>
    </p>
    <p class="synced">✅ 已同步上游 <a href="https://github.com/Yu9191/wloc/releases" target="_blank" rel="noopener">Yu9191/wloc v1.1</a>：随机扰动半径 · 港澳台/百度坐标解析</p>
  </header>

  <div class="ctas">
    <a class="enter go" href="/picker">🗺️ 进入选点网页</a>
    <a class="enter video" href="https://youtu.be/EspuRlKWUxc" target="_blank" rel="noopener">▶️ 视频教程</a>
  </div>
  <a class="enter tg" href="https://t.me/cyberhandymancngroup" target="_blank" rel="noopener">✈️ 加入 Telegram 讨论群</a>

  <div class="divider"></div>

  <h2>安装模块</h2>
  <p class="sub">选你的代理客户端，点「一键导入」直接装；或「复制」手动添加。</p>
  <div class="note">📍 生效前提：① 代理 App 已连接（开关/引擎打开、<b>非「直连」模式</b>）；② 开启 HTTPS 解密(MITM) 并信任证书；③ 装好对应客户端的模块。之后打开选点页选位置、点「储存到设备」即可生效。iOS 26+ 切换后可能需重启一次设备清缓存。</div>

  <div id="plats"></div>

  <div class="mitm">
    <b>Quantumult X 资源解析器 URL（QX 一键导入 / 重写引用需先配好）：</b><br>
    <code>https://raw.githubusercontent.com/KOP-XIAO/QuantumultX/master/Scripts/resource-parser.js</code><br>
    添加方式 —— 把下面这段填进 QX 配置：<br>
    <code>[general]<br>#复制下面这些内容（另起一行）<br>resource_parser_url=https://raw.githubusercontent.com/KOP-XIAO/QuantumultX/master/Scripts/resource-parser.js</code>
  </div>
  <div class="mitm">
    <b>MITM 主机名（如全部配置成功仍不生效，在 MITM / HTTPS 解密中手动加入下面四个域名）：</b>
    <div class="hosts"><code>gs-loc.apple.com<br>gs-loc-cn.apple.com<br>bluedot.is.autonavi.com<br>bluedot.is.autonavi.com.gds.alibabadns.com</code></div>
  </div>

  <footer>
    坐标只存在你<b>当前设备</b>上，服务端不留存记录。<br>
    GNU AGPL-3.0 · 仅供学习研究
  </footer>
</div>
<div class="wm" id="wm" aria-hidden="true"><div class="wm-i" id="wmi"></div></div>
<div class="toast" id="toast"></div>
<script>
/* ---- Watermark: tiled, non-interactive, rebuilt if tampered with ---- */
var WM_TEXT = 'YouTube：赛博工具人 @CyberHandyman 根据GitHub开源项目制作';
function buildWM(){
  var host = document.getElementById('wm');
  if (!host){ host = document.createElement('div'); host.id = 'wm'; host.className = 'wm'; host.setAttribute('aria-hidden','true'); document.body.appendChild(host); }
  host.className = 'wm'; host.removeAttribute('style');
  var n = Math.ceil((window.innerWidth * window.innerHeight) / 12000) + 40;
  var s = '';
  for (var i = 0; i < n; i++) s += '<span>' + WM_TEXT + '</span>';
  host.innerHTML = '<div class="wm-i" id="wmi">' + s + '</div>';
}
function ensureWM(){
  var host = document.getElementById('wm'), inner = document.getElementById('wmi');
  if (!host || !inner || inner.textContent.indexOf('CyberHandyman') < 0) { buildWM(); return; }
  var ch = getComputedStyle(host), ci = getComputedStyle(inner);
  if (ch.display === 'none' || ch.visibility === 'hidden' || ch.position !== 'fixed' || parseFloat(ci.opacity) < 0.03) {
    host.removeAttribute('style'); inner.removeAttribute('style'); buildWM();
  }
}
buildWM();
try { new MutationObserver(ensureWM).observe(document.body, { childList:true }); } catch(e) {}
setInterval(ensureWM, 1500);
window.addEventListener('resize', buildWM);

var origin = location.origin;
function u(file){ return origin + '/' + file; }
var qxExtra = ', tag=iOS Location Spoofer, update-interval=172800, opt-parser=true, enabled=true';
var PLATS = [
  { name:'Surge', file:'ios-location-spoofer.sgmodule', scheme:function(x){ return 'surge:///install-module?url=' + encodeURIComponent(x); } },
  { name:'Shadowrocket', file:'ios-location-spoofer.sgmodule', scheme:function(x){ return 'shadowrocket://install?module=' + encodeURIComponent(x); } },
  { name:'Egern', file:'ios-location-spoofer.sgmodule', scheme:function(x){ return 'egern:///install-module?url=' + encodeURIComponent(x); } },
  { name:'Loon', file:'ios-location-spoofer.lnplugin', scheme:function(x){ return 'loon://import?plugin=' + encodeURIComponent(x); } },
  { name:'Stash', file:'ios-location-spoofer.stoverride', scheme:function(x){ return 'stash://install-override?url=' + encodeURIComponent(x); } },
  { name:'Quantumult X', file:'ios-location-spoofer.snippet',
    scheme:function(x){ return 'quantumult-x:///add-resource?remote-resource=' + encodeURIComponent(JSON.stringify({ rewrite_remote:[x + qxExtra] })); },
    note:'QX 没有模块面板：一键导入=添加「重写」资源(需已配资源解析器)；MITM 主机名要手动加进 设置→MITM。' }
];

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(m){ var t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); }, 1800); }
function copyText(s){
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
  return new Promise(function(res,rej){ try{ var ta=document.createElement('textarea'); ta.value=s; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); var ok=document.execCommand('copy'); document.body.removeChild(ta); ok?res():rej(); }catch(e){ rej(e); } });
}
function doCopy(s, btn){ copyText(s).then(function(){ toast('已复制模块链接'); var o=btn.textContent; btn.classList.add('ok'); btn.textContent='✓'; setTimeout(function(){ btn.textContent=o; btn.classList.remove('ok'); }, 1200); }).catch(function(){ toast('复制失败，请手动选择'); }); }

var html = '';
for (var i=0; i<PLATS.length; i++){
  var p = PLATS[i];
  var url = u(p.file);
  html += '<div class="plat">' +
    '<a class="big" href="' + esc(p.scheme(url)) + '">一键导入 ' + esc(p.name) + '</a>' +
    '<div class="line"><span class="url">' + esc(url) + '</span>' +
    '<button class="copy" data-url="' + esc(url) + '">复制</button></div>' +
    (p.note ? '<div class="pnote">' + esc(p.note) + '</div>' : '') +
    '</div>';
}
document.getElementById('plats').innerHTML = html;
var btns = document.querySelectorAll('.copy');
for (var j=0; j<btns.length; j++){ (function(b){ b.addEventListener('click', function(){ doCopy(b.getAttribute('data-url'), b); }); })(btns[j]); }
<\/script>
</body>
</html>`;
}

/* ==== inlined from src/index.js (imports stripped, Hono shimmed) ==== */

const app = new Hono();

app.get("/", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getLandingHtml());
});
app.get("/picker", (c) => {
  c.header("Cache-Control", "no-cache");
  return c.html(getPageHtml());
});

/* ---- PWA: manifest + icons (enables "Add to Home Screen") ---- */
const MANIFEST = {
  name: "iOS Location Spoofer",
  short_name: "iOSLoc",
  description: "Stateless map picker for iOS Location Spoofer (WGS-84 + altitude).",
  start_url: "/picker",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#f2f2f7",
  theme_color: "#007aff",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};
const IMG_CACHE = "public, max-age=604800, immutable";
app.get("/manifest.webmanifest", (c) =>
  c.body(JSON.stringify(MANIFEST), 200, { "Content-Type": "application/manifest+json", "Cache-Control": IMG_CACHE })
);
app.get("/icon.svg", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));
app.get("/icon-180.png", (c) => c.body(b64ToBytes(ICON_180_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/icon-512.png", (c) => c.body(b64ToBytes(ICON_512_B64), 200, { "Content-Type": "image/png", "Cache-Control": IMG_CACHE }));
app.get("/favicon.ico", (c) => c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMG_CACHE }));

/* ---- Self-hosted on-device module ----
   Serve the two module scripts + a subscribable manifest so the whole stateless
   setup runs from this worker with NO GitHub dependency. The manifest self-references
   whatever domain served it (workers.dev URL or a custom domain). */
const JS_HEADERS = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" };
app.get("/location-spoofer.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_B64), 200, JS_HEADERS));
app.get("/location-settings.js", (c) => c.body(b64ToBytes(LOCATION_SETTINGS_B64), 200, JS_HEADERS));
app.get("/location-spoofer-qx.js", (c) => c.body(b64ToBytes(LOCATION_SPOOFER_QX_B64), 200, JS_HEADERS));

function sgmodule(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=任何售卖本项目/模块的都是骗子，请立即联系退款。无状态版：坐标写入每台设备各自的本机存储、可公开共用、多人互不覆盖。搭配选点页使用。适用于 Shadowrocket / Surge / Egern。
#!homepage=${origin}

[Script]
iOS Location Spoofer = type=http-response,pattern=^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$,requires-body=1,binary-body-mode=1,max-size=1048576,timeout=10,script-path=${origin}/location-spoofer.js,argument=mode=response&debug=false
iLS Settings = type=http-request,pattern=^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/,requires-body=0,max-size=0,timeout=10,script-path=${origin}/location-settings.js

[MITM]
hostname = %APPEND% gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
function stoverride(origin) {
  return String.raw`name: iOS Location Spoofer (Stateless)
desc: "任何售卖本项目/模块的都是骗子，请立即联系退款。iOS Location Spoofer 无状态版 (Stash)"
homepage: ${origin}

http:
  mitm:
    - "gs-loc.apple.com"
    - "gs-loc-cn.apple.com"
  script:
    - match: ^https?:\/\/gs-loc(-cn)?\.apple\.com\/clls\/wloc
      name: ios-location-spoofer
      type: response
      require-body: true
      binary-mode: true
      max-size: 0
      timeout: 30
      argument: mode=response&debug=false
    - match: ^https?:\/\/gs-loc(-cn)?\.apple\.com\/ils-settings\/
      name: ios-location-settings
      type: request
      require-body: false
      timeout: 10

script-providers:
  ios-location-spoofer:
    url: ${origin}/location-spoofer.js
    interval: 86400
  ios-location-settings:
    url: ${origin}/location-settings.js
    interval: 86400`;
}
function lnplugin(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=任何售卖本项目/模块的都是骗子，请立即联系退款。无状态版，配合选点页使用。Loon 插件。
#!homepage=${origin}

[Script]
http-response ^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ script-path=${origin}/location-spoofer.js, requires-body=true, binary-body-mode=true, max-size=1048576, timeout=12, tag=iOS Location Spoofer, argument=mode=response&debug=false
http-request ^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ script-path=${origin}/location-settings.js, requires-body=false, timeout=10, tag=iLS Settings

[MITM]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
// Quantumult X has NO module/plugin system — it uses a "rewrite" reference. QX also does
// not auto-merge MITM hostnames the way Surge modules do, so the user must add them manually.
function qxsnippet(origin) {
  return String.raw`#!name=iOS Location Spoofer (Stateless)
#!desc=任何售卖本项目/模块的都是骗子，请立即联系退款。无状态版。Quantumult X 用「重写(rewrite)引用」(非模块/插件)。MITM 主机名需手动加进 QX 设置 → MITM。
#!homepage=${origin}

[rewrite_local]
^https?:\/\/(?:gs-loc(?:-cn)?\.apple\.com|bluedot\.is\.autonavi\.com(?:\.gds\.alibabadns\.com)?)\/clls\/wloc(?:\?.*)?$ url script-response-body ${origin}/location-spoofer-qx.js
^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/ils-settings\/ url script-echo-response ${origin}/location-settings.js

[mitm]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com, bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com`;
}
const TXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" };
app.get("/ios-location-spoofer.sgmodule", (c) => c.body(sgmodule(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.stoverride", (c) => c.body(stoverride(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.lnplugin", (c) => c.body(lnplugin(new URL(c.req.url).origin), 200, TXT));
app.get("/ios-location-spoofer.snippet", (c) => c.body(qxsnippet(new URL(c.req.url).origin), 200, TXT));

// Map link parsing: called by the iOS Shortcut.
// GET /api/parse?u=<link>&format=json&cs=<gcj|none>
//   Returns {lat, lon, name}; Amap / Apple Maps (both GCJ-02 in mainland China) are auto-converted to WGS84; coordinates outside China are skipped automatically (out_of_china). cs=none forces no conversion.
//   Without format=json it returns a plain-text "lat=..&lon=.." fragment.
app.get("/api/parse", async (c) => {
  const raw = c.req.query("u") || "";
  const cs = (c.req.query("cs") || "").toLowerCase();
  const fmt = (c.req.query("format") || "").toLowerCase();
  try {
    let { lat, lon, name, src } = await parseCoords(raw);
    // Normalize every source to WGS-84 at the entrance (hard requirement).
    // Automatic path uses toWgs84(src): Baidu => BD-09; Amap/Apple/Google => GCJ-02,
    // EXCEPT Apple/Google in HK/Macau/Taiwan which are already WGS-84 (Yu9191 v1.1).
    // Explicit cs= overrides still win. All guards no-op outside China.
    if (cs === "none") {
      // leave coordinates untouched
    } else if (cs === "bd09" || cs === "baidu") {
      ({ lat, lon } = toWgs84(lat, lon, "baidu"));
    } else if (cs === "gcj") {
      ({ lat, lon } = gcj02ToWgs84(lat, lon));
    } else {
      ({ lat, lon } = toWgs84(lat, lon, src));
    }
    lat = round6(lat);
    lon = round6(lon);
    name = name || "";
    c.header("Access-Control-Allow-Origin", "*");
    if (fmt === "json") return c.json({ lat, lon, name });
    return c.text(`lat=${lat}&lon=${lon}`);
  } catch (e) {
    c.header("Access-Control-Allow-Origin", "*");
    return c.json({ error: String(e && e.message ? e.message : e) }, 422);
  }
});

/* ---- Telegram bot webhook: a user sends /link (or /start) → the bot replies with the homepage link.
   One-time setup:
     1) @BotFather → 你的 bot (CyberHandymanMSG_bot) → 拿 API token
     2) 终端:  wrangler secret put TG_BOT_TOKEN            (粘贴 token)
     3) (可选) wrangler secret put TG_WEBHOOK_SECRET       (任意随机串，防伪造)
     4) 注册回调:  curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<origin>/tg&secret_token=<SECRET>"
     5) @BotFather → /setprivacy → 选该 bot → Disable      (这样它才能读到群里的 /link)
   Token 只存在 Cloudflare Secret 里，不写进代码。未配置时本路由静默返回 ok，不影响其它功能。 */
app.post("/tg", async (c) => {
  const secret = c.env && c.env.TG_WEBHOOK_SECRET;
  if (secret && c.req.header("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return c.text("forbidden", 403);
  }
  const token = c.env && c.env.TG_BOT_TOKEN;
  let update = null;
  try { update = await c.req.json(); } catch (e) {}
  const msg = update && (update.message || update.channel_post);
  const text = (msg && msg.text) || "";
  const chatId = msg && msg.chat && msg.chat.id;
  // Match /link, /links, /start — tolerate the /link@BotName form Telegram uses in groups.
  const cmd = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (token && chatId && (cmd === "/link" || cmd === "/links" || cmd === "/start")) {
    const origin = new URL(c.req.url).origin;
    const reply =
      "📍 iOS 虚拟定位 · 选点主页\n" + origin + "/\n\n" +
      "▶️ 视频教程：https://youtu.be/EspuRlKWUxc\n\n" +
      "⚠️ 免费开源，禁止售卖。若你是付款进来的，请立即联系退款——任何售卖者都是骗子。";
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply, disable_web_page_preview: false }),
    });
  }
  return c.text("ok", 200);
});

app.onError((e, c) => {
  console.error(`${e}`);
  return c.text(`${e}`, 500);
});

/* ---- Geo-restriction: block mainland China (CN); allow everywhere else ---- */
const BLOCK_HTML = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available in your region</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#f2f2f7;font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:28px}div{max-width:520px}h1{font-size:20px;margin-bottom:14px}p{color:#9a9aa8;font-size:14px;line-height:1.8}</style></head><body><div><h1>本服务在你所在地区不可用</h1><p>This service is not available in your region.<br><br>本项目免费开源、禁止售卖；仅面向中国大陆以外地区提供访问。<br>This free & open-source project is not for sale, and is served only outside mainland China.</p></div></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const country = request && request.cf && request.cf.country;
    let pathname = "/";
    try { pathname = new URL(request.url).pathname; } catch (e) {}
    // Telegram's webhook POST is a server-to-server call (non-CN anyway) — never geo-block /tg.
    if (country === "CN" && pathname !== "/tg") {
      return new Response(BLOCK_HTML, { status: 403, headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });
    }
    // Lightweight access log — stream it live with `wrangler tail` to spot resale / abuse.
    // (No IP logged; edge-cached static fetches won't appear here, but page loads will.)
    try {
      console.log("REQ " + JSON.stringify({
        country: country || "?",
        path: pathname,
        ref: request.headers.get("referer") || "",
        ua: (request.headers.get("user-agent") || "").slice(0, 90),
      }));
    } catch (e) {}
    return app.fetch(request, env, ctx);
  },
};