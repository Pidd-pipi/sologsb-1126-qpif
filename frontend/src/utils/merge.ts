/**
 * 营位归并工具：
 * 1. findMergeCandidates —— 按距离、海拔差、名称相似度列出疑似重复登记的营位对；
 * 2. buildMergePlan —— 预演归并，列清双方基础字段冲突、待转入的多轮因子与否决记录；
 * 3. mergeSites —— 在单个 Dexie 事务内完成「保留项吸收另一条」，失败自动回滚两条原样；
 * 4. restoreLastMerge —— 归并后仍可恢复成两条原始营位，恢复后允许重新归并（可重试）。
 *
 * 旧编号处理：被吸收营位的 code 追加到保留项 aliases（v4 起为多值索引），
 * 因此后续导入用旧编号检索时仍能定位到保留项（resolveSiteByCode）。
 */
import type { Campsite, CampsiteMergeLog } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { RiskVeto } from '@/types/veto'
import type { ScoreProfile } from '@/types/score'
import { db, toPlain } from '@/utils/db'
import { distanceMeters } from '@/utils/geo'
import { nowIso } from '@/utils/format'

/* ----------------------------- 候选探测 ----------------------------- */

export interface MergeThresholds {
  /** 坐标距离阈值（米） */
  maxDistanceMeters: number
  /** 海拔差阈值（米） */
  maxElevationDiff: number
  /** 名称相似度阈值（0-1） */
  minNameSimilarity: number
}

export const DEFAULT_MERGE_THRESHOLDS: MergeThresholds = {
  maxDistanceMeters: 60,
  maxElevationDiff: 25,
  minNameSimilarity: 0.34
}

export interface MergeCandidate {
  a: Campsite
  b: Campsite
  /** 坐标间距（米） */
  distance: number
  /** 海拔差（米，绝对值） */
  elevationDiff: number
  /** 名称相似度 0-1 */
  nameSimilarity: number
  /** 是否属于同一营地 */
  sameCamp: boolean
  /** 命中依据，便于在界面上讲清为什么是候选 */
  reasons: string[]
}

/** 去掉空白与常见标点，用于名称归一比对。 */
function normalizeName(text: string): string {
  return (text ?? '').replace(/[\s·・,，.。、\-_/（）()【】\[\]]/g, '')
}

/**
 * 名称相似度：基于归一后字符串的二元字组 Jaccard，
 * 并对「包含」「相等」给更高的保底分，贴合「桦树湾平台 / 桦树湾平整台地」这类现场命名。
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) {
    const shorter = Math.min(x.length, y.length)
    const longer = Math.max(x.length, y.length)
    return Math.max(0.6, shorter / longer)
  }
  const grams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const gx = grams(x)
  const gy = grams(y)
  if (gx.size === 0 || gy.size === 0) return 0
  let common = 0
  gx.forEach((g) => {
    if (gy.has(g)) common += 1
  })
  return common / (gx.size + gy.size - common)
}

/** 列出全部疑似重复营位对，按距离从近到远排列。 */
export function findMergeCandidates(
  sites: Campsite[],
  thresholds: MergeThresholds = DEFAULT_MERGE_THRESHOLDS
): MergeCandidate[] {
  const valid = sites.filter((s): s is Campsite & { id: number } => typeof s.id === 'number')
  const out: MergeCandidate[] = []
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const a = valid[i]
      const b = valid[j]
      const distance = distanceMeters({ lng: a.lng, lat: a.lat }, { lng: b.lng, lat: b.lat })
      const elevationDiff = Math.abs(a.elevation - b.elevation)
      const sim = nameSimilarity(a.name, b.name)
      const sameCamp = !!a.campName && a.campName === b.campName
      if (distance > thresholds.maxDistanceMeters) continue
      if (elevationDiff > thresholds.maxElevationDiff) continue
      if (!sameCamp && sim < thresholds.minNameSimilarity) continue

      const reasons: string[] = []
      reasons.push(`坐标相距 ${distance.toFixed(1)} m`)
      reasons.push(`海拔差 ${elevationDiff} m`)
      reasons.push(sameCamp ? '同一所属营地' : '分属不同营地')
      reasons.push(`名称相似度 ${(sim * 100).toFixed(0)}%`)
      out.push({ a, b, distance, elevationDiff, nameSimilarity: sim, sameCamp, reasons })
    }
  }
  return out.sort((x, y) => x.distance - y.distance)
}

/* ----------------------------- 归并预演 ----------------------------- */

