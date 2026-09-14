<p align="center">
  <img src="assets/icon.png" alt="Project Grid" width="80" />
</p>

<h1 align="center">Project Grid · 项目矩阵</h1>

<p align="center"><strong>多个项目，一屏掌握。红框亮起，继续下一轮。</strong></p>
<p align="center">A local workspace for parallel Codex projects, live terminals, and completion alerts.</p>

<p align="center">
  <a href="https://github.com/noeigenstate/project-manager/releases/latest"><img src="https://img.shields.io/github/v/release/noeigenstate/project-manager?style=flat-square&color=78bfa1&label=release" alt="Latest release" /></a>
  <a href="https://github.com/noeigenstate/project-manager/actions/workflows/build-windows.yml"><img src="https://github.com/noeigenstate/project-manager/actions/workflows/build-windows.yml/badge.svg?branch=main" alt="Windows build and desktop tests" /></a>
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011%20%C2%B7%20x64-8ebce5?style=flat-square" alt="Windows 10 / 11 x64" />
  <img src="https://img.shields.io/badge/Desktop-Portable-d8dfe8?style=flat-square" alt="Portable desktop app" />
</p>

<p align="center">
  <a href="https://github.com/noeigenstate/project-manager/releases/latest"><strong>下载 Windows 版</strong></a> ·
  <a href="#亮点功能">亮点功能</a> ·
  <a href="#开始使用">开始使用</a> ·
  <a href="#未来展望">未来展望</a> ·
  <a href="docs/usage.md">使用文档</a>
</p>

<p align="center">
  <img src="docs/images/overview.png" alt="Project Grid 总览：多个真实终端同屏显示，红框表示等待查看，绿框表示开发完成" width="1100" />
</p>
<p align="center"><sub>真实桌面界面，使用演示项目展示。油画里的树影、蓝天与白云，衬托清晰的磨玻璃工作区。</sub></p>

## 为什么做 Project Grid

同时开发几个项目时，最容易错过的，是另一个窗口里早已结束的任务。

Project Grid 把项目放进同一个窗口：每个方框都有独立终端，Codex 每轮结束时红框闪烁。点开处理、继续下达指令，再回到总览；其他项目始终可以继续运行。你可以把注意力放在需要接手的地方。

## 亮点功能

### 🧩 所有项目，一屏可见

添加多个本地目录，网格随项目数量自动排列。每个项目都有真实的 PowerShell 终端，保留 Codex 的终端交互和 ANSI 色彩。搜索、添加项目和设置收进顶部栏，把更多空间留给代码与输出。

### 🔴 每次完成，都有明确提醒

| 状态 | 表示什么 | 接下来怎么做 |
| --- | --- | --- |
| 🔴 红框闪烁 | Codex 本轮结束，等你查看 | 点击进入全屏，检查结果并继续下达指令 |
| 🟢 绿框常亮 | 你已确认整个项目开发完成 | 放在总览里，需要时选择「继续开发」 |
| ⚪ 常规边框 | 终端就绪或 Codex 会话已打开 | 继续工作；会话状态不等同于模型正在生成 |

红框会保留到你查看为止，搜索、切换窗口或关闭到托盘都不会清掉提醒。还可以在设置中开启系统通知和提示音。

### 🖥️ 点开专注，返回继续总览

点击项目标题或红框，进入原生全屏。左侧展开熟悉的文件目录，查看代码与产物；目录栏可以收起，给终端让出空间。返回总览时，原来的终端与任务仍然保留。

### 🎬 生成的结果，直接在这里看

| 文件与操作 | 应用内体验 | 带来的便利 |
| --- | --- | --- |
| PNG、JPEG、WebP、GIF、ICO 等 | 直接看图，适应窗口、原尺寸、缩放 | 不必另外寻找图片查看器 |
| HTML / HTM | 渲染网页，可切换源码；支持项目内图片、CSS、脚本和 JSON | 不必为了查看静态报告反复切换窗口 |
| MP4、WebM 等视频 | 播放、暂停、拖动进度、音量、全屏 | 不必先打开独立播放器 |
| 大文本、日志与 HTML 源码 | 分段读取、按页跳转，只渲染可见行 | 不再因为超过 1 MiB 被要求换编辑器 |
| Ctrl + 鼠标左键 | 网页链接打开浏览器，项目内文件直接预览 | 不必复制路径再去找文件 |

<table>
  <tr>
    <td width="50%"><img src="docs/images/image-preview.png" alt="应用内图片预览，提供缩放和原尺寸查看" /></td>
    <td width="50%"><img src="docs/images/video-preview.png" alt="应用内视频播放器，支持播放和进度跳转" /></td>
  </tr>
  <tr>
    <td align="center">看图、检查细节</td>
    <td align="center">播放视频、检查输出</td>
  </tr>
</table>

文件预览期间，终端任务继续运行。产物更新后点击刷新，就能查看新的内容。

### 🌿 让长时间工作更舒服

