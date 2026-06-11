import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION = process.env.SESSION_SECRET || "purc-letter-tracker-session";
const OFFICIAL_LOGO_URL = "https://portal.purc.com.gh/sig_theme/static/src/img/purc_logo.png";

function trim(value = "") {
  return String(value).trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeJson(value = "") {
  return JSON.stringify(String(value)).slice(1, -1);
}

function readConfigFile() {
  const candidates = [
    path.join(__dirname, "supabase_config.txt"),
    path.join(__dirname, "..", "cpp-supabase", "supabase_config.txt")
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const values = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > -1) values[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (values.SUPABASE_URL && values.SUPABASE_ANON_KEY) return values;
  }
  return {};
}

const fileConfig = readConfigFile();
const SUPABASE_URL = (process.env.SUPABASE_URL || fileConfig.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || fileConfig.SUPABASE_ANON_KEY || "";
const CACHE_TTL_MS = 15000;
const responseCache = new Map();

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

const userFile = path.join(__dirname, "users_config.txt");

function roleFor(username, role = "Staff") {
  if (trim(username).toUpperCase() === "CHANTEL") return "Admin";
  return role === "Admin" ? "Admin" : "Staff";
}

function loadUsers() {
  const users = new Map();
  const envUsers = process.env.AUTH_USERS || "";
  for (const part of envUsers.split(";")) {
    const idx = part.indexOf(":");
    if (idx > -1) {
      const username = trim(part.slice(0, idx));
      const password = trim(part.slice(idx + 1));
      if (username && password) users.set(username, { password, role: roleFor(username) });
    }
  }
  const candidates = [userFile, path.join(__dirname, "..", "cpp-supabase", "users_config.txt")];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const username = trim(line.slice(0, idx));
      let password = trim(line.slice(idx + 1));
      let role = roleFor(username);
      const roleIdx = password.lastIndexOf(":");
      if (roleIdx > -1 && ["Admin", "Staff"].includes(password.slice(roleIdx + 1).trim())) {
        role = roleFor(username, password.slice(roleIdx + 1).trim());
        password = password.slice(0, roleIdx).trim();
      }
      if (username && password) users.set(username, { password, role });
    }
    if (users.size) break;
  }
  if (!users.size) users.set("CHANTEL", { password: "Purc@123", role: "Admin" });
  for (const [username, record] of users) users.set(username, { ...record, role: roleFor(username, record.role) });
  return users;
}

function saveUsers(users) {
  fs.writeFileSync(userFile, [...users.entries()].map(([u, record]) => `${u}:${record.password}:${roleFor(u, record.role)}`).join("\n") + "\n");
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function currentUser(req) {
  const cookies = parseCookies(req);
  if (cookies.purc_session !== SESSION) return "";
  return trim(cookies.purc_user || "STAFF");
}

function currentRole(req) {
  const username = currentUser(req);
  if (!username) return "";
  const cookies = parseCookies(req);
  return roleFor(username, cookies.purc_role || "Staff");
}

function isAdmin(req) {
  return currentRole(req) === "Admin";
}

function passwordOk(password) {
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}

function passwordRulesText() {
  return "Use 8+ characters with uppercase, lowercase, number, and special character.";
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function longDate() {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
}

function timestamp(value = "") {
  return String(value).replace("T", " ").replace(/\.\d+.*/, "").replace(/[+Z].*/, "");
}

function monthLabel(value = "") {
  if (!/^\d{4}-\d{2}$/.test(value)) return value || "Unknown Month";
  const [year, month] = value.split("-");
  const name = new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(Number(year), Number(month) - 1, 1));
  return `${name} ${year}`;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return Object.fromEntries(new URLSearchParams(body));
}

function redirect(res, location, cookies = []) {
  res.writeHead(303, { Location: location, "Set-Cookie": cookies, "Content-Length": 0 });
  res.end();
}

function send(res, html, status = 200, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...extra });
  res.end(html);
}

