# Eclipse CDT Bridge

在 Visual Studio Code 中复用 Eclipse CDT 工程的构建和烧录配置。插件读取 `.project`、`.cproject` 和 Eclipse `.launch`，不会修改厂商工程文件。界面语言自动跟随 VS Code 显示语言，支持中文和英文。

当前版本：`0.4.1`

## 功能

- 解析 Eclipse CDT 工程名和 Managed Build 配置。
- 调用厂商 Eclipse headless 命令行程序（`eclipsec.exe` 或厂商 `*c.exe`）编译。
- 构建前由 CDT 自动更新生成的 Makefile。
- 工程不在 Eclipse workspace 时自动导入。
- 提供普通 Build 和 Clean and Build 任务。
- 支持从命令面板切换 `.cproject` 中已有的构建配置。
- 提供 Eclipse CDT Activity Bar 侧栏，集中显示和修改构建配置。
- 读取厂商 Eclipse 启动配置中的烧录文件、调试器、GDB Server、端口和下载命令。
- 支持解析 GD32 启动配置，以及 Flagchip FC IDE 的 J-Link/OpenOCD 启动配置。
- 提供编辑器顶部 Build 和 Flash 按钮，并支持 4 组可切换图标。
- Flash 按钮执行“构建当前配置 → 构建成功后烧录”；构建失败时不会烧录旧文件。
- 使用 Eclipse 风格快捷键：`Ctrl+B` 构建，`F11` 烧录。
- 与厂商 Eclipse GUI 共用 `.project`、`.cproject` 和构建目录。

## 使用

1. 在 VS Code 中打开包含 `.project` 和 `.cproject` 的工程。
2. 点击 Activity Bar 中的芯片图标打开 `Eclipse CDT` 侧栏。
3. 点击 `Eclipse IDE 客户端` 选择项，再通过“浏览 Eclipse IDE 客户端程序...”选择主程序 EXE，例如 `GD32EmbeddedBuilder.exe`、`Flagchip_FC_IDE.exe` 或标准 `eclipse.exe`。用户不需要寻找命令行构建器、workspace、J-Link、OpenOCD 或 GDB；插件会从主程序所在目录自动查找，已选择的主程序会保留在历史列表中。
4. 一般不需要修改构建配置；需要切换 Debug 或 Release 时，在底部 `其他设置` 折叠区选择 `.cproject` 自带的配置。
5. 在 `Flash configuration` 中选择厂商 Eclipse 保存的启动配置。
6. 检查自动带出的烧录文件和 Debugger 字段，必要时重新选择 ELF、AXF、OUT、HEX 或 BIN 文件。工程内文件保存并显示为相对路径，例如 `Debug_FLASH/FC_DC50_IHU.elf`。
7. 使用编辑器顶部按钮、侧栏按钮或快捷键执行 Build 和 Flash。Flash 会先构建当前选中的 CDT 配置，成功后才开始烧录。

编辑器顶部 Build/Flash 按钮图标可以通过设置 `eclipseBridge.toolbarIcons` 切换，也可以执行 `Eclipse CDT: Select Toolbar Icon Theme` 命令选择。当前提供 4 组图标：工具、芯片、经典和打包。

普通 J-Link 配置使用厂商 IDE 自带的 J-Link Commander 执行一次性下载、复位、运行和退出；Flagchip 自定义设备 XML 只能由 J-Link GDB Server 接收，因此 FC J-Link 自动改走 GDB Server + GDB 下载。GD-Link/OpenOCD 配置也通过对应 GDB Server 完成下载。侧栏的“其他设置”折叠区集中放置低频设置，包括构建配置、Headless Workspace 模式和自动导入状态。

烧录过程中再次点击 Flash，或取消 VS Code 的烧录进度通知，可以立即停止当前任务。插件生成的连接、成功、失败和停止结果会根据 VS Code 界面语言输出中文或英文；J-Link/OpenOCD/GDB 自身的原始日志保持原文。

