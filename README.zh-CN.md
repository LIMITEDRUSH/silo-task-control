# SILO Task Control

[English](README.md) | [简体中文](README.zh-CN.md)

SILO 是一个简约、轻量的 Codex 控制面板，用于跨项目扫描现有任务、逐项检查将要发送的继续或优化提示词，并通过 Codex 原生任务工具启动用户确认过的批次。

当前版本：**v0.4.1**（`0.4.1+codex.20260913`）

## 安装

先把 GitHub 仓库加入 Codex marketplace，再安装 SILO：

```powershell
codex plugin marketplace add LIMITEDRUSH/silo-task-control
codex plugin add silo-cn@silo-plugins
# 或安装固定英文版：
codex plugin add silo-en@silo-plugins
```

首次安装后重启 Codex。可以从侧边栏打开 **SILO**，也可以新建任务后输入：

```text
$silo-task-control 打开控制面板，扫描我现在的任务。
```

安装时二选一：`silo-cn` 的界面和默认任务提示词固定为简体中文，`silo-en` 固定为英文。面板内不再提供语言开关，避免同一安装在使用中意外混用语言。

后续更新：

```powershell
codex plugin marketplace upgrade silo-plugins
codex plugin add silo-cn@silo-plugins
```

SILO 目前面向 Windows，需要 Codex Desktop 和 Node.js 22.5 或更高版本。

## 主要能力

- 快速读取本地任务，并结合 Codex 原生状态同步与 SQLite 后备索引。
- 简洁的 **全部 / 待处理 / 已完成 / 智能选择** 工作流、全局搜索和项目分组。
- 逐任务检查完整提示词，支持继续/优化、独立 Burn 策略、模型、推理强度及显式启动确认。
- 使用持久化原生 job、原子 claim 和进度恢复构建实时运行栏；面板或服务重启后仍可恢复状态。
- 轻量额度轮询和重置预测。面板打开时会从第三方服务 [codex-reset.com](https://codex-reset.com/zh/) 获取重置信息。
- 键盘操作：`/` 聚焦搜索，方向键移动任务，`X` 切换选择，`Space` 打开详情，`Esc` 清空批次但保留草稿。

## 调度流程

打开、扫描、筛选和智能选择均为只读。智能选择最多检查候选任务最近两轮对话，只提出继续或优化建议，不会直接启动任务。

启动必须通过确认对话框。SILO 会保存短时有效的计划，发送一条可见的跟进消息，通过 Codex 原生任务工具重新读取每个目标，跳过正在运行或需要用户处理的任务，为每个可用目标执行原子 claim，并把进度写入运行栏。它不会创建、派生、归档、重命名或中断无关任务。

## Windows 外置面板

在 SILO 中选择 **外置窗口**，或双击 `desktop\Start SILO.cmd`。启动器会使用 Codex Desktop 自带的 Node 与 Codex 运行时，启动只监听本机回环地址的服务，并在 Edge 应用窗口中打开同一面板。

## 侧边栏入口

SILO 会把 MCP App 声明为全局入口，因此兼容的 Codex Desktop 版本可在侧边栏显示 **SILO**。这项宿主元数据目前仍未成为公开 API。Codex Desktop 更新后可运行：

```powershell
npm run sidebar-doctor
```

该命令只进行兼容性检查。SILO 不会修补 Codex，也不会修改 `app.asar`。

## 开发

```powershell
npm install
npm run check
```

打包后的 MCP 服务入口为 `dist/server.mjs`。

## 安全边界

- 扫描与计划创建均为只读。
- 计划 15 分钟后失效，只包含最近扫描到的任务 ID。
- 调度需要显式确认，并会在 Codex 中显示可见消息。
- 编辑后的提示词按审核内容发送；启用 Burn 时只追加一次。
- 每个目标都会在发送前通过原生任务 API 再次检查。
- 外置面板的 STOP 只影响由该 SILO 进程启动的子任务。

## 许可证

MIT
