# 3D Studio Web 工作台 · 技术方案

| 项 | 内容 |
|---|---|
| 版本 | v2.6(真实平面截面证据) |
| 日期 | 2026-07-23 |
| 上游文档 | 《PRD v0.95》 |
| 外部数据核实日 | 2026-07-20(Tripo 官方 Upload / Generation 文档) |

**v2.6 变更记录(M1.7.6 真实平面截面证据)**:① **按实例世界变换求真实交线**——`analyzePlaneSection` 读取本地 `BufferGeometry` 的 position/index 和实例 TRS，把每个被扫描三角形变换到世界坐标后与当前轴向平面求交；线段做容差去重并以亮黄色覆盖在 GPU A/B 预览之上，顶点和截线不上传 Agent 或 Worker。② **闭合图与面积 fail-closed**——截线端点量化成无向图，仅当完整扫描、所有连通分量节点度为 2、无分叉、无共面三角形且至少形成一个闭合环时，才按切面二维投影和奇偶嵌套计算净面积；开链、空截面、共面歧义和部分扫描一律 `areaMm2=null`。③ **双预算保护**——默认最多扫描 120,000 面、保留 24,000 条唯一截线；超预算采用均匀面片抽样，只显示部分证据并明确“轮廓与面积不下结论”，不允许偶然闭环升级成完整结果。④ **拖动响应分层**——滑杆事件立即刷新切面位置、A/B 包围盒和入床结论，真实截面扫描延后 90ms 且同轴重复事件会取消旧任务；25/50/75 快捷点仍立即扫描，避免高面数模型每 1% 阻塞 UI。⑤ **权限边界不变**——截面、环数、周长和面积都是只读证据；仍不分类/切开三角形、不生成截面新顶点拓扑、不封口、不创建派生资产或写历史。

**v2.5 变更记录(M1.7.5 可调平面切割位置)**:① **同一确定性内核支持任意偏移**——`evaluatePlaneCutCandidate` 将用户位置限制在 10%–90%，每次即时重算世界切面、A/B 包围盒尺寸、床适配、剩余超限轴、评分与说明；不调用 API、不消耗 token。② **可放入区间显式化**——在其余两轴已适配且目标轴长度不超过床长两倍时，纯函数求出“切后两侧都能入床”的归一化区间；300mm 模型在 256mm 床的 X 轴区间显示为 15%–85%，Y/Z 则明确显示无单切可行区间。③ **每轴独立保留临时位置**——切换 X/Y/Z 只替换当前轴候选；返回某轴时保留该轴上次调整，不重置用户比较过程。④ **实时预览仍零写入**——滑杆、25/50/75 快捷位置和候选切换仅更新 PreviewStore；GPU clipping plane 与 A/B 标签同步移动，`SceneDocument.editVersion`、几何、资产和历史不变。⑤ **能力边界不变**——预览仍基于 AABB 和视觉裁剪，不计算真实截面、封口、结构强度或装配连接，不产出可导出零件。

**v2.4 变更记录(M1.7.4 平面切割候选只读预览)**:① **候选先由确定性代码生成**——`findPlaneCutCandidates` 只读取新鲜 `dims.world` 与当前打印床，沿世界 X/Y/Z 中线分别切分 AABB；两侧尺寸、床适配、剩余超限轴和切面面积代理值均为纯函数结果，不调用 API、不消耗 token。评分优先“切后两侧均可入床”和“缩短原超限轴”，固定落在 0–100。② **只读 PreviewStore**——预览状态独立保存候选、索引、源 `editVersion` 与床配置；场景编辑、床变化或实例删除后立即失效。开启、切换和关闭只改变选择、相机与临时状态，历史和几何均不变。③ **GPU 双侧裁剪呈现**——同一源几何以相反 clipping plane 渲染青/紫两侧，琥珀半透明平面标出当前切面，原实例降透明作为上下文；这是视觉裁剪，不计算真实交线、不封口、不生成闭合零件或派生资产。④ **AI 建议接上本地动作**——有新鲜单壳超床证据时，AI 结果页的当前方案、行动中心和 `find_cut_candidates` / `preview_plane_cut` 步骤卡可以显式打开本地候选预览；模型仍不能调用写工具或直接修改场景。⑤ **稳定 QA 与持久化边界**——`?qa=plane-cut-preview` 用 300×80×80mm 封闭盒验证 X 中切可入床、Y/Z 仍超床和历史 `0/0`；`ast_qa_*` 与 `ast_demo_*` 一样不进入 IndexedDB，避免测试夹具刷新后因持久化重建污染几何。

