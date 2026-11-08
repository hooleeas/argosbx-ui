// argosbx-ui admin UI — plain HTML + module JS. No secrets are ever
// displayed in full: uuid / agk / subid come back masked from the server.
const $ = (id) => document.getElementById(id);
const PROTOS = [
  ["anpt", "AnyTLS"], ["tupt", "TUIC5"], ["arpt", "Any-Reality"], ["sspt", "Shadowsocks 2022"], ["nvpt", "NaiveProxy"],
  ["vxpt", "VLESS-xhttp-enc（仅 beta）"], ["vwpt", "VLESS-ws-enc"], ["xhpt", "VLESS xhttp-reality"], ["xupt", "VLESS xhttp-tls-UDP H3"], ["xcpt", "VLESS xhttp-tls-TCP/UDP"], ["vlpt", "VLESS Reality-Vision"],
  ["hypt", "Hysteria2"], ["vmpt", "VMess-ws"], ["sopt", "Socks5"],
];
// 协议页按内核分组；PROTOS 的扁平顺序即组内顺序，collectVars/fillForm 共用。
const PROTO_GROUPS = [
  { title: "sing-box", keys: ["anpt", "tupt", "arpt", "sspt", "nvpt"] },
  { title: "Xray", keys: ["vxpt", "vwpt", "xhpt", "xupt", "xcpt", "vlpt"] },
  { title: "双核（Xray + sing-box）", keys: ["hypt", "vmpt", "sopt"] },
];
const PROTO_LABEL = Object.fromEntries(PROTOS);
// 有独立端口文件的协议（livePorts 里有 key 的）：开关以 JP 实际生效端口为准。
const PORT_PROTOS = ["anpt", "arpt", "hypt", "tupt", "vmpt", "vwpt", "vxpt", "xcpt", "xhpt", "xupt"];
let vars = {};
let confirmToken = "";
let pendingDiff = [];

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showLogin(); throw new Error("未登录"); }
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function showLogin() { $("login").hidden = false; $("app").hidden = true; $("logout").hidden = true; }
function showApp() { $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false; }
// 无需确认的提示：点保存/导入后告诉用户点了没，几秒后自己消失，不用点确定。
let toastTimer = null;
function showToast(msg, isErr) {
  const el = $("toast"); if (!el) return;
  el.textContent = msg; el.classList.toggle("err", !!isErr); el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isErr ? 6000 : 4000);
}

