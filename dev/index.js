"use strict";

const { Plugin, showMessage, Setting, Dialog, confirm } = require("siyuan");
let fs = null;
let path = null;
let http = null;
let cryptoNode = null;
try { fs = require("fs"); } catch (e) {}
try { path = require("path"); } catch (e) {}
try { http = require("http"); } catch (e) {}
try { cryptoNode = require("crypto"); } catch (e) {}

const TASK_PLUGIN = "siyuan-plugin-task-note-management";
const FEISHU_CATEGORY = "category_feishu_todo";
const CFG_NAME = "feishu-todo-sync";
const LOG_NAME = "sync-log";

function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function base64Encode(str) {
    if (typeof btoa === "function") {
        return btoa(unescape(encodeURIComponent(str)));
    }
    return Buffer.from(str, "utf8").toString("base64");
}

function ensureScheme(url) {
    const t = String(url || "").trim();
    if (!t) return t;
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) ? t : "https://" + t;
}

function hmacSha256(key, data) {
    if (!cryptoNode) return null;
    return cryptoNode.createHmac("sha256", key).update(data, "utf8").digest();
}

const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const FEISHU_TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
const FEISHU_API = "https://open.feishu.cn/open-apis";
const DEFAULT_SCOPE = "task:task:read task:task:write task:tasklist:read task:tasklist:write offline_access";

function pad(n) {
    return String(n).padStart(2, "0");
}

function randomStr(len) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < len; i++) {
        s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
}

function toMs(v) {
    if (!v) return 0;
    if (typeof v === "number") return v;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
}

function siyuanModifiedMs(st) {
    let t = 0;
    if (st.updatedAt) t = Math.max(t, toMs(st.updatedAt));
    if (st.completedTime) {
        let ct = st.completedTime;
        if (typeof ct === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ct)) {
            ct = ct.replace(" ", "T") + ":00";
        }
        t = Math.max(t, toMs(ct));
    }
    if (st.createdAt) t = Math.max(t, toMs(st.createdAt));
    return t;
}

function feishuModifiedMs(ft) {
    let t = 0;
    if (ft.updated_at) t = Math.max(t, Number(ft.updated_at) || 0);
    if (ft.completed_at && ft.completed_at !== "0") t = Math.max(t, Number(ft.completed_at) || 0);
    if (ft.created_at) t = Math.max(t, Number(ft.created_at) || 0);
    return t;
}

function normalizeCompletedTime(ct) {
    if (typeof ct === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ct)) {
        return ct.replace(" ", "T") + ":00";
    }
    return ct;
}

function formatCompletedTime(ms) {
    const dt = new Date(Number(ms));
    if (!Number.isFinite(dt.getTime())) return "";
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function cleanSiyuanNote(note) {
    if (!note) return "";
    let t = String(note);
    // 移除“来源：飞书待办”前缀（支持换行、斜杠、竖线、横线等分隔）
    t = t.replace(/^来源[：:]\s*飞书待办\s*[\n\/\\|—–-]*/i, "");
    // 移除 feishu_guid 占位
    t = t.replace(/feishu_guid[：:]\s*[0-9a-fA-F-]{36}/gi, "");
    // 清理开头/结尾残留分隔符
    t = t.replace(/^[\s\n\/\\|—–-]+/, "");
    t = t.replace(/[\s\n\/\\|—–-]+$/, "");
    // 压缩多余空行
    t = t.replace(/\n{3,}/g, "\n\n");
    return t.trim();
}

const DELETED_SUFFIX = "该任务同步后已删除";
const MOVED_SUFFIX = "该任务同步后已转移到其他待办清单中";

function appendTitleSuffix(title, suffix, maxBase) {
    const t = String(title || "");
    if (!t) return t;
    if (t.endsWith(suffix)) return t;
    const base = maxBase ? t.slice(0, maxBase) : t;
    return base + "-" + suffix;
}

function stripTitleSuffix(title) {
    let t = String(title || "");
    for (const s of [MOVED_SUFFIX, DELETED_SUFFIX]) {
        if (t.endsWith(s)) {
            t = t.slice(0, t.length - s.length);
            if (t.endsWith("-")) t = t.slice(0, t.length - 1);
            break;
        }
    }
    return t;
}

function sameDue(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return Number(a.timestamp) === Number(b.timestamp) && !!a.is_all_day === !!b.is_all_day;
}

function siyuanLogical(st) {
    return {
        title: stripTitleSuffix(st.title).trim(),
        note: cleanSiyuanNote(st.note),
        due: siyuanDue(st.endDate || st.date, st.endTime || st.time) || null,
        completed: !!st.completed,
    };
}

function feishuLogical(ft) {
    return {
        title: stripTitleSuffix(ft.summary).trim(),
        note: cleanSiyuanNote(ft.description),
        due: ft.due || null,
        completed: !!(ft.completed_at && ft.completed_at !== "0"),
    };
}

function hashLogical(o) {
    const due = o.due ? `${Number(o.due.timestamp)}_${!!o.due.is_all_day}` : "";
    return JSON.stringify({ title: o.title, note: o.note, due, completed: o.completed });
}

function isMirrorTask(st) {
    return /feishu_guid[:：]\s*[0-9a-fA-F-]{36}/.test(st.note || "");
}

function isFeishuCategory(st) {
    return String(st.categoryId || "").split(",").map((s) => s.trim()).includes(FEISHU_CATEGORY);
}

function parseDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3] };
}

function parseTime(s) {
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return { hh: +m[1], mm: +m[2] };
}

// 思源 date/time -> 飞书 due
function siyuanDue(dateStr, timeStr) {
    const d = parseDate(dateStr);
    if (!d) return undefined;
    const t = parseTime(timeStr);
    if (t) {
        return {
            timestamp: String(new Date(d.y, d.mo - 1, d.d, t.hh, t.mm).getTime()),
            is_all_day: false,
        };
    }
    return {
        timestamp: String(Date.UTC(d.y, d.mo - 1, d.d)),
        is_all_day: true,
    };
}

// 飞书 due -> 思源 {date, time}
function feishuDue(due) {
    if (!due || !due.timestamp || due.timestamp === "0") {
        return { date: "", time: "" };
    }
    const ms = Number(due.timestamp);
    if (!Number.isFinite(ms) || ms <= 0) {
        return { date: "", time: "" };
    }
    const dt = new Date(ms);
    if (due.is_all_day) {
        return {
            date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
            time: "",
        };
    }
    return {
        date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
        time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
    };
}

function genSiyuanTaskId() {
    return `reminder_${Date.now()}_${randomStr(8)}`;
}

function defaultConfig() {
    return {
        appId: "",
        appSecret: "",
        scope: DEFAULT_SCOPE,
        oauthPort: 18080,
        tasklistGuid: "",
        intervalSec: 60,
        syncCategories: [],
        syncDirection: "bidirectional",
        restrictToTasklist: false,
        deleteDryRun: true,
        backupType: "none",
        backupUrl: "",
        backupUsername: "",
        backupPassword: "",
        backupPath: "feishu-backup",
        ossEndpoint: "",
        ossBucket: "",
        ossRegion: "",
        ossAccessKey: "",
        ossSecretKey: "",
        ossPath: "feishu-backup",
        channels: ["feishu"],
        feishuTasklistGuids: [],
        feishuDefaultTasklistName: "AI管家·每日待办",
        wecomCorpId: "",
        wecomSecret: "",
        wecomAgentId: "",
        wecomCalId: "",
        wecomUserId: "",
        aiBaseUrl: "",
        aiModel: "",
        aiApiKey: "",
        dockPosition: "right",
        markDeleted: true,
        lastSyncAt: 0,
    };
}

function ensureScope(scope) {
    const parts = (scope || DEFAULT_SCOPE).split(/\s+/).filter(Boolean);
    const want = ["task:task:read", "task:task:write", "task:tasklist:read", "task:tasklist:write", "offline_access"];
    for (const w of want) {
        if (!parts.includes(w)) parts.push(w);
    }
    return parts.join(" ");
}

