# 3D Studio Web 工作台 · 技术方案

| 项 | 内容 |
|---|---|
| 版本 | v1.4(T12 落地修订) |
| 日期 | 2026-07-07 |
| 上游文档 | 《PRD v0.93》 |
| 外部数据核实日 | 2026-07-06(Tripo/Meshy 官方文档、Cloudflare 官方文档) |

**v1.4 变更记录(T12 落地修订)**:① Turnstile widget 接线定稿:site key 走构建变量 `VITE_TURNSTILE_SITE_KEY`(Cloudflare 构建设置配置),缺位回退官方测试 key(与测试 secret 配对,零账号配置即全链路可走);widget 用 `appearance: interaction-only`(指令条内不常驻占位,仅需交互时浮现);token 单次使用——提交即 consume 并 reset 预取下一枚,过期由 expired-callback 自愈;「点提交但 token 未就绪」记 pending,token 回调到达后自动续提交(重试出路复用同机制)。② 刷新恢复(AI 边界 1)落地 = localStorage 活动任务票据(`{taskId, context, startedAt}`,仅 queued/running 持有)× mock 引擎无状态时间表:装载见票即恢复轮询并立即问一拍,未知/过期任务由服务端稳定收敛到 timeout+返还,客户端无需本地兜底超时。③ 自带 key 通道(D6 ④)前端面:key 仅存 sessionStorage,经 `apiHeaders()` 以 `x-engine-key` 透传;配额拦截(AI-07 提交前拦截)在 idle 态状态区呈现「明日再来 / 自带 API key」双出路。④ 「接受」在 T12 的语义 = 结果 GLB 送入 T10 导入管线(解析→单位→水密预检→贴床);AI-09 完整落入链(自动选中+聚焦+首检+R2 转存)仍归 T16,届时替换此调用点即可。

**v1.3 变更记录(T4 落地修订)**:① D4 统一任务协议补充可选字段 `queuePosition`(排队位置反馈,PRD AI-03 的服务侧供给);接口定稿:`submit` 接收路由层账务键(扣减先于提交,键必然先存在),引擎负责「引擎侧 taskId → 账务键」映射并以 `billingIdOf` 暴露——mock 内嵌进 taskId(零存储),Tripo 经 KV(T13,存储分工表既定)。② mock 引擎采用无状态时间表设计:排队/生成时长与结局在提交瞬间定案、编码进 taskId,查询按当前时间纯计算——零存储成本、跨 isolate 天然一致、页面刷新恢复轮询(AI 边界 1)免费获得;取消由路由层承接(账务返还 + 客户端停轮询)。③ 失败注入指令(`@mock:fail/queue/run/asset`)写入 prompt,T12 开发与演示可在零 credit 成本下确定性遍历 AI-05 三分类;三类失败时间线各异(moderation 排队即拒 / service 中途崩 / timeout 到点失败),供前端三出路做差异化体验。④ 返还的执行点统一在路由层(提交失败、轮询观察到失败、取消三处),幂等语义只有 quota-core ledger 一套。

**v1.2 变更记录(实现↔文档对账,Backlog「PRD 漂移检查」条款)**:① 全局熔断计数从 KV 收进配额 Durable Object——单实例串行化让「个人配额 + 全局预算」两笔账天然原子,且省去 dashboard 建 KV 命名空间的账号侧步骤;KV 的启用缓办至 T13(任务映射)。② 访客复合键的 M1 落地 = 客户端持久 ID(localStorage)+ IP 的 SHA-256 截断——完整浏览器指纹的投入产出比不成立,绕过风险由熔断层兜底(§8 风险表原判不变)。③ 配额日界定为 UTC 自然日,跨日整体翻转;跨日返还落空视为可接受损耗(返还发生在任务生命周期内,分钟级)。

---

## 1. 总体架构

```
浏览器(React + Three.js SPA)
  ├─ 渲染/编辑:Three.js 场景、gizmo、选择系统
  ├─ Web Worker ×2:文件解析(loaders)、打印检查(几何分析)
  ├─ IndexedDB:资产库、项目场景(PRD C5)
  └─ fetch → 服务层
服务层(Cloudflare Workers,单 Worker 多路由)
  ├─ /api/generate   任务提交(校验、配额扣减、转发引擎)
  ├─ /api/task/:id   任务查询(客户端驱动轮询的代理)
  ├─ /api/transfer   结果转存(引擎临时 URL → R2)
  ├─ /api/quota      配额查询
  ├─ Durable Object:访客配额计数、账务记录、全局熔断(强一致,v1.2)
  ├─ KV:任务映射(读多写少,可容忍最终一致;T13 启用)
  └─ R2:AI 生成结果持久化(GLB)
外部
  ├─ Tripo OpenAPI(M1 主引擎)
  └─ Meshy API(M2 第二引擎)
```

