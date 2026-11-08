// argosbx-ui v0.1.0 — TS + Hono, SQLite, plain HTML UI.
// Principle: the web UI only edits + persists the variable group.
// Every change takes effect by calling upstream ArgoSBX (beta) with `rep`.
// NEVER run rep/del without an explicit user confirmation in the UI.
// Secrets (uuid / agk tunnel token / sub token) are never returned in full
// via any API and never written to logs; only masked forms leave the server.
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { Database } from "bun:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);
const VERSION = "argosbx-ui v0.1.0";
const PORT = Number(process.env.PORT || 3100);
const DATA_DIR = process.env.DATA_DIR || "/data";
const AGSBX_DIR = process.env.AGSBX_DIR || "/root/agsbx";
const YGKKKCA_DIR = process.env.YGKKKCA_DIR || "/root/ygkkkca";
const WEBSBX_DIR = process.env.WEBSBX_DIR || "/root/websbx";
const AGSBX_BIN = process.env.AGSBX_BIN || "/root/bin/agsbx";
const BETA_URL =
  "https://raw.githubusercontent.com/yonggekkk/argosbx/beta/argosbx.sh";
const ACME_URL =
  "https://raw.githubusercontent.com/yonggekkk/acme-yg/main/acme.sh";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (!ADMIN_PASSWORD) console.warn("[warn] ADMIN_PASSWORD is empty — login disabled protection off");

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "argosbx.db"));
db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, op TEXT NOT NULL, detail TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, label TEXT NOT NULL, files TEXT NOT NULL);`);
const kvGet = (k: string): string | null => {
  const r = db.query("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | null;
  return r ? r.v : null;
};
const kvSet = (k: string, v: string) =>
  db.query("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);

// ---------- variable group ----------
const PT_VARS = ["vlpt","vmpt","vwpt","vxpt","xhpt","xupt","xcpt","hypt","tupt","anpt","arpt","sspt","sopt","nvpt"] as const;
const VAL_VARS = ["reym","cdnym","argo","agn","agk","warp","name","cfip","ippz","hyjpt","subid","subpt"] as const;
const SWITCH_VARS = ["agqc","alns","oap","sub"] as const;
const ALL_VARS = ["uuid", ...PT_VARS, ...VAL_VARS, ...SWITCH_VARS] as const;
type Vars = Record<string, string>;
const EMPTY_VARS = (): Vars => Object.fromEntries(ALL_VARS.map((k) => [k, ""])) as Vars;
const SECRET_KEYS = new Set(["uuid", "agk", "subid"]);

function loadVars(): Vars {
  const raw = kvGet("vars");
  if (!raw) return EMPTY_VARS();
  try { const p = JSON.parse(raw) as Vars; return { ...EMPTY_VARS(), ...p }; } catch { return EMPTY_VARS(); }
}
function saveVars(v: Vars) { kvSet("vars", JSON.stringify(v)); }
function maskVal(k: string, v: string): string {
  if (!v) return "";
  if (SECRET_KEYS.has(k)) return "••••••••";
  return v;
}
function publicVars(v: Vars): Vars {
  const o: Vars = {};
  for (const k of ALL_VARS) o[k] = maskVal(k, v[k] || "");
  // __on 开关也要发给前端，否则协议页勾选框永远是空的（之前就是这个 bug）。
  for (const k of PT_VARS) (o as any)[k + "__on"] = (v as any)[k + "__on"] ? "1" : "";
  return o;
}
// mask any known secret values inside arbitrary text (logs, list output)
function maskSecrets(text: string, v?: Vars): string {
  const vars = v || loadVars();
  let out = text;
  const secrets = [vars.uuid, vars.agk, vars.subid].filter((s) => s && s.length >= 8);
  for (const s of secrets) out = out.split(s).join("••••••••");
  // Always mask UUID-shaped strings even before the DB has imported them,
  // and any long eyJ... tunnel-token blob regardless of its prefix.
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "••••••••");
  out = out.replace(/eyJ[A-Za-z0-9_-]{20,}/g, "••••••••");
  out = out.replace(/(agk=|Argo固定隧道token：?|token：)\s*\S+/g, "$1••••••••");
  return out;
}
function audit(op: string, detail: string, result: string) {
  db.query("INSERT INTO audit(ts,op,detail,result) VALUES(?,?,?,?)").run(Date.now(), op, detail, result);
}
const readFileSafe = (p: string): string | null => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const fileExists = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// ---------- host exec (via nsenter into host namespaces; read-only ops in v1) ----------
// The container runs --privileged --pid=host. nsenter -t 1 puts the command
// back into the host mount/net/pid namespaces so /root/bin/agsbx runs exactly
// as if on the host (systemd, crontab, /root paths all host-side).
async function hostExec(args: string[], env: Record<string, string> = {}, timeoutMs = 120000): Promise<{ code: number; out: string; err: string }> {
  const cmd = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", ...args];
  try {
    const { stdout, stderr } = await execFileAsync(cmd[0], cmd.slice(1), {
      env: { ...process.env, ...env, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, out: e.stdout || "", err: e.stderr || String(e.message || e) };
  }
}
const NSENTER_OK = async (): Promise<boolean> => {
  try { await execFileAsync("nsenter", ["-t", "1", "-m", "--", "true"], { timeout: 5000 }); return true; } catch { return false; }
};

// ---------- live state (read-only) ----------
const PORT_FILE_MAP: Record<string, string> = {
  port_an: "anpt", port_ar: "arpt", port_hy2: "hypt", port_tu: "tupt",
  port_vm_ws: "vmpt", port_vw: "vwpt", port_vx: "vxpt", port_xc: "xcpt",
  port_xh: "xhpt", port_xu: "xupt",
  port_ss: "sspt", port_so: "sopt", port_nv: "nvpt", port_vl_re: "vlpt",
};
function livePorts(): Record<string, string> {
  const o: Record<string, string> = {};
  try {
    for (const f of fs.readdirSync(AGSBX_DIR)) {
      if (f.startsWith("port_") && PORT_FILE_MAP[f]) {
        const v = readFileSafe(path.join(AGSBX_DIR, f));
        if (v) o[PORT_FILE_MAP[f]] = v.trim();
      }
    }
  } catch {}
  return o;
}
function parseShTxt(): Vars {
  const v = EMPTY_VARS();
  const txt = readFileSafe(path.join(AGSBX_DIR, "sh.txt"));
  if (!txt) return v;
  // sh.txt is: uuid="..." vmpt="" ... bash <(curl ...) rep
  for (const m of txt.matchAll(/(\w+)="([^"]*)"/g)) {
    if ((ALL_VARS as readonly string[]).includes(m[1])) v[m[1]] = m[2];
  }
  return v;
}
function certInfo() {
  const crt = path.join(YGKKKCA_DIR, "cert.crt");
  const key = path.join(YGKKKCA_DIR, "private.key");
  const caLog = readFileSafe(path.join(YGKKKCA_DIR, "ca.log"))?.trim() || "";
  if (!fileExists(crt)) return { exists: false, subject: "", notBefore: "", notAfter: "", caLog };
  return { exists: true, subject: "", notBefore: "", notAfter: "", caLog, _crtPath: crt, _hasKey: fileExists(key) };
}
// 证书日期统一显示为 年/月/日 时:分:秒 GMT（时间本身是 GMT，不换算时区）。
// openssl 格式 "Feb 3 05:54:48 2027 GMT" 与 acme.sh 列表的 ISO 格式
// "2026-11-05T06:53:21Z" 都进这里；解析失败原样返回。
function fmtGmtDate(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`;
}
async function certDatesFor(crtPath: string): Promise<{ subject: string; issuer: string; notBefore: string; notAfter: string }> {
  try {
    const { stdout } = await execFileAsync("openssl", ["x509", "-noout", "-subject", "-issuer", "-dates", "-in", crtPath], { timeout: 10000 });
    return {
      subject: stdout.match(/subject=(.*)/)?.[1]?.trim() || "",
      issuer: stdout.match(/issuer=(.*)/)?.[1]?.trim() || "",
      notBefore: fmtGmtDate(stdout.match(/notBefore=(.*)/)?.[1]?.trim() || ""),
      notAfter: fmtGmtDate(stdout.match(/notAfter=(.*)/)?.[1]?.trim() || ""),
    };
  } catch { return { subject: "", issuer: "", notBefore: "", notAfter: "" }; }
}
async function certDates(): Promise<{ subject: string; issuer: string; notBefore: string; notAfter: string }> {
  return certDatesFor(path.join(YGKKKCA_DIR, "cert.crt"));
}
// 证书“在用谁”以 JP 实际生效的配置为准：读 xr.json / sb.json 里的证书路径。
// 指向 /root/ygkkkca/ = 在用域名证书；指向 /root/agsbx/cert.crt = 自签。
// 数据库里的 alns 只是用户下一次 rep 想用什么的意愿，不能当现状——
// alns 本来就不在 sh.txt 的记录表里，import-live 恢复不出它，库里空值
// 是“不知道”，不是“关”。（2026-11-09 纠正：此前按 alns 判现状是错的；
// 实查 JP：xr.json 3 处、sb.json 2 处都是 ygkkkca，agsbx 0 处。）
function liveCertUsage(): { inUse: "own" | "self" | "mixed" | "unknown"; ygkkkcaRefs: number; agsbxRefs: number; caLog: string } {
  const all = (readFileSafe(path.join(AGSBX_DIR, "xr.json")) || "") + "\n" + (readFileSafe(path.join(AGSBX_DIR, "sb.json")) || "");
  const yg = (all.match(/\/root\/ygkkkca\/cert\.crt/g) || []).length;
  const ag = (all.match(/\/root\/agsbx\/cert\.crt/g) || []).length;
  const caLog = readFileSafe(path.join(YGKKKCA_DIR, "ca.log"))?.trim() || "";
  const inUse = yg > 0 && ag === 0 ? "own" : ag > 0 && yg === 0 ? "self" : yg > 0 && ag > 0 ? "mixed" : "unknown";
  return { inUse, ygkkkcaRefs: yg, agsbxRefs: ag, caLog };
}
function parseJhsub(): { name: string; proto: string; maskedLink: string }[] {
  const vars = loadVars();
  const txt = readFileSafe(path.join(AGSBX_DIR, "jhsub.txt")) || "";
  const out: { name: string; proto: string; maskedLink: string }[] = [];
  for (const line of txt.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const proto = l.split("://")[0] || "?";
    const frag = l.includes("#") ? decodeURIComponent(l.split("#").slice(1).join("#")) : "";
    out.push({ name: frag || proto, proto, maskedLink: maskSecrets(l, vars).slice(0, 120) });
  }
  return out;
}
async function subStatus() {
  const tokenFile = readFileSafe(path.join(AGSBX_DIR, "subtoken.log"))?.trim() || "";
  const portFile = readFileSafe(path.join(AGSBX_DIR, "subport.log"))?.trim() || "";
  const serverIp = readFileSafe(path.join(AGSBX_DIR, "server_ip.log"))?.trim() || "";
  const files = ["clmi.yaml", "sbox.json", "jhsub.txt"].map((f) => {
    const p = path.join(WEBSBX_DIR, tokenFile, f);
    let lines = 0;
    try { lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length; } catch {}
    return { file: f, lines, exists: fileExists(p) };
  });
  // "can it be opened" — HEAD the local subscription URL in host netns
  let httpOk: Record<string, boolean> = {};
  if (tokenFile && portFile) {
    const r = await hostExec(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8",
      `http://127.0.0.1:${portFile}/${tokenFile}/jhsub.txt`], {}, 15000);
    httpOk = { jhsub: r.out.trim() === "200" };
  }
  return { enabled: !!tokenFile, tokenMasked: tokenFile ? "•".repeat(Math.min(tokenFile.length, 8)) : "", port: portFile, serverIp, files, httpOk };
}