默认在 VS Code 扩展存储目录中为每个工程创建独立的 Headless Workspace，避免与正在运行的厂商 Eclipse GUI 争用 workspace 锁。可以通过 `eclipseBridge.workspacePath` 显式指定其他 Eclipse workspace。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `eclipseBridge.installationPath` | 空 | Eclipse IDE主程序路径，例如 `eclipse.exe`、`GD32EmbeddedBuilder.exe` 或 `Flagchip_FC_IDE.exe`。插件自动寻找命令行构建器和配套工具。 |
| `eclipseBridge.workspacePath` | 空 | Headless Build 使用的 Eclipse workspace。留空时按工程创建独立 workspace。 |
| `eclipseBridge.configuration` | 空 | `.cproject` 中的 CDT 构建配置。留空时优先选择名称包含 Debug 的配置。 |
| `eclipseBridge.launchConfiguration` | 空 | 用于 Flash 的厂商 Eclipse `.launch` 配置。留空时选择当前工程的第一个可用配置。 |
| `eclipseBridge.elfPath` | 空 | 用于 Flash 的烧录文件，支持选择 ELF、AXF、OUT、HEX 和 BIN。工程内文件保存为相对路径；留空时使用 `.launch` 中的程序路径。 |
| `eclipseBridge.autoImport` | `true` | 工程尚未出现在 Headless Workspace 中时，自动执行导入。 |
| `eclipseBridge.toolbarIcons` | `tools` | 编辑器顶部 Build/Flash 按钮图标主题，可选 `tools`、`hardware`、`build`、`package`。 |

## 工作方式

```text
VS Code command/task
  -> eclipsec.exe (or vendor *c.exe)
  -> org.eclipse.cdt.managedbuilder.core.headlessbuild
  -> vendor CDT plug-ins read .cproject
  -> generated Makefiles are refreshed
  -> vendor Make/GCC build the ELF/HEX/BIN

VS Code Flash
  -> run the selected Eclipse CDT build and wait for exit code 0
  -> read the Eclipse .launch from the vendor IDE workspace
  -> J-Link: run JLink.exe LoadFile / Reset / Go / Exit
  -> Flagchip J-Link with vendor device XML: J-Link GDB Server + GDB
  -> GD-Link/OpenOCD: start GDB Server and run GDB download commands
  -> reset target and disconnect
```

## 注意事项

- 不要手工修改 Eclipse 生成的 `Debug/Makefile`、`sources.mk` 或 `subdir.mk`。
- 厂商 Eclipse GUI 与 Headless Build 不能同时占用同一个 workspace。插件默认使用独立 workspace；只有显式设置 `eclipseBridge.workspacePath` 时才可能再次发生锁冲突。
- 独立 workspace 只隔离 Eclipse 元数据；源码目录中的 `.project`、`.cproject` 和构建输出仍与厂商 Eclipse 兼容。
- 不要让厂商 Eclipse 和 VS Code 同时编译同一个构建配置，否则双方可能同时改写生成的 Makefile 或目标文件。
- 工程名称相同但目录不同的工程不要导入同一个 Eclipse workspace。
- Flash 配置默认读取厂商 IDE 目录下 `workspace/.metadata/.plugins/org.eclipse.debug.core/.launches`，也读取工程根目录中共享的 `.launch`。
- Flash 直接使用 `.launch` 中记录的 GDB Server 和 GDB 工具。切换 J-Link/GD-Link 后，应先在厂商 Eclipse 中保存对应启动配置。
- 文件选择器允许选择常见烧录格式，但实际支持范围由底层工具决定。BIN 不携带目标地址，通常还需要在对应烧录工具或启动配置中设置 Flash 起始地址；当前 GDB `load` 流程优先使用 ELF/AXF 等带地址信息的文件。
- `Ctrl+B` 和 `F11` 只在检测到 Eclipse CDT 工程且编辑器有焦点时覆盖 VS Code 原快捷键。

## 常见问题

### `Workspace already in use`

