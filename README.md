# 露营营地选址评估器（gbcampsite）

面向营地规划者与户外领队：把候选营位的地形、补给与隐患折算成综合得分。地图选点登记营位，录入坡度、水源距离、风向、信号等因子，配置权重后实时重排名次并给出 A/B/C 等级。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21826>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21826 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`siteStore` / `profileStore` / `uiStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`），未配置时自动降级为本地 SVG 网格视图 |
| 本地数据 | IndexedDB（Dexie，`gbcampsite-db`，含版本号与升级迁移）+ localStorage（表单草稿、最近一次归并快照） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Campsite 营位 | `frontend/src/types/campsite.ts` | 营位编号、名称、所属营地、经纬度、海拔、坡度、坡向、地表类型、可容帐篷数、平整度评分、进出方式、默认方案、历史别名 `aliases` 与归并留痕 `mergeLogs` |
| FactorAssessment 因子评估 | `frontend/src/types/factor.ts` | 所属营位、水源距离、风向与风力等级、信号强度、日照时长、落石落枝风险、植被遮蔽度、离车距离、离步道距离、评估人、评估日期 |
| ScoreProfile 权重方案 | `frontend/src/types/score.ts` | 方案名、各因子权重（0-100）、归一化方式（极差归一 / 阈值分段）、A/B/C 等级阈值、适用季节、是否启用 |
| RiskVeto 风险否决项 | `frontend/src/types/veto.ts` | 营位 id、否决类型（河道内 / 山洪沟 / 孤树下 / 崖底落石区 / 陡坡）、说明、判定人、判定日期 |

### IndexedDB 版本与升级迁移

库名 `gbcampsite-db`（Dexie），共 4 张表：`sites`、`factors`、`profiles`、`vetos`。

- **v1**：建立 `sites`（营位）与 `factors`（因子评估）两张表。
- **v2**：新增 `profiles`（权重方案）表，并为 `factors` 补 `siteId` 索引，让「按营位取因子」走索引；同时为存量因子补齐 `shade`、`distanceToCar`、`distanceToTrail` 缺省值。
- **v3**：新增 `vetos`（风险否决）表，并为存量营位回填 `defaultProfileId`（取当前启用方案的 id）与新增字段缺省值。
- **v4**：为 `sites` 增加 `*aliases` 多值索引（历史别名编号）与 `mergeLogs`（归并留痕）字段；旧数据升级时自动补齐两个空数组，业务数据不变。归并后被吸收营位的旧编号写入保留项 `aliases`，后续导入凭旧编号仍能定位保留项。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 营位名次表（按综合得分降序，展示坡度、水源距离、信号与等级，可按营地/地表/进出方式筛选，命中否决项整行标红） | Campsite、FactorAssessment、RiskVeto |
| `/sites/new` | 新增营位（地图点选或手填经纬度，录入海拔、坡度、坡向与容量，支持草稿保存） | Campsite、FactorAssessment |
| `/sites/:id` | 营位详情（上部地图定位与基本信息，中部因子打分表，下部否决记录与多轮复核） | 四个模型 |
| `/scoring` | 权重与评分（拖动各因子权重条，名次实时刷新，可另存为季节方案） | ScoreProfile、Campsite |
| `/map` | 营位地图（高德 JS API 标记按等级着色，未配置 `VITE_AMAP_KEY` 时退化为本地 SVG 网格视图） | Campsite、RiskVeto |
| `/veto` | 风险否决登记（选营位与否决类型、填说明，提交后名次表与地图同步更新） | RiskVeto、Campsite |
| `/merge` | 营位归并（按距离/海拔/名称列候选，确认保留项与冲突取值，接管因子、否决、方案关系，可恢复两条原样并重试，支持旧编号反查） | 四个模型 |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `MapPanel.vue`（高德 + SVG 网格双模式）、`FactorScoreBar.vue`（原始值 / 归一化得分 / 权重占比）、`GradeBadge.vue`（A/B/C 等级与得分气泡）、`EmptyState.vue`（空态与新建入口）、`WeightEditor.vue`（权重条编辑器）
- hooks：`frontend/src/hooks/useAmapLoader.ts`（按需注入高德 JS API，key 缺省或加载失败返回降级标记）、`useRanking.ts`（归一化得分与名次）、`useLocalDraft.ts`（表单草稿）
- utils：`frontend/src/utils/score.ts`（极差归一、阈值分段、加权求和、等级阈值、否决短路）、`geo.ts`（经纬度距离与网格坐标换算）、`format.ts`（数值与日期格式化、流水编号）、`db.ts`（Dexie 封装、v1-v4 升级与样例数据）、`merge.ts`（营位归并：候选探测、冲突预演、事务归并、快照恢复、旧编号反查）、`draft.ts`（localStorage 草稿）