// ---------- rep env builder ----------
function buildRepEnv(v: Vars): Record<string, string> {
  const env: Record<string, string> = {};
  if (v.uuid) env.uuid = v.uuid;
  // The UI stores enabled state explicitly as `<var>__on` in the JSON.
  // Only enabled protocols are passed at all; an enabled protocol with an
  // empty port passes `VAR=` — the script then reuses the on-disk port file
  // if it exists, otherwise randomises one in 10000–65535 and writes the
  // file (beta 全协议同款，见 emptyPortPlan)。Web 侧不自己随机。
  // A disabled protocol is omitted entirely.
  for (const k of PT_VARS) if ((v as any)[k + "__on"]) env[k] = (v[k] || "").trim();
  if (v.reym) env.reym = v.reym;
  if (v.cdnym) env.cdnym = v.cdnym;
  if (v.argo) env.argo = v.argo;
  if (v.agn) env.agn = v.agn;
  if (v.agk) env.agk = v.agk;
  if (v.agqc) env.agqc = v.agqc;
  if (v.warp) env.warp = v.warp;
  if (v.name) env.name = v.name;
  if (v.cfip) env.cfip = v.cfip;
  if (v.ippz) env.ippz = v.ippz;
  if (v.hyjpt) env.hyjpt = v.hyjpt;
  if (v.alns) env.alns = v.alns;
  if (v.oap) env.oap = v.oap;
  if (v.sub) env.sub = v.sub;
  if (v.subid) env.subid = v.subid;
  if (v.subpt) env.subpt = v.subpt;
  return env;
}
const ARGO_PROTOS = ["vmpt", "vwpt", "vxpt"] as const;
// 端口留空的生效推导（2026-11-09 用户定）：优先沿用旧端口，没有旧端口
// 就随机。判断以磁盘上 /root/agsbx/port_* 文件为准；随机由 rep 时脚本做
// （shuf -i 10000-65535，beta 14 个协议 + subport 同款），Web 不自己随机、
// 不编端口号。只覆盖端口留空且已启用的协议；填了端口的以 diff 为准。
function emptyPortPlan(v: Vars): { key: string; mode: "reuse" | "random"; port: string }[] {
  const live = livePorts();
  const out: { key: string; mode: "reuse" | "random"; port: string }[] = [];
  for (const k of PT_VARS) {
    if (!(v as any)[k + "__on"]) continue;
    if ((v[k] || "").trim()) continue;
    if (live[k]) out.push({ key: k, mode: "reuse", port: live[k] });
    else out.push({ key: k, mode: "random", port: "" });
  }
  return out;
}
const ARGO_LABEL: Record<string, string> = { vmpt: "VMess-ws", vwpt: "VLESS-ws-enc", vxpt: "VLESS-xhttp-enc" };
// Argo 主协议联动（2026-11-08 用户定）：隧道页选了 argo=vmpt/vwpt/vxpt，对应协议
// 自动打开，不用用户手动去协议页找。只改开关，不动端口——端口留空时 rep 沿用
// 磁盘上的端口文件。argo 为空（关闭隧道）时不做任何事。
function applyArgoLink(v: Vars): string[] {
  const auto: string[] = [];
  if (v.argo && (ARGO_PROTOS as readonly string[]).includes(v.argo) && !(v as any)[v.argo + "__on"]) {
    (v as any)[v.argo + "__on"] = "1";
    auto.push(v.argo);
  }
  return auto;
}
function validateVars(v: Vars): string[] {
  const errs: string[] = [];
  const enabled = PT_VARS.filter((k) => (v as any)[k + "__on"]);
  if (!enabled.length) errs.push("至少要启用一个协议");
  if (!v.uuid) errs.push("UUID 不能为空（换 UUID 会让全部节点失效）");
  if (v.argo && !["vmpt", "vwpt", "vxpt"].includes(v.argo)) errs.push("argo 只能是 vmpt / vwpt / vxpt");
  // 注意：argo 对应协议未开不报错——applyArgoLink 已在校验前自动把它打开
  // （2026-11-08 用户定：不要拦截、不要让用户手动去开）。这里不再拦。
  if ((v.agn && !v.agk) || (!v.agn && v.agk)) errs.push("固定隧道域名和 token 必须同时填（只填一个会变临时隧道）");
  for (const k of PT_VARS) {
    const p = (v[k] || "").trim();
    if (p && !/^\d+$/.test(p)) errs.push(`${k} 端口必须是数字`);
    if (p && (+p < 1 || +p > 65535)) errs.push(`${k} 端口超出范围`);
  }
  if (v.subpt && !/^\d+$/.test(v.subpt.trim())) errs.push("subpt 必须是数字");
  return errs;
}
function diffVars(oldV: Vars, newV: Vars): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  for (const k of [...ALL_VARS, ...PT_VARS.map((x) => x + "__on")]) {
    const a = String((oldV as any)[k] ?? ""), b = String((newV as any)[k] ?? "");
    if (a !== b) out.push({ key: k, from: maskVal(k.replace("__on", ""), a), to: maskVal(k.replace("__on", ""), b) });
  }
  return out;
}
function backupConfigs(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DATA_DIR, "backups", ts + "-" + label);
  fs.mkdirSync(dir, { recursive: true });
  const saved: string[] = [];
  for (const f of ["xr.json", "sb.json", "sh.txt"]) {
    const src = path.join(AGSBX_DIR, f);
    if (fileExists(src)) { fs.copyFileSync(src, path.join(dir, f)); saved.push(f); }
  }
  db.query("INSERT INTO backups(ts,label,files) VALUES(?,?,?)").run(Date.now(), label, JSON.stringify(saved));
  return dir;
}
const newConfirmToken = () => {
  const t = randomBytes(16).toString("hex");
  kvSet("confirm:" + t, JSON.stringify({ ts: Date.now() }));
  return t;
};
const consumeConfirmToken = (t: string): boolean => {
  const raw = kvGet("confirm:" + t);
  if (!raw) return false;
  db.query("DELETE FROM kv WHERE k=?").run("confirm:" + t);
  try { return Date.now() - (JSON.parse(raw).ts as number) < 10 * 60 * 1000; } catch { return false; }
};