架构风格:**无长驻任务,客户端驱动轮询**。客户端按 PRD AI-04 的 5s/2s 分频轮询 `/api/task/:id`,Worker 每次被动查询引擎并透传。不用服务端定时器/队列消费者——Workers 的 CPU 计时不含 I/O 等待,转发型请求的实际 CPU 消耗为毫秒级,免费档即可承载 M1。

## 2. 关键技术决策(带依据)

**D1 服务层选 Cloudflare Workers + R2 + KV。** 依据:① CPU 计时排除 I/O 等待,轮询代理负载近零成本;② R2 出口流量免费——GLB 分发是本产品最大隐性成本项,按流量计费的平台(Vercel/Netlify)在这里结构性吃亏;③ 免费档(10 万请求/日,R2 10GB)覆盖 M1,付费档 $5/月封顶可预期。

**D2 生成引擎:M1 单接 Tripo,M2 增 Meshy 可切换。** Tripo 依据:credit 定价透明(图生带纹理 30 credits = $0.30/次,文生 $0.20/次),按量购买无月费门槛,300 免费 credits 覆盖开发调试,并发 10 足够单人产品。Meshy 定位从「备胎」升级为「打印特性差异化引擎」:其 API 具备 3MF 导出、多色打印(1–16 色,10 credits)与可打印性修复接口,但 API 要求 Pro 订阅($20/月)构成固定成本,故放 M2。

**D3 两条被外部约束证实的 PRD 设计。** Meshy API 生成结果非企业档仅保留 3 天即自动删除 → AST-05 云端转存为硬需求;Meshy API 禁止第三方站点 CORS → AI-02 服务层代理为硬需求。技术方案与 PRD 在此互为证据。

**D4 引擎抽象层(PRD AI-10 的实现)。** Worker 内定义统一任务协议:
`{ type: text|image, prompt/imageKey, options } → { taskId } → { status: queued|running|success|failed, progress, resultUrl, failReason: timeout|moderation|service }`
Tripo 映射:`text_to_model` / `image_to_model`(H3 版本,带纹理);`consumed_credit` 字段用于成本对账;错误码 2000(超并发)映射为对用户不可见的服务层排队重试(指数退避 + Retry-After),不占用用户失败分类。Meshy 映射同构,M2 实现。

**D5 STL 导出走客户端。** Three.js STLExporter 直接从场景写出二进制 STL(Z-up + mm 已是世界设定,零转换)。不用 Tripo 的付费 Conversion 任务(5–10 credits/次)——但记录其 `flatten_bottom` 能力于注释层,作为「服务端也有沉底概念」的佐证。

**D6 防滥用四层。** ① Cloudflare Turnstile(免费、无感)拦机器人于任务提交前;② 访客配额:浏览器指纹 + IP 复合键,3 次/日(见 §6 成本模型),计数与账务存 Durable Object——KV 为最终一致且无原子操作,并发读改写会产生配额双花,不得用于计数;③ 全局预算熔断:当日总消耗 credits 记于配额 Durable Object(v1.2:与个人配额同实例记账,原子且无双花),达上限(可配)后全站生成入口降级为「今日额度已用完 + 自带 key」;④ 自带 key 通道:用户 key 仅存 sessionStorage、每请求透传、服务层不落盘;⑤ 演示码:URL 携带的提升配额令牌(如 20 次/日),供面试与演示链接使用,服务层可逐码撤销——防御机制不应卡住最高价值访客。

## 3. 前端工程

- **栈**:React 18 + TypeScript + Vite;Three.js(r16x)+ @react-three/fiber 承载视口,drei 提供 TransformControls/相机控制的基础件(按 PRD VIEW-02 重映射鼠标)。
- **状态**:Zustand 三个 store——场景(实例/组/选中集,单一事实源)、历史(command 栈)、任务(生成状态机)。历史栈实现为 command pattern(PRD HIST-02),store 变更一律经 command 派发,禁止旁路 setState 修改场景。旋转以欧拉角(固定 XYZ 序)为源数据,gizmo 旋转增量直接作用于欧拉,禁止从变换矩阵反解回写(等价角多解会造成面板数值跳变)。
- **Worker 化**:`parse.worker.ts`(GLTFLoader/STLLoader/OBJLoader + 单位推断 + 水密性预检)、`check.worker.ts`(打印检查,PRD CHK-04 的资产级/实例级分层)。几何以 Transferable ArrayBuffer 传递,避免结构化克隆开销。
- **水密性算法**:**前置顶点焊接**(按距离 ε 合并重复顶点重建索引)后,再以半边结构统计边的相邻面数,存在邻面数 ≠ 2 的边即非水密。焊接不可省略:STL 格式按定义逐三角形独立存储顶点,AI 生成网格亦常见重复顶点,不焊接将导致全量误报。退化面按面积 < ε 判定。悬垂热图(M2)以面法线与 Z 轴夹角 > 45° 着色。
- **持久化**:IndexedDB 经 idb 封装;资产几何存 ArrayBuffer,项目存 JSON(PRD §8 数据结构)。

