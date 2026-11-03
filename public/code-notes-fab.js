/* Floating "Code notes" button (bottom-left, so it never covers Mia's chat bubble at bottom-right). */
(function () {
  if (window.__codeNotesFab || /[?&]embed=1/.test(location.search)) return; window.__codeNotesFab = 1;
  var s = document.createElement("style");
  s.textContent = ".cn-fab{position:fixed;left:16px;bottom:calc(20px + env(safe-area-inset-bottom));z-index:9998;display:flex;align-items:center;gap:6px;padding:12px 16px;min-height:48px;border-radius:999px;border:1px solid #a855f799;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;font:700 14px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 0 18px #a855f780;animation:cnPulse 2.6s ease-in-out infinite}" +
    ".cn-fab:focus-visible{outline:3px solid #38bdf8;outline-offset:3px}@keyframes cnPulse{0%,100%{box-shadow:0 0 10px #a855f760}50%{box-shadow:0 0 26px #a855f7cc,0 0 4px #38bdf8}}" +
    "@media (prefers-reduced-motion: reduce){.cn-fab{animation:none}}" +
    ".cn-ov{position:fixed;inset:0;z-index:10001;background:#000c;display:flex;align-items:center;justify-content:center}" +
    ".cn-ov iframe{width:min(860px,96vw);height:92vh;border:1px solid #333d52;border-radius:16px;background:#0a0c10}" +
    "@media (max-width:640px){.cn-ov iframe{width:100vw;height:100%;border:0;border-radius:0}.cn-fab span.t{display:none}}";
  document.head.appendChild(s);
  var b = document.createElement("button");
  b.className = "cn-fab"; b.type = "button"; b.setAttribute("aria-label", "Code notes: paste code for Ima");
  b.innerHTML = '📝 <span class="t">Paste code for Ima</span>';
  b.onclick = function () {
    if (/\/notes(\.html)?$/.test(location.pathname)) { var c = document.getElementById("code"); if (c) { c.scrollIntoView({ behavior: "smooth", block: "center" }); c.focus(); } return; }
    var ov = document.createElement("div"); ov.className = "cn-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "Code notes");
    var f = document.createElement("iframe"); f.src = "/notes.html?embed=1"; f.title = "Code notes";
    ov.appendChild(f); document.body.appendChild(ov); document.body.style.overflow = "hidden";
    var close = function () { ov.remove(); document.body.style.overflow = ""; window.removeEventListener("message", onMsg); document.removeEventListener("keydown", onKey); b.focus(); };
    var onMsg = function (e) { if (e.origin !== location.origin) return; if (e.data === "cn-close") close(); if (e.data && e.data.cnSendToMia) { close(); location.hash = "note=" + e.data.cnSendToMia; location.reload(); } };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    window.addEventListener("message", onMsg); document.addEventListener("keydown", onKey);
  };
  document.body.appendChild(b);
})();
