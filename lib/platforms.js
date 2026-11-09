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

/** 规范平台名。顺序就是下拉里的顺序。 */
export const PLATFORMS = [
  '小红书', '抖音', '快手', '视频号', 'B站', '知乎', '公众号', '微博',
  '头条', '百家号', '淘宝', '京东', '拼多多', '闲鱼',
  'TikTok', 'YouTube', 'Instagram', 'X', 'Facebook',
]

/**
 * 别名 → 规范名。键一律小写、去掉空格和常见连接符后再比。
 * 只放真正同义的说法；「视频号」和「公众号」是两个东西，别合并。
 */
const ALIASES = new Map(Object.entries({
  // 小红书
  '小红书': '小红书', 'xhs': '小红书', 'xiaohongshu': '小红书', 'rednote': '小红书', 'red': '小红书',
  // 抖音
  '抖音': '抖音', 'douyin': '抖音', 'tiktok中国': '抖音', '抖音号': '抖音',
  // 快手
  '快手': '快手', 'kuaishou': '快手',
  // 视频号
  '视频号': '视频号', '微信视频号': '视频号', 'channels': '视频号', 'wechat channels': '视频号',
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
}))

/** 比较用的形态：小写、去空格、去 _ - · / 。「B 站」「b-站」会落到同一个键上。 */
function keyOf(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[\s_\-·/、]+/g, '')
}

/**
 * 把任意写法收敛成规范名。认得出来返回规范名，认不出来返回原值（trim 过）。
 * 空值返回空串 —— 调用方要自己决定空串怎么显示。
 */
export function normalizePlatform(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  const hit = ALIASES.get(keyOf(text))
  return hit === undefined ? text : hit
}

/**
 * 给筛选下拉用的候选：规范名 + 用户自己的自定义平台，规范名排前面。
 * 传进来的通常是扫全表得到的原始值。
 */
export function platformOptions(rawList) {
  const custom = new Set()
  for (const raw of rawList ?? []) {
    const name = normalizePlatform(raw)
    if (name !== '' && !PLATFORMS.includes(name)) custom.add(name)
  }
  return [...PLATFORMS, ...[...custom].sort((a, b) => a.localeCompare(b, 'zh'))]
}

/** 两个平台名是不是同一个（B站 / bilibili 算一个）。 */
export function samePlatform(a, b) {
  return normalizePlatform(a) === normalizePlatform(b)
}
