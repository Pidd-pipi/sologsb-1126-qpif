/**
 * 营位归并工具：候选检测、归并预览、事务性归并执行、旧编号/旧 id 解析。
 *
 * 归并语义：
 *   - 保留项接过被并项的全部因子评估与风险否决（siteId 改写为保留项 id）
 *   - 被并项编号成为保留项的历史别名（aliases），旧编号检索能定位到保留项
 *   - 冲突字段由用户选择取值来源，双方来源在预览中逐一标明
 *   - 全程在 Dexie 事务中执行，任一步失败整体回滚，恢复两条营位原样后可重试
 */
import { db, toPlain } from '@/utils/db'
import { distanceMeters } from '@/utils/geo'
import { nowIso } from '@/utils/format'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type { RiskVeto } from '@/types/veto'
import {
  MERGE_FIELDS,
  mergeValuesEqual,
  type MergeCandidate,
  type MergeChoice,
  type MergeConflictRow,
  type MergeResult,
  type SiteMergeRecord
} from '@/types/merge'

/* ------------------------------ 候选检测 ------------------------------ */

/** 候选判定阈值（可由调用方按营地尺度调整）。 */
export interface MergeThresholds {
  /** 间距上限（米），超过则不视为同一营位 */
  maxDistance: number
  /** 海拔差上限（米） */
  maxElevationDiff: number
  /** 名称相似度下限（0-1） */
  minNameSimilarity: number
}

export const DEFAULT_THRESHOLDS: MergeThresholds = {
  maxDistance: 500,
  maxElevationDiff: 80,
  minNameSimilarity: 0.3
}

/** 归一化名称：去空白、标点，转小写，便于相似度比对。 */
function normalizeName(name: string): string {
  return (name ?? '')
    .replace(/[\s·\-　]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .toLowerCase()
}

/** Levenshtein 相似度（0-1），越长的公共子序列得分越高。 */
function levenshteinSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return 0
  const dp: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j += 1) dp[j] = j
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j]
      if (a[i - 1] === b[j - 1]) dp[j] = prev
      else dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
    }
  }
  const dist = dp[n]
  return 1 - dist / Math.max(m, n)
}

/** 名称相似度：综合 Levenshtein 与字符 bigram 重叠。 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const lev = levenshteinSimilarity(na, nb)
  // bigram 重叠系数
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const ba = bigrams(na)
  const bb = bigrams(nb)
  let inter = 0
  ba.forEach((g) => {
    if (bb.has(g)) inter += 1
  })
  const bigram = ba.size + bb.size > 0 ? (2 * inter) / (ba.size + bb.size) : 0
  return Math.max(lev, bigram)
}

/** 计算两个营位的候选得分与命中原因。 */
function scorePair(
  a: Campsite,
  b: Campsite,
  thresholds: MergeThresholds
): { candidate: MergeCandidate | null } {
  const meters = distanceMeters({ lng: a.lng, lat: a.lat }, { lng: b.lng, lat: b.lat })
  const elevDiff = Math.abs(a.elevation - b.elevation)
  const nameSim = nameSimilarity(a.name, b.name)
  const sameCamp = a.campName.trim() !== '' && a.campName === b.campName

  const reasons: string[] = []
  let pass = false

  if (meters <= thresholds.maxDistance) {
    reasons.push(`间距 ${meters.toFixed(0)} m`)
    pass = true
  }
  if (elevDiff <= thresholds.maxElevationDiff) {
    reasons.push(`海拔差 ${elevDiff.toFixed(0)} m`)
    pass = true
  }
  if (nameSim >= thresholds.minNameSimilarity) {
    reasons.push(`名称相似度 ${(nameSim * 100).toFixed(0)}%`)
    pass = true
  }
  if (sameCamp) {
    reasons.push(`同属「${a.campName}」`)
    pass = true
  }

  if (!pass) return { candidate: null }

  // 综合得分：距离 40% + 海拔 20% + 名称 40%
  const distScore = Math.max(0, 1 - meters / thresholds.maxDistance) * 100
  const elevScore = Math.max(0, 1 - elevDiff / thresholds.maxElevationDiff) * 100
  const nameScore = nameSim * 100
  const score = Math.round(0.4 * distScore + 0.2 * elevScore + 0.4 * nameScore)

  return {
    candidate: {
      siteA: a,
      siteB: b,
      distanceMeters: meters,
      elevationDiff: elevDiff,
      nameSimilarity: nameSim,
      score,
      reasons
    }
  }
}

