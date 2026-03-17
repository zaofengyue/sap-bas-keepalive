# 🚀 SAP BAS Keep Alive

自动保活 SAP Business Application Studio (BAS) Dev Space，防止长时间未使用导致空间休眠或被删除。

---

## 背景

SAP BTP Trial 版本的 BAS Dev Space 有以下限制：

- 长时间无操作后，Dev Space 会自动**休眠（STOPPED）**
- **超过 30 天**未运行的 Dev Space 将被**永久删除**

本项目通过 GitHub Actions 定时任务，每 25 分钟自动 ping 一次 BAS URL，保持 Dev Space 处于 **RUNNING** 状态。

---

## 工作原理

```
GitHub Actions Cron（每25分钟）
        ↓
   访问 BAS URL
        ↓
  BAS 平台检测到请求
        ↓
   Dev Space 保持活跃
```

> BAS 平台在检测到 HTTP 请求时会自动维持 Dev Space 运行状态，因此只需定期访问 URL 即可实现保活。

---

## 快速开始

### 第一步：获取 BAS URL

打开你的 BAS Dev Space，复制浏览器地址栏的域名部分：

```
https://xxxxxxxx.ap10.applicationstudio.cloud.sap
```

### 第二步：Fork 或克隆本仓库

```bash
git clone https://github.com/your-username/sap-bas-keepalive.git
cd sap-bas-keepalive
```

### 第三步：配置 GitHub Secret

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret 名称 | 说明 | 示例 |
|---|---|---|
| `BAS_URL` | 你的 BAS Dev Space 地址 | `https://xxxxxxxx.ap10.applicationstudio.cloud.sap` |

### 第四步：启用 GitHub Actions

将 `.github/workflows/bas-keepalive.yml` 推送到仓库后，Actions 会自动启用。

也可以手动触发测试：**Actions → SAP BAS Keep Alive → Run workflow**

---

## 文件结构

```
.
├── .github/
│   └── workflows/
│       └── bas-keepalive.yml   # GitHub Actions 工作流
└── README.md                   # 本文档
```

---

## Workflow 说明

`.github/workflows/bas-keepalive.yml`

```yaml
name: SAP BAS Keep Alive

on:
  schedule:
    - cron: '*/25 * * * *'   # 每25分钟执行一次（UTC时间）
  workflow_dispatch:           # 支持手动触发

jobs:
  keepalive:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Ping BAS to keep it alive
        run: |
          BAS_URL="${{ secrets.BAS_URL }}"
          MAX_RETRY=6
          WAIT_SEC=30
          ...
```

**重试机制：**
- 每次执行最多重试 **6 次**
- 每次重试间隔 **30 秒**
- 总等待时间约 **3 分钟**，足够 BAS 完成冷启动
- 全部失败后不报错，**25 分钟后**自动再次尝试

---

## 各区域配置

根据你的 BTP 区域，BAS URL 格式如下：

| 区域 | URL 格式 |
|---|---|
| 新加坡（ap10） | `https://xxx.ap10.applicationstudio.cloud.sap` |
| 澳大利亚（ap10） | `https://xxx.ap10.applicationstudio.cloud.sap` |
| 欧洲（eu10） | `https://xxx.eu10.applicationstudio.cloud.sap` |
| 美国东部（us10） | `https://xxx.us10.applicationstudio.cloud.sap` |
| 韩国（ap12） | `https://xxx.ap12.applicationstudio.cloud.sap` |

---

## 注意事项

- **GitHub Actions 免费额度**：公开仓库完全免费；私有仓库每月有 2000 分钟免费额度，本项目每月消耗约 720 分钟（每天 48 次 × 约 0.5 分钟）
- **Trial 账号限制**：保活只能防止休眠，无法绕过 SAP 对 Trial 账号的其他限制
- **30 天删除规则**：只要 Dev Space 保持 RUNNING 状态，就不会触发 30 天删除机制
- **密码安全**：本方案只需要 BAS URL，无需账号密码，安全性高

---

## 日志示例

执行成功时的 Actions 日志：

```
⏰ Tue Mar 17 09:25:00 UTC 2026
🎯 Target: https://xxxxxxxx.ap10.applicationstudio.cloud.sap

🔄 Attempt 1/6
   Status: HTTP 302
✅ BAS is alive!
```

BAS 刚唤醒时（需要重试）：

```
🔄 Attempt 1/6
   Status: HTTP 000
   ⏳ Waiting 30s...

🔄 Attempt 2/6
   Status: HTTP 302
✅ BAS is alive!
```

---

## License

MIT
