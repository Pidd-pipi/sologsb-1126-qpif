/**
 * SiteMerge（营位归并）—— 两条重复登记的营位合并为一条的完整记录。
 * 被并项的因子、否决与评分关系统一挂到保留项；被并项编号成为保留项的历史别名。
 * 快照用于审计与失败回滚参考。
 */
import type { Campsite } from './campsite'
import type { FactorAssessment } from './factor'
import type { RiskVeto } from './veto'

/** 归并前的完整快照，记录双方原始数据与被转移的子记录 id。 */
export interface MergeSnapshot {
  /** 保留项归并前的原始记录 */
  kept: Campsite
  /** 被并项归并前的原始记录 */
  removed: Campsite
  /** 被转移到保留项的因子评估 id 列表 */
  factorIds: number[]
  /** 被转移到保留项的风险否决 id 列表 */
  vetoIds: number[]
}

export interface SiteMergeRecord {
  /** 主键，自增 */
  id?: number
  /** 保留项（归并后继续使用的营位）id */
  keptSiteId: number
  /** 保留项编号 */
  keptCode: string
  /** 被并项（归并后删除的营位）id */
  removedSiteId: number
  /** 被并项编号，归并后成为保留项的历史别名 */
  removedCode: string
  /** 被并项名称 */
  removedName: string
  /** 归并时间（ISO） */
  mergedAt: string
  /** 归并操作人 */
  operator: string
  /** 归并说明：冲突字段的取值来源摘要 */
  note: string
  /** 归并前快照 */
  snapshot: MergeSnapshot
}

/** 归并时候选字段的取值来源 */
export type MergeChoice = 'kept' | 'removed'

/** 两个营位的相似度评分结果，用于候选排序 */
export interface MergeCandidate {
  /** 参与归并的甲方（保留项候选） */
  siteA: Campsite
  /** 参与归并的乙方（被并项候选） */
  siteB: Campsite
  /** 两点间距（米） */
  distanceMeters: number
  /** 海拔差（米，绝对值） */
  elevationDiff: number
  /** 名称相似度（0-1） */
  nameSimilarity: number
  /** 综合相似度得分（0-100），越高越像重复登记 */
  score: number
  /** 命中的候选原因，用于界面提示 */
  reasons: string[]
}

/** 归并预览中一个冲突字段的对比行 */
export interface MergeConflictRow {
  /** 字段键（Campsite 字段名） */
  field: string
  /** 字段中文名 */
  label: string
  /** 保留项的原始值 */
  keptValue: unknown
  /** 被并项的原始值 */
  removedValue: unknown
  /** 当前选择的取值来源 */
  choice: MergeChoice
}

/** 归并操作的结果 */
export interface MergeResult {
  success: boolean
  /** 保留项 id */
  keptSiteId?: number
  /** 被转移的因子条数 */
  movedFactors?: number
  /** 被转移的否决条数 */
  movedVetoes?: number
  /** 失败时的错误信息 */
  error?: string
}

/** 需要对比的营位字段元数据 */
export interface MergeFieldMeta {
  key: string
  label: string
}

/** 归并时需要对比、可由用户选择来源的营位字段 */
export const MERGE_FIELDS: MergeFieldMeta[] = [
  { key: 'name', label: '营位名称' },
  { key: 'campName', label: '所属营地' },
  { key: 'lng', label: '经度' },
  { key: 'lat', label: '纬度' },
  { key: 'elevation', label: '海拔' },
  { key: 'slope', label: '坡度' },
  { key: 'aspect', label: '坡向' },
  { key: 'surface', label: '地表类型' },
  { key: 'tentCapacity', label: '可容帐篷数' },
  { key: 'flatness', label: '平整度评分' },
  { key: 'access', label: '进出方式' },
  { key: 'note', label: '备注' }
]

/** 判断两个营位字段值是否相等（做了数值归一，避免 1 与 1.0 误判）。 */
export function mergeValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6
  return false
}

/** 从因子数组中取最新一轮（按评估日期倒序）。 */
export function latestFactorOf(factors: FactorAssessment[]): FactorAssessment | null {
  if (!factors.length) return null
  return [...factors].sort((x, y) => (x.assessedAt < y.assessedAt ? 1 : -1))[0]
}

/** 从否决数组中取最新一条（按判定日期倒序）。 */
export function latestVetoOf(vetos: RiskVeto[]): RiskVeto | null {
  if (!vetos.length) return null
  return [...vetos].sort((x, y) => (x.judgedAt < y.judgedAt ? 1 : -1))[0]
}
