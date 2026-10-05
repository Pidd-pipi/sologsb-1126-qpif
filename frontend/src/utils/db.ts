/**
 * IndexedDB（Dexie）封装：库结构、版本号与升级迁移、首次运行的样例营地数据。
 *
 * 版本演进（与提示词一致）：
 *   v1 建 sites / factors 两张表
 *   v2 新增 profiles 表，并为 factors 补 siteId 索引
 *   v3 新增 vetos 表，并为存量营位回填默认权重方案
 *   v4 营位归并：sites 增加 aliases（历史别名编号，多值索引）与 mergeLogs（归并留痕）
 */
import Dexie, { type Table } from 'dexie'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { ScoreProfile } from '@/types/score'
import { DEFAULT_WEIGHTS } from '@/types/score'
import type { RiskVeto } from '@/types/veto'

export const DB_NAME = 'gbcampsite-db'
/** 当前数据结构版本号 */
export const DB_VERSION = 4

export class GbCampsiteDatabase extends Dexie {
  sites!: Table<Campsite, number>
  factors!: Table<FactorAssessment, number>
  profiles!: Table<ScoreProfile, number>
  vetos!: Table<RiskVeto, number>

  constructor() {
    super(DB_NAME)

    // v1：营位与因子评估
    this.version(1).stores({
      sites: '++id, code, name, campName, surface, access',
      factors: '++id, assessedAt, assessor'
    })

    // v2：新增权重方案表；factors 补 siteId 索引，让「按营位取因子」走索引
    this.version(2)
      .stores({
        sites: '++id, code, name, campName, surface, access, defaultProfileId',
        factors: '++id, siteId, assessedAt, assessor',
        profiles: '++id, name, season, active'
      })
      .upgrade(async (tx) => {
        // 为存量因子评估补齐 siteId 之外的缺省字段
        await tx
          .table('factors')
          .toCollection()
          .modify((f: Partial<FactorAssessment>) => {
            if (typeof f.siteId !== 'number') f.siteId = 0
            if (typeof f.shade !== 'number') f.shade = 30
            if (typeof f.distanceToCar !== 'number') f.distanceToCar = 200
            if (typeof f.distanceToTrail !== 'number') f.distanceToTrail = 150
          })
      })

    // v3：新增风险否决表；为存量营位回填默认方案 id 与新增字段缺省值
    this.version(3)
      .stores({
        sites: '++id, code, name, campName, surface, access, defaultProfileId, updatedAt',
        factors: '++id, siteId, assessedAt, assessor',
        profiles: '++id, name, season, active, updatedAt',
        vetos: '++id, siteId, type, judgedAt'
      })
      .upgrade(async (tx) => {
        const profiles = (await tx.table('profiles').toArray()) as ScoreProfile[]
        const fallback = profiles.find((p) => p.active) ?? profiles[0]
        const fallbackId = typeof fallback?.id === 'number' ? fallback.id : null
        await tx
          .table('sites')
          .toCollection()
          .modify((s: Partial<Campsite>) => {
            if (s.defaultProfileId === undefined) s.defaultProfileId = fallbackId
            if (typeof s.note !== 'string') s.note = ''
            if (typeof s.flatness !== 'number') s.flatness = 70
            if (typeof s.tentCapacity !== 'number') s.tentCapacity = 1
          })
      })

    // v4：营位归并。aliases 为多值索引（*），后续导入可凭旧编号反查保留项；
    // 同时为存量营位补齐 aliases / mergeLogs 两个字段，保证旧数据升级后字段完整。
    this.version(DB_VERSION)
      .stores({
        sites:
          '++id, code, name, campName, surface, access, defaultProfileId, updatedAt, *aliases',
        factors: '++id, siteId, assessedAt, assessor',
        profiles: '++id, name, season, active, updatedAt',
        vetos: '++id, siteId, type, judgedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table('sites')
          .toCollection()
          .modify((s: Partial<Campsite>) => {
            if (!Array.isArray(s.aliases)) s.aliases = []
            if (!Array.isArray(s.mergeLogs)) s.mergeLogs = []
          })
      })
  }
}

export const db = new GbCampsiteDatabase()

/** 写入前脱掉 Vue 响应式 Proxy，避免结构化克隆抛 DataCloneError。 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 打开数据库；首次运行写入样例数据。 */
export async function initDatabase(): Promise<void> {
  await db.open()
  await seedIfEmpty()
}

/* ------------------------------ 样例数据 ------------------------------ */

const SEED_TS = '2024-04-12T02:30:00.000Z'