**v2.3 变更记录(M1.7.3 连通壳拆件只读预览)**:① **复用并查集结果，不重复跑几何**——`componentsOf` 已算出的共享边连通分量直接生成 `ConnectedComponentEvidence`，保留原始 0-based 面片索引、壳面数、闭合状态、局部包围盒和主体/独立壳/内部壳/疑似碎片分类。② **双预算证据载荷**——完整连通壳分析仍以 250,000 面为上限；主线程只接收前 24 壳、总计最多 120,000 个预览面索引，按剩余壳公平分配并均匀抽样。`componentEvidenceComplete=false` 时 UI 明示“预算内抽样预览”，但 `connectedComponents` 仍是完整统计。③ **基于原几何的只读派生显示**——主线程从 `geometryRegistry` 按面索引临时构造各壳渲染几何，使用琥珀/青/紫/绿循环色板；当前壳穿透高亮、亮框和标签显示，临时 BufferGeometry 卸载时主动 dispose。④ **整体→局部的相机节奏**——首次进入先对整个实例 fit，展示各壳关系；上一件/下一件才按壳世界包围盒聚焦，并额外保留 60% 观察余量。循环浏览只更新 `activeEvidenceIndex`、选择与相机，历史和 `editVersion` 不变。⑤ **安全边界**——该能力只预览“现有断开壳可视为候选零件”，不真的拆分、不自动命名、不写派生资产；Agent 输入仍只发送壳数量摘要。`?qa=component-preview` 用单资产三封闭壳自动检查并进入预览，普通示例与 Gold Set 不变。

**v2.2 变更记录(M1.7.2 自交局部证据定位)**:① **有限证据载荷**——自交窄相位命中时记录原始 1-based 面片编号和两组三角形资产局部坐标；总命中仍最多 200 组，但只保留前 24 组可视证据，防止 Worker→主线程结构化克隆随模型复杂度无限增长。② **实例级只读呈现**——证据继续挂在资产健康元数据上复用；视口按实例 TRS 变换当前三角形对，红色表示面 A、蓝色表示面 B，并用穿透材质、边线、中心标记和面号标签显示。自交模式隐藏全模型红壳，避免遮挡局部证据。③ **局部相机命令**——相机总线新增 `focusBounds`，由两片三角形的世界包围盒驱动透视/正交同源 fit；上一组/下一组循环浏览只更新 `activeEvidenceIndex` 和相机，不写 `SceneDocument`、`editVersion` 或历史。④ **稳定 QA 入口**——`?qa=self-intersection` 加载三片三角形、两组确定命中的独立场景并自动检查；普通五对象示例和 Agent Gold Set 不变。⑤ **Agent 最小披露**——拆件输入仍只包含自交计数、完整状态等摘要，不发送局部坐标，既控制 token/隐私面，也保持阶段一只读权限。