这表示 Headless Build 与另一个 Eclipse 进程使用了相同 workspace。清空 `eclipseBridge.workspacePath` 可恢复插件默认的独立 workspace；也可以关闭占用该 workspace 的厂商 Eclipse 后再运行。不要删除仍被 Eclipse 使用的 `.lock` 文件。

### 找不到工程或构建配置

确认 VS Code 打开的目录中同时存在 `.project` 和 `.cproject`，再执行 `Eclipse CDT: Show Project Information` 查看插件识别到的工程名和配置。传给 CDT 的名称必须与 `.cproject` 中记录的名称完全一致。

### 修改源码后 Makefile 没有更新

插件依赖厂商 CDT Managed Build 插件刷新 Makefile。不要绕过 headless 命令行程序直接调用旧 Makefile；如果刷新仍失败，应先用厂商 Eclipse 确认该工程和对应配置可以正常生成构建文件。

## 项目结构

```text
src/extension.js          VS Code 命令、任务和配置入口
src/i18n.js               中英文界面文案与语言切换
src/project-model.js      .project/.cproject 解析与配置选择
src/headless-command.js   Headless Build 命令参数生成与 IDE 路径识别
src/launch-model.js       Eclipse .launch 解析、烧录文件和 Debugger 字段
src/flash-runner.js       GDB Server 启动与批量烧录
src/sidebar-provider.js   交互式 Activity Bar 侧栏
media/eclipse-cdt.svg     Activity Bar 侧栏图标
test/project-model.test.js
                          Eclipse 工程解析单元测试
package.json              扩展清单、命令和配置定义
package.nls.json          英文界面文案
package.nls.zh-cn.json    中文界面文案
```

## 开发与验证

```powershell
npm install
npm test
node --check src/extension.js
node --check src/project-model.js
node --check src/headless-command.js
node --check src/launch-model.js
node --check src/flash-runner.js
node --check src/sidebar-provider.js
node --check src/i18n.js
```

单元测试只验证插件逻辑，不会编译 MCU 工程。涉及厂商 Eclipse 版本、工程导入或 Makefile 生成行为的改动，还需要选取实际工程做人工验证。

## 打包与发布

```powershell
npm install
npm test
npm run package
```

生成的 `.vsix` 可以通过 VS Code 的 `Extensions: Install from VSIX...` 安装。

发布新版本时：

1. 更新 `package.json` 中的版本号。
2. 同步更新本 README 的“当前版本”、相关功能/配置说明和“版本记录”。
3. 运行测试和 JavaScript 语法检查。
4. 执行 `npm run package` 生成 VSIX。

`node_modules/`、测试覆盖率目录和生成的 `*.vsix` 不纳入 Git 版本控制。打包时同时排除测试、`.codegraph` 和 `.omo` 等开发期文件。

## 维护约定

每次修改插件时都必须同步检查并更新本 README。新增或变更功能、命令、配置、兼容性、使用步骤、限制和版本号时，应在同一次提交中更新对应说明；即使改动不影响文档，也应确认现有说明仍与实现一致。

## 版本记录

### 0.4.1

- 适配 Flagchip FC IDE 的 J-Link/OpenOCD `.launch`，读取 FC 芯片型号、接口、速度、端口和烧录文件。
- 自动定位 FC IDE 内置的 J-Link GDB Server、OpenOCD、GDB 和 `JLinkDevices.xml`。
- FC 自定义 J-Link 设备使用支持设备 XML 的 J-Link GDB Server + GDB 流程，并按 SEGGER 语法分开发送 reset、halt 和 load 命令。

### 0.4.0

