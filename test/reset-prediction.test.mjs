import test from "node:test";
import assert from "node:assert/strict";
import { parseResetPrediction } from "../src/reset-prediction.mjs";

test("reports no plan when the tracker has no official reset window", () => {
  const result = parseResetPrediction(
    "<main>上次全局重置 19小时前 9月12日 UTC 08:09 当前还没有宣布任何官方重置窗口。</main>",
    1,
  );
  assert.equal(result.status, "none");
  assert.equal(result.lastReset, "9月12日 UTC 08:09");
  assert.equal(result.nextReset, "暂无计划");
  assert.equal(result.label, "暂无计划");
  assert.equal(result.checkedAt, 1);
});

test("extracts a newly announced reset window", () => {
  const result = parseResetPrediction(
    "<main>上次重置 9月10日 UTC 01:20 重置预计于今天 PST 下午 6 点左右生效。</main>",
    2,
  );
  assert.equal(result.status, "scheduled");
  assert.equal(result.lastReset, "9月10日 UTC 01:20");
  assert.equal(result.nextReset, "今天 PST 下午 6 点左右");
  assert.equal(result.label, "今天 PST 下午 6 点左右");
});
