# 架构与诊断

## 服务组成

插件在 `mcp.json` 中声明两个本地 stdio MCP 服务：

| 服务               | 职责                                              |
| ------------------ | ------------------------------------------------- |
| `mobile-use-codex` | 设备监看、MCP Apps UI、采集与操作租约             |
| `mobile-control`   | 内置上游 mobile-mcp，提供 `mobile_*` 设备操作工具 |

两个服务通过 `scripts/launch.mjs` 启动，首次使用时按 lockfile 安装运行依赖。安装锁防止两个服务同时安装，安装日志写入 stderr，不混入 MCP 协议。操作工具保留上游参数、注解与截图结果；skill 在设备任务外围协调监看租约。

```text
Codex → mobile-control → mobile-mcp → mobilecli → 设备操作
Codex → mobile-use-codex → 共享采集服务 → mobilecli → JPEG 帧
                              ↓
                      MCP 工具桥 → 侧栏 widget
```

## 采集生命周期

共享服务通过用户私有 Unix socket 连接，启动锁防止重复创建。所有连接按设备 ID 复用采集，旧采集进程退出后才允许重启。

共享目录固定为 `~/.codex/mobile-codex/runtime`，兼容不同插件名称使用同一采集服务；可通过 `MOBILE_CODEX_RUNTIME_DIR` 隔离测试环境。

1. `open_monitor` 创建或复用监看，返回当前连接的主要操作租约。
2. 操作期间每约 45 秒调用 `renew_operation`；90 秒未续租自动回收。
3. 完成、失败、取消或等待用户前调用 `end_operation`。最后一个活动操作结束后停止采集，其他连接的操作不受影响。

独立并行任务可用 `begin_operation` 创建额外租约。`close_monitor` 只释放当前连接的操作。MCP 正常退出时释放本连接租约，异常退出由超时回收。

观看连接不维持操作租约，零活动操作时不能恢复采集；无人观看时也停止采集。面板停止后保留最后一帧，并标明采集已停止。

新连接会刷新共享服务使用的 mobilecli 路径和诊断页面模板，运行中的采集保持原进程。

## 画面与面板

widget 通过 `read_frame` 获取最新 JPEG 帧，丢弃积压帧；暂停或关闭时调用 `release_frame_viewer`。这两个工具仅供 widget 使用，Agent 通过元素树或截图判断设备页面。

默认请求 30 fps、0.5 缩放，实际帧率取决于设备和传输性能。UI 首选 `fullscreen` 显示模式，在 Codex 中对应右侧面板；用户收回后不反复自动展开。

诊断 HTTP 接口仅监听 `127.0.0.1`，使用随机会话 token。画面不落盘，也不逐帧传给模型。

## 诊断

- 先通过设备发现确认设备在线、已解锁，连接与设备端 agent 正常。
- 用 `monitor_status` 查看采集状态和活动操作数，该工具不会启动采集。
- 操作存在但没有画面时，检查 widget 观看连接；无首帧 20 秒或中途无帧 10 秒会提示重连。

在插件目录执行真机验证：

```sh
npm run smoke -- --device '<实际在线设备 ID>'
```

`scripts/smoke.mjs` 验证内置控制服务的设备与页面读取、连续画面传输，以及操作结束后的停止采集；不改变设备页面、不保存画面，也不验证客户端 UI 渲染。
