# GitHub 分发

将本插件目录作为独立 GitHub 仓库根目录，保留 `.agents/plugins/marketplace.json`；不包含上层项目、`node_modules/`、`dist/` 或设备上下文。

1. 同步更新 `package.json`、`package-lock.json` 和 `plugin.json` 的版本。
2. 执行 `npm run check`、`npm run test:codex-tools`、`npm run package`，验证客户端实际暴露全部操作及监控工具，以及解压后的插件可首次启动。客户端验证所需环境变量见 [架构与诊断](architecture.md)。
3. 推送源码，创建与版本对应的 Git tag，将 `dist/` 中的 ZIP 和校验文件附到 GitHub Release。

用户可从 GitHub marketplace 安装：

```sh
codex plugin marketplace add dva2019ksy/mobile-use-codex --ref main --json
codex plugin add mobile-use-codex@mobile-use --json
```

发布包解压后也可使用 README 中的本地安装命令。首次启动会安装锁定的运行依赖；设备连接仍需按 mobile-mcp 要求准备。

同名市场已经配置为 Git 来源时，测试未推送的本地修复需临时将市场来源切换为本地源码。仅通过单次命令覆盖来源，重启同步时仍可能恢复 Git 中的旧版本。修复推送后恢复 Git 来源并重新安装，确认安装版本与提交一致。

这是 GitHub 分发流程。官方插件目录需另行完成开发者身份验证和审核，见 [官方提交文档](https://developers.openai.com/plugins/deploy/submission)。
