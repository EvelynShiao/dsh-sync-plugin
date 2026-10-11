# dsh-sync-plugin（多设备同步，深度改造版）

给 DSH 做 PC ↔ 手机（DSHA）数据同步的插件。本仓库是自用深度改造版，**不是原作者版本的镜像**——原作者的骨架还在，但行为按"下载即覆盖、跨设备兼容"重写过多轮。以下全部是本版的机制，忘光了看这里就行。

## 仓库地址

- GitCode（主用）：`gitcode.com/gcw_wXIDw07q/dsh-sync-plugin`
- GitHub：`github.com/EvelynShiao/dsh-sync-plugin`

## 同步哪些东西

按"组"组织，每组独立开关与策略：

- **skills**：`~/.agents/skills` + 锁文件，standalone（各机独立备份）
- **sessions**：会话文件（merge 共享），**只传真会话**（目录名带 `session-` 前缀的才上传，子代理会话目录不带前缀、不同步）
- **settings.yaml**：standalone
- **plugins**：只存声明文件（package.json / cordis.patch.yml / pnpm-lock.yaml），**不含 node_modules**（按机重装），standalone
- **prompts**：`dsh-preset-lite/cordis.patch.yml`（提示词版本的真身）单独一组走 merge 共享路径——它在 node_modules 下、被 plugins 组排除，不单拎出来手机永远收不到提示词
- **memory**：session-kit 的 `memory.sqlite`（记忆 + 提示词版本/绑定，见下），merge
- **knowledge**：`knowledge.sqlite`，merge

## 本版重写过的核心行为（为什么和原版不一样）

**1. 上传 = 覆盖云端、下载 = 覆盖本地（配置类）**
原版是"增量合并"，本地改过的文件下载时跳过留冲突。本版给 skills/settings/plugins/prompts 四组加了 `overwriteOnDownload`：下载时整组强制镜像（`reset --hard FETCH_HEAD` 后按远端为准删改），云端是真源。会话组仍 merge（正在写的对话不能被覆盖）；memory/knowledge 仍 merge（SQLite 有打开句柄，硬覆盖会坏库）。上传方向本就是全量镜像（`mirrorLiveToShadow` 先删影子再拷）。**代价：改完提示词/配置要先上传，再下载别的，否则没传的改动会被云端盖掉。**

**2. 跨设备路径键归一化（手机能用的关键）**
会话项目目录由 `header.cwd` 派生，而 cwd 是各设备绝对路径：PC 的 `--C-Users-...` 与手机的 `--root-...` 是两个目录 → 同一会话在云端存成两份 → 宿主报 `duplicate JSONL session id` 拒绝加载。本版下载收尾做了归一化：外来会话按 cwd 的文件夹名匹配本地 workspace，把 header.cwd 改写成本机路径、搬进本机目录（zstd 多帧文件只重写帧 0，事件不动）；本机已有同 id 的，外来副本入备份。另有 `dedupeSessionDirs` 兜底。

**3. 提示词版本 + 工作区绑定 + 手动排序的同步**
- 真相在 `memory.sqlite` 的 `memory_settings` 表 key=`promptWorkshop`（versions + workspacePresets + autoApply）。preset 文件只是投影（session-kit 开机按 versions 重写它），只同步文件永远没用——版本列表必须跟着走。
- 绑定的键是各设备绝对路径 → 导出时翻译成工作区**标题**（可移植），下载时翻回本机路径写进 memory.sqlite。**重启后 session-kit 生效**（它开机读一次）。
- 手动排序：官方 UI 的手动顺序只存浏览器 localStorage（`dsh.workspace.view.v5`），官方从不跨设备同步。本版由 session-kit 客户端桥接（钩 setItem 防抖上传 + 无序时从服务端种子），sync 把 `$DSH_HOME/manual-order.json` 嵌进 `workspace-order.json`（order 文件字段：workspaces 顺序、各工作区 sessions 顺序、archived/pinned、promptBindings、promptWorkshop、manualOrder）带上云。

**4. 快照不再自动乱建**
原版每次下载建 `pre-download-` 安全快照、每次恢复建 `pre-restore-`，越积越多。本版三种安全快照（pre-download / pre-restore / pre-remote-pull）+ 每日自动快照全部 **opt-in**（配置 `snapshotSafety: true` 才建）。快照时间戳改用 `.snap-created` 元数据 + 名字解析（按 UTC，UI 转本地显示），不再用文件系统 birthtime（拷贝后会变）。快照列表带重命名/删除按钮。

**5. 健壮性修补**
- 上传按钮走的是独立函数（非 runPush），开头清残留 `index.lock`（上次上传被强杀会留下锁，之后 git add 必报错）——自动恢复，不用手动删文件
- 上传处理器的 `git add -A` 前重写 order 文件（否则传的是影子仓库里的陈旧版本）
- 下载完成后**无条件刷新会话列表**（新会话不用重启就能看到）+ 触发投影预热
- sessions 组上传前按"总字节数:文件数"签名跳过未变组（skills 76MB 收益最大）
- 会话归档标记（archivedSessionIds / pinnedSessionIds）也随 order 文件并集同步（只保留本机真实存在的 id，防幽灵墓碑）

## 配置速查（cordis.patch.yml 里 dsh-sync 段）

`repoUrl` / `token` / `branch` / 各组 syncXxx 开关 / 各组 Strategy（standalone=各机独立备份、merge=共享）/ `syncOrder`（顺序文件开关）/ `snapshotAuto` / `snapshotSafety` / `snapshotLocalKeep` / `uploadOverwrite`

## 踩坑备忘

- 云端仓库（`dsh-sync.git`）是**私有**的，装着聊天记录本体——别公开
- 下载即覆盖语义下，"改了没上传就下载"= 丢改动。规矩：改完先上传
- 手机端插件装在 `plugin-src/`（`profiles/web/node_modules` 是指回它的符号链接），本版所有路径计算都兼容两种布局
- 重装手机插件：`mv 旧目录 && git clone --depth 1 <GitCode地址> 新目录 && rm -rf 新目录/.git`，link: 按路径解析会自动接上
