const RESET_URL = "https://codex-reset.com/zh/";
const CACHE_MS = 10 * 60 * 1000;

let cached = null;

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function visibleText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function parseResetPrediction(html, checkedAt = Date.now()) {
  const text = visibleText(html);
  const lastResetMatch = text.match(
    /上次(?:全局)?重置(?:时间)?\s*(?:\d+\s*(?:分钟|小时|天)前\s*)?((?:\d{4}年)?\d{1,2}月\d{1,2}日(?:\s*UTC\s*\d{1,2}:\d{2})?)/i,
  );
  const lastReset = lastResetMatch?.[1]?.trim().replace(/\s+/g, " ") || "暂无记录";
  const noPlan = /暂无官方重置信号|当前还没有宣布任何官方重置窗口|没有计划，只有重置/.test(text);
  if (noPlan) {
    return {
      status: "none",
      lastReset,
      nextReset: "暂无计划",
      label: "暂无计划",
      detail: "网站当前没有公布明确的下一次全局重置时间",
      sourceUrl: RESET_URL,
      checkedAt,
    };
  }

  const signal = text.match(
    /(?:重置预计于|预计(?:将)?于|重置将于|预计在)([^。！？]{2,72}?)(?:生效|完成|重置|。|！|？)/,
  );
  if (signal) {
    const nextReset = signal[1].trim().replace(/\s+/g, " ").slice(0, 48);
    return {
      status: "scheduled",
      lastReset,
      nextReset,
      label: nextReset,
      detail: "来自 codex-reset.com 的当前公开重置窗口",
      sourceUrl: RESET_URL,
      checkedAt,
    };
  }

  return {
    status: "uncertain",
    lastReset,
    nextReset: "暂无预测",
    label: "暂无预测",
    detail: "网站有重置信号，但没有可确认的明确时间",
    sourceUrl: RESET_URL,
    checkedAt,
  };
}

export async function readResetPrediction({ force = false, timeoutMs = 10_000 } = {}) {
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;
  const response = await fetch(RESET_URL, {
    cache: "no-store",
    headers: {
      accept: "text/html",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": "SILO/0.2 reset-status reader",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`重置预测网站返回 ${response.status}`);
  cached = parseResetPrediction(await response.text());
  return cached;
}

export { RESET_URL };
