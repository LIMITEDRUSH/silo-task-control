# SILO Desktop

Windows 双击 `Start SILO.cmd`；macOS 双击 `Start SILO.command`，即可打开同一套轻量外置面板。Windows 使用 Edge 应用窗口；macOS 优先使用已安装的 Chrome、Edge、Brave 或 Chromium 应用窗口，并在没有 Chromium 浏览器时回退到默认浏览器。不打包 Electron，也不维护单独的 Mac UI。

- 扫描、额度、文件夹分组、任务选择和指令编辑与 Codex 插件共用同一套核心。
- Launch 使用官方 `codex exec resume` 命令并按所选并发执行，不绕过审批或沙箱；另一个 Codex 窗口占用任务时会安全失败并显示原因。
- 右侧“运行”栏持续显示本次启动的每个任务、进度和失败原因，刷新页面后会重新附着到仍在内存中的桌面批次。
- “停止 SILO 启动的任务”和“满额停止本批次”都需要输入 `STOP`，只作用于当前桌面进程启动的任务。
- 窗口关闭且没有运行中的批次后，本地服务会在五分钟空闲后退出。

macOS 首次启动若被 Finder 阻止，可在终端运行 `chmod +x "desktop/Start SILO.command"`，随后在 Finder 中右键该文件并选择“打开”。Node.js 与 `codex` 应位于 `PATH`，也可通过 `CODEX_CLI_PATH` 指定 Codex CLI。
