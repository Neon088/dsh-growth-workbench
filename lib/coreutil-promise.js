/**
 * 把一个还在飞的 Promise 当值读。
 *
 * 面板要把「卡片分包还没到」渲染成一次“暂时没有内容”，但 React 的 Suspense 是
 * 「抛 promise 让上面接住」——而工作台面板挂在宿主页面的那棵 React 树里（不是我们
 * 起的根），根上有没有 Suspense 不能猜。赌错了的代价很难看：整个面板被换成宿主的
 * 加载态，比「卡片晚半秒出现」糟得多。
 *
 * 所以不抛，改成记一笔：谁问谁拿。
 *   · 没结算 → undefined（调用方画空占位）
 *   · 已失败 → { failed: true, message }（调用方抛给 CardBoundary 显示）
 * 记录挂在 promise 上（WeakMap），同一个分包被反复询问也只注册一次回调。
 */
const RECORDS = new WeakMap()

function recordOf(promise) {
  const cached = RECORDS.get(promise)
  if (cached !== undefined) return cached
  const entry = { done: false, failed: false, value: undefined, message: '' }
  RECORDS.set(promise, entry)
  promise.then(
    (value) => {
      entry.done = true
      entry.value = value
    },
    (error) => {
      entry.done = true
      entry.failed = true
      entry.message = String((error !== null && error !== undefined && error.message !== undefined) ? error.message : error)
    },
  )
  return entry
}

/** 已结算就返回记录（含 failed），还在飞返回 undefined。 */
export function peekPromise(promise) {
  const entry = recordOf(promise)
  return entry.done === true ? entry : undefined
}