- 插件改名为 Eclipse CDT Bridge，不再限定 GD32，可对接不同厂商的 Eclipse CDT headless builder。
- 界面语言自动跟随 VS Code 显示语言，支持中文和英文。
- 新增 `eclipseBridge.toolbarIcons` 设置和 `Eclipse CDT: Select Toolbar Icon Theme` 命令，提供 4 组 Build/Flash 图标。
- 命令、配置和上下文前缀统一改为 `eclipseBridge.*`，旧 `gd32EclipseBridge.*` 配置自动迁移。
- Headless 命令行程序识别逻辑泛化，支持 `eclipsec.exe` 和任意厂商 `*c.exe`。
- IDE选择改为只选择主程序EXE，并自动归一化旧的目录或命令行程序历史记录。
- Flash 改为构建并烧录：先等待当前 CDT 配置构建成功，失败时取消烧录；再次点击可停止当前构建或烧录任务。
- 已验证自动识别 GD32 Embedded Builder 1.5.6、1.5.10和Flagchip FC IDE 4.3.1的命令行构建入口。
- 自动读取IDE最近使用的workspace；`.launch` 中工具路径失效时，从IDE目录查找J-Link GDB Server、OpenOCD和GDB。
- 仅将与 `JLinkGDBServerCL.exe` 同目录的 `JLink.exe` 识别为SEGGER工具，避免误用Java运行时的同名程序。
- 烧录文件选择器支持 ELF、AXF、OUT、HEX 和 BIN；工程内文件以工程相对路径保存和显示。
- 将低频使用的 Build configuration 移入侧栏底部“其他设置”折叠区。
- 侧栏、提示和烧录日志全部接入中英文文案。

### 0.3.3

- 根据厂家 Eclipse 成功日志调整 J-Link 烧录方式。
- J-Link 改用同一 SEGGER 安装中的 J-Link Commander，复用 `.launch` 的芯片、接口和速度参数。
- 使用 `LoadFile -> Reset -> Go -> Exit` 完成一次性烧录，确保程序运行且烧录进程退出。
- GD-Link/OpenOCD 仍使用 GDB 下载流程。

### 0.3.2

- 修正 J-Link 就绪判断：监听端口不代表已连接目标，必须等待目标连接成功后才启动 GDB。
- 识别 `InitTarget`、目标连接失败和 GDB 远程通信错误，立即停止并给出中文结果。
- Flash 运行中再次点击 Flash 即可停止，同时支持取消进度通知。
- 将插件生成的烧录状态、结果和错误提示改为中文。

### 0.3.1

- 修复烧录成功或失败后 GDB 未退出，导致后续一直提示已有 Flash 任务的问题。
- 正确拆分厂家 `.launch` 中以 XML 实体保存的多行 GDB 命令。
- 下载完成后自动复位并运行目标程序。
- 为 GDB 增加 60 秒退出超时，并确保 GDB 和 GDB Server 最终被清理。

### 0.3.0

- 将树形侧栏升级为可交互的配置面板。
- IDE 选择器支持当前路径、历史路径，以及浏览选择 IDE 主程序 EXE。
- 构建配置直接读取 `.cproject`；Flash 配置读取厂家 Eclipse `.launch`。
- 显示并可选择烧录文件，显示实际 Debugger 与 GDB Server 类型。
- 新增编辑器顶部 Build/Flash 按钮，以及 `Ctrl+B`/`F11` Eclipse 风格快捷键。
- Flash 复用厂家启动配置执行 GDB 下载、复位和断开。

### 0.2.0

- 新增 GD32 Eclipse Activity Bar 侧栏。
- 可在侧栏中查看工程和配置，并点击修改 Embedded Builder、构建配置、Headless Workspace 及自动导入状态。
- 可直接从侧栏执行 Build 与 Clean and Build。

### 0.1.1

- 默认按工程创建独立 Headless Workspace，避免与厂家 Eclipse GUI 发生 workspace 锁冲突。
- 支持显式配置共享或自定义 workspace。
- 自动导入尚未进入 Headless Workspace 的 Eclipse 工程。

### 0.1.0

- 首个可用版本。
- 解析 `.project` 和 `.cproject`，识别 CDT 构建配置。
- 通过 GD32 Embedded Builder Headless Build 执行 Build 与 Clean and Build。
