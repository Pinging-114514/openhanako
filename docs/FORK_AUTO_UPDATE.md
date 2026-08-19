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

## 最短上手路径

### 0. 已经做好的
- 更新源默认指向 `Pinging-114514/openhanako`
- OTA 走系统/手动代理 + 瞬态重试
- 签名公钥 `2026pinging` 已写入 `shared/artifact-core/pinned-keyset.json`（排第一，发版会用它）
- 私钥在仓库外：`E:\personal\HanaAgent\openhanako-secrets\hana-sign-private.pem`

### 1. 把私钥塞进 GitHub Secret
仓库 Settings → Secrets and variables → Actions → New repository secret：

- Name: `HANA_SIGN_KEY`
- Value: `hana-sign-private.pem` 的**全文**（含 BEGIN/END）

或用 gh：

```powershell
gh secret set HANA_SIGN_KEY --repo Pinging-114514/openhanako --body (Get-Content -Raw E:\personal\HanaAgent\openhanako-secrets\hana-sign-private.pem)
```

### 2. 打第一个正式包
推一个版本 tag，触发 `.github/workflows/build.yml`：

```powershell
git tag v0.447.4-pinging.1
git push origin v0.447.4-pinging.1
```

成功后 GitHub Releases 会出现安装包；`publish-train` job 会写：
- `channels/stable.json`（+ `.sig`）
- `train-stable-N` 热更新归档

### 3. 装你自己的包
卸掉/覆盖当前官方 `0.446.6`，改装你 Release 里的 Windows 安装包。  
只有装了 fork 包，自动更新才会查你家仓库，而不是 `liliMozi/openhanako`。

### 4. 日常更新
以后每次：
1. 合代码到 `main`
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. 等 Actions 绿
4. 已安装客户端会自己检查；也可设置里手动检查更新

### 5. 梯子
Settings → 网络 用「系统代理」或填手动代理。TUN 全局模式通常最省心。

**不要把私钥提交进 git。**
