// 平台归一。
//
// 问题：平台名字散在四个地方各填各的 —— 选题 frontmatter、日历表的一列、
// 活动表的一列、筛选下拉的候选（靠扫全表去重）。同一个平台写成「B站」「bilibili」
// 「哔哩哔哩」就是三条互不相认的记录，回流会记到两条上、榜单会并档。
//
// 做法：只做「读时归一」，不碰磁盘。
//   * 认得出来的别名收敛成规范名；
//   * 认不出来的原样保留 —— 用户新加了什么平台，我们不该擅自改写它。
//   * 绝不写迁移脚本：批量改磁盘会和 expectedSha1、和用户正在 Obsidian 里编辑的文件打架。
//
// 这个文件同时是浏览器的唯一事实源：client.js 是单模块（host loader 不解析相对
// import），所以它的平台表由 `npm run build:client` 从本文件内联过去，CI 用
// `npm run check:client` 比对两边。改这里之后记得跑一次生成。

/** 规范平台名。顺序就是下拉里的顺序。 */
const PLATFORMS = [
  '小红书', '抖音', '快手', '视频号', 'B站', '知乎', '公众号', '微博',
  '头条', '百家号', '淘宝', '京东', '拼多多', '闲鱼',
  'TikTok', 'YouTube', 'Instagram', 'X', 'Facebook',
]

/**
 * 别名 → 规范名。键一律小写、去掉空格和常见连接符后再比。
 * 只放真正同义的说法；「视频号」和「公众号」是两个东西，别合并。
 */
const PLATFORM_ALIASES = {
  // 小红书
  '小红书': '小红书', 'xhs': '小红书', 'xiaohongshu': '小红书', 'rednote': '小红书', 'red': '小红书',
  // 抖音
  '抖音': '抖音', 'douyin': '抖音', 'tiktok中国': '抖音', '抖音号': '抖音',
  // 快手
  '快手': '快手', 'kuaishou': '快手',
  // 视频号
  '视频号': '视频号', '微信视频号': '视频号', 'channels': '视频号', 'wechatchannels': '视频号',
  // B站
  'b站': 'B站', 'bilibili': 'B站', 'bili': 'B站', '哔哩哔哩': 'B站', '小破站': 'B站',
  // 知乎
  '知乎': '知乎', 'zhihu': '知乎',
  // 公众号
  '公众号': '公众号', '微信公众号': '公众号', 'wechat': '公众号', 'wechat official': '公众号', 'mp': '公众号',
  // 微博
  '微博': '微博', 'weibo': '微博',
  // 头条
  '头条': '头条', '今日头条': '头条', 'toutiao': '头条',
  // 百家号
  '百家号': '百家号', 'baijia': '百家号', 'baijiahao': '百家号',
  // 电商
  '淘宝': '淘宝', 'taobao': '淘宝', '天猫': '淘宝',
  '京东': '京东', 'jd': '京东', 'jingdong': '京东',
  '拼多多': '拼多多', 'pdd': '拼多多', 'pinduoduo': '拼多多',
  '闲鱼': '闲鱼', 'xianyu': '闲鱼',
  // 海外
  'tiktok': 'TikTok',
  'youtube': 'YouTube', 'yt': 'YouTube', '油管': 'YouTube',
  'instagram': 'Instagram', 'ig': 'Instagram', 'ins': 'Instagram',
  'x': 'X', 'twitter': 'X', '推特': 'X',
  'facebook': 'Facebook', 'fb': 'Facebook',
}

/** 比较用的形态：小写、去空格、去 _ - · / 、，。「B 站」「b-站」会落到同一个键上。 */
function keyOf(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[\s_\-·/、，]+/g, '')
}

/**
 * 把任意写法收敛成规范名。认得出来返回规范名，认不出来返回原值（trim 过）。
 * 空值返回空串 —— 调用方要自己决定空串怎么显示。
 */
function normalizePlatform(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  const key = keyOf(text)
  const hit = PLATFORM_ALIASES[key]
  if (hit !== undefined) return hit
  const direct = PLATFORMS.find((name) => keyOf(name) === key)
  return direct === undefined ? text : direct
}

/**
 * 给筛选下拉用的候选：规范名 + 用户自己的自定义平台，规范名排前面。
 * 传进来的通常是扫全表得到的原始值。
 */
function platformOptions(rawList) {
  const custom = new Set()
  for (const raw of rawList ?? []) {
    // 一格里可能塞着多个平台（同步发行）。逐个拆开再归一，
    // 否则「抖音 / 知乎 / 公众号」会整串变成一个自定义平台，污染整个下拉。
    for (const name of splitPlatforms(raw)) {
      if (name !== '' && !PLATFORMS.includes(name)) custom.add(name)
    }
  }
  return [...PLATFORMS, ...[...custom].sort((a, b) => a.localeCompare(b, 'zh'))]
}

/** 两个平台名是不是同一个（B站 / bilibili 算一个）。 */
function samePlatform(a, b) {
  return normalizePlatform(a) === normalizePlatform(b)
}

/**
 * 拆成平台集合：同一篇内容可以同步发行给多个平台，
 * 「平台」一格里就存着多个平台名（用 / 、 , ; ； 隔开）。
 *
 * 分隔符固定写在函数里（不抽成常量）：测试会把单个函数摘出来单独求值，
 * 引用外层常量的函数在那种环境里会 ReferenceError。
 *
 * 返回的是归一后的、去重后的、保持首次出现顺序的规范名列表。
 * 单值输入返回一个元素的数组；空输入返回空数组。
 */
function splitPlatforms(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  const out = []
  const seen = new Set()
  for (const part of text.split(/\s*[/、,;；，]\s*/)) {
    const name = normalizePlatform(part)
    if (name === '') continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 平台集合是不是只有一个（或零个）。 */
function isSinglePlatform(raw) {
  return splitPlatforms(raw).length <= 1
}

/** 拼回一格能存的字符串。固定用「 / 」连接，服务端和客户端拼出来的东西才长得一样。 */
function joinPlatforms(list) {
  return splitPlatforms(Array.isArray(list) ? list.join(' / ') : list).join(' / ')
}

/**
 * 判断一个平台格是不是「多平台格」（里面塞了不止一个平台）。
 * 写侧守卫用它拦下「一行一个平台版本」之外的非法形状。
 */
function isMultiPlatform(raw) {
  return splitPlatforms(raw).length > 1
}

export {
  PLATFORMS,
  PLATFORM_ALIASES,
  keyOf,
  normalizePlatform,
  platformOptions,
  samePlatform,
  splitPlatforms,
  isSinglePlatform,
  joinPlatforms,
  isMultiPlatform,
}