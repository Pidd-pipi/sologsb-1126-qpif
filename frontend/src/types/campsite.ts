/**
 * Campsite（营位）—— 候选营位的基础地理与场地信息。
 * 与地形/坡度/容量相关，被名次表、地图、详情页共同消费。
 */

/** 地表类型 */
export type SurfaceType = '草地' | '碎石' | '林地' | '沙地'

/** 进出方式 */
export type AccessMode = '车行' | '步行'

/** 坡向（八方位 + 平缓） */
export type AspectType =
  | '北'
  | '东北'
  | '东'
  | '东南'
  | '南'
  | '西南'
  | '西'
  | '西北'
  | '平缓'

export interface Campsite {
  /** 主键，自增 */
  id?: number
  /** 营位编号，如 CS-0001 */
  code: string
  /** 营位名称 */
  name: string
  /** 所属营地 */
  campName: string
  /** 经度（WGS84 近似值，用于地图与网格换算） */
  lng: number
  /** 纬度 */
  lat: number
  /** 海拔（米） */
  elevation: number
  /** 地形坡度（度） */
  slope: number
  /** 坡向 */
  aspect: AspectType
  /** 地表类型 */
  surface: SurfaceType
  /** 可容帐篷数 */
  tentCapacity: number
  /** 平整度评分（0-100） */
  flatness: number
  /** 进出方式 */
  access: AccessMode
  /** 该营位默认采用的权重方案 id（v3 迁移时回填） */
  defaultProfileId: number | null
  /**
   * 历史别名编号：营位归并后，被吸收营位的旧编号保存在保留项上。
   * 多值索引（*aliases），后续导入凭旧编号仍能定位到保留项。（v4 迁移时补齐）
   */
  aliases: string[]
  /** 归并留痕：每次归并的来源、时间与冲突取值依据（只增不改） */
  mergeLogs: CampsiteMergeLog[]
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
}

/** 营位归并留痕：讲清楚另一条记录从哪来、冲突值如何取 */
export interface CampsiteMergeLog {
  /** 被吸收营位的原主键（恢复两条原样时可能用到） */
  absorbedId: number
  /** 被吸收营位的原编号，已转入 aliases */
  absorbedCode: string
  /** 归并时间 ISO */
  mergedAt: string
  /** 因子评估转入条数 */
  factorCount: number
  /** 风险否决转入条数 */
  vetoCount: number
  /** 冲突字段取值说明：每个冲突字段标注最终取自哪一方 */
  conflicts: Array<{
    field: string
    label: string
    keptValue: string | number
    source: 'retained' | 'absorbed'
    retainedValue: string | number
    absorbedValue: string | number
  }>
}

/** 地表类型的可选值，供筛选器与表单复用 */
export const SURFACE_TYPES: SurfaceType[] = ['草地', '碎石', '林地', '沙地']

/** 进出方式可选值 */
export const ACCESS_MODES: AccessMode[] = ['车行', '步行']

/** 坡向可选值 */
export const ASPECT_TYPES: AspectType[] = [
  '北',
  '东北',
  '东',
  '东南',
  '南',
  '西南',
  '西',
  '西北',
  '平缓'
]

/** 坡向对应的理想光照系数（东南/南向最适宜扎营） */
export const ASPECT_SCORE: Record<AspectType, number> = {
  南: 100,
  东南: 90,
  西南: 80,
  东: 78,
  平缓: 74,
  西: 66,
  东北: 62,
  西北: 54,
  北: 48
}