module.exports = class FeishuTodoSync extends Plugin {
    onload() {
        this.disposed = false;
        this.running = false;
        this.paused = false;
        this.writing = false;
        this.timer = null;
        this.watcher = null;
        this.server = null;
        this.oauthTimeout = null;
        this.debounceTimer = null;

        this.cfg = defaultConfig();
        this.mapping = {}; // siyuanId -> {feishuGuid, lastHash, missingRounds}
        this.wecomMapping = {}; // wecom scheduleId -> {siyuanId, lastHash}
        this.tombstones = {}; // feishuGuid -> timestamp
        this.token = null; // {access_token, refresh_token, expiresAt}
        this.wecomToken = null;
        this.categories = [];
        this.tasklists = [];
        this.logHistory = [];
        this.logSaveTimer = null;
        this.aiChat = [];

        this.elements = {};

        this.buildSetting();
        this.loadState().then(() => {
            this.refreshDynamicSetting();
            this.startTimer();
            this.startWatcher();
        });
    }

    async onLayoutReady() {
        this.addTopBar({
            icon: "iconRefresh",
            title: this.i18n.syncNow,
            position: "right",
            callback: () => {
                this.syncNow(true);
            },
            contextMenu: (menu) => {
                menu.addItem({
                    icon: "iconSettings",
                    label: this.i18n.openSettings,
                    click: () => this.openSetting(),
                });
                menu.addItem({
                    icon: "iconRefresh",
                    label: "立即同步",
                    click: () => this.syncNow(true),
                });
            },
        });
        const pos = this.cfg.dockPosition || "right";
        if (pos !== "none") {
            this.addDock({
                config: {
                    position: pos === "left" ? "LeftBottom" : "RightBottom",
                    size: { width: 260, height: 340 },
                    icon: "iconRefresh",
                    title: "飞书待办同步",
                },
                data: {},
                type: "feishu-todo-sync-dock",
                init: (dock) => this.initDock(dock),
            });
        }
    }

    async onunload() {
        this.disposed = true;
        this.stopTimer();
        this.stopWatcher();
        if (this.oauthTimeout) {
            clearTimeout(this.oauthTimeout);
            this.oauthTimeout = null;
        }
        if (this.server) {
            try {
                this.server.close();
            } catch (e) {
                /* ignore */
            }
            this.server = null;
        }
        if (this.logSaveTimer) {
            clearTimeout(this.logSaveTimer);
            this.logSaveTimer = null;
        }
        await this.saveData(LOG_NAME, this.logHistory).catch(() => {});
    }

    // ---------- 存储 ----------
    async loadState() {
        const saved = (await this.loadData(CFG_NAME).catch(() => null)) || {};
        this.cfg = Object.assign(defaultConfig(), saved.config || {});
        this.cfg.scope = ensureScope(this.cfg.scope);
        this.mapping = saved.mapping || {};
        this.wecomMapping = saved.wecomMapping || {};
        this.tombstones = saved.tombstones || {};
        this.token = saved.token || null;
        this.data[CFG_NAME] = saved;
        this.logHistory = (await this.loadData(LOG_NAME).catch(() => null)) || [];
    }

    async persist() {
        this.data[CFG_NAME] = {
            config: this.cfg,
            mapping: this.mapping,
            wecomMapping: this.wecomMapping,
            tombstones: this.tombstones,
            token: this.token,
        };
        await this.saveData(CFG_NAME, this.data[CFG_NAME]).catch(() => {});
    }

    // ---------- 任务插件数据 ----------
    taskPluginDataPath() {
        return `data/storage/petal/${TASK_PLUGIN}`;
    }

    taskDataDir() {
        if (path) {
            return path.resolve(this.dataDir || "", "..", TASK_PLUGIN);
        }
        return this.taskPluginDataPath();
    }

    async readTaskJson(name) {
        const p = `${this.taskPluginDataPath()}/${name}`;
        const resp = await fetch("/api/file/getFile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: p }),
        });
        if (!resp.ok) {
            throw new Error(`读取 ${p} 失败: HTTP ${resp.status}`);
        }
        const text = await resp.text();
        return JSON.parse(text);
    }

    async writeTaskJson(name, obj) {
        const p = `${this.taskPluginDataPath()}/${name}`;
        const form = new FormData();
        form.append("path", p);
        form.append("file", new Blob([JSON.stringify(obj)], { type: "application/json" }));
        form.append("isDir", "false");
        form.append("modTime", String(Date.now()));
        const resp = await fetch("/api/file/putFile", {
            method: "POST",
            body: form,
        });
        const json = await resp.json().catch(() => ({}));
        if (!json || json.code !== 0) {
            throw new Error(`写入 ${p} 失败: ${(json && json.msg) || "未知错误"}`);
        }
    }

    async readReminders() {
        try {
            const data = await this.readTaskJson("reminder.json");
            this._readSnapshotIds = new Set(Object.keys(data || {}));
            return data;
        } catch (e) {
            this.log("读取 reminder.json 失败: " + e.message);
            return null;
        }
    }

    async writeReminders(obj) {
        this.writing = true;
        try {
            let fresh = null;
            try {
                fresh = await this.readTaskJson("reminder.json");
            } catch (e) {
                fresh = null;
            }
            let merged;
            if (fresh && typeof fresh === "object") {
                merged = fresh;
                for (const [sid, st] of Object.entries(obj)) {
                    if (!this._readSnapshotIds || !this._readSnapshotIds.has(sid) || JSON.stringify(fresh[sid]) !== JSON.stringify(st)) {
                        merged[sid] = st;
                    }
                }
                if (this._readSnapshotIds) {
                    for (const sid of this._readSnapshotIds) {
                        if (!obj[sid]) {
                            delete merged[sid];
                        }
                    }
                }
            } else {
                merged = obj;
            }
            await this.writeTaskJson("reminder.json", merged);
        } finally {
            this.writing = false;
        }
    }

    async readCategories() {
        try {
            return await this.readTaskJson("categories.json");
        } catch (e) {
            this.log("读取 categories.json 失败: " + e.message);
            return [];
        }
    }

    // ---------- 定时与监听 ----------
    startTimer() {
        this.stopTimer();
        const sec = Math.max(10, Number(this.cfg.intervalSec) || 60);
        this.timer = setInterval(() => this.syncNow(false), sec * 1000);
    }

    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    setPaused(paused) {
        this.paused = !!paused;
        if (this.paused) {
            this.stopTimer();
            this.stopWatcher();
        } else {
            this.startTimer();
            this.startWatcher();
        }
        if (this.elements.pauseBtn) {
            this.elements.pauseBtn.textContent = this.paused ? "恢复同步" : "暂停同步";
        }
    }

    startWatcher() {
        this.stopWatcher();
        if (!fs) return;
        try {
            this.watcher = fs.watch(this.taskDataDir(), (eventType, filename) => {
                if (this.disposed || this.running || this.writing) return;
                if (filename === "reminder.json" || filename === "categories.json") {
                    this.scheduleSync(1500);
                }
            });
        } catch (e) {
            this.watcher = null;
        }
    }

    stopWatcher() {
        if (this.watcher) {
            try {
                this.watcher.close();
            } catch (e) {
                /* ignore */
            }
            this.watcher = null;
        }
    }

    scheduleSync(delayMs) {
        if (this.disposed) return;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.syncNow(false);
        }, delayMs);
    }

    log(msg) {
        const line = `[${new Date().toLocaleString()}] ${msg}`;
        this.logHistory.push(line);
        if (this.logHistory.length > 2000) {
            this.logHistory.shift();
        }
        console.log(`[feishu-todo-sync] ${msg}`);
        if (this.elements.status) {
            this.elements.status.textContent = this.logHistory.slice(-20).join("\n");
        }
        if (this.dlg && this.dlg.logArea) {
            this.dlg.logArea.textContent = this.logHistory.slice(-40).join("\n");
            this.dlg.logArea.scrollTop = this.dlg.logArea.scrollHeight;
        }
        this.scheduleLogSave();
    }

    scheduleLogSave() {
        if (this.logSaveTimer) {
            clearTimeout(this.logSaveTimer);
        }
        this.logSaveTimer = setTimeout(() => {
            this.logSaveTimer = null;
            this.saveData(LOG_NAME, this.logHistory).catch(() => {});
        }, 2000);
    }

    // ---------- 飞书鉴权 ----------
    async getValidToken() {
        if (this.token && this.token.access_token && this.token.expiresAt && Date.now() < this.token.expiresAt - 60 * 1000) {
            return this.token.access_token;
        }
        if (this.token && this.token.refresh_token) {
            try {
                const t = await this.refreshToken(this.token.refresh_token);
                this.token = t;
                await this.persist();
                return t.access_token;
            } catch (e) {
                this.log("刷新 token 失败: " + e.message);
                this.token = null;
                await this.persist();
                return null;
            }
        }
        return null;
    }

    async refreshToken(refreshToken) {
        const body = {
            grant_type: "refresh_token",
            client_id: this.cfg.appId,
            client_secret: this.cfg.appSecret,
            refresh_token: refreshToken,
        };
        const res = await this.httpJson("POST", FEISHU_TOKEN_URL, body, null);
        if (!res || res.code !== 0 || !res.access_token) {
            throw new Error((res && res.msg) || "refresh_token 响应异常");
        }
        return {
            access_token: res.access_token,
            refresh_token: res.refresh_token || refreshToken,
            expiresAt: Date.now() + (Number(res.expires_in) || 7200) * 1000,
        };
    }

    async getUserOpenId() {
        const token = await this.getValidToken();
        if (!token) return null;
        const res = await this.httpJson("GET", `${FEISHU_API}/authen/v1/user_info`, undefined, token);
        if (!res || res.code !== 0 || !res.data) {
            this.log("获取飞书用户信息失败: " + ((res && res.msg) || JSON.stringify(res)));
            return null;
        }
        return res.data.open_id || res.data.user_id || null;
    }

    startOAuth() {
        if (!http) {
            showMessage("移动端暂不支持本地回调授权，请在桌面端授权后通过云同步使用");
            return;
        }
        if (!this.cfg.appId || !this.cfg.appSecret) {
            showMessage(this.i18n.needCredentials);
            return;
        }
        if (this.server) {
            try {
                this.server.close();
            } catch (e) {
                /* ignore */
            }
            this.server = null;
        }
        const state = randomStr(16);
        const port = Number(this.cfg.oauthPort) || 18080;
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://127.0.0.1:${port}`);
            if (url.pathname === "/callback") {
                const code = url.searchParams.get("code");
                const st = url.searchParams.get("state");
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end("<html><body style=\"font-family:sans-serif;padding:24px\"><h3>授权成功，可关闭此页面返回思源</h3></body></html>");
                try {
                    server.close();
                } catch (e) {
                    /* ignore */
                }
                this.server = null;
                if (this.oauthTimeout) {
                    clearTimeout(this.oauthTimeout);
                    this.oauthTimeout = null;
                }
                if (st === state && code) {
                    this.exchangeCode(code);
                } else {
                    this.log("OAuth 回调失败或 state 不匹配");
                    showMessage(this.i18n.authorizeFailed);
                }
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.on("error", (e) => {
            this.log("本地回调服务启动失败: " + e.message);
            if (e && e.code === "EADDRINUSE") {
                showMessage(`OAuth 回调端口 ${port} 被占用，请在设置中更换端口或重启思源`);
            } else {
                showMessage(this.i18n.authorizeFailed + ": " + e.message);
            }
        });
        server.listen(port, "127.0.0.1", () => {
            this.server = server;
            if (this.oauthTimeout) {
                clearTimeout(this.oauthTimeout);
            }
            this.oauthTimeout = setTimeout(() => {
                if (this.server === server) {
                    try {
                        server.close();
                    } catch (e) {
                        /* ignore */
                    }
                    this.server = null;
                }
            }, 5 * 60 * 1000);
            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const authorizeUrl =
                `${FEISHU_AUTHORIZE_URL}?client_id=${encodeURIComponent(this.cfg.appId)}` +
                `&response_type=code` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&scope=${encodeURIComponent(this.cfg.scope || DEFAULT_SCOPE)}` +
                `&state=${state}`;
            this.log("请在浏览器中完成飞书授权");
            window.open(authorizeUrl);
        });
    }

    async exchangeCode(code) {
        try {
            const body = {
                grant_type: "authorization_code",
                client_id: this.cfg.appId,
                client_secret: this.cfg.appSecret,
                code,
                redirect_uri: `http://127.0.0.1:${Number(this.cfg.oauthPort) || 18080}/callback`,
            };
            const res = await this.httpJson("POST", FEISHU_TOKEN_URL, body, null);
            if (!res || res.code !== 0 || !res.access_token) {
                throw new Error((res && res.msg) || "token 响应异常");
            }
            this.token = {
                access_token: res.access_token,
                refresh_token: res.refresh_token || (this.token && this.token.refresh_token) || "",
                expiresAt: Date.now() + (Number(res.expires_in) || 7200) * 1000,
            };
            await this.persist();
            this.log("飞书授权成功");
            showMessage(this.i18n.authorizeDone);
            this.refreshDynamicSetting();
            this.syncNow(false);
        } catch (e) {
            this.log("获取 token 失败: " + e.message);
            showMessage(this.i18n.authorizeFailed + ": " + e.message);
        }
    }

    // ---------- 飞书 API ----------
    async httpJson(method, url, body, token) {
        const headers = { "Content-Type": "application/json; charset=utf-8" };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        const opt = { method, headers };
        if (body !== undefined && body !== null) {
            opt.body = JSON.stringify(body);
        }
        const resp = await fetch(url, opt);
        const text = await resp.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            json = { code: -1, msg: text };
        }
        return json;
    }

    async listTasklists() {
        const token = await this.getValidToken();
        if (!token) return [];
        const items = [];
        let pageToken = "";
        for (let i = 0; i < 20; i++) {
            const q = new URLSearchParams({ page_size: "100" });
            if (pageToken) q.set("page_token", pageToken);
            const res = await this.httpJson("GET", `${FEISHU_API}/task/v2/tasklists?${q.toString()}`, undefined, token);
            if (!res || res.code !== 0 || !res.data) break;
            const data = res.data;
            (data.items || []).forEach((it) => items.push(it));
            pageToken = data.page_token || "";
            if (!data.has_more || !pageToken) break;
        }
        return items;
    }

    async createTasklist(name) {
        const token = await this.getValidToken();
        if (!token) return null;
        const body = { name };
        const res = await this.httpJson("POST", `${FEISHU_API}/task/v2/tasklists`, body, token);
        if (!res || res.code !== 0 || !res.data || !res.data.tasklist) {
            this.log("创建飞书任务清单失败: " + ((res && res.msg) || JSON.stringify(res)));
            return null;
        }
        return res.data.tasklist.guid;
    }

    async resolveFeishuTasklists() {
        let guids = (this.cfg.feishuTasklistGuids || []).filter(Boolean);
        if (guids.length === 0 && this.cfg.tasklistGuid) guids = [this.cfg.tasklistGuid];
        if (guids.length === 0) {
            const all = this.tasklists.length ? this.tasklists : await this.listTasklists();
            const name = this.cfg.feishuDefaultTasklistName || "AI管家·每日待办";
            const target = all.find((it) => (it.name || "").includes(name));
            if (target) guids = [target.guid];
        }
        return guids;
    }

    async listTasks() {
        const token = await this.getValidToken();
        if (!token) return [];
        const guids = await this.resolveFeishuTasklists();
        const items = [];
        const collect = async (urlBase, setType) => {
            let pageToken = "";
            for (let i = 0; i < 50; i++) {
                const q = new URLSearchParams({ page_size: "100" });
                if (setType) q.set("type", "my_tasks");
                if (pageToken) q.set("page_token", pageToken);
                const res = await this.httpJson("GET", `${urlBase}?${q.toString()}`, undefined, token);
                if (!res || res.code !== 0 || !res.data) break;
                (res.data.items || []).forEach((it) => items.push(it));
                pageToken = res.data.page_token || "";
                if (!res.data.has_more || !pageToken) break;
            }
        };
        if (guids.length === 0) {
            await collect(`${FEISHU_API}/task/v2/tasks`, true);
        } else {
            for (const guid of guids) {
                await collect(`${FEISHU_API}/task/v2/tasklists/${guid}/tasks`, false);
            }
        }
        const seen = new Set();
        return items.filter((it) => {
            if (!it || !it.guid || seen.has(it.guid)) return false;
            seen.add(it.guid);
            return true;
        });
    }

    async createFeishuTask(summary, description, due, siyuanId, openId) {
        const token = await this.getValidToken();
        if (!token) return null;
        const body = { summary: summary || "" };
        if (description) body.description = description;
        if (due) body.due = due;
        if (openId) {
            body.members = [{ id: openId, type: "user", role: "assignee" }];
        }
        if (siyuanId) {
            try {
                body.extra = JSON.stringify({ siyuan_id: siyuanId });
            } catch (e) {
                /* ignore */
            }
        }
        body.client_token = `st${Date.now()}-${randomStr(8)}`;
        const res = await this.httpJson("POST", `${FEISHU_API}/task/v2/tasks?user_id_type=open_id`, body, token);
        if (!res || res.code !== 0 || !res.data || !res.data.task) {
            this.log("创建飞书任务失败: " + ((res && res.msg) || JSON.stringify(res)));
            return null;
        }
        return res.data.task.guid;
    }

    async updateFeishuTask(guid, fields) {
        const token = await this.getValidToken();
        if (!token) return false;
        const updateFields = [];
        const task = {};
        if (fields.summary !== undefined) {
            task.summary = fields.summary || "";
            updateFields.push("summary");
        }
        if (fields.description !== undefined) {
            task.description = fields.description || "";
            updateFields.push("description");
        }
        if ("due" in fields) {
            task.due = fields.due || null;
            updateFields.push("due");
        }
        if (updateFields.length === 0) return true;
        const body = { task, update_fields: updateFields };
        const res = await this.httpJson("PATCH", `${FEISHU_API}/task/v2/tasks/${guid}?user_id_type=open_id`, body, token);
        return !!(res && res.code === 0);
    }

    async completeFeishuTask(guid, complete) {
        const token = await this.getValidToken();
        if (!token) return false;
        const completedAt = complete ? String(Date.now()) : "0";
        const body = {
            task: { completed_at: completedAt },
            update_fields: ["completed_at"],
        };
        const res = await this.httpJson("PATCH", `${FEISHU_API}/task/v2/tasks/${guid}?user_id_type=open_id`, body, token);
        this.log(`完成状态更新 guid=${guid} complete=${complete} code=${res && res.code} msg=${res && res.msg}`);
        if (!res || res.code !== 0) {
            this.log("更新飞书完成状态失败: " + JSON.stringify(res));
        }
        return !!(res && res.code === 0);
    }

    async getFeishuTask(guid) {
        const token = await this.getValidToken();
        if (!token) return { status: "unknown" };
        const res = await this.httpJson("GET", `${FEISHU_API}/task/v2/tasks/${guid}?user_id_type=open_id`, undefined, token);
        if (!res) return { status: "unknown" };
        if (res.code === 0 && res.data && res.data.task) return { status: "ok", task: res.data.task };
        if (res.code === 1470404) {
            this.log(`飞书任务不存在或已删除(1470404): ${guid}`);
            return { status: "missing" };
        }
        this.log(`飞书任务查询未确认: code=${res.code} msg=${res.msg}`);
        return { status: "unknown", code: res.code, msg: res.msg };
    }

    async deleteFeishuTask(guid) {
        const token = await this.getValidToken();
        if (!token) return false;
        const res = await this.httpJson("DELETE", `${FEISHU_API}/task/v2/tasks/${guid}?user_id_type=open_id`, undefined, token);
        return !!(res && res.code === 0);
    }

    async resolveTasklist() {
        if (this.tasklists.length === 0) {
            this.tasklists = await this.listTasklists();
        }
        if (this.cfg.tasklistGuid) {
            const found = this.tasklists.find((it) => it.guid === this.cfg.tasklistGuid);
            if (found) return found.guid;
        }
        // 尝试自动识别清单，找不到则自动创建「思源待办」
        let target = this.tasklists.find((it) => /待办|思源|我负责/.test(it.name || "")) || this.tasklists[0];
        if (!target) {
            const guid = await this.createTasklist("思源待办");
            if (guid) {
                target = { guid, name: "思源待办" };
                this.tasklists.push(target);
            }
        }
        if (target && target.guid) {
            this.cfg.tasklistGuid = target.guid;
            await this.persist();
            return target.guid;
        }
        return "";
    }

    // ---------- 企业微信日程通道 ----------
    wecomConfigured() {
        return !!(this.cfg.wecomCorpId && this.cfg.wecomSecret && this.cfg.wecomAgentId && this.cfg.wecomCalId && this.cfg.wecomUserId);
    }

    async getWecomToken(force) {
        if (!this.cfg.wecomCorpId || !this.cfg.wecomSecret) return null;
        if (!force && this.wecomToken && this.wecomToken.expiresAt > Date.now() + 60000) {
            return this.wecomToken.access_token;
        }
        const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.cfg.wecomCorpId)}&corpsecret=${encodeURIComponent(this.cfg.wecomSecret)}`;
        const resp = await fetch(url);
        const json = await resp.json().catch(() => ({}));
        if (!json || json.errcode !== 0 || !json.access_token) {
            this.log("企业微信获取 token 失败: " + ((json && json.errmsg) || "unknown"));
            return null;
        }
        this.wecomToken = { access_token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 7200) * 1000 };
        return this.wecomToken.access_token;
    }

    async wecomRequest(path, body) {
        const token = await this.getWecomToken();
        if (!token) return { errcode: -1, errmsg: "no token" };
        const doPost = async (tk) => {
            const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/${path}?access_token=${encodeURIComponent(tk)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body || {}),
            });
            return resp.json().catch(() => ({}));
        };
        let json = await doPost(token);
        if (json && json.errcode === 42001) {
            const t2 = await this.getWecomToken(true);
            if (t2) json = await doPost(t2);
        }
        return json;
    }

    async wecomListSchedules() {
        if (!this.wecomConfigured()) return [];
        const limit = 1000;
        let offset = 0;
        const out = [];
        for (let i = 0; i < 20; i++) {
            const json = await this.wecomRequest("oa/schedule/get_by_calendar", { cal_id: this.cfg.wecomCalId, offset, limit });
            if (!json || json.errcode !== 0) {
                this.log("企业微信日程列举失败: " + ((json && json.errmsg) || "unknown"));
                return null;
            }
            const list = json.schedule_list || [];
            for (const s of list) out.push(s);
            if (list.length < limit) break;
            offset += limit;
        }
        return out;
    }

    wecomDueFromSiyuan(st) {
        const d = parseDate(st.endDate || st.date);
        if (!d) return null;
        const t = parseTime(st.endTime || st.time);
        const startMs = t ? new Date(d.y, d.mo - 1, d.d, t.hh, t.mm).getTime() : new Date(d.y, d.mo - 1, d.d, 9, 0).getTime();
        const start = Math.floor(startMs / 1000);
        return { start, end: start + 3600, allDay: t ? 0 : 1 };
    }

    wecomSummary(st, completed) {
        return ((completed ? "✅ " : "") + (st.title || "")).slice(0, 120);
    }

    wecomDescription(st, completed) {
        const meta = `\n\n---\nsiyuan_task_id=${st.id}\nsiyuan_completed=${completed ? 1 : 0}`;
        return `${cleanSiyuanNote(st.note)}${meta}`;
    }

    async wecomCreateSchedule(st) {
        if (!this.wecomConfigured()) return null;
        const due = this.wecomDueFromSiyuan(st);
        if (!due) return null;
        const body = {
            schedule: {
                start_time: due.start,
                end_time: due.end,
                is_whole_day: due.allDay,
                attendees: [{ userid: this.cfg.wecomUserId }],
                summary: this.wecomSummary(st, !!st.completed),
                description: this.wecomDescription(st, !!st.completed),
                cal_id: this.cfg.wecomCalId,
            },
        };
        const json = await this.wecomRequest("oa/schedule/add", body);
        if (!json || json.errcode !== 0 || !json.schedule_id) {
            this.log("企业微信创建日程失败: " + ((json && json.errmsg) || "unknown"));
            return null;
        }
        return json.schedule_id;
    }

    async wecomUpdateSchedule(scheduleId, st) {
        if (!this.wecomConfigured() || !scheduleId) return false;
        const due = this.wecomDueFromSiyuan(st);
        if (!due) return false;
        const body = {
            schedule: {
                schedule_id: scheduleId,
                start_time: due.start,
                end_time: due.end,
                is_whole_day: due.allDay,
                attendees: [{ userid: this.cfg.wecomUserId }],
                summary: this.wecomSummary(st, !!st.completed),
                description: this.wecomDescription(st, !!st.completed),
            },
        };
        const json = await this.wecomRequest("oa/schedule/update", body);
        return !!(json && json.errcode === 0);
    }

    async wecomDeleteSchedule(scheduleId) {
        if (!this.wecomConfigured() || !scheduleId) return false;
        const json = await this.wecomRequest("oa/schedule/del", { schedule_id: scheduleId });
        return !!(json && json.errcode === 0);
    }

    wecomLogical(s) {
        const summary = String(s.summary || "");
        const completed = summary.startsWith("✅ ");
        const noteRaw = String(s.description || "");
        const note = noteRaw.replace(/\n\n---\nsiyuan_task_id=[\s\S]*$/, "").trim();
        let due = null;
        if (s.end_time) due = { timestamp: Number(s.end_time) * 1000, all_day: !!s.is_whole_day };
        return { title: (completed ? summary.slice(2) : summary).trim(), note, due, completed };
    }

    initDock(dock) {
        const el = dock.element;
        el.innerHTML = "";
        el.style.padding = "10px";
        el.style.display = "flex";
        el.style.flexDirection = "column";
        el.style.gap = "8px";
        const title = document.createElement("div");
        title.textContent = "飞书待办同步";
        title.style.fontWeight = "600";
        const openBtn = document.createElement("button");
        openBtn.className = "b3-button b3-button--outline";
        openBtn.textContent = "打开设置面板";
        openBtn.addEventListener("click", () => this.openSettingsDialog());
        const syncBtn = document.createElement("button");
        syncBtn.className = "b3-button b3-button--outline";
        syncBtn.textContent = "立即同步";
        syncBtn.addEventListener("click", () => this.syncNow(true));
        const testBtn = document.createElement("button");
        testBtn.className = "b3-button b3-button--outline";
        testBtn.textContent = "测试飞书连接";
        testBtn.addEventListener("click", async () => {
            testBtn.disabled = true;
            try {
                const msg = await this.testFeishu();
                this.log("连通性: " + msg);
                showMessage(msg);
            } finally {
                testBtn.disabled = false;
            }
        });
        const status = document.createElement("div");
        status.className = "feishu-todo-sync-hint";
        status.textContent = this.cfg.lastSyncAt ? "上次同步：" + new Date(this.cfg.lastSyncAt).toLocaleString() : "尚未同步";
        el.append(title, openBtn, syncBtn, testBtn, status);
    }

    async testFeishu() {
        if (!this.cfg.appId || !this.cfg.appSecret) return "请先填写 App ID / Secret";
        const token = await this.getValidToken();
        if (!token) return "获取 token 失败，请检查 App ID/Secret 或重新授权";
        const res = await this.httpJson("GET", `${FEISHU_API}/task/v2/tasklists?page_size=1`, undefined, token);
        if (res && res.code === 0) return "飞书连通性正常";
        return "飞书接口失败：" + ((res && res.msg) || JSON.stringify(res));
    }

    async testWebdav() {
        this.syncBackupFromDialog();
        if (!this.cfg.backupUrl) return "请先填写 WebDAV 地址";
        try {
            const base = ensureScheme(this.cfg.backupUrl).replace(/\/+$/, "");
            const dir = (this.cfg.backupPath || "feishu-backup").replace(/^\/+|\/+$/g, "");
            const url = `${base}/${dir}/.probe-${Date.now()}.json`;
            const headers = { "Content-Type": "application/json" };
            if (this.cfg.backupUsername) {
                headers.Authorization = "Basic " + base64Encode(`${this.cfg.backupUsername}:${this.cfg.backupPassword || ""}`);
            }
            const resp = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ probe: true }) });
            if (resp.ok || resp.status === 201 || resp.status === 204) return "WebDAV 写入正常";
            return "WebDAV 失败：HTTP " + resp.status;
        } catch (e) {
            return "WebDAV 异常：" + e.message;
        }
    }

    async testOss() {
        if (cryptoNode) this.syncBackupFromDialog();
        if (!cryptoNode) return "当前环境不支持 OSS 签名（移动端）";
        if (!this.cfg.ossEndpoint || !this.cfg.ossBucket || !this.cfg.ossAccessKey || !this.cfg.ossSecretKey) {
            return "请先填写 OSS Endpoint/Bucket/AccessKey/SecretKey";
        }
        try {
            const objectKey = `${(this.cfg.ossPath || "feishu-backup").replace(/^\/+|\/+$/g, "")}/.probe-${Date.now()}.json`;
            const body = JSON.stringify({ probe: true, time: Date.now() });
            const put = this.ossSign("PUT", objectKey, body);
            const resp = await fetch(put.url, { method: "PUT", headers: put.headers, body });
            const putOk = resp.ok || [200, 201, 204].includes(resp.status);
            const get = this.ossSign("GET", objectKey, "");
            const v = await fetch(get.url, { method: "GET", headers: get.headers }).catch(() => null);
            const getOk = !!(v && v.ok);
            this.log(`OSS 测试 PUT ${put.url} -> ${resp.status}; GET -> ${v ? v.status : "n/a"}`);
            if (!putOk) {
                const t = await resp.text().catch(() => "");
                return `OSS 写入失败 HTTP ${resp.status}: ${t.slice(0, 200)}`;
            }
            if (!getOk) {
                return `OSS PUT 返回 ${resp.status}，但回读校验失败（${v ? v.status : "无响应"}），文件可能未真正写入`;
            }
            return `OSS 读写正常: ${objectKey}`;
        } catch (e) {
            return "OSS 异常：" + e.message;
        }
    }

    async listOssBackups() {
        if (!cryptoNode) return "当前环境不支持 OSS 签名（移动端）";
        this.syncBackupFromDialog();
        if (!this.cfg.ossEndpoint || !this.cfg.ossBucket || !this.cfg.ossAccessKey || !this.cfg.ossSecretKey) {
            return "请先填写 OSS 配置";
        }
        try {
            const prefix = (this.cfg.ossPath || "feishu-backup").replace(/^\/+|\/+$/g, "");
            const query = `list-type=2&max-keys=20&prefix=${encodeURIComponent(prefix + "/")}`;
            const req = this.ossSign("GET", "", "", query);
            this.log(`OSS LIST ${req.url}`);
            const resp = await fetch(req.url, { method: "GET", headers: req.headers });
            const text = await resp.text();
            this.log(`OSS LIST -> HTTP ${resp.status}`);
            if (!resp.ok) {
                this.log(`OSS LIST 失败: ${text.slice(0, 300)}`);
                return `列出失败 HTTP ${resp.status}`;
            }
            const keys = [];
            const re = /<Key>([^<]+)<\/Key>/g;
            let m;
            while ((m = re.exec(text))) keys.push(m[1]);
            if (keys.length === 0) {
                this.log(`OSS LIST 前缀 ${prefix}/ 下无对象`);
                return `前缀 ${prefix}/ 下没有对象`;
            }
            this.log(`OSS LIST 找到 ${keys.length} 个对象: ${keys.join(", ")}`);
            return `找到 ${keys.length} 个：${keys.slice(0, 5).join(", ")}`;
        } catch (e) {
            return "列出异常：" + e.message;
        }
    }

    // ---------- AI 诊断 ----------
    buildDiagnosePackage() {
        const strip = (obj) => {
            const out = {};
            for (const [k, v] of Object.entries(obj || {})) {
                if (/secret|token|key|password|accesskey/i.test(k)) out[k] = v ? "***" : "";
                else if (/appId|corpId|agentId|calId|userId/i.test(k)) out[k] = v ? "***" : "";
                else out[k] = v;
            }
            return out;
        };
        return {
            plugin: "siyuan-plugin-feishu-todo-sync",
            version: (this.manifest && this.manifest.version) || "",
            time: new Date().toISOString(),
            config: strip(this.cfg),
            mappingCount: Object.keys(this.mapping || {}).length,
            tombstoneCount: Object.keys(this.tombstones || {}).length,
            recentLogs: (this.logHistory || []).slice(-60),
        };
    }

    async askAi(question) {
        if (!this.cfg.aiBaseUrl || !this.cfg.aiModel || !this.cfg.aiApiKey) {
            showMessage("请先配置 AI 诊断地址、模型和 API Key");
            return "";
        }
        const pkg = this.buildDiagnosePackage();
        const system = "你是 SiYuan 飞书/企业微信待办同步插件的排障助手。只能依据给定脱敏诊断包分析，不要索取或输出任何密钥、令牌、任务正文或个人信息。先指出可能的错误分类，再给出可验证的修复步骤。";
        const user = (question ? "用户问题：" + question + "\n\n" : "") + "诊断包：\n" + JSON.stringify(pkg, null, 2);
        const base = ensureScheme(this.cfg.aiBaseUrl).replace(/\/+$/, "");
        const resp = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.aiApiKey}` },
            body: JSON.stringify({ model: this.cfg.aiModel, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        });
        const json = await resp.json().catch(() => ({}));
        if (json && json.choices && json.choices[0] && json.choices[0].message) return json.choices[0].message.content || "";
        return "AI 调用失败: " + ((json && json.error && json.error.message) || resp.status);
    }

    renderAiBubble(logEl, role, text) {
        const row = document.createElement("div");
        row.className = "ftsd-ai-msg ftsd-ai-" + role;
        const bubble = document.createElement("div");
        bubble.className = "ftsd-ai-bubble";
        bubble.textContent = text;
        row.append(bubble);
        logEl.append(row);
        logEl.scrollTop = logEl.scrollHeight;
    }

    openAiChat() {
        if (this.aiDialog) {
            try {
                this.aiDialog.destroy();
            } catch (e) {
                /* ignore */
            }
            this.aiDialog = null;
        }
        this.aiChat = this.aiChat || [];
        const dialog = new Dialog({
            title: "AI 诊断对话",
            content: "<div class='ftsd-ai'><div class='ftsd-ai-log'></div><div class='ftsd-ai-input'><textarea class='b3-text-field fn__block' rows='2' placeholder='描述你的问题，Enter 发送，Shift+Enter 换行'></textarea><button class='b3-button b3-button--outline'>发送</button></div></div>",
            width: "760px",
        });
        this.aiDialog = dialog;
        const root = dialog.element;
        const logEl = root.querySelector(".ftsd-ai-log");
        const input = root.querySelector("textarea");
        const btn = root.querySelector("button");
        if (this.aiChat.length === 0) {
            this.aiChat.push({ role: "assistant", content: "你好，我是本插件的排障助手。直接描述问题即可，我会结合脱敏诊断包分析。" });
        }
        for (const m of this.aiChat) {
            this.renderAiBubble(logEl, m.role, m.content);
        }
        const send = async () => {
            const text = (input.value || "").trim();
            if (!text) return;
            input.value = "";
            this.aiChat.push({ role: "user", content: text });
            this.renderAiBubble(logEl, "user", text);
            btn.disabled = true;
            const thinking = document.createElement("div");
            thinking.className = "ftsd-ai-msg ftsd-ai-assistant";
            thinking.textContent = "思考中…";
            logEl.append(thinking);
            logEl.scrollTop = logEl.scrollHeight;
            try {
                const answer = await this.askAiChat();
                this.aiChat.push({ role: "assistant", content: answer });
                if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
                this.renderAiBubble(logEl, "assistant", answer);
            } catch (e) {
                if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
                this.renderAiBubble(logEl, "assistant", "调用失败: " + e.message);
            } finally {
                btn.disabled = false;
            }
        };
        btn.addEventListener("click", send);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    }

    async askAiChat() {
        if (!this.cfg.aiBaseUrl || !this.cfg.aiModel || !this.cfg.aiApiKey) {
            return "请先在「AI 诊断」页配置 API 地址、模型和 API Key。";
        }
        const pkg = this.buildDiagnosePackage();
        const system = "你是 SiYuan 飞书待办同步插件的排障助手。只能依据给定脱敏诊断包和对话分析，不要索取或输出任何密钥、令牌、任务正文或个人信息。用中文回答：先给出可能的错误分类，再给出可验证的修复步骤。";
        const messages = [{ role: "system", content: system }];
        for (const m of (this.aiChat || []).slice(-20)) {
            messages.push({ role: m.role, content: m.content });
        }
        messages.push({ role: "user", content: "最新脱敏诊断包：\n" + JSON.stringify(pkg, null, 2) });
        const base = ensureScheme(this.cfg.aiBaseUrl).replace(/\/+$/, "");
        const resp = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.aiApiKey}` },
            body: JSON.stringify({ model: this.cfg.aiModel, messages }),
        });
        const json = await resp.json().catch(() => ({}));
        if (json && json.choices && json.choices[0] && json.choices[0].message) {
            return json.choices[0].message.content || "";
        }
        return "AI 调用失败: " + ((json && json.error && json.error.message) || resp.status);
    }

    // ---------- 同步逻辑 ----------
    isSyncableSiyuanTask(st, selectedCats) {
        if (!st || !st.title) return false;
        if (st.repeat && st.repeat.enabled) return false;
        if (selectedCats.size === 0) return false;
        const cats = String(st.categoryId || "").split(",").map((s) => s.trim()).filter(Boolean);
        for (const c of cats) {
            if (selectedCats.has(c)) return true;
        }
        return false;
    }

    isOutOfSyncScope(st, selectedCats) {
        if (!selectedCats || selectedCats.size === 0) return false;
        if (isFeishuCategory(st) || isMirrorTask(st)) return false;
        const cats = String(st.categoryId || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (cats.length === 0) return false;
        return !cats.some((c) => selectedCats.has(c));
    }

    async syncNow(manual) {
        if (this.running) return;
        if (this.paused && !manual) return;
        this.running = true;
        if (manual && this.elements.syncBtn) {
            this.elements.syncBtn.disabled = true;
            this.elements.syncBtn.textContent = "同步中…";
        }
        try {
            const channels = this.cfg.channels && this.cfg.channels.length ? this.cfg.channels : ["feishu"];
            const feishuEnabled = channels.includes("feishu");
            const wecomEnabled = channels.includes("wecom");
            if (!feishuEnabled && !wecomEnabled) {
                this.log("未启用任何同步渠道");
                if (manual) showMessage("请至少启用一个同步渠道");
                return;
            }
            if (feishuEnabled && (!this.cfg.appId || !this.cfg.appSecret)) {
                this.log(this.i18n.needCredentials);
                if (manual) showMessage(this.i18n.needCredentials);
                return;
            }
            let token = null;
            let openId = null;
            if (feishuEnabled) {
                token = await this.getValidToken();
                if (!token) {
                    this.log(this.i18n.needAuthorize);
                    if (manual) showMessage(this.i18n.needAuthorize);
                    return;
                }
                openId = this.cfg.openId || (await this.getUserOpenId());
                if (openId) {
                    this.cfg.openId = openId;
                }
            }
            const reminders = await this.readReminders();
            if (!reminders) {
                this.log("读取任务数据失败，本轮同步已中止");
                if (manual) showMessage("读取任务数据失败，本轮同步已中止");
                return;
            }
            this.remindersDirty = false;

            if (feishuEnabled) {
                const feishuTasks = await this.listTasks();
                const feishuByGuid = new Map(feishuTasks.map((t) => [t.guid, t]));
                const selectedCats = new Set(this.cfg.syncCategories || []);
                this.recoverMappingFromExtra(feishuTasks, reminders);
                this.recoverExistingMappings(feishuTasks, reminders);
                const feishuToSiyuan = {};
                for (const [sid, m] of Object.entries(this.mapping)) {
                    if (m && m.feishuGuid) feishuToSiyuan[m.feishuGuid] = sid;
                }
                const pullEnabled = this.cfg.syncDirection !== "siyuan_to_feishu";
                const pushEnabled = this.cfg.syncDirection !== "feishu_to_siyuan";
                if (pullEnabled) {
                    for (const ft of feishuTasks) {
                        if (feishuToSiyuan[ft.guid]) continue;
                        if (this.tombstones[ft.guid]) continue;
                        if (ft.completed_at && ft.completed_at !== "0") continue;
                        const sid = this.createSiyuanTaskFromFeishu(ft, reminders);
                        if (sid) {
                            this.mapping[sid] = { feishuGuid: ft.guid, lastHash: "" };
                            feishuToSiyuan[ft.guid] = sid;
                        }
                    }
                }
                if (pushEnabled) {
                    for (const [sid, st] of Object.entries(reminders)) {
                        if (this.mapping[sid]) continue;
                        if (isMirrorTask(st)) continue;
                        if (isFeishuCategory(st)) continue;
                        if (st.completed) continue;
                        if (!this.isSyncableSiyuanTask(st, selectedCats)) continue;
                        const guid = await this.createFeishuTaskFromSiyuan(st, openId);
                        if (guid) {
                            this.mapping[sid] = { feishuGuid: guid, lastHash: "" };
                        }
                    }
                }
                for (const [sid, m] of Object.entries(this.mapping)) {
                    const st = reminders[sid];
                    const ft = feishuByGuid.get(m.feishuGuid);
                    if (!st && !ft) {
                        delete this.mapping[sid];
                        continue;
                    }
                    if (!st && ft) {
                        await this.handleSiyuanDeleted(sid, ft, reminders);
                        continue;
                    }
                    if (st && !ft) {
                        await this.handleFeishuMissing(sid, st, m, reminders);
                        continue;
                    }
                    if (this.cfg.markDeleted && this.isOutOfSyncScope(st, selectedCats)) {
                        const newSummary = appendTitleSuffix(ft.summary, MOVED_SUFFIX, 110);
                        if (newSummary !== ft.summary) {
                            await this.updateFeishuTask(ft.guid, { summary: newSummary });
                            this.log(`已将飞书任务标题标注转移: ${newSummary}`);
                        }
                        continue;
                    }
                    await this.reconcilePair(sid, st, ft, m);
                }
            }

            if (wecomEnabled) {
                await this.syncWecomPass(reminders);
            }

            if (this.remindersDirty) {
                await this.writeReminders(reminders);
            }
            this.cfg.lastSyncAt = Date.now();
            await this.persist();
            this.log(this.i18n.syncDone);
            if (manual) showMessage(this.i18n.syncDone);
        } catch (e) {
            this.log(this.i18n.syncFailed + ": " + e.message);
            if (manual) showMessage(this.i18n.syncFailed + ": " + e.message);
        } finally {
            this.running = false;
            if (this.elements.syncBtn) {
                this.elements.syncBtn.disabled = false;
                this.elements.syncBtn.textContent = this.i18n.syncNow;
            }
        }
    }

    async syncWecomPass(reminders) {
        if (!this.wecomConfigured()) {
            this.log("企业微信通道未配置完整，已跳过");
            return;
        }
        const schedules = await this.wecomListSchedules();
        if (!schedules) return;
        this.wecomMapping = this.wecomMapping || {};
        const byId = new Map(schedules.filter((s) => s.status !== 1).map((s) => [s.schedule_id, s]));
        const selectedCats = new Set(this.cfg.syncCategories || []);
        const pullEnabled = this.cfg.syncDirection !== "siyuan_to_feishu";
        const pushEnabled = this.cfg.syncDirection !== "feishu_to_siyuan";
        const idToSchedule = {};
        for (const [scheduleId, m] of Object.entries(this.wecomMapping)) {
            if (m && m.siyuanId) idToSchedule[m.siyuanId] = scheduleId;
        }
        if (pullEnabled) {
            for (const s of schedules) {
                if (s.status === 1) continue;
                if (this.wecomMapping[s.schedule_id]) continue;
                const logical = this.wecomLogical(s);
                if (logical.completed) continue;
                const sid = genSiyuanTaskId();
                const entry = {
                    id: sid,
                    title: logical.title,
                    categoryId: FEISHU_CATEGORY,
                    completed: false,
                    note: `来源：企业微信日程\nwecom_schedule_id: ${s.schedule_id}\n\n${logical.note}`.trim(),
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    kanbanStatus: "doing",
                };
                if (logical.due) {
                    const d = feishuDue({ timestamp: String(logical.due.timestamp), is_all_day: logical.due.all_day });
                    if (d.date) entry.endDate = d.date;
                    if (d.time) entry.endTime = d.time;
                }
                reminders[sid] = entry;
                this.wecomMapping[s.schedule_id] = { siyuanId: sid, lastHash: hashLogical(logical) };
                idToSchedule[sid] = s.schedule_id;
                this.remindersDirty = true;
            }
        }
        if (pushEnabled) {
            for (const [sid, st] of Object.entries(reminders)) {
                if (idToSchedule[sid]) continue;
                if (isMirrorTask(st)) continue;
                if (st.completed) continue;
                if (!this.isSyncableSiyuanTask(st, selectedCats)) continue;
                const scheduleId = await this.wecomCreateSchedule(st);
                if (scheduleId) {
                    this.wecomMapping[scheduleId] = { siyuanId: sid, lastHash: hashLogical(siyuanLogical(st)) };
                    idToSchedule[sid] = scheduleId;
                }
            }
        }
        for (const [scheduleId, m] of Object.entries(this.wecomMapping)) {
            if (!m || !m.siyuanId) continue;
            const st = reminders[m.siyuanId];
            if (!st) {
                delete this.wecomMapping[scheduleId];
                continue;
            }
            const s = byId.get(scheduleId);
            if (!s) continue;
            const sLog = siyuanLogical(st);
            const fLog = this.wecomLogical(s);
            const sHash = hashLogical(sLog);
            const fHash = hashLogical(fLog);
            const sChanged = sHash !== (m.lastHash || "");
            const fChanged = fHash !== (m.lastHash || "");
            if (!sChanged && !fChanged) continue;
            if (!sChanged && fChanged) {
                st.title = fLog.title;
                st.note = `来源：企业微信日程\nwecom_schedule_id: ${scheduleId}\n\n${fLog.note}`.trim();
                st.completed = fLog.completed;
                if (fLog.due) {
                    const d = feishuDue({ timestamp: String(fLog.due.timestamp), is_all_day: fLog.due.all_day });
                    if (d.date) st.endDate = d.date; else delete st.endDate;
                    if (d.time) st.endTime = d.time; else delete st.endTime;
                }
                st.updatedAt = new Date().toISOString();
                this.remindersDirty = true;
                m.lastHash = fHash;
            } else {
                const ok = await this.wecomUpdateSchedule(scheduleId, st);
                if (ok) m.lastHash = sHash;
            }
        }
    }

    recoverMappingFromExtra(feishuTasks, reminders) {
        for (const ft of feishuTasks) {
            if (!ft.extra) continue;
            try {
                const ex = JSON.parse(ft.extra);
                if (ex && ex.siyuan_id && reminders[ex.siyuan_id] && !this.mapping[ex.siyuan_id]) {
                    this.mapping[ex.siyuan_id] = { feishuGuid: ft.guid, lastHash: "" };
                }
            } catch (e) {
                /* ignore */
            }
        }
    }

    recoverExistingMappings(feishuTasks, reminders) {
        const feishuGuids = new Set(feishuTasks.map((t) => t.guid));
        const noteBased = {};
        for (const [sid, st] of Object.entries(reminders)) {
            const note = st.note || "";
            const m = /feishu_guid[:：]\s*([0-9a-fA-F-]{36})/.exec(note);
            if (m && feishuGuids.has(m[1])) {
                noteBased[m[1]] = sid;
            }
        }
        // 只做映射归位：同一飞书任务已有镜像，就把映射指向该镜像，不删除 reminder
        for (const [guid, oldSid] of Object.entries(noteBased)) {
            for (const [sid, mp] of Object.entries(this.mapping)) {
                if (sid !== oldSid && mp && mp.feishuGuid === guid) {
                    delete this.mapping[sid];
                }
            }
            if (!this.mapping[oldSid]) {
                this.mapping[oldSid] = { feishuGuid: guid, lastHash: "" };
            }
        }
    }

    createSiyuanTaskFromFeishu(ft, reminders) {
        const sid = genSiyuanTaskId();
        const { date, time } = feishuDue(ft.due);
        const completed = !!(ft.completed_at && ft.completed_at !== "0");
        const note = `来源：飞书待办\nfeishu_guid: ${ft.guid}\n\n${ft.description || ""}`.trim();
        const entry = {
            id: sid,
            title: ft.summary || "",
            categoryId: FEISHU_CATEGORY,
            completed,
            note,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            kanbanStatus: "doing",
        };
        if (date) entry.date = date;
        if (time) entry.time = time;
        if (completed) entry.completedTime = ft.completed_at ? new Date(Number(ft.completed_at)).toLocaleString("sv-SE").replace("T", " ") : "";
        reminders[sid] = entry;
        this.remindersDirty = true;
        return sid;
    }

    async createFeishuTaskFromSiyuan(st, openId) {
        const summary = st.title || "";
        const description = cleanSiyuanNote(st.note);
        const due = siyuanDue(st.endDate || st.date, st.endTime || st.time);
        let guid = await this.createFeishuTask(summary, description, due, st.id, openId);
        if (!guid) return null;
        if (st.completed) {
            await this.completeFeishuTask(guid, true);
        }
        return guid;
    }

    async reconcilePair(sid, st, ft, m) {
        const cleanedTitle = stripTitleSuffix(st.title);
        if (cleanedTitle !== st.title) {
            st.title = cleanedTitle;
            this.remindersDirty = true;
        }
        const sLog = siyuanLogical(st);
        const fLog = feishuLogical(ft);
        const sHash = hashLogical(sLog);
        const fHash = hashLogical(fLog);
        const lastHash = m.lastHash || "";

        const sChanged = sHash !== lastHash;
        const fChanged = fHash !== lastHash;

        if (!sChanged && !fChanged) return;

        let siyuanWins = sChanged;
        if (sChanged && fChanged) {
            const siyuanT = siyuanModifiedMs(st);
            const feishuT = feishuModifiedMs(ft);
            siyuanWins = siyuanT >= feishuT || !feishuT;
            this.log(`双向冲突按最新时间: ${st.title} S=${siyuanT} F=${feishuT} -> ${siyuanWins ? "S→F" : "F→S"}`);
        }
        if (this.cfg.syncDirection === "feishu_to_siyuan") {
            siyuanWins = false;
        } else if (this.cfg.syncDirection === "siyuan_to_feishu") {
            siyuanWins = true;
        }

        if (siyuanWins) {
            const ok = await this.pushSiyuanToFeishu(st, ft, sLog, fLog);
            if (ok) m.lastHash = sHash;
        } else {
            const changed = this.pullFeishuToSiyuan(st, ft, sLog, fLog);
            if (changed) m.lastHash = fHash;
        }
    }

    async pushSiyuanToFeishu(st, ft, sLog, fLog) {
        let ok = true;
        const titleChanged = sLog.title !== fLog.title;
        const dueChanged = !sameDue(sLog.due, fLog.due);
        const noteChanged = !!sLog.note && sLog.note !== fLog.note;
        if (titleChanged || dueChanged || noteChanged) {
            this.log(`同步内容(S→F): ${st.title}`);
            const fields = { summary: sLog.title, due: sLog.due || null };
            if (sLog.note) fields.description = sLog.note;
            const r = await this.updateFeishuTask(ft.guid, fields);
            if (!r) ok = false;
        }
        if (sLog.completed !== fLog.completed) {
            this.log(`同步完成状态(S→F): ${st.title} -> ${sLog.completed}`);
            const r = await this.completeFeishuTask(ft.guid, sLog.completed);
            if (!r) ok = false;
        }
        return ok;
    }

    pullFeishuToSiyuan(st, ft, sLog, fLog) {
        const changed =
            sLog.title !== fLog.title ||
            sLog.note !== fLog.note ||
            sLog.completed !== fLog.completed ||
            !sameDue(sLog.due, fLog.due);
        if (!changed) return false;

        this.log(`同步状态(F→S): ${ft.summary}`);
        st.title = fLog.title;
        st.note = `来源：飞书待办\nfeishu_guid: ${ft.guid}\n\n${fLog.note}`.trim();
        const d = feishuDue(fLog.due);
        if (d.date) {
            st.endDate = d.date;
            st.endTime = d.time || undefined;
        } else {
            delete st.endDate;
            delete st.endTime;
        }
        st.completed = fLog.completed;
        if (fLog.completed) {
            st.completedTime = ft.completed_at ? formatCompletedTime(ft.completed_at) : st.completedTime;
        } else {
            delete st.completedTime;
        }
        st.updatedAt = new Date().toISOString();
        this.remindersDirty = true;
        return true;
    }

    async handleSiyuanDeleted(sid, ft, reminders) {
        const orphan = Object.entries(this.mapping).some(([id, mp]) => id !== sid && mp && mp.feishuGuid === ft.guid && reminders[id]);
        if (orphan) {
            delete this.mapping[sid];
            this.log(`删除死映射(存在其他镜像): ${ft.summary}`);
            return;
        }
        if (this.cfg.syncDirection === "feishu_to_siyuan") {
            delete this.mapping[sid];
            this.log(`解绑映射(不删飞书): ${ft.summary}`);
            return;
        }
        if (this.cfg.markDeleted) {
            const newSummary = appendTitleSuffix(ft.summary, DELETED_SUFFIX, 118);
            if (newSummary !== ft.summary) {
                await this.updateFeishuTask(ft.guid, { summary: newSummary });
                this.log(`已将飞书任务标题标注删除: ${newSummary}`);
            }
            delete this.mapping[sid];
            this.tombstones[ft.guid] = Date.now();
            return;
        }
        if (this.cfg.deleteDryRun) {
            this.log(`[dryRun] 将删除飞书任务: ${ft.summary} (${ft.guid})`);
            return;
        }
        const ok = await this.deleteFeishuTask(ft.guid);
        if (ok) {
            delete this.mapping[sid];
            this.tombstones[ft.guid] = Date.now();
            this.log(`已删除飞书任务: ${ft.summary}`);
        }
    }

    async handleFeishuMissing(sid, st, m, reminders) {
        m.missingRounds = (m.missingRounds || 0) + 1;
        if (m.missingRounds < 2) return;
        const r = await this.getFeishuTask(m.feishuGuid);
        if (r && r.status === "ok") {
            if (this.cfg.markDeleted && !String(st.title || "").endsWith(MOVED_SUFFIX)) {
                st.title = appendTitleSuffix(st.title, MOVED_SUFFIX);
                this.remindersDirty = true;
                this.log(`已将思源镜像标题标注转移: ${st.title}`);
            }
            m.missingRounds = 0;
            return;
        }
        if (!r || r.status === "unknown") {
            this.log(`飞书任务查询失败，保留思源镜像待下轮重试: ${st.title}`);
            return;
        }
        if (this.cfg.markDeleted) {
            if (!String(st.title || "").endsWith(DELETED_SUFFIX)) {
                st.title = appendTitleSuffix(st.title, DELETED_SUFFIX);
                this.remindersDirty = true;
                this.log(`已将思源镜像标题标注删除: ${st.title}`);
            }
            delete this.mapping[sid];
            this.tombstones[m.feishuGuid] = Date.now();
            return;
        }
        if (this.cfg.syncDirection === "siyuan_to_feishu") {
            delete this.mapping[sid];
            this.log(`解绑映射(不删思源): ${st.title}`);
            return;
        }
        if (this.cfg.deleteDryRun) {
            this.log(`[dryRun] 将删除思源镜像: ${st.title}`);
            return;
        }
        delete reminders[sid];
        delete this.mapping[sid];
        this.tombstones[m.feishuGuid] = Date.now();
        this.remindersDirty = true;
        this.log(`已删除思源镜像(飞书不存在): ${st.title}`);
    }

    // ---------- 设置面板 ----------
    _legacyBuildSetting() {
        this.setting = new Setting({
            confirmCallback: () => {
                this.onSettingSave();
            },
        });

        const appId = document.createElement("input");
        appId.className = "b3-text-field fn__block";
        appId.type = "text";
        this.elements.appId = appId;

        const appSecret = document.createElement("input");
        appSecret.className = "b3-text-field fn__block";
        appSecret.type = "password";
        this.elements.appSecret = appSecret;

        const scope = document.createElement("input");
        scope.className = "b3-text-field fn__block";
        scope.type = "text";
        this.elements.scope = scope;

        const oauthPort = document.createElement("input");
        oauthPort.className = "b3-text-field fn__block";
        oauthPort.type = "number";
        oauthPort.min = "1024";
        oauthPort.max = "65535";
        this.elements.oauthPort = oauthPort;

        const authStatus = document.createElement("div");
        authStatus.className = "feishu-todo-sync-status";
        this.elements.authStatus = authStatus;
        const authorizeBtn = document.createElement("button");
        authorizeBtn.className = "b3-button b3-button--outline";
        authorizeBtn.textContent = this.i18n.authorize;
        authorizeBtn.addEventListener("click", () => {
            this.startOAuth();
        });
        const authWrap = document.createElement("div");
        authWrap.className = "fn__flex";
        authWrap.style.gap = "8px";
        authWrap.append(authStatus, authorizeBtn);

        const restrictToTasklist = document.createElement("input");
        restrictToTasklist.type = "checkbox";
        this.elements.restrictToTasklist = restrictToTasklist;

        const tasklistSelect = document.createElement("select");
        tasklistSelect.className = "b3-select fn__block";
        this.elements.tasklistSelect = tasklistSelect;
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "b3-button b3-button--outline";
        refreshBtn.textContent = this.i18n.refreshTasklists;
        refreshBtn.addEventListener("click", () => {
            this.loadTasklistsIntoSelect(true);
        });

        const restrictLabel = document.createElement("label");
        restrictLabel.style.display = "flex";
        restrictLabel.style.alignItems = "center";
        restrictLabel.style.gap = "6px";
        restrictLabel.append(restrictToTasklist, document.createTextNode("仅同步指定清单"));
        restrictToTasklist.addEventListener("change", () => {
            if (restrictToTasklist.checked) {
                this.loadTasklistsIntoSelect(true);
            }
        });

        const tasklistRow = document.createElement("div");
        tasklistRow.style.display = "flex";
        tasklistRow.style.gap = "8px";
        tasklistRow.append(tasklistSelect, refreshBtn);

        const restrictWrap = document.createElement("div");
        restrictWrap.style.display = "flex";
        restrictWrap.style.flexDirection = "column";
        restrictWrap.style.gap = "8px";
        restrictWrap.append(restrictLabel, tasklistRow);

        const interval = document.createElement("input");
        interval.className = "b3-text-field fn__block";
        interval.type = "number";
        interval.min = "10";
        this.elements.interval = interval;

        const backupType = document.createElement("select");
        backupType.className = "b3-select fn__block";
        const bt1 = document.createElement("option");
        bt1.value = "none";
        bt1.textContent = "不备份";
        const bt2 = document.createElement("option");
        bt2.value = "webdav";
        bt2.textContent = "WebDAV";
        const bt3 = document.createElement("option");
        bt3.value = "oss";
        bt3.textContent = "OSS 存储桶";
        backupType.append(bt1, bt2, bt3);
        this.elements.backupType = backupType;

        const backupUrl = document.createElement("input");
        backupUrl.className = "b3-text-field fn__block";
        backupUrl.type = "text";
        backupUrl.placeholder = "https://dav.example.com/dav/";
        this.elements.backupUrl = backupUrl;

        const backupUsername = document.createElement("input");
        backupUsername.className = "b3-text-field fn__block";
        backupUsername.type = "text";
        this.elements.backupUsername = backupUsername;

        const backupPassword = document.createElement("input");
        backupPassword.className = "b3-text-field fn__block";
        backupPassword.type = "password";
        this.elements.backupPassword = backupPassword;

        const backupPath = document.createElement("input");
        backupPath.className = "b3-text-field fn__block";
        backupPath.type = "text";
        this.elements.backupPath = backupPath;

        const ossEndpoint = document.createElement("input");
        ossEndpoint.className = "b3-text-field fn__block";
        ossEndpoint.type = "text";
        ossEndpoint.placeholder = "https://oss-cn-hangzhou.aliyuncs.com";
        this.elements.ossEndpoint = ossEndpoint;

        const ossBucket = document.createElement("input");
        ossBucket.className = "b3-text-field fn__block";
        ossBucket.type = "text";
        this.elements.ossBucket = ossBucket;

        const ossRegion = document.createElement("input");
        ossRegion.className = "b3-text-field fn__block";
        ossRegion.type = "text";
        ossRegion.placeholder = "oss-cn-hangzhou";
        this.elements.ossRegion = ossRegion;

        const ossAccessKey = document.createElement("input");
        ossAccessKey.className = "b3-text-field fn__block";
        ossAccessKey.type = "text";
        this.elements.ossAccessKey = ossAccessKey;

        const ossSecretKey = document.createElement("input");
        ossSecretKey.className = "b3-text-field fn__block";
        ossSecretKey.type = "password";
        this.elements.ossSecretKey = ossSecretKey;

        const ossPath = document.createElement("input");
        ossPath.className = "b3-text-field fn__block";
        ossPath.type = "text";
        this.elements.ossPath = ossPath;

        const feishuChannel = document.createElement("input");
        feishuChannel.type = "checkbox";
        this.elements.feishuChannel = feishuChannel;
        const wecomChannel = document.createElement("input");
        wecomChannel.type = "checkbox";
        this.elements.wecomChannel = wecomChannel;
        const feishuChannelLabel = document.createElement("label");
        feishuChannelLabel.style.display = "flex";
        feishuChannelLabel.style.alignItems = "center";
        feishuChannelLabel.style.gap = "6px";
        feishuChannelLabel.append(feishuChannel, document.createTextNode("飞书任务"));
        const wecomChannelLabel = document.createElement("label");
        wecomChannelLabel.style.display = "flex";
        wecomChannelLabel.style.alignItems = "center";
        wecomChannelLabel.style.gap = "6px";
        wecomChannelLabel.append(wecomChannel, document.createTextNode("企业微信日程"));
        const channelWrap = document.createElement("div");
        channelWrap.style.display = "flex";
        channelWrap.style.gap = "16px";
        channelWrap.append(feishuChannelLabel, wecomChannelLabel);

        const wecomCorpId = document.createElement("input");
        wecomCorpId.className = "b3-text-field fn__block";
        this.elements.wecomCorpId = wecomCorpId;
        const wecomSecret = document.createElement("input");
        wecomSecret.className = "b3-text-field fn__block";
        wecomSecret.type = "password";
        this.elements.wecomSecret = wecomSecret;
        const wecomAgentId = document.createElement("input");
        wecomAgentId.className = "b3-text-field fn__block";
        this.elements.wecomAgentId = wecomAgentId;
        const wecomCalId = document.createElement("input");
        wecomCalId.className = "b3-text-field fn__block";
        this.elements.wecomCalId = wecomCalId;
        const wecomUserId = document.createElement("input");
        wecomUserId.className = "b3-text-field fn__block";
        this.elements.wecomUserId = wecomUserId;

        const wecomAppBtn = document.createElement("button");
        wecomAppBtn.className = "b3-button b3-button--outline";
        wecomAppBtn.textContent = "打开企业微信管理后台";
        wecomAppBtn.addEventListener("click", () => {
            window.open("https://work.weixin.qq.com/wework_admin/frame#apps", "_blank");
        });
        const wecomDocBtn = document.createElement("button");
        wecomDocBtn.className = "b3-button b3-button--outline";
        wecomDocBtn.textContent = "日程接口权限文档";
        wecomDocBtn.addEventListener("click", () => {
            window.open("https://developer.work.weixin.qq.com/document/path/93624", "_blank");
        });
        const wecomLinkWrap = document.createElement("div");
        wecomLinkWrap.style.display = "flex";
        wecomLinkWrap.style.gap = "8px";
        wecomLinkWrap.append(wecomAppBtn, wecomDocBtn);

        const aiBaseUrl = document.createElement("input");
        aiBaseUrl.className = "b3-text-field fn__block";
        aiBaseUrl.placeholder = "https://api.example.com/v1";
        this.elements.aiBaseUrl = aiBaseUrl;
        const aiModel = document.createElement("input");
        aiModel.className = "b3-text-field fn__block";
        this.elements.aiModel = aiModel;
        const aiApiKey = document.createElement("input");
        aiApiKey.className = "b3-text-field fn__block";
        aiApiKey.type = "password";
        this.elements.aiApiKey = aiApiKey;
        const aiBtn = document.createElement("button");
        aiBtn.className = "b3-button b3-button--outline";
        aiBtn.textContent = "询问 AI";
        aiBtn.addEventListener("click", async () => {
            aiBtn.disabled = true;
            try {
                const answer = await this.askAi("请分析当前同步状态和错误");
                this.log("AI 诊断返回: " + (answer || "").slice(0, 200));
                showMessage((answer || "AI 无返回").slice(0, 400));
            } catch (e) {
                showMessage("AI 调用出错: " + e.message);
            } finally {
                aiBtn.disabled = false;
            }
        });
        const copyBtn = document.createElement("button");
        copyBtn.className = "b3-button b3-button--outline";
        copyBtn.textContent = "复制脱敏诊断包";
        copyBtn.addEventListener("click", async () => {
            const text = JSON.stringify(this.buildDiagnosePackage(), null, 2);
            try {
                await navigator.clipboard.writeText(text);
                showMessage("已复制脱敏诊断包");
            } catch (e) {
                showMessage("复制失败，请查看日志");
            }
        });
        const aiWrap = document.createElement("div");
        aiWrap.style.display = "flex";
        aiWrap.style.gap = "8px";
        aiWrap.append(aiBtn, copyBtn);

        backupType.addEventListener("change", () => setTimeout(() => this.refreshBackupFields(), 0));
        feishuChannel.addEventListener("change", () => setTimeout(() => this.refreshChannelFields(), 0));
        wecomChannel.addEventListener("change", () => setTimeout(() => this.refreshChannelFields(), 0));

        const syncDirection = document.createElement("select");
        syncDirection.className = "b3-select fn__block";
        const sd1 = document.createElement("option");
        sd1.value = "bidirectional";
        sd1.textContent = "双向同步";
        const sd2 = document.createElement("option");
        sd2.value = "feishu_to_siyuan";
        sd2.textContent = "只从飞书到思源";
        const sd3 = document.createElement("option");
        sd3.value = "siyuan_to_feishu";
        sd3.textContent = "只从思源到飞书";
        syncDirection.append(sd1, sd2, sd3);
        this.elements.syncDirection = syncDirection;

        const catsContainer = document.createElement("div");
        catsContainer.className = "feishu-todo-sync-cats";
        this.elements.catsContainer = catsContainer;

        const lastSync = document.createElement("div");
        lastSync.className = "feishu-todo-sync-hint";
        this.elements.lastSync = lastSync;

        const status = document.createElement("div");
        status.className = "feishu-todo-sync-status";
        this.elements.status = status;

        const historyBtn = document.createElement("button");
        historyBtn.className = "b3-button b3-button--outline";
        historyBtn.textContent = "查看历史日志";
        historyBtn.addEventListener("click", () => {
            this.showLogHistory();
        });

        const logWrap = document.createElement("div");
        logWrap.style.display = "flex";
        logWrap.style.flexDirection = "column";
        logWrap.style.gap = "8px";
        logWrap.append(historyBtn, status);

        const syncBtn = document.createElement("button");
        syncBtn.className = "b3-button b3-button--outline";
        syncBtn.textContent = this.i18n.syncNow;
        syncBtn.addEventListener("click", () => {
            this.syncNow(true);
        });
        this.elements.syncBtn = syncBtn;

        const clearBtn = document.createElement("button");
        clearBtn.className = "b3-button b3-button--outline";
        clearBtn.textContent = "清空飞书待办并重同步";
        clearBtn.addEventListener("click", () => {
            this.clearFeishuMirrorsAndResync();
        });

        this.setting.addItem({ title: "同步渠道", description: "选择需要同步的外部渠道，可多选", direction: "row", createActionElement: () => channelWrap });
        this.setting.addItem({ title: this.i18n.appId, description: this.i18n.appIdDesc, direction: "row", createActionElement: () => appId });
        this.setting.addItem({ title: this.i18n.appSecret, description: this.i18n.appSecretDesc, direction: "row", createActionElement: () => appSecret });
        this.setting.addItem({ title: this.i18n.scope, description: this.i18n.scopeDesc, direction: "row", createActionElement: () => scope });
        this.setting.addItem({ title: this.i18n.oauthPort, description: this.i18n.oauthPortDesc, direction: "row", createActionElement: () => oauthPort });
        this.setting.addItem({ title: this.i18n.authStatus, description: this.i18n.authorizeHint, direction: "row", createActionElement: () => authWrap });
        this.setting.addItem({ title: "企业微信 CorpID", description: "企业微信自建应用的 CorpID", direction: "row", createActionElement: () => wecomCorpId });
        this.setting.addItem({ title: "企业微信 Secret", description: "企业微信自建应用的 Secret（仅保存在本机）", direction: "row", createActionElement: () => wecomSecret });
        this.setting.addItem({ title: "企业微信 AgentID", description: "应用的 AgentID", direction: "row", createActionElement: () => wecomAgentId });
        this.setting.addItem({ title: "企业微信日历 cal_id", description: "插件专用日历的 cal_id，仅同步该日历日程", direction: "row", createActionElement: () => wecomCalId });
        this.setting.addItem({ title: "企业微信参与人 userid", description: "同步日程的参与人 userid", direction: "row", createActionElement: () => wecomUserId });
        this.setting.addItem({ title: "企业微信应用与文档", description: "先在管理后台创建自建应用并开通日程接口权限", direction: "row", createActionElement: () => wecomLinkWrap });
        this.setting.addItem({ title: this.i18n.interval, description: this.i18n.intervalDesc, direction: "row", createActionElement: () => interval });
        this.setting.addItem({ title: "仅同步指定清单", description: "勾选后只同步下面选择的飞书清单；不勾选则同步「我负责的」全部任务", direction: "row", createActionElement: () => restrictWrap });
        this.setting.addItem({ title: "备份方式", description: "清空飞书待办前是否备份到外部存储", direction: "row", createActionElement: () => backupType });
        this.setting.addItem({ title: "备份地址 (WebDAV)", description: "WebDAV 地址，例如 https://dav.example.com/dav/", direction: "row", createActionElement: () => backupUrl });
        this.setting.addItem({ title: "备份用户名", description: "WebDAV 认证用户名，可留空", direction: "row", createActionElement: () => backupUsername });
        this.setting.addItem({ title: "备份密码", description: "WebDAV 认证密码，可留空", direction: "row", createActionElement: () => backupPassword });
        this.setting.addItem({ title: "备份路径", description: "备份文件存放子目录名", direction: "row", createActionElement: () => backupPath });
        this.setting.addItem({ title: "OSS Endpoint", description: "如 https://oss-cn-hangzhou.aliyuncs.com", direction: "row", createActionElement: () => ossEndpoint });
        this.setting.addItem({ title: "OSS Bucket", description: "存储桶名称", direction: "row", createActionElement: () => ossBucket });
        this.setting.addItem({ title: "OSS Region", description: "如 oss-cn-hangzhou", direction: "row", createActionElement: () => ossRegion });
        this.setting.addItem({ title: "OSS AccessKey", direction: "row", createActionElement: () => ossAccessKey });
        this.setting.addItem({ title: "OSS SecretKey", direction: "row", createActionElement: () => ossSecretKey });
        this.setting.addItem({ title: "OSS 路径", description: "备份文件存放前缀", direction: "row", createActionElement: () => ossPath });
        this.setting.addItem({ title: "备份说明", description: "点击「清空飞书待办并重同步」时，会先把现有「飞书待办」任务备份到上述外部存储，再清空并重新同步。", direction: "row", createActionElement: () => { const d = document.createElement("div"); d.className = "feishu-todo-sync-hint"; d.textContent = "备份用于误清空时恢复，请先确认备份成功再清空。"; return d; } });
        this.setting.addItem({ title: "同步方向", description: "控制任务创建/删除/完成状态的同步方向", direction: "row", createActionElement: () => syncDirection });
        this.setting.addItem({ title: this.i18n.categories, description: this.i18n.categoriesDesc, direction: "row", createActionElement: () => catsContainer });
        this.setting.addItem({ title: this.i18n.lastSync, direction: "row", createActionElement: () => lastSync });
        this.setting.addItem({ title: "AI 诊断地址", description: "OpenAI 兼容接口，如 https://api.example.com/v1", direction: "row", createActionElement: () => aiBaseUrl });
        this.setting.addItem({ title: "AI 模型", description: "如 gpt-4o-mini 等", direction: "row", createActionElement: () => aiModel });
        this.setting.addItem({ title: "AI API Key", description: "仅保存在本机，不会写入日志", direction: "row", createActionElement: () => aiApiKey });
        this.setting.addItem({ title: "AI 诊断", description: "只发送脱敏后的设置、错误码和日志，不包含密钥或任务正文", direction: "row", createActionElement: () => aiWrap });
        this.setting.addItem({ title: this.i18n.status, direction: "row", createActionElement: () => logWrap });
        this.setting.addItem({ title: this.i18n.syncNow, actionElement: syncBtn });
        this.setting.addItem({ title: "清空飞书待办", description: "删除「飞书待办」分类下所有任务，并清空映射后重新从飞书导入", actionElement: clearBtn });
    }

    // ---------- 分区设置面板 ----------
    buildSetting() {
        this.setting = new Setting({
            confirmCallback: () => {
                if (this.dlg) this.saveFromDialog();
            },
        });
        const btn = document.createElement("button");
        btn.className = "b3-button b3-button--outline";
        btn.textContent = "打开设置面板";
        btn.addEventListener("click", () => this.openSettingsDialog());
        this.setting.addItem({ title: "设置面板", description: "按分区管理飞书同步配置", actionElement: btn });
    }

    field(label, input) {
        const wrap = document.createElement("div");
        wrap.className = "ftsd-field";
        const l = document.createElement("div");
        l.className = "ftsd-label";
        l.textContent = label;
        const c = document.createElement("div");
        c.className = "ftsd-input";
        if (input) c.append(input);
        wrap.append(l, c);
        return wrap;
    }

    textInput(key, type) {
        const el = document.createElement("input");
        el.className = "b3-text-field fn__block";
        el.type = type || "text";
        const v = this.cfg[key];
        el.value = v === undefined || v === null ? "" : String(v);
        this.dlg[key] = el;
        return el;
    }

    async openSettingsDialog() {
        if (this.settingsDialog) {
            try {
                this.settingsDialog.destroy();
            } catch (e) {
                /* ignore */
            }
            this.settingsDialog = null;
        }
        this.dlg = {};
        try {
            this.categories = await this.readCategories();
        } catch (e) {
            this.categories = this.categories || [];
        }
        if (!this.tasklists || this.tasklists.length === 0) {
            try {
                this.tasklists = await this.listTasklists();
            } catch (e) {
                this.tasklists = this.tasklists || [];
            }
        }
        const dialog = new Dialog({
            title: "飞书待办同步设置",
            content: "<div class='ftsd'><div class='ftsd-nav'></div><div class='ftsd-main'><div class='ftsd-body'></div><div class='ftsd-footer'><button class='b3-button b3-button--outline ftsd-save'>保存设置</button></div></div></div>",
            width: "880px",
        });
        this.settingsDialog = dialog;
        const root = dialog.element;
        const nav = root.querySelector(".ftsd-nav");
        const body = root.querySelector(".ftsd-body");
        const save = root.querySelector(".ftsd-save");
        if (save) save.addEventListener("click", () => this.saveFromDialog());
        const tabs = [
            ["overview", "总览"],
            ["feishu", "飞书授权"],
            ["tasklist", "任务清单"],
            ["sync", "同步范围"],
            ["backup", "备份"],
            ["ai", "AI 诊断"],
            ["log", "日志"],
            ["danger", "危险操作"],
        ];
        this.dlg.tabIds = tabs.map((t) => t[0]);
        this.dlg.panels = {};
        this.dlg.navItems = [];
        for (const [id, name] of tabs) {
            const btn = document.createElement("button");
            btn.className = "ftsd-nav-item";
            btn.textContent = name;
            btn.addEventListener("click", () => this.showDialogTab(id));
            nav.append(btn);
            this.dlg.navItems.push(btn);
            const panel = document.createElement("div");
            panel.className = "ftsd-panel";
            body.append(panel);
            this.dlg.panels[id] = panel;
            this.buildDialogPanel(id, panel);
        }
        this.showDialogTab("overview");
    }

    showDialogTab(id) {
        if (!this.dlg || !this.dlg.panels) return;
        for (const [tid, panel] of Object.entries(this.dlg.panels)) {
            panel.style.display = tid === id ? "" : "none";
        }
        this.dlg.navItems.forEach((el, i) => {
            el.classList.toggle("is-active", this.dlg.tabIds[i] === id);
        });
    }

    buildDialogPanel(id, panel) {
        if (id === "overview") {
            const info = document.createElement("div");
            info.className = "feishu-todo-sync-hint";
            info.textContent = `版本 ${(this.manifest && this.manifest.version) || ""} · 上次同步：${this.cfg.lastSyncAt ? new Date(this.cfg.lastSyncAt).toLocaleString() : "从未"}`;
            const syncBtn = document.createElement("button");
            syncBtn.className = "b3-button b3-button--outline";
            syncBtn.textContent = "立即同步";
            syncBtn.addEventListener("click", () => this.syncNow(true));
            const row = document.createElement("div");
            row.className = "ftsd-row";
            row.append(syncBtn);
            const dockSel = document.createElement("select");
            dockSel.className = "b3-select fn__block";
            for (const pair of [["right", "右侧栏"], ["left", "左侧栏"], ["none", "不显示停靠面板"]]) {
                const o = document.createElement("option");
                o.value = pair[0];
                o.textContent = pair[1];
                dockSel.append(o);
            }
            dockSel.value = this.cfg.dockPosition || "right";
            this.dlg.dockPosition = dockSel;
            panel.append(info, this.field("显示位置", dockSel), row);
            const hint = document.createElement("div");
            hint.className = "feishu-todo-sync-hint";
            hint.textContent = "顶栏入口始终保留；修改停靠位置后需重启思源生效。";
            panel.append(hint);
            return;
        }
        if (id === "feishu") {
            panel.append(this.field("App ID", this.textInput("appId")));
            panel.append(this.field("App Secret", this.textInput("appSecret", "password")));
            panel.append(this.field("Scope", this.textInput("scope")));
            panel.append(this.field("OAuth 回调端口", this.textInput("oauthPort", "number")));
            const row = document.createElement("div");
            row.className = "ftsd-row";
            const status = document.createElement("span");
            status.className = "feishu-todo-sync-hint";
            status.textContent = this.token && this.token.access_token ? "已授权" : "未授权";
            const authBtn = document.createElement("button");
            authBtn.className = "b3-button b3-button--outline";
            authBtn.textContent = "授权飞书";
            authBtn.addEventListener("click", () => this.startOAuth());
            const testBtn = document.createElement("button");
            testBtn.className = "b3-button b3-button--outline";
            testBtn.textContent = "测试连接";
            const feishuResult = document.createElement("div");
            feishuResult.className = "feishu-todo-sync-hint";
            testBtn.addEventListener("click", async () => {
                testBtn.disabled = true;
                feishuResult.textContent = "测试中…";
                try {
                    const m = await this.testFeishu();
                    this.log("连通性: " + m);
                    feishuResult.textContent = m;
                    showMessage(m);
                } catch (e) {
                    feishuResult.textContent = "测试失败: " + e.message;
                } finally {
                    testBtn.disabled = false;
                }
            });
            row.append(status, authBtn, testBtn);
            panel.append(row, feishuResult);
            return;
        }
        if (id === "tasklist") {
            const hint = document.createElement("div");
            hint.className = "feishu-todo-sync-hint";
            hint.textContent = `未勾选任何清单时，默认同步「${this.cfg.feishuDefaultTasklistName || "AI管家·每日待办"}」；可多选。`;
            const list = document.createElement("div");
            list.className = "feishu-todo-sync-cats";
            this.dlg.tasklistList = list;
            const refresh = document.createElement("button");
            refresh.className = "b3-button b3-button--outline";
            refresh.textContent = "刷新清单";
            refresh.addEventListener("click", async () => {
                this.tasklists = await this.listTasklists();
                this.renderDialogTasklists();
            });
            const row = document.createElement("div");
            row.className = "ftsd-row";
            row.append(refresh);
            panel.append(hint, row, list);
            this.renderDialogTasklists();
            return;
        }
        if (id === "sync") {
            const dir = document.createElement("select");
            dir.className = "b3-select fn__block";
            for (const pair of [["bidirectional", "双向同步"], ["feishu_to_siyuan", "只从飞书到思源"], ["siyuan_to_feishu", "只从思源到飞书"]]) {
                const o = document.createElement("option");
                o.value = pair[0];
                o.textContent = pair[1];
                dir.append(o);
            }
            dir.value = this.cfg.syncDirection || "bidirectional";
            this.dlg.syncDirection = dir;
            panel.append(this.field("同步方向", dir));
            panel.append(this.field("同步间隔（秒）", this.textInput("intervalSec", "number")));
            const markDel = document.createElement("input");
            markDel.type = "checkbox";
            markDel.checked = !!this.cfg.markDeleted;
            this.dlg.markDeleted = markDel;
            panel.append(this.field("删除改为标题标注", markDel));
            const cats = document.createElement("div");
            cats.className = "feishu-todo-sync-cats";
            this.dlg.cats = cats;
            this.renderDialogCategories();
            panel.append(this.field("同步到飞书的分类", cats));
            return;
        }
        if (id === "backup") {
            const type = document.createElement("select");
            type.className = "b3-select fn__block";
            for (const pair of [["none", "不备份"], ["webdav", "WebDAV"], ["oss", "OSS / S3"]]) {
                const o = document.createElement("option");
                o.value = pair[0];
                o.textContent = pair[1];
                type.append(o);
            }
            type.value = this.cfg.backupType || "none";
            this.dlg.backupType = type;
            panel.append(this.field("备份方式", type));
            const webdav = document.createElement("div");
            webdav.append(this.field("WebDAV 地址", this.textInput("backupUrl")));
            webdav.append(this.field("WebDAV 用户名", this.textInput("backupUsername")));
            webdav.append(this.field("WebDAV 密码", this.textInput("backupPassword", "password")));
            webdav.append(this.field("WebDAV 路径", this.textInput("backupPath")));
            panel.append(webdav);
            const oss = document.createElement("div");
            oss.append(this.field("OSS Endpoint", this.textInput("ossEndpoint")));
            oss.append(this.field("OSS Bucket", this.textInput("ossBucket")));
            oss.append(this.field("OSS Region", this.textInput("ossRegion")));
            oss.append(this.field("OSS AccessKey", this.textInput("ossAccessKey")));
            oss.append(this.field("OSS SecretKey", this.textInput("ossSecretKey", "password")));
            oss.append(this.field("OSS 路径", this.textInput("ossPath")));
            panel.append(oss);
            const note = document.createElement("div");
            note.className = "feishu-todo-sync-hint";
            note.textContent = "清空前会先备份；备份配置不完整或上传失败会中止清空。";
            panel.append(note);
            const testRow = document.createElement("div");
            testRow.className = "ftsd-row";
            const testResult = document.createElement("div");
            testResult.className = "feishu-todo-sync-hint";
            const testDav = document.createElement("button");
            testDav.className = "b3-button b3-button--outline";
            testDav.textContent = "测试 WebDAV";
            testDav.addEventListener("click", async () => {
                testDav.disabled = true;
                testResult.textContent = "测试中…";
                try {
                    const m = await this.testWebdav();
                    this.log("连通性: " + m);
                    testResult.textContent = m;
                    showMessage(m);
                } catch (e) {
                    testResult.textContent = "测试失败: " + e.message;
                } finally {
                    testDav.disabled = false;
                }
            });
            const testOssBtn = document.createElement("button");
            testOssBtn.className = "b3-button b3-button--outline";
            testOssBtn.textContent = "测试 OSS";
            testOssBtn.addEventListener("click", async () => {
                testOssBtn.disabled = true;
                testResult.textContent = "测试中…";
                try {
                    const m = await this.testOss();
                    this.log("连通性: " + m);
                    testResult.textContent = m;
                    showMessage(m);
                } catch (e) {
                    testResult.textContent = "测试失败: " + e.message;
                } finally {
                    testOssBtn.disabled = false;
                }
            });
            const listBtn = document.createElement("button");
            listBtn.className = "b3-button b3-button--outline";
            listBtn.textContent = "列出 OSS 备份";
            listBtn.addEventListener("click", async () => {
                listBtn.disabled = true;
                testResult.textContent = "查询中…";
                try {
                    const m = await this.listOssBackups();
                    testResult.textContent = m;
                } catch (e) {
                    testResult.textContent = "查询失败: " + e.message;
                } finally {
                    listBtn.disabled = false;
                }
            });
            testRow.append(testDav, testOssBtn, listBtn);
            panel.append(testRow, testResult);
            const refreshShow = () => {
                webdav.style.display = type.value === "webdav" ? "" : "none";
                oss.style.display = type.value === "oss" ? "" : "none";
            };
            type.addEventListener("change", refreshShow);
            refreshShow();
            return;
        }
        if (id === "ai") {
            panel.append(this.field("API 地址", this.textInput("aiBaseUrl")));
            panel.append(this.field("模型", this.textInput("aiModel")));
            panel.append(this.field("API Key", this.textInput("aiApiKey", "password")));
            const row = document.createElement("div");
            row.className = "ftsd-row";
            const askBtn = document.createElement("button");
            askBtn.className = "b3-button b3-button--outline";
            askBtn.textContent = "打开 AI 对话";
            askBtn.addEventListener("click", () => this.openAiChat());
            const copyBtn = document.createElement("button");
            copyBtn.className = "b3-button b3-button--outline";
            copyBtn.textContent = "复制脱敏诊断包";
            copyBtn.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(JSON.stringify(this.buildDiagnosePackage(), null, 2));
                    showMessage("已复制脱敏诊断包");
                } catch (e) {
                    showMessage("复制失败");
                }
            });
            row.append(askBtn, copyBtn);
            const note = document.createElement("div");
            note.className = "feishu-todo-sync-hint";
            note.textContent = "只发送脱敏设置、错误码和日志，不发送密钥或任务正文。";
            panel.append(row, note);
            return;
        }
        if (id === "log") {
            const area = document.createElement("div");
            area.className = "feishu-todo-sync-status";
            area.textContent = (this.logHistory || []).slice(-40).join("\n");
            this.dlg.logArea = area;
            const row = document.createElement("div");
            row.className = "ftsd-row";
            const histBtn = document.createElement("button");
            histBtn.className = "b3-button b3-button--outline";
            histBtn.textContent = "查看完整历史";
            histBtn.addEventListener("click", () => this.showLogHistory());
            row.append(histBtn);
            panel.append(area, row);
            return;
        }
        if (id === "danger") {
            const note = document.createElement("div");
            note.className = "feishu-todo-sync-hint";
            note.textContent = "清空会删除「飞书待办」分类下的镜像任务，并重新从飞书导入。";
            const clearBtn = document.createElement("button");
            clearBtn.className = "b3-button b3-button--outline";
            clearBtn.textContent = "清空飞书待办并重同步";
            const row = document.createElement("div");
            row.className = "ftsd-row";
            row.append(clearBtn);
            clearBtn.addEventListener("click", () => this.clearFeishuMirrorsAndResync());
            panel.append(note, row);
            return;
        }
    }

    renderDialogTasklists() {
        const list = this.dlg && this.dlg.tasklistList;
        if (!list) return;
        list.innerHTML = "";
        const selected = new Set(this.cfg.feishuTasklistGuids || []);
        for (const tl of this.tasklists || []) {
            const label = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = tl.guid || "";
            cb.checked = selected.has(tl.guid);
            const span = document.createElement("span");
            span.textContent = tl.name || tl.guid || "";
            label.append(cb, span);
            list.append(label);
        }
    }

    renderDialogCategories() {
        const cats = this.dlg && this.dlg.cats;
        if (!cats) return;
        cats.innerHTML = "";
        const selected = new Set(this.cfg.syncCategories || []);
        for (const cat of this.categories || []) {
            const label = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = cat.id || "";
            cb.checked = selected.has(cat.id);
            const span = document.createElement("span");
            span.textContent = `${cat.icon || ""} ${cat.name || cat.id}`;
            label.append(cb, span);
            cats.append(label);
        }
    }

    saveFromDialog() {
        const d = this.dlg || {};
        if (d.appId) this.cfg.appId = d.appId.value || "";
        if (d.appSecret) this.cfg.appSecret = d.appSecret.value || "";
        if (d.scope) this.cfg.scope = d.scope.value || DEFAULT_SCOPE;
        if (d.oauthPort) this.cfg.oauthPort = Number(d.oauthPort.value) || 18080;
        if (d.intervalSec) this.cfg.intervalSec = Math.max(10, Number(d.intervalSec.value) || 60);
        if (d.syncDirection) this.cfg.syncDirection = d.syncDirection.value || "bidirectional";
        const guids = [];
        if (d.tasklistList) {
            d.tasklistList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
                if (cb.checked) guids.push(cb.value);
            });
        }
        this.cfg.feishuTasklistGuids = guids;
        const cats = [];
        if (d.cats) {
            d.cats.querySelectorAll("input[type=checkbox]").forEach((cb) => {
                if (cb.checked) cats.push(cb.value);
            });
        }
        this.cfg.syncCategories = cats;
        if (d.backupType) this.cfg.backupType = d.backupType.value || "none";
        if (d.backupUrl) this.cfg.backupUrl = d.backupUrl.value || "";
        if (d.backupUsername) this.cfg.backupUsername = d.backupUsername.value || "";
        if (d.backupPassword) this.cfg.backupPassword = d.backupPassword.value || "";
        if (d.backupPath) this.cfg.backupPath = d.backupPath.value || "feishu-backup";
        if (d.ossEndpoint) this.cfg.ossEndpoint = d.ossEndpoint.value || "";
        if (d.ossBucket) this.cfg.ossBucket = d.ossBucket.value || "";
        if (d.ossRegion) this.cfg.ossRegion = d.ossRegion.value || "";
        if (d.ossAccessKey) this.cfg.ossAccessKey = d.ossAccessKey.value || "";
        if (d.ossSecretKey) this.cfg.ossSecretKey = d.ossSecretKey.value || "";
        if (d.ossPath) this.cfg.ossPath = d.ossPath.value || "feishu-backup";
        if (d.aiBaseUrl) this.cfg.aiBaseUrl = d.aiBaseUrl.value || "";
        if (d.aiModel) this.cfg.aiModel = d.aiModel.value || "";
        if (d.aiApiKey) this.cfg.aiApiKey = d.aiApiKey.value || "";
        if (d.dockPosition) this.cfg.dockPosition = d.dockPosition.value || "right";
        if (d.markDeleted) this.cfg.markDeleted = !!d.markDeleted.checked;
        this.cfg.channels = ["feishu"];
        this.persist().then(() => {
            this.startTimer();
            if (d.logArea) d.logArea.textContent = (this.logHistory || []).slice(-40).join("\n");
            showMessage("设置已保存");
        });
    }

    onSettingSave() {
        this.cfg.appId = (this.elements.appId && this.elements.appId.value) || "";
        this.cfg.appSecret = (this.elements.appSecret && this.elements.appSecret.value) || "";
        this.cfg.scope = (this.elements.scope && this.elements.scope.value) || DEFAULT_SCOPE;
        this.cfg.oauthPort = Number(this.elements.oauthPort && this.elements.oauthPort.value) || 18080;
        this.cfg.intervalSec = Math.max(10, Number(this.elements.interval && this.elements.interval.value) || 60);
        this.cfg.tasklistGuid = (this.elements.tasklistSelect && this.elements.tasklistSelect.value) || "";
        const cats = [];
        if (this.elements.catsContainer) {
            this.elements.catsContainer.querySelectorAll("input[type=checkbox]").forEach((cb) => {
                if (cb.checked) cats.push(cb.value);
            });
        }
        this.cfg.syncCategories = cats;
        this.cfg.restrictToTasklist = !!(this.elements.restrictToTasklist && this.elements.restrictToTasklist.checked);
        this.cfg.backupType = (this.elements.backupType && this.elements.backupType.value) || "none";
        this.cfg.backupUrl = (this.elements.backupUrl && this.elements.backupUrl.value) || "";
        this.cfg.backupUsername = (this.elements.backupUsername && this.elements.backupUsername.value) || "";
        this.cfg.backupPassword = (this.elements.backupPassword && this.elements.backupPassword.value) || "";
        this.cfg.backupPath = (this.elements.backupPath && this.elements.backupPath.value) || "feishu-backup";
        this.cfg.ossEndpoint = (this.elements.ossEndpoint && this.elements.ossEndpoint.value) || "";
        this.cfg.ossBucket = (this.elements.ossBucket && this.elements.ossBucket.value) || "";
        this.cfg.ossRegion = (this.elements.ossRegion && this.elements.ossRegion.value) || "";
        this.cfg.ossAccessKey = (this.elements.ossAccessKey && this.elements.ossAccessKey.value) || "";
        this.cfg.ossSecretKey = (this.elements.ossSecretKey && this.elements.ossSecretKey.value) || "";
        this.cfg.ossPath = (this.elements.ossPath && this.elements.ossPath.value) || "feishu-backup";
        this.cfg.syncDirection = (this.elements.syncDirection && this.elements.syncDirection.value) || "bidirectional";
        const chans = [];
        if (this.elements.feishuChannel && this.elements.feishuChannel.checked) chans.push("feishu");
        if (this.elements.wecomChannel && this.elements.wecomChannel.checked) chans.push("wecom");
        this.cfg.channels = chans;
        this.cfg.wecomCorpId = (this.elements.wecomCorpId && this.elements.wecomCorpId.value) || "";
        this.cfg.wecomSecret = (this.elements.wecomSecret && this.elements.wecomSecret.value) || "";
        this.cfg.wecomAgentId = (this.elements.wecomAgentId && this.elements.wecomAgentId.value) || "";
        this.cfg.wecomCalId = (this.elements.wecomCalId && this.elements.wecomCalId.value) || "";
        this.cfg.wecomUserId = (this.elements.wecomUserId && this.elements.wecomUserId.value) || "";
        this.cfg.aiBaseUrl = (this.elements.aiBaseUrl && this.elements.aiBaseUrl.value) || "";
        this.cfg.aiModel = (this.elements.aiModel && this.elements.aiModel.value) || "";
        this.cfg.aiApiKey = (this.elements.aiApiKey && this.elements.aiApiKey.value) || "";
        this.persist().then(() => {
            this.startTimer();
            showMessage(this.i18n.saveSuccess);
        });
    }

    refreshDynamicSetting() {
        if (this.elements.appId) this.elements.appId.value = this.cfg.appId || "";
        if (this.elements.appSecret) this.elements.appSecret.value = this.cfg.appSecret || "";
        if (this.elements.scope) this.elements.scope.value = this.cfg.scope || DEFAULT_SCOPE;
        if (this.elements.oauthPort) this.elements.oauthPort.value = String(this.cfg.oauthPort || 18080);
        if (this.elements.interval) this.elements.interval.value = String(this.cfg.intervalSec || 60);
        if (this.elements.restrictToTasklist) this.elements.restrictToTasklist.checked = !!this.cfg.restrictToTasklist;
        if (this.elements.backupType) this.elements.backupType.value = this.cfg.backupType || "none";
        if (this.elements.backupUrl) this.elements.backupUrl.value = this.cfg.backupUrl || "";
        if (this.elements.backupUsername) this.elements.backupUsername.value = this.cfg.backupUsername || "";
        if (this.elements.backupPassword) this.elements.backupPassword.value = this.cfg.backupPassword || "";
        if (this.elements.backupPath) this.elements.backupPath.value = this.cfg.backupPath || "feishu-backup";
        if (this.elements.ossEndpoint) this.elements.ossEndpoint.value = this.cfg.ossEndpoint || "";
        if (this.elements.ossBucket) this.elements.ossBucket.value = this.cfg.ossBucket || "";
        if (this.elements.ossRegion) this.elements.ossRegion.value = this.cfg.ossRegion || "";
        if (this.elements.ossAccessKey) this.elements.ossAccessKey.value = this.cfg.ossAccessKey || "";
        if (this.elements.ossSecretKey) this.elements.ossSecretKey.value = this.cfg.ossSecretKey || "";
        if (this.elements.ossPath) this.elements.ossPath.value = this.cfg.ossPath || "feishu-backup";
        if (this.elements.syncDirection) this.elements.syncDirection.value = this.cfg.syncDirection || "bidirectional";
        if (this.elements.feishuChannel) this.elements.feishuChannel.checked = (this.cfg.channels || ["feishu"]).includes("feishu");
        if (this.elements.wecomChannel) this.elements.wecomChannel.checked = (this.cfg.channels || []).includes("wecom");
        if (this.elements.wecomCorpId) this.elements.wecomCorpId.value = this.cfg.wecomCorpId || "";
        if (this.elements.wecomSecret) this.elements.wecomSecret.value = this.cfg.wecomSecret || "";
        if (this.elements.wecomAgentId) this.elements.wecomAgentId.value = this.cfg.wecomAgentId || "";
        if (this.elements.wecomCalId) this.elements.wecomCalId.value = this.cfg.wecomCalId || "";
        if (this.elements.wecomUserId) this.elements.wecomUserId.value = this.cfg.wecomUserId || "";
        if (this.elements.aiBaseUrl) this.elements.aiBaseUrl.value = this.cfg.aiBaseUrl || "";
        if (this.elements.aiModel) this.elements.aiModel.value = this.cfg.aiModel || "";
        if (this.elements.aiApiKey) this.elements.aiApiKey.value = this.cfg.aiApiKey || "";
        this.refreshAuthStatus();
        this.refreshCategories();
        this.loadTasklistsIntoSelect(false);
        this.refreshLastSync();
    }

    toggleSettingRow(el, visible) {
        if (!el) return;
        const row = el.closest(".b3-form__group") || el.closest(".b3-form__item") || el.parentElement;
        if (row) row.style.display = visible ? "" : "none";
    }

    refreshBackupFields() {
        const t = (this.elements.backupType && this.elements.backupType.value) || "none";
        for (const el of [this.elements.backupUrl, this.elements.backupUsername, this.elements.backupPassword, this.elements.backupPath]) {
            this.toggleSettingRow(el, t === "webdav");
        }
        for (const el of [this.elements.ossEndpoint, this.elements.ossBucket, this.elements.ossRegion, this.elements.ossAccessKey, this.elements.ossSecretKey, this.elements.ossPath]) {
            this.toggleSettingRow(el, t === "oss");
        }
    }

    refreshChannelFields() {
        const feishuOn = !!(this.elements.feishuChannel && this.elements.feishuChannel.checked);
        const wecomOn = !!(this.elements.wecomChannel && this.elements.wecomChannel.checked);
        for (const el of [this.elements.appId, this.elements.appSecret, this.elements.scope, this.elements.oauthPort, this.elements.authStatus]) {
            this.toggleSettingRow(el, feishuOn);
        }
        for (const el of [this.elements.wecomCorpId, this.elements.wecomSecret, this.elements.wecomAgentId, this.elements.wecomCalId, this.elements.wecomUserId]) {
            this.toggleSettingRow(el, wecomOn);
        }
    }

    refreshAuthStatus() {
        if (!this.elements.authStatus) return;
        this.elements.authStatus.textContent = this.token && this.token.access_token ? this.i18n.authorized : this.i18n.notAuthorized;
    }

    refreshLastSync() {
        if (!this.elements.lastSync) return;
        this.elements.lastSync.textContent = this.cfg.lastSyncAt ? new Date(this.cfg.lastSyncAt).toLocaleString() : this.i18n.never;
    }

    async refreshCategories() {
        if (!this.elements.catsContainer) return;
        this.categories = await this.readCategories();
        const selected = new Set(this.cfg.syncCategories || []);
        this.elements.catsContainer.innerHTML = "";
        for (const cat of this.categories) {
            const label = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = cat.id || "";
            cb.checked = selected.has(cat.id);
            const span = document.createElement("span");
            span.textContent = `${cat.icon || ""} ${cat.name || cat.id}`;
            label.append(cb, span);
            this.elements.catsContainer.append(label);
        }
    }

    async loadTasklistsIntoSelect(force) {
        if (!this.elements.tasklistSelect) return;
        if (force || this.tasklists.length === 0) {
            try {
                this.tasklists = await this.listTasklists();
            } catch (e) {
                this.log("获取任务清单失败: " + e.message);
            }
        }
        const select = this.elements.tasklistSelect;
        select.innerHTML = "";
        if (this.tasklists.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = this.i18n.noTasklist;
            select.append(opt);
            return;
        }
        for (const tl of this.tasklists) {
            const opt = document.createElement("option");
            opt.value = tl.guid || "";
            opt.textContent = tl.name || tl.guid || "";
            select.append(opt);
        }
        select.value = this.cfg.tasklistGuid || (this.tasklists[0] && this.tasklists[0].guid) || "";
    }

    showLogHistory() {
        const text = this.logHistory.join("\n");
        const dialog = new Dialog({
            title: "同步历史日志",
            content: `<div class="b3-dialog__content"><textarea class="b3-text-field fn__block" style="height:420px;white-space:pre;overflow:auto;" readonly>${escapeHtml(text)}</textarea></div>`,
            width: "760px",
        });
    }

    clearFeishuMirrorsAndResync() {
        confirm("⚠️ 清空飞书待办", "将删除「飞书待办」分类下所有任务，并清空同步映射后重新从飞书导入。确定？", () => {
            this.doClearFeishuMirrors();
        });
    }

    async backupTasksToWebdav(tasks) {
        if (!this.cfg.backupUrl) return false;
        const base = ensureScheme(this.cfg.backupUrl).replace(/\/+$/, "");
        const dir = (this.cfg.backupPath || "feishu-backup").replace(/^\/+|\/+$/g, "");
        const filename = `feishu-backup-${Date.now()}.json`;
        const fullUrl = `${base}/${dir}/${filename}`;
        const headers = { "Content-Type": "application/json" };
        if (this.cfg.backupUsername) {
            headers.Authorization = "Basic " + base64Encode(`${this.cfg.backupUsername}:${this.cfg.backupPassword || ""}`);
        }
        const resp = await fetch(fullUrl, {
            method: "PUT",
            headers,
            body: JSON.stringify(tasks, null, 2),
        });
        const ok = resp.ok || resp.status === 201 || resp.status === 204;
        this.log(ok ? `WebDAV 备份成功: ${fullUrl}` : `WebDAV 备份失败: HTTP ${resp.status} ${fullUrl}`);
        return ok;
    }

    ossSign(method, objectKey, bodyStr, queryStr) {
        const endpoint = ensureScheme(this.cfg.ossEndpoint).replace(/\/+$/, "");
        const host = endpoint.replace("https://", "").replace("http://", "");
        const bucket = this.cfg.ossBucket;
        const region = this.cfg.ossRegion || "us-east-1";
        const service = "s3";
        const now = new Date();
        const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
        const dateStamp = amzDate.slice(0, 8);
        const payloadHash = cryptoNode.createHash("sha256").update(bodyStr || "", "utf8").digest("hex");
        const encodedKey = objectKey.split("/").map((s) => encodeURIComponent(s)).join("/");
        const virtualHosted = host.startsWith(bucket + ".");
        const canonicalUri = virtualHosted ? "/" + encodedKey : "/" + encodeURIComponent(bucket) + "/" + encodedKey;
        const isPut = method === "PUT";
        let canonicalHeaders;
        let signedHeaders;
        if (isPut) {
            canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
            signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
        } else {
            canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
            signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        }
        const canonicalQuery = queryStr || "";
        const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
        const scope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${cryptoNode.createHash("sha256").update(canonicalRequest, "utf8").digest("hex")}`;
        const kDate = hmacSha256("AWS4" + this.cfg.ossSecretKey, dateStamp);
        const kRegion = hmacSha256(kDate, region);
        const kService = hmacSha256(kRegion, service);
        const kSigning = hmacSha256(kService, "aws4_request");
        const signature = hmacSha256(kSigning, stringToSign).toString("hex");
        const authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.ossAccessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        const headers = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, Authorization: authorization };
        if (isPut) headers["Content-Type"] = "application/json";
        let url = virtualHosted ? `${endpoint}/${encodedKey}` : `${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
        if (canonicalQuery) url += "?" + canonicalQuery;
        return { url, headers, virtualHosted };
    }

    async backupTasksToOss(tasks) {
        if (!cryptoNode) {
            this.log("移动端暂不支持 OSS 签名备份，请改用 WebDAV");
            return false;
        }
        if (!this.cfg.ossEndpoint || !this.cfg.ossBucket || !this.cfg.ossAccessKey || !this.cfg.ossSecretKey) {
            this.log("OSS 配置不完整，未执行备份");
            return false;
        }
        const body = JSON.stringify(tasks, null, 2);
        const objectKey = `${(this.cfg.ossPath || "feishu-backup").replace(/^\/+|\/+$/g, "")}/feishu-backup-${Date.now()}.json`;
        const put = this.ossSign("PUT", objectKey, body);
        this.log(`OSS PUT ${put.url} (${tasks.length} 条)`);
        const resp = await fetch(put.url, { method: "PUT", headers: put.headers, body });
        const ok = resp.ok || [200, 201, 204].includes(resp.status);
        if (!ok) {
            const t = await resp.text().catch(() => "");
            this.log(`OSS 备份失败 HTTP ${resp.status}: ${t.slice(0, 300)}`);
            return false;
        }
        const get = this.ossSign("GET", objectKey, "");
        const v = await fetch(get.url, { method: "GET", headers: get.headers }).catch(() => null);
        if (!v || !v.ok) {
            this.log(`OSS 回读校验失败: ${v ? v.status : "无响应"} (${objectKey})`);
            return false;
        }
        this.log(`OSS 回读校验通过: ${objectKey}`);
        this.log(`OSS 备份成功: ${objectKey}`);
        return true;
    }

    syncBackupFromDialog() {
        const d = this.dlg || {};
        if (d.backupType) this.cfg.backupType = d.backupType.value || "none";
        if (d.backupUrl) this.cfg.backupUrl = d.backupUrl.value || "";
        if (d.backupUsername) this.cfg.backupUsername = d.backupUsername.value || "";
        if (d.backupPassword) this.cfg.backupPassword = d.backupPassword.value || "";
        if (d.backupPath) this.cfg.backupPath = d.backupPath.value || "feishu-backup";
        if (d.ossEndpoint) this.cfg.ossEndpoint = d.ossEndpoint.value || "";
        if (d.ossBucket) this.cfg.ossBucket = d.ossBucket.value || "";
        if (d.ossRegion) this.cfg.ossRegion = d.ossRegion.value || "";
        if (d.ossAccessKey) this.cfg.ossAccessKey = d.ossAccessKey.value || "";
        if (d.ossSecretKey) this.cfg.ossSecretKey = d.ossSecretKey.value || "";
        if (d.ossPath) this.cfg.ossPath = d.ossPath.value || "feishu-backup";
    }

    async doClearFeishuMirrors() {
        this.syncBackupFromDialog();
        this.setPaused(true);
        let cleared = false;
        try {
            for (let i = 0; i < 50 && this.running; i++) {
                await new Promise((r) => setTimeout(r, 300));
            }
            if (this.running) {
                throw new Error("当前同步未结束，请稍后再试");
            }
            this.running = true;
            try {
                const reminders = await this.readReminders();
                if (!reminders) throw new Error("读取任务数据失败");
                const targets = Object.entries(reminders).filter(([, st]) => isFeishuCategory(st));
                this.log(`清空目标 ${targets.length} 条，备份方式: ${this.cfg.backupType}`);
                if (this.cfg.backupType !== "none") {
                    if (targets.length === 0) {
                        this.log("没有飞书待办任务可备份，将直接清空映射");
                    } else if (this.cfg.backupType === "webdav") {
                        if (!this.cfg.backupUrl) throw new Error("WebDAV 备份地址未配置，已中止清空");
                        const ok = await this.backupTasksToWebdav(targets.map(([, st]) => st));
                        if (!ok) throw new Error("WebDAV 备份失败，已中止清空");
                        this.log(`已备份 ${targets.length} 条任务到 WebDAV`);
                    } else if (this.cfg.backupType === "oss") {
                        if (!this.cfg.ossBucket || !this.cfg.ossEndpoint || !this.cfg.ossAccessKey || !this.cfg.ossSecretKey) {
                            throw new Error("OSS 备份配置不完整，已中止清空");
                        }
                        const ok = await this.backupTasksToOss(targets.map(([, st]) => st));
                        if (!ok) throw new Error("OSS 备份失败，已中止清空");
                        this.log(`已备份 ${targets.length} 条任务到 OSS`);
                    } else {
                        throw new Error("未知备份方式: " + this.cfg.backupType);
                    }
                }
                for (const [sid] of targets) {
                    delete reminders[sid];
                    delete this.mapping[sid];
                }
                await this.writeReminders(reminders);
                this.tombstones = {};
                await this.persist();
                cleared = true;
                this.log(`已清空 ${targets.length} 条飞书待办镜像任务`);
                showMessage(`已清空 ${targets.length} 条，开始重新同步`);
            } finally {
                this.running = false;
            }
        } catch (e) {
            this.log("清空失败: " + e.message);
            showMessage("清空失败: " + e.message);
        }
        if (cleared) {
            await this.syncNow(true);
        }
        this.setPaused(false);
    }

    openSetting() {
        this.openSettingsDialog();
    }
};