async function supabase(pathname, { method = "GET", body, csv = false } = {}) {
  if (!configured()) throw new Error("Supabase is not configured.");
  const cacheKey = `${method}:${csv ? "csv" : "json"}:${pathname}`;
  if (method === "GET") {
    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;
  } else {
    responseCache.clear();
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: csv ? "text/csv" : "application/json",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase request failed: ${response.status}`);
  const value = csv ? text : (text ? JSON.parse(text) : null);
  if (method === "GET") responseCache.set(cacheKey, { time: Date.now(), value });
  return value;
}

async function loadAppUsers() {
  try {
    const rows = await supabase("app_users?select=*&order=username.asc&limit=1000");
    if (Array.isArray(rows)) {
      const users = new Map();
      for (const row of rows) {
        const username = trim(row.username);
        const password = trim(row.password);
        if (username && password) users.set(username, { password, role: roleFor(username, row.role) });
      }
      if (users.size) {
        for (const [username, record] of loadUsers()) {
          if (!users.has(username)) users.set(username, record);
        }
        return users;
      }
    }
  } catch {
    // Fall back to Render/local users if the Supabase user table is not ready.
  }
  return loadUsers();
}

async function saveAppUser(username, password, role = "Staff") {
  username = trim(username);
  const existing = await supabase(`app_users?select=id&username=eq.${encodeURIComponent(username)}&limit=1`);
  const payload = { username, password, role: roleFor(username, role) };
  if (existing.length) {
    await supabase(`app_users?username=eq.${encodeURIComponent(username)}`, { method: "PATCH", body: payload });
  } else {
    await supabase("app_users", { method: "POST", body: payload });
  }
  responseCache.clear();
}

async function updateAppUserRole(username, role) {
  username = trim(username);
  await supabase(`app_users?username=eq.${encodeURIComponent(username)}`, { method: "PATCH", body: { role: roleFor(username, role) } });
  responseCache.clear();
}

function layout(title, body, req) {
  const user = currentUser(req);
  const admin = isAdmin(req);
  const active = (name) => title === name ? " class='active'" : "";
  const adminLinks = admin ? `<a${active("Delete Records")} href="/delete">Delete Records</a><a${active("User Management")} href="/users">Users</a>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title><link rel="icon" href="/purc_logo.png"><style>${styles()}.month-clean:not(.has-value)::-webkit-datetime-edit{color:transparent}.generation-type{display:none}.generation-type.active{display:block}.count{text-decoration:none;color:var(--ink)}</style>
  <script>${clientScript()}</script></head><body>
  <div class="top-strip"><div>Accra, Ghana &nbsp; 0302218300</div><em>Protecting the interest of consumers &amp; utility service providers</em><div></div></div>
  <header class="app-head"><div class="brand"><img src="/purc_logo.png" alt="PURC logo"><div><strong>PURC LETTER TRACKER</strong><span>PUBLIC UTILITIES REGULATORY COMMISSION <small>| GHANA</small></span></div></div><div class="head-actions"><span class="chip">${longDate()}</span><span class="chip">${escapeHtml(user || "STAFF")} ${admin ? "(ADMIN)" : ""}</span></div></header>
  <nav class="nav"><a${active("Add New Record")} href="/">Add New Record</a><a${active("Dashboard")} href="/dashboard">Dashboard</a>${adminLinks}<a${active("Audit Log")} href="/audit">Audit Log</a><span></span><a class="signout" href="/logout">Sign Out</a></nav>
  <main>${body}</main></body></html>`;
}

function authPreviewShell() {
  return `<div class="preview" aria-hidden="true">
    <div class="preview-top"><span>Accra, Ghana&nbsp;&nbsp;0302218300</span><em>Protecting the interest of consumers &amp; utility service providers</em></div>
    <div class="preview-head"><div class="preview-brand"><img src="/purc_logo.png" alt=""><div><b>PURC LETTER TRACKER</b><small>PUBLIC UTILITIES REGULATORY COMMISSION</small></div></div></div>
    <div class="preview-nav"><span>Add New Record</span><span>Dashboard</span><span>Delete Records</span></div>
    <div class="preview-main"><section><h1>Dashboard</h1><p>Welcome back. Here's what's happening with your correspondence.</p></section></div>
  </div>`;
}

function authPage(kind, message = "") {
  const isRegister = kind === "register";
  const isForgot = kind === "forgot";
  const action = isRegister ? "/register" : isForgot ? "/forgot-password" : "/login";
  const button = isRegister ? "Register" : isForgot ? "Reset Password" : "Sign In";
  const subtitle = isRegister ? "Create a user account for the letter tracker" : isForgot ? "Reset the password for an existing user" : "Existing users sign in to access the registry";
  const extra = isRegister || isForgot ? `<label>${isForgot ? "New " : ""}Password<input name="purc_login_pass" type="password" autocomplete="new-password" minlength="8" data-strength="password_strength" required></label><label class="show"><input type="checkbox" onchange="togglePasswords(this)"> Show password</label><div id="password_strength" class="strength"></div><p class="rules">${passwordRulesText()}</p><label>Confirm ${isForgot ? "New " : ""}Password<input name="purc_confirm_pass" type="password" autocomplete="new-password" minlength="8" required></label>` : `<label>Password<input name="purc_login_pass" type="password" autocomplete="new-password" data-strength="password_strength" required></label><label class="show"><input type="checkbox" onchange="togglePasswords(this)"> Show password</label><div id="password_strength" class="strength"></div><p class="rules">${passwordRulesText()}</p>`;
  const links = isRegister ? `<a href="/login">Existing User Sign In</a><a href="/forgot-password">Forgot Password?</a>` : isForgot ? `<a href="/login">Back to Sign In</a><a href="/register">Create New User</a>` : `<a href="/register">Create New User</a><a href="/forgot-password">Forgot Password?</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PURC Letter Tracker</title><style>${authStyles()}</style><script>${clientScript()}</script></head><body>${authPreviewShell()}<main class="login-card"><img src="/purc_logo.png" alt="PURC logo"><h1>PURC LETTER TRACKER</h1><h2>PUBLIC UTILITIES REGULATORY COMMISSION</h2><p>${subtitle}</p>${message ? `<div class="login-message">${escapeHtml(message)}</div>` : ""}<form method="post" action="${action}" autocomplete="off" data-auth="true"><label>Username<input name="purc_login_user" autocomplete="new-password" autocapitalize="off" spellcheck="false" required></label>${extra}<button>${button}</button></form><div class="auth-links">${links}</div></main></body></html>`;
}

function requireLogin(req, res) {
  if (!currentUser(req)) {
    redirect(res, "/login");
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, layout("Access Denied", `<section class="panel"><h1>Access Denied</h1><p class="error">Only an admin can open this page or perform this action.</p></section>`, req), 403);
  return false;
}

function optionList(values, selected, first) {
  return `<option value="">${first}</option>` + values.map(v => `<option value="${escapeHtml(v)}"${selected === v ? " selected" : ""}>${escapeHtml(v)}</option>`).join("");
}

const sectors = ["Electricity Distribution", "Electricity Transmission", "Electricity Generation", "Water", "Natural Gas", "Government Agency", "Consumer / Public", "Internal PURC", "Other"];
const providersBySector = {
  "Electricity Distribution": ["ECG", "NEDCo"],
  "Electricity Transmission": ["GRIDCo"],
  "Electricity Generation": ["VRA", "Bui Power Authority", "Sunon Asogli Power", "Cenpower Generation", "Karpowership Ghana", "AKSA Energy Ghana", "CENIT Energy", "Genser Energy", "BXC Solar", "Meinergy Ghana", "Other"],
  "Electricity Generation - Hydro": ["VRA", "Bui Power Authority", "Other"],
  "Electricity Generation - Thermal": ["Sunon Asogli Power", "Cenpower Generation", "Karpowership Ghana", "AKSA Energy Ghana", "CENIT Energy", "Genser Energy", "Other"],
  "Electricity Generation - Solar": ["BXC Solar", "Meinergy Ghana", "Other"],
  "Electricity Generation - Other": ["Other"],
  Water: ["Ghana Water"],
  "Natural Gas": ["Ghana Gas"],
  "Government Agency": ["Ministry of Energy", "Energy Commission", "Ministry of Finance", "Parliament of Ghana", "Other Government Agency"],
  "Consumer / Public": ["Individual Consumer", "Business Consumer", "Consumer Group", "Community / Public Petition"],
  "Internal PURC": ["Executive Secretary Office", "Commissioners", "Legal Department", "Consumer Services", "Tariff Department", "Regional Office", "Administration"],
  Other: ["Other"]
};
const allProviders = [...new Set(Object.values(providersBySector).flat())];

function buildLetterPayload(form) {
  let utilityService = form.utility_service === "Other" && trim(form.utility_service_other) ? trim(form.utility_service_other) : (form.utility_service || "Other");
  if (utilityService === "Electricity Generation") utilityService = `Electricity Generation - ${form.generation_type || "Other"}`;
  const utilityProvider = form.utility_provider === "Other" && trim(form.utility_provider_other) ? trim(form.utility_provider_other) : (form.utility_provider || "Other");
  return {
    direction: form.direction || "Received",
    date_dispatched: form.date_dispatched,
    registry_number: form.registry_number,
    sender_receiver: form.sender_receiver,
    date_of_letter: form.date_of_letter || null,
    letter_number: form.letter_number || null,
    utility_service: utilityService,
    utility_provider: utilityProvider,
    subject: form.subject,
    remarks: form.remarks || null,
    action_officer: form.action_officer || null,
    department: form.department || null,
    status: form.status || "Open",
    priority: form.priority || "Normal",
    follow_up_date: form.follow_up_date || null
  };
}

async function audit(action, req, letterId, registryNumber, details) {
  try {
    await supabase("audit_logs", { method: "POST", body: { action, username: currentUser(req) || "STAFF", letter_id: letterId || null, registry_number: registryNumber || null, details } });
  } catch {
    // Audit should not block the main registry action.
  }
}

function letterForm(req, values = {}, error = "", id = "") {
  const v = (name, fallback = "") => escapeHtml(values[name] ?? fallback);
  const savedSector = values.utility_service || "";
  const isGeneration = savedSector.startsWith("Electricity Generation - ");
  const sector = isGeneration ? "Electricity Generation" : savedSector;
  const generationType = isGeneration ? savedSector.replace("Electricity Generation - ", "") : "";
  const provider = values.utility_provider || "";
  return layout(id ? "Edit Letter" : "Add New Record", `${hero(id ? "Edit Record" : "Add New Record", "Executive Secretary correspondence registry for received and dispatched letters.")}${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form class="panel grid" method="post" action="/save${id ? `?id=${encodeURIComponent(id)}` : ""}">
  <h2 class="form-title">Letter Details</h2>
  <label>Type<select name="direction"><option${v("direction","Received")==="Received"?" selected":""}>Received</option><option${v("direction")==="Sent"?" selected":""}>Sent</option></select></label>
  <label>Date Dispatched / Received<input type="date" name="date_dispatched" value="${v("date_dispatched")}" required></label>
  <label>Reference Number<input name="registry_number" value="${v("registry_number")}" placeholder="e.g. PURC/REF/2026/001" required></label>
  <label>From Whom Sent / To Whom Sent<input name="sender_receiver" value="${v("sender_receiver")}" required></label>
  <label>Date of Letter<input type="date" name="date_of_letter" value="${v("date_of_letter")}"></label>
  <label>No. of Letter<input name="letter_number" value="${v("letter_number")}"></label>
  <h2 class="form-title">Stakeholder Classification</h2>
  <label>Stakeholder Category<select id="utility_service_select" name="utility_service" onchange="checkOther(this,'utility_service')" required>${optionList(sectors, sector, "Select Stakeholder Category")}</select><span id="utility_service_other" class="other-inline"><input name="utility_service_other" id="utility_service_other_input" placeholder="Type stakeholder category"><a onclick="useList('utility_service')">Use list instead</a></span></label>
  <label id="generation_type_field" class="generation-type">Generation Type<select id="generation_type_select" name="generation_type"><option value="">Select Generation Type</option><option${generationType==="Thermal"?" selected":""}>Thermal</option><option${generationType==="Hydro"?" selected":""}>Hydro</option><option${generationType==="Solar"?" selected":""}>Solar</option><option${generationType==="Other"?" selected":""}>Other</option></select></label>
  <label>Stakeholder / Institution<select id="utility_provider_select" name="utility_provider" onchange="checkOther(this,'utility_provider')" required>${optionList(allProviders, provider, "Select Stakeholder")}</select><span id="utility_provider_other" class="other-inline"><input name="utility_provider_other" id="utility_provider_other_input" placeholder="Type stakeholder or institution"><a onclick="useList('utility_provider')">Use list instead</a></span></label>
  <label class="wide">Subject<input name="subject" value="${v("subject")}" required></label>
  <h2 class="form-title">Assignment and Tracking</h2>
  <label>Action Officer<input name="action_officer" value="${v("action_officer")}"></label>
  <label>Department<input name="department" value="${v("department")}"></label>
  <input type="hidden" name="status" value="${v("status", "Open")}">
  <label>Priority<select name="priority">${["Normal","Urgent"].map(s=>`<option${(values.priority||"Normal")===s?" selected":""}>${s}</option>`).join("")}</select></label>
  <label>Follow-up Reminder Date<input type="date" name="follow_up_date" value="${v("follow_up_date")}"><small>This will appear as a reminder on the dashboard until it is marked done.</small></label>
  <h2 class="form-title">Remarks</h2>
  <textarea class="wide" name="remarks" placeholder="Add notes, instructions, movement history, or follow-up comments">${v("remarks")}</textarea>
  <div class="actions"><button class="primary">Save Record</button><a class="btn" href="/dashboard">Cancel</a></div></form>`, req);
}

function hero(title, subtitle, right = "") {
  return `<section class="hero"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${right}</section>`;
}

function filterRows(rows, params) {
  let out = rows;
  if (params.get("direction")) out = out.filter(r => r.direction === params.get("direction"));
  if (params.get("utility")) {
    const utility = params.get("utility");
    out = out.filter(r => utility === "Electricity Generation" ? String(r.utility_service || "").startsWith("Electricity Generation - ") : r.utility_service === utility);
  }
  if (params.get("provider")) out = out.filter(r => r.utility_provider === params.get("provider"));
  const q = trim(params.get("q") || "").toLowerCase();
  if (q) out = out.filter(r => [r.registry_number, r.sender_receiver, r.letter_number, r.subject, r.remarks, r.action_officer, r.department, r.utility_service, r.utility_provider].some(v => String(v || "").toLowerCase().includes(q)));
  return out;
}

async function getLetters(limit = 1000) {
  return await supabase(`letters?select=*&order=date_dispatched.desc,created_at.desc&limit=${limit}`);
}

function statusBadge(status) {
  const cls = status === "Closed" ? " closed" : status === "In Progress" ? " progress" : "";
  return `<span class="status${cls}">${escapeHtml(status || "Open")}</span>`;
}

function typeBadge(direction) {
  return `<span class="badge ${direction === "Sent" ? "sent" : ""}">${escapeHtml(direction)}</span>`;
}

function tableRows(rows, includeAction = true) {
  if (!rows.length) return `<tr><td colspan="${includeAction ? 12 : 11}">No records found.</td></tr>`;
  return rows.map(r => `<tr><td>${typeBadge(r.direction)}</td><td>${escapeHtml(r.date_dispatched || "")}</td><td>${escapeHtml(timestamp(r.created_at || ""))}</td><td><strong>${escapeHtml(r.registry_number || "")}</strong></td><td>${escapeHtml(r.sender_receiver || "")}</td><td>${escapeHtml(r.letter_number || "")}</td><td>${escapeHtml(r.utility_service || "")}</td><td>${escapeHtml(r.utility_provider || "")}</td><td>${escapeHtml(r.subject || "")}</td><td>${escapeHtml(r.action_officer || "")}</td><td>${statusBadge(r.status)}</td>${includeAction ? `<td><a href="/edit?id=${r.id}">Edit</a></td>` : ""}</tr>`).join("");
}

async function dashboard(req, params) {
  const all = await getLetters();
  const rows = filterRows(all, params);
  const activeReminders = all.filter(r => r.follow_up_date && r.status !== "Closed");
  const admin = isAdmin(req);
  const reminder = activeReminders.length ? `<details class="reminder"><summary><span>Follow-up Reminders <b>${activeReminders.length}</b><small>${activeReminders.length} letter(s) need follow-up action. Don't forget to keep your correspondence on track.</small></span></summary><div>${activeReminders.map(r => `<div class="reminder-row"><div><strong>${escapeHtml(r.registry_number)}</strong> &middot; ${escapeHtml(r.utility_provider)}<br>${escapeHtml(r.subject)}<br><small>Action officer: ${escapeHtml(r.action_officer || "Not assigned")}</small></div><div><strong class="due">${r.follow_up_date <= todayIso() ? "Due now" : "Upcoming"}: ${escapeHtml(r.follow_up_date)}</strong>${admin ? `<br><a href="/edit?id=${r.id}">Review letter</a><form method="post" action="/complete-follow-up?id=${r.id}" style="display:inline"><button class="smallbtn">Mark Done</button></form>` : ""}</div></div>`).join("")}</div></details>` : "";
  const body = `<div class="dashboard">${hero("Dashboard", `Welcome back, ${currentUser(req) || "STAFF"}. Here's what's happening with your correspondence.`)}
  <section class="stats"><div><span>Total Letters</span><strong>${all.length}</strong><small>All correspondence</small></div><div class="received"><span>Received</span><strong>${all.filter(r=>r.direction==="Received").length}</strong></div><div class="sent-card"><span>Dispatched</span><strong>${all.filter(r=>r.direction==="Sent").length}</strong><small>Sent to providers</small></div><div class="due-card"><span>Due Follow-up</span><strong>${activeReminders.length}</strong><small>Needs attention</small></div></section>
  ${reminder}<div class="layout"><section><div class="tabs"><a class="${!params.get("direction")?"active":""}" href="/dashboard">All</a><a class="${params.get("direction")==="Received"?"active":""}" href="/dashboard?direction=Received">Received</a><a class="${params.get("direction")==="Sent"?"active":""}" href="/dashboard?direction=Sent">Dispatched</a></div>${recordCard(rows, "/dashboard", params, admin)}</section>${quickLinks(admin)}</div></div>`;
  return layout("Dashboard", body, req);
}

function recordCard(rows, action, params, admin = false) {
  return `<section class="record-card"><header><div><h2>Recent Letters</h2><p>Search correspondence records from Supabase.</p></div></header>${filterForm(action, params)}<div class="table-wrap"><table><thead><tr><th>Type</th><th>Date</th><th>Registered At</th><th>Reference No.</th><th>From / To</th><th>Letter No.</th><th>Category</th><th>Stakeholder</th><th>Subject</th><th>Officer</th><th>Status</th>${admin ? "<th>Action</th>" : ""}</tr></thead><tbody>${tableRows(rows, admin)}</tbody></table></div><p class="empty">Showing ${rows.length} record(s)</p></section>`;
}

function filterForm(action, params, label = "Search") {
  return `<form class="filters" method="get" action="${action}"><input name="q" value="${escapeHtml(params.get("q") || "")}" placeholder="Search reference no., sender, subject..."><select id="filter_utility" name="utility">${optionList(sectors, params.get("utility") || "", "All Stakeholder Categories")}</select><select name="provider" data-provider-filter="filter_utility" data-allow-all="true">${optionList(allProviders, params.get("provider") || "", "All Stakeholders")}</select><button>${label}</button><a class="btn" href="${action}">Reset</a></form>`;
}

function quickLinks(admin = false) {
  return `<aside class="quick"><h2>Quick Links</h2><a href="/">Add New Record</a><a href="/history">View Letter History</a><a href="/export">Export Registry Report</a><a href="/utility-counts">View Stakeholder Counts</a>${admin ? `<a href="/users">Manage Users</a>` : ""}</aside>`;
}

async function historyPage(req, params) {
  let rows = filterRows(await getLetters(), params);
  const month = params.get("month");
  if (month) rows = rows.filter(r => String(r.date_dispatched || "").startsWith(month));
  const providerMap = new Map();
  for (const r of rows) {
    const provider = r.utility_provider || "Other";
    const m = String(r.date_dispatched || "").slice(0, 7) || "Unknown";
    if (!providerMap.has(provider)) providerMap.set(provider, new Map());
    if (!providerMap.get(provider).has(m)) providerMap.get(provider).set(m, []);
    providerMap.get(provider).get(m).push(r);
  }
  let archives = "";
  for (const [provider, months] of providerMap) {
    const total = [...months.values()].reduce((n, a) => n + a.length, 0);
    archives += `<section class="archive"><h2>${escapeHtml(provider)}<span>${total} letter(s)</span></h2>`;
    for (const [m, records] of months) {
      archives += `<div class="month"><h3>${monthLabel(m)} · ${records.length} record(s)</h3><table><thead><tr><th>Date</th><th>Registered At</th><th>Reference No.</th><th>Category</th><th>Type</th><th>From / To</th><th>Subject</th><th>Status</th><th>Remarks</th></tr></thead><tbody>${records.map(r=>`<tr><td>${escapeHtml(r.date_dispatched||"")}</td><td>${escapeHtml(timestamp(r.created_at||""))}</td><td><strong>${escapeHtml(r.registry_number||"")}</strong></td><td>${escapeHtml(r.utility_service||"")}</td><td>${escapeHtml(r.direction||"")}</td><td>${escapeHtml(r.sender_receiver||"")}</td><td>${escapeHtml(r.subject||"")}</td><td>${statusBadge(r.status)}</td><td>${escapeHtml(r.remarks||"")}</td></tr>`).join("")}</tbody></table></div>`;
    }
    archives += `</section>`;
  }
  if (!archives) archives = `<section class="panel">No history found.</section>`;
  return layout("History", `${hero("Letter History", "Browse archived records of received and dispatched correspondence.")}<form class="panel filters history" method="get" action="/history"><input name="q" value="${escapeHtml(params.get("q")||"")}" placeholder="Search older records..."><select id="history_utility" name="utility">${optionList(sectors, params.get("utility")||"", "All Stakeholder Categories")}</select><select name="provider" data-provider-filter="history_utility" data-allow-all="true">${optionList(allProviders, params.get("provider")||"", "All Stakeholders")}</select><input type="month" class="month-clean${month ? " has-value" : ""}" name="month" value="${escapeHtml(month||"")}" onchange="this.classList.toggle('has-value', !!this.value)"><button>Search</button><a class="btn" href="/history">Reset</a></form>${archives}`, req);
}

async function deletePage(req) {
  const rows = await getLetters();
  return layout("Delete Records", `${hero("Delete Records", "Select records that should be permanently removed from the letter registry.")}<section class="panel"><table><thead><tr><th>Date</th><th>Reference No.</th><th>Type</th><th>From / To</th><th>Stakeholder</th><th>Subject</th><th>Action</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.date_dispatched||"")}</td><td><strong>${escapeHtml(r.registry_number||"")}</strong></td><td>${escapeHtml(r.direction||"")}</td><td>${escapeHtml(r.sender_receiver||"")}</td><td>${escapeHtml(r.utility_provider||"")}</td><td>${escapeHtml(r.subject||"")}</td><td><form method="post" action="/delete?id=${r.id}" onsubmit="return confirm('Delete this record permanently?')"><button class="danger">Delete</button></form></td></tr>`).join("")}</tbody></table></section>`, req);
}

async function utilityCounts(req) {
  const rows = await getLetters();
  const counts = (key) => rows.reduce((m, r) => (m.set(r[key] || "Other", (m.get(r[key] || "Other") || 0) + 1), m), new Map());
  const render = (map, key) => [...map.entries()].map(([k,v]) => `<a class="count" href="/stakeholder-details?${key}=${encodeURIComponent(k)}"><span>${escapeHtml(k)}</span><strong>${v}</strong></a>`).join("");
  return layout("Stakeholder Counts", `${hero("Stakeholder Counts", "Number of letters or documents recorded for each stakeholder category and institution.")}<section class="workspace"><div class="panel"><h2>By Stakeholder / Institution</h2>${render(counts("utility_provider"), "provider")}</div><div class="panel"><h2>By Stakeholder Category</h2>${render(counts("utility_service"), "utility")}</div></section>`, req);
}

async function stakeholderDetails(req, params) {
  const provider = params.get("provider");
  const utility = params.get("utility");
  const rows = filterRows(await getLetters(), params);
  const title = provider || utility || "Stakeholder";
  const subtitle = provider ? `Records for stakeholder/institution: ${provider}` : `Records for stakeholder category: ${utility}`;
  return layout("Stakeholder Counts", `${hero(title, subtitle, `<a class="btn primary" href="/utility-counts">Back to Counts</a>`)}${recordCard(rows, "/stakeholder-details", params, isAdmin(req))}`, req);
}

async function auditPage(req, params) {
  let logs = [];
  try { logs = await supabase("audit_logs?select=*&order=created_at.desc&limit=300"); } catch {}
  if (!isAdmin(req)) logs = logs.filter(l => String(l.username || "").toUpperCase() === currentUser(req).toUpperCase());
  const q = trim(params.get("q") || "").toLowerCase();
  if (q) logs = logs.filter(l => [l.action, l.username, l.registry_number, l.details].some(v => String(v || "").toLowerCase().includes(q)));
  if (params.get("action")) logs = logs.filter(l => l.action === params.get("action"));
  const actions = ["", "Created record", "Updated record", "Deleted record", "Completed follow-up", "Updated user role", "Created user account"];
  return layout("Audit Log", `${hero("Audit Log", "Review who added, edited, deleted, or completed follow-up actions in the registry.")}<form class="panel filters" method="get" action="/audit"><input name="q" value="${escapeHtml(params.get("q")||"")}" placeholder="Search user, reference no., action, details..."><select name="action">${actions.map(a=>`<option value="${escapeHtml(a)}"${params.get("action")===a?" selected":""}>${a||"All Actions"}</option>`).join("")}</select><button>Search</button><a class="btn" href="/audit">Reset</a></form><section class="panel"><h2>Activity Records</h2><p><strong>${logs.length}</strong> audit event(s) shown.</p><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Reference No.</th><th>Details</th></tr></thead><tbody>${logs.length ? logs.map(l=>`<tr><td>${escapeHtml(timestamp(l.created_at||""))}</td><td><strong>${escapeHtml(l.username||"STAFF")}</strong></td><td>${typeBadge(l.action||"")}</td><td>${escapeHtml(l.registry_number||"")}</td><td>${escapeHtml(l.details||"")}</td></tr>`).join("") : `<tr><td colspan="5">No audit activity found. Make sure supabase_schema.sql has been run.</td></tr>`}</tbody></table></section>`, req);
}

async function usersPage(req, message = "") {
  const users = await loadAppUsers();
  for (const [username, record] of users) {
    try { await saveAppUser(username, record.password, record.role); } catch {}
  }
  try {
    const logs = await supabase("audit_logs?select=username&limit=1000");
    for (const log of logs) {
      const username = trim(log.username);
      if (username && !users.has(username)) users.set(username, { password: "", role: roleFor(username), source: "audit" });
    }
  } catch {}
  const rows = [...users.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([username, record]) => {
    const role = roleFor(username, record.role);
    const fixedAdmin = username.toUpperCase() === "CHANTEL";
    if (!record.password) {
      return `<tr><td><strong>${escapeHtml(username)}</strong><br><small>Seen in audit log, account missing from Supabase</small></td><td>Needs restore</td><td><form method="post" action="/users/create" style="display:grid;grid-template-columns:1fr 160px auto;gap:8px;align-items:center"><input type="hidden" name="username" value="${escapeHtml(username)}"><input name="password" type="password" placeholder="Set new password" required minlength="8"><select name="role"><option>Staff</option><option>Admin</option></select><button class="smallbtn">Restore User</button></form></td></tr>`;
    }
    return `<tr><td><strong>${escapeHtml(username)}</strong></td><td>${escapeHtml(role)}</td><td>${fixedAdmin ? "Permanent admin" : `<form method="post" action="/users/role" style="display:flex;gap:8px;align-items:center"><input type="hidden" name="username" value="${escapeHtml(username)}"><select name="role"><option${role === "Staff" ? " selected" : ""}>Staff</option><option${role === "Admin" ? " selected" : ""}>Admin</option></select><button class="smallbtn">Save Role</button></form>`}</td></tr>`;
  }).join("");
  return layout("User Management", `${hero("User Management", "Admin-only control for who can manage sensitive registry actions.")}${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<section class="panel"><h2>Users</h2><p>CHANTEL is the permanent admin. If a user registered before Supabase user storage was enabled, restore the account here with a new password.</p><table><thead><tr><th>User</th><th>Role</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></section>`, req);
}

async function exportPage(req, params) {
  const rows = filterRows(await getLetters(), params).filter(r => !params.get("direction") || r.direction === params.get("direction"));
  return layout("Export Registry Report", `${hero("Export Registry Report", "Download letter records for all stakeholders or a selected stakeholder/institution.")}<form class="panel filters export" method="get" action="/export"><select id="export_utility" name="utility">${optionList(sectors, params.get("utility")||"", "All Stakeholder Categories")}</select><select name="provider" data-provider-filter="export_utility" data-allow-all="true">${optionList(allProviders, params.get("provider")||"", "All Stakeholders")}</select><select name="direction">${optionList(["Received","Sent"], params.get("direction")||"", "All Letter Types")}</select><a class="btn primary" href="/export-csv?${params.toString()}">Download CSV</a><a class="btn" href="/export">Reset</a></form><section class="panel"><h2>Letters Selected for Export</h2><p><strong>${rows.length}</strong> record(s) selected.</p><table><thead><tr><th>Type</th><th>Date</th><th>Registered At</th><th>Reference No.</th><th>From / To</th><th>Letter No.</th><th>Category</th><th>Stakeholder</th><th>Subject</th><th>Officer</th><th>Status</th></tr></thead><tbody>${tableRows(rows, false)}</tbody></table></section>`, req);
}

function csvEscape(v = "") {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows) {
  const fields = ["direction","date_dispatched","created_at","registry_number","sender_receiver","letter_number","utility_service","utility_provider","subject","action_officer","status","remarks"];
  return [fields.join(","), ...rows.map(r => fields.map(f => csvEscape(r[f])).join(","))].join("\n");
}

async function editPage(req, params) {
  const id = params.get("id");
  const rows = await supabase(`letters?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!rows.length) return layout("Edit Letter", `<p class="error">Record not found.</p>`, req);
  return letterForm(req, rows[0], "", id);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/purc_logo.png") {
      const logoFiles = [
        path.join(__dirname, "public", "purc_logo.png"),
        path.join(__dirname, "purc_logo.png")
      ];
      const logoFile = logoFiles.find(file => fs.existsSync(file));
      if (logoFile) return send(res, fs.readFileSync(logoFile), 200, "image/png", { "Cache-Control": "public, max-age=86400" });
      return redirect(res, OFFICIAL_LOGO_URL);
    }
    if (url.pathname === "/login" && req.method === "GET") return send(res, authPage("login"));
    if (url.pathname === "/login" && req.method === "POST") {
      const form = await readBody(req);
      const users = await loadAppUsers();
      const username = trim(form.purc_login_user || form.username);
      const password = form.purc_login_pass || form.password || "";
      const record = users.get(username);
      if (record?.password === password) return redirect(res, "/", [`purc_session=${encodeURIComponent(SESSION)}; Path=/; HttpOnly; SameSite=Lax`, `purc_user=${encodeURIComponent(username)}; Path=/; SameSite=Lax`, `purc_role=${encodeURIComponent(roleFor(username, record.role))}; Path=/; SameSite=Lax`]);
      return send(res, authPage("login", "Incorrect username or password."));
    }
    if (url.pathname === "/register" && req.method === "GET") return send(res, authPage("register"));
    if (url.pathname === "/register" && req.method === "POST") {
      const form = await readBody(req);
      const users = await loadAppUsers();
      const username = trim(form.purc_login_user || form.username);
      const password = form.purc_login_pass || form.password || "";
      const confirmPassword = form.purc_confirm_pass || form.confirm_password || "";
      if (!username) return send(res, authPage("register", "Please enter a username."));
      if (users.has(username)) return send(res, authPage("register", "This username already exists."));
      if (password !== confirmPassword) return send(res, authPage("register", "The two passwords do not match."));
      if (!passwordOk(password)) return send(res, authPage("register", passwordRulesText()));
      await saveAppUser(username, password, roleFor(username));
      return send(res, authPage("login", "Registration successful. Please sign in with your new account."));
    }
    if (url.pathname === "/forgot-password" && req.method === "GET") return send(res, authPage("forgot"));
    if (url.pathname === "/forgot-password" && req.method === "POST") {
      const form = await readBody(req);
      const users = await loadAppUsers();
      const username = trim(form.purc_login_user || form.username);
      const password = form.purc_login_pass || form.password || "";
      const confirmPassword = form.purc_confirm_pass || form.confirm_password || "";
      if (!users.has(username)) return send(res, authPage("forgot", "Username not found."));
      if (password !== confirmPassword) return send(res, authPage("forgot", "The two passwords do not match."));
      if (!passwordOk(password)) return send(res, authPage("forgot", passwordRulesText()));
      await saveAppUser(username, password, roleFor(username, users.get(username)?.role));
      return send(res, authPage("login", "Password reset successful. Please sign in with the new password."));
    }
    if (url.pathname === "/logout") return redirect(res, "/login", [`purc_session=; Path=/; Max-Age=0`, `purc_user=; Path=/; Max-Age=0`, `purc_role=; Path=/; Max-Age=0`]);
    if (!requireLogin(req, res)) return;
    if (!configured()) return send(res, layout("Supabase Setup Required", `<section class="panel"><h1>Supabase Setup Required</h1><p>Add SUPABASE_URL and SUPABASE_ANON_KEY in Render environment variables.</p></section>`, req));
    if (url.pathname === "/" && req.method === "GET") return send(res, letterForm(req));
    if (url.pathname === "/dashboard") return send(res, await dashboard(req, url.searchParams));
    if (url.pathname === "/new") return send(res, letterForm(req));
    if (url.pathname === "/history") return send(res, await historyPage(req, url.searchParams));
    if (url.pathname === "/delete" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;
      return send(res, await deletePage(req));
    }
    if (url.pathname === "/audit") return send(res, await auditPage(req, url.searchParams));
    if (url.pathname === "/users" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;
      return send(res, await usersPage(req));
    }
    if (url.pathname === "/users/role" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const form = await readBody(req);
      const users = await loadAppUsers();
      const username = trim(form.username);
      if (users.has(username) && username.toUpperCase() !== "CHANTEL") {
        await updateAppUserRole(username, form.role);
        await audit("Updated user role", req, "", "", `${username} role changed to ${roleFor(username, form.role)}`);
      }
      return redirect(res, "/users");
    }
    if (url.pathname === "/users/create" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const form = await readBody(req);
      const username = trim(form.username);
      const password = form.password || "";
      if (!username) return send(res, await usersPage(req, "Please enter a username."));
      if (!passwordOk(password)) return send(res, await usersPage(req, passwordRulesText()));
      await saveAppUser(username, password, roleFor(username, form.role));
      await audit("Created user account", req, "", "", `${username} account created as ${roleFor(username, form.role)}`);
      return redirect(res, "/users");
    }
    if (url.pathname === "/utility-counts") return send(res, await utilityCounts(req));
    if (url.pathname === "/stakeholder-details") return send(res, await stakeholderDetails(req, url.searchParams));
    if (url.pathname === "/export") return send(res, await exportPage(req, url.searchParams));
    if (url.pathname === "/edit") {
      if (!requireAdmin(req, res)) return;
      return send(res, await editPage(req, url.searchParams));
    }
    if (url.pathname === "/export-csv") {
      const rows = filterRows(await getLetters(), url.searchParams).filter(r => !url.searchParams.get("direction") || r.direction === url.searchParams.get("direction"));
      return send(res, toCsv(rows), 200, "text/csv; charset=utf-8", { "Content-Disposition": 'attachment; filename="purc-letter-register.csv"' });
    }
    if (url.pathname === "/save" && req.method === "POST") {
      const form = await readBody(req);
      if (!form.date_dispatched || !form.registry_number || !form.sender_receiver || !form.subject) return send(res, letterForm(req, form, "Please complete all required fields."));
      const id = url.searchParams.get("id");
      if (id && !requireAdmin(req, res)) return;
      const payload = buildLetterPayload(form);
      if (id) await supabase(`letters?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
      else await supabase("letters", { method: "POST", body: payload });
      await audit(id ? "Updated record" : "Created record", req, id, payload.registry_number, `${id ? "Updated" : "Created"} letter: ${payload.subject}`);
      return redirect(res, "/dashboard");
    }
    if (url.pathname === "/delete" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const id = url.searchParams.get("id");
      const rows = await supabase(`letters?select=registry_number&id=eq.${encodeURIComponent(id)}&limit=1`);
      await supabase(`letters?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      await audit("Deleted record", req, id, rows[0]?.registry_number || "", "Deleted letter record");
      return redirect(res, "/delete");
    }
    if (url.pathname === "/complete-follow-up" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const id = url.searchParams.get("id");
      const rows = await supabase(`letters?select=registry_number&id=eq.${encodeURIComponent(id)}&limit=1`);
      await supabase(`letters?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: { follow_up_date: null } });
      await audit("Completed follow-up", req, id, rows[0]?.registry_number || "", "Marked follow-up reminder as done");
      return redirect(res, "/dashboard");
    }
    send(res, layout("Not Found", `<p>Page not found.</p>`, req), 404);
  } catch (err) {
    send(res, layout("Error", `<section class="panel"><h1>Application Error</h1><p class="error">${escapeHtml(err.message)}</p></section>`, req), 500);
  }
}

function styles() {
  return `:root{--blue:#465ca8;--red:#d6293b;--navy:#071a33;--ink:#061b34;--muted:#52627d;--line:#dbe3ee;--bg:#eef4f9;--shadow:0 18px 40px rgba(8,29,54,.09);--soft:0 8px 22px rgba(8,29,54,.06)}*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Arial,sans-serif;color:var(--ink);background:linear-gradient(180deg,#f7f9fc,var(--bg))}.top-strip{height:34px;background:var(--blue);color:white;display:grid;grid-template-columns:1fr 1.4fr 1fr;align-items:center;padding:0 36px;font-size:13px;font-weight:800}.top-strip em{text-align:center}.app-head{height:86px;background:white;display:flex;align-items:center;justify-content:space-between;padding:0 52px;border-bottom:1px solid #e8edf5}.brand{display:flex;gap:14px;align-items:center}.brand img{width:60px;height:60px;object-fit:contain}.brand strong{display:block;color:var(--red);font-size:22px;font-weight:900}.brand span{display:block;color:var(--blue);font-size:10px;font-weight:900}.chip{border:1px solid var(--line);background:#f8fbff;border-radius:7px;padding:10px 14px;font-weight:800;color:#30476a;font-size:12px}.head-actions{display:flex;gap:10px}.nav{height:52px;display:flex;align-items:center;background:var(--navy);padding:0 40px;gap:4px}.nav a{height:52px;display:flex;align-items:center;color:white;text-decoration:none;text-transform:uppercase;font-size:13px;font-weight:900;padding:0 16px;position:relative}.nav a.active,.nav a:hover{background:#102947}.nav a.active:after{content:'';position:absolute;left:16px;right:16px;bottom:0;height:4px;background:var(--red)}.nav span{flex:1}.signout{height:36px!important;border:1px solid rgba(255,255,255,.55);border-radius:4px}main{padding:24px 36px 44px}.hero{background:linear-gradient(135deg,#fff,#f8fbff);border:1px solid #e4ebf5;border-left:5px solid var(--red);border-radius:0 9px 9px 0;box-shadow:var(--soft);padding:26px 30px;margin-bottom:18px;display:flex;justify-content:space-between;gap:20px}.hero h1{margin:0;font-size:34px;text-transform:uppercase}.hero p,p{color:var(--muted)}.panel,.record-card,.quick,.archive{background:white;border:1px solid var(--line);border-radius:8px;box-shadow:var(--soft);padding:20px;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.wide,.form-title,.actions{grid-column:1/-1}.form-title{font-size:14px;text-transform:uppercase;border-left:4px solid var(--red);background:#f8fbff;padding:12px;margin:6px 0 0}label{font-size:12px;font-weight:900;text-transform:uppercase;color:#405571}input,select,textarea{width:100%;min-height:46px;padding:12px;border:1px solid #bfc9d6;border-radius:5px;margin-top:6px;font:inherit}textarea{min-height:110px}.btn,button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border:1px solid var(--line);border-radius:5px;padding:0 18px;background:white;color:var(--ink);font:inherit;text-decoration:none;cursor:pointer}.primary,button{background:var(--blue);border-color:var(--blue);color:white;font-weight:900}.danger,.filters button{background:var(--red);border-color:var(--red);color:white}.error{background:#fde8e7;color:#b42318;padding:12px;border-radius:5px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.stats div{background:white;border:1px solid var(--line);border-top:4px solid var(--blue);border-radius:8px;padding:16px;box-shadow:var(--soft)}.stats .received{border-top-color:#16a34a}.stats .sent-card{border-top-color:#f59e0b}.stats .due-card{border-top-color:var(--red)}.stats span{display:block;font-size:12px;font-weight:900;color:#405571}.stats strong{font-size:30px}.stats small{color:#6b778b}.layout{display:grid;grid-template-columns:minmax(0,1fr)305px;gap:26px}.quick h2,.panel h2{margin-top:0;text-transform:uppercase}.quick h2:after,.panel h2:after{content:'';display:block;width:34px;height:4px;background:red;margin-top:9px}.quick a{display:grid;grid-template-columns:1fr 18px;background:#fbfcff;border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0;text-decoration:none;color:var(--ink);font-weight:900;text-transform:uppercase}.quick a:after{content:'>';color:var(--blue);text-align:right}.tabs{display:flex;gap:8px;margin-bottom:14px}.tabs a{padding:12px 18px;border:1px solid var(--line);background:white;border-radius:5px;text-decoration:none;color:var(--ink);font-weight:900}.tabs .active{background:var(--red);color:white}.filters{display:grid;grid-template-columns:minmax(220px,1fr)190px 210px auto auto;gap:10px;align-items:end;margin:0;padding:18px}.filters.history,.filters.export{grid-template-columns:minmax(260px,1fr)190px 210px 170px auto auto}.record-card{padding:0;overflow:hidden}.record-card header{padding:16px 20px;border-bottom:1px solid var(--line)}.record-card h2{margin:0}.table-wrap{overflow:auto;max-height:390px}table{width:100%;border-collapse:separate;border-spacing:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f3f6fb;color:#334865;font-size:11px;text-transform:uppercase}.badge,.status{display:inline-block;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:900;background:#e7eefc;color:#2c4598;text-transform:uppercase}.sent{background:#fde8e8;color:#b81327}.status{background:#e9f7ef;color:#107a3c}.status.progress{background:#edf2ff;color:#2c4598}.status.closed{background:#eef0f3;color:#52627d}.empty{padding:0 20px 16px}.archive{padding:0;overflow:hidden}.archive>h2{margin:0;background:var(--navy);color:white;padding:16px 20px;display:flex;justify-content:space-between}.archive>h2 span{font-size:12px}.month{padding:18px}.month h3{margin:0 0 12px;color:var(--blue);text-transform:uppercase;font-size:15px}.workspace{display:grid;grid-template-columns:1fr 1fr;gap:18px}.count{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:12px 4px}.count strong{background:#edf2ff;border-radius:999px;padding:4px 10px}.reminder{background:#fff5f5;border:1px solid #fecaca;border-left:5px solid var(--red);border-radius:7px;margin-bottom:14px}.reminder summary{padding:12px 16px;font-size:12px;font-weight:900;text-transform:uppercase;cursor:pointer}.reminder summary b{background:var(--red);color:white;border-radius:999px;padding:2px 6px}.reminder summary small{display:block;color:#405571;text-transform:none;font-weight:500;margin-top:5px}.reminder-row{display:flex;justify-content:space-between;gap:16px;background:white;border:1px solid #f1d8da;margin:10px 16px;padding:12px;border-radius:6px}.due{color:#b42318}.smallbtn{min-height:34px;padding:0 12px;margin-left:8px}.other-inline{display:none}.other-inline a{display:inline-block;margin-top:7px;color:var(--blue);cursor:pointer}@media(max-width:950px){.top-strip{grid-template-columns:1fr}.app-head,.hero{height:auto;flex-direction:column;align-items:flex-start}.layout,.stats,.workspace,.grid,.filters,.filters.history,.filters.export{grid-template-columns:1fr}.nav{overflow:auto;padding:0 12px}main{padding:18px}}`;
}

function authStyles() {
  return `:root{--blue:#465ca8;--red:#d6293b;--navy:#071a33;--ink:#081d36;--line:#d8dee8}*{box-sizing:border-box}body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#dfe7f0;color:var(--ink);min-height:100vh;display:grid;place-items:center;overflow:auto}.preview{position:fixed;inset:0;background:#eef4f9;filter:blur(9px);transform:scale(1.03);opacity:.58;pointer-events:none}.preview:after{content:'';position:absolute;inset:0;background:rgba(7,26,51,.24)}.preview-top{height:34px;background:var(--blue);color:white;display:grid;grid-template-columns:1fr 1.5fr 1fr;align-items:center;padding:0 36px;font-size:13px;font-weight:800}.preview-top em{text-align:center}.preview-head{height:116px;background:white;display:flex;align-items:center;padding:0 48px}.preview-brand{display:flex;align-items:center;gap:16px}.preview-brand img{width:78px;height:78px;object-fit:contain}.preview-brand b{display:block;color:var(--red);font-size:26px;font-weight:900}.preview-brand small{display:block;color:var(--blue);font-size:12px;font-weight:900}.preview-nav{height:54px;background:var(--navy);display:flex;gap:34px;align-items:center;padding:0 52px;color:white;text-transform:uppercase;font-weight:900}.preview-main{padding:30px 40px}.preview-main section{height:165px;background:white;border-left:5px solid var(--red);border-radius:8px;padding:34px;box-shadow:0 16px 38px rgba(8,29,54,.12)}.preview-main h1{margin:0;font-size:34px;text-transform:uppercase}.preview-main p{color:#52627d}.login-card{position:relative;width:min(100%,470px);background:rgba(255,255,255,.96);border:1px solid rgba(255,255,255,.9);border-radius:10px;box-shadow:0 30px 70px rgba(8,29,54,.34);padding:38px;overflow:hidden}.login-card:before{content:'';position:absolute;left:0;top:0;width:100%;height:7px;background:linear-gradient(90deg,var(--red) 0 34%,var(--blue) 34%)}.login-card img{display:block;width:78px;height:78px;object-fit:contain;margin:0 auto 10px}.login-card h1{text-align:center;font-size:25px;margin:0;color:#001f3f}.login-card h2{text-align:center;color:var(--blue);font-size:14px;margin:8px 0 0}.login-card p{text-align:center;color:#51627a}.login-message{background:#fde8e7;color:#b42318;padding:12px;margin:14px 0;font-weight:700}label{display:block;margin-top:15px;font-size:12px;font-weight:900;text-transform:uppercase;color:#405571}input{width:100%;padding:14px;border:1px solid #bfc9d6;margin-top:7px;font:inherit}.show{display:flex;gap:8px;align-items:center;text-transform:none}.show input{width:auto}.strength{margin-top:10px;padding:0}.strength.strong{background:#e6f5ee;color:#08734a;padding:9px;font-weight:900}.strength.weak{background:#fde8e7;color:#b42318;padding:9px;font-weight:900}.rules{text-align:left!important;font-size:12px}.login-card button{width:100%;margin-top:24px;background:var(--blue);color:white;border:0;padding:14px 18px;font:inherit;font-weight:900;cursor:pointer;box-shadow:0 10px 22px rgba(70,92,168,.25)}.auth-links{display:flex;justify-content:space-between;margin-top:18px}.auth-links a{color:var(--blue);font-weight:900;text-decoration:none;font-size:13px}@media(max-width:650px){.preview-head{padding:0 22px}.preview-brand b{font-size:20px}.preview-nav{padding:0 18px;gap:18px}.login-card{width:calc(100% - 24px);padding:30px}}`;
}

function clientScript() {
  return `const providersBySector={'Electricity Distribution':['ECG','NEDCo'],'Electricity Transmission':['GRIDCo'],'Electricity Generation':['VRA','Bui Power Authority','Sunon Asogli Power','Cenpower Generation','Karpowership Ghana','AKSA Energy Ghana','CENIT Energy','Genser Energy','BXC Solar','Meinergy Ghana','Other'],'Electricity Generation - Hydro':['VRA','Bui Power Authority','Other'],'Electricity Generation - Thermal':['Sunon Asogli Power','Cenpower Generation','Karpowership Ghana','AKSA Energy Ghana','CENIT Energy','Genser Energy','Other'],'Electricity Generation - Solar':['BXC Solar','Meinergy Ghana','Other'],'Electricity Generation - Other':['Other'],Water:['Ghana Water'],'Natural Gas':['Ghana Gas'],'Government Agency':['Ministry of Energy','Energy Commission','Ministry of Finance','Parliament of Ghana','Other Government Agency'],'Consumer / Public':['Individual Consumer','Business Consumer','Consumer Group','Community / Public Petition'],'Internal PURC':['Executive Secretary Office','Commissioners','Legal Department','Consumer Services','Tariff Department','Regional Office','Administration'],Other:['Other']};function providerKey(s){if(!s)return'';if(s.value==='Electricity Generation'){const g=document.getElementById('generation_type_select');return g?'Electricity Generation - '+(g.value||'Other'):'Electricity Generation'}return s.value}function filterProviders(s,p){if(!s||!p)return;const old=p.value,all=p.dataset.allowAll==='true';const key=providerKey(s);const vals=providersBySector[key]||Object.values(providersBySector).flat();p.innerHTML='';p.innerHTML='<option value="">'+(all?'All Stakeholders':'Select Stakeholder')+'</option>';vals.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;p.appendChild(o)});if([...p.options].some(o=>o.value===old))p.value=old}function toggleGenerationType(){const s=document.getElementById('utility_service_select'),f=document.getElementById('generation_type_field'),g=document.getElementById('generation_type_select'),p=document.getElementById('utility_provider_select');if(!s||!f)return;const on=s.value==='Electricity Generation';f.classList.toggle('active',on);if(on&&g&&!g.value)g.value='Thermal';if(!on&&g)g.value='';filterProviders(s,p)}function bindProviderFilter(s,p){if(!s||!p)return;s.addEventListener('change',()=>{toggleGenerationType();filterProviders(s,p)});const g=document.getElementById('generation_type_select');if(g)g.addEventListener('change',()=>filterProviders(s,p));toggleGenerationType();filterProviders(s,p)}function useOther(k){document.getElementById(k+'_select').style.display='none';document.getElementById(k+'_other').style.display='block';document.getElementById(k+'_other_input').focus()}function useList(k){document.getElementById(k+'_other').style.display='none';document.getElementById(k+'_other_input').value='';const s=document.getElementById(k+'_select');s.value='';s.style.display='block'}function checkOther(sel,k){if(sel.value==='Other')useOther(k);toggleGenerationType()}function passwordStrong(v){return v.length>=8&&/[A-Z]/.test(v)&&/[a-z]/.test(v)&&/[0-9]/.test(v)&&/[^A-Za-z0-9]/.test(v)}function togglePasswords(box){document.querySelectorAll('input[type=password],input[data-was-password]').forEach(i=>{if(box.checked){i.dataset.wasPassword=1;i.type='text'}else if(i.dataset.wasPassword){i.type='password'}})}function clearAuthFields(){document.querySelectorAll('form[data-auth] input').forEach(i=>{if(i.type==='checkbox'){i.checked=false;return}i.value='';i.setAttribute('autocomplete','new-password')});document.querySelectorAll('.strength').forEach(b=>{b.className='strength';b.textContent=''})}function scheduleAuthClear(){if(!document.querySelector('form[data-auth]'))return;[0,150,600,1400].forEach(ms=>setTimeout(clearAuthFields,ms))}window.addEventListener('pageshow',scheduleAuthClear);document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('[data-provider-filter]').forEach(p=>bindProviderFilter(document.getElementById(p.dataset.providerFilter),p));bindProviderFilter(document.getElementById('utility_service_select'),document.getElementById('utility_provider_select'));document.querySelectorAll('[data-strength]').forEach(i=>i.addEventListener('input',()=>{const b=document.getElementById(i.dataset.strength);if(!b)return;if(!i.value){b.className='strength';b.textContent=''}else if(passwordStrong(i.value)){b.className='strength strong';b.textContent='Strong password'}else{b.className='strength weak';b.textContent='Weak password'}}));scheduleAuthClear()})`;
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`PURC Letter Tracker Render app running on http://${HOST}:${PORT}`);
});