**v2.1 变更记录(M1.7.1 深度网格诊断与修复差异)**:① **资产级只读健康分析**——`mesh-health-core.ts` 在既有检查 Worker 内计算面连通分量、闭合壳、疑似内部壳、小型孤立碎片和不相邻三角形自交；结果随资产缓存复用，实例变换不重复计算。② **深度检测预算显式化**——连通壳完整分析上限 250,000 面；自交最多扫描 60,000 个三角形、测试 500,000 个候选对并记录 200 个命中；使用 X 轴 sweep-and-prune 包围盒粗筛后再做非共面线段/三角形与共面二维重叠测试。任一预算触顶即返回不完整状态，UI 报“部分检测”，不允许把零命中表述为无自交。超大网格只焊接被抽样面引用的顶点，避免第二次全量拓扑副本导致内存峰值。③ **内部壳与碎片是疑似证据**——有效三角形按共享边并查集分量；闭合候选先做严格包围盒包含，再用非轴对齐射线奇偶测试确认采样点在外壳内；小分量按相对面数/尺度标记孤立碎片，二者都只读且文案保留设计意图不确定性。④ **差异几何双通道**——修复计划除 `addedPositions` 外新增 `removedPositions`，Worker 以 Transferable 回传；视口支持修复后半透明叠加与仅看变化，新增面亮绿、删除面亮红，模式切换只改临时 Zustand 状态，不进入历史。⑤ **Agent 仍只读**——新健康证据进入 split-analysis 输入 schema，但没有新增任何写工具或权限。

**v2.0 变更记录(M1.7 确定性网格修复)**:① **先预览、再派生，不原位改几何**——打印检查的非水密/退化条目触发独立临时预览，预览不写 `SceneDocument` 与历史；用户确认后 `replaceInstanceAssetWithDerived` 在同一 command 中创建派生资产并切换实例引用，`capture` 同时覆盖实例与新资产，因此 undo/redo 能原子恢复。原始资产始终保留。② **修复内核 fail-closed**——复用检查器焊接容差，删除塌缩/零面积/重复面，只对方向一致、≤128 顶点、近似共面的简单边界环做三角化；结果必须重新通过水密、非流形边和非零体积验证。非流形、开放链、分叉、绕序冲突、非平面孔洞和不稳定体积均不产出结果。该算法不检测或修复任意自交、内部壳与复杂布尔残片，UI/版本记录不得把“拓扑水密”表述为“几何完全健康”。③ **第三个几何 Worker**——`mesh-repair.worker.ts` 接收位置/索引 Transferable，在后台运行清理、边界分析、三角化和验证；45 秒超时即 terminate，原模型零副作用。主线程只负责构建预览 BufferGeometry、亮显新增面和提交派生资产。④ **确认后自动复检**——新几何注册与缩略图生成完成后启动同源 `runPrintCheck`，结果面板、树黄标和导出闸门共享新报告；修复本身仅一条 `fix` 历史。⑤ **安全边界显式进入产品**——预览卡同时展示前后面数、开放边、退化面、动作与“开口可能是设计意图”提示；场景 editVersion 或实例 assetId 变化会让确认失效。

**v1.9 变更记录(M1.5.3 图生模型)**:① **图片随 `/api/generate` multipart 一次上行**——浏览器不直连 Tripo、不持有服务 key，也不新增公开上传代理；Worker 在格式、大小、数量、正面必填、Turnstile 与配额检查全部通过后，才把图片转发至 Tripo `/upload/sts` 获取 `image_token`，上传或任务提交失败统一走 AI-07 返还。② **协议扩为 `text | image | multiview`，状态机不分叉**——单图映射 `image_to_model`；多图 UI 暂定正面/左侧/右侧三槽，服务端按 Tripo 要求组装四项 `[front,left,back,right]`，back 以空对象占位，至少两张且 front 不可缺。任务提交后的排队、轮询、失败、取消、结果代理、接受与 T16 落入完全复用。③ **双层校验**——前端即时校验提升反馈速度，Worker 以 PNG/JPEG/WebP、单张 10MB、单图 1 张、多图 2–3 张为安全边界；校验位于 Turnstile 和扣减之前。④ **本地文件不持久化**——活动票据只保存图片名称/大小/MIME/视角元数据，刷新可恢复已提交任务轮询，但调整或重试需要用户重新选择本地文件，避免把图片二进制塞进 localStorage。⑤ **Tripo 上传 multipart 不手写 `content-type`**，由运行时生成 boundary；图片上传与任务提交均复用服务 key/自带 key，并对 2000/5xx 做既有退避重试。

