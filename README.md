# Claude Code Dashboard

Claude Code 远程开发平台 — 一次部署，任意设备，随时接入。

在浏览器中管理和运行 Claude Code 的 Web 方案。自动扫描项目目录，选择项目即可在浏览器内启动完整的 Claude Code 交互式终端。适用于任何安装了 Node.js 和 Claude Code 的 Mac，通过局域网访问，可在手机、平板或其他电脑上远程操作。

## 功能

- **用户登录** — 内置认证系统，支持多用户隔离
- **自动项目发现** — 扫描 `~/projects/` 目录，按使用频率排序
- **原生终端体验** — 基于 xterm.js，完整支持 Claude Code 交互式界面
- **多会话管理** — 同一项目可开多个 Claude 会话，自由切换
- **进程保活** — 关闭浏览器不丢失会话，重连后自动回放输出
- **会话恢复** — 支持 `claude --resume` 恢复历史对话上下文
- **重启可恢复** — PM2 重启后，可通过 resume 恢复之前的对话
- **移动端适配** — 响应式布局，iPad / 手机可用
- **资源监控** — 状态栏显示会话数和内存，点击查看详情
- **Git Clone** — 侧边栏粘贴 git 地址即可 clone 新项目
- **优雅停机** — SIGTERM/SIGINT 信号自动清理所有会话进程

## 快速开始

```bash
git clone https://gitee.com/xiangboit/claude-code-remote.git
cd claude-code-remote
npm install
npm start
```

访问 http://localhost:3000 ，首次启动会进入注册页面创建管理员账户。

### PM2 持久化运行（推荐）

```bash
npm install -g pm2
pm2 start server.js --name claude-dashboard --watch
pm2 startup  # 按提示执行 sudo 命令
pm2 save
```

## 前提条件

- macOS
- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已安装
- 项目存放在 `~/projects/` 目录下

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端终端 | xterm.js + xterm-addon-fit | 浏览器内终端模拟 |
| 前端框架 | 原生 HTML/CSS/JS | 无构建步骤 |
| 后端 | Express + ws | REST API + WebSocket |
| 进程管理 | node-pty | PTY 进程池 |
| 数据库 | better-sqlite3 (WAL) | 用户、项目统计 |
| 部署 | PM2 | 自动重启 + 开机自启 |

## 项目结构

```
server.js          — 后端（Express + WebSocket + PTY 进程池 + 认证）
public/index.html  — 页面（登录页 + 主应用）
public/app.js      — 前端逻辑（终端、会话管理、认证）
dashboard.db       — SQLite 数据库（自动创建）
test.js            — 测试
```

## 测试

```bash
npm test
```
