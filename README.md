# dsh-mcp-manager

<div align="center">
  <b style="font-size: 1.15em;">MCP 可视化管理器：装没装、连没连，一目了然</b><br /><br />
  <code>查看列表</code> <code>新增删除</code> <code>启用停用</code> <code>连接状态</code> <code>OAuth 自动接入</code> <code>中英双语</code><br />
  <code>DeepSeek Harness</code> <code>DSH Desktop</code><br /><br />
  <b>设置 → MCP</b> 一站管理 DSH 里的所有 MCP 服务器，<br />
  无需再手改 <code>cordis.patch.yml</code> —— 所有修改即改即生效（HMR 热应用）。
</div>

<!-- 截图：待补充（建议放 3 张：服务器列表 / 添加表单 / 展开的编辑面板） -->

## ✨ 功能一览

- **📋 服务器列表**：列出所有已装的 MCP 服务器 —— 名称、实时状态、传输方式、启用开关与已注册工具数
- **➕ 新增 / ➖ 删除**：表单添加服务器，两种传输方式（`Streamable HTTP` / `STDIO`）；HTTP 支持请求头与超时，STDIO 支持命令、启动参数、环境变量与工作目录；带格式与重名校验，一键删除
- **🔐 OAuth 自动接入**：HTTP 服务器**不需要你回答「它要不要 OAuth」**。保存时管理器只发一个不带凭据的探测请求，需要授权的行才交给 OAuth 桥（走 RFC 9728 发现 + 动态注册 + 浏览器授权 + 令牌刷新），其余行一律用 DSH 内置客户端——**不装第三方插件也能管理所有非 OAuth 的 MCP**
- **🔌 启用 / 停用**：随时切换，工具随之热连接 / 热断开
- **📶 连接状态**：每张卡片一个实时状态胶囊 —— `未加载` / `等待中` / `加载中` / `N 个工具`（已连接）/ `无工具` / `失败` / `已停用` / `卸载中`，由宿主事件流推送，无需手动刷新
- **✏️ 编辑**：在卡片原位展开表单，保存即应用
- **🌏 多语言**：界面文案跟随 DSH 语言（zh / en）实时切换
- **💾 持久化**：所有修改写入 profile 的 `cordis.patch.yml`，重启后保留；页面底部显示文件路径

## 🧭 设计说明：为什么面板里没有 OAuth 开关

选哪个桥由插件自己判断，与用户无关。**默认是内置客户端**——只有探测确认需要 OAuth 的行，才会用到那个第三方插件：

| 传输方式 | 归属包 | 判定 |
|---|---|---|
| `STDIO` | `@deepseek-ai/dsh-mcp-client`（DSH 内置） | 直接判定，不发任何请求。子进程不可能需要 OAuth |
| 带 `Authorization` 请求头的 HTTP | 同上（内置） | 直接判定，不发任何请求。你自己带令牌，就不该让 OAuth 插手（`Authorization` 是 OAuth 令牌用的同一个头，SDK 会让行内配置覆盖它） |
| 其余 HTTP | 探测决定 | `401` + `WWW-Authenticate: Bearer` → `@hualiong/dsh-oauth-mcp-client`；其它任何响应 → 内置客户端 |

探测就是一个 5 秒超时的 GET，只看响应状态码与 `WWW-Authenticate` 头，不发 MCP 协议消息、不建会话、不带凭据。三种结果都会在页面上给一行提示。走偏了有两种自然的纠正方式，都不需要额外开关：

- **服务器要求 OAuth，但保存时它正好没连上**（探测报「无法验证」，按内置客户端接入）：等它可达后**重新保存一次**，归属会被重新判定并改写。
- **如果你自己的固定令牌服务器被判成了 OAuth**：在表单里填上 `Authorization` 请求头，该行立刻回到内置客户端。

两种情况在界面上完全一样，你不需要选。编辑会重新探测，所以归属也可能随之改变（这正是上面第一条纠正方式）。

**没装 HTTP 桥怎么办**：行照常写入（先加行、后装插件是合理路径），但会**以「停用」状态保存**——这样重启 DSH 时它不会去加载一个不存在的包。卡片上的开关同时会**置灰、打不开**（宿主也会拒绝这次开启），保存时页面直接给一行警告说明缺哪个包：