/** 参与冲突比对的基础字段（坐标经纬度合并为一项，取值时一起搬）。 */
export const MERGE_FIELD_KEYS = [
  'name',
  'campName',
  'lngLat',
  'elevation',
  'slope',
  'aspect',
  'surface',
  'tentCapacity',
  'flatness',
  'access',
  'defaultProfileId',
  'note'
] as const

export type MergeFieldKey = (typeof MERGE_FIELD_KEYS)[number]
export type MergeValueSource = 'retained' | 'absorbed'

export interface MergeFieldConflict {
  key: MergeFieldKey
  label: string
  /** 保留项该字段的展示值 */
  retainedValue: string
  /** 被吸收项该字段的展示值 */
  absorbedValue: string
  /** 双方是否一致（一致则不算冲突，固定取保留项） */
  equal: boolean
}

export interface MergePlan {
  retained: Campsite
  absorbed: Campsite
  /** 基础字段冲突清单（双方取值不一致的字段） */
  conflicts: MergeFieldConflict[]
  /** 保留项已有的因子轮次数 */
  retainedFactorCount: number
  /** 将从被吸收项转入的因子轮次 */
  absorbedFactors: FactorAssessment[]
  /** 将从被吸收项转入的否决记录 */
  absorbedVetos: RiskVeto[]
  /** 保留项已有否决条数（界面提示用） */
  retainedVetoCount: number
}

function profileNameOf(id: number | null | undefined, profiles: ScoreProfile[]): string {
  if (id == null) return '未指定方案'
  const p = profiles.find((x) => x.id === id)
  return p ? p.name : `方案 #${id}`
}

/** 单个字段的人类可读展示值。 */
export function formatFieldValue(
  site: Campsite,
  key: MergeFieldKey,
  profiles: ScoreProfile[]
): string {
  switch (key) {
    case 'name':
      return site.name || '—'
    case 'campName':
      return site.campName || '—'
    case 'lngLat':
      return `${site.lng.toFixed(5)}, ${site.lat.toFixed(5)}`
    case 'elevation':
      return `${site.elevation} m`
    case 'slope':
      return `${site.slope}°`
    case 'aspect':
      return site.aspect
    case 'surface':
      return site.surface
    case 'tentCapacity':
      return `${site.tentCapacity} 帐`
    case 'flatness':
      return `${site.flatness} 分`
    case 'access':
      return site.access
    case 'defaultProfileId':
      return profileNameOf(site.defaultProfileId, profiles)
    case 'note':
      return site.note || '（无备注）'
  }
}

function fieldRawEqual(a: Campsite, b: Campsite, key: MergeFieldKey): boolean {
  if (key === 'lngLat') {
    return Math.abs(a.lng - b.lng) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6
  }
  return a[key] === b[key]
}

const FIELD_LABELS: Record<MergeFieldKey, string> = {
  name: '营位名称',
  campName: '所属营地',
  lngLat: '坐标（经纬度）',
  elevation: '海拔',
  slope: '坡度',
  aspect: '坡向',
  surface: '地表类型',
  tentCapacity: '可容帐篷数',
  flatness: '平整度',
  access: '进出方式',
  defaultProfileId: '默认评分方案',
  note: '备注'
}

/** 预演一次归并：列出冲突字段与将转入的因子/否决，不写库。 */
export function buildMergePlan(
  retained: Campsite,
  absorbed: Campsite,
  profiles: ScoreProfile[],
  allFactors: FactorAssessment[],
  allVetos: RiskVeto[]
): MergePlan {
  const conflicts = MERGE_FIELD_KEYS.filter((key) => !fieldRawEqual(retained, absorbed, key)).map(
    (key) => ({
      key,
      label: FIELD_LABELS[key],
      retainedValue: formatFieldValue(retained, key, profiles),
      absorbedValue: formatFieldValue(absorbed, key, profiles),
      equal: false
    })
  )
  return {
    retained,
    absorbed,
    conflicts,
    retainedFactorCount: allFactors.filter((f) => f.siteId === retained.id).length,
    absorbedFactors: allFactors
      .filter((f) => f.siteId === absorbed.id)
      .sort((x, y) => (x.assessedAt < y.assessedAt ? 1 : -1)),
    absorbedVetos: allVetos.filter((v) => v.siteId === absorbed.id),
    retainedVetoCount: allVetos.filter((v) => v.siteId === retained.id).length
  }
}

/* ----------------------------- 写库与回滚 ----------------------------- */