**v1.8 变更记录(T16 落地修订,AI 落入汇聚)**:① **接受结果不另造 AI 解析管线,以 `ImportOptions` 扩展 T10/T11 同源入口**——`startAiLanding` 仍把 GLB 交给 `startImport → parse.worker → finalize`,单位烘焙、拓扑预检、缩略图、几何注册表与 IndexedDB 对账全部复用;只显式携带 `source=ai`、生成上下文与落场完成回调。选择复用而非复制的原因:一旦 AI 与本地导入各有一套 finalize,单位/水密/持久化修复会出现双点维护,最容易让「站内检查的资产」和「实际落场资产」口径漂移。② **整段只有一次文档写入(HIST-05/C1)**——`finalize` 先入资产(库操作不入场景历史),再以既有 `placeInstance` 一次提交根层级实例,位置直接取 `[0,0,-bbox.minZ]` 完成床中心+沉底,该命令本身自动选中,历史类型使用预留的 `aiPlace`/「AI 生成落入」;聚焦、首检和 toast 均为只读/UI 效果,不拆出第二条历史。撤销闭包只捕获实例、不含资产,因此撤销后 AI 资产与生成参数继续保留,无需特殊栈手术。③ **聚焦与首检按各自生命周期接线**——聚焦延后一帧发送,因为 dispatch 后 React/R3F 尚需一次 commit 才把新 mesh 注册进 `meshRegistry`,同帧 focus 会退化为对床聚焦;首检直接复用 T14 的 `runPrintCheck`,若 Worker 正忙则订阅检查 store,旧轮收尾后再发全量新轮(旧轮开始时尚无 AI 实例且会被 editVersion 判过期,不能把「搭上旧轮」等同首检)。④ **资产 provenance 完整落库**——AI 资产记录 prompt、生成类型、taskId 与运行时引擎名,沿 T11 对账同步器持久化;接受按钮加同步 ref 锁与「落入中」态,防双击并发下载造成重复资产/实例。⑤ **范围裁剪保持显式**——AST-05/R2 转存与「未备份」后台重试随 T13b 一并外移,本次不以假状态占位;现阶段同源结果代理负责下载,本地 IndexedDB 负责已接受资产保留,恢复 T13b 时在资产 provenance/完成回调上增量接线,不改落场原子性。

**v1.7 变更记录(T15 落地修订,STL 导出)**:① **D5 落地修订:写出器弃 STLExporter,改用与检查器同源的 composeTRS 逐顶点直写**——「客户端导出、零转换、零 credit」的 D5 本体不变,变的是实现载体。论证:检查器(v1.6 ②)已用 composeTRS 逐顶点求世界几何,导出复用同一构造路径 = **检查报告度量的世界几何与导出文件字节严格同口径**(检查说 zMin=0 的对象,导出后在切片软件里就贴在 z=0);顺带修掉 STLExporter 不覆盖的两个坑:**负缩放(镜像)按矩阵行列式判定并交换 v1/v2 绕序**,否则镜像件导出后法向内翻、切片软件视为内外反转;**二进制头部不以 "solid" 开头**(部分解析器以此嗅探 ASCII 格式,误判后读崩),头部同时声明 units: mm · Z-up。facet normal 由世界顶点叉积重算(变换后局部法线失效),退化面写零法线不产 NaN(STL 规范允许,切片器自行重算)。② **逐对象 zip = 手写 STORE 法 PKZIP(约 80 行,零依赖)**——STL 打包不值得为压缩率引一个压缩库依赖;条目名带 UTF-8 标志位(bit 11)保中文对象名跨平台可读;固定时间戳(2026-01-01)使同输入产出字节完全一致,单测以独立解析器回读对拍(签名/条目数/CRC32/偏移自洽,CRC32 过标准测试向量)。③ **导出闸门语义(CHK-02 自动触发分支定稿)**——报告新鲜(phase=done 且 editVersion+床与检查时刻一致)直接复用不重跑;过期/缺失则自动发起一轮**与手动完全同源**的检查(结果面板、树黄标照常更新——导出触发的检查不是私有旁路);检查已在跑则搭现车等结果。「返回」以令牌作废闸门回调,检查本身照常跑完入面板。④ **确认框三类如实列明(CHK-08/C4)**——导出集内错误级条目 + 超时未检对象(不假装成功)+ 范围排除名单(边界 4:仅选中含隐藏/未就绪),任一非空即弹确认,确认后放行,**绝不禁用导出**;错误只挂在导出集外(如隐藏对象)不触发确认。⑤ **导出不入栈(C1 第三类)由测试钉死**:全流程 editVersion 与历史栈长度零变化。⑥ **锁定可导出**——锁定 = 视口不可变换,不是不可导出(C7 三状态正交),导出范围只看有效可见性与资产就绪。

