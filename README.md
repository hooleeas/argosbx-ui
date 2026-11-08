# argosbx-ui

argosbx-ui 是 ArgoSBX 的 Web 管理界面。它只负责界面与变量存取，不重写部署逻辑：每次改动都调用上游脚本（[yonggekkk/argosbx](https://github.com/yonggekkk/argosbx)）以 `rep` 方式带全量变量组重跑生效。证书管理集成 [acme-yg](https://github.com/yonggekkk/acme-yg)。

## 功能

- **服务器状态**：隧道、证书、订阅、节点四张状态卡片，一眼看清当前运行情况
- **协议管理**：按 sing-box / Xray / 双核分组，拉杆开关启用或停用；端口留空沿用旧端口，没有旧端口时 rep 随机分配
- **Argo 隧道**：固定隧道（域名 + token）与临时隧道；选择 Argo 主协议时，对应协议自动打开
- **证书管理**：内置自签证书与域名证书二选一；查看、申请、删除证书
- **订阅管理**：订阅分组、命名订阅链接、过期时间
- **操作**：更新 Xray / sing-box / cloudflared 内核、重启全部服务、从服务器现状导入变量
- **安全改动流程**：保存后先干跑比对差异，界面确认后才执行 rep；执行前自动备份配置；UUID、隧道 token、订阅 token 不会被改动，API 与日志中全部打码

## 要求

- 一台已安装 ArgoSBX 的 Linux 服务器（x86_64 / ARM 均可）
- Docker（compose 方式还需要 Docker Compose）
- 上游脚本使用 beta 分支（提供 VLESS-xhttp-enc 固定隧道等新功能）；如果服务器上是 main 分支安装，首次 rep 会升级到 beta

## 部署

把代码放到服务器上，进入目录，任选一种方式一键部署（两者等价，共用同一份 `.env` 与 `./data`）：

### 方式一：Docker Compose

```sh
cd argosbx-ui
./compose.sh
```

之后日常启停直接用 `docker compose up -d` / `docker compose down`。

### 方式二：Docker run

```sh
cd argosbx-ui
./run.sh
```

首次运行如果没有管理员密码，部署脚本会随机生成一个 UUID 作为密码，写入 `.env`（仅保存在本机，不进仓库），并在终端显示一次，请妥善保存。

部署完成后打开 `http://<服务器地址>:3100`，用管理员密码登录。

> 两种方式不要混用管理同一个容器；切换方式前先停掉旧容器：`docker rm -f argosbx-web`。

### 找回管理员密码

密码只保存在部署目录的 `.env` 文件中，在服务器上、部署目录下执行：

```sh
sed -n 's/^ADMIN_PASSWORD=//p' .env
```

### 容器权限说明

容器以 `--privileged --pid=host` 运行，通过 `nsenter` 回到宿主机命名空间执行 `agsbx list/rep`，这样才能操作宿主机的服务与配置；同时挂载 ArgoSBX 数据目录与证书目录（证书只读）。没有这些权限，rep 与状态读取无法工作。

## 使用

1. 登录后先在「操作」页点「从服务器现状导入变量」，把已在跑的配置同步进数据库。
2. 在「协议」「隧道」「证书」「订阅」页改动，点「保存并预览改动」查看差异（尚未生效）。
3. 到「操作」页确认后执行 rep，改动才生效。rep 期间订阅会短暂中断，执行前会自动备份配置。

## 安全说明

- 任何 rep 之前：先展示改动差异、备份配置，界面确认后才执行。
- UUID、隧道 token、订阅 token 不会被自动改动；API 返回与日志均为打码形式。
- 证书选择与现状不一致时（例如已在用域名证书），导入时会提示补齐，避免 rep 切回自签证书。
- `alns` 已开启但服务器上没有证书时，rep 会被直接拒绝，请先在证书页申请证书。
- IP 证书有效期只有 3 天。
- 暂不支持一键删除（上游 `del` 会删除整个 ArgoSBX 与订阅目录）。

## 技术栈

- 后端：TypeScript + Hono（Bun），SQLite
- 前端：纯 HTML + 模块 JS，无重型框架
- 上游：[yonggekkk/argosbx](https://github.com/yonggekkk/argosbx)（beta 分支）、[yonggekkk/acme-yg](https://github.com/yonggekkk/acme-yg)
