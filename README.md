# 🚀 SAP BAS Keep Alive

自动保活 SAP Business Application Studio (BAS) Dev Space，防止空间因长时间未使用而停止或被删除。

---

## 背景

SAP BTP Trial 版本的 BAS Dev Space 有以下限制：

- 长时间无操作后 Dev Space 会自动 **停止（STOPPED）**
- **超过 30 天**未运行的 Dev Space 将被**永久删除**

本项目通过 GitHub Actions 每小时自动登录 BAS，进入 Dev Space 并停留 60 秒，让平台持续记录活跃状态。

---

## 工作原理

```
每小时自动触发
      ↓
Playwright 模拟浏览器登录 BTP
      ↓
处理隐私声明弹窗
      ↓
检查 Dev Space 状态
      ↓
  ┌─ STOPPED ──▶ 点击 ▶ 启动 ──▶ 等待 RUNNING
  └─ RUNNING ──────────────────────────────┐
                                           ↓
                                   点击空间名进入编辑器
                                           ↓
                                    停留 60 秒 ✅
```

---

## 快速开始

### 第一步：Fork 本仓库

点击右上角 **Fork**，复制到自己账号下。

### 第二步：配置 GitHub Secrets

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加以下 4 个 Secret：

| Secret 名称 | 说明 | 示例 |
|---|---|---|
| `BAS_URL` | BAS 地址 | `https://xxxxx.ap21.applicationstudio.cloud.sap` |
| `BTP_USER` | BTP 登录邮箱 | `you@example.com` |
| `BTP_PASSWORD` | BTP 登录密码 | `your-password` |
| `BAS_SPACE_NAME` | Dev Space 名称 | `myspace` |

> BAS_URL 获取方式：登录 BAS 后复制浏览器地址栏的域名部分

### 第三步：手动触发测试

**Actions → SAP BAS Keep Alive → Run workflow**

看到 `✅ Done! Activity recorded.` 即表示成功。

---

## 文件结构

```
.
├── .github/
│   └── workflows/
│       └── bas-keepalive.yml   # 定时任务（每小时执行）
├── scripts/
│   └── bas-login.js            # 自动登录核心脚本
├── package.json
└── README.md
```

---

## 各区域 BAS URL 格式

| 区域 | URL 格式 |
|---|---|
| 日本东京（ap21） | `https://xxxxx.ap21.applicationstudio.cloud.sap` |
| 新加坡（ap10） | `https://xxxxx.ap10.applicationstudio.cloud.sap` |
| 欧洲（eu10） | `https://xxxxx.eu10.applicationstudio.cloud.sap` |
| 美国东部（us10） | `https://xxxxx.us10.applicationstudio.cloud.sap` |
| 韩国（ap12） | `https://xxxxx.ap12.applicationstudio.cloud.sap` |

---

## License

MIT
