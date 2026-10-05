<script setup lang="ts">
/**
 * `/merge` 营位归并 —— 处理勘察队对同一营位的重复登记。
 * 1. 按距离 / 海拔差 / 名称相似度自动列出候选营位对，也支持手动指定两条；
 * 2. 预演归并：选择保留项，逐字段确认冲突取值（讲清双方来源），
 *    被吸收项的多轮因子、风险否决整单转入保留项，默认评分方案关系按选择保留；
 * 3. 归并在单个事务内完成，失败自动恢复两条原样并可重试；
 * 4. 归并后可用旧编号反查保留项（历史别名 aliases，多值索引）。
 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import {
  DEFAULT_MERGE_THRESHOLDS,
  buildMergePlan,
  findMergeCandidates,
  loadMergeBackup,
  mergeSites,
  resolveSiteByCode,
  restoreLastMerge,
  type MergeFieldKey,
  type MergePlan,
  type MergeValueSource
} from '@/utils/merge'
import { formatDateTime } from '@/utils/format'

const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()

/* ------------------------------ 候选列表 ------------------------------ */

const candidates = computed(() => findMergeCandidates(siteStore.list))

const siteOptions = computed(() =>
  siteStore.list
    .filter((s): s is typeof s & { id: number } => typeof s.id === 'number')
    .map((s) => ({
      value: s.id,
      label: `${s.code} · ${s.name}（${s.campName}）`
    }))
)

const manualA = ref<number | null>(null)
const manualB = ref<number | null>(null)

function openPair(aId: number, bId: number): void {
  pairAId.value = aId
  pairBId.value = bId
  retainedId.value = aId
  resetResolutions()
  dialogVisible.value = true
}

function startManual(): void {
  if (manualA.value == null || manualB.value == null) {
    ElMessage.warning('请先选择两条要归并的营位')
    return
  }
  if (manualA.value === manualB.value) {
    ElMessage.warning('请选择两条不同的营位')
    return
  }
  openPair(manualA.value, manualB.value)
}

/* ------------------------------ 归并对话框 ------------------------------ */

const dialogVisible = ref(false)
const pairAId = ref<number | null>(null)
const pairBId = ref<number | null>(null)
const retainedId = ref<number | null>(null)
const merging = ref(false)

/** 冲突字段取值：默认全部取保留项，用户可逐项改取被吸收项 */
const resolutions = reactive<Partial<Record<MergeFieldKey, MergeValueSource>>>({})

function resetResolutions(): void {
  for (const key of Object.keys(resolutions)) delete resolutions[key as MergeFieldKey]
}

function chooseRetained(id: number): void {
  retainedId.value = id
  resetResolutions()
}

const siteA = computed(() => (pairAId.value == null ? null : siteStore.byId(pairAId.value)))
const siteB = computed(() => (pairBId.value == null ? null : siteStore.byId(pairBId.value)))

const retainedSite = computed(() => (retainedId.value == null ? null : siteStore.byId(retainedId.value)))
const absorbedSite = computed(() => {
  if (pairAId.value == null || pairBId.value == null || retainedId.value == null) return null
  const other = retainedId.value === pairAId.value ? pairBId.value : pairAId.value
  return siteStore.byId(other)
})

const plan = computed<MergePlan | null>(() => {
  if (!retainedSite.value || !absorbedSite.value) return null
  return buildMergePlan(
    retainedSite.value,
    absorbedSite.value,
    profileStore.list,
    siteStore.factors,
    uiStore.vetos
  )
})

/** 某一条候选营位当前的因子轮次与否决条数（选择保留项时展示） */
function sideFactorCount(id: number | null | undefined): number {
  if (id == null) return 0
  return siteStore.factors.filter((f) => f.siteId === id).length
}
function sideVetoCount(id: number | null | undefined): number {
  if (id == null) return 0
  return uiStore.vetos.filter((v) => v.siteId === id).length
}

function sourceOf(key: MergeFieldKey): MergeValueSource {
  return resolutions[key] ?? 'retained'
}

function setSource(key: MergeFieldKey, source: MergeValueSource): void {
  resolutions[key] = source
}

/** el-radio-group 的 change 值类型较宽，这里收窄到取值来源 */
function onSourceChange(key: MergeFieldKey, value: string | number | boolean | undefined): void {
  setSource(key, value === 'absorbed' ? 'absorbed' : 'retained')
}

function setAllSources(source: MergeValueSource): void {
  resetResolutions()
  if (source === 'absorbed') {
    plan.value?.conflicts.forEach((c) => {
      resolutions[c.key] = 'absorbed'
    })
  }
}

