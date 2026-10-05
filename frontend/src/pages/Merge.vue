<script setup lang="ts">
/**
 * `/merge` 营位归并 —— 检测重复登记的营位对（按距离、海拔、名称相似度），
 * 预览冲突字段并由用户选择取值来源，事务性执行归并。
 * 保留项接过被并项的因子与否决，被并项编号成为历史别名；失败回滚后可重试。
 * 消费 Campsite、FactorAssessment、RiskVeto、SiteMergeRecord。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSiteStore } from '@/stores/siteStore'
import { useUiStore } from '@/stores/uiStore'
import {
  DEFAULT_THRESHOLDS,
  aliasesOf,
  buildMergePreview,
  findMergeCandidates
} from '@/utils/merge'
import { formatDistance } from '@/utils/geo'
import { formatDateTime } from '@/utils/format'
import type { Campsite } from '@/types/campsite'
import type { MergeCandidate, MergeChoice, MergeConflictRow } from '@/types/merge'
import { MERGE_FIELDS } from '@/types/merge'

const router = useRouter()
const siteStore = useSiteStore()
const uiStore = useUiStore()

/* ------------------------------ 候选检测 ------------------------------ */

const candidates = computed<MergeCandidate[]>(() =>
  findMergeCandidates(siteStore.list, DEFAULT_THRESHOLDS)
)

const candidateThresholds = computed(() => DEFAULT_THRESHOLDS)

/* ------------------------------ 手动选择 ------------------------------ */

const manualKeptId = ref<number | null>(null)
const manualRemovedId = ref<number | null>(null)

const siteOptions = computed(() =>
  siteStore.list
    .filter((s): s is Campsite & { id: number } => typeof s.id === 'number')
    .map((s) => ({ value: s.id, label: `${s.code} · ${s.name}（${s.campName}）` }))
)

function useManualPair(): void {
  if (manualKeptId.value == null || manualRemovedId.value == null) {
    ElMessage.warning('请选择两个要归并的营位')
    return
  }
  if (manualKeptId.value === manualRemovedId.value) {
    ElMessage.warning('不能归并同一个营位')
    return
  }
  const kept = siteStore.byId(manualKeptId.value)
  const removed = siteStore.byId(manualRemovedId.value)
  if (!kept || !removed) return
  openPreview(kept, removed)
}

/* ------------------------------ 归并预览 ------------------------------ */

const previewVisible = ref(false)
const previewKept = ref<Campsite | null>(null)
const previewRemoved = ref<Campsite | null>(null)
const conflicts = ref<MergeConflictRow[]>([])
const movedFactorCount = ref(0)
const movedVetoCount = ref(0)
const choices = reactive<Record<string, MergeChoice>>({})
const operator = ref('')
const merging = ref(false)
const lastError = ref('')

function openPreview(kept: Campsite, removed: Campsite): void {
  previewKept.value = kept
  previewRemoved.value = removed
  const preview = buildMergePreview(kept, removed, siteStore.factors, uiStore.vetos)
  conflicts.value = preview.conflicts
  movedFactorCount.value = preview.movedFactorCount
  movedVetoCount.value = preview.movedVetoCount
  // 默认全部取保留项
  for (const c of conflicts.value) choices[c.field] = 'kept'
  lastError.value = ''
  previewVisible.value = true
}

function swapSides(): void {
  if (!previewKept.value || !previewRemoved.value) return
  const k = previewKept.value
  const r = previewRemoved.value
  openPreview(r, k)
}

function choose(field: string, choice: MergeChoice): void {
  choices[field] = choice
}

function conflictLabel(field: string): string {
  return MERGE_FIELDS.find((m) => m.key === field)?.label ?? field
}

function displayValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value)
    return value.toFixed(1)
  }
  return String(value)
}

async function confirmMerge(): Promise<void> {
  if (!previewKept.value || !previewRemoved.value) return
  merging.value = true
  lastError.value = ''
  try {
    const result = await siteStore.mergeSites(
      previewKept.value.id as number,
      previewRemoved.value.id as number,
      { ...choices },
      operator.value
    )
    if (result.success) {
      ElMessage.success(
        `归并完成：保留「${previewKept.value.code}」，转移因子 ${result.movedFactors ?? 0} 条、否决 ${result.movedVetoes ?? 0} 条`
      )
      previewVisible.value = false
      // 刷新否决记录与归并历史
      await uiStore.loadVetos()
      await loadMergeLogs()
    } else {
      lastError.value = result.error ?? '归并失败'
      ElMessage.error(`归并失败：${lastError.value}，已恢复原样，可重试`)
    }
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : String(err)
    ElMessage.error(`归并失败：${lastError.value}，已恢复原样，可重试`)
  } finally {
    merging.value = false
  }
}

/* ------------------------------ 归并历史 ------------------------------ */

const mergeLogs = ref<import('@/types/merge').SiteMergeRecord[]>([])

async function loadMergeLogs(): Promise<void> {
  const { db } = await import('@/utils/db')
  mergeLogs.value = await db.mergeLogs.orderBy('mergedAt').reverse().toArray()
}

