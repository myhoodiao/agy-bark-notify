# agy-bark-notify

在 Windows 上为 **Antigravity (`agy`)** 添加任务完成自动推送提醒：每次 `agy` 运行结束（正常完成、报错或触发上限），自动通过 **Bark 官方 API** 推送通知到手机，并附带当前会话名称。

## 推送效果

正常完成：

```text
[Dev · agy Task Completed]
本轮运行已正常结束。
会话：对齐需求与目标分析
```

运行报错：

```text
[Dev · agy Task Failed]
本轮运行因错误中止。
错误：generating and executing: PERMISSION_DENIED (code 403): ...
会话：对齐需求与目标分析
```

- 每次运行结束自动推送（仅跳过手动取消 `USER_CANCELED`）。
- 推送失败或超时不会阻断 `agy` 正常退出。
- Bark 配对令牌（Device Key）仅在本地 PowerShell 交互录入并保存在本机 `~/.gemini/config/bark-completion/config.json`，不提交到 Git 仓库。

## 环境要求

- Windows 10 / 11（PowerShell 5.1 或 PowerShell 7）
- Node.js **>= 22.5**（推荐 Node 24 LTS，使用内置 `node:sqlite`，零第三方依赖）
- 已安装 Antigravity (`agy`)
- 手机已安装 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) 并获取配对令牌（Device Key）

## 在另一台 Windows 设备上安装

在 PowerShell 中执行以下三步：

```powershell
git clone https://github.com/myhoodiao/agy-bark-notify.git
cd agy-bark-notify
.\scripts\install.ps1
```

如果系统提示“在此系统上禁止运行脚本”，改用下面这条命令执行安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

运行后按终端提示操作即可：
1. 输入本机显示名称（直接回车默认 `Dev`，将显示为 `[Dev · agy Task Completed]`）。
2. 输入 Bark 配对令牌 Device Key（输入时隐藏不回显；支持只粘贴 Key，也支持直接粘贴完整 `https://api.day.app/<Key>` 链接）。
3. 按回车发送一条测试推送，手机收到通知即安装完成。

## 常用维护命令

检查本机配置状态（不会打印令牌明文）：

```powershell
node --no-warnings "$HOME\.gemini\config\bark-completion\notify.cjs" --status
```

手动发送测试通知：

```powershell
node --no-warnings "$HOME\.gemini\config\bark-completion\notify.cjs" --test
```

修改设备名或更换 Bark 令牌：重新执行 `.\scripts\install.ps1` 即可覆盖更新。

卸载（仅移除 `hooks.json` 中的 `bark-completion` 节点，保留其他钩子）：

```powershell
.\scripts\uninstall.ps1
```

## 运行单元测试

```powershell
node --no-warnings --test .\src\notify.test.cjs
```