async function confirmMerge(): Promise<void> {
  if (!retainedSite.value || !absorbedSite.value) return
  const retainedCode = retainedSite.value.code
  const absorbedCode = absorbedSite.value.code
  try {
    await ElMessageBox.confirm(
      `确认把「${absorbedCode} ${absorbedSite.value.name}」并入「${retainedCode} ${retainedSite.value.name}」？\n\n` +
        `归并后仅保留 ${retainedCode} 一条记录：${absorbedCode} 的多轮因子、风险否决将转入保留项，` +
        `原编号 ${absorbedCode} 成为保留项的历史别名。操作失败会自动恢复两条原样。`,
      '归并确认',
      {
        type: 'warning',
        confirmButtonText: '确认归并',
        cancelButtonText: '再看看',
        customStyle: { whiteSpace: 'pre-line' }
      }
    )
  } catch {
    return
  }
  merging.value = true
  try {
    const kept = await mergeSites({
      retainedId: retainedSite.value.id as number,
      absorbedId: absorbedSite.value.id as number,
      profiles: profileStore.list,
      resolutions: { ...resolutions },
      factors: siteStore.factors,
      vetos: uiStore.vetos
    })
    ElMessage.success(`归并完成：${kept.code} 已接管 ${absorbedCode} 的因子、否决与方案关系`)
    dialogVisible.value = false
    await Promise.all([siteStore.load(), uiStore.loadVetos()])
    refreshBackupTick()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    merging.value = false
  }
}

/* ------------------------------ 失败恢复 / 撤销 ------------------------------ */

const backupTick = ref(0)
function refreshBackupTick(): void {
  backupTick.value += 1
}

const backupInfo = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  backupTick.value
  return loadMergeBackup()
})

/** 快照是否仍对应一次「尚未撤销」的归并：保留项在库且已挂上被吸收编号别名 */
const restorable = computed(() => {
  const b = backupInfo.value
  if (!b) return false
  const kept = siteStore.byId(b.retainedId)
  return !!kept && (kept.aliases ?? []).includes(b.absorbedCode)
})