function seedProfiles(): ScoreProfile[] {
  return [
    {
      id: 1,
      name: '均衡型方案',
      weights: { ...DEFAULT_WEIGHTS },
      normalize: 'minmax',
      thresholds: { gradeA: 78, gradeB: 58 },
      season: '四季通用',
      active: true,
      note: '默认方案，坡度、水源、落石三项权重略高，适用于大多数山谷营地。',
      createdAt: SEED_TS,
      updatedAt: SEED_TS
    },
    {
      id: 2,
      name: '雨季防风防山洪',
      weights: {
        slope: 12,
        flatness: 8,
        aspect: 4,
        waterDistance: 18,
        wind: 18,
        signal: 6,
        sun: 4,
        rockfall: 14,
        shade: 4,
        distanceToCar: 8,
        distanceToTrail: 4
      },
      normalize: 'threshold',
      thresholds: { gradeA: 82, gradeB: 62 },
      season: '夏季',
      active: false,
      note: '雨季强调风力遮蔽与水系距离，阈值分段避免极差归一被单个离群营位拉偏。',
      createdAt: SEED_TS,
      updatedAt: SEED_TS
    }
  ]
}

function seedSites(): Campsite[] {
  const base = {
    defaultProfileId: 1,
    aliases: [] as string[],
    mergeLogs: [] as Campsite['mergeLogs'],
    createdAt: SEED_TS,
    updatedAt: SEED_TS
  }
  return [
    {
      ...base,
      id: 1,
      code: 'CS-0001',
      name: '溪畔台地 A 区',
      campName: '云栖山谷营地',
      lng: 119.8842,
      lat: 30.5318,
      elevation: 412,
      slope: 2.4,
      aspect: '东南',
      surface: '草地',
      tentCapacity: 6,
      flatness: 92,
      access: '车行',
      note: '溪流东岸二级台地，进出道路硬化到营位边，适合家庭帐篷。'
    },
    {
      ...base,
      id: 2,
      code: 'CS-0002',
      name: '松林缓坡 B 区',
      campName: '云栖山谷营地',
      lng: 119.8916,
      lat: 30.5402,
      elevation: 468,
      slope: 6.8,
      aspect: '南',
      surface: '林地',
      tentCapacity: 4,
      flatness: 74,
      access: '步行',
      note: '马尾松林下缓坡，夏季阴凉，但落枝需定期清理。'
    },
    {
      ...base,
      id: 3,
      code: 'CS-0003',
      name: '碎石坝顶 C 区',
      campName: '北岭高地营地',
      lng: 119.9025,
      lat: 30.5211,
      elevation: 523,
      slope: 3.1,
      aspect: '平缓',
      surface: '碎石',
      tentCapacity: 8,
      flatness: 86,
      access: '车行',
      note: '坝顶碎石平台，地势高、视野开阔，大风天体感明显。'
    },
    {
      ...base,
      id: 4,
      code: 'CS-0004',
      name: '崖下背风 D 区',
      campName: '北岭高地营地',
      lng: 119.9098,
      lat: 30.5136,
      elevation: 561,
      slope: 9.6,
      aspect: '西',
      surface: '碎石',
      tentCapacity: 2,
      flatness: 58,
      access: '步行',
      note: '崖壁西侧凹槽，背风但上方有落石痕迹，须重点复核。'
    },
    {
      ...base,
      id: 5,
      code: 'CS-0005',
      name: '杉木林台 E 区',
      campName: '杉木坪营地',
      lng: 119.8731,
      lat: 30.5514,
      elevation: 386,
      slope: 4.5,
      aspect: '东北',
      surface: '林地',
      tentCapacity: 5,
      flatness: 80,
      access: '步行',
      note: '杉木林间平整台地，遮蔽度高，日照偏短。',
      defaultProfileId: 2
    },
    {
      ...base,
      id: 6,
      code: 'CS-0006',
      name: '河滩沙地 F 区',
      campName: '杉木坪营地',
      lng: 119.8669,
      lat: 30.5458,
      elevation: 352,
      slope: 1.2,
      aspect: '平缓',
      surface: '沙地',
      tentCapacity: 10,
      flatness: 95,
      access: '车行',
      note: '河滩沙地，平整度极佳但位于常水位河道边缘，须评估山洪风险。'
    },
    /* ---- 以下两条为同一营位的重复登记：坐标相距约 4 m，因子/否决/方案散在两条上 ---- */
    {
      ...base,
      id: 7,
      code: 'CS-0007',
      name: '桦树湾平台',
      campName: '云栖山谷营地',
      lng: 119.8851,
      lat: 30.5324,
      elevation: 418,
      slope: 3.2,
      aspect: '东南',
      surface: '草地',
      tentCapacity: 5,
      flatness: 88,
      access: '车行',
      note: '一组首登记录：有第一轮因子，未做风险复核。'
    },
    {
      ...base,
      id: 8,
      code: 'CS-0008',
      name: '桦树湾平整台地',
      campName: '云栖山谷营地',
      lng: 119.88514,
      lat: 30.53237,
      elevation: 415,
      slope: 2.8,
      aspect: '南',
      surface: '草地',
      tentCapacity: 6,
      flatness: 90,
      access: '车行',
      note: '二组复测记录：补了第二轮因子与山洪沟复核，默认挂雨季方案。',
      defaultProfileId: 2
    }
  ]
}