## 4. 服务层接口设计

| 端点 | 方法 | 职责 | 失败语义 |
|---|---|---|---|
| /api/generate | POST | Turnstile 验证 → 配额检查扣减(Durable Object 强一致)→ 引擎提交 → 返回 taskId | 配额不足 = 提交前拦截(PRD AI-07);引擎侧异常 = 返还并报 service 类失败 |
| /api/task/:id | GET | 代理查询引擎任务;success 时附带触发转存 | 引擎 404/过期 → 按 timeout 类处理并返还 |
| /api/transfer | 内部 | 拉取引擎临时 URL → 写 R2 → 返回永久 URL | 失败标「未备份」,前端后台重试(PRD AI 边界 2) |
| /api/quota | GET | 返回访客剩余配额与全局熔断状态 | — |

**配额账务与 PRD AI-07 的映射**:扣减记录 `{visitorKey, taskId, credits, state: charged|refunded}` 写入配额 Durable Object(单对象串行化保证幂等:重复返还请求无副作用);日终以 Tripo `consumed_credit` 对账,差异报警。

**密钥管理**:引擎 key 存 Workers Secrets;自带 key 模式下请求头透传,Worker 不写任何存储。

## 5. 存储分工(PRD C5 的落地)

| 层 | 技术 | 内容 | 生命周期 |
|---|---|---|---|
| 运行内存 | Zustand | 历史栈、选中态 | 刷新即清 |
| 本地 | IndexedDB | 资产库(≤500MB)、项目 | 跨会话 |
| 云端 | R2 | AI 生成 GLB 转存 | 30 天过期清理(Worker Cron) |
| 云端 | Durable Object | 配额计数、账务记录 | 计数按日翻转(UTC 日界) |
| 云端 | Durable Object(同上) | 全局熔断计数(v1.2 自 KV 移入) | 按日翻转 |
| 云端 | KV | 任务映射(T13 启用) | 24h TTL |

R2 成本核算:单模型 GLB 约 5–30MB,免费档 10GB ≈ 500–2000 个模型;写入属 Class A(免费档 100 万次/月,远超需求)。出口流量免费使「资产恢复回源」无成本压力。

## 6. 成本模型(回填 PRD §9)

| 项 | 数值 | 依据 |
|---|---|---|
| 单次生成成本上限 | $0.30(图生带纹理)/ $0.20(文生) | Tripo 官方 credit 价,核实于 2026-07-06 |
| 访客配额 | 3 次/日 → 单访客日成本上限 $0.90 | 建议值,PRD §9 回填 |
| 全局熔断 | 100 次/日(= 上限 $30/日,可配) | 预算保护 |
| 平台固定成本 | $0(M1 免费档)→ $5/月(放量后) | Cloudflare 定价 |
| M2 增量 | Meshy Pro $20/月(含 1000 credits) | 决定接入时点再评估 |

## 7. 部署与环境

Cloudflare Pages 托管 SPA(静态资源免费不限量),同账号绑定 Worker 与 R2/KV;`dev / production` 双环境,Secrets 分离;wrangler 一键部署。前端构建产物含两个 Worker bundle,总包体预算 < 3MB(Three.js tree-shaking + loader 按需)。

## 8. 风险与备选

| 风险 | 概率 | 应对 |
|---|---|---|
| Tripo 定价/接口变动(赛道半年一轮) | 高 | 引擎抽象层隔离;consumed_credit 对账及时暴露价差 |
| 免费 credits 耗尽于开发期 | 中 | 开发期用 mock 引擎(抽象层的免费红利),真实调用留给联调与演示录制 |
| 浏览器指纹配额被绕过 | 中 | 接受——熔断层兜底,损失上限 = 日预算 |
| 大 GLB 解析内存峰值 | 中 | Worker 内流式解析 + 面数上限前置拦截(IMP-03) |
| R2/KV 免费额度突破 | 低 | 用量告警;升级 $5 档即解 |

## 9. PRD 待校准参数回填

| PRD §9 参数 | 回填值 |
|---|---|
| 访客生成配额 | 3 次/日(单价 $0.20–0.30/次已核实) |
| 其余参数 | 维持「待校准」,进入开发后按基准测试回填 |
