'use client';

/**
 * EastMoney push2 (行业板块) JSONP + 懒加载映射 + 聚合
 * - 行业板块列表：fs=m:90+t:2
 * - 板块成分股：fs=b:BKxxxx
 *
 * 说明：
 * 1) 为了兼容 GitHub Pages/静态站，全部使用 JSONP(script 注入)方式请求
 * 2) 「股票->行业板块」映射采用“按需构建 + 停止条件 + 缓存”策略，避免全量扫板块造成卡顿
 */

const LS_KEY = 'industryPlateCache_v1';
const LS_TTL_MS = 12 * 60 * 60 * 1000; // 12小时缓存（可改 6~24 小时）
const QUOTE_TTL_MS = 60 * 1000; // 行业板块涨跌幅缓存 60s

const inflight = new Map(); // url -> Promise
let quoteCache = { ts: 0, data: null };

/** ---------- JSONP 工具 ---------- **/
function jsonp(url, cbParam = 'cb', timeoutMs = 8000) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('无浏览器环境'));
  }

  // in-flight 去重：同一URL同一时间只发一次
  if (inflight.has(url)) return inflight.get(url);

  const p = new Promise((resolve, reject) => {
    const cbName = `__jsonp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const fullUrl = url.includes(`${cbParam}=`) ? url : `${url}&${cbParam}=${cbName}`;

    let timer = null;
    const cleanup = (script) => {
      if (timer) clearTimeout(timer);
      try { delete window[cbName]; } catch {}
      if (script && document.body.contains(script)) document.body.removeChild(script);
    };

    window[cbName] = (data) => {
      cleanup(script);
      resolve(data);
    };

    const script = document.createElement('script');
    script.src = fullUrl;
    script.async = true;

    script.onerror = () => {
      cleanup(script);
      reject(new Error('JSONP加载失败'));
    };

    timer = setTimeout(() => {
      cleanup(script);
      reject(new Error('JSONP超时'));
    }, timeoutMs);

    document.body.appendChild(script);
  });

  inflight.set(url, p);
  p.finally(() => inflight.delete(url));
  return p;
}


// 尝试兼容不同接口的 JSONP 参数命名：优先 callback=，失败再退回 cb=
async function jsonpSmart(url, timeoutMs = 8000) {
  try {
    return await jsonp(url, 'callback', timeoutMs);
  } catch (e1) {
    return await jsonp(url, 'cb', timeoutMs);
  }
}


/** ---------- localStorage 缓存 ---------- **/
function loadCache() {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.updatedAt || !obj.stockToPlates) return null;
    if (Date.now() - obj.updatedAt > LS_TTL_MS) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveCache(stockToPlates) {
  try {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        stockToPlates
      })
    );
  } catch {}
}

/** ---------- EastMoney push2 API ---------- **/

/**
 * 拉行业板块实时行情（返回 code/name/pct）
 */
export async function fetchIndustryPlateQuotes() {
  const now = Date.now();
  if (quoteCache.data && now - quoteCache.ts < QUOTE_TTL_MS) {
    return quoteCache.data;
  }

  // fields:
  // f12: 板块代码(BKxxxx)
  // f14: 板块名称
  // f3 : 涨跌幅(%)
  const base =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=2000&po=1&np=1&fltt=2&invt=2' +
    '&fid=f3&fs=m:90+t:2&fields=f12,f14,f3';

  const data = await jsonpSmart(base, 10000);
  const diff = data?.data?.diff || [];
  const list = diff
    .map((d) => ({
      code: String(d.f12 || ''),
      name: String(d.f14 || ''),
      pct: typeof d.f3 === 'number' ? d.f3 : Number(d.f3)
    }))
    .filter((x) => x.code && x.name);

  quoteCache = { ts: now, data: list };
  return list;
}

/**
 * 拉板块成分股列表（仅需要股票代码 f12）
 * 支持分页 pn/pz
 */
async function fetchPlateStocks(bkCode, pn = 1, pz = 200) {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2` +
    `&fs=b:${encodeURIComponent(bkCode)}&fields=f12`;

  const data = await jsonpSmart(url, 12000);
  const diff = data?.data?.diff || [];
  const codes = diff
    .map((d) => String(d.f12 || '').trim())
    .filter((c) => /^\d{6}$/.test(c)); // A股 6位
  const hasMore = diff.length === pz;
  return { codes, hasMore };
}

/**
 * 确保 stockCodes（6位）都有「股票->行业板块」映射（按需构建）
 * 返回 stockToPlates: { [stockCode]: [plateName...] }
 *
 * 关键优化：
 * - 只对缺失的股票构建
 * - 遍历行业板块时，找到所有缺失股票的匹配就立即停止
 * - 限制最大扫描板块数量，避免极端情况卡死
 */
export async function ensureStockToIndustryPlateMap(stockCodes, options = {}) {
  const {
    maxPlatesToScan = 200, // 最多扫描多少个行业板块（够用了）
    concurrency = 3,       // 并发拉板块成分股
    pz = 200               // 单页数量
  } = options;

  const targetStocks = Array.from(
    new Set((stockCodes || []).map(String).filter((c) => /^\d{6}$/.test(c)))
  );
  if (!targetStocks.length) return {};

  const cached = loadCache();
  let stockToPlates = cached?.stockToPlates && typeof cached.stockToPlates === 'object'
    ? { ...cached.stockToPlates }
    : {};

  const missing = new Set(targetStocks.filter((c) => !stockToPlates[c] || !stockToPlates[c]?.length));
  if (!missing.size) return stockToPlates;

  const plates = await fetchIndustryPlateQuotes(); // 这里拿到行业板块 code+name
  const plateList = plates.slice(0, maxPlatesToScan);

  // 简单并发队列
  let idx = 0;
  async function worker() {
    while (idx < plateList.length && missing.size > 0) {
      const i = idx++;
      const plate = plateList[i];
      const bkCode = plate.code;
      const plateName = plate.name;

      // 分页拉成分股，遇到匹配就写入
      let pn = 1;
      let guardPages = 0;
      let keepGoing = true;
      while (keepGoing && missing.size > 0) {
        guardPages++;
        if (guardPages > 10) break; // 每个板块最多翻 10 页，防止异常
        const { codes, hasMore } = await fetchPlateStocks(bkCode, pn, pz);
        pn++;

        // 和 missing 交集
        for (const s of codes) {
          if (missing.has(s)) {
            if (!stockToPlates[s]) stockToPlates[s] = [];
            if (!stockToPlates[s].includes(plateName)) {
              stockToPlates[s].push(plateName);
            }
            // 行业板块一般一个股票只需一个主行业即可：命中后就标记完成
            missing.delete(s);
          }
        }

        // 如果这一页没更多了就停
        if (!hasMore) keepGoing = false;

        // 如果没有任何 missing 了就全局停（worker会退出）
        if (missing.size === 0) break;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.allSettled(workers);

  // 写回缓存（即使没完全命中，也缓存已有结果）
  saveCache(stockToPlates);
  return stockToPlates;
}

/**
 * 从基金 holdings 聚合关联行业板块 TopN，并附带实时涨跌幅
 *
 * holdings: [{code, name, weight, change}, ...]
 * stockToPlates: { [stockCode]: [plateName...] }
 * plateQuotes: [{code,name,pct}, ...]  (行业板块涨幅)
 */
export function aggregateIndustryPlatesForFund(holdings, stockToPlates, plateQuotes, topN = 3) {
  const platePctByName = new Map();
  (plateQuotes || []).forEach((p) => {
    // 用 name 做 join（更稳定：映射里存的是name）
    if (p?.name) platePctByName.set(p.name, p.pct);
  });

  const counter = new Map(); // name -> count
  const stocks = (holdings || [])
    .map((h) => String(h?.code || '').trim())
    .filter((c) => /^\d{6}$/.test(c))
    .slice(0, 10);

  for (const s of stocks) {
    const plates = stockToPlates?.[s] || [];
    if (!plates.length) continue;
    // 行业板块一般只取第一个主行业
    const name = plates[0];
    counter.set(name, (counter.get(name) || 0) + 1);
  }

  const result = Array.from(counter.entries())
    .map(([name, count]) => ({
      code: name, // 这里用 name 作为 key（UI 渲染足够），不强依赖 BK code
      name,
      count,
      pct: platePctByName.has(name) ? platePctByName.get(name) : null
    }))
    .sort((a, b) => (b.count - a.count) || ((b.pct ?? -999) - (a.pct ?? -999)))
    .slice(0, topN);

  return result;
}
