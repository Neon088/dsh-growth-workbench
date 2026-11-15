/**
 * 版本检查 —— 只读，不碰任何文件。
 *
 * 设置页里的「检查更新」只做三件事：读本地版本（index.js 的 PKG_VERSION，
 * 真源是 package.json）、问 GitHub 要最新 Release、把两个版本比一下。
 * 不下载、不解压、不覆盖，所以 git clone、市场装的副本、junction 到源码目录
 * 这三种安装方式下都能安全点击 —— 更新的动作留给用户自己。
 *
 * 比版本不能只比字符串：0.10.0 > 0.2.0 按 semver 成立、按字典序不成立；
 * 预发布版 0.2.1-rc.1 要排在 0.2.1 之前。这里实现的就是 semver 的那部分规则。
 */

export const REPO = 'Neon088/dsh-growth-workbench'
export const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases'
export const API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest'

const DIGITS = /^[0-9]+$/
const NOTES_LIMIT = 600

/**
 * "v0.2.1-rc.1" → { numbers: [0, 2, 1], pre: ['rc', '1'] }
 * 看不懂就返回 null（调用方当成「不知道谁新」处理，不去猜）。
 */
export function parseVersion(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const bare = raw.replace(/^v/i, '')
  const dashAt = bare.indexOf('-')
  const core = dashAt === -1 ? bare : bare.slice(0, dashAt)
  const pre = dashAt === -1 ? '' : bare.slice(dashAt + 1)
  const pieces = core.split('.')
  // 只认 major[.minor[.patch]]；带 build 元数据（+abc）或四段的都不猜。
  if (pieces.length === 0 || pieces.length > 3 || core.includes('+')) return null
  const numbers = []
  for (const piece of pieces) {
    if (!DIGITS.test(piece)) return null
    numbers.push(Number(piece))
  }
  while (numbers.length < 3) numbers.push(0)
  return { numbers, pre: pre === '' ? [] : pre.split('.') }
}

/** 预发布标识符比较：纯数字按数值、数字比字母小、其余按字典序。 */
function compareIdentifiers(left, right) {
  const leftNumeric = DIGITS.test(left)
  const rightNumeric = DIGITS.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** -1 / 0 / 1；任一侧看不懂就返回 0（不猜）。 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (let at = 0; at < 3; at += 1) {
    if (a.numbers[at] !== b.numbers[at]) return a.numbers[at] < b.numbers[at] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const shared = Math.min(a.pre.length, b.pre.length)
  for (let at = 0; at < shared; at += 1) {
    const step = compareIdentifiers(a.pre[at], b.pre[at])
    if (step !== 0) return step
  }
  if (a.pre.length === b.pre.length) return 0
  return a.pre.length < b.pre.length ? -1 : 1
}

export function isNewer(latest, current) {
  return compareVersions(latest, current) > 0
}

/** Release 正文压成几行：够看出改了什么，又不至于把设置页撑爆。 */
export function trimNotes(body) {
  const text = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text === '') return ''
  if (text.length <= NOTES_LIMIT) return text
  return text.slice(0, NOTES_LIMIT).replace(/\s+\S*$/, '') + '…'
}

/**
 * 把一个 Release 对象翻成界面要的那几个字段。
 * release 为 null 表示没拿到（网络、限流、404 之类），此时 ok=false、error 有话说。
 */
export function interpretRelease({ current, release, checkedAt }) {
  const currentVersion = String(current ?? '').trim()
  const at = String(checkedAt ?? new Date().toISOString())
  const base = {
    ok: false,
    current: currentVersion,
    latest: '',
    behind: false,
    url: RELEASES_PAGE,
    publishedAt: '',
    notes: '',
    prerelease: false,
    checkedAt: at,
    error: '',
  }
  if (release === null || typeof release !== 'object') {
    return { ...base, error: '没有拿到 Release 信息' }
  }
  const tag = String(release.tag_name ?? '').trim()
  const latest = tag.replace(/^v/i, '')
  if (parseVersion(latest) === null) {
    return { ...base, error: 'Release 的版本号看不懂：' + (tag === '' ? '(空)' : tag) }
  }
  return {
    ...base,
    ok: true,
    latest,
    behind: isNewer(latest, currentVersion),
    url: typeof release.html_url === 'string' && release.html_url !== '' ? release.html_url : RELEASES_PAGE,
    publishedAt: String(release.published_at ?? ''),
    notes: trimNotes(release.body),
    prerelease: release.prerelease === true,
  }
}

/**
 * 问 GitHub 要 latest Release。网络/限流/404 都抛出来，交给调用方翻成界面文案。
 * fetch 可注入，测试不用连网；超时用 AbortSignal.timeout，避免设置页一直转圈。
 */
export async function fetchLatestRelease(options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('这个运行时没有 fetch')
  const timeoutMs = Number(options.timeoutMs ?? 9000)
  const init = {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-growth-workbench' },
    cache: 'no-store',
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs)
  }
  const response = await doFetch(API_LATEST, init)
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    const status = Number(response?.status ?? 0)
    const message = status === 404
      ? '仓库还没有发布 Release'
      : status === 403 || status === 429
        ? 'GitHub 限流了，过一会儿再试'
        : 'GitHub 返回 HTTP ' + (status === 0 ? '未知' : String(status))
    const error = new Error(message)
    error.status = status
    throw error
  }
  const payload = await response.json()
  if (payload === null || typeof payload !== 'object') throw new Error('GitHub 返回的不是 JSON')
  return payload
}