export interface MergeSitesInput {
  retainedId: number
  absorbedId: number
  profiles: ScoreProfile[]
  /** 每个冲突字段取哪一方；缺省一律取保留项 */
  resolutions: Partial<Record<MergeFieldKey, MergeValueSource>>
  /** 界面上当前全部因子与否决（也可直接读库，由页面传入减少往返） */
  factors: FactorAssessment[]
  vetos: RiskVeto[]
}

const BACKUP_KEY = 'gbcampsite:merge-backup:latest'

interface MergeBackup {
  savedAt: string
  retainedId: number
  absorbedId: number
  retainedCode: string
  absorbedCode: string
  sites: Campsite[]
  factors: FactorAssessment[]
  vetos: RiskVeto[]
}

/** 归并前的现场快照，失败恢复与事后撤销都用它。 */
export function saveMergeBackup(backup: MergeBackup): void {
  try {
    globalThis.localStorage.setItem(BACKUP_KEY, JSON.stringify(backup))
  } catch {
    /* localStorage 不可用时不阻塞归并，事务本身仍保证原子性 */
  }
}

export function loadMergeBackup(): MergeBackup | null {
  try {
    const raw = globalThis.localStorage.getItem(BACKUP_KEY)
    return raw ? (JSON.parse(raw) as MergeBackup) : null
  } catch {
    return null
  }
}

export function clearMergeBackup(): void {
  try {
    globalThis.localStorage.removeItem(BACKUP_KEY)
  } catch {
    /* ignore */
  }
}

function applyResolution(
  patch: Partial<Campsite>,
  retained: Campsite,
  absorbed: Campsite,
  key: Exclude<MergeFieldKey, 'lngLat'>,
  source: MergeValueSource
): void {
  const src = source === 'absorbed' ? absorbed : retained
  // 联合类型字段逐个赋值，保证 TS 能校验 patch 与 Campsite 字段对应
  if (key === 'name') {
    patch.name = src.name
  } else if (key === 'campName') {
    patch.campName = src.campName
  } else if (key === 'elevation') {
    patch.elevation = src.elevation
  } else if (key === 'slope') {
    patch.slope = src.slope
  } else if (key === 'aspect') {
    patch.aspect = src.aspect
  } else if (key === 'surface') {
    patch.surface = src.surface
  } else if (key === 'tentCapacity') {
    patch.tentCapacity = src.tentCapacity
  } else if (key === 'flatness') {
    patch.flatness = src.flatness
  } else if (key === 'access') {
    patch.access = src.access
  } else if (key === 'defaultProfileId') {
    patch.defaultProfileId = src.defaultProfileId
  } else if (key === 'note') {
    patch.note = src.note
  }
}

/**
 * 执行归并。全程包在一个 rw 事务里：任一步失败，IndexedDB 自动放弃全部改动，
 * 两条营位保持原样，调用方可提示用户重试。
 *
 * 归并成功后：被吸收营位删除；其因子（多轮）、否决记录的 siteId 改挂保留项；
 * 被吸收营位原编号（含它自带的历史别名）转入保留项 aliases；冲突取值写入 mergeLogs 留痕。
 */