// ---------- acme-yg cert jobs (query / apply / delete) ----------
// acme-yg is a purely interactive script (no CLI args). Apply/delete drive
// the real upstream script by piping the menu answers on stdin — the same
// pattern the existing renew endpoint already uses (printf '3\n0\n').
// Apply/delete run as background jobs: the HTTP call returns a jobId and
// the UI polls for status + masked log. Only one cert job runs at a time.
// Query is read-only: it just runs `acme.sh --list` (exactly what the
// script's own Certificate() menu item does) and parses the rows.
// NOTE (verified against upstream acme.sh V26.6.17): "revoke + delete one
// cert" is commented out in the script, so there is NO per-domain delete —
// delete here is menu 4: delete ALL certs + uninstall acme.sh. The UI says so.
type CertJob = { id: string; kind: string; mode: string; target: string; status: "running" | "done" | "failed"; code: number | null; log: string; startedAt: number; finishedAt: number | null };
const certJobs = new Map<string, CertJob>();
let certJobRunning = false;
const shQuote = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function maskWithSecrets(text: string, extra: string[]): string {
  let out = maskSecrets(text);
  for (const s of extra) if (s && s.length >= 6) out = out.split(s).join("••••••••");
  return out;
}
function parseAcmeList(raw: string): { domain: string; keyLength: string; san: string; profile: string; ca: string; created: string; renew: string }[] {
  const out: { domain: string; keyLength: string; san: string; profile: string; ca: string; created: string; renew: string }[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("Main_Domain")) continue;
    const p = t.split(/\s+/);
    if (p.length < 4) continue;
    // Row shape varies: with an empty Profile column the row has 6 tokens,
    // with Profile set it has 7. Created/Renew are always the last two.
    const created = p[p.length - 2] || "", renew = p[p.length - 1] || "";
    const mid = p.slice(3, p.length - 2);
    out.push({
      domain: p[0], keyLength: (p[1] || "").replace(/"/g, ""), san: p[2] || "",
      profile: mid.length > 1 ? mid[0] : "", ca: mid.length > 1 ? mid.slice(1).join(" ") : (mid[0] || ""),
      created: fmtGmtDate(created), renew: fmtGmtDate(renew),
    });
  }
  return out;
}
async function publicIps(): Promise<{ v4: string; v6: string }> {
  const v4 = readFileSafe(path.join(AGSBX_DIR, "server_ip.log"))?.trim() || "";
  const v6r = await hostExec(["curl", "-s6", "--max-time", "8", "https://icanhazip.com"], {}, 15000);
  return { v4, v6: v6r.out.trim() };
}
async function domainResolvesToLocal(domain: string): Promise<{ ok: boolean; resolved: string; local: string }> {
  const bare = domain.replace(/^\*\./, "");
  const { v4, v6 } = await publicIps();
  const r = await hostExec(["dig", "@8.8.8.8", "+time=3", "+short", bare], {}, 20000);
  const resolved = r.out.split("\n").map((s) => s.trim()).find((s) => /^([0-9]+\.){3}[0-9]+$/.test(s) || /^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/.test(s)) || "";
  const ok = !!resolved && (resolved === v4 || (!!v6 && resolved === v6));
  return { ok, resolved, local: v4 || v6 };
}