**v1.6 变更记录(T14 落地修订,打印检查)**:① **`editVersion` 作为过期信号源(CHK-03)**——`SceneDocument` 增单调计数 `editVersion`,经 `HistoryManager.bindOnChange` 在 push(常规/合并)/undo/redo 时递增,`hydrate` 手动递增;**选中与相机不递增**,与 C1 的「编辑」定义严格同口径(检查结果只应因几何/位置变化而过期,不因视图操作抖动)。过期判定 `isReportStale` 复合 editVersion + 床配置三轴——改床尺寸会令「床外」结论失真,故床变化亦过期。② **逐顶点精确世界包围盒**——实例级检查在 Worker 内以 `composeTRS`(`THREE.Matrix4.compose`,与 gizmo-math 同构造路径保证欧拉 XYZ 口径一致)对每个顶点变换求真实世界 zMin/包围盒,**替代内核 dropToBed 的 bbox 角点近似**;旋转体的 bbox 角点会外扩虚报更低的 zMin,逐顶点法才能让悬空判定与沉底修复不过冲(`check-core.test.ts` 用斜置八面体证明二者差异)。手写矩阵乘避免百万级 Vector3 分配。③ **Worker 常驻复用 + 资产级缓存(CHK-04/C2)**——检查 Worker 生命周期内缓存 `assetId→{positions, topo}`,几何只在首次需要时经 Transferable 传输(runner 侧 `sentAssets` 去重),后续轮次只传 id;资产级属性(水密/退化/面数)一次分析缓存,实例级属性(床外/悬空/微小/尺寸)随变换重算。验收样例「1 资产 × 6 实例 → 分析 1 次」即此分层的可观测证据(汇总行 + Console 日志)。超时 `terminate` 后缓存随实例销毁,`sentAssets` 同步清空,重试轮自动重传。④ **超时按未完成呈现(CHK-02)**——`CheckRunner` 30s 超时(`CHECK_TIMEOUT_MS`,可注入)处决 Worker、保留已流回的逐实例部分结果、未检对象列入 `unfinished` 供分对象重试(边界 5「不假装成功」);Worker `onerror` 崩溃同路径收口。逐实例流式返回是「部分结果保留」的前提。⑤ **修复后语义 = 编辑 → 过期(CHK-03 同规则)**——确定性修复(悬空沉底 / 超床 clamp 回最近合法位)本身是一次入栈编辑,触发 editVersion 递增 → 整份报告过期;条目额外标「已执行修复」承接验收样例的可读性,`fixedKeys` 新一轮清空。新增 OpKind `'fix'`(🩹 修复)入 history-labels 权威表;内核加 `nudgeInstances`(平移增量,超床修复用)与 `dropToBed` 可选 label 参数。⑥ **树黄标只在新鲜报告亮(CHK-05)**——`flaggedIds` 派生带错误/警告的实例及其祖先组链,过期即熄灭(黄标承诺「当前场景确有此问题」,过期后承诺失效);锁定对象可检查但修复禁用(C7),点击其条目只聚焦不选中。⑦ **纯前端零 credit**——检查全程在浏览器 Worker,不碰服务层与 Tripo;非水密边界边描红线段在资产首次分析时采集(`parse-core` 的 `collectBoundarySegments`,上限 `MAX_HIGHLIGHT_SEGMENTS=4000`)回传主线程 `edgeRegistry` 供高亮,随实例变换渲染。阈值 `FLOATING_MM=0.5` / `TINY_MM=2` 待上线对照切片软件默认值校准(§9)。

