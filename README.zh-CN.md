[English](./README.md) | 简体中文

<p align="center">
  <img src="public/icon-512.png" width="96" height="96" alt="Codex Mobile Bridge 图标">
</p>

<h1 align="center">Codex Mobile Bridge</h1>

<p align="center">
  一个通过手机访问本地 Codex 会话的自托管 Web 界面。<br>
  服务运行在 Windows 回环地址上，并通过 Tailscale Serve 保持私有访问。
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20+"></a>
  <a href="https://www.microsoft.com/windows/"><img src="https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows11&logoColor=white" alt="Windows"></a>
  <a href="https://tailscale.com/"><img src="https://img.shields.io/badge/Network-Tailscale-242424?logo=tailscale&logoColor=white" alt="Tailscale"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License"></a>
</p>

## 界面预览

> [!NOTE]
> 下方出现的会话、路径、指标和结果均为专门制作的虚构演示数据，不包含
> 任何个人信息或生产数据。

<p align="center">
  <img src="docs/screenshots/desktop-light.png" alt="桌面端白色模式，展示虚构的 Codex 工程会话" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/mobile-light.png" alt="手机端白色模式，展示虚构会话和 Markdown 渲染" width="390">
  &nbsp;&nbsp;
  <img src="docs/screenshots/mobile-dark.png" alt="手机端深色模式，展示相同的虚构 Codex 工程会话" width="390">
</p>

## 功能

- 搜索、打开和新建 Codex 会话。
- 使用 Markdown 渲染回复，并支持可点击链接、表格和代码块。
- 发送消息、追加或停止活动任务，并处理支持的审批和用户输入请求。
- 通过 SSE 实时接收回复，支持心跳、有限事件重放和重连后的增量同步。
- 首次加载最近 10 轮，大型工具详情只在打开时获取。
- 压缩 HTTP 响应，只缓存静态应用资源。
- 通过计划任务 watchdog 自动恢复，并支持经过验证的蓝绿重启。
- 在深色和白色主题之间切换，也可切换英文和简体中文界面。
- 没有运行时 npm 依赖。

## 环境要求

- Windows 10 或 11
- PowerShell 5.1 或更高版本
- Node.js 20 或更高版本
- 已安装并登录 Codex CLI
- 已安装、登录并连接 Tailscale

## 安装

在项目目录运行安装脚本：

```powershell
.\setup.ps1
```

脚本会检查依赖、选择可用端口、创建本机配置、启动 Bridge、配置
Tailscale Serve，并安装当前用户的 watchdog 计划任务。

只预览操作，不修改电脑：

```powershell
.\setup.ps1 -WhatIf
```

显式指定端口或初始界面语言：

```powershell
.\setup.ps1 -LocalPort 8765 -HttpsPort 8443 -Language zh-CN
```

安装完成后，在已连接同一 tailnet 的手机上打开脚本输出的 HTTPS 地址。
该界面也可以安装成 PWA。

## 架构

```mermaid
flowchart LR
    Phone[手机浏览器] -->|Tailnet HTTPS| Serve[Tailscale Serve]
    subgraph Windows[Windows 主机]
        Serve -->|回环 HTTP| Bridge[Mobile Bridge]
        Bridge -->|基于 stdio 的 JSON-RPC| Codex[Codex App Server]
        Bridge --> Files[(本地状态与日志)]
    end
```

只有 Tailscale Serve 可以被远程访问。API 响应和会话数据使用 `no-store`；
Service Worker 只缓存静态界面文件。

## 日常操作

| 命令 | 说明 |
| --- | --- |
| `.\start.ps1` | 启动 Bridge，或检查现有进程。 |
| `.\status.ps1` | 查看 Bridge、App Server、监听端口、Serve 和 watchdog 状态。 |
| `.\bluegreen-restart.ps1` | 验证候选实例后再切换流量。 |
| `.\restart.ps1` | 停止并重新启动 Bridge。 |
| `.\stop.ps1` | 停止 Bridge 并关闭对应的 Serve 规则。 |
| `.\install-watchdog.ps1` | 安装或更新自动恢复任务。 |
| `.\uninstall-watchdog.ps1` | 删除自动恢复任务。 |

Bridge 健康且没有任务运行时，计划升级建议使用
`bluegreen-restart.ps1`。存在活动任务时，该脚本默认拒绝切换。

## 配置

本机路径、端口、语言和生成的访问地址保存在 Git 忽略的
`state/config.json` 中。配置优先级为：

1. 环境变量；
2. `state/config.json`；
3. 自动发现和默认值。

<details>
<summary>环境变量</summary>

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRIDGE_PORT` | 从 `8765` 起首个空闲端口 | 回环 HTTP 端口 |
| `BRIDGE_HTTPS_PORT` | 从 `8443` 起首个空闲端口 | Tailscale Serve HTTPS 端口 |
| `BRIDGE_NODE_PATH` | 自动发现 | Node.js 可执行文件 |
| `BRIDGE_CODEX_COMMAND` | 自动发现 | Codex CLI 可执行文件 |
| `BRIDGE_TAILSCALE_PATH` | 自动发现 | Tailscale 可执行文件 |
| `BRIDGE_UI_LANGUAGE` | 操作系统语言 | `en` 或 `zh-CN` |
| `BRIDGE_APPROVAL_POLICY` | `never` | App Server 审批策略 |
| `BRIDGE_SANDBOX_MODE` | `danger-full-access` | Codex 沙箱模式 |

Node 入口还支持 `CODEX_COMMAND`、`CODEX_ARGS_JSON`、`CODEX_CWD`、
`BRIDGE_STATE_FILE` 和 `BRIDGE_MAX_BODY_BYTES`。绑定非回环地址需要设置
`BRIDGE_ALLOW_NON_LOOPBACK=1`。

</details>

## 安全说明

默认执行模式为 `danger-full-access`，审批策略为 `never`。任何有权打开
Bridge 的 tailnet 设备都能要求 Codex 在主机上执行命令或修改文件。使用前
请检查 tailnet 成员和 ACL。不要把 Bridge 直接暴露到公网。

浏览器写操作必须使用 JSON，并拒绝跨站浏览器请求。静态响应包含严格的
Content Security Policy。

## 开发与验证

运行语法检查、单元测试和协议夹具集成测试：

```powershell
npm run check
```

自动化测试覆盖本地 HTTP 行为和协议映射。已安装 Codex CLI 的兼容性、生产
进程、Tailscale Serve、watchdog 调度和另一台手机的访问仍是独立验证项。

实现细节和版本记录见 [ARCHITECTURE.md](./ARCHITECTURE.md) 和
[CHANGELOG.md](./CHANGELOG.md)。

## 许可证

[MIT](./LICENSE)