## 五之二、营位归并规则

勘察队重复登记同一营位时，在「营位归并」页处理，保证多轮因子、风险否决与评分方案关系不丢：

1. **列候选**：按坐标距离（默认 ≤ 60 m）、海拔差（≤ 25 m）、名称相似度（二元字组 Jaccard，≥ 34%；同营地不卡名称阈值）自动配对，也可手动指定任意两条。
2. **确认保留项**：两条记录任选其一为保留项；被吸收项的编号（含它自带的历史别名）追加到保留项 `aliases`。
3. **冲突讲清双方来源**：名称、坐标、海拔、坡度、坡向、地表、容量、平整度、进出方式、默认评分方案、备注等取值不一致的字段逐项选边（默认保留项，支持一键全取一方），最终取值与双方原值写入保留项 `mergeLogs`，详情页时间线可查。
4. **关系接管**：被吸收项的**全部多轮**因子评估与否决记录整单改挂保留项（不丢任何一轮）；默认评分方案关系随字段选择保留。
5. **原子性与可重试**：归并全程在单个 Dexie `rw` 事务内完成，任一步失败自动回滚为两条原样；归并前快照存于 localStorage（`gbcampsite:merge-backup:latest`），归并后仍可「恢复两条原样」，恢复后可重新归并。
6. **只展示保留项**：被吸收营位删除，名次表与地图自然只剩保留项；后续导入若仍引用旧编号，`resolveSiteByCode()` 先查现行 `code` 再查 `*aliases` 多值索引，仍能定位保留项。
7. 样例数据内置一对重复登记（CS-0007 / CS-0008，相距约 5 m，因子与否决分散在两条），首屏即可演练；逻辑测试见 `scripts/merge.test.ts`、升级测试见 `scripts/upgrade.test.ts`（`npm test`）。

## 六、地图降级说明

`VITE_AMAP_KEY` 为空时，`useAmapLoader()` **不会**请求 `webapi.amap.com`，而是立即返回降级标记；
`MapPanel` 随即渲染本地 SVG 网格视图（可点选、可查看详情），因此**构建与运行都不依赖该 key**。
若配置了 key，则注入脚本时带 `onerror` 与 8 秒超时双兜底，失败同样降级，不会产生 console error。

## 七、目录结构

```
sologsb-1126/
├── docker-compose.yml
├── .env / .env.example
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{campsite,factor,score,veto}.ts
        ├── stores/{siteStore,profileStore,uiStore}.ts
        ├── components/common/{MapPanel,FactorScoreBar,GradeBadge,EmptyState,WeightEditor}.vue
        ├── hooks/{useAmapLoader,useRanking,useLocalDraft}.ts
        ├── pages/{Ranking,SiteNew,SiteDetail,Scoring,MapView,Veto,Merge}.vue
        ├── router/index.ts
        ├── utils/{score,geo,format,db,merge,draft}.ts
        ├── scripts/{merge,upgrade}.test.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- 全部数据只存在浏览器本地：营位、因子评估、权重方案、否决记录存 **IndexedDB**（Dexie，库名 `gbcampsite-db`）。
- 表单草稿（新增营位、否决登记）存 **localStorage**，键前缀 `gbcampsite:draft:`，刷新或误关页面后可恢复。
- 容器完全无状态：不使用数据库服务、不挂载命名卷，清除浏览器站点数据即回到首次运行的样例营地。