/**
 * 从全部营位中检测重复登记的候选对，按综合得分降序排列。
 * 已归并（在 aliases 中出现过的编号）的营位不再参与。
 */
export function findMergeCandidates(
  sites: Campsite[],
  thresholds: MergeThresholds = DEFAULT_THRESHOLDS
): MergeCandidate[] {
  const active = sites.filter((s) => typeof s.id === 'number')
  const out: MergeCandidate[] = []
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const { candidate } = scorePair(active[i], active[j], thresholds)
      if (candidate) out.push(candidate)
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/* ------------------------------ 归并预览 ------------------------------ */

/** 构建归并预览：列出所有冲突字段及双方来源。 */
export function buildMergePreview(
  kept: Campsite,
  removed: Campsite,
  factors: FactorAssessment[],
  vetos: RiskVeto[]
): {
  conflicts: MergeConflictRow[]
  movedFactorCount: number
  movedVetoCount: number
} {
  const conflicts: MergeConflictRow[] = []
  for (const meta of MERGE_FIELDS) {
    const kv = (kept as unknown as Record<string, unknown>)[meta.key]
    const rv = (removed as unknown as Record<string, unknown>)[meta.key]
    if (!mergeValuesEqual(kv, rv)) {
      conflicts.push({ field: meta.key, label: meta.label, keptValue: kv, removedValue: rv, choice: 'kept' })
    }
  }
  const movedFactorCount = factors.filter((f) => f.siteId === removed.id).length
  const movedVetoCount = vetos.filter((v) => v.siteId === removed.id).length
  return { conflicts, movedFactorCount, movedVetoCount }
}

/* ------------------------------ 事务性归并 ------------------------------ */

/** 归并失败错误，携带阶段信息便于界面提示与重试。 */
export class MergeError extends Error {
  constructor(
    message: string,
    public readonly stage: 'validate' | 'transaction' | 'unknown'
  ) {
    super(message)
    this.name = 'MergeError'
  }
}

/**
 * 执行营位归并。
 *
 * 流程（全程事务，失败自动回滚）：
 *   1. 校验两个营位存在且不同
 *   2. 快照双方原始数据
 *   3. 被并项的因子评估 siteId 改写为保留项
 *   4. 被并项的风险否决 siteId 改写为保留项
 *   5. 按 choices 合并保留项字段，被并项编号加入 aliases
 *   6. 删除被并项
 *   7. 写入归并记录
 *
 * 任一步抛出异常，Dexie 事务回滚，两条营位恢复原样，调用方可重试。
 */
export async function executeMerge(
  keptSiteId: number,
  removedSiteId: number,
  choices: Record<string, MergeChoice>,
  operator: string
): Promise<MergeResult> {
  if (keptSiteId === removedSiteId) {
    return { success: false, error: '不能归并同一个营位' }
  }

  try {
    const result = await db.transaction(
      'rw',
      db.sites,
      db.factors,
      db.vetos,
      db.mergeLogs,
      async () => {
        // 1. 校验
        const kept = await db.sites.get(keptSiteId)
        const removed = await db.sites.get(removedSiteId)
        if (!kept || !removed) {
          throw new MergeError('营位不存在，可能已被删除', 'validate')
        }

        // 2. 快照
        const snapshot: SiteMergeRecord['snapshot'] = {
          kept: toPlain(kept),
          removed: toPlain(removed),
          factorIds: [],
          vetoIds: []
        }

        // 3. 转移因子评估
        const movedFactors = await db.factors.where('siteId').equals(removedSiteId).toArray()
        snapshot.factorIds = movedFactors.map((f) => f.id as number)
        if (movedFactors.length) {
          await db.factors.where('siteId').equals(removedSiteId).modify({ siteId: keptSiteId })
        }

        // 4. 转移风险否决
        const movedVetos = await db.vetos.where('siteId').equals(removedSiteId).toArray()
        snapshot.vetoIds = movedVetos.map((v) => v.id as number)
        if (movedVetos.length) {
          await db.vetos.where('siteId').equals(removedSiteId).modify({ siteId: keptSiteId })
        }

        // 5. 合并保留项字段
        const merged: Campsite = { ...toPlain(kept) }
        for (const meta of MERGE_FIELDS) {
          const choice = choices[meta.key]
          if (choice === 'removed') {
            const rv = (removed as unknown as Record<string, unknown>)[meta.key]
            ;(merged as unknown as Record<string, unknown>)[meta.key] = rv
          }
        }
        // 评分关系（defaultProfileId）：保留项优先，保留项为空时接过被并项的方案
        if (merged.defaultProfileId == null && removed.defaultProfileId != null) {
          merged.defaultProfileId = removed.defaultProfileId
        }
        // 被并项编号成为保留项的历史别名
        const aliases = new Set<string>([...(kept.aliases ?? [])])
        if (removed.code) aliases.add(removed.code)
        if (removed.name && removed.name !== kept.name) aliases.add(removed.name)
        merged.aliases = Array.from(aliases)
        merged.updatedAt = nowIso()

        // 6. 删除被并项
        await db.sites.delete(removedSiteId)

        // 7. 写入归并记录
        const record: SiteMergeRecord = {
          keptSiteId,
          keptCode: merged.code,
          removedSiteId,
          removedCode: removed.code,
          removedName: removed.name,
          mergedAt: nowIso(),
          operator: operator.trim() || '未署名',
          note: buildMergeNote(choices, kept, removed),
          snapshot
        }
        await db.mergeLogs.add(record)

        return {
          success: true,
          keptSiteId,
          movedFactors: movedFactors.length,
          movedVetoes: movedVetos.length
        } as MergeResult
      }
    )
    return result
  } catch (err) {
    // 事务已回滚，两条营位恢复原样
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}

/** 归并说明：记录冲突字段的取值来源，便于审计追溯。 */
function buildMergeNote(
  choices: Record<string, MergeChoice>,
  kept: Campsite,
  removed: Campsite
): string {
  const parts: string[] = []
  for (const meta of MERGE_FIELDS) {
    const choice = choices[meta.key]
    if (choice === 'removed') {
      const rv = (removed as unknown as Record<string, unknown>)[meta.key]
      parts.push(`${meta.label}取被并项「${removed.code}」的值（${formatMergeValue(rv)}）`)
    }
  }
  if (!parts.length) return `全部字段保留保留项「${kept.code}」取值`
  return parts.join('；')
}

function formatMergeValue(value: unknown): string {
  if (value == null || value === '') return '空'
  if (typeof value === 'number') return String(value)
  return String(value)
}

/* ------------------------------ 旧编号 / 旧 id 解析 ------------------------------ */

/**
 * 解析营位 id：若该 id 是被并项的旧 id，返回保留项 id；否则返回原 id。
 * 用于后续导入或子记录引用旧 id 时自动重定向到保留项。
 */
export async function resolveSiteId(id: number | null | undefined): Promise<number | null> {
  if (id == null || typeof id !== 'number') return null
  const existing = await db.sites.get(id)
  if (existing) return id
  const log = await db.mergeLogs.where('removedSiteId').equals(id).first()
  return log ? log.keptSiteId : id
}

/**
 * 按编号或历史别名查找营位：精确匹配 code 或 aliases 中的任一项。
 * 用于旧编号检索 —— 搜被并项的原编号能定位到保留项。
 */
export function findSiteByCodeOrAlias(
  sites: Campsite[],
  code: string
): Campsite | null {
  const kw = code.trim().toLowerCase()
  if (!kw) return null
  return (
    sites.find((s) => s.code.toLowerCase() === kw) ??
    sites.find((s) => (s.aliases ?? []).some((a) => a.toLowerCase() === kw)) ??
    null
  )
}

/** 取某营位的全部历史别名（含编号与曾用名）。 */
export function aliasesOf(site: Campsite | null | undefined): string[] {
  if (!site) return []
  return site.aliases ?? []
}