function seedFactors(): FactorAssessment[] {
  const rows: Array<Omit<FactorAssessment, 'createdAt' | 'updatedAt'>> = [
    {
      id: 1,
      siteId: 1,
      waterDistance: 45,
      windDir: '东南',
      windForce: 1,
      signalBars: 4,
      sunHours: 5.5,
      rockfallRisk: '无',
      shade: 35,
      distanceToCar: 12,
      distanceToTrail: 40,
      assessor: '李营',
      assessedAt: '2024-04-06'
    },
    {
      id: 2,
      siteId: 2,
      waterDistance: 180,
      windDir: '南',
      windForce: 2,
      signalBars: 3,
      sunHours: 4.2,
      rockfallRisk: '低',
      shade: 68,
      distanceToCar: 260,
      distanceToTrail: 35,
      assessor: '李营',
      assessedAt: '2024-04-06'
    },
    {
      id: 3,
      siteId: 3,
      waterDistance: 320,
      windDir: '西北',
      windForce: 4,
      signalBars: 5,
      sunHours: 6.8,
      rockfallRisk: '无',
      shade: 12,
      distanceToCar: 30,
      distanceToTrail: 120,
      assessor: '周勘',
      assessedAt: '2024-04-08'
    },
    {
      id: 4,
      siteId: 4,
      waterDistance: 260,
      windDir: '西',
      windForce: 1,
      signalBars: 3,
      sunHours: 3.6,
      rockfallRisk: '高',
      shade: 40,
      distanceToCar: 480,
      distanceToTrail: 60,
      assessor: '周勘',
      assessedAt: '2024-04-08'
    },
    {
      id: 5,
      siteId: 5,
      waterDistance: 210,
      windDir: '东北',
      windForce: 2,
      signalBars: 2,
      sunHours: 2.8,
      rockfallRisk: '中',
      shade: 78,
      distanceToCar: 340,
      distanceToTrail: 25,
      assessor: '陈巡',
      assessedAt: '2024-04-10'
    },
    {
      id: 6,
      siteId: 6,
      waterDistance: 8,
      windDir: '北',
      windForce: 3,
      signalBars: 4,
      sunHours: 6.2,
      rockfallRisk: '低',
      shade: 8,
      distanceToCar: 55,
      distanceToTrail: 90,
      assessor: '陈巡',
      assessedAt: '2024-04-10'
    },
    /* CS-0007：只有一组首登的第一轮因子 */
    {
      id: 7,
      siteId: 7,
      waterDistance: 95,
      windDir: '东南',
      windForce: 2,
      signalBars: 3,
      sunHours: 5.1,
      rockfallRisk: '低',
      shade: 42,
      distanceToCar: 60,
      distanceToTrail: 70,
      assessor: '李营',
      assessedAt: '2024-04-07'
    },
    /* CS-0008：二组复测的第二轮因子（日期更新），风险结论与首登不同 */
    {
      id: 8,
      siteId: 8,
      waterDistance: 120,
      windDir: '南',
      windForce: 2,
      signalBars: 4,
      sunHours: 5.6,
      rockfallRisk: '中',
      shade: 38,
      distanceToCar: 70,
      distanceToTrail: 65,
      assessor: '周勘',
      assessedAt: '2024-04-11'
    }
  ]
  return rows.map((r) => ({ ...r, createdAt: SEED_TS, updatedAt: SEED_TS }))
}

function seedVetos(): RiskVeto[] {
  return [
    {
      id: 1,
      siteId: 6,
      type: '河道内',
      description: '营位北缘距常水位仅 8 米，暴雨后水位上涨会直接漫过沙地。',
      judge: '陈巡',
      judgedAt: '2024-04-11',
      createdAt: SEED_TS,
      updatedAt: SEED_TS
    },
    {
      id: 2,
      siteId: 5,
      type: '孤树下',
      description: '台地中央有一株孤立高杉，雷雨时存在雷击与断枝风险。',
      judge: '李营',
      judgedAt: '2024-04-11',
      createdAt: SEED_TS,
      updatedAt: SEED_TS
    },
    /* CS-0008（复测那条）登记了山洪沟否决，归并后应转入保留项 */
    {
      id: 3,
      siteId: 8,
      type: '山洪沟',
      description: '台地南缘紧贴汇水沟口，复测确认短时强降雨时有山洪直冲风险。',
      judge: '周勘',
      judgedAt: '2024-04-11',
      createdAt: SEED_TS,
      updatedAt: SEED_TS
    }
  ]
}

/** 首次运行写入样例数据，保证每个页面首屏都有可评估的内容。 */
export async function seedIfEmpty(): Promise<void> {
  const count = await db.sites.count()
  if (count > 0) return
  await db.transaction('rw', db.sites, db.factors, db.profiles, db.vetos, async () => {
    await db.profiles.bulkPut(seedProfiles())
    await db.sites.bulkPut(seedSites())
    await db.factors.bulkPut(seedFactors())
    await db.vetos.bulkPut(seedVetos())
  })
}