1. 装 `@hualiong/dsh-oauth-mcp-client`
2. 重启 DSH
3. 打开那个开关 —— **不需要重新保存这一行**

普通 HTTP / STDIO / 自带令牌的行完全不碰这条路径。

其余 OAuth 相关的字段也不在表单里：

| 字段 | 默认 |
|---|---|
| `credentialRef` | 由**插件 ID** 推导：转大写、非字母数字换成 `_`（如 `oauth-mcp-cloudflare` → `OAUTH_MCP_CLOUDFLARE`），必要时前缀 `MCP_`。令牌就存在这个 Harness 凭据名下 |
| `callbackPort` | 固定 `45179`（不是随机端口，这样 `redirect_uri` 跨重启稳定，令牌不用反复重新注册）。被占用时退回临时端口并写一条警告；同时跑多个 OAuth 服务器请各自指定 `callbackPort` |
| `scope` / `authorizationTimeoutMs` | 由服务器元数据 / 5 分钟兜底 |

想改这些值，直接编辑 profile 的 `cordis.patch.yml` —— 面板不做覆盖，编辑已有行时会原样保留。

## 🚀 安装

**前置**：DSH 已装好（`dsh web` 能正常运行）。

- 只想管理 `STDIO` 或普通 `Streamable HTTP`（含自带令牌的）MCP：**什么都不用额外装**，内置客户端就够了。
- 有需要 OAuth 授权的 HTTP MCP：再装 HTTP 桥，只有这些行会用到它：

```sh
dsh plugin --profile desktop add @hualiong/dsh-oauth-mcp-client
```

### 从本地 checkout 安装（开发 / 自用）

```sh
dsh plugin --profile desktop add "link:C:/绝对路径/dsh-mcp-manager"
```

也可以直接跑仓库里的脚本，它会自动识别本地 checkout 并用 `link:` 装好：

```sh
bash scripts/install.sh                                     # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1   # Windows
```

### 从 npm 安装

```sh
dsh plugin --profile desktop add @hualiong/dsh-mcp-manager
```

> `dsh plugin add` 会自动完成三件事：登记依赖 → 识别包内 `dsh.bundle.patch`（[cordis.patch.yml](cordis.patch.yml)）→ 注册进 `dsh.profile.bundles` 挂载，无需手改 `cordis.patch.yml`。
> profile 名按实际部署填：桌面版用 `desktop`，命令行 `dsh web` 用 `web`。

装完**硬刷新浏览器**（Cmd/Ctrl+Shift+R），打开 **设置 → MCP** 即可看到管理页。若未出现 MCP 页签，重启一次 DSH（宿主半边首次挂载需要）。

<details>
<summary><b>更新 / 卸载</b></summary>

**本地 checkout**：`git pull` 后 `pnpm build`。前端改动（`lib/client.js`）会被客户端 HMR 直接热替换，浏览器里立刻生效；**宿主改动**（`lib/index.js`）不在默认 HMR 监听范围内，需要重启一次 DSH（或在「设置 → 插件」里把本插件关掉再打开）。

**npm 安装**：重跑一次 `dsh plugin --profile <profile> add @hualiong/dsh-mcp-manager`。

**卸载**：`dsh plugin --profile <profile> remove @hualiong/dsh-mcp-manager`；若曾在 `cordis.patch.yml` 里手写过挂载行，一并删掉那段 `- insert: ... mcp-manager ...`。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 装完没看到 MCP 页签 | 硬刷新（Cmd/Ctrl+Shift+R）；仍没有就重启 DSH 一次（宿主半边首次挂载需要）。 |
| 页面出现**两个 MCP 页签** | 双挂载：`cordis.patch.yml` 里还留着旧的手动挂载行，删掉那段 `- insert: … mcp-manager …`（[scripts/remove-manual-mount.mjs](scripts/remove-manual-mount.mjs) 可代劳）。 |
| 新增需要授权的 HTTP 服务器 | 保存时会提示缺 `@hualiong/dsh-oauth-mcp-client`，该行以**停用**状态保存、开关置灰打不开；装上插件重启 DSH 后**直接打开开关**即可，不用重新保存。 |
| 需要浏览器授权的服务器停在 `无工具` | 首次要授权：桥会自动打开默认浏览器，等待回环回调（默认 5 分钟）；看宿主日志里的进度。授权完成后状态会自动变成 `N 个工具`。 |
| 改完配置没生效 | 所有修改都走 HMR 热应用，等 1–2 秒即自动刷新；页面右上角也可手动刷新。 |
| 想让某行固定用自己的令牌 | 在「请求头」里加一行，名称填 `Authorization`、值填 `Bearer <token>`，该行就会交给内置客户端，不参与 OAuth。 |