**v1.5 变更记录(T13a 落地修订,真实 Tripo 接入)**:① **状态映射定稿**:上游 8 态 → 协议 4 态——`queued/running` 同名透传(`queuing_num`→queuePosition、progress),`success`→success,`banned`→failed/moderation,`failed`→failed/service(error_code/msg 入日志),`cancelled|unknown|expired` 及未来新值→failed/timeout(接口契约既定);另按 `create_time` 计龄,排队/生成超过 `TRIPO_TIMEOUT_MS`(默认 10 分钟)合成 timeout 失败并返还。② **事实修正:上游无取消端点**(2026-07 核实,官方 SDK 与 OpenAPI schema 均无)——D4 原设想「真实引擎调上游取消接口」不成立;取消语义与 mock 一致 = 路由层返还 + 客户端停轮询,**上游任务将跑完并消耗 credit**,该差额计入 consumed_credit 对账口径(产品承诺 AI-06 优先于成本回收)。③ **任务映射改存配额 Durable Object(mapPut/mapGet),KV 退出存储分工表**——论证:零新增绑定与 dashboard 步骤(Git 集成一键部署链不动);M1 量级(≤ 数百条/日)远低于单 DO 吞吐;且服务端权威配对**防「伪造 taskId 骗返还」**——mock 把账务键编码进 taskId 是零成本下的正当简化,真实计费下客户端可控的配对即攻击面。映射保留 48h 惰性剪枝(账本按日翻转,跨两日已无账可退)。自带 key 任务无账务不写映射。④ **结果代理路由 `/api/task/:id/result` 落地 D3 的 AI-02 硬需求**:上游预签名地址会过期且 CORS 姿态不可控,success 的 resultUrl 一律指向服务层同源代理,现查上游取新鲜地址流式转发——前端 fetch 与 T10 导入管线零改动,T13b(R2 转存)外移不受影响。⑤ **2000 超并发 = 请求内指数退避**(0.8s/1.6s 共 3 次尝试,对用户不可见,不占失败三分类);HTTP 5xx 同策略;业务错误码不重试即抛,路由层按 AI-07 返还。⑥ **prompt 上限由引擎上报**(接口新增可选 `promptMaxLength`):Tripo 上游硬限 1024 < 服务层默认 2000,校验层如实前移拦截,不走「扣减→上游打回→返还」的冤枉路。`@mock:` 演练指令在真实提交前剥离。⑦ **consumed_credit 对账**:成功观察时记 `[reconcile]` 日志(上游实耗 vs CREDITS_BY_TYPE 计费常量),价差与取消差额靠日志暴露(§9 风险表既定);查询遇上游 5xx/鉴权失败按瞬时故障抛 502(客户端续轮询),不伪装成任务失败去触发返还。⑧ 诊断面板演练在真实引擎下禁用(@mock 注入不生效、20 秒收敛窗对分钟级真实生成必然超时、白耗 credits);真实链验收走生成面板主链。引擎切换以 wrangler.jsonc 为准(Git 部署会覆盖 dashboard 改的 vars,Secrets 不受影响),回退 mock = 改一个 var 后 push。⑨(fix1)health 的 config 增加 `promptMax`(引擎上报值),前端计数器与即时校验以此为运行时数据源,写死常量降级为离线兜底;提交失败路径补齐可诊断性——路由层 `[submit-fail]` 日志记原因全文,响应消息附脱敏摘要并对 key 缺位 / 401·403 做人话分类(线上首验即暴露:catch 吞错时,连 Live logs 都无从定位)。⑩(fix2)TripoEngine 默认 fetch 改为 `fetch.bind(globalThis)`——`this.fetchImpl(...)` 的属性访问把引擎实例作为 this 传给全局 fetch,workerd 抛 Illegal invocation;单测注入桩不校验 this,全绿仍漏网,由 fix1 的原因外显在线上定位。教训入档:凡包装平台内置函数(fetch/caches/crypto)必须 bind 或箭头包裹,并配 this 断言回归测试。

