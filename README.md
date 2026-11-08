# argosbx-ui

Web UI for [ArgoSBX](https://github.com/yonggekkk/argosbx). It only manages variables and shows status. Every change applies by re-running the upstream script with `rep`, using the full variable set. Certificates use [acme-yg](https://github.com/yonggekkk/acme-yg).

## Features

- Server status: tunnel, certificate, subscription, nodes
- Protocols: grouped by sing-box / Xray / both, toggle on or off; an empty port reuses the old port, or gets a random one on rep
- Argo tunnel: fixed (domain + token) or temporary; picking an Argo protocol auto-enables it
- Certificates: built-in self-signed or domain certificate; list, apply, delete
- Subscriptions: groups, named links, expiry
- Operations: update Xray / sing-box / cloudflared, restart services, import live variables
- Safe changes: dry-run diff first, confirm in the UI, auto-backup before rep; UUID and tokens are never changed and are masked in API responses and logs

## Requirements

- A Linux server with ArgoSBX installed (x86_64 / ARM)
- Docker (Docker Compose for the compose method)
- Upstream beta branch: the first rep upgrades a main-branch install to beta

## Docker

The container needs `--privileged --pid=host` to run the upstream script in the host namespace.

Generate the admin password once (written to `.env`, shown once):

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

Then open `http://<server>:3100` and log in with the admin password.

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

### Recover the admin password

The password lives only in `.env` in the deploy directory:

```sh
sed -n 's/^ADMIN_PASSWORD=//p' .env
```

## Usage

1. On the Operations page, import live variables from the server first.
2. Edit protocols, tunnel, certificates, or subscriptions, then save to preview the diff (not applied yet).
3. Confirm on the Operations page to run rep. The subscription drops briefly during rep.

## Notes

- If a domain certificate is in use but the stored choice says otherwise, import asks to fix it, so rep won't switch back to self-signed.
- With `alns` on but no certificate on the server, rep is refused — apply a certificate first.
- IP certificates last 3 days only.
- No one-click delete: upstream `del` removes the whole ArgoSBX and subscription directories.
