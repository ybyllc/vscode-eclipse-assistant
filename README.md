# GD32 Eclipse Bridge

在 Visual Studio Code 中调用兆易创新 GD32 Embedded Builder 的 CDT Headless Build。插件读取 `.project` 和 `.cproject` 中的工程名、Debug/Release配置，但不会自行生成 Makefile；Makefile仍由厂家 Eclipse插件生成。

当前版本：`0.2.0`

## 功能

- 解析 Eclipse CDT工程名和 Managed Build配置。
- 调用厂家 `GD32EmbeddedBuilderc.exe` 编译。
- 构建前由 CDT自动更新生成的 Makefile。
- 工程不在 Eclipse workspace时自动导入。
- 提供普通 Build和 Clean and Build任务。
- 支持从命令面板切换 `.cproject` 中已有的构建配置。
- 提供 GD32 Eclipse Activity Bar侧栏，集中显示和修改构建配置。
- 与厂家 Eclipse GUI共用 `.project`、`.cproject` 和构建目录。

## 使用

1. 在 VS Code中打开包含 `.project` 和 `.cproject` 的工程。
2. 点击 Activity Bar中的 GD32芯片图标打开 `GD32 Eclipse` 侧栏。
3. 选择包含 `GD32EmbeddedBuilderc.exe` 的目录，例如 `D:\GD32embeddedBuilder\GD32EB_v1.5.10_Rel\GD32EB`。
4. 点击 `Build Configuration`，选择 `.cproject` 中已有的构建配置。
5. 点击侧栏中的 `Build` 或 `Clean and Build`。

侧栏还可以切换 Headless Workspace模式和自动导入状态。所有功能仍可通过 `GD32 Eclipse: ...` 命令以及 `Ctrl+Shift+B` 使用。

默认在 VS Code扩展存储目录中为每个工程创建独立的 Headless Workspace，避免与正在运行的厂家 Eclipse GUI争用 workspace锁。可以通过 `gd32EclipseBridge.workspacePath` 显式指定其他 Eclipse workspace。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `gd32EclipseBridge.installationPath` | 空 | 包含 `GD32EmbeddedBuilderc.exe` 的目录，或该程序的完整路径。 |
| `gd32EclipseBridge.workspacePath` | 空 | Headless Build使用的 Eclipse workspace。留空时按工程创建独立 workspace。 |
| `gd32EclipseBridge.configuration` | 空 | `.cproject` 中的 CDT构建配置。留空时优先选择名称包含 Debug的配置。 |
| `gd32EclipseBridge.autoImport` | `true` | 工程尚未出现在 Headless Workspace中时，自动执行导入。 |

## 工作方式

```text
VS Code command/task
  -> GD32EmbeddedBuilderc.exe
  -> org.eclipse.cdt.managedbuilder.core.headlessbuild
  -> vendor CDT plug-ins read .cproject
  -> generated Makefiles are refreshed
  -> vendor Make/GCC build the ELF/HEX/BIN
```

## 注意事项

- 不要手工修改 Eclipse生成的 `Debug/Makefile`、`sources.mk` 或 `subdir.mk`。
- 厂家 Eclipse GUI与 Headless Build不能同时占用同一个 workspace。插件默认使用独立 workspace；只有显式设置 `gd32EclipseBridge.workspacePath` 时才可能再次发生锁冲突。
- 独立 workspace只隔离 Eclipse元数据；源码目录中的 `.project`、`.cproject`和构建输出仍与厂家 Eclipse兼容。
- 不要让厂家 Eclipse和 VS Code同时编译同一个构建配置，否则双方可能同时改写生成的 Makefile或目标文件。
- 工程名称相同但目录不同的工程不要导入同一个 Eclipse workspace。
- 本插件只负责兼容构建；烧录和调试建议继续使用 Cortex-Debug加当前已验证的 OpenOCD配置。

## 常见问题

### `Workspace already in use`

这表示 Headless Build与另一个 Eclipse进程使用了相同 workspace。清空 `gd32EclipseBridge.workspacePath` 可恢复插件默认的独立 workspace；也可以关闭占用该 workspace的厂家 Eclipse后再运行。不要删除仍被 Eclipse使用的 `.lock` 文件。

### 找不到工程或构建配置

确认 VS Code打开的目录中同时存在 `.project` 和 `.cproject`，再执行 `GD32 Eclipse: Show Project Information` 查看插件识别到的工程名和配置。传给 CDT的名称必须与 `.cproject` 中记录的名称完全一致。

### 修改源码后 Makefile没有更新

插件依赖厂家 CDT Managed Build插件刷新 Makefile。不要绕过 `GD32EmbeddedBuilderc.exe` 直接调用旧 Makefile；如果刷新仍失败，应先用厂家 Eclipse确认该工程和对应配置可以正常生成构建文件。

## 项目结构

```text
src/extension.js          VS Code命令、任务和配置入口
src/project-model.js      .project/.cproject解析与配置选择
src/headless-command.js   Headless Build命令参数生成
media/gd32.svg            Activity Bar侧栏图标
test/project-model.test.js
                          Eclipse工程解析单元测试
package.json              扩展清单、命令和配置定义
```

## 开发与验证

```powershell
npm install
npm test
node --check src/extension.js
node --check src/project-model.js
node --check src/headless-command.js
```

单元测试只验证插件逻辑，不会编译 MCU工程。涉及厂家 Embedded Builder版本、工程导入或 Makefile生成行为的改动，还需要选取实际 GD32工程做人工验证。

## 打包与发布

```powershell
npm install
npm test
npm run package
```

生成的 `.vsix` 可以通过 VS Code的 `Extensions: Install from VSIX...` 安装。

发布新版本时：

1. 更新 `package.json` 中的版本号。
2. 同步更新本 README的“当前版本”、相关功能/配置说明和“版本记录”。
3. 运行测试和 JavaScript语法检查。
4. 执行 `npm run package` 生成 VSIX。

`node_modules/`、测试覆盖率目录和生成的 `*.vsix` 不纳入 Git版本控制。

## 维护约定

每次修改插件时都必须同步检查并更新本 README。新增或变更功能、命令、配置、兼容性、使用步骤、限制和版本号时，应在同一次提交中更新对应说明；即使改动不影响文档，也应确认现有说明仍与实现一致。

## 版本记录

### 0.2.0

- 新增 GD32 Eclipse Activity Bar侧栏。
- 可在侧栏中查看工程和配置，并点击修改 Embedded Builder、构建配置、Headless Workspace及自动导入状态。
- 可直接从侧栏执行 Build与 Clean and Build。

### 0.1.1

- 默认按工程创建独立 Headless Workspace，避免与厂家 Eclipse GUI发生 workspace锁冲突。
- 支持显式配置共享或自定义 workspace。
- 自动导入尚未进入 Headless Workspace的 Eclipse工程。

### 0.1.0

- 首个可用版本。
- 解析 `.project` 和 `.cproject`，识别 CDT构建配置。
- 通过 GD32 Embedded Builder Headless Build执行 Build与 Clean and Build。
