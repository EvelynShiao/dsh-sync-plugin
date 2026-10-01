# dsh-sync（带知识库同步补丁）

这是 `@weibaohui/dsh-sync` 的分叉版，在原版基础上新增第 5 个同步组：知识库 `knowledge.sqlite`。

## 为什么需要它

原版只同步四类：`syncSkills` / `syncSessions` / `syncSettings` / `syncPlugins`，
**知识库不在其中** —— 电脑上整理好的知识库传不到手机。

## 补丁清单（7 处，全部在 `src/index.js`）

| # | 位置 | 改动 |
|---|---|---|
| 1 | 默认设置 | 新增 `syncKnowledge: true` |
| 2 | 默认设置 | 新增 `knowledgeStrategy: 'merge'` |
| 3 | 设置 schema | 新增 `syncKnowledge` 与 `knowledgeStrategy` 两个字段 |
| 4 | `defaultRoots()` | 新增 knowledge 路径指向 DSH_HOME 下的 knowledge.sqlite |
| 5 | `syncSpec()` | 新增 knowledgeStrategy 策略解析 |
| 6 | `syncSpec()` | 新增第 5 个同步组（单文件模式） |
| 7 | 配置层 | `cordis.patch.yml` 需加 `syncKnowledge: true` |

生成的同步组：

```
组 [knowledge] 策略=merge
     <DSH_HOME>/knowledge.sqlite  ->  knowledge/knowledge.sqlite   (单文件)
```

## 为什么用 merge 而不是 standalone

- `merge` → 顶层共享路径 `knowledge/knowledge.sqlite`，两端都能读
- `standalone` → `backup/<设备实例>/...`，各机各存各的，手机读不到

## 已知限制

1. **SQLite 是二进制**，两端同时改会进入冲突流程（`conflictMode: ai` 由对齐步骤处理，失败则人工选边）。日常单端写入不会触发。
2. 库是 `journal_mode = delete`（非 WAL），单文件拷贝安全 —— 这是本补丁成立的前提。
3. 必须在 `cordis.patch.yml` 的 config.sync 下加 `syncKnowledge: true` 才生效。

## 版本

`9999999.9.9` —— 故意写死，让更新检查器认为已是最新，**不要用原版覆盖掉这个补丁**。

## 上游

npm: `@weibaohui/dsh-sync` · 原作者 MIT 许可。本分叉只改同步组，不改冲突处理与快照机制。


## 2026-09-30 修复（第二批）

起因：手机端点「下载」提示成功，实际影子仓库没更新，知识库没落地；同时新装插件被关。

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 上次被强杀留下的 `index.lock` 导致 `reset --hard` 失败，而失败被 `.catch(()=>{})` 吞掉 | **下载入口先自检残留锁**（超 5 分钟自动清理并告警，未超时则抛出可读错误） |
| 2 | `reset` / `checkout` 失败静默 → 界面照报「下载完成」 | **失败改为上抛**，错误信息带原因 |
| 3 | `if (!haveSource) continue` 分不清「本机没装」和「仓库没拉到」 | **改为写入 `skipped[]` 并随返回值上抛**，界面能看到被跳过项 |
| 4 | `plugins`/`settings`/`skills`（standalone）下载时拿**本机自己的旧备份**覆盖 live → 新装插件消失 | **standalone 组下载时跳过**（路径以 `backup/` 开头的一律不覆盖），恢复走快照还原或「远端浏览 → 远端对齐」 |

修复后下载只应用**云端共享内容**（`sessions/`、`knowledge/`），不再碰各机独立配置。

返回值新增 `skipped` 字段，例如：

```
backup/pc/plugins（本机备份，下载不覆盖）
knowledge/knowledge.sqlite（影子仓库缺失，可能未拉取成功）
```

### 仍未修（已知）

PR 合并、预推送对账等**辅助流程**里仍有 `.catch(()=>{})` 吞错（`src/index.js` 约 575/609/632/699/816 行）。
它们的根因同样是残留锁——下载入口的锁自检会先把锁清掉，因此目前不会被触发。