function keptNameOf(log: import('@/types/merge').SiteMergeRecord): string {
  return siteStore.byId(log.keptSiteId)?.name ?? '—'
}

onMounted(() => {
  void loadMergeLogs()
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>营位归并</h1>
        <p>
          勘察队重复登记的同一营位（编号不同、坐标很近）会被检测出来。归并后保留项接过另一条的因子评估与否决记录，
          原编号成为历史别名，名次表与地图只展示保留项。归并在事务中执行，失败自动回滚并可重试。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/')">返回名次表</el-button>
      </div>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="候选判定依据"
      :description="`间距 ≤ ${candidateThresholds.maxDistance} m、海拔差 ≤ ${candidateThresholds.maxElevationDiff} m、名称相似度 ≥ ${candidateThresholds.minNameSimilarity}，命中任一即列为候选，按综合相似度排序。`"
    />

    <!-- 候选营位对 -->
    <section class="panel">
      <div class="panel__head">
        <h2>重复登记候选</h2>
        <span class="weight-note">共 {{ candidates.length }} 对候选</span>
      </div>

      <div v-if="candidates.length" class="candidate-list">
        <div v-for="(cand, idx) in candidates" :key="idx" class="candidate-card">
          <div class="candidate-card__sites">
            <div class="candidate-site">
              <strong>{{ cand.siteA.code }}</strong>
              <span>{{ cand.siteA.name }}</span>
              <small>{{ cand.siteA.campName }} · 海拔 {{ cand.siteA.elevation }} m</small>
            </div>
            <div class="candidate-card__vs">
              <el-tag type="warning" effect="plain" size="small">疑似同一营位</el-tag>
            </div>
            <div class="candidate-site">
              <strong>{{ cand.siteB.code }}</strong>
              <span>{{ cand.siteB.name }}</span>
              <small>{{ cand.siteB.campName }} · 海拔 {{ cand.siteB.elevation }} m</small>
            </div>
          </div>
          <div class="candidate-card__meta">
            <el-tag size="small" effect="plain">{{ formatDistance(cand.distanceMeters) }}</el-tag>
            <el-tag size="small" effect="plain">海拔差 {{ cand.elevationDiff.toFixed(0) }} m</el-tag>
            <el-tag size="small" effect="plain">名称相似度 {{ (cand.nameSimilarity * 100).toFixed(0) }}%</el-tag>
            <el-tag size="small" type="success">综合 {{ cand.score }} 分</el-tag>
          </div>
          <div class="candidate-card__reasons">
            <span v-for="r in cand.reasons" :key="r" class="reason-chip">{{ r }}</span>
          </div>
          <div class="candidate-card__actions">
            <el-button size="small" type="primary" @click="openPreview(cand.siteA, cand.siteB)">
              归并此对
            </el-button>
          </div>
        </div>
      </div>
      <el-empty v-else description="暂未检测到重复登记的营位对" :image-size="80" />
    </section>

    <!-- 手动选择 -->
    <section class="panel">
      <div class="panel__head">
        <h2>手动选择归并</h2>
        <span class="weight-note">未被自动检测到的重复营位可手动指定</span>
      </div>
      <div class="manual-row">
        <el-select
          v-model="manualKeptId"
          placeholder="保留项（归并后继续使用）"
          filterable
          style="width: 320px"
        >
          <el-option v-for="opt in siteOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <span class="manual-arrow">← 归并到 →</span>
        <el-select
          v-model="manualRemovedId"
          placeholder="被并项（编号成为历史别名）"
          filterable
          style="width: 320px"
        >
          <el-option v-for="opt in siteOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-button type="primary" plain @click="useManualPair">预览归并</el-button>
      </div>
    </section>

    <!-- 归并预览对话框 -->
    <el-dialog v-model="previewVisible" title="营位归并预览" width="780px" :close-on-click-modal="false">
      <div v-if="previewKept && previewRemoved" class="merge-preview">
        <el-alert
          v-if="lastError"
          type="error"
          show-icon
          :closable="false"
          title="上次归并失败，已恢复原样"
          :description="lastError + '。可调整后重试。'"
          style="margin-bottom: 12px"
        />

        <div class="merge-sides">
          <div class="merge-side merge-side--kept">
            <el-tag type="success" size="small">保留项</el-tag>
            <strong>{{ previewKept.code }}</strong>
            <span>{{ previewKept.name }}</span>
            <small>{{ previewKept.campName }} · 海拔 {{ previewKept.elevation }} m</small>
          </div>
          <div class="merge-swap">
            <el-button size="small" text @click="swapSides">↔ 交换</el-button>
          </div>
          <div class="merge-side merge-side--removed">
            <el-tag type="warning" size="small">被并项</el-tag>
            <strong>{{ previewRemoved.code }}</strong>
            <span>{{ previewRemoved.name }}</span>
            <small>{{ previewRemoved.campName }} · 海拔 {{ previewRemoved.elevation }} m</small>
          </div>
        </div>

        <el-divider content-position="left">冲突字段（选择保留值，来源已标注）</el-divider>

        <el-table :data="conflicts" size="small" border>
          <el-table-column label="字段" prop="label" width="120" />
          <el-table-column label="保留项取值" min-width="200">
            <template #default="{ row }">
              <el-radio
                :model-value="row.choice"
                value="kept"
                @change="choose(row.field, 'kept')"
              >
                <span class="choice-source">{{ previewKept.code }}</span>
                <span class="choice-value">{{ displayValue(row.keptValue) }}</span>
              </el-radio>
            </template>
          </el-table-column>
          <el-table-column label="被并项取值" min-width="200">
            <template #default="{ row }">
              <el-radio
                :model-value="row.choice"
                value="removed"
                @change="choose(row.field, 'removed')"
              >
                <span class="choice-source">{{ previewRemoved.code }}</span>
                <span class="choice-value">{{ displayValue(row.removedValue) }}</span>
              </el-radio>
            </template>
          </el-table-column>
        </el-table>
        <p v-if="!conflicts.length" class="panel__hint">两个营位的基础字段完全一致，无冲突需要选择。</p>

        <el-divider content-position="left">归并影响</el-divider>
        <ul class="merge-impact">
          <li>
            转移因子评估 <strong>{{ movedFactorCount }}</strong> 条、风险否决
            <strong>{{ movedVetoCount }}</strong> 条到保留项
          </li>
          <li>
            被并项编号 <strong>{{ previewRemoved.code }}</strong> 将成为保留项的历史别名
            <el-tag v-if="aliasesOf(previewKept).length" size="small" effect="plain" class="ml6">
              已有别名 {{ aliasesOf(previewKept).length }} 个
            </el-tag>
          </li>
          <li>归并后名次表与地图只展示保留项，被并项不再出现</li>
          <li>后续导入若引用被并项旧 id，将自动重定向到保留项</li>
        </ul>

        <el-form label-width="100px" style="margin-top: 12px">
          <el-form-item label="归并操作人">
            <el-input v-model="operator" placeholder="如 周勘" style="width: 200px" />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <el-button @click="previewVisible = false">取消</el-button>
        <el-button type="primary" :loading="merging" @click="confirmMerge">确认归并</el-button>
      </template>
    </el-dialog>

    <!-- 归并历史 -->
    <section class="panel">
      <div class="panel__head">
        <h2>归并历史</h2>
        <span class="weight-note">共 {{ mergeLogs.length }} 条记录</span>
      </div>
      <el-table v-if="mergeLogs.length" :data="mergeLogs" size="small" border stripe>
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.mergedAt) }}</template>
        </el-table-column>
        <el-table-column label="保留项" min-width="180">
          <template #default="{ row }">
            <el-link type="primary" underline="never" @click="router.push(`/sites/${row.keptSiteId}`)">
              {{ row.keptCode }} · {{ keptNameOf(row) }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="被并项编号" width="140">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.removedCode }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="removedName" label="被并项名称" min-width="160" />
        <el-table-column prop="operator" label="操作人" width="100" />
        <el-table-column prop="note" label="冲突处理说明" min-width="220" />
      </el-table>
      <el-empty v-else description="暂无归并记录" :image-size="60" />
    </section>
  </div>
