# argosbx-ui

[ArgoSBX](https://github.com/yonggekkk/argosbx) 的 Web 管理界面。只管理变量、显示状态；每次改动通过 `rep` 重跑上游脚本、带完整变量组生效。证书用 [acme-yg](https://github.com/yonggekkk/acme-yg)。

## 功能

- 服务器状态：隧道、证书、订阅、节点
- 协议：按 sing-box / Xray / 双核分组，开关启用；端口留空沿用旧端口，没有旧端口则 rep 时随机分配
- Argo 隧道：固定（域名 + token）或临时；选了 Argo 协议会自动启用对应协议
- 证书：内置自签或域名证书；查看、申请、删除
- 订阅：分组、命名链接、过期时间
- 操作：更新 Xray / sing-box / cloudflared、重启服务、从服务器导入变量
- 安全改动：先干跑看差异，界面确认后执行，rep 前自动备份；UUID 和 token 不会被改动，API 与日志里全部打码

## 要求

- 已装 ArgoSBX 的 Linux 服务器（x86_64 / ARM）
- Docker（compose 方式需要 Docker Compose）
- 上游 beta 分支：第一次 rep 会把 main 分支的安装升到 beta

## Docker

容器需要 `--privileged --pid=host`，才能在宿主机命名空间里跑上游脚本。

运行当前镜像：

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

检查服务：

```bash
curl http://localhost:3100/api/health
```

应返回 `{"ok":true,...}`。

然后打开 `http://<server>:3100`，用管理员密码登录。

Docker Compose：

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

更新到最新镜像前，先删掉正在跑的容器，因为它占着 `3100` 端口：

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

密码只保存在部署目录的 `.env` 里。部署脚本（`run.sh` / `compose.sh`）会自动把项目里的 `sbpass` 装到 `/usr/local/bin/sbpass`，SSH 进 VPS 后直接输 `sbpass` 就显示密码（没有 `.env` 时先生成一个）：

```sh
sbpass
```

没装 `sbpass` 时也可以直接读：

```sh
sed -n 's/^ADMIN_PASSWORD=//p' .env
```

## 使用

1. 先在操作页从服务器导入变量。
2. 改协议、隧道、证书或订阅，保存后先预览差异（还没生效）。
3. 在操作页确认后执行 rep。rep 期间订阅会短暂中断。

## 注意

- 如果正在用域名证书、但存的选择不对，导入时会提示修正，rep 就不会切回自签。
- `alns` 开着但服务器上没有证书时，rep 会被拒绝——先申请证书。
- IP 证书只有 3 天有效期。
- 没有一键删除：上游的 `del` 会删掉整个 ArgoSBX 和订阅目录。