async function restore(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将按归并前的快照恢复成两条原始营位（因子与否决的归属一并复原），恢复后可重新归并。是否继续？',
      '恢复两条营位',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    const { retainedId: rId, absorbedId: aId } = await restoreLastMerge()
    await Promise.all([siteStore.load(), uiStore.loadVetos()])
    refreshBackupTick()
    ElMessage.success(`已恢复两条原样：${rId} 与 ${aId}，可重新发起归并`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

/* ------------------------------ 旧编号反查 ------------------------------ */

const lookupCode = ref('')
const lookupResult = ref<{ id: number; code: string; name: string; aliases: string[] } | null>(
  null
)
const lookupMiss = ref(false)

async function lookup(): Promise<void> {
  const code = lookupCode.value.trim()
  if (!code) return
  const site = await resolveSiteByCode(code)
  lookupMiss.value = !site
  lookupResult.value =
    site && typeof site.id === 'number'
      ? { id: site.id, code: site.code, name: site.name, aliases: site.aliases ?? [] }
      : null
}

function openDetail(id: number | undefined | null): void {
  if (typeof id === 'number') void router.push(`/sites/${id}`)
}

const thresholdText = `距离 ≤ ${DEFAULT_MERGE_THRESHOLDS.maxDistanceMeters} m · 海拔差 ≤ ${DEFAULT_MERGE_THRESHOLDS.maxElevationDiff} m · 名称相似度 ≥ ${Math.round(
  DEFAULT_MERGE_THRESHOLDS.minNameSimilarity * 100
)}%（同营地不受名称阈值限制）`
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>营位归并</h1>
        <p>
          勘察队重复登记了同一营位时，在此按距离、海拔与名称找出候选，确认保留项后把另一条的
          多轮因子、风险否决与评分方案关系并入保留项；旧编号转为历史别名，名次表与地图只显示保留项。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
        <el-button type="primary" @click="router.push('/sites/new')">新增营位</el-button>
      </div>
    </div>

    <el-alert
      v-if="restorable"
      type="success"
      show-icon
      :closable="false"
      class="mb12"
    >
      <div class="restore-bar">
        <span>
          最近一次归并：保留项 {{ backupInfo?.retainedCode }} 已吸收 {{ backupInfo?.absorbedCode }}（归并于
          {{ backupInfo ? formatDateTime(backupInfo.savedAt) : '' }}）。如归并有误，可恢复成两条原始营位后重新归并。
        </span>
        <el-button size="small" type="warning" plain @click="restore">恢复两条原样</el-button>
      </div>
    </el-alert>

    <section class="panel">
      <div class="panel__head">
        <h2>疑似重复登记</h2>
        <span class="weight-note">判定标准：{{ thresholdText }}</span>
      </div>

      <div v-if="candidates.length" class="candidate-list">
        <article v-for="(c, idx) in candidates" :key="`${c.a.id}-${c.b.id}`" class="candidate-card">
          <div class="candidate-card__head">
            <el-tag size="small" type="warning" effect="plain">候选 {{ idx + 1 }}</el-tag>
            <span class="candidate-distance">{{ c.distance.toFixed(1) }} m</span>
          </div>
          <div class="candidate-sides">
            <div class="candidate-side">
              <el-link type="primary" underline="never" @click="openPair(c.a.id as number, c.b.id as number)">
                {{ c.a.code }} · {{ c.a.name }}
              </el-link>
              <span class="candidate-sub">{{ c.a.campName }} · 海拔 {{ c.a.elevation }} m</span>
              <span class="candidate-sub">{{ c.a.lng }}, {{ c.a.lat }}</span>
            </div>
            <span class="candidate-vs">⇄</span>
            <div class="candidate-side">
              <el-link type="primary" underline="never" @click="openPair(c.a.id as number, c.b.id as number)">
                {{ c.b.code }} · {{ c.b.name }}
              </el-link>
              <span class="candidate-sub">{{ c.b.campName }} · 海拔 {{ c.b.elevation }} m</span>
              <span class="candidate-sub">{{ c.b.lng }}, {{ c.b.lat }}</span>
            </div>
          </div>
          <div class="candidate-meta">
            <el-tag v-for="r in c.reasons" :key="r" size="small" effect="plain" class="mr6">{{ r }}</el-tag>
          </div>
          <div class="candidate-actions">
            <el-button size="small" type="primary" @click="openPair(c.a.id as number, c.b.id as number)">
              归并这两条
            </el-button>
          </div>
        </article>
      </div>
      <p v-else class="panel__hint">
        当前没有命中判定标准的候选营位对。若确认两条记录实为同一营位，可在下方手动指定。
      </p>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>手动指定两条营位</h2>
      </div>
      <div class="manual-row">
        <el-select v-model="manualA" placeholder="第一条营位" filterable style="width: 300px">
          <el-option v-for="opt in siteOptions" :key="`a-${opt.value}`" :label="opt.label" :value="opt.value" />
        </el-select>
        <span>⇄</span>
        <el-select v-model="manualB" placeholder="第二条营位" filterable style="width: 300px">
          <el-option v-for="opt in siteOptions" :key="`b-${opt.value}`" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button type="primary" plain @click="startManual">检查并归并</el-button>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>旧编号反查（后续导入）</h2>
        <span class="weight-note">归并后旧编号成为历史别名，导入数据引用旧编号仍能定位保留项</span>
      </div>
      <div class="manual-row">
        <el-input
          v-model="lookupCode"
          placeholder="输入旧编号，如 CS-0008"
          clearable
          style="width: 240px"
          @keyup.enter="lookup"
        />
        <el-button @click="lookup">查保留项</el-button>
        <span v-if="lookupMiss" class="muted">没有任何现行编号或历史别名匹配该编号。</span>
        <span v-else-if="lookupResult" class="lookup-hit">
          定位到保留项
          <el-link type="primary" underline="never" @click="openDetail(lookupResult.id)">
            {{ lookupResult.code }} · {{ lookupResult.name }}
          </el-link>
          <template v-if="lookupResult.aliases.length">
            （历史别名：{{ lookupResult.aliases.join('、') }}）
          </template>
        </span>
      </div>
    </section>

    <!-- ------------------------------ 归并确认对话框 ------------------------------ -->
    <el-dialog v-model="dialogVisible" title="确认归并营位" width="880px" top="6vh">
      <div v-if="plan && retainedSite && absorbedSite">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="先选择保留项，再逐项确认双方不一致字段的取值"
          description="多轮因子评估、风险否决记录会整单转入保留项，不丢任何一轮；无冲突的字段沿用保留项。"
          class="mb12"
        />

        <div class="retain-pick">
          <div
            class="retain-card"
            :class="{ 'is-active': retainedId === siteA?.id }"
            @click="siteA && chooseRetained(siteA.id as number)"
          >
            <el-radio :model-value="retainedId" :value="siteA?.id" @change="siteA && chooseRetained(siteA.id as number)">
              保留此项
            </el-radio>
            <strong>{{ siteA?.code }} · {{ siteA?.name }}</strong>
            <span class="muted">{{ siteA?.campName }} · 海拔 {{ siteA?.elevation }} m</span>
            <span class="muted">因子 {{ sideFactorCount(siteA?.id) }} 轮 · 否决 {{ sideVetoCount(siteA?.id) }} 条</span>
          </div>
          <div
            class="retain-card"
            :class="{ 'is-active': retainedId === siteB?.id }"
            @click="siteB && chooseRetained(siteB.id as number)"
          >
            <el-radio :model-value="retainedId" :value="siteB?.id" @change="siteB && chooseRetained(siteB.id as number)">
              保留此项
            </el-radio>
            <strong>{{ siteB?.code }} · {{ siteB?.name }}</strong>
            <span class="muted">{{ siteB?.campName }} · 海拔 {{ siteB?.elevation }} m</span>
            <span class="muted">因子 {{ sideFactorCount(siteB?.id) }} 轮 · 否决 {{ sideVetoCount(siteB?.id) }} 条</span>
          </div>
        </div>

        <el-divider content-position="left">
          冲突字段（{{ plan.conflicts.length }} 项，取值来源会记入保留项的归并留痕）
        </el-divider>

        <div v-if="plan.conflicts.length" class="conflict-bulk">
          批量取值：
          <el-button size="small" text @click="setAllSources('retained')">全部取保留项</el-button>
          <el-button size="small" text @click="setAllSources('absorbed')">全部取被吸收项</el-button>
        </div>

        <el-table v-if="plan.conflicts.length" :data="plan.conflicts" size="small" border class="mb12">
          <el-table-column prop="label" label="字段" width="140" />
          <el-table-column label="保留项取值" min-width="180">
            <template #default="{ row }">
              <span :class="{ 'picked': sourceOf(row.key) === 'retained' }">{{ row.retainedValue }}</span>
            </template>
          </el-table-column>
          <el-table-column label="被吸收项取值" min-width="180">
            <template #default="{ row }">
              <span :class="{ 'picked': sourceOf(row.key) === 'absorbed' }">{{ row.absorbedValue }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最终取自" width="170">
            <template #default="{ row }">
              <el-radio-group
                :model-value="sourceOf(row.key)"
                size="small"
                @change="(v: string | number | boolean | undefined) => onSourceChange(row.key, v)"
              >
                <el-radio-button value="retained">保留项</el-radio-button>
                <el-radio-button value="absorbed">被吸收</el-radio-button>
              </el-radio-group>
            </template>
          </el-table-column>
        </el-table>
        <p v-else class="panel__hint">双方基础字段完全一致，无需取舍。</p>

        <el-divider content-position="left">整单转入保留项的记录</el-divider>
        <div class="transfer-grid">
          <div class="transfer-item">
            <span>多轮因子评估</span>
            <strong>{{ plan.absorbedFactors.length }} 轮</strong>
            <span class="muted">
              日期：{{ plan.absorbedFactors.map((f) => f.assessedAt).join('、') || '无' }}
            </span>
          </div>
          <div class="transfer-item">
            <span>风险否决记录</span>
            <strong>{{ plan.absorbedVetos.length }} 条</strong>
            <span class="muted">
              类型：{{ plan.absorbedVetos.map((v) => v.type).join('、') || '无' }}
            </span>
          </div>
          <div class="transfer-item">
            <span>被吸收编号</span>
            <strong>{{ absorbedSite.code }}</strong>
            <span class="muted">归并后成为保留项历史别名</span>
          </div>
          <div class="transfer-item">
            <span>保留项已有</span>
            <strong>因子 {{ plan.retainedFactorCount }} 轮</strong>
            <span class="muted">否决 {{ plan.retainedVetoCount }} 条，均保留不动</span>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="merging" @click="confirmMerge">确认归并</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mb12 {
  margin-bottom: 12px;
}
.mr6 {
  margin-right: 6px;
}
.muted {
  color: var(--gb-muted);
  font-size: 12px;
}
.restore-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.candidate-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 12px;
}
.candidate-card {
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--gb-surface);
}
.candidate-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.candidate-distance {
  font-weight: 700;
  color: var(--gb-accent-strong);
  font-variant-numeric: tabular-nums;
}
.candidate-sides {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 10px;
  align-items: center;
}
.candidate-side {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.candidate-sub {
  font-size: 12px;
  color: var(--gb-muted);
}
.candidate-vs {
  color: var(--gb-muted);
}
.candidate-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.candidate-actions {
  display: flex;
  justify-content: flex-end;
}
.manual-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.lookup-hit {
  font-size: 13px;
}
.retain-pick {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.retain-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  cursor: pointer;
}
.retain-card.is-active {
  border-color: var(--gb-accent-strong);
  background: #eef6f0;
}
.conflict-bulk {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--gb-muted);
}
.picked {
  font-weight: 700;
  color: var(--gb-accent-strong);
}
.transfer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.transfer-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  background: var(--gb-surface);
  border-radius: 8px;
  font-size: 13px;
}
</style>