</template>

<style scoped>
.candidate-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.candidate-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  background: var(--gb-surface);
  border: 1px solid var(--gb-line);
  border-radius: 10px;
}
.candidate-card__sites {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.candidate-site {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 200px;
}
.candidate-site strong {
  font-size: 15px;
  color: var(--gb-accent-strong);
}
.candidate-site span {
  font-size: 13px;
}
.candidate-site small {
  font-size: 11px;
  color: var(--gb-muted);
}
.candidate-card__vs {
  flex-shrink: 0;
}
.candidate-card__meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.candidate-card__reasons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.reason-chip {
  font-size: 11px;
  color: var(--gb-muted);
  background: #ffffff;
  border: 1px solid var(--gb-line);
  padding: 2px 8px;
  border-radius: 6px;
}
.candidate-card__actions {
  display: flex;
  justify-content: flex-end;
}
.manual-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.manual-arrow {
  font-size: 13px;
  color: var(--gb-muted);
}
.merge-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.merge-sides {
  display: flex;
  align-items: center;
  gap: 12px;
}
.merge-side {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--gb-line);
}
.merge-side--kept {
  background: #eef6f0;
  border-color: #bfe0c9;
}
.merge-side--removed {
  background: #fdf6ec;
  border-color: #f0d9a8;
}
.merge-side strong {
  font-size: 15px;
}
.merge-side span {
  font-size: 13px;
}
.merge-side small {
  font-size: 11px;
  color: var(--gb-muted);
}
.merge-swap {
  flex-shrink: 0;
}
.choice-source {
  font-size: 11px;
  color: var(--gb-muted);
  margin-right: 6px;
}
.choice-value {
  font-weight: 600;
}
.merge-impact {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--gb-ink);
}
.ml6 {
  margin-left: 6px;
}
</style>