树影、蓝天、白云的油画背景，搭配半透明磨玻璃面板。正文、路径和终端文字经过提亮，文字区域加深底色，减少背景干扰。系统启用减少动态效果时，提醒会保留颜色并停止闪烁。

## 开始使用

**Windows 10 / 11 · x64 · 本机已安装 Codex CLI，并可在 PowerShell 中运行。**

1. 从 [Releases 下载最新版](https://github.com/noeigenstate/project-manager/releases/latest)，双击 `Project-Grid-版本号-win-x64.exe`，无需安装。
2. 点击顶部 **添加项目**，选择项目目录。在终端输入 `codex`，或点击 **启动 Codex**。
3. 红框亮起后点开，查看结果并继续对话。完成后点击 **返回总览**。
4. 整个项目做完时，点击 **标记开发完成**，让它以绿色常亮留在总览中。

> **更新已有版本：**先等正在运行的任务结束，再从设置或托盘菜单退出旧版，然后启动新文件。只关闭窗口可能会缩到托盘，仍然运行旧版。项目列表和完成标记会保留。

| 快捷操作 | 功能 |
| --- | --- |
| `Ctrl + K` | 总览中搜索项目 |
| `Ctrl + B` | 全屏项目中展开或收起目录 |
| `Ctrl + Shift + G` | 返回项目总览 |
| `Ctrl + 鼠标左键` | 打开终端中的链接 |
| `Ctrl + Shift + C` | 复制选中的终端文字 |

## 几个实用说明

<details>
<summary><strong>红框是「本轮结束」，绿框是「项目完成」</strong></summary>

红框来自本应用终端中 Codex 的完成通知。终端退出、普通命令结束、长时间没有输出，都不会被误判为开发完成。绿色由你手动确认；后续新一轮任务完成时，仍会重新亮红，避免漏看。

</details>

<details>
<summary><strong>本地工作区与现有 VS Code 如何配合？</strong></summary>

Project Grid 为所选目录创建独立终端，不会搬入 VS Code 中已经运行的终端。需要继续已有 Codex 对话时，可在结束原窗口会话后使用 `codex resume`。需要编辑文件时，可通过项目菜单或预览工具栏在 VS Code 打开。

窗口默认关闭到托盘，任务继续运行。项目目录、未读记录和绿色标记保存在本机；退出应用后不保存终端文字，重新启动也不会自动重跑命令。Codex 的模型连接和账户沿用你自己的 CLI 配置。

</details>

<details>
<summary><strong>大文件、网页和视频有哪些注意事项？</strong></summary>

没有固定的文本、图片或 HTML 文件大小门槛。大文本按约 256 KiB 分页，支持 UTF-8 和带 BOM 的 UTF-16；行号与复制针对当前页。图片解码和复杂网页渲染仍受可用内存影响。

视频按需读取。MP4（H.264）与 WebM 已做实际播放验证；编码不被内置播放器支持时，可选择系统播放器。

HTML 在独立来源的隔离框架中运行，不能访问应用的 Node.js 或终端接口。支持项目内相对资源，HTTPS CDN 需要联网；依赖开发服务器的前端源码应先构建再预览。相对文件链接按项目根目录解析。

</details>

## 未来展望

接下来希望让多项目协作更顺手。以下是规划方向，尚未上线，欢迎通过 [Issues](https://github.com/noeigenstate/project-manager/issues) 讨论优先级。

- [ ] **项目分组与快捷切换**：按客户、产品或开发阶段组织工作区。
- [ ] **更丰富的 Agent 接入**：让更多命令行编码助手接入统一的完成提醒。
- [ ] **任务与产物记录**：更容易回看每一轮的结果，快速找到生成的图片、网页和视频。
- [ ] **更强的文件查看**：大文件搜索、行号定位与更丰富的格式支持。
- [ ] **跨平台与远程项目**：探索 macOS、Linux、WSL 和 SSH 工作区。

## 本地开发

使用 Windows 与 Node.js 24：

```powershell
git clone https://github.com/noeigenstate/project-manager.git
cd project-manager
npm ci
npm start
```

```powershell
npm run build          # 类型检查与前端构建
npm test               # 状态、文件读取、链接与资源访问测试
npm run test:desktop   # 真实桌面、终端、图片与视频交互验证
npm run dist           # 构建 Windows 免安装版
```

采用 **Electron · React · TypeScript · xterm.js · node-pty**。GitHub Actions 自动构建 Windows 可执行文件；版本标签通过单元测试和打包版桌面测试后发布到 Releases，并附 SHA-256 校验信息。详细说明见 [开发与发布文档](docs/usage.md#github-自动构建)。

---

<p align="center">
  <strong>让任务继续运行，让注意力回到需要你的项目。</strong><br />
  <a href="https://github.com/noeigenstate/project-manager/releases/latest">下载体验</a> ·
  <a href="https://github.com/noeigenstate/project-manager/issues">反馈问题与建议</a>
</p>
