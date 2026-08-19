# Fork 自动更新说明（Pinging-114514/openhanako）

## 两条更新水管

1. **壳更新**（整包安装器）：`desktop/auto-updater.cjs` → electron-updater → GitHub Releases  
2. **热更新**（只换 server/renderer）：`artifact-ota` → `channels/stable.json`（签名）→ train 归档

本 fork 默认更新源：`Pinging-114514/openhanako`。可用环境变量覆盖：

- `HANA_UPDATE_OWNER` / `HANA_UPDATE_REPO`
- `HANA_OTA_CHANNEL_MIRRORS`：逗号分隔的额外 channel base

## 代理

热更新现在会走 Settings → 网络 的代理设置：

- `manual`：用你填的 HTTP/HTTPS/SOCKS
- `system`：问 Electron 系统代理（梯子开系统代理时能吃到）
- `direct`：真直连

瞬态错误（`ECONNRESET` 等）会短退避重试 3 次。

## 自己发热更新要准备什么

1. 生成 Ed25519 密钥，公钥写入 `shared/artifact-core/pinned-keyset.json`  
2. 私钥放进 GitHub Secret：`HANA_SIGN_KEY`（整段 PEM）  
3. CI 打出 `vX.Y.Z` 安装包 Release  
4. 跑 `publish-train`（workflow 或 `node scripts/publish-train.mjs --tag vX.Y.Z --channel stable`）  
5. 客户端轮询 `.../releases/download/channels/stable.json`

密钥目录建议放在仓库外，例如 `E:\personal\HanaAgent\openhanako-secrets\`，**不要提交私钥**。
