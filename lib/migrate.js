/**
 * 旧数据迁移：给历史选题补稳定 id，并把「已有平台字段」的旧选题
 * 迁成一个平台版本（不复制正文，只建版本壳；脚本还留在原选题笔记里）。
 *
 * 这是可重复执行的：已有 id 不覆盖，已有平台版本不重建。
 */

import { normalizePlatform, splitPlatforms } from './platforms.js'
import { VaultError } from './vault.js'

const STATUS_MAP = {
  选题: '在写',
  创作中: '在写',
  在写: '在写',
  待审: '待发',
  已排期: '待发',
  待发: '待发',
  // 历史选题上的状态不能证明某个平台版本真的发布过，也没有可信的
  // 实际发布时间。迁移只建草稿壳，发布事实留给人确认，避免凭一个旧标签
  // 伪造发布时间、观察周期和结案状态。
  已发: '在写',
  数据回流: '在写',
  已回填: '在写',
  待回填: '在写',
  已归档: '在写',
}

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

export function createMigrator({ vault, topics, domain }) {
  async function scan() {
    const all = typeof topics.all === 'function' ? await topics.all({ includeVariants: false }) : await topics.list({ limit: 1000 })
    // `Topics/测试/` 是仓库自带的种子/演示数据，迁移时不能把它们变成真实平台版本。
    const masters = all.filter((master) => !String(master.path ?? '').startsWith('Topics/测试/'))
    const variants = await domain.listVariants('')
    const byMaster = new Map()
    for (const variant of variants) {
      const key = String(variant.front?.masterId ?? '')
      if (key === '') continue
      if (!byMaster.has(key)) byMaster.set(key, [])
      byMaster.get(key).push(variant)
    }
    const missingId = masters.filter((master) => clean(master.front?.id, 40) === '')
    const pending = []
    for (const master of masters) {
      const platforms = splitPlatforms(clean(master.front?.platform, 100))
      for (const platform of platforms) {
        const exists = (byMaster.get(master.id) ?? []).some((variant) => normalizePlatform(clean(variant.front?.platform, 100)) === platform)
        if (exists) continue
        pending.push({
          masterId: master.id,
          title: master.title,
          path: master.path,
          platform,
          account: '',
          status: STATUS_MAP[clean(master.front?.status, 20)] ?? '在写',
          sourceStatus: clean(master.front?.status, 20),
          needsPublishConfirmation: ['已发', '数据回流', '已回填', '待回填', '已归档'].includes(clean(master.front?.status, 20)),
        })
      }
    }
    return { total: masters.length, skippedTest: all.length - masters.length, missingId: missingId.map((master) => master.path), pending }
  }

  async function preview() {
    const result = await scan()
    return {
      totalTopics: result.total,
      skippedTestCount: result.skippedTest,
      missingIdCount: result.missingId.length,
      missingId: result.missingId,
      createVariantCount: result.pending.length,
      createVariants: result.pending,
      dryRun: true,
    }
  }

  async function apply({ dryRun = false } = {}) {
    const previewData = await preview()
    if (dryRun) return previewData
    let assignedIds = 0
    const changedFiles = []
    const failed = []
    for (const path of previewData.missingId) {
      try {
        const before = await topics.read(path)
        await topics.update(path, { front: { id: before.id }, expectedSha1: before.sha1 })
        assignedIds += 1
        changedFiles.push(path)
      } catch (error) {
        failed.push({ path, operation: '补稳定 ID', error: error?.message ?? String(error) })
      }
    }
    // 补 id 后 fallback id 会变成真实 id，重新扫一遍再建版本，避免拿旧 id 去查主选题。
    const fresh = await scan()
    const created = []
    for (const item of fresh.pending) {
      try {
        const variant = await domain.createVariant({
          masterId: item.masterId,
          platform: item.platform,
          account: item.account,
          status: item.status,
          riskLevel: '低',
        })
        created.push({ masterId: item.masterId, path: variant.path, sourceStatus: item.sourceStatus, needsPublishConfirmation: item.needsPublishConfirmation })
        changedFiles.push(variant.path)
      } catch (error) {
        failed.push({ path: item.path, platform: item.platform, operation: '建立平台版本', error: error?.message ?? String(error) })
      }
    }
    vault.invalidate()
    const result = { ...(await preview()), dryRun: false, assignedIds, createdCount: created.length, created, changedFiles, failed }
    if (failed.length > 0) throw new VaultError('迁移只完成了一部分；成功项已保留，请按失败清单处理后重试', 'conflict', { partial: true, migration: result })
    return result
  }

  return { preview, apply }
}

export { STATUS_MAP }
