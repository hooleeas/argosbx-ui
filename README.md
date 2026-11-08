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

## Docker

先生成管理员密码（只需一次，密码写入 `.env` 并显示一次，请妥善保存）：

```bash
[ -f .env ] || { echo "ADMIN_PASSWORD=$(cat /proc/sys/kernel/random/uuid)" > .env && chmod 600 .env && cat .env; }
```

Run the current image:

```bash
docker run -d --name argosbx-web --restart=always \
  --privileged --pid=host \
  -p 3100:3100 \
  --env-file .env \
  -e DATA_DIR=/data \
  -v ./data:/data \
  -v /root/agsbx:/root/agsbx \
  -v /root/ygkkkca:/root/ygkkkca:ro \
  -v /root/websbx:/root/websbx:ro \
  -v /root/bin:/root/bin:ro \
  hooleeas/argosbx-ui:latest
```

Check the service:

```bash
curl http://localhost:3100/api/health
```

It should return `{"ok":true,...}`.

Then open `http://<服务器地址>:3100` and log in with the admin password.

Docker Compose:

```yaml
services:
  argosbx-ui:
    image: hooleeas/argosbx-ui:latest
    container_name: argosbx-web
    restart: always
    privileged: true
    pid: host
    ports:
      - "3100:3100"
    env_file:
      - .env
    environment:
      - DATA_DIR=/data
    volumes:
      - ./data:/data
      - /root/agsbx:/root/agsbx
      - /root/ygkkkca:/root/ygkkkca:ro
      - /root/websbx:/root/websbx:ro
      - /root/bin:/root/bin:ro
```

To update to the latest image, remove the running container before starting the new one because it uses port `3100`:

```bash
docker rm -f argosbx-web
docker pull hooleeas/argosbx-ui:latest
docker run -d --name argosbx-web --restart=always \
  --privileged --pid=host \
  -p 3100:3100 \
  --env-file .env \
  -e DATA_DIR=/data \
  -v ./data:/data \
  -v /root/agsbx:/root/agsbx \
  -v /root/ygkkkca:/root/ygkkkca:ro \
  -v /root/websbx:/root/websbx:ro \
  -v /root/bin:/root/bin:ro \
  hooleeas/argosbx-ui:latest
```

### 找回管理员密码

密码只保存在部署目录的 `.env` 文件中：

```sh
sed -n 's/^ADMIN_PASSWORD=//p' .env
```

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
