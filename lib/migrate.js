/**
 * 旧数据迁移：给历史选题补稳定 id，并把「已有平台字段」的旧选题
 * 迁成一个平台版本（不复制正文，只建版本壳；脚本还留在原选题笔记里）。
 *
 * 这是可重复执行的：已有 id 不覆盖，已有平台版本不重建。
 */

const STATUS_MAP = {
  选题: '在写',
  创作中: '在写',
  待审: '待发',
  已排期: '待发',
  已发: '已发',
  数据回流: '待回填',
  已回填: '待回填',
  已归档: '已归档',
}

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

export function createMigrator({ vault, topics, domain }) {
  async function scan() {
    const all = await topics.list({ limit: 1000 })
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
      const platform = clean(master.front?.platform, 100)
      if (platform === '') continue
      if ((byMaster.get(master.id) ?? []).some((variant) => clean(variant.front?.platform, 100) === platform)) continue
      pending.push({
        masterId: master.id,
        title: master.title,
        path: master.path,
        platform,
        account: '',
        status: STATUS_MAP[clean(master.front?.status, 20)] ?? '在写',
      })
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
    for (const path of previewData.missingId) {
      const before = await topics.read(path)
      await topics.update(path, { front: { ...before.front }, expectedSha1: before.sha1 })
      assignedIds += 1
    }
    // 补 id 后 fallback id 会变成真实 id，重新扫一遍再建版本，避免拿旧 id 去查主选题。
    const fresh = await scan()
    const created = []
    for (const item of fresh.pending) {
      const variant = await domain.createVariant({
        masterId: item.masterId,
        platform: item.platform,
        account: item.account,
        status: item.status,
        riskLevel: '低',
      })
      created.push({ masterId: item.masterId, path: variant.path })
    }
    vault.invalidate()
    return { ...(await preview()), dryRun: false, assignedIds, createdCount: created.length, created }
  }

  return { preview, apply }
}

export { STATUS_MAP }
