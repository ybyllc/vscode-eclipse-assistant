# 版本记录

本文件记录 Eclipse Assistant 的版本变化。日期采用 `YYYY-MM-DD` 格式。

## 0.5.4 - 2026-08-21

- 新增独立的 `CHANGELOG.md`，恢复并集中整理从 `0.1.0` 开始的完整版本记录。
- README 改为链接版本记录，避免功能说明与版本历史重复维护。

## 0.5.3 - 2026-08-21

- 新增失败构建日志保存根目录设置。
- 保存目录支持绝对路径、工程相对路径、`${workspaceFolder}` 和 `${projectDir}` 变量。
- 日志按工程存入独立子目录，避免多个工程共用根目录时相互清理。

## 0.5.2 - 2026-08-21

- 构建失败时自动保存完整命令行输出，构建成功或主动停止时不保留日志。
- 新增失败日志保留数量设置，每个工程可保留最近 `0` 到 `5` 条，默认 `5` 条。
- 保存的日志移除 ANSI 颜色控制字符，并记录工程、配置、Eclipse 客户端、构建命令和退出结果。
- 构建终端在失败后显示日志保存路径，烧录前的构建失败同样会生成日志。

## 0.5.1 - 2026-08-21

- 扩展显示名改为 Eclipse Assistant，技术包名改为 `eclipse-assistant`，扩展 ID 改为 `ybyllc.eclipse-assistant`。
- 固定编辑器顶部构建和烧录按钮为工具、闪电图标，保留 `Ctrl+B` 和 `F11` 快捷键。
- 构建终端增加 xterm-256 规则匹配，对错误、警告、成功、构建阶段、命令和尺寸统计进行分类着色。
- 每次构建清理上一次终端内容，并改进 `successful`、`not successful` 和 Managed Build 重复标识日志的颜色判断。
- 增加 Eclipse 客户端与工程 Managed Build 插件不兼容检测，避免将常见 `Duplicate identifier` 误判为客户端不兼容。
- 支持解析 Eclipse `${workspace_loc:...}` 烧录文件路径，并改进 J-Link/GDB 下载和校验失败识别。
- 简化 Marketplace README，补充使用、IDE 配置、侧栏和烧录配置截图。
- 更新扩展图标、活动栏图标、仓库地址和 Marketplace 分类。

## 0.5.0 - 2026-08-20

- 扩展更名为 Eclipse CDT，包名改为 `eclipse-cdt`。
- 新增带 ANSI 颜色的自定义构建终端。
- 提供四组可切换的编辑器顶部构建和烧录图标。
- 更新扩展图标、活动栏图标和 Marketplace 风格 README。
- 从 VSIX 中排除测试、设计素材和开发期文件，减小安装包体积。

## 0.4.1 - 2026-08-20

- 适配 Flagchip FC IDE 的 J-Link/OpenOCD `.launch`，读取 FC 芯片型号、接口、速度、端口和烧录文件。
- 自动定位 FC IDE 内置的 J-Link GDB Server、OpenOCD、GDB 和 `JLinkDevices.xml`。
- FC 自定义 J-Link 设备使用支持设备 XML 的 J-Link GDB Server 与 GDB 流程，并按 SEGGER 语法分开发送复位、停止和下载命令。

## 0.4.0 - 2026-08-20

- 插件更名为 Eclipse CDT Bridge，从仅支持 GD32 扩展为可对接不同厂商的 Eclipse CDT Headless Builder。
- 界面语言自动跟随 VS Code，增加完整的中文和英文文案。
- 命令、配置和上下文前缀统一为 `eclipseBridge.*`，自动迁移旧的 `gd32EclipseBridge.*` 配置。
- 泛化 Headless 命令行识别，支持 `eclipsec.exe` 和厂商 `*c.exe`；IDE 选择改为选择客户端主程序并自动寻找所需工具。
- 已验证识别 GD32 Embedded Builder 1.5.6、1.5.10 和 Flagchip FC IDE 4.3.1 的命令行构建入口。
- 自动读取 IDE 最近使用的 workspace，并在 `.launch` 工具路径失效时从 IDE 目录寻找 J-Link、OpenOCD 和 GDB。
- 烧录改为“构建并烧录”：当前 CDT 配置构建成功后才烧录，失败时不会下载旧文件。
- 烧录文件选择支持 ELF、AXF、OUT、HEX 和 BIN，工程内文件以相对路径保存和显示。
- 低频使用的构建配置、Headless Workspace 和自动导入选项移入侧栏“其他设置”。
- 增加可切换的顶部按钮图标主题和对应设置。

## 0.3.3 - 2026-08-19

- 根据厂商 Eclipse 的成功日志调整 J-Link 烧录方式。
- J-Link 改用同一 SEGGER 安装中的 J-Link Commander，复用 `.launch` 的芯片、接口和速度参数。
- 使用 `LoadFile -> Reset -> Go -> Exit` 完成一次性烧录，确保程序运行且烧录进程退出。
- GD-Link/OpenOCD 继续使用 GDB 下载流程。

## 0.3.2 - 2026-08-19

- 修正 J-Link 就绪判断：监听端口不再代表已连接目标，必须等待目标连接成功后才启动 GDB。
- 识别 `InitTarget`、目标连接失败和 GDB 远程通信错误，立即停止并输出中文结果。
- 烧录运行中再次点击烧录按钮即可停止，同时支持取消进度通知。
- 将插件生成的烧录状态、结果和错误提示改为中文。

## 0.3.1 - 2026-08-19

- 修复烧录成功或失败后 GDB 未退出，导致后续一直提示已有烧录任务的问题。
- 正确拆分厂商 `.launch` 中以 XML 实体保存的多行 GDB 命令。
- 下载完成后自动复位并运行目标程序。
- 为 GDB 增加退出超时，并确保 GDB 和 GDB Server 最终被清理。

## 0.3.0 - 2026-08-19

- 将树形侧栏升级为可交互的配置面板。
- IDE 选择器支持当前路径、历史路径以及浏览选择 IDE 主程序。
- 构建配置直接读取 `.cproject`，烧录配置读取厂商 Eclipse `.launch`。
- 显示并可选择烧录文件，同时显示实际调试器和 GDB Server 类型。
- 新增编辑器顶部构建、烧录按钮，以及 `Ctrl+B`、`F11` Eclipse 风格快捷键。
- 烧录复用厂商启动配置执行 GDB 下载、复位和断开。

## 0.2.0 - 2026-08-19

- 新增 GD32 Eclipse 活动栏侧栏。
- 可在侧栏查看工程和配置，并修改 Embedded Builder、构建配置、Headless Workspace 及自动导入状态。
- 可直接从侧栏执行构建和清理后构建。

## 0.1.1 - 2026-08-19

- 默认按工程创建独立 Headless Workspace，避免与厂商 Eclipse GUI 发生 workspace 锁冲突。
- 支持显式配置共享或自定义 workspace。
- 自动导入尚未进入 Headless Workspace 的 Eclipse 工程。

## 0.1.0 - 2026-08-19

- 首个可用版本。
- 解析 `.project` 和 `.cproject`，识别 CDT Managed Build 配置。
- 通过 GD32 Embedded Builder Headless Build 执行构建和清理后构建。
