/**
 * 卡片分包要用到的那份 client.js 作用域。
 *
 * 卡片代码以前和 Panel / Markdown 渲染器住在同一个函数里，直接闭包拿 React、h、
 * 一堆公共组件和 API helper。拆出去之后没有闭包可用了，所以这里把她们集中收一份，
 * 由 client.js 塞进 CARD_SHARED 再交给每个分包（见下面的契约检查）。
 *
 * 为什么要有 CONTRACT：分包是 "shared.xxx" 动态取的，某个名字漏了不会在打包时报错，
 * 只会在用户点开那张卡时炸一个 "xxx is not a function"。这里列成表，开发时一眼能数
 * 齐，也方便以后写测试比对。
 *
 * 注意：这份登记表的目的是让「拆包」零行为变化——卡片逻辑一个字都没改，
 * 拿到的还是原来那些东西，只是加载时机从「进面板」变成「点开这张卡」。
 */

/** 每个卡片分包都可以从 shared 里拿这些公共设施。 */
export const CARD_SHARED_CONTRACT = Object.freeze([
  // ── React 与取数 ──
  'React', 'h', 'call', 'get', 'post', 'put', 'del', 't', 'NL',
  // ── 推给对话 ──
  'PUSH_PROMPTS', 'pushToAgent', 'pushToAgentFromPath', 'pushListToAgent', 'summarizeRecords', 'confirmUnsavedIfNeeded',
  // ── 打开 / 删除 / 日志 ──
  'openInObsidian', 'openObsidian', 'deleteNote', 'noteLog',
  // ── 基础 UI ──
  'Pill', 'ErrorBar', 'Empty', 'ConflictDialog', 'Field', 'OpenObsidian', 'OpenActions', 'RowDelete',
  'Sect', 'Fold', 'RankRow', 'formatCount', 'Breadcrumb', 'ListFilter', 'ComboField',
  // ── 数据 hook ──
  'useAsync', 'useRecordFilter', 'useSqueeze', 'useExternalSync', 'ExternalUpdateBar',
  // ── 批注 / 正文编辑器 ──
  'SelectionToolbar', 'applyAnnotation', 'removeAnnotation', 'annotationsIn', 'selectionIn', 'selectionInEditor',
  'jumpToPreview', 'readAnnotWidth', 'saveAnnotWidth', 'ModeButtons', 'AnnotSplitter', 'AnnotationPanel',
  'LiveMarkdown', 'LiveBlock', 'markIn', 'mdBlocks', 'renderBlock', 'inlineNodes', 'stripAnnotationTails', 'blockToMd', 'spliceBlock',
  // ── 详情页与 SOP 树 ──
  'NoteDetail', 'TreeDir', 'renderTree', 'countAll', 'buildHitMap', 'pruneTree', 'highlightNodes',
  // ── 日历小工具 ──
  'shiftMonth', 'monthTitle', 'monthGrid', 'todayISO', 'tailOf',
])

/** 卡片分包里会直接用到的浏览器全局（分包没有 client.js 的闭包，得显式传出去）。 */
export const CARD_GLOBALS_CONTRACT = Object.freeze([
  'window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'URL', 'Blob', 'console', 'navigator',
  'Date', 'JSON', 'Object', 'Array', 'String', 'Number', 'Promise', 'Map', 'Set', 'RegExp', 'Math', 'Error', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'confirm', 'alert', 'Uint8Array', 'TextDecoder',
])

/**
 * 从一份现成的名字表里挑出契约要求的部分。
 *
 * 缺名字直接抛：宁可开发时一眼炸，也不要等用户点开某张卡才炸。
 * （以前的写法是让面板在渲染期抛 ReferenceError，用户看到的是整块面板黑掉。）
 */
export function pickCardShared(scope) {
  const source = scope ?? {}
  const missing = CARD_SHARED_CONTRACT.filter((name) => source[name] === undefined)
  if (missing.length > 0) {
    throw new Error('卡片分包缺公共设施：' + missing.join(', '))
  }
  const picked = {}
  for (const name of CARD_SHARED_CONTRACT) picked[name] = source[name]
  return picked
}

/**
 * 浏览器里没有的 DOM 全局先跳过，别在模块加载期就把 client.js 弄崩；
 * 用得着的时候分包自己会报错，而且有 CardBoundary 兜着。
 */
export function pickCardGlobals(host) {
  const windowRef = host ?? {}
  const globals = {}
  for (const name of CARD_GLOBALS_CONTRACT) {
    const value = windowRef[name]
    if (value !== undefined) globals[name] = value
  }
  return globals
}
