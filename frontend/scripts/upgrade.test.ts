/**
 * 旧数据升级测试：先按 v3 结构建库写入两条「无 aliases / mergeLogs」的营位，
 * 再用当前版本打开，验证 v4 upgrade 自动补齐字段且多值索引可用。
 *
 * 运行：npx esbuild scripts/upgrade.test.ts --bundle --platform=node --format=esm \
 *        --inject:scripts/_localStorage.ts | node
 */
import Dexie from 'dexie'
import { db, DB_NAME } from '../src/utils/db'

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
  // 1) 用旧版本号结构建库（只声明 v3 已有的表与索引）
  const legacy = new Dexie(DB_NAME)
  legacy.version(1).stores({
    sites: '++id, code, name, campName, surface, access',
    factors: '++id, assessedAt, assessor'
  })
  legacy.version(2).stores({
    sites: '++id, code, name, campName, surface, access, defaultProfileId',
    factors: '++id, siteId, assessedAt, assessor',
    profiles: '++id, name, season, active'
  })
  legacy.version(3).stores({
    sites: '++id, code, name, campName, surface, access, defaultProfileId, updatedAt',
    factors: '++id, siteId, assessedAt, assessor',
    profiles: '++id, name, season, active, updatedAt',
    vetos: '++id, siteId, type, judgedAt'
  })
  await legacy.open()
  await legacy.table('sites').bulkPut([
    {
      id: 1,
      code: 'CS-0001',
      name: '旧库营位甲',
      campName: '老营地',
      lng: 119.88,
      lat: 30.53,
      elevation: 400,
      slope: 3,
      aspect: '东南',
      surface: '草地',
      tentCapacity: 3,
      flatness: 80,
      access: '车行',
      defaultProfileId: null,
      note: '旧数据，没有 aliases 字段',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    },
    {
      id: 2,
      code: 'CS-0002',
      name: '旧库营位乙',
      campName: '老营地',
      lng: 119.89,
      lat: 30.54,
      elevation: 420,
      slope: 5,
      aspect: '南',
      surface: '林地',
      tentCapacity: 2,
      flatness: 70,
      access: '步行',
      defaultProfileId: null,
      note: '',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    }
  ])
  await legacy.close()

  // 2) 用当前 db（v4）打开，触发升级
  await db.open()
  assert(db.verno === 4, `数据库版本升级到 v4（实际 verno=${db.verno}）`)

  const sites = await db.sites.orderBy('id').toArray()
  assert(sites.length === 2, '存量营位条数不变')
  assert(
    sites.every((s) => Array.isArray(s.aliases) && s.aliases.length === 0),
    '存量营位全部补齐 aliases 空数组'
  )
  assert(
    sites.every((s) => Array.isArray(s.mergeLogs) && s.mergeLogs.length === 0),
    '存量营位全部补齐 mergeLogs 空数组'
  )
  // 旧数据原本的字段不丢
  assert(sites[0].name === '旧库营位甲' && sites[0].elevation === 400, '存量营位业务字段保持原样')

  // 3) *aliases 多值索引可查询（后续导入旧编号反查依赖）
  // 先模拟归并写入别名，再走索引查
  await db.sites.update(1, { aliases: ['CS-0009'] })
  const hit = await db.sites.where('aliases').equals('CS-0009').first()
  assert(hit?.id === 1, '*aliases 多值索引可按旧编号命中保留项')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    process.exit(1)
  } else {
    console.log('\n升级测试全部断言通过 ✔')
  }
  await db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
