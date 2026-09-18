# 国内 CloudBase 免费部署方案

## 目标架构

```text
国内浏览器
  -> CloudBase 云托管（Docker / Node.js）
  -> /var/data（挂载 CloudBase 对象存储）
  -> sandboxes/<sandbox-id>.sqlite
```

项目继续使用现有 Node.js API、HttpOnly Session、CSRF 校验和独立 SQLite 演示沙箱。
云托管只保留一个实例，`/var/data` 挂载对象存储，避免实例缩容或重建导致沙箱数据立即丢失。

## 云托管配置

- 服务名称：`zhixue-dual-engine`
- 部署来源：公开 Git 仓库 `https://github.com/zhoulyle224-web/zhixue`
- 分支：`main`
- 构建方式：仓库根目录 `Dockerfile`
- 服务端口：`8080`
- 最小实例数：`0`
- 最大实例数：`1`
- 健康检查：`/api/health`
- 对象存储挂载目录：`/var/data`

环境变量：

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
ZHIXUE_DATA_DIR=/var/data
ZHIXUE_COOKIE_SECURE=1
ZHIXUE_TRUST_PROXY=1
ZHIXUE_SANDBOX_TTL_HOURS=24
ZHIXUE_STORAGE_BACKEND=cloudbase-cos
```

## 安全与费用边界

- 免费体验环境不启用按量付费；资源点耗尽时宁可停服，不自动产生费用。
- 默认域名只用于参赛演示，不承载真实学生数据。
- 仅发布匿名合成数据；每个浏览器获得独立沙箱，24 小时无活动后自动清理。
- 免费默认域名可能有限频或安全提示。正式长期发布需要已备案自定义域名。

## 上线验收

1. `GET /api/health` 返回 `success: true` 与 `mode: public-sandbox`。
2. 教师账号 `teacher2026 / demo123` 可以登录。
3. 学生账号 `student2026 / demo123` 可以登录。
4. 同一浏览器切换教师和学生时任务可见，不同浏览器的沙箱相互隔离。
5. 服务缩容并重新唤醒后，未过期沙箱仍能恢复。

