/**
 * 营位归并端到端逻辑测试（node + fake-indexeddb，不依赖浏览器）。
 * 运行：npx esbuild scripts/merge.test.ts --bundle --platform=node --format=esm | node
 *
 * 覆盖：
 *  1. 样例数据升级后字段完整（aliases / mergeLogs 补齐）；
 *  2. 候选探测能找到 CS-0007 / CS-0008 这对重复登记；
 *  3. 归并：因子多轮、否决、别名转入保留项；冲突默认取保留项；
 *  4. 旧编号反查（resolveSiteByCode）能定位保留项；
 *  5. 事务中途失败 → 两条营位原样恢复，且可重试成功；
 *  6. 恢复两条原样 → 再归并，冲突改取被吸收项后字段/方案关系符合预期。
 */

// localStorage / window / IndexedDB polyfill 由 esbuild --inject:scripts/_localStorage.ts 注入

import { db, seedIfEmpty } from '../src/utils/db'
import {
  buildMergePlan,
  findMergeCandidates,
  loadMergeBackup,
  mergeSites,
  nameSimilarity,
  resolveSiteByCode,
  restoreLastMerge
} from '../src/utils/merge'

let failures = 0
function assert(cond: unknown, message: string): void {
  if (cond) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}
async function main(): Promise<void> {
  await db.open()
  await seedIfEmpty()

  console.log('样例数据与升级')
  const sites = await db.sites.orderBy('id').toArray()
  assert(sites.length === 8, '样例营位共 8 条（含一对重复登记）')
  assert(sites.every((s) => Array.isArray(s.aliases) && Array.isArray(s.mergeLogs)), 'v4 字段 aliases / mergeLogs 齐全')

  console.log('候选探测')
  const candidates = findMergeCandidates(sites)
  const pair = candidates.find(
    (c) =>
      (c.a.code === 'CS-0007' && c.b.code === 'CS-0008') ||
      (c.a.code === 'CS-0008' && c.b.code === 'CS-0007')
  )
  assert(!!pair, 'CS-0007 / CS-0008 被判为重复登记候选')
  assert(pair ? pair.distance < 60 : false, `候选距离 < 60 m（实际 ${pair?.distance.toFixed(1)} m）`)
  assert(
    Math.abs(nameSimilarity('桦树湾平台', '桦树湾平整台地') - 0.4286) < 0.01,
    '名称相似度符合二元字组 Jaccard 预期'
  )

  const profiles = await db.profiles.toArray()
  const factors = await db.factors.toArray()
  const vetos = await db.vetos.toArray()

  console.log('预演归并（CS-0007 保留，CS-0008 吸收）')
  const s7 = (await db.sites.get(7))!
  const s8 = (await db.sites.get(8))!
  const plan = buildMergePlan(s7, s8, profiles, factors, vetos)
  assert(plan.absorbedFactors.length === 1, '被吸收项带 1 轮因子（二组复测）')
  assert(plan.absorbedVetos.length === 1, '被吸收项带 1 条山洪沟否决')
  assert(plan.conflicts.some((c) => c.key === 'defaultProfileId'), '默认评分方案不同属于冲突字段')
  assert(plan.conflicts.some((c) => c.key === 'elevation'), '海拔不同属于冲突字段')

  console.log('事务失败自动回滚 + 重试')
  const origBulkPut = db.factors.bulkPut.bind(db.factors)
  db.factors.bulkPut = (() => {
    throw new Error('mock disk error')
  }) as typeof db.factors.bulkPut
  let failed = false
  try {
    await mergeSites({
      retainedId: 7,
      absorbedId: 8,
      profiles,
      resolutions: {},
      factors,
      vetos
    })
  } catch (err) {
    failed = /归并失败/.test(err instanceof Error ? err.message : String(err))
  }
  db.factors.bulkPut = origBulkPut
  assert(failed, '归并中途出错时抛出「归并失败、已恢复原样」错误')
  const s7b = (await db.sites.get(7))!
  const s8b = await db.sites.get(8)
  assert(!!s7b && !!s8b, '回滚后两条营位都还在')
  assert((s7b.aliases ?? []).length === 0, '回滚后保留项没有写入别名')
  assert((await db.factors.where('siteId').equals(8).count()) === 1, '回滚后因子仍归属 CS-0008')
  assert((await db.vetos.where('siteId').equals(8).count()) === 1, '回滚后否决仍归属 CS-0008')
  assert(!!loadMergeBackup(), '失败现场留有快照，且可直接重试')

  console.log('正式归并（冲突默认全部取保留项）')
  const merged = await mergeSites({
    retainedId: 7,
    absorbedId: 8,
    profiles,
    resolutions: {},
    factors,
    vetos
  })
  assert(merged.code === 'CS-0007', '保留项编号仍为 CS-0007')
  assert((merged.aliases ?? []).includes('CS-0008'), 'CS-0008 成为保留项历史别名')
  assert(merged.mergeLogs.length === 1, '保留项有 1 条归并留痕')
  assert(
    merged.mergeLogs[0].conflicts.every((c) => c.source === 'retained'),
    '冲突字段全部标注来源为保留项，双方原值都在留痕里'
  )
  assert(merged.elevation === 418, '保留项海拔仍是自己的 418 m')
  assert(merged.defaultProfileId === 1, '保留项默认评分方案仍是方案 1')
  assert((await db.sites.get(8)) === undefined, '被吸收营位已删除')
  const mergedFactors = await db.factors.where('siteId').equals(7).toArray()
  assert(mergedFactors.length === 2, '保留项接管后共有 2 轮因子（多轮不丢）')
  const mergedVetos = await db.vetos.where('siteId').equals(7).toArray()
  assert(mergedVetos.length === 1, '保留项接管 1 条否决（山洪沟）')
  assert(mergedVetos[0].type === '山洪沟', '接管的否决类型正确')

  console.log('旧编号反查')
  const resolved = await resolveSiteByCode('CS-0008')
  assert(resolved?.id === 7, '用旧编号 CS-0008 反查到保留项 id=7')
  const direct = await resolveSiteByCode('CS-0007')
  assert(direct?.id === 7, '现行编号 CS-0007 也能正常查到')

  console.log('恢复两条原样并重新归并（冲突改取被吸收项）')
  const restored = await restoreLastMerge()
  assert(restored.absorbedId === 8, '恢复操作返回被吸收营位 id')
  const r7 = (await db.sites.get(7))!
  const r8 = (await db.sites.get(8))!
  assert(!!r7 && !!r8, '恢复后两条营位都在')
  assert((r7.aliases ?? []).length === 0 && r7.mergeLogs.length === 0, '保留项回到归并前状态')
  assert((await db.factors.where('siteId').equals(8).count()) === 1, '因子归属复原')
  assert((await db.vetos.where('siteId').equals(8).count()) === 1, '否决归属复原')

  const profiles2 = await db.profiles.toArray()
  const factors2 = await db.factors.toArray()
  const vetos2 = await db.vetos.toArray()
  const plan2 = buildMergePlan(r7, r8, profiles2, factors2, vetos2)
  const resolutions = Object.fromEntries(plan2.conflicts.map((c) => [c.key, 'absorbed'])) as Record<
    string,
    'absorbed'
  >
  const remerged = await mergeSites({
    retainedId: 7,
    absorbedId: 8,
    profiles: profiles2,
    resolutions,
    factors: factors2,
    vetos: vetos2
  })
  assert(remerged.name === '桦树湾平整台地', '重试归并：名称取被吸收项')
  assert(remerged.elevation === 415, '重试归并：海拔取被吸收项 415 m')
  assert(remerged.defaultProfileId === 2, '重试归并：默认评分方案关系接被吸收项（雨季方案）')
  assert(
    remerged.mergeLogs[0].conflicts.every((c) => c.source === 'absorbed'),
    '留痕中每个冲突来源都标注为被吸收项'
  )
  assert((await db.factors.where('siteId').equals(7).count()) === 2, '重试归并后因子仍为 2 轮')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  } else {
    console.log('\n全部断言通过 ✔')
  }
  await db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
