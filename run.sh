#!/bin/bash
# argosbx-ui run 脚本——docker run 方式一键部署。
# 镜像来自 Docker Hub（hooleeas/argosbx-ui），部署时自动拉取，无需本地构建。
# 在已安装 ArgoSBX 的服务器上运行，与 ./compose.sh（docker compose 方式）等价，
# 共用同一份 .env 与 ./data，任选其一即可。
# 管理员密码只保存在 ./.env（不进仓库）：
# 首次运行没有密码时自动生成一个随机 UUID 密码，写入 .env（600）并只显示一次。
set -e
cd "$(dirname "$0")"
# 部署自带 sbpass：装到 /usr/local/bin，SSH 进来输 sbpass 就显示管理员密码
if [ -f ./sbpass ]; then cp ./sbpass /usr/local/bin/sbpass && chmod +x /usr/local/bin/sbpass; fi
if [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD=$(cat /proc/sys/kernel/random/uuid)
  [ -f .env ] || { touch .env; chmod 600 .env; }
  sed -i '/^ADMIN_PASSWORD=/d' .env
  printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" >> .env
  chmod 600 .env
  echo "已生成管理员密码（仅显示一次，请妥善保存）：$ADMIN_PASSWORD"
fi
mkdir -p "$PWD/data"
docker pull hooleeas/argosbx-ui:latest
docker rm -f argosbx-ui 2>/dev/null || true
docker run -d --name argosbx-ui --restart unless-stopped \
  --privileged --pid=host \
  -p 3100:3100 \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e DATA_DIR=/data \
  -v "$PWD/data:/data" \
  -v /root/agsbx:/root/agsbx \
  -v /root/ygkkkca:/root/ygkkkca:ro \
  -v /root/websbx:/root/websbx:ro \
  -v /root/bin:/root/bin:ro \
  hooleeas/argosbx-ui:latest
docker logs --tail 20 argosbx-ui
echo
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$HOST_IP" ]; then echo "访问地址：http://$HOST_IP:3100"; else echo "访问地址：http://<服务器地址>:3100"; fi
echo "管理员密码在 .env 中，找回：sed -n 's/^ADMIN_PASSWORD=//p' .env"