**v1.4 变更记录(T12 落地修订)**:① Turnstile widget 接线定稿:site key 走构建变量 `VITE_TURNSTILE_SITE_KEY`(Cloudflare 构建设置配置),缺位回退官方测试 key(与测试 secret 配对,零账号配置即全链路可走);widget 用 `appearance: interaction-only`(指令条内不常驻占位,仅需交互时浮现);token 单次使用——提交即 consume 并 reset 预取下一枚,过期由 expired-callback 自愈;「点提交但 token 未就绪」记 pending,token 回调到达后自动续提交(重试出路复用同机制)。② 刷新恢复(AI 边界 1)落地 = localStorage 活动任务票据(`{taskId, context, startedAt}`,仅 queued/running 持有)× mock 引擎无状态时间表:装载见票即恢复轮询并立即问一拍,未知/过期任务由服务端稳定收敛到 timeout+返还,客户端无需本地兜底超时。③ 自带 key 通道(D6 ④)前端面:key 仅存 sessionStorage,经 `apiHeaders()` 以 `x-engine-key` 透传;配额拦截(AI-07 提交前拦截)在 idle 态状态区呈现「明日再来 / 自带 API key」双出路。④ 「接受」在 T12 的语义 = 结果 GLB 送入 T10 导入管线(解析→单位→水密预检→贴床);AI-09 完整落入链(自动选中+聚焦+首检+R2 转存)仍归 T16,届时替换此调用点即可。

**v1.3 变更记录(T4 落地修订)**:① D4 统一任务协议补充可选字段 `queuePosition`(排队位置反馈,PRD AI-03 的服务侧供给);接口定稿:`submit` 接收路由层账务键(扣减先于提交,键必然先存在),引擎负责「引擎侧 taskId → 账务键」映射并以 `billingIdOf` 暴露——mock 内嵌进 taskId(零存储),Tripo 经 KV(T13,存储分工表既定)。② mock 引擎采用无状态时间表设计:排队/生成时长与结局在提交瞬间定案、编码进 taskId,查询按当前时间纯计算——零存储成本、跨 isolate 天然一致、页面刷新恢复轮询(AI 边界 1)免费获得;取消由路由层承接(账务返还 + 客户端停轮询)。③ 失败注入指令(`@mock:fail/queue/run/asset`)写入 prompt,T12 开发与演示可在零 credit 成本下确定性遍历 AI-05 三分类;三类失败时间线各异(moderation 排队即拒 / service 中途崩 / timeout 到点失败),供前端三出路做差异化体验。④ 返还的执行点统一在路由层(提交失败、轮询观察到失败、取消三处),幂等语义只有 quota-core ledger 一套。

**v1.2 变更记录(实现↔文档对账,Backlog「PRD 漂移检查」条款)**:① 全局熔断计数从 KV 收进配额 Durable Object——单实例串行化让「个人配额 + 全局预算」两笔账天然原子,且省去 dashboard 建 KV 命名空间的账号侧步骤;KV 的启用缓办至 T13(任务映射)。② 访客复合键的 M1 落地 = 客户端持久 ID(localStorage)+ IP 的 SHA-256 截断——完整浏览器指纹的投入产出比不成立,绕过风险由熔断层兜底(§8 风险表原判不变)。③ 配额日界定为 UTC 自然日,跨日整体翻转;跨日返还落空视为可接受损耗(返还发生在任务生命周期内,分钟级)。

---

## 1. 总体架构

