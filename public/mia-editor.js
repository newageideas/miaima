/* Mia Page Editor: lets the Mia chat bot preview, apply, undo, persist and export page edits.
   Edits are stored in localStorage (this browser only) and re-applied on load. */
(function () {
  "use strict";
  var KEY = "mia_page_edits_v1";
  var SKIP = "#geminiChatPanel, #cardsList, #kanbanBoard, script, style, canvas, .toast, [data-mia-skip]";
  var SEL = "h1,h2,h3,h4,p,label,button,a,img,section,header,.wordmark span,.tagline,.metric-label,.metric-val,.banner-text,.form-panel-title,.pill-tag";
  var els = {}, history = [], edits = [];
  var STYLE_OK = /^(color|background|background-color|font-size|font-weight|font-family|letter-spacing|text-transform|border-radius|padding|text-align|opacity|border-color|line-height)$/;

  var css = document.createElement("style");
  css.textContent = ".mia-edit-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 12px;font-size:11px;color:#94a3b8;border-top:1px solid #222938}" +
    ".mia-edit-bar strong{color:#c7d2fe}.mia-preview{margin-top:8px;border:1px dashed #6366f1;border-radius:10px;padding:8px;font-size:12px;background:#6366f114}" +
    ".mia-preview ul{margin:4px 0 8px 16px;color:#cbd5e1}.mia-preview .row{display:flex;gap:6px;flex-wrap:wrap}" +
    ".mia-preview button{background:#6366f1;color:#fff;border:0;border-radius:8px;padding:6px 10px;font-weight:600;cursor:pointer;min-height:32px}" +
    ".mia-preview button.ghost{background:transparent;border:1px solid #475569;color:#cbd5e1}" +
    ".mia-flash{outline:2px solid #38bdf8!important;outline-offset:2px;transition:outline .3s}.mia-block{margin:16px 0;padding:14px 16px;border:1px solid #333d52;border-radius:12px;background:#12151c}" +
    ".mia-block h3{font-size:15px;margin-bottom:4px}.mia-block p{color:#94a3b8;font-size:13px;white-space:pre-wrap}";
  document.head.appendChild(css);

  function index() {
    var n = 0;
    document.querySelectorAll(SEL).forEach(function (el) {
      if (el.closest(SKIP) || el.closest(".pick-modal-overlay,.teleprompter-overlay,.polish-modal-overlay")) return;
      if (el.dataset.miaId) { els[el.dataset.miaId] = el; return; }
      var id = "m" + (n++);
      el.dataset.miaId = id; els[id] = el;
    });
  }
  function leafText(el) {
    var t = el.children.length && el.tagName !== "BUTTON" && el.tagName !== "A" ? "" : (el.textContent || "");
    return t.replace(/\s+/g, " ").trim().slice(0, 90);
  }
  function context() {
    var list = [];
    Object.keys(els).forEach(function (id) {
      var el = els[id]; if (!el.isConnected) return;
      var item = { id: id, tag: el.tagName.toLowerCase() };
      var t = leafText(el); if (t) item.text = t;
      if (el.tagName === "IMG") item.src = (el.getAttribute("src") || "").slice(0, 80);
      if (el.id) item.domId = el.id;
      if (el.className && typeof el.className === "string") item.cls = el.className.split(" ").slice(0, 2).join(" ");
      if (el.style.display === "none") item.hidden = true;
      if (item.text || item.tag === "img" || item.tag === "section" || item.tag === "header") list.push(item);
    });
    var vars = {}, cs = getComputedStyle(document.documentElement);
    ["--bg-main", "--bg-card", "--bg-surface", "--text-primary", "--text-secondary", "--accent-cyan", "--accent-indigo", "--accent-purple", "--border-subtle"].forEach(function (v) { vars[v] = cs.getPropertyValue(v).trim(); });
    return { page: "MAI / IMA Trend Picker", elements: list.slice(0, 220), cssVars: vars, editsApplied: edits.length };
  }

  function snapshot(a) {
    var el = a.target && els[a.target];
    switch (a.type) {
      case "set_text": return el && { el: el, text: el.textContent };
      case "set_style": return el && { el: el, prop: a.property, val: el.style.getPropertyValue(a.property) };
      case "hide": case "show": return el && { el: el, prop: "display", val: el.style.getPropertyValue("display") };
      case "set_image": return el && { el: el, src: el.getAttribute("src") };
      case "set_css_var": return { root: true, name: a.name, val: document.documentElement.style.getPropertyValue(a.name) };
      default: return {};
    }
  }
  function validate(a) {
    if (!a || typeof a !== "object") return false;
    if (["set_text", "set_style", "hide", "show", "set_image"].indexOf(a.type) >= 0 && !els[a.target]) return false;
    if (a.type === "set_text") return typeof a.value === "string" && a.value.length < 500;
    if (a.type === "set_style") return STYLE_OK.test(a.property || "") && typeof a.value === "string" && !/url\(|expression|javascript:/i.test(a.value);
    if (a.type === "set_css_var") return /^--[a-z0-9-]+$/i.test(a.name || "") && typeof a.value === "string" && !/url\(|javascript:/i.test(a.value);
    if (a.type === "set_image") return els[a.target].tagName === "IMG" && /^https:\/\//.test(a.src || "");
    if (a.type === "insert_block") return !!els[a.after] && typeof a.heading === "string";
    if (a.type === "add_idea") return a.idea && typeof a.idea === "object";
    if (a.type === "insert_code") return !!els[a.after] && typeof a.code === "string" && a.code.length > 0;
    return a.type === "hide" || a.type === "show" || a.type === "reset_edits";
  }
  function run(a) {
    var el = a.target && els[a.target];
    switch (a.type) {
      case "set_text":
        if (el.children.length && el.tagName !== "BUTTON") {
          // keep child markup: replace the first meaningful text node, otherwise the whole text
          var tn = Array.prototype.find.call(el.childNodes, function (c) { return c.nodeType === 3 && c.textContent.trim(); });
          if (tn) { tn.textContent = a.value; break; }
        }
        el.textContent = a.value; break;
      case "set_style": el.style.setProperty(a.property, a.value); break;
      case "hide": el.style.setProperty("display", "none"); break;
      case "show": el.style.removeProperty("display"); break;
      case "set_image": el.setAttribute("src", a.src); break;
      case "set_css_var": document.documentElement.style.setProperty(a.name, a.value); break;
      case "insert_block": {
        var b = document.createElement("div"); b.className = "mia-block"; b.dataset.miaBlock = "1";
        var h = document.createElement("h3"); h.textContent = a.heading;
        var p = document.createElement("p"); p.textContent = a.body || "";
        b.appendChild(h); b.appendChild(p); els[a.after].insertAdjacentElement("afterend", b);
        a._node = b; break;
      }
      case "insert_code": a._node = buildCodeNode(a.code); els[a.after].insertAdjacentElement(a.position === "before" ? "beforebegin" : "afterend", a._node); break;
    }
    if (el) { el.classList.add("mia-flash"); setTimeout(function () { el.classList.remove("mia-flash"); }, 1200); }
  }
  function revert(a, snap) {
    if (a.type === "insert_block" || a.type === "insert_code") { if (a._node) a._node.remove(); return; }
    if (!snap) return;
    if (snap.root) { snap.val ? document.documentElement.style.setProperty(snap.name, snap.val) : document.documentElement.style.removeProperty(snap.name); return; }
    if ("text" in snap) snap.el.textContent = snap.text;
    if ("prop" in snap) snap.val ? snap.el.style.setProperty(snap.prop, snap.val) : snap.el.style.removeProperty(snap.prop);
    if ("src" in snap) snap.src == null ? snap.el.removeAttribute("src") : snap.el.setAttribute("src", snap.src);
  }

  function prefillIdea(idea) {
    var map = { title: "titleInput", niche: "nicheInput", format: "formatInput", description: "descriptionInput", hook: "hookInput", dialogueOutline: "dialogueOutlineInput", videoPrompt: "videoPromptInput", characters: "charactersInput", cameraNotes: "cameraNotesInput", backgroundSetting: "backgroundSettingInput", estimatedViews: "estimatedViewsInput" };
    var panel = document.getElementById("newIdeaFormPanel");
    if (panel && !panel.classList.contains("active")) { var t = document.getElementById("toggleFormBtn"); t && t.click(); }
    Object.keys(map).forEach(function (k) { var f = document.getElementById(map[k]); if (f && idea[k] != null) f.value = idea[k]; });
    panel && panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function applyBatch(actions, persist) {
    var batch = [];
    actions.forEach(function (a) {
      if (a.type === "reset_edits") { reset(); return; }
      if (a.type === "add_idea") { prefillIdea(a.idea); return; }
      var snap = snapshot(a); run(a); batch.push({ a: a, snap: snap });
      if (persist) edits.push(strip(a));
    });
    if (batch.length) history.push(batch);
    if (persist) save();
    ui();
    return batch.length;
  }
  function strip(a) { var c = {}; Object.keys(a).forEach(function (k) { if (k[0] !== "_") c[k] = a[k]; }); return c; }
  function undo() {
    var batch = history.pop(); if (!batch) return;
    for (var i = batch.length - 1; i >= 0; i--) revert(batch[i].a, batch[i].snap);
    edits.splice(Math.max(0, edits.length - batch.length), batch.length);
    save(); ui();
  }
  function reset() {
    while (history.length) undo();
    edits = []; save();
    document.querySelectorAll("[data-mia-block],[data-mia-code]").forEach(function (n) { n.remove(); });
    ui();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(edits)); } catch (e) {} }
  function ui() {
    var c = document.getElementById("miaEditCount"); if (c) c.textContent = String(edits.length);
    var u = document.getElementById("miaUndoBtn"); if (u) u.disabled = !history.length;
  }
  function toast(m) { if (typeof window.showToast === "function") window.showToast(m); }

  function describe(a) {
    var el = a.target && els[a.target], name = el ? ('"' + (leafText(el) || el.tagName.toLowerCase()).slice(0, 30) + '"') : "";
    switch (a.type) {
      case "set_text": return "Change text " + name + " → \u201c" + a.value.slice(0, 60) + "\u201d";
      case "set_style": return "Style " + name + ": " + a.property + " = " + a.value;
      case "set_css_var": return "Theme " + a.name + " = " + a.value;
      case "hide": return "Hide " + name;
      case "show": return "Show " + name;
      case "set_image": return "Swap image " + name;
      case "insert_code": return "Insert pasted code " + (a.position || "after") + " " + name;
      case "insert_block": return "Add block \u201c" + a.heading.slice(0, 40) + "\u201d";
      case "add_idea": return "Draft new trend idea \u201c" + ((a.idea && a.idea.title) || "") + "\u201d (you review & save)";
      case "reset_edits": return "Reset all page edits";
    }
    return a.type;
  }

  function preview(actions, msgEl) {
    var ok = actions.filter(validate), bad = actions.length - ok.length;
    if (!ok.length) { if (bad) toast("Mia suggested an edit I couldn't map to the page — try naming the element."); return; }
    var pv = applyBatch(ok, false); // live preview, not yet saved
    var box = document.createElement("div"); box.className = "mia-preview";
    var title = document.createElement("div"); title.textContent = "👀 Previewing " + ok.length + " edit" + (ok.length > 1 ? "s" : "") + (bad ? " (" + bad + " skipped)" : "") + ":";
    var ul = document.createElement("ul");
    ok.forEach(function (a) { var li = document.createElement("li"); li.textContent = describe(a); ul.appendChild(li); });
    var row = document.createElement("div"); row.className = "row";
    var keep = document.createElement("button"); keep.textContent = "✓ Keep";
    var drop = document.createElement("button"); drop.className = "ghost"; drop.textContent = "✕ Discard";
    keep.onclick = function () {
      ok.forEach(function (a) { if (a.type !== "add_idea" && a.type !== "reset_edits") edits.push(strip(a)); });
      save(); ui(); box.textContent = "✅ Saved on this browser. Use ↶ Undo anytime."; toast("Page edits saved ✨");
    };
    drop.onclick = function () { if (pv) undo(); box.textContent = "↩️ Discarded."; };
    row.appendChild(keep); row.appendChild(drop);
    box.appendChild(title); box.appendChild(ul); box.appendChild(row);
    (msgEl || document.getElementById("chatMessages")).appendChild(box);
    var cm = document.getElementById("chatMessages"); if (cm) cm.scrollTop = cm.scrollHeight;
  }

  function exportEdits() {
    var blob = new Blob([JSON.stringify({ site: location.host, exportedAt: new Date().toISOString(), edits: edits }, null, 2)], { type: "application/json" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "mia-page-edits.json"; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function init() {
    index();
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(saved) && saved.length) {
        var ok = saved.filter(validate); history = []; edits = [];
        ok.forEach(function (a) { run(a); edits.push(strip(a)); });
      }
    } catch (e) {}
    ui();
    var nm = location.hash.match(/note=([\w-]+)/);
    if (nm) {
      fetch("/api/notes").then(function (r) { return r.json(); }).then(function (d) {
        var n = (d.notes || []).find(function (x) { return x.id === nm[1]; });
        if (n) { openPaste(n.code); toast("Loaded “" + n.title + "” from Code notes"); } else toast("Couldn't load that code note (it may have been deleted).");
        window.history.replaceState(null, "", location.pathname);
      }).catch(function () {});
    }
    var u = document.getElementById("miaUndoBtn"); u && u.addEventListener("click", undo);
    var x = document.getElementById("miaExportBtn"); x && x.addEventListener("click", exportEdits);
    var pb = document.getElementById("miaPasteBtn"); pb && pb.addEventListener("click", openPaste);
    var r = document.getElementById("miaResetBtn"); r && r.addEventListener("click", function () {
      if (!edits.length && !history.length) { toast("No page edits to reset."); return; }
      if (confirm("Reset all Mia page edits on this browser?")) { reset(); location.reload(); }
    });
  }
  // reset() after reload needs saved edits cleared even if history is empty
  var _reset = reset; reset = function () { _reset(); try { localStorage.removeItem(KEY); } catch (e) {} };


  // ======================= PASTE CODE MODE =======================
  function esc(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function highlight(code) {
    // tiny tokenizer: comments, strings, tags/attrs, keywords — rendered as escaped text only
    var out = "", re = /(<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(<\/?[a-zA-Z][\w-]*|\/?>)|\b(function|const|let|var|return|if|else|for|while|class|import|export|new|async|await|fetch)\b/g, last = 0, m;
    var lim = code.length > 200000 ? code.slice(0, 200000) : code;
    while ((m = re.exec(lim))) {
      out += esc(lim.slice(last, m.index));
      var c = m[1] ? "#64748b" : m[2] ? "#fbbf24" : m[3] ? "#38bdf8" : "#c084fc";
      out += '<span style="color:' + c + '">' + esc(m[0]) + "</span>"; last = re.lastIndex;
    }
    return out + esc(lim.slice(last)) + (lim !== code ? "\n… (view truncated, full code kept)" : "");
  }
  function scan(code) {
    var r = [], c = code;
    var hosts = {}; (c.match(/https?:\/\/[^\s"'`)<>]+/g) || []).forEach(function (u) { try { hosts[new URL(u).host] = 1; } catch (e) {} });
    var hs = Object.keys(hosts).filter(function (h) { return !/fonts\.(googleapis|gstatic)\.com$/.test(h); });
    if (/<script[\s>]/i.test(c) || /\bon[a-z]+\s*=/i.test(c)) r.push("Contains JavaScript (runs only in a locked sandbox, never on the main page)");
    if (hs.length) r.push("Talks to external sites: " + hs.slice(0, 6).join(", "));
    if (/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/.test(c)) r.push("Makes network requests");
    if (/document\.cookie|localStorage|sessionStorage|indexedDB/.test(c)) r.push("Reads/writes browser storage or cookies");
    if (/<form[\s\S]*?(action=|password)|type=["']?password|addEventListener\(\s*["']key/i.test(c)) r.push("Collects typed input / forms / keystrokes");
    if (/\beval\s*\(|new Function\s*\(|atob\s*\(|\\x[0-9a-f]{2}|fromCharCode/i.test(c)) r.push("Obfuscation or dynamic code (eval/atob) — treat as suspicious");
    if (/window\.location\s*=|location\.(href|replace)|top\.location/.test(c)) r.push("Redirects the page");
    if (/coinhive|cryptonight|miner|\bwasm\b/i.test(c)) r.push("Possible crypto-miner");
    if (/<iframe/i.test(c)) r.push("Embeds another page (iframe)");
    return r;
  }
  function hasScript(code) { return /<script[\s>]|\bon[a-z]+\s*=|javascript:/i.test(code); }
  function sanitize(code) {
    var t = document.createElement("template"); t.innerHTML = code;
    t.content.querySelectorAll("script,iframe,object,embed,base,meta,link[rel=import]").forEach(function (n) { n.remove(); });
    t.content.querySelectorAll("*").forEach(function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (at) {
        if (/^on/i.test(at.name) || /^\s*javascript:/i.test(at.value)) n.removeAttribute(at.name);
      });
    });
    return t.content;
  }
  function frameFor(code, allowScripts) {
    var f = document.createElement("iframe");
    f.setAttribute("sandbox", allowScripts ? "allow-scripts" : ""); // never allow-same-origin: no access to this site, cookies or storage
    f.setAttribute("referrerpolicy", "no-referrer");
    f.style.cssText = "width:100%;min-height:220px;border:1px solid #333d52;border-radius:12px;background:#fff";
    f.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\' https:; font-src https: data:; script-src \'unsafe-inline\'">' + code;
    return f;
  }
  // Script-free code is inserted as sanitized HTML (styles scoped in a shadow root);
  // code with JavaScript stays inside a sandboxed iframe with no network access and no access to the site.
  function buildCodeNode(code) {
    var wrap = document.createElement("div"); wrap.dataset.miaCode = "1"; wrap.style.margin = "16px 0";
    if (hasScript(code)) { wrap.appendChild(frameFor(code, true)); }
    else { var root = wrap.attachShadow({ mode: "open" }); root.appendChild(sanitize(code)); }
    return wrap;
  }
  function targets() {
    return Object.keys(els).filter(function (id) { var e = els[id]; return e.isConnected && /^(SECTION|HEADER|H1|H2|H3|MAIN|DIV)$/.test(e.tagName) || (e.classList && e.classList.contains("tagline")); })
      .map(function (id) { var e = els[id]; return { id: id, label: (e.id ? "#" + e.id + " " : "") + e.tagName.toLowerCase() + " " + (leafText(e) || (e.className || "")).toString().slice(0, 40) }; });
  }
  function openPaste(prefill) {
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:10000;background:#000b;display:flex;align-items:center;justify-content:center;padding:10px";
    ov.innerHTML = '<div style="background:#12151c;border:1px solid #333d52;border-radius:14px;width:min(900px,100%);max-height:94vh;overflow:auto;padding:14px;color:#f1f5f9;font-size:13px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong>📋 Paste code from a friend</strong><button data-x style="background:none;border:0;color:#94a3b8;font-size:18px;cursor:pointer" aria-label="Close">✕</button></div>' +
      '<textarea data-code spellcheck="false" placeholder="Paste HTML / CSS / JS here — any length" style="width:100%;min-height:180px;background:#0a0c10;color:#e2e8f0;border:1px solid #333d52;border-radius:10px;padding:10px;font:12px JetBrains Mono,monospace;resize:vertical"></textarea>' +
      '<div data-stats style="color:#64748b;margin:4px 0"></div>' +
      '<pre data-hl style="display:none;max-height:220px;overflow:auto;background:#0a0c10;border:1px solid #222938;border-radius:10px;padding:10px;font:12px JetBrains Mono,monospace;white-space:pre-wrap;word-break:break-word"></pre>' +
      '<div data-risk style="margin:8px 0"></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0"><label>Insert <select data-pos style="background:#191e2b;color:#fff;border:1px solid #333d52;border-radius:6px;padding:4px"><option value="after">after</option><option value="before">before</option></select></label>' +
      '<select data-target style="flex:1;min-width:160px;background:#191e2b;color:#fff;border:1px solid #333d52;border-radius:6px;padding:4px"></select></div>' +
      '<div data-explain style="white-space:pre-wrap;color:#cbd5e1;margin:6px 0"></div><div data-prev></div>' +
      '<div class="mia-preview" style="border:0;background:none;padding:0"><div class="row">' +
      '<button data-ask>🧠 Explain with Mia</button><button data-pv class="ghost">👀 Preview (sandbox)</button><label style="display:flex;gap:4px;align-items:center;color:#94a3b8"><input type="checkbox" data-js> run JS in preview</label>' +
      '<button data-add>➕ Add to page</button><button data-x class="ghost">Cancel</button></div></div></div>';
    document.body.appendChild(ov);
    var q = function (s) { return ov.querySelector(s); };
    var ta = q("[data-code]"), sel = q("[data-target]");
    targets().forEach(function (t) { var o = document.createElement("option"); o.value = t.id; o.textContent = t.label; sel.appendChild(o); });
    var cards = Object.keys(els).find(function (id) { return els[id].id === "metricsBar"; }); if (cards) sel.value = cards;
    var close = function () { ov.remove(); };
    ov.querySelectorAll("[data-x]").forEach(function (b) { b.onclick = close; });
    var refresh = function () {
      var c = ta.value, lines = c ? c.split("\n").length : 0;
      q("[data-stats]").textContent = c ? (lines + " lines · " + c.length.toLocaleString() + " chars") : "";
      var hl = q("[data-hl]"); hl.style.display = c ? "block" : "none"; hl.innerHTML = c ? highlight(c) : "";
      var r = scan(c);
      q("[data-risk]").innerHTML = r.length ? '<div style="border:1px solid #f59e0b66;background:#f59e0b1a;border-radius:10px;padding:8px;color:#fbbf24">⚠️ Check before adding:<ul style="margin:4px 0 0 16px">' + r.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>" : (c ? '<div style="color:#34d399">✓ No scripts, trackers or external calls found.</div>' : "");
    };
    var t; ta.addEventListener("input", function () { clearTimeout(t); t = setTimeout(refresh, 250); });
    q("[data-pv]").onclick = function () {
      if (!ta.value.trim()) return; var box = q("[data-prev]"); box.innerHTML = "";
      box.appendChild(frameFor(ta.value, q("[data-js]").checked));
    };
    q("[data-ask]").onclick = function () {
      var c = ta.value; if (!c.trim()) return; var ex = q("[data-explain]"); ex.textContent = "Mia is reading the code…";
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 45000);
      fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ messages: [{ role: "user", content: "A friend sent me this code. What does it do, is it safe, and where should it go on my page?" }], code: c, risks: scan(c), pageContext: context() }) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); })
        .then(function (d) {
          ex.textContent = "🧠 " + (d.reply || "");
          (d.actions || []).forEach(function (a) { if (a.type === "suggest_insert" && els[a.after]) { if (![].some.call(sel.options, function (o) { return o.value === a.after; })) { var o = document.createElement("option"); o.value = a.after; o.textContent = a.after + " (Mia's pick)"; sel.appendChild(o); } sel.value = a.after; q("[data-pos]").value = a.position === "before" ? "before" : "after"; } });
        })
        .catch(function (e) { ex.textContent = "⚠️ Mia couldn't review it right now (" + (e.name === "AbortError" ? "timed out" : e.message) + "). You can still Preview safely."; })
        .finally(function () { clearTimeout(tm); });
    };
    q("[data-add]").onclick = function () {
      var c = ta.value; if (!c.trim()) return;
      var r = scan(c);
      if (r.length && !confirm("This code has warnings:\n- " + r.join("\n- ") + "\n\nAdd it anyway? (JavaScript stays sandboxed)")) return;
      var a = { type: "insert_code", after: sel.value, position: q("[data-pos]").value, code: c };
      if (!validate(a)) { toast("Pick where to insert it first."); return; }
      applyBatch([a], true); close(); toast("Code added ✨ — ↶ Undo or ⬇ Export anytime");
      var n = a._node; n && n.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    if (typeof prefill === "string") { ta.value = prefill; refresh(); }
    ta.focus();
  }
  function saveSafe() { try { localStorage.setItem(KEY, JSON.stringify(edits)); } catch (e) { toast("Browser storage is full — use ⬇ Export to keep this code."); } }
  save = saveSafe;
  window.MiaEditor = { context: context, preview: preview, undo: undo, reset: reset, export: exportEdits, paste: openPaste, scan: scan, apply: function (a) { return applyBatch(a.filter(validate), true); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
