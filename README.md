# Mobile Use for Codex

Codex 移动设备操作与实时监看插件。内置 [mobile-mcp](https://github.com/mobile-next/mobile-mcp)，支持点击、滑动、输入、启动 App，并在 Codex 右侧面板显示实时画面，无需单独配置 mobile-mcp。

- 每台设备共享采集，最后一个活动操作结束后停止。
- 画面不保存到磁盘，也不逐帧发送给模型。
- 已验证 iPad；其他 iOS、Android 设备及模拟器需按设备验证。

## 安装

需要 macOS 或 Linux、Node.js 22.13+（22 LTS）或 24+、npm，以及支持本地插件和 MCP Apps 的 Codex 客户端。按 [mobile-mcp 文档](https://github.com/mobile-next/mobile-mcp)完成设备连接准备。

从 GitHub 安装：

```sh
codex plugin marketplace add dva2019ksy/mobile-use-codex --ref main --json
codex plugin add mobile-use-codex@mobile-use --json
```

下载源码或解压发布包后，也可在含 `plugin.json` 的目录执行 `codex plugin marketplace add . --json`，再安装插件。

重启 Codex 加载插件。首次启动自动通过 npm 安装锁定的运行依赖，需要网络，可能耗时较长；启动超时后可重试。安装失败时，可在报错中显示的插件目录手动执行 `npm ci --omit=dev --ignore-scripts`。

## 使用

```text
用 mobile-use-codex 打开 iPad 的拼多多，搜索 iqoo 手机，同时显示实时画面。
```

插件 skill 协调设备操作与监看租约，任务结束时释放采集。单独调用设备操作工具不会自动打开监看。

## 开发与打包

```sh
npm ci --ignore-scripts
npm run format
npm run check
CODEX_CLI='/absolute/path/to/codex' npm run test:codex-tools
npm run package
```

`dist/` 输出 ZIP 和 SHA-256 校验文件，不包含依赖和用户数据。打包需要系统提供 `zip` 命令。真机只读验证：`npm run smoke -- --device '<实际在线设备 ID>'`。

架构见 [docs/architecture.md](docs/architecture.md)，GitHub 分发见 [docs/releasing.md](docs/releasing.md)。

## 许可证

MIT · dva2019ksy。上游依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目由第三方开发。