```
浏览器(React + Three.js SPA)
  ├─ 渲染/编辑:Three.js 场景、gizmo、选择系统
  ├─ Web Worker ×3:文件解析、打印检查、网格修复预览
  ├─ IndexedDB:资产库、项目场景(PRD C5)
  └─ fetch → 服务层
服务层(Cloudflare Workers,单 Worker 多路由)
  ├─ /api/generate   任务提交(校验、配额扣减、转发引擎)
  ├─ /api/task/:id   任务查询(客户端驱动轮询的代理)
  ├─ /api/transfer   结果转存(引擎临时 URL → R2)
  ├─ /api/quota      配额查询
  ├─ Durable Object:访客配额计数、账务记录、全局熔断(强一致,v1.2)
  ├─ Durable Object(同实例):任务映射 tripoId→账务键(v1.5 自 KV 方案收进,防伪造返还)
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
`{ type: text|image|multiview, prompt/images, options } → { taskId } → { status: queued|running|success|failed, progress, resultUrl, failReason: timeout|moderation|service }`
Tripo 映射:`text_to_model` / `image_to_model` / `multiview_to_model`;图片先经 `/upload/sts` 换取 `image_token`;`consumed_credit` 字段用于成本对账;错误码 2000(超并发)映射为对用户不可见的服务层排队重试(指数退避 + Retry-After),不占用用户失败分类。Meshy 映射同构,M2 实现。

**D5 STL 导出走客户端。** 复用检查器的 composeTRS 逐顶点直写二进制 STL(Z-up + mm 已是世界设定,零转换;v1.7 自 STLExporter 方案收进——检查与导出同口径、镜像绕序修正、头部嗅探兼容)。不用 Tripo 的付费 Conversion 任务(5–10 credits/次)——但记录其 `flatten_bottom` 能力于注释层,作为「服务端也有沉底概念」的佐证。

**D6 防滥用四层。** ① Cloudflare Turnstile(免费、无感)拦机器人于任务提交前;② 访客配额:浏览器指纹 + IP 复合键,3 次/日(见 §6 成本模型),计数与账务存 Durable Object——KV 为最终一致且无原子操作,并发读改写会产生配额双花,不得用于计数;③ 全局预算熔断:当日总消耗 credits 记于配额 Durable Object(v1.2:与个人配额同实例记账,原子且无双花),达上限(可配)后全站生成入口降级为「今日额度已用完 + 自带 key」;④ 自带 key 通道:用户 key 仅存 sessionStorage、每请求透传、服务层不落盘;⑤ 演示码:URL 携带的提升配额令牌(如 20 次/日),供面试与演示链接使用,服务层可逐码撤销——防御机制不应卡住最高价值访客。

## 3. 前端工程

- **栈**:React 18 + TypeScript + Vite;Three.js(r16x)+ @react-three/fiber 承载视口,drei 提供 TransformControls/相机控制的基础件(按 PRD VIEW-02 重映射鼠标)。
- **状态**:Zustand 三个 store——场景(实例/组/选中集,单一事实源)、历史(command 栈)、任务(生成状态机)。历史栈实现为 command pattern(PRD HIST-02),store 变更一律经 command 派发,禁止旁路 setState 修改场景。旋转以欧拉角(固定 XYZ 序)为源数据,gizmo 旋转增量直接作用于欧拉,禁止从变换矩阵反解回写(等价角多解会造成面板数值跳变)。
- **Worker 化**:`parse.worker.ts`(GLTFLoader/STLLoader/OBJLoader + 单位推断 + 水密性预检)、`check.worker.ts`(打印检查,PRD CHK-04 的资产级/实例级分层)、`mesh-repair.worker.ts`(确定性清理/简单平面封口/结果验证)。几何以 Transferable ArrayBuffer 传递,避免结构化克隆开销。
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
| 云端 | Durable Object(同上) | 任务映射 tripoId→账务键(v1.5 自 KV 收进) | 48h 惰性剪枝 |

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