// ---------- app ----------
const app = new Hono();
app.get("/api/health", (c) => c.json({ ok: true, version: VERSION }));
app.use("/public/*", serveStatic({ root: "./" }));
app.get("/", (c) => c.html(fs.readFileSync("./public/index.html", "utf8")));
app.get("/api/me", (c) => {
  const tok = c.req.header("cookie")?.match(/session=([^;]+)/)?.[1] || "";
  const ok = !!tok && !!db.query("SELECT token FROM sessions WHERE token=?").get(tok);
  return c.json({ loggedIn: ok });
});
app.post("/api/login", async (c) => {
  const { password } = await c.req.json().catch(() => ({} as any));
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) return c.json({ ok: false, error: "密码不对" }, 401);
  const tok = randomBytes(24).toString("hex");
  db.query("INSERT INTO sessions(token,created_at) VALUES(?,?)").run(tok, Date.now());
  c.header("Set-Cookie", `session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => {
  const tok = c.req.header("cookie")?.match(/session=([^;]+)/)?.[1] || "";
  if (tok) db.query("DELETE FROM sessions WHERE token=?").run(tok);
  c.header("Set-Cookie", "session=; Path=/; Max-Age=0");
  return c.json({ ok: true });
});
const auth = async (c: any, next: any) => {
  const tok = c.req.header("cookie")?.match(/session=([^;]+)/)?.[1] || "";
  if (!tok || !db.query("SELECT token FROM sessions WHERE token=?").get(tok)) return c.json({ ok: false, error: "未登录" }, 401);
  await next();
};
app.use("/api/*", auth);
// ---- read-only ----
app.get("/api/status", async (c) => {
  const vars = loadVars();
  const procs = await hostExec(["sh", "-c", "ps aux | grep -E 'agsbx/(s|x)|cloudflared|busybox httpd' | grep -v grep | wc -l"], {}, 15000);
  const cert = { ...certInfo(), ...(await certDates()), live: liveCertUsage() };
  delete (cert as any)._crtPath;
  return c.json({
    ok: true, version: VERSION,
    nsenter: await NSENTER_OK(),
    procsRunning: parseInt(procs.out.trim() || "0", 10),
    livePorts: livePorts(),
    argoDomain: readFileSafe(path.join(AGSBX_DIR, "sbargoym.log"))?.trim() || "",
    tokenExists: fileExists(path.join(AGSBX_DIR, "sbargotoken.log")),
    argoPort: readFileSafe(path.join(AGSBX_DIR, "argoport.log"))?.trim() || "",
    vlvm: readFileSafe(path.join(AGSBX_DIR, "vlvm"))?.trim() || "",
    cftupr: readFileSafe(path.join(AGSBX_DIR, "cftupr.log"))?.trim() || "（无此文件 = main 分支，固定 http2）",
    shTxt: maskSecrets(readFileSafe(path.join(AGSBX_DIR, "sh.txt")) || "", vars),
    cert, sub: await subStatus(),
    varsSaved: !!kvGet("vars"),
  });
});
app.get("/api/nodes", (c) => {
  const nodes = parseJhsub();
  return c.json({ ok: true, count: nodes.length, nodes });
});
app.get("/api/vars", (c) => c.json({ ok: true, vars: publicVars(loadVars()) }));
app.get("/api/cert", async (c) => {
  const cert = { ...certInfo(), ...(await certDates()) };
  delete (cert as any)._crtPath;
  const cron = await hostExec(["sh", "-c", "crontab -l 2>/dev/null | grep -i acme | head -3"], {}, 15000);
  // alns 是用户下一次 rep 的意愿（选择区），live 是实际在用谁（xr/sb 配置），两者分开返回。
  // selfCert 是 ArgoSBX 内置自签证书（/root/agsbx/cert.crt）的实查信息，供横条写清颁发者。
  const selfCertPath = path.join(AGSBX_DIR, "cert.crt");
  const selfCert = { exists: fileExists(selfCertPath), ...(await certDatesFor(selfCertPath)) };
  return c.json({ ok: true, cert, selfCert, autoRenewCron: maskSecrets(cron.out.trim()), alns: loadVars().alns || "", live: liveCertUsage() });
});
app.get("/api/audit", (c) => {
  const rows = db.query("SELECT id,ts,op,detail,result FROM audit ORDER BY id DESC LIMIT 50").all() as any[];
  return c.json({ ok: true, rows });
});
// ---- JP 现状推导（import-live 与差异覆盖共用；只读，不写任何 live 文件）----
// live 值来源：sh.txt（uuid/argo/agn/agk/name/oap）、/root/agsbx/port_* 文件
// （各协议端口）、uuid/name/ym_vl_re/vlvm/sbargoym.log/sbargotoken.log、
// subport.log/subtoken.log、xr.json/sb.json（协议开关 tag 与证书路径）。
// 没有 live 来源的字段（agqc/cfip/hyjpt/ippz/cdnym/warp 等）不在返回值里，
// 导入时既不补也不比对。alns 不在 sh.txt 里：按 live 证书路径推导——
// xr.json/sb.json 指向 /root/ygkkkca/ 就是在用域名证书（alns="y"），
// 指向 /root/agsbx/cert.crt 才是自签（alns=""）；两者都有或都没有则无法判断。
function computeLive(): { vals: Partial<Vars>; onFlags: Record<string, boolean>; certInUse: string } {
  const sh = parseShTxt();
  const ports = livePorts();
  const vals: Partial<Vars> = {};
  for (const k of ALL_VARS) if (k !== "alns" && sh[k]) vals[k] = sh[k];
  for (const [k, v] of Object.entries(ports)) vals[k] = v;
  const uuidFile = readFileSafe(path.join(AGSBX_DIR, "uuid"))?.trim() || "";
  if (uuidFile) vals.uuid = uuidFile;
  const domain = readFileSafe(path.join(AGSBX_DIR, "sbargoym.log"))?.trim() || "";
  if (domain) vals.agn = domain;
  // agk: read host file server-side only; stored in DB, never returned in full.
  const agkFile = readFileSafe(path.join(AGSBX_DIR, "sbargotoken.log"))?.trim() || "";
  if (agkFile) vals.agk = agkFile;
  const name = readFileSafe(path.join(AGSBX_DIR, "name"))?.trim() || "";
  // /root/agsbx/name stores the prefix WITH trailing dash ("Fam-") while the
  // script's `name` variable is without it ("Fam", dash appended by script).
  // Normalise so a future rep does not produce "Fam--...".
  if (name) vals.name = name.replace(/-+$/, "");
  const reym = readFileSafe(path.join(AGSBX_DIR, "ym_vl_re"))?.trim() || "";
  if (reym) vals.reym = reym;
  const subPort = readFileSafe(path.join(AGSBX_DIR, "subport.log"))?.trim() || "";
  if (subPort) vals.subpt = subPort;
  const subToken = readFileSafe(path.join(AGSBX_DIR, "subtoken.log"))?.trim() || "";
  if (subToken && subToken !== vals.uuid) vals.subid = subToken;
  if (subToken) vals.sub = "y";
  if (!vals.argo) {
    const vlvm = readFileSafe(path.join(AGSBX_DIR, "vlvm"))?.trim() || "";
    vals.argo = vlvm === "Vmess" ? "vmpt" : vlvm === "Vlessx" ? "vxpt" : vlvm === "Vless" ? "vwpt" : "";
    if (!vals.argo && vals.agn && vals.agk) vals.argo = "vwpt";
  }
  const cert = liveCertUsage();
  if (cert.inUse === "own") vals.alns = "y";
  else if (cert.inUse === "self") vals.alns = "";
  // enabled flags: a protocol is on when its port file exists,
  // or (for ports the script kept) when the xr/sb config contains its tag.
  const xr = readFileSafe(path.join(AGSBX_DIR, "xr.json")) || "";
  const sb = readFileSafe(path.join(AGSBX_DIR, "sb.json")) || "";
  const tagOn: Record<string, boolean> = {
    vlpt: xr.includes("reality-vision"), vmpt: xr.includes("vmess-xr") || sb.includes("vmess-sb"),
    vwpt: xr.includes("vless-ws"), vxpt: xr.includes("vless-xhttp"),
    xhpt: xr.includes("xhttp-reality"), xupt: xr.includes("xhttp-h3"), xcpt: xr.includes("xhttp-h23"),
    hypt: xr.includes("hy2-xr") || sb.includes("hy2-sb"), tupt: sb.includes("tuic5-sb"),
    anpt: sb.includes("anytls-sb"), arpt: sb.includes("anyreality-sb"),
    sspt: sb.includes("ss-2022"), sopt: xr.includes("socks5-xr") || sb.includes("socks5-sb"),
    nvpt: sb.includes("naive-sb"),
  };
  const onFlags: Record<string, boolean> = {};
  for (const k of PT_VARS) onFlags[k] = !!(ports[k] || tagOn[k]);
  return { vals, onFlags, certInUse: cert.inUse };
}
// ---- import live state into DB ----
// 空字段直接从 JP 现状补；已有值 ≠ 现状的列进 diffs，不静默覆盖，
// 前端列出差异、用户确认后才由 /api/import-live/apply 覆盖。
// “已导入字段：无”不是没读到东西：比对过且一致的字段计 matched，
// 前端据此说清“数据库已是最新”。
app.post("/api/import-live", (c) => {
  const saved = loadVars();
  const hasSaved = !!kvGet("vars");
  const live = computeLive();
  const next: Vars = { ...saved };
  const filled: string[] = [];
  const diffs: { key: string; db: string; live: string }[] = [];
  let matched = 0;
  const disp = (k: string, v: string): string => {
    if (k === "alns") return v === "y" ? "域名证书" : "内置自签";
    if (k.endsWith("__on")) return v ? "已启用" : "未启用";
    return maskVal(k, v);
  };
  for (const k of ALL_VARS) {
    const lv = live.vals[k];
    if (lv === undefined) continue; // live 无此字段来源：不补不比
    const db = next[k] || "";
    // 只有 alns 的 "" 也有意义（= 自签）；其余字段 live 为空 = 没信息，不比。
    if (lv === "" && k !== "alns") continue;
    if (db === lv) { matched++; continue; }
    if (!hasSaved || !db) { next[k] = lv; filled.push(k); }
    else diffs.push({ key: k, db: disp(k, db), live: disp(k, lv) });
  }
  for (const k of PT_VARS) {
    const lv = live.onFlags[k] ? "1" : "";
    const db = (next as any)[k + "__on"] || "";
    if (db === lv) { matched++; continue; }
    if (!hasSaved || !db) { (next as any)[k + "__on"] = lv; filled.push(k + "__on"); }
    else diffs.push({ key: k + "__on", db: disp(k + "__on", db), live: disp(k + "__on", lv) });
  }
  saveVars(next);
  const tokenExists = fileExists(path.join(AGSBX_DIR, "sbargotoken.log"));
  return c.json({ ok: true, filled, diffs, matched, liveCert: live.certInUse, tokenExists, vars: publicVars(next) });
});
app.post("/api/import-live/apply-confirm", (c) => {
  return c.json({ ok: true, confirmToken: newConfirmToken(), warning: "将用 JP 现状覆盖数据库里不一致的字段（仅覆盖你勾选的差异项）。覆盖后下一次 rep 会用新值。" });
});
app.post("/api/import-live/apply", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { confirmToken, fields } = body;
  if (!confirmToken || !consumeConfirmToken(confirmToken)) return c.json({ ok: false, error: "确认凭证无效或已过期（10 分钟），请重新点确认" }, 400);
  const allowed = new Set([...ALL_VARS, ...PT_VARS.map((k) => k + "__on")]);
  const list = Array.isArray(fields) ? fields.filter((f: string) => allowed.has(f)) : [];
  if (!list.length) return c.json({ ok: false, error: "没有可覆盖的差异字段" }, 400);
  const live = computeLive();
  const next = loadVars();
  const applied: string[] = [];
  for (const k of list) {
    if (k.endsWith("__on")) {
      const base = k.slice(0, -4);
      if (live.onFlags[base] === undefined) continue;
      (next as any)[k] = live.onFlags[base] ? "1" : "";
    } else if (live.vals[k] !== undefined) {
      next[k] = live.vals[k] as string;
    } else continue;
    applied.push(k);
  }
  if (!applied.length) return c.json({ ok: false, error: "所选字段没有对应的 JP 现状值" }, 400);
  saveVars(next);
  return c.json({ ok: true, applied, vars: publicVars(next) });
});
// ---- save vars (no rep) ----
app.post("/api/vars", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const cur = loadVars();
  const next: Vars = { ...cur };
  for (const k of ALL_VARS) {
    if (body[k] !== undefined && body[k] !== null) {
      // masked secrets coming back from the form mean "keep the stored value"
      if (SECRET_KEYS.has(k) && typeof body[k] === "string" && body[k].includes("•")) continue;
      next[k] = String(body[k]);
    }
  }
  for (const k of PT_VARS) if (body[k + "__on"] !== undefined) (next as any)[k + "__on"] = body[k + "__on"] ? "1" : "";
  applyArgoLink(next);
  const errs = validateVars(next);
  if (errs.length) return c.json({ ok: false, error: errs.join("；") }, 400);
  saveVars(next);
  audit("save-vars", "保存变量组（未 rep）", "ok");
  return c.json({ ok: true, vars: publicVars(next) });
});
// ---- rep: dry-run diff + confirm token, then run ----
app.post("/api/rep/dry-run", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const cur = loadVars();
  const next: Vars = { ...cur };
  for (const k of ALL_VARS) {
    if (body[k] !== undefined && body[k] !== null) {
      if (SECRET_KEYS.has(k) && typeof body[k] === "string" && body[k].includes("•")) continue;
      next[k] = String(body[k]);
    }
  }
  for (const k of PT_VARS) if (body[k + "__on"] !== undefined) (next as any)[k + "__on"] = body[k + "__on"] ? "1" : "";
  // Argo 联动：argo 对应协议自动打开（只改开关，不动端口），自动开启的协议
  // 随 autoEnabled 返回，前端在 diff 里明写一行“已自动开启 …”，用户看得见。
  const autoEnabled = applyArgoLink(next);
  const errs = validateVars(next);
  if (errs.length) return c.json({ ok: false, error: errs.join("；") }, 400);
  if (next.alns && !fileExists(path.join(YGKKKCA_DIR, "private.key"))) {
    return c.json({ ok: false, error: "alns 已开但 /root/ygkkkca 下没有证书，rep 会挂在 acme-yg 交互等待上。请先在证书页申请证书。" }, 400);
  }
  const diff = diffVars(cur, next);
  const token = diff.length ? newConfirmToken() : "";
  kvSet("pending-rep", JSON.stringify(next));
  return c.json({ ok: true, diff, confirmToken: token, autoEnabled, portPlan: emptyPortPlan(next), warning: "rep 会杀掉 sing-box / xray / cloudflared / 订阅 httpd 进程并重建配置，服务会短暂中断；订阅会短暂 502。确认后才执行。" });
});
app.post("/api/rep", async (c) => {
  const { confirmToken } = await c.req.json().catch(() => ({} as any));
  if (!confirmToken || !consumeConfirmToken(confirmToken)) return c.json({ ok: false, error: "确认凭证无效或已过期（10 分钟），请重新点保存并确认" }, 400);
  const pending = kvGet("pending-rep");
  if (!pending) return c.json({ ok: false, error: "没有待执行的 rep，请先点保存并确认" }, 400);
  const next = JSON.parse(pending) as Vars;
  applyArgoLink(next);
  const errs = validateVars(next);
  if (errs.length) return c.json({ ok: false, error: errs.join("；") }, 400);
  saveVars(next);
  const backupDir = backupConfigs("rep");
  const env = buildRepEnv(next);
  audit("rep-start", `备份于 ${backupDir}；改动见 dry-run`, "running");
  // Run beta script via host nsenter so systemd/crontab//root paths are host-side.
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) envArgs.push(`${k}=${v}`);
  const script = `curl -Ls ${BETA_URL} | bash -s rep`;
  const r = await hostExec(["bash", "-c", script], env, 300000);
  const maskedOut = maskSecrets(r.out + "\n" + r.err, next).slice(-8000);
  audit("rep-finish", `code=${r.code} 备份 ${backupDir}`, r.code === 0 ? "ok" : "failed");
  // post-rep verification: list again (read-only)
  const list = await hostExec([AGSBX_BIN, "list"], {}, 120000);
  const nodes = parseJhsub();
  return c.json({ ok: r.code === 0, code: r.code, log: maskedOut, backupDir, nodesCount: nodes.length, listOk: list.code === 0 });
});
// ---- ops: list is read-only; the rest need the same confirm gate ----
app.post("/api/ops/list", async (c) => {
  const r = await hostExec([AGSBX_BIN, "list"], {}, 120000);
  const nodes = parseJhsub();
  return c.json({ ok: r.code === 0, log: maskSecrets(r.out).slice(-6000), nodesCount: nodes.length });
});
app.post("/api/ops/:action", async (c) => {
  const action = c.req.param("action");
  if (!["upx", "ups", "upa", "res"].includes(action)) return c.json({ ok: false, error: "未知操作" }, 400);
  const { confirmToken } = await c.req.json().catch(() => ({} as any));
  if (!confirmToken || !consumeConfirmToken(confirmToken)) return c.json({ ok: false, error: "此操作会杀进程/更新内核，请先在操作页点确认拿到凭证" }, 400);
  const backupDir = backupConfigs(action);
  const useBeta = action === "upa";
  const r = useBeta
    ? await hostExec(["bash", "-c", `curl -Ls ${BETA_URL} | bash -s ${action}`], {}, 300000)
    : await hostExec([AGSBX_BIN, action], {}, 300000);
  audit("op-" + action, `备份 ${backupDir}`, r.code === 0 ? "ok" : "failed");
  return c.json({ ok: r.code === 0, code: r.code, log: maskSecrets(r.out + "\n" + r.err).slice(-6000), backupDir });
});
app.post("/api/ops/confirm", async (c) => {
  const { action } = await c.req.json().catch(() => ({} as any));
  if (!["upx", "ups", "upa", "res"].includes(action)) return c.json({ ok: false, error: "未知操作" }, 400);
  return c.json({ ok: true, confirmToken: newConfirmToken(), warning: `${action} 会杀掉对应进程并重启/更新内核，服务会短暂中断。` });
});
// ---- uninstall (del)：双重确认，先备份快照，绝不动 Web 自身 ----
// del 是毁灭性的：调 cleandel()（删 ~/.bashrc 里的 agsbx 行、清 crontab
// 相关行、删 $HOME/bin/agsbx、停并删 xr/sb/argo 三个服务、清 NAT 规则），
// 再删 sbx_update、$HOME/agsbx、$HOME/websbx 整个目录。
// 执行前先把脚本与配置打快照备份到宿主 /tmp，备份失败就停手、不执行 del。
// 备份包：/root/agsbx（配置+数据）、/root/websbx（订阅生成目录）、
// /root/bin/agsbx（启动脚本，95KB，内含上游 main 分支地址与全部变量记录
// 逻辑）、/root/sbx_update（安装标记，存在才备）。卸完即使上游不在了，
// 也能靠备份把脚本找回来重装。
// 数据库里的变量组不动——重装时用保存的变量组在操作页执行一次 rep 就能装回来。
// 安全红线：只删 AGSBX_DIR / WEBSBX_DIR 两个常量路径；/root/argosbx-web
// （Web 自身代码）与 DATA_DIR（数据库）绝不在删除范围，执行前再核对一次。
const UNINSTALL_BACKUP_PREFIX = "/tmp/backup-argosbx-uninstall-";
function uninstallSafetyCheck(): string | null {
  for (const p of [AGSBX_DIR, WEBSBX_DIR]) {
    const norm = path.resolve(p);
    if (norm === "/" || norm === "/root" || norm === path.resolve(DATA_DIR) || norm.includes("argosbx-web") || norm.includes("argosbx-ui")) return `拒绝执行：删除路径异常（${p}）`;
  }
  return null;
}
async function probeUninstallPaths(): Promise<Record<string, boolean>> {
  const paths = ["/root/agsbx", "/root/websbx", "/root/bin/agsbx", "/root/sbx_update"];
  const r = await hostExec(["bash", "-c", 'for p in "$@"; do if [ -e "$p" ]; then echo "$p:1"; else echo "$p:0"; fi; done', "_", ...paths], {}, 15000);
  const out: Record<string, boolean> = {};
  for (const line of r.out.split("\n")) {
    const m = line.trim().match(/^(\S+):([01])$/);
    if (m) out[m[1]] = m[2] === "1";
  }
  for (const p of paths) if (out[p] === undefined) out[p] = false;
  return out;
}
async function snapshotBeforeUninstall(): Promise<{ ok: boolean; dir: string; manifest: string; error?: string }> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const dir = UNINSTALL_BACKUP_PREFIX + ts;
  const script = `
set -e
dir="$1"
mkdir -p "$dir"
manifest="$dir/MANIFEST.txt"
: > "$manifest"
copy_one() {
  src="$1"; dest="$2"
  if [ -e "$src" ]; then cp -a "$src" "$dest"; echo "$src -> $dest" >> "$manifest";
  else echo "$src (不存在，跳过)" >> "$manifest"; fi
}
copy_one /root/agsbx "$dir/agsbx"
copy_one /root/websbx "$dir/websbx"
copy_one /root/bin/agsbx "$dir/agsbx-bin"
copy_one /root/sbx_update "$dir/sbx_update"
echo "备份目录：$dir" >> "$manifest"
`;
  const r = await hostExec(["bash", "-c", script, "_", dir], {}, 120000);
  if (r.code !== 0) return { ok: false, dir, manifest: "", error: maskSecrets(r.out + "\n" + r.err).slice(-2000) };
  const v = await hostExec(["bash", "-c", 'test -s "$1/MANIFEST.txt" && echo OK', "_", dir], {}, 15000);
  if (v.out.trim() !== "OK") return { ok: false, dir, manifest: "", error: "备份清单 MANIFEST.txt 缺失或为空，备份未落定" };
  const manifest = (await hostExec(["cat", dir + "/MANIFEST.txt"], {}, 15000)).out;
  return { ok: true, dir, manifest: maskSecrets(manifest) };
}
// 预检：只返回存在性与备份清单，不执行任何删除，也不发确认凭证以外的状态。
app.post("/api/uninstall/confirm", async (c) => {
  const probe = await probeUninstallPaths();
  const installed = probe["/root/agsbx"] || probe["/root/websbx"];
  const backupItems = [
    { path: "/root/agsbx", label: "ArgoSBX 配置与数据目录", exists: probe["/root/agsbx"] },
    { path: "/root/websbx", label: "订阅生成目录", exists: probe["/root/websbx"] },
    { path: "/root/bin/agsbx", label: "启动脚本 agsbx", exists: probe["/root/bin/agsbx"] },
    { path: "/root/sbx_update", label: "安装标记 sbx_update", exists: probe["/root/sbx_update"] },
  ];
  return c.json({
    ok: true, installed, confirmToken: newConfirmToken(), backupItems,
    backupPrefix: UNINSTALL_BACKUP_PREFIX,
    deletes: ["/root/agsbx（全部配置、节点、订阅文件）", "/root/websbx（订阅生成目录）", "/root/bin/agsbx（启动脚本）", "/root/sbx_update（安装标记）", "xr / sb / argo 三个服务与相关定时任务"],
    warning: "卸载会删掉全部节点、订阅、配置、服务与定时任务，节点全部失效。执行前先自动备份快照，备份失败不执行；Web 界面、数据库变量组、Cloudflare 侧固定隧道定义不动。",
  });
});
app.post("/api/uninstall", async (c) => {
  const { confirmToken } = await c.req.json().catch(() => ({} as any));
  if (!confirmToken || !consumeConfirmToken(confirmToken)) return c.json({ ok: false, error: "确认凭证无效或已过期（10 分钟），请重新走卸载确认流程" }, 400);
  const safeErr = uninstallSafetyCheck();
  if (safeErr) return c.json({ ok: false, error: safeErr }, 400);
  const probe = await probeUninstallPaths();
  if (!probe["/root/agsbx"] && !probe["/root/websbx"]) return c.json({ ok: false, error: "ArgoSBX 未安装，无需卸载" }, 400);
  audit("uninstall-start", "卸载 ArgoSBX（del），先备份快照", "running");
  // 1. 备份快照；失败停手，不执行 del。
  const snap = await snapshotBeforeUninstall();
  if (!snap.ok) {
    audit("uninstall-abort", "备份失败，未执行 del", "failed");
    return c.json({ ok: false, error: "备份失败，未执行卸载：" + (snap.error || "未知错误"), backupDir: snap.dir }, 500);
  }
  // 2. 执行 del（上游脚本自带 cleandel：停并删服务、清 crontab/bashrc、删目录）。
  // 启动脚本还在就用它；已被人删过则走 beta 脚本直跑 del（del 不受“未安装”门槛限制）。
  const r = probe["/root/bin/agsbx"]
    ? await hostExec([AGSBX_BIN, "del"], {}, 300000)
    : await hostExec(["bash", "-c", `curl -Ls ${BETA_URL} | bash -s del`], {}, 300000);
  const maskedLog = maskSecrets(r.out + "\n" + r.err).slice(-6000);
  // 3. 核验：目录与启动脚本已不存在、xr/sb/argo 服务已停、代理进程已无。
  // 订阅 httpd（busybox）不在硬核验里：cleandel 不保证杀它，目录删掉后它也无内容可 serve。
  const verify = await hostExec(["bash", "-c", `
    ok=1
    [ -e /root/agsbx ] && ok=0
    [ -e /root/websbx ] && ok=0
    [ -e /root/bin/agsbx ] && ok=0
    for u in xr sb argo; do systemctl is-active --quiet "$u" 2>/dev/null && ok=0; done
    if ps aux | grep -E 'agsbx/(s|x)' | grep -v grep >/dev/null 2>&1; then ok=0; fi
    echo $ok`], {}, 30000);
  const verified = verify.out.trim() === "1";
  const ok = r.code === 0 && verified;
  audit("uninstall-finish", `备份 ${snap.dir}；code=${r.code}；核验 ${verified ? "通过" : "未通过"}`, ok ? "ok" : "failed");
  // 数据库变量组刻意不动：重装时用保存的变量组执行一次 rep 即可。
  return c.json({ ok, code: r.code, log: maskedLog, backupDir: snap.dir, backupManifest: snap.manifest, verified });
});
// ---- cert renew (interactive script piped with menu answers; confirm-gated) ----
app.post("/api/cert/renew", async (c) => {
  const { confirmToken } = await c.req.json().catch(() => ({} as any));
  if (!confirmToken || !consumeConfirmToken(confirmToken)) return c.json({ ok: false, error: "请先点确认拿到凭证" }, 400);
  const r = await hostExec(["bash", "-c", `printf '3\\n0\\n' | bash <(curl -Ls ${ACME_URL})`], {}, 300000);
  audit("cert-renew", "手动续期全部证书", r.code === 0 ? "ok" : "failed");
  const cert = { ...certInfo(), ...(await certDates()) };
  return c.json({ ok: r.code === 0, log: maskSecrets(r.out + "\n" + r.err).slice(-4000), cert });
});
app.post("/api/cert/renew-confirm", async (c) => {
  return c.json({ ok: true, confirmToken: newConfirmToken(), warning: "手动续期会强制跑一次全部证书续期；80 端口模式续期需要 80 端口空闲。续期后代理进程是否重载新证书未确认。" });
});
// ---- acme-yg: query (read-only) ----
app.get("/api/cert/list", async (c) => {
  const r = await hostExec(["bash", "/root/.acme.sh/acme.sh", "--list"], {}, 30000);
  return c.json({ ok: true, installed: r.code === 0, certs: parseAcmeList(r.out), raw: maskSecrets(r.out).slice(0, 2000) });
});
// ---- acme-yg: apply (async job; drives the real menu-1 flow) ----
app.post("/api/cert/apply-confirm", async (c) => {
  return c.json({ ok: true, confirmToken: newConfirmToken(), warning: "申请新证书会重装 acme.sh（上游流程），旧证书记录会被清除；申请失败时现有证书也可能被删。80 端口模式会强制释放 80 端口；IP 证书只有 3 天。" });
});
app.post("/api/cert/apply", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { confirmToken, mode } = body;
  if (!confirmToken || !consumeConfirmToken(confirmToken)) return c.json({ ok: false, error: "请先点确认拿到凭证" }, 400);
  if (certJobRunning) return c.json({ ok: false, error: "已有证书任务在执行，请等它完成" }, 409);
  const email = String(body.email || "").trim();
  const domain = String(body.domain || "").trim();
  const ip = String(body.ip || "").trim();
  const errs: string[] = [];
  if (!["ip", "domain", "dns"].includes(mode)) errs.push("申请方式只能是 ip / domain / dns");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push("邮箱格式不对（留空则自动生成虚拟邮箱）");
  if (mode === "ip" && ip && !/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip) && !/^[0-9a-fA-F:]+$/.test(ip) && !/^([0-9]{1,3}\.){3}[0-9]{1,3}\s+[0-9a-fA-F:]+$/.test(ip)) errs.push("IP 格式不对（IPv4、IPv6 或“IPv4 IPv6”，留空用本机 IP）");
  if ((mode === "domain" || mode === "dns")) {
    if (!domain || !/^(?:\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(domain)) errs.push("域名格式不对");
    if (domain.includes("ip6.arpa")) errs.push("不支持 ip6.arpa 域名");
  }
  const secrets: string[] = [];
  let lines: string[] = [];
  const provider = String(body.provider || "");
  if (mode === "dns") {
    if (!["cf", "dp", "ali"].includes(provider)) errs.push("请选择 DNS 服务商");
    else if (provider === "cf") {
      const cfMethod = String(body.cfMethod || "token");
      if (cfMethod === "token") {
        if (!body.cfAccountId || !body.cfToken) errs.push("Cloudflare API Token 方式需要填写账户 ID 和 API Token");
        secrets.push(String(body.cfToken || ""), String(body.cfAccountId || ""));
        lines = ["1", "3", email, domain, "1", "1", String(body.cfAccountId || ""), String(body.cfToken || "")];
      } else if (cfMethod === "gkey") {
        if (!body.cfEmail || !body.cfKey) errs.push("Cloudflare Global Key 方式需要填写注册邮箱和 Global API Key");
        secrets.push(String(body.cfKey || ""));
        lines = ["1", "3", email, domain, "1", "2", String(body.cfEmail || ""), String(body.cfKey || "")];
      } else errs.push("Cloudflare 验证方式只能是 token / gkey");
    } else if (provider === "dp") {
      if (!body.dpId || !body.dpKey) errs.push("DNSPod 需要填写 DP_Id 和 DP_Key");
      secrets.push(String(body.dpKey || ""));
      lines = ["1", "3", email, domain, "2", String(body.dpId || ""), String(body.dpKey || "")];
    } else if (provider === "ali") {
      if (!body.aliKey || !body.aliSecret) errs.push("阿里云需要填写 Ali_Key 和 Ali_Secret");
      secrets.push(String(body.aliSecret || ""));
      lines = ["1", "3", email, domain, "3", String(body.aliKey || ""), String(body.aliSecret || "")];
    }
  } else if (mode === "ip") lines = ["1", "1", email, ip];
  else lines = ["1", "2", email, domain];
  if (errs.length) return c.json({ ok: false, error: errs.join("；") }, 400);
  // Pre-flight (before anything destructive): the domain must already resolve
  // to this VPS IP, otherwise the script would burn the existing cert and fail.
  if (mode === "domain" || mode === "dns") {
    const chk = await domainResolvesToLocal(domain);
    if (!chk.ok) return c.json({ ok: false, error: `域名 ${domain} 解析到的 IP（${chk.resolved || "未解析出"}）与本机 IP（${chk.local || "未知"}）不一致，请先在服务商处把解析指到本机 IP 并关掉 CDN 小黄云。本次没有执行任何申请，现有证书未动。` }, 400);
  }
  const id = randomBytes(8).toString("hex");
  const job: CertJob = { id, kind: "apply", mode, target: mode === "ip" ? (ip || "本机 IP") : domain, status: "running", code: null, log: "", startedAt: Date.now(), finishedAt: null };
  certJobs.set(id, job);
  certJobRunning = true;
  const script = `cd /root && printf '%s\\n' ${lines.map(shQuote).join(" ")} | bash <(curl -Ls ${ACME_URL})`;
  hostExec(["bash", "-c", script], {}, 600000).then((r) => {
    const caLog = readFileSafe(path.join(YGKKKCA_DIR, "ca.log"))?.trim() || "";
    const target = mode === "ip" ? (ip || "").split(" ")[0] : domain.replace(/^\*\./, "");
    const installed = fileExists(path.join(YGKKKCA_DIR, "cert.crt")) && fileExists(path.join(YGKKKCA_DIR, "private.key"));
    const match = target ? (caLog === target || caLog.includes(target)) : installed;
    job.code = r.code;
    job.log = maskWithSecrets(r.out + "\n" + r.err, secrets).slice(-12000);
    job.status = r.code === 0 && installed && match ? "done" : "failed";
    job.finishedAt = Date.now();
    certJobRunning = false;
    audit("cert-apply-" + mode, `目标 ${job.target}`, job.status);
  });
  audit("cert-apply-start", `方式 ${mode}，目标 ${job.target}`, "running");
  return c.json({ ok: true, jobId: id });
});
app.get("/api/cert/jobs/:id", (c) => {
  const job = certJobs.get(c.req.param("id"));
  if (!job) return c.json({ ok: false, error: "任务不存在（可能服务已重启）" }, 404);
  return c.json({ ok: true, job });
});
// ---- acme-yg: delete (menu 4 — ALL certs + uninstall acme.sh; double-confirm) ----
app.post("/api/cert/delete-confirm", async (c) => {
  return c.json({ ok: true, confirmToken: newConfirmToken(), warning: "删除证书并卸载 acme.sh：删掉 /root/ygkkkca、~/.acme.sh，清除自动续期 cron。删完没有证书可用，alns 会自动切回内置自签，须重新 rep 才生效。" });
});
app.post("/api/cert/delete", async (c) => {
  const { confirmToken } = await c.req.json().catch(() => ({} as any));
  if (!confirmToken || !consumeConfirmToken(confirmToken)) return c.json({ ok: false, error: "请先点确认拿到凭证" }, 400);
  if (certJobRunning) return c.json({ ok: false, error: "已有证书任务在执行，请等它完成" }, 409);
  const id = randomBytes(8).toString("hex");
  const job: CertJob = { id, kind: "delete", mode: "delete", target: "全部证书 + acme.sh", status: "running", code: null, log: "", startedAt: Date.now(), finishedAt: null };
  certJobs.set(id, job);
  certJobRunning = true;
  const script = `cd /root && printf '4\\n' | bash <(curl -Ls ${ACME_URL})`;
  hostExec(["bash", "-c", script], {}, 300000).then((r) => {
    const gone = !fileExists(path.join(YGKKKCA_DIR, "cert.crt"));
    job.code = r.code;
    job.log = maskSecrets(r.out + "\n" + r.err).slice(-8000);
    job.status = r.code === 0 && gone ? "done" : "failed";
    job.finishedAt = Date.now();
    certJobRunning = false;
    if (job.status === "done") {
      const v = loadVars();
      v.alns = "";
      saveVars(v);
    }
    audit("cert-delete", "删除证书并卸载 acme.sh", job.status);
  });
  return c.json({ ok: true, jobId: id });
});

app.notFound((c) => c.json({ ok: false, error: "404 Not found" }, 404));
export default { port: PORT, fetch: app.fetch };
console.log(`[argosbx-ui] ${VERSION} listening on :${PORT}`);
