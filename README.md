# 3D STD · Web 工作台

AI 生成 → 编辑摆盘 → 打印检查 → 导出 STL 的网页版 3D 打印创作工作台。
规格见 `docs/`(PRD v0.93 · 技术方案 v1.1 · Backlog v1.0)。当前进度:T1 脚手架 + T2 编辑内核(16 测试)。

## 首次上线(全程网页操作,无需命令行)

**A. 仓库准备**
1. 打开 github.com/bigcatdamao/3D-STD → Settings → General,拉到底部 Danger Zone → Change visibility → **Public**。
   (私有库协作方读不到;若坚持私有,改为每次把代码 zip 传进对话。)
2. 若仓库为空:点 Add file → Create new file,随便建一个 `init.txt` 提交,激活默认分支。

**B. 上传代码**
1. 解压本 zip。
2. 仓库页 Add file → **Upload files**,把解压出的**全部内容**(含 docs、src、worker 等文件夹)一次拖入,Commit。
   备选:打开 Codespace,把 zip 拖进左侧文件树,终端跑 `unzip *.zip && git add -A && git commit -m t1 && git push`。

**C. 绑定 Cloudflare(一次性)**
1. 注册/登录 dash.cloudflare.com(免费档即可)。
2. 左栏 Workers & Pages → Create → **Workers** → Import a repository → 授权 GitHub → 选 `3D-STD`。
3. 构建设置:Build command 填 `npm run build`,Deploy command 保持默认(`npx wrangler deploy`),保存。
4. 等云端构建完成,得到 `https://3d-std.<你的子域>.workers.dev`。

**D. T1 验收(打开上面的 URL)**
- 看到五区布局壳;
- 视口里绿色立方体「立」在打印床网格上(Z-up 正确);
- 顶栏右侧「服务层: 在线」(Worker 路由通)。
三条全过 = T1 完成,此后每次推送代码自动重新部署。

## 日常协作循环
新会话开工口令:仓库地址 + 任务号(如 T5)+ 遗留问题 → 协作方拉代码开发 → 交付更新 zip → 你按步骤 B 上传 → 自动部署 → 你按 PRD 验收标准点测。

## 本地/云端开发(可选)
Codespace 终端:`npm i && npm run dev`,按提示打开转发端口即可看到实时画面。
校验:`npm run typecheck && npm test && npm run build`。