export async function mergeSites(input: MergeSitesInput): Promise<Campsite> {
  const { retainedId, absorbedId } = input
  if (retainedId === absorbedId) {
    throw new Error('不能把同一个营位归并给自己')
  }
  const retained = await db.sites.get(retainedId)
  const absorbed = await db.sites.get(absorbedId)
  if (!retained || !absorbed) {
    throw new Error('待归并的营位已不存在，请刷新候选列表后重试')
  }

  const factors = input.factors.some((f) => f.siteId === absorbedId)
    ? input.factors
    : await db.factors.toArray()
  const vetos = input.vetos.some((v) => v.siteId === absorbedId)
    ? input.vetos
    : await db.vetos.toArray()
  const absorbedFactors = factors.filter((f) => f.siteId === absorbedId)
  const absorbedVetos = vetos.filter((v) => v.siteId === absorbedId)

  // 归并前先留快照：即便事务已原子，快照仍支持事后「恢复两条原样」。
  saveMergeBackup({
    savedAt: nowIso(),
    retainedId,
    absorbedId,
    retainedCode: retained.code,
    absorbedCode: absorbed.code,
    sites: [toPlain(retained), toPlain(absorbed)],
    factors: toPlain([
      ...factors.filter((f) => f.siteId === retainedId || f.siteId === absorbedId)
    ]),
    vetos: toPlain([...vetos.filter((v) => v.siteId === retainedId || v.siteId === absorbedId)])
  })

  try {
    let merged: Campsite | undefined
    await db.transaction('rw', db.sites, db.factors, db.vetos, async () => {
      const ts = nowIso()
      const patch: Partial<Campsite> = { updatedAt: ts }

      // 1) 冲突字段按用户选择取值，并形成留痕
      const plan = buildMergePlan(retained, absorbed, input.profiles, factors, vetos)
      const conflictLog: CampsiteMergeLog['conflicts'] = plan.conflicts.map((c) => {
        const source = input.resolutions[c.key] ?? 'retained'
        if (c.key === 'lngLat') {
          const src = source === 'absorbed' ? absorbed : retained
          patch.lng = src.lng
          patch.lat = src.lat
        } else {
          applyResolution(patch, retained, absorbed, c.key, source)
        }
        return {
          field: c.key,
          label: c.label,
          keptValue: source === 'absorbed' ? c.absorbedValue : c.retainedValue,
          source,
          retainedValue: c.retainedValue,
          absorbedValue: c.absorbedValue
        }
      })

      // 2) 历史别名：被吸收编号 + 它可能已携带的旧别名（链式归并不丢号），去重
      const aliasSet = new Set<string>([...(retained.aliases ?? [])])
      aliasSet.add(absorbed.code)
      for (const alias of absorbed.aliases ?? []) aliasSet.add(alias)
      if (aliasSet.has(retained.code)) aliasSet.delete(retained.code)
      patch.aliases = Array.from(aliasSet)

      // 3) 归并留痕（只增不改）
      const log: CampsiteMergeLog = {
        absorbedId,
        absorbedCode: absorbed.code,
        mergedAt: ts,
        factorCount: absorbedFactors.length,
        vetoCount: absorbedVetos.length,
        conflicts: conflictLog
      }
      patch.mergeLogs = [log, ...(retained.mergeLogs ?? [])]

      await db.sites.update(retainedId, patch)

      // 4) 多轮因子、风险否决整单接到保留项
      if (absorbedFactors.length) {
        await db.factors.bulkPut(
          absorbedFactors.map((f) => ({ ...toPlain(f), siteId: retainedId, updatedAt: ts }))
        )
      }
      if (absorbedVetos.length) {
        await db.vetos.bulkPut(
          absorbedVetos.map((v) => ({ ...toPlain(v), siteId: retainedId, updatedAt: ts }))
        )
      }

      // 5) 删除被吸收营位（名次表与地图随即只剩保留项）
      await db.sites.delete(absorbedId)

      merged = await db.sites.get(retainedId)
    })
    if (!merged) throw new Error('归并后读取保留项失败')
    return merged
  } catch (err) {
    // 事务已回滚：两条营位、因子与否决均保持归并前状态，可直接重试
    throw new Error(`归并失败，数据已恢复为两条原样：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 事后撤销：用快照把两条营位恢复成归并前的原样。
 * 注意：保留项在归并后新增的因子轮次/否决不受影响（它们不在快照内），
 * 仅把快照中的双方原始记录（含原 siteId 指向）整单复原。
 */
export async function restoreLastMerge(): Promise<{ retainedId: number; absorbedId: number }> {
  const backup = loadMergeBackup()
  if (!backup) throw new Error('没有可恢复的归并记录')
  await db.transaction('rw', db.sites, db.factors, db.vetos, async () => {
    await db.sites.bulkPut(backup.sites.map((s) => toPlain(s)))
    if (backup.factors.length) await db.factors.bulkPut(backup.factors.map((f) => toPlain(f)))
    if (backup.vetos.length) await db.vetos.bulkPut(backup.vetos.map((v) => toPlain(v)))
  })
  clearMergeBackup()
  return { retainedId: backup.retainedId, absorbedId: backup.absorbedId }
}

/* --------------------------- 旧编号反查（后续导入） --------------------------- */

/**
 * 按营位编号定位：先查现行 code，再查历史别名 aliases（v4 多值索引）。
 * 后续导入数据引用旧编号时，仍能找到归并后的保留项。
 */
export async function resolveSiteByCode(code: string): Promise<Campsite | undefined> {
  const key = (code ?? '').trim()
  if (!key) return undefined
  const direct = await db.sites.where('code').equals(key).first()
  if (direct) return direct
  return db.sites.where('aliases').equals(key).first()
}