function buildProtoForm() {
  $("protoForm").innerHTML = PROTO_GROUPS.map((g) =>
    `<h3 class="proto-group">${g.title}</h3>` + g.keys.map((k) => `
    <div class="proto-row"><label class="switch-wrap"><input type="checkbox" id="on-${k}"><span class="slider"></span></label><label class="proto-name" for="on-${k}">${PROTO_LABEL[k]}</label>
    <span class="proto-state" id="st-${k}">未启用</span>
    <label class="proto-port-label" for="f-${k}">端口</label>
    <input type="text" id="f-${k}" placeholder="留空沿用旧端口，无则随机" inputmode="numeric"></div>`).join("")).join("");
}
// 纯展示：每行拉杆旁的「已启用 / 未启用」文字，跟着拉杆状态走。
function syncProtoStates() {
  for (const [k] of PROTOS) {
    const el = $("st-" + k), sw = $("on-" + k);
    if (!el || !sw) continue;
    el.textContent = sw.checked ? "已启用" : "未启用";
    el.classList.toggle("on", sw.checked);
  }
  // 开放所有端口（oap）拉杆旁的状态文字，跟着 f-oap 走。
  const oapEl = $("st-oap"), oapSw = $("f-oap");
  if (oapEl && oapSw) {
    oapEl.textContent = oapSw.checked ? "已启用" : "未启用";
    oapEl.classList.toggle("on", oapSw.checked);
  }
}
// 勾选状态以 JP 实际在跑的为准：有生效端口的协议 = 已开，没端口的 = 未开；
// 无独立端口文件的协议（vlpt/sspt/sopt/nvpt）沿用数据库 __on（fillForm 已填好）。
function applyLiveProtoState(livePorts) {
  for (const k of PORT_PROTOS) {
    const el = $("on-" + k);
    if (el) el.checked = !!livePorts[k];
  }
}
// Argo 主协议联动：隧道页选了 argo=vmpt/vwpt/vxpt，对应协议的拉杆开关自动打开，
// 不用用户手动去协议页找；只改开关，不动端口（端口留空仍沿用已有的）。
// 在 f-argo 切换时和登录加载后都跑一次；argo 为空（关闭隧道）时不做任何事。
// 注意调用顺序：必须在 applyLiveProtoState 之后，否则 livePorts 会把刚自动
// 打开的开关再按“没生效端口”关回去。
function updateArgoHint() {
  const argo = $("f-argo").value;
  const hint = $("argoHint");
  if (!argo || !["vmpt", "vwpt", "vxpt"].includes(argo)) { if (hint) { hint.hidden = true; hint.textContent = ""; } return; }
  const sw = $("on-" + argo);
  if (sw && !sw.checked) {
    sw.checked = true;
    if (hint) { hint.hidden = false; hint.textContent = `已自动打开 ${argo}（${PROTO_LABEL[argo]}），端口沿用已有的。`; }
  } else if (hint) { hint.hidden = true; hint.textContent = ""; }
}
function collectVars() {
  const v = { ...vars };
  for (const [k] of PROTOS) { v[k + "__on"] = $("on-" + k).checked ? "1" : ""; v[k] = $("f-" + k).value.trim(); }
  for (const k of ["name", "reym", "cfip", "warp", "ippz", "hyjpt", "argo", "agn", "agqc"]) v[k] = $( "f-" + k).value;
  v.oap = $("f-oap").checked ? "y" : "";
  // 证书二选一：选「域名证书」= alns=y，选「内置证书（自签）」= alns 为空。
  v.alns = (document.querySelector('input[name="certChoice"]:checked')?.value === "own") ? "y" : "";
  v.sub = $("f-sub").checked ? "y" : "";
  const agk = $("f-agk").value;
  if (agk && !agk.includes("•")) v.agk = agk;
  v.subid = $("f-subid").value.trim();
  v.subpt = $("f-subpt").value.trim();
  return v;
}
function fillForm(v) {
  vars = v;
  for (const [k] of PROTOS) { $("on-" + k).checked = !!v[k + "__on"]; $("f-" + k).value = v[k] || ""; }
  for (const k of ["name", "reym", "cfip", "warp", "ippz", "hyjpt", "argo", "agn", "agqc"]) { const el = $("f-" + k); if (el) el.value = v[k] || ""; }
  $("f-oap").checked = !!v.oap; $("f-sub").checked = !!v.sub;
  // 证书二选一跟 alns 互转：alns=y 选中「域名证书」，否则选中「内置证书（自签）」。
  document.querySelectorAll('input[name="certChoice"]').forEach((r) => { r.checked = (r.value === "own") === !!v.alns; });
  syncCertChoice();
  $("f-agk").value = v.agk || ""; // masked value from server; sending it back keeps the stored value
  $("f-subid").value = v.subid || ""; $("f-subpt").value = v.subpt || "";
}
// 证书二选一：当前选中的那项一眼看得出（绿边 + 浅绿底 +「✓ 已选」）。
function syncCertChoice() {
  document.querySelectorAll(".cert-option").forEach((lab) => {
    const r = lab.querySelector('input[type="radio"]');
    const on = !!(r && r.checked);
    lab.classList.toggle("on", on);
    const tag = lab.querySelector(".picked");
    if (tag) tag.hidden = !on;
  });
}
// 证书到底在用谁：以 JP 实际生效的配置为准（xr.json/sb.json 里的证书路径），
// 不拿 alns 判断——alns 只是下一次 rep 想用什么的意愿。alns 为空是“不知道”，
// 不是“关”（alns 本来就不在 sh.txt 里，import-live 恢复不出它）。
function certUsageLive(live, cert, selfCert) {
  const domain = (cert.subject || "").replace(/^CN=/, "") || cert.caLog || live.caLog || "—";
  const sc = selfCert || {};
  if (live.inUse === "own") return { kind: "own", big: "✓ 正在使用域名证书", sub: `颁发者：${cert.issuer || "—"} · 域名：<span class="cert-domain">${domain}</span> · 到期：${cert.notAfter || "—"} · 开始：${cert.notBefore || "—"}` };
  if (live.inUse === "mixed") return { kind: "warn", big: "⚠ 证书混用：部分协议用域名证书，部分用自签", sub: `域名证书引用 ${live.ygkkkcaRefs} 处，自签引用 ${live.agsbxRefs} 处。` };
  if (live.inUse === "self") return { kind: "self", big: "正在使用自签证书（内置）", sub: `签发者：${sc.issuer || "CN=www.bing.com"} · 主体：${sc.subject || "CN=www.bing.com"} · 有效期至 ${sc.notAfter || "—"}（100 年）。` + (cert.exists ? `磁盘上有域名证书 <span class="cert-domain">${domain}</span>，到期 ${cert.notAfter || "—"}，但现在没用上。` : "还没办域名证书。") };
  return { kind: "warn", big: "证书在用谁未知", sub: "配置里没找到证书路径引用。" };
}
// 横条分两行写清楚：现状一行（实际在用谁），你的选择一行（下次 rep 生效），
// 不要混成一句。选择与现状不一致时给警告：选了内置但实际在用域名证书，
// 下次 rep 会切回自签；选了域名证书但证书文件不存在，rep 会挂起。
function renderCertBanner(live, cert, selfCert, alnsIntent) {
  const u = certUsageLive(live, cert, selfCert);
  const choice = alnsIntent ? "域名证书（acme-yg）" : "内置证书（自签）";
  let warn = "";
  if (live.inUse === "own" && !alnsIntent) warn = "注意：你的选择是内置证书，下次 rep 会切回自签；想继续用域名证书，请先选「域名证书」。";
  else if (live.inUse === "self" && alnsIntent && !cert.exists) warn = "注意：你选了域名证书，但证书文件不存在，rep 会挂起，请先办证。";
  const el = $("certBanner");
  if (el) el.innerHTML = `<div class="cert-banner ${u.kind}"><div class="big">${u.big}</div><div class="sub">${u.sub}</div><div class="sub">你的选择（下次 rep 生效）：${choice}</div>${warn ? `<div class="sub warn">${warn}</div>` : ""}</div>`;
  return u;
}
// ---- acme-yg 证书列表 / 申请 / 删除 ----
// 查询只读：来源是 JP 上 ~/.acme.sh 的实际记录（acme.sh --list）。
async function loadCertList() {
  const el = $("certList");
  if (!el) return;
  try {
    const j = await api("/api/cert/list");
    if (!j.installed) { el.innerHTML = "<p>未安装 acme.sh（~/.acme.sh 不存在）。</p>"; return; }
    if (!j.certs.length) { el.innerHTML = "<p>没有已申请的证书记录。</p>"; return; }
    el.innerHTML = `<table class="cert-table"><tr><th>域名</th><th>密钥</th><th>申请</th><th>续期</th></tr>` +
      j.certs.map((x) => `<tr><td>${x.domain}</td><td>${x.keyLength || "—"}</td><td>${x.created || "—"}</td><td>${x.renew || "—"}</td></tr>`).join("") + "</table>";
  } catch (e) { el.innerHTML = `<p class="err">查询失败：${e.message}</p>`; }
}
const APPLY_WARNS = {
  ip: "注意：80 端口模式会强制释放 80 端口；IP 证书只有 3 天有效期。申请流程会重装 acme.sh，旧证书记录会被清除，申请失败时现有证书也可能被删。",
  domain: "注意：80 端口模式会强制释放 80 端口；域名须先解析到本机 IP，CDN 小黄云须关，否则不开始申请。申请流程会重装 acme.sh，旧证书记录会被清除，申请失败时现有证书也可能被删。",
  dns: "注意：不占 80 端口；域名须先解析到本机 IP；泛域名须先在服务商解析处加一条名称为 * 的记录。DNS 凭证只用于本次申请，不保存、不记日志。申请流程会重装 acme.sh，旧证书记录会被清除。",
};
function renderApplyFields() {
  const mode = $("applyMode").value;
  const box = $("applyFields");
  $("applyWarn").textContent = APPLY_WARNS[mode] || "";
  const email = `<label>注册邮箱 <input id="applyEmail" type="email" placeholder="留空自动生成虚拟邮箱" autocomplete="off"></label>`;
  if (mode === "ip") {
    box.innerHTML = email + `<label>IP <input id="applyIp" placeholder="留空用本机 IP（IPv4、IPv6 或“IPv4 IPv6”）" autocomplete="off"></label>`;
  } else if (mode === "domain") {
    box.innerHTML = email + `<label>域名 <input id="applyDomain" placeholder="例如 acme-jp.hooleeas.com" autocomplete="off"></label>`;
  } else {
    box.innerHTML = email + `<label>域名 <input id="applyDomain" placeholder="单域名或 *.example.com" autocomplete="off"></label>
    <label>DNS 服务商 <select id="applyProvider"><option value="cf">Cloudflare</option><option value="dp">腾讯云 DNSPod</option><option value="ali">阿里云</option></select></label>
    <div id="applyProviderFields"></div>`;
    renderProviderFields();
    $("applyProvider").onchange = renderProviderFields;
  }
}
function renderProviderFields() {
  const p = $("applyProvider")?.value;
  const box = $("applyProviderFields");
  if (!box) return;
  if (p === "cf") {
    box.innerHTML = `<label>验证方式 <select id="applyCfMethod"><option value="token">API Token（推荐）</option><option value="gkey">Global API Key</option></select></label><div id="applyCfFields"></div>`;
    renderCfFields();
    $("applyCfMethod").onchange = renderCfFields;
  } else if (p === "dp") {
    box.innerHTML = `<label>DP_Id <input id="applyDpId" autocomplete="off"></label><label>DP_Key <input id="applyDpKey" type="password" autocomplete="off"></label>`;
  } else if (p === "ali") {
    box.innerHTML = `<label>Ali_Key <input id="applyAliKey" autocomplete="off"></label><label>Ali_Secret <input id="applyAliSecret" type="password" autocomplete="off"></label>`;
  }
}
function renderCfFields() {
  const m = $("applyCfMethod")?.value;
  const box = $("applyCfFields");
  if (!box) return;
  box.innerHTML = m === "token"
    ? `<label>Cloudflare 账户 ID <input id="applyCfAccountId" autocomplete="off"></label><label>Cloudflare DNS API Token <input id="applyCfToken" type="password" autocomplete="off"></label>`
    : `<label>Cloudflare 注册邮箱 <input id="applyCfEmail" type="email" autocomplete="off"></label><label>Cloudflare Global API Key <input id="applyCfKey" type="password" autocomplete="off"></label>`;
}
// 申请/删除跑异步任务：每 2 秒轮询一次任务状态 + 打码后的日志，跑完刷新全部状态。
function pollCertJob(id, statusEl, logEl, doneMsg) {
  const t = setInterval(async () => {
    try {
      const j = await api("/api/cert/jobs/" + id);
      const job = j.job;
      if (statusEl) statusEl.textContent = job.status === "running" ? "执行中…" : job.status === "done" ? doneMsg : "失败（见日志）";
      if (logEl) logEl.textContent = job.log || "执行中…";
      if (job.status !== "running") { clearInterval(t); await loadAll(); }
    } catch (e) { clearInterval(t); if (statusEl) statusEl.textContent = "查询任务状态失败：" + e.message; }
  }, 2000);
}
async function startCertApply() {
  const mode = $("applyMode").value;
  const body = { mode, email: $("applyEmail")?.value.trim() || "" };
  if (mode === "ip") body.ip = $("applyIp")?.value.trim() || "";
  if (mode === "domain" || mode === "dns") body.domain = $("applyDomain")?.value.trim() || "";
  if (mode === "dns") {
    body.provider = $("applyProvider").value;
    if (body.provider === "cf") {
      body.cfMethod = $("applyCfMethod").value;
      if (body.cfMethod === "token") { body.cfAccountId = $("applyCfAccountId")?.value.trim(); body.cfToken = $("applyCfToken")?.value; }
      else { body.cfEmail = $("applyCfEmail")?.value.trim(); body.cfKey = $("applyCfKey")?.value; }
    } else if (body.provider === "dp") { body.dpId = $("applyDpId")?.value.trim(); body.dpKey = $("applyDpKey")?.value; }
    else if (body.provider === "ali") { body.aliKey = $("applyAliKey")?.value.trim(); body.aliSecret = $("applyAliSecret")?.value; }
  }
  if (!confirm("确定申请新证书？\n" + ($("applyWarn").textContent || ""))) return;
  try {
    const { confirmToken } = await api("/api/cert/apply-confirm", { method: "POST", body: "{}" });
    const j = await api("/api/cert/apply", { method: "POST", body: JSON.stringify({ ...body, confirmToken }) });
    $("applyJob").hidden = false;
    $("applyStatus").textContent = "申请中…（可能需要几分钟，请勿关闭页面）";
    $("applyLog").textContent = "";
    pollCertJob(j.jobId, $("applyStatus"), $("applyLog"), "申请成功，已刷新证书状态。");
  } catch (e) { alert(e.message); }
}
// 删除是双重确认：两次 confirm + 服务端确认凭证。删完 alns 自动切回内置自签。
async function startCertDelete() {
  const alnsOn = document.querySelector('input[name="certChoice"]:checked')?.value === "own";
  if (!confirm("确定删除全部证书并卸载 acme.sh？\n会删掉 /root/ygkkkca、~/.acme.sh，清除自动续期 cron。" + (alnsOn ? "\n你现在正在用域名证书，删完会回落到内置自签，须重新 rep 才生效。" : ""))) return;
  try {
    const { confirmToken } = await api("/api/cert/delete-confirm", { method: "POST", body: "{}" });
    if (!confirm("最后确认：真的删除？删完没有证书可用，只能重新申请。")) return;
    const j = await api("/api/cert/delete", { method: "POST", body: JSON.stringify({ confirmToken }) });
    $("certDeleteStatus").textContent = "删除中…";
    pollCertJob(j.jobId, $("certDeleteStatus"), null, "已删除，证书选择已切回内置自签。");
  } catch (e) { alert(e.message); }
}
async function loadAll() {
  // 登录后自动就是 JP 现状：数据库里还没保存过变量时，先调一次 import-live
  // 导入 JP 现状再填表；已保存过的不覆盖（import-live 只填空字段）。
  let s = await api("/api/status");
  if (!s.varsSaved) {
    try { await api("/api/import-live", { method: "POST", body: "{}" }); s = await api("/api/status"); }
    catch (e) { /* 导入失败也继续显示现状，手动点导入可重试 */ }
  }
  const [n, vv, cert] = await Promise.all([
    api("/api/nodes"), api("/api/vars"), api("/api/cert"),
  ]).catch((e) => { throw e; });
  const sub = s;
  $("ver").textContent = s.version || "";
  $("serverInfo").innerHTML = `
    <p>nsenter（进宿主机执行）：${s.nsenter ? "可用" : "不可用"}</p>
    <p>相关进程数：${s.procsRunning} · 固定隧道域名：${s.argoDomain || "—"}（token：${s.tokenExists ? "已存" : "无"}）</p>
    <p>Argo 主协议端口：${s.argoPort || "—"}（${s.vlvm || "—"}）· 传输：${s.cftupr}</p>
    <p>已生效端口：${Object.entries(s.livePorts).map(([k, v]) => k + "=" + v).join(" ") || "—"}</p>
    <p>变量已保存到数据库：${s.varsSaved ? "是" : "否（自动导入失败，请手动点导入）"}</p>
    <p>上次完整命令（已打码）：</p><pre>${s.shTxt || "—"}</pre>`;
  $("nodeCount").textContent = n.count;
  $("nodeList").innerHTML = n.nodes.map((x) => `<li>${x.name} <small>(${x.proto})</small></li>`).join("") || "<li>无节点</li>";
  // 纯展示：服务器页顶部状态卡片，隧道 / 证书 / 订阅 / 节点一眼看清。
  // 证书卡片按「在用谁」显示（xr.json/sb.json 里的证书路径），不要只按文件
  // 存在显示「有效」，也不要拿 alns 判断。
  const live = cert.live || { inUse: "unknown", ygkkkcaRefs: 0, agsbxRefs: 0, caLog: "" };
  const certDomain = (cert.cert.subject || "").replace(/^CN=/, "") || cert.cert.caLog || live.caLog || "";
  const certCard = live.inUse === "own"
    ? `<div class="status-card cert"><div class="k">证书</div><div class="v ok">域名证书</div><div class="s"><span class="cert-domain">${certDomain || "—"}</span> · 到期 ${cert.cert.notAfter || "—"}</div></div>`
    : live.inUse === "mixed"
    ? `<div class="status-card cert"><div class="k">证书</div><div class="v bad">⚠ 混用</div><div class="s">部分域名证书，部分自签</div></div>`
    : live.inUse === "unknown"
    ? `<div class="status-card cert"><div class="k">证书</div><div class="v bad">未知</div><div class="s">配置里没找到证书路径</div></div>`
    : `<div class="status-card cert"><div class="k">证书</div><div class="v">自签证书</div><div class="s">${cert.cert.exists ? "磁盘有域名证书，未用上" : "未办域名证书"}</div></div>`;
  const subOk = sub.sub.enabled;
  $("statusCards").innerHTML = `
    <div class="status-card wide"><div class="k">固定隧道</div><div class="v${s.argoDomain ? " ok" : " bad"}">${s.argoDomain || "未配置"}</div><div class="s">token：${s.tokenExists ? "已存" : "无"} · ${s.vlvm || "—"} ${s.argoPort || ""} · ${s.cftupr || ""}</div></div>
    ${certCard}
    <div class="status-card"><div class="k">订阅</div><div class="v${subOk ? " ok" : " bad"}">${subOk ? "已启用" : "未启用"}</div><div class="s">${subOk ? "端口 " + sub.sub.port + " · " + (sub.sub.httpOk.jhsub ? "可达 200" : "不可达") : "—"}</div></div>
    <div class="status-card"><div class="k">节点</div><div class="v">${n.count} 条</div><div class="s">进程 ${s.procsRunning} 个 · nsenter ${s.nsenter ? "可用" : "不可用"}</div></div>`;
  fillForm(vv.vars);
  applyLiveProtoState(s.livePorts || {});
  updateArgoHint();
  syncProtoStates();
  renderCertBanner(live, cert.cert, cert.selfCert || {}, !!vv.vars.alns);
  $("certInfo").innerHTML = cert.cert.exists
    ? `<p>证书：${cert.cert.caLog || "—"} · 到期：${cert.cert.notAfter || "—"} · 开始：${cert.cert.notBefore || "—"}</p><p>自动续期 cron：${cert.autoRenewCron || "无"}</p>`
    : "<p>无证书（/root/ygkkkca/cert.crt 不存在）</p>";
  loadCertList();
  $("subInfo").innerHTML = sub.sub.enabled
    ? `<p>订阅端口：${sub.sub.port} · 直连可达：${sub.sub.httpOk.jhsub ? "是（200）" : "否"}</p>` +
      sub.sub.files.map((f) => `<p>${f.file}：${f.exists ? f.lines + " 行" : "不存在"}</p>`).join("")
    : "<p>订阅未启用</p>";
  const a = await api("/api/audit");
  $("auditList").innerHTML = a.rows.map((r) => `<li>${new Date(r.ts).toLocaleString()} ${r.op}：${r.result}</li>`).join("") || "<li>无记录</li>";
}
async function savePreview() {
  const v = collectVars();
  try {
    const j = await api("/api/rep/dry-run", { method: "POST", body: JSON.stringify(v) });
    pendingDiff = j.diff; confirmToken = j.confirmToken;
    // Argo 联动自动开启的协议，在 diff 里明写一行，用户在点 rep 前看得见。
    const autoLines = (j.autoEnabled || []).map((k) => `<p>已自动开启 ${k}（${PROTO_LABEL[k]}）。</p>`).join("");
    // 端口留空的生效情况：有旧端口就沿用，没有就由 rep 时脚本随机（10000–65535）。
    const portLines = (j.portPlan || []).map((p) => p.mode === "reuse"
      ? `<p>${p.key}（${PROTO_LABEL[p.key]}）：端口留空，将沿用旧端口 ${p.port}。</p>`
      : `<p>${p.key}（${PROTO_LABEL[p.key]}）：端口留空，没有旧端口，rep 时将随机分配端口（10000–65535）。</p>`).join("");
    $("diffBox").innerHTML = autoLines + portLines + (j.diff.length ? j.diff.map((d) => `<p>${d.key}：${d.from || "（空）"} → ${d.to || "（空）"}</p>`).join("") : "<p>没有改动。</p>") + `<p class="hint">${j.warning}</p>`;
    $("repBtn").disabled = !j.diff.length;
    showToast(j.diff.length ? `已保存，预览已生成（${j.diff.length} 项改动），尚未生效——去操作页确认 rep 才生效。` : "已保存，没有改动，无需 rep。");
  } catch (e) {
    // 校验报错原样显示在改动确认区（不发确认凭证、不启用 rep），不只弹通用提示。
    confirmToken = ""; $("repBtn").disabled = true;
    $("diffBox").innerHTML = `<p class="err">${e.message}</p>`;
    showToast("保存失败：" + e.message, true);
  }
}
async function doRep() {
  if (!confirmToken) return;
  if (!confirm("rep 会杀掉代理进程并重建配置，服务短暂中断，确定执行？")) return;
  $("logBox").textContent = "rep 执行中，请稍等…";
  try {
    const j = await api("/api/rep", { method: "POST", body: JSON.stringify({ confirmToken }) });
    $("logBox").textContent = `rep 完成（code=${j.code}，节点 ${j.nodesCount} 条，备份 ${j.backupDir}）\n` + j.log;
    confirmToken = ""; $("repBtn").disabled = true; await loadAll();
  } catch (e) { $("logBox").textContent = "rep 失败：" + e.message; }
}
async function op(action, needConfirm) {
  try {
    if (action === "list") { const j = await api("/api/ops/list", { method: "POST", body: "{}" }); $("logBox").textContent = j.log; await loadAll(); return; }
    let tok = "";
    if (needConfirm) {
      if (!confirm(`${action} 会杀掉对应进程，服务短暂中断，确定？`)) return;
      tok = (await api("/api/ops/confirm", { method: "POST", body: JSON.stringify({ action }) })).confirmToken;
    }
    const j = await api("/api/ops/" + action, { method: "POST", body: JSON.stringify({ confirmToken: tok }) });
    $("logBox").textContent = `${action} 完成（code=${j.code}，备份 ${j.backupDir}）\n` + j.log;
    await loadAll();
  } catch (e) { $("logBox").textContent = action + " 失败：" + e.message; }
}
// ---- 自定义弹窗（站内弹窗，不用浏览器原生 confirm）----
let modalOkHandler = null;
function openModal(title, bodyHtml, okLabel, okDanger) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHtml;
  const ok = $("modalOk");
  ok.textContent = okLabel;
  ok.className = okDanger ? "danger" : "primary";
  ok.disabled = false;
  $("modalOverlay").hidden = false;
}
function closeModal() { $("modalOverlay").hidden = true; modalOkHandler = null; }
$("modalCancel").onclick = closeModal;
$("modalOk").onclick = () => { if (modalOkHandler) modalOkHandler(); };
$("modalOverlay").addEventListener("click", (e) => { if (e.target === $("modalOverlay")) closeModal(); });
// ---- 卸载 ArgoSBX：弹窗双重确认 ----
// 第一步：列清删什么、备份什么；第二步：输入「卸载」二字才放行红色确认按钮。
// 备份清单由服务端预检返回（实际存在才写“会备份”，不存在的写“不存在，跳过”）。
const UNINSTALL_DELETES = ["全部节点与订阅链接（/root/agsbx/jhsub.txt 等）", "全部协议配置（/root/agsbx/xr.json、sb.json）", "订阅生成目录 /root/websbx", "启动脚本 /root/bin/agsbx 与安装标记 sbx_update", "xr / sb / argo 三个服务与相关定时任务"];
async function startUninstall() {
  try {
    const pre = await api("/api/uninstall/confirm", { method: "POST", body: "{}" });
    if (!pre.installed) { showToast("ArgoSBX 未安装，无需卸载。", true); return; }
    const backupList = pre.backupItems.map((b) => `<li>${b.path}（${b.label}）${b.exists ? "——会备份" : "——不存在，跳过"}</li>`).join("");
    openModal("卸载 ArgoSBX",
      `<p>这会删掉：</p><ul>${UNINSTALL_DELETES.map((d) => `<li>${d}</li>`).join("")}</ul>
       <p>卸载前先自动备份快照到宿主 <code>${pre.backupPrefix}&lt;时间戳&gt;/</code>，备份清单：</p><ul>${backupList}</ul>
       <p class="hint">备份失败不执行卸载。Web 界面、数据库里的变量组、Cloudflare 侧固定隧道定义不动；重装时在操作页用保存的变量组执行一次 rep 即可。</p>`,
      "下一步：确认卸载", false);
    modalOkHandler = () => step2Uninstall(pre);
  } catch (e) { showToast("卸载预检失败：" + e.message, true); }
}
function step2Uninstall(pre) {
  openModal("最后确认",
    `<p class="err"><strong>真的卸载？删完节点全部失效，订阅链接打不开，只能靠备份或重新 rep 恢复。</strong></p>
     <p>备份将存到宿主 <code>${pre.backupPrefix}&lt;时间戳&gt;/</code>。</p>
     <label>输入「卸载」二字确认 <input id="uninstallType" placeholder="卸载" autocomplete="off"></label>`,
    "确认卸载", true);
  const input = $("uninstallType");
  const ok = $("modalOk");
  ok.disabled = true;
  input.oninput = () => { ok.disabled = input.value.trim() !== "卸载"; };
  input.focus();
  modalOkHandler = () => doUninstall();
}
async function doUninstall() {
  closeModal();
  $("uninstallStatus").textContent = "正在备份并卸载，请稍等…";
  $("logBox").textContent = "卸载执行中（先备份快照，再跑 del）…";
  try {
    const { confirmToken } = await api("/api/uninstall/confirm", { method: "POST", body: "{}" });
    const j = await api("/api/uninstall", { method: "POST", body: JSON.stringify({ confirmToken }) });
    $("uninstallStatus").textContent = j.ok ? `卸载完成，备份在 ${j.backupDir}` : "卸载未完全成功，见日志。";
    $("logBox").textContent = `卸载${j.ok ? "完成" : "未完全成功"}（code=${j.code}，核验 ${j.verified ? "通过" : "未通过"}，备份 ${j.backupDir}）\n备份清单：\n${j.backupManifest || ""}\n${j.log}`;
    showToast(j.ok ? "已卸载 ArgoSBX，变量组已保留，重装时执行一次 rep 即可。" : "卸载未完全成功，见执行日志。", !j.ok);
    await loadAll();
  } catch (e) {
    $("uninstallStatus").textContent = "卸载失败：" + e.message;
    $("logBox").textContent = "卸载失败：" + e.message;
    showToast("卸载失败：" + e.message, true);
  }
}
document.querySelectorAll("#tabs button").forEach((b) => b.onclick = () => {
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("on"));
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("on"));
  b.classList.add("on"); $("tab-" + b.dataset.tab).classList.add("on");
});
$("loginBtn").onclick = async () => {
  try { await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("pw").value }) }); showApp(); await loadAll(); }
  catch (e) { $("loginErr").textContent = e.message; }
};
$("logout").onclick = async () => { await api("/api/logout", { method: "POST", body: "{}" }); showLogin(); };
const IMPORT_LABELS = { uuid: "UUID", agk: "隧道 token", agn: "隧道域名", argo: "Argo 主协议", alns: "证书选择", name: "节点名前缀", oap: "开放所有端口", reym: "Reality 域名", sub: "订阅", subid: "订阅路径", subpt: "订阅端口", vlpt: "VLESS Reality-Vision", vmpt: "VMess-ws", vwpt: "VLESS-ws", vxpt: "VLESS-xhttp-enc", xhpt: "VLESS xhttp-reality", xupt: "VLESS xhttp-tls-UDP", xcpt: "VLESS xhttp-tls-TCP/UDP", hypt: "Hysteria2", tupt: "TUIC5", anpt: "AnyTLS", arpt: "Any-Reality", sspt: "Shadowsocks 2022", sopt: "Socks5", nvpt: "NaiveProxy" };
const importLabel = (k) => { const base = IMPORT_LABELS[k.replace(/__on$/, "")]; if (!base) return k; return base + (k.endsWith("__on") ? "开关" : ""); };
function renderImportResult(j) {
  const el = $("importResult");
  const lines = [];
  if (j.filled.length) lines.push(`<p>已补 ${j.filled.length} 个空字段：${j.filled.map(importLabel).join("、")}</p>`);
  if (!j.filled.length && !j.diffs.length) lines.push(`<p>数据库已是最新：已比对 ${j.matched} 个字段，都有值且与 JP 现状一致，无需导入。</p>`);
  if (j.diffs.length) {
    lines.push(`<p>以下 ${j.diffs.length} 项数据库 ≠ JP 现状，尚未覆盖：</p><ul>${j.diffs.map((d, i) => `<li><label><input type="checkbox" class="diff-check" data-key="${d.key}" checked> ${importLabel(d.key)}：数据库 ${d.db} → JP 现状 ${d.live}</label></li>`).join("")}</ul><div class="row"><button id="applyDiffsBtn">用 JP 现状覆盖选中差异</button></div>`);
  }
  el.innerHTML = lines.join("");
  const btn = $("applyDiffsBtn");
  if (btn) btn.onclick = async () => {
    const fields = [...document.querySelectorAll(".diff-check:checked")].map((x) => x.dataset.key);
    if (!fields.length) { alert("请先勾选要覆盖的差异项"); return; }
    if (!confirm(`用 JP 现状覆盖选中的 ${fields.length} 项？覆盖后下一次 rep 会用新值。`)) return;
    try {
      const { confirmToken } = await api("/api/import-live/apply-confirm", { method: "POST", body: "{}" });
      const r = await api("/api/import-live/apply", { method: "POST", body: JSON.stringify({ confirmToken, fields }) });
      el.innerHTML = `<p>已覆盖：${r.applied.map(importLabel).join("、")}</p>`;
      showToast(`已覆盖：${r.applied.map(importLabel).join("、")}`);
      await loadAll();
    } catch (e) { showToast("覆盖失败：" + e.message, true); }
  };
}
$("importBtn").onclick = async () => {
  try {
    const j = await api("/api/import-live", { method: "POST", body: "{}" });
    renderImportResult(j);
    showToast(j.diffs.length ? `导入完成，有 ${j.diffs.length} 项与 JP 现状不一致，待你在下方确认覆盖。` : j.filled.length ? `导入完成，已补 ${j.filled.length} 个空字段：${j.filled.map(importLabel).join("、")}` : `数据库已是最新：已比对 ${j.matched} 个字段，无需导入。`);
    await loadAll();
  } catch (e) { showToast("导入失败：" + e.message, true); }
};
for (const id of ["saveBtn", "saveBtn2", "saveBtn3", "saveBtn4"]) $(id).onclick = () => savePreview().catch((e) => showToast("保存失败：" + e.message, true));
$("repBtn").onclick = doRep;
$("listBtn").onclick = () => op("list");
$("upxBtn").onclick = () => op("upx", true);
$("upsBtn").onclick = () => op("ups", true);
$("upaBtn").onclick = () => op("upa", true);
$("resBtn").onclick = () => op("res", true);
$("uninstallBtn").onclick = startUninstall;
$("renewBtn").onclick = async () => {
  if (!confirm("手动续期全部证书，确定？")) return;
  try {
    const { confirmToken: t } = await api("/api/cert/renew-confirm", { method: "POST", body: "{}" });
    const j = await api("/api/cert/renew", { method: "POST", body: JSON.stringify({ confirmToken: t }) });
    $("logBox").textContent = "续期完成\n" + j.log; await loadAll();
  } catch (e) { alert(e.message); }
};
buildProtoForm();
renderApplyFields();
$("applyMode").onchange = renderApplyFields;
$("applyBtn").onclick = startCertApply;
$("certDeleteBtn").onclick = startCertDelete;
$("certListRefreshBtn").onclick = loadCertList;
$("protoForm").addEventListener("change", syncProtoStates);
$("f-oap").addEventListener("change", syncProtoStates);
$("f-argo").onchange = () => { updateArgoHint(); syncProtoStates(); };
document.querySelectorAll('input[name="certChoice"]').forEach((r) => r.addEventListener("change", syncCertChoice));
api("/api/me").then((j) => { if (j.loggedIn) { showApp(); loadAll().catch((e) => alert(e.message)); } else showLogin(); }).catch(showLogin);