</details>

## 📖 使用说明

打开 **设置 → MCP**：

- **添加服务器**：填写 插件 ID、`serverName`、传输方式及对应字段。
  - `Streamable HTTP`：URL（+ 请求头、超时）；
  - `STDIO`：命令、参数（每行一个）、环境变量（`KEY=VALUE`，每行一个）、工作目录。
- 面板做格式与重名校验，重复的 id / `serverName` 会被拒绝，错误直接标在对应字段下方。
- **编辑**在卡片原位展开，表单字段与添加时完全一致；保存时会重新探测，因此归属桥可能在编辑后改变（这正是「服务器后来才可达」时的纠正路径）。
- 每张卡片显示实时状态、传输方式、被编辑的补丁文件路径，可执行 **启用 / 停用**、**编辑**、**删除**。
- 传输方式标签是写死的属性，不随连接状态变化；`未加载` / `等待中` / `加载中` 这类中间态只在状态标签上出现。

## ⚙️ 配置

插件在 loader 里的行配置支持一个可选字段：

| 字段 | 说明 |
|---|---|
| `patchFile` | 要编辑的用户补丁层绝对路径。默认 `$DSH_HOME/profiles/web/cordis.patch.yml`。 |

桌面版建议在 profile 补丁里显式指定，例如：

```yml
- id: mcp-manager
  name: '@hualiong/dsh-mcp-manager'
  config:
    patchFile: C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml
```

## 🏗️ 项目结构

```text
cordis.patch.yml          # bundle 层：把本插件挂进 profile（dsh.bundle.patch 指向它）
src/
  index.ts                # 宿主半边：/mcp-manager 路由 + SSE 变更流 + 端点分发
  patch.ts                # cordis.patch.yml 读写（insert 行 / 覆盖行 / disabled）
  detect.ts               # 保存时的一次性探测：401 + Bearer 挑战 ⇒ 这行需要 OAuth
  status.ts               # 遍历 loader + tools，投影出每台服务器的状态与工具数
  validate.ts             # 与两个桥接包 schema 对齐的字段级校验
  shared.ts               # 主进程 / 浏览器共用类型与常量（含两个桥接包名）
  client/
    index.tsx             # 浏览器半边：注册 设置 → MCP 页（settings.section 槽位）
    McpManagerSection.tsx # 页面本体：服务器列表 + 添加/编辑表单
    locales.ts            # zh / en 文案
    rpc.ts                # 对 /mcp-manager 的 fetch 客户端
    dsh-client-runtime.d.ts
scripts/
  build.mjs               # esbuild：lib/index.js（宿主）+ lib/client.js（ModuleLoader bundle）
  install.sh / install.ps1
  remove-manual-mount.mjs
test/                     # node:test：路由契约、补丁读写、状态投影
lib/                      # 构建产物（已入库，GitHub 源安装可直接用）
```

配套仓库：**dsh-oauth-mcp-client**（HTTP 桥，OAuth 感知，浏览器授权 + 凭据持久化）。

## 🔧 开发

```bash
pnpm install
pnpm build        # esbuild：lib/index.js（宿主）+ lib/client.js（ModuleLoader bundle）
pnpm typecheck    # tsc --noEmit（@deepseek-ai/* 的类型来自 devDependencies）
pnpm test         # node --test：宿主半边的路由契约 / 补丁读写 / 状态投影
```

改了源码记得 `pnpm build` 并把新的 `lib/` 一并提交（仓库刻意入库构建产物，方便 GitHub 源直接安装）。

## 许可证

MIT，见 [LICENSE](LICENSE)（保留原作者的版权声明）。
