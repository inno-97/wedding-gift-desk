import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  initializeFirestore, memoryLocalCache,
  connectFirestoreEmulator, doc, collection, setDoc, updateDoc, onSnapshot,
  serverTimestamp, writeBatch, deleteField,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ───────────────────────── Firebase ─────────────────────────
const isLocal = /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);
const app = initializeApp(isLocal ? { projectId: "demo-wedding", apiKey: "demo" } : firebaseConfig);
// 기기에 명부를 남기지 않도록 메모리 캐시만 사용 (탭을 닫으면 사라짐)
const db = initializeFirestore(app, { localCache: memoryLocalCache() });
// 이전 버전이 남긴 기기 저장 캐시(IndexedDB) 정리
try {
  indexedDB.databases?.().then((dbs) => dbs.forEach((d) => {
    if (d.name && d.name.startsWith("firestore/")) indexedDB.deleteDatabase(d.name);
  })).catch(() => {});
} catch {}
if (isLocal) connectFirestoreEmulator(db, location.hostname, 8080);

// ───────────────────────── 유틸 ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => (n == null ? "" : n.toLocaleString("ko-KR"));
const manwon = (n) => {
  if (n == null) return "";
  if (n % 10000 === 0) return `${(n / 10000).toLocaleString("ko-KR")}만`;
  return `${won(n)}원`;
};
const parseAmount = (s) => {
  const digits = String(s ?? "").replace(/[^0-9]/g, "");
  return digits === "" ? null : Math.min(parseInt(digits, 10), 100000000);
};
const clean = (s) => {
  const t = String(s ?? "").trim();
  return t === "" ? null : t;
};
// 신규 등록 시 식권 기본값 (장부 설정에서 바꿀 수 있음). 금액은 기본값 없음(마감 때 입력).
const DEFAULT_TICKETS = 1;
// 관계 빠른 선택
const RELATIONS = ["친구", "직장", "친척", "가족", "학교", "지인", "부 지인", "모 지인"];
const normName = (n) => String(n ?? "").replace(/\s+/g, "").toLowerCase();

// 숫자 전용 입력: 숫자 외 문자 제거, 최대값 제한, (선택) 천 단위 콤마
const LIMITS = { no: 99999, tickets: 100, ticketsInitial: 10000, defaultTickets: 20, amount: 100000000 };
function digitsInput(el, { max, comma = false }) {
  el.type = "text";
  el.inputMode = "numeric";
  el.autocomplete = "off";
  if (!comma) el.pattern = "[0-9]*";
  const fmt = () => {
    const d = el.value.replace(/[^0-9]/g, "");
    if (d === "") { el.value = ""; return; }
    // 금액 칸에 "15만"처럼 쓰면 150,000원으로 해석
    const unit = comma && /만/.test(el.value) ? 10000 : 1;
    const v = Math.min(parseInt(d, 10) * unit, max);
    el.value = comma ? won(v) : String(v);
  };
  el.addEventListener("input", fmt);
  el.addEventListener("blur", fmt);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let toastTimer;
function toast(msg, kind = "ok", ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const RECENT_KEY = "giftdesk.recent";
function readRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function rememberLedger(id, title) {
  try {
    const list = readRecent().filter((r) => r.id !== id);
    list.unshift({ id, title });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {}
}

// ───────────────────────── 라우팅 ─────────────────────────
const m = location.pathname.match(/^\/l\/([0-9a-f-]{36})\/?$/i);
const ledgerId = m ? m[1].toLowerCase() : null;
if (ledgerId && UUID_RE.test(ledgerId)) renderLedger(ledgerId);
else if (ledgerId) renderMessage("주소가 올바르지 않아요", "받은 링크 전체를 다시 확인해 주세요.");
else renderHome();

function renderMessage(title, body) {
  $("#app").innerHTML = `<main class="center"><h1>${esc(title)}</h1><p class="muted">${esc(body)}</p><a class="btn" href="/">처음으로</a></main>`;
}

// ───────────────────────── 홈: 장부 만들기 ─────────────────────────
function renderHome() {
  const recent = readRecent();
  $("#app").innerHTML = `
    <main class="home">
      <p class="eyebrow">WEDDING GIFT DESK</p>
      <h1>축의금 장부 만들기</h1>
      <p class="muted">양가 장부는 섞이지 않도록 <b>신랑 측 / 신부 측을 따로</b> 만드세요.<br>만든 링크를 받은 사람만 장부에 접근할 수 있어요.</p>
      <form id="create" class="card">
        <label class="field"><span>장부 이름</span>
          <input name="title" type="text" maxlength="40" required autocomplete="off" placeholder="예: 신부 측" />
        </label>
        <div class="chips">
          <button type="button" class="chip" data-title="신부 측">신부 측</button>
          <button type="button" class="chip" data-title="신랑 측">신랑 측</button>
        </div>
        <label class="field"><span>처음 받은 식권 수 <small>(선택 · 잔여 계산용)</small></span>
          <input name="tickets" placeholder="예: 120" />
        </label>
        <button class="primary" type="submit">장부 만들기</button>
      </form>
      ${recent.length ? `
        <h2>최근 연 장부</h2>
        <ul class="recent">${recent.map((r) => `<li><a href="/l/${esc(r.id)}">${esc(r.title)}<small>${esc(r.id.slice(0, 8))}…</small></a></li>`).join("")}</ul>` : ""}
    </main>`;

  const form = $("#create");
  digitsInput(form.tickets, { max: LIMITS.ticketsInitial });
  form.addEventListener("click", (e) => {
    const t = e.target.closest("[data-title]");
    if (t) form.title.value = t.dataset.title;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = clean(form.title.value);
    if (!title) { toast("장부 이름을 입력해 주세요", "err"); form.title.focus(); return; }
    const t = parseAmount(form.tickets.value);
    const id = crypto.randomUUID();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "만드는 중…";
    try {
      await setDoc(doc(db, "ledgers", id), {
        title, ticketsInitial: t == null ? null : Math.min(t, 10000),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      rememberLedger(id, title);
      location.href = `/l/${id}`;
    } catch (err) {
      console.error(err);
      toast("장부를 만들지 못했어요. 인터넷 연결을 확인해 주세요.", "err", 4000);
      btn.disabled = false;
      btn.textContent = "장부 만들기";
    }
  });
}

// ───────────────────────── 장부 화면 ─────────────────────────
function renderLedger(lid) {
  const ledgerRef = doc(db, "ledgers", lid);
  const entriesCol = collection(db, "ledgers", lid, "entries");
  const entryRef = (no) => doc(db, "ledgers", lid, "entries", String(no));

  const S = {
    ledger: null,
    entries: new Map(), // no -> data
    pendingCount: 0,
    fromCache: true,
    tab: "reg",
    filter: "all", // all | noamount | deleted
    q: "",
    sortAsc: false,
    showSum: false, // 합계는 눌러야 보임
  };

  $("#app").innerHTML = `
    <header class="top">
      <div class="top-row">
        <div class="title-wrap">
          <a href="/" class="home-x" aria-label="처음 화면으로" title="처음 화면으로">✕</a>
          <h1 id="ltitle">…</h1>
          <span id="sync" class="sync"></span>
        </div>
        <div id="summary" class="summary"></div>
        <button id="menu-btn" class="icon-btn" aria-label="메뉴" aria-haspopup="menu" aria-expanded="false">☰</button>
      </div>
      <nav id="menu" class="menu" role="menu" hidden>
        <button role="menuitem" data-go="reg" class="on">✎ 등록</button>
        <button role="menuitem" data-go="list">☰ 목록 · 합계</button>
        <button role="menuitem" data-go="settings">⚙︎ 장부 설정</button>
      </nav>
    </header>
    <main>
      <section id="tab-reg"></section>
      <section id="tab-list" hidden>
        <button type="button" id="list-sum" class="list-sum" aria-pressed="false"></button>
        <div class="list-tools">
          <input id="q" type="search" maxlength="60" autocomplete="off" enterkeyhint="search" placeholder="이름·번호·메모 검색" />
          <button id="sort" class="ghost" aria-label="정렬 바꾸기">최신순</button>
        </div>
        <div class="chips filters">
          <button class="chip on" data-filter="all">전체</button>
          <button class="chip" data-filter="noamount">금액 미입력</button>
          <button class="chip" data-filter="deleted">삭제됨</button>
        </div>
        <ul id="list" class="list"></ul>
        <button id="csv" class="ghost wide">CSV 내려받기 (마감 정산용)</button>
      </section>
    </main>
    <div id="sheet" class="sheet" hidden></div>`;

  // ── 등록 폼
  const regForm = createEntryForm($("#tab-reg"), { mode: "new" });

  // ── 메뉴 (등록 / 목록 / 설정)
  const menu = $("#menu"), menuBtn = $("#menu-btn");
  const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute("aria-expanded", String(open)); };
  menuBtn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest("#menu")) setMenu(false); });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    setMenu(false);
    if (b.dataset.go === "settings") return openSettingsSheet();
    showView(b.dataset.go);
  });
  function showView(v) {
    S.tab = v;
    menu.querySelectorAll("[data-go]").forEach((x) => x.classList.toggle("on", x.dataset.go === v));
    $("#tab-reg").hidden = v !== "reg";
    $("#tab-list").hidden = v !== "list";
    if (v === "list") { renderList(); renderListSum(); }
    window.scrollTo(0, 0);
  }

  // ── 목록 도구
  $("#q").addEventListener("input", (e) => { S.q = e.target.value.trim(); renderList(); });
  $("#sort").addEventListener("click", (e) => {
    S.sortAsc = !S.sortAsc;
    e.target.textContent = S.sortAsc ? "번호순" : "최신순";
    renderList();
  });
  $(".filters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    S.filter = b.dataset.filter;
    document.querySelectorAll(".filters .chip").forEach((x) => x.classList.toggle("on", x === b));
    renderList();
  });
  $("#list").addEventListener("click", (e) => {
    const li = e.target.closest("[data-no]");
    if (li) openEditSheet(Number(li.dataset.no));
  });
  $("#csv").addEventListener("click", downloadCsv);
  $("#list-sum").addEventListener("click", () => { S.showSum = !S.showSum; renderListSum(); });

  // ── 실시간 구독
  onSnapshot(ledgerRef, { includeMetadataChanges: true }, (snap) => {
    if (!snap.exists()) {
      if (!snap.metadata.fromCache) renderMessage("장부를 찾을 수 없어요", "링크가 정확한지 확인해 주세요.");
      return;
    }
    S.ledger = snap.data({ serverTimestamps: "estimate" });
    $("#ltitle").textContent = S.ledger.title;
    document.title = `${S.ledger.title} · 축의대`;
    rememberLedger(lid, S.ledger.title);
    renderSummary();
    regForm.applyDefaults();
  }, (err) => {
    console.error(err);
    renderMessage("장부를 열 수 없어요", "링크가 정확한지 확인해 주세요.");
  });

  onSnapshot(entriesCol, { includeMetadataChanges: true }, (snap) => {
    S.entries = new Map();
    let pending = 0;
    snap.docs.forEach((d) => {
      const data = d.data({ serverTimestamps: "estimate" });
      S.entries.set(data.no, data);
      if (d.metadata.hasPendingWrites) pending++;
    });
    S.pendingCount = pending;
    S.fromCache = snap.metadata.fromCache;
    renderSync();
    renderSummary();
    regForm.syncAutoNo();
    if (S.tab === "list") renderList();
  }, (err) => console.error(err));

  window.addEventListener("online", renderSync);
  window.addEventListener("offline", renderSync);

  function defaultTickets() {
    const v = S.ledger?.defaultTickets;
    return Number.isInteger(v) ? v : DEFAULT_TICKETS;
  }

  function defaultAmount() {
    const v = S.ledger?.defaultAmount;
    return Number.isInteger(v) ? v : null; // 기본: 미입력
  }

  // after 다음 번호부터 찾고, 없으면 처음부터 다시 찾음 (after 자신은 제외)
  function nextMissing(after) {
    const nos = [...S.entries.values()]
      .filter((e) => !e.deleted && e.amount == null && e.no !== after)
      .map((e) => e.no).sort((a, b) => a - b);
    if (!nos.length) return null;
    return nos.find((n) => n > after) ?? nos[0];
  }

  function nextNo() {
    let max = 0;
    for (const no of S.entries.keys()) if (no > max) max = no;
    return max + 1;
  }

  function stats() {
    let count = 0, tickets = 0, sum = 0, missing = 0;
    for (const e of S.entries.values()) {
      if (e.deleted) continue;
      count++;
      tickets += e.tickets || 0;
      if (e.amount == null) missing++;
      else sum += e.amount;
    }
    return { count, tickets, sum, missing };
  }

  // 서버와 실제로 연결돼 있을 때만 저장 허용 (오프라인 등록 → 번호 꼬임 방지)
  function isOnline() { return navigator.onLine && !S.fromCache; }
  function blockedOffline() {
    if (isOnline()) return false;
    toast("인터넷 연결이 끊겨서 저장할 수 없어요. 연결된 뒤 다시 눌러 주세요.", "err", 4000);
    return true;
  }

  function renderSync() {
    const el = $("#sync");
    el.title = "";
    $("#tab-reg .bottom-bar button")?.classList.toggle("offline", !isOnline());
    if (!navigator.onLine) {
      el.className = "sync off";
      el.textContent = "연결 끊김 · 저장 불가";
    } else if (S.pendingCount) {
      el.className = "sync wait";
      el.textContent = `전송 중 ${S.pendingCount}건`;
    } else if (S.fromCache) {
      el.className = "sync wait";
      el.textContent = "연결 중…";
    } else {
      el.className = "sync on dot";
      el.textContent = "";
      el.title = "실시간 연결됨";
    }
  }

  function renderSummary() {
    const s = stats();
    const init = S.ledger?.ticketsInitial;
    const remain = init == null ? null : init - s.tickets;
    $("#summary").innerHTML = `
      <span>봉투 <b>${s.count}</b></span>
      <span>식권 <b>${s.tickets}</b>${remain == null ? "" : `<small>/잔여 ${remain}</small>`}</span>`;
    renderListSum();
  }

  // 합계는 목록 화면에서만, 눌러야 보임
  function renderListSum() {
    const s = stats();
    const el = $("#list-sum");
    el.setAttribute("aria-pressed", String(S.showSum));
    el.innerHTML = `
      <span>합계 ${S.showSum ? `<b>${won(s.sum)}원</b>` : `<b class="masked">눌러서 보기</b>`}</span>
      <small>${s.missing ? `금액 미입력 ${s.missing}건` : "금액 모두 입력됨"}</small>`;
  }

  function filtered() {
    const q = S.q.toLowerCase();
    let arr = [...S.entries.values()].filter((e) => {
      if (S.filter === "deleted") { if (!e.deleted) return false; }
      else if (e.deleted) return false;
      if (S.filter === "noamount" && e.amount != null) return false;
      if (!q) return true;
      return String(e.no) === q || [e.name, e.relation, e.memo].some((v) => v && v.toLowerCase().includes(q));
    });
    arr.sort((a, b) => (S.sortAsc ? a.no - b.no : b.no - a.no));
    return arr;
  }

  function renderList() {
    const arr = filtered();
    const nameCount = new Map();
    for (const e of S.entries.values()) {
      if (e.deleted || !e.name) continue;
      const k = normName(e.name);
      nameCount.set(k, (nameCount.get(k) || 0) + 1);
    }
    const ul = $("#list");
    if (!arr.length) {
      ul.innerHTML = `<li class="empty">${S.entries.size ? "해당하는 봉투가 없어요" : "아직 등록된 봉투가 없어요"}</li>`;
      return;
    }
    ul.innerHTML = arr.map((e) => `
      <li data-no="${e.no}" class="${e.deleted ? "is-deleted" : ""}">
        <span class="no">${e.no}</span>
        <span class="who">
          <b>${esc(e.name) || '<i class="muted">이름 없음</i>'}${!e.deleted && e.name && nameCount.get(normName(e.name)) > 1 ? ' <em class="dup">동명이인</em>' : ""}</b>
          <small>${[`식권 ${e.tickets || 0}`, [e.relation, e.memo].filter(Boolean).map(esc).join(" · ")].filter(Boolean).join(" | ")}${e.deleted && e.movedTo ? ` → ${e.movedTo}번으로 이동` : ""}</small>
        </span>
        <span class="amt ${e.amount == null ? "none" : ""}">${e.amount == null ? "미입력" : manwon(e.amount)}</span>
      </li>`).join("");
  }

  // ── 등록/수정 폼 (같은 UI를 등록 탭과 수정 시트에서 공유)
  function createEntryForm(root, { mode, entry }) {
    const isEdit = mode === "edit";
    // 수정(목록에서 열기)은 금액 입력이 주 용도라 축의금 카드를 먼저 보여줌
    const INFO = `
        <section class="card">
          <div class="row-top">
            <label class="field f-no"><span>봉투번호${isEdit ? "" : ' <small class="auto">자동</small>'}</span>
              <input name="no" enterkeyhint="next" />
            </label>
            <label class="field f-name"><span class="name-label">이름 <small class="req">필수</small><em class="name-dup" hidden>⚠ 이름중복</em></span>
              <input name="name" type="text" maxlength="60" autocomplete="off" spellcheck="false" placeholder="성명 / 단체명" enterkeyhint="done" />
            </label>
          </div>
          <div class="stepper">
            <span class="label">식권</span>
            <button type="button" data-tk="-1" aria-label="식권 1장 빼기">−</button>
            <output name="tickets">0</output>
            <button type="button" data-tk="1" aria-label="식권 1장 더하기">+</button>
          </div>
          <div class="rel-row">
            <span class="label">관계</span>
            <div class="rel-chips">
              ${RELATIONS.map((r) => `<button type="button" class="chip" data-rel="${r}">${r}</button>`).join("")}
            </div>
          </div>
          <details class="extra">
            <summary>관계 직접입력 · 메모 <small>(선택)</small></summary>
            <label class="field"><span>관계 / 대리 전달</span>
              <input name="relation" type="text" maxlength="60" autocomplete="off" spellcheck="false" placeholder="예: 직장동료, OOO 대신 전달" />
            </label>
            <label class="field"><span>메모</span>
              <textarea name="memo" rows="2" maxlength="300" spellcheck="false" placeholder="특이사항"></textarea>
            </label>
          </details>
        </section>`;
    const AMOUNT = `
        <section class="card amount">
          <div class="amount-head"><span>축의금</span><small>${isEdit ? "" : "마감 때 입력해도 돼요"}</small></div>
          <div class="amount-row">
            <button type="button" data-step="-50000">−5만</button>
            <div class="amount-input">
              <input name="amount" placeholder="미입력" />
              <span>원</span>
            </div>
            <button type="button" data-step="50000">+5만</button>
          </div>
          <div class="quick">
            ${[10, 15, 20, 30, 50, 100].map((v) => `<button type="button" data-set="${v * 10000}">${v}만</button>`).join("")}
          </div>
          <button type="button" class="link clear-amount">금액 지우기</button>
        </section>`;
    root.innerHTML = `
      <form class="entry" autocomplete="off" novalidate>
        ${isEdit ? AMOUNT + INFO : INFO + AMOUNT}

        <p class="form-msg" role="alert"></p>
        ${isEdit ? `
          <button type="button" class="danger-link" data-act="${entry.deleted ? "restore" : "delete"}">${entry.deleted ? "복구하기" : "이 봉투 삭제"}</button>
          <div class="actions sheet-bar">
            ${entry.amount == null && !entry.deleted && nextMissing(entry.no) != null
              ? `<button type="button" class="ghost" data-act="skip">건너뛰기</button>`
              : `<button type="button" class="ghost" data-act="cancel">닫기</button>`}
            <button type="submit" class="primary">저장</button>
          </div>`
        : `<div class="bottom-bar"><button type="submit" class="primary big">등록</button></div>`}
      </form>`;

    const f = $("form", root);
    const msg = $(".form-msg", f);
    let tickets = 0;
    let noTouched = false;
    let pristine = true; // 신규 폼을 아직 안 건드렸으면 설정 변경(기본 식권)을 바로 반영
    f.addEventListener("input", () => (pristine = false));

    const setTickets = (n) => { tickets = Math.max(0, Math.min(LIMITS.tickets, n)); f.tickets.value = tickets; };
    const setAmount = (n) => { f.amount.value = n == null ? "" : won(Math.max(0, Math.min(LIMITS.amount, n))); amountChanged(); };
    const amountChanged = () => {
      const v = parseAmount(f.amount.value);
      f.querySelectorAll("[data-set]").forEach((b) => b.classList.toggle("on", Number(b.dataset.set) === v));
    };
    const showMsg = (t) => { msg.textContent = t || ""; };
    const warn = $(".name-dup", f);

    // 관계 칩: 입력값과 같은 칩을 켜둠. 켜진 칩을 다시 누르면 해제.
    const syncRelChips = () => {
      const v = f.relation.value.trim();
      f.querySelectorAll("[data-rel]").forEach((b) => b.classList.toggle("on", b.dataset.rel === v));
    };
    f.relation.addEventListener("input", syncRelChips);

    // 동명이인 경고 (삭제된 봉투·자기 자신 제외)
    const checkSameName = () => {
      const key = normName(f.name.value);
      const same = key
        ? [...S.entries.values()].filter((e) => !e.deleted && normName(e.name) === key && (!isEdit || e.no !== entry.no))
        : [];
      warn.hidden = !same.length;
      // 상세(몇 번인지)는 길게 누르기/마우스오버 툴팁으로만
      warn.title = same.sort((a, b) => a.no - b.no).map((e) => `${e.no}번${e.relation ? `(${e.relation})` : ""}`).join(", ");
    };
    f.name.addEventListener("input", () => { checkSameName(); if (f.name.value.trim()) showMsg(""); });

    if (isEdit) {
      f.no.value = entry.no;
      f.name.value = entry.name || "";
      f.relation.value = entry.relation || "";
      f.memo.value = entry.memo || "";
      // 금액 입력이 주 용도라 관계·메모는 접어두고 내용만 요약해서 보여줌
      const extra = [entry.relation, entry.memo].filter(Boolean).join(" · ");
      if (extra) $(".extra summary small", f).textContent = `(${extra.length > 24 ? extra.slice(0, 24) + "…" : extra})`;
      setTickets(entry.tickets || 0);
      setAmount(entry.amount ?? null);
      syncRelChips();
      checkSameName();
    } else {
      setTickets(defaultTickets());
      setAmount(defaultAmount());
    }

    digitsInput(f.no, { max: LIMITS.no });
    digitsInput(f.amount, { max: LIMITS.amount, comma: true });
    f.no.addEventListener("input", () => {
      noTouched = true;
      $(".auto", f)?.classList.add("hide");
      showMsg("");
    });
    f.amount.addEventListener("input", amountChanged);
    // 키보드가 올라와 있을 때 식권·관계·금액 버튼을 눌러도 입력칸 포커스(=키보드)를 유지.
    // 터치: touchend 기본동작을 막아 포커스 이동(blur)을 없애고 직접 처리.
    // 마우스: mousedown 기본동작을 막으면 포커스가 그대로 남음.
    // 등록 버튼도 포함: 누를 때 키보드가 닫혔다 다시 열리는 깜빡임 방지
    const KEEP = "button[data-tk], button[data-rel], button[data-set], button[data-step], button.clear-amount, .bottom-bar button[type=submit]";
    const typing = () => {
      const a = document.activeElement;
      return a && f.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
    };
    let touch = null;
    f.addEventListener("touchstart", (e) => {
      const b = e.target.closest(KEEP);
      const t = e.touches[0];
      touch = b ? { b, x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    f.addEventListener("touchend", (e) => {
      const b = e.target.closest(KEEP);
      if (!b || !touch || touch.b !== b || !typing()) return;
      const t = e.changedTouches[0];
      const moved = Math.abs(t.clientX - touch.x) > 10 || Math.abs(t.clientY - touch.y) > 10;
      touch = null;
      if (moved) return; // 스크롤 제스처는 무시
      e.preventDefault(); // 합성 click·포커스 이동 취소 → 키보드 유지
      if (b.type === "submit") { if (!b.disabled) f.requestSubmit(); }
      else onButton(b);
    }, { passive: false });
    f.addEventListener("mousedown", (e) => { if (e.target.closest(KEEP) && typing()) e.preventDefault(); });

    f.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) onButton(b);
    });
    function onButton(b) {
      if (b.dataset.tk || b.dataset.set || b.dataset.step || b.dataset.rel) pristine = false;
      if (b.dataset.rel) {
        f.relation.value = f.relation.value.trim() === b.dataset.rel ? "" : b.dataset.rel;
        syncRelChips();
        return;
      }
      if (b.dataset.tk) setTickets(tickets + Number(b.dataset.tk));
      else if (b.dataset.set) setAmount(Number(b.dataset.set));
      else if (b.dataset.step) setAmount((parseAmount(f.amount.value) || 0) + Number(b.dataset.step));
      else if (b.classList.contains("clear-amount")) setAmount(null);
      else if (b.dataset.act === "cancel") closeSheet();
      else if (b.dataset.act === "skip") { const n = nextMissing(entry.no); n != null ? openEditSheet(n) : closeSheet(); }
      else if (b.dataset.act === "delete") softDelete(entry.no);
      else if (b.dataset.act === "restore") restore(entry.no);
    }
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      isEdit ? saveEdit() : saveNew();
    });

    function values() {
      return {
        no: parseInt(f.no.value, 10),
        name: clean(f.name.value),
        relation: clean(f.relation.value),
        memo: clean(f.memo.value),
        tickets,
        amount: parseAmount(f.amount.value),
      };
    }

    function resetNew(lastNo) {
      f.reset();
      setTickets(defaultTickets());
      setAmount(defaultAmount());
      $("details", f).open = false;
      noTouched = false;
      pristine = true;
      syncRelChips();
      checkSameName();
      $(".auto", f)?.classList.remove("hide");
      f.no.value = Math.max(nextNo(), lastNo + 1);
      showMsg("");
    }

    let saving = false;
    async function saveNew() {
      if (saving) return;
      const v = values();
      if (!Number.isInteger(v.no) || v.no < 1 || v.no > 99999) return showMsg("봉투번호를 입력해 주세요.");
      if (!v.name) { f.name.focus(); return showMsg("이름을 입력해 주세요. 모르면 '미상' 등으로 적고 메모를 남겨 주세요."); }
      const ex = S.entries.get(v.no);
      if (ex && !ex.deleted) {
        return showMsg(`${v.no}번은 이미 등록돼 있어요${ex.name ? ` (${ex.name})` : ""}. 다음 번호는 ${nextNo()}번이에요.`);
      }
      if (blockedOffline()) return;
      // 키보드가 열려 있으면 탭 동작(사용자 제스처) 안에서 바로 이름 칸으로 포커스를 옮겨 둠.
      // (저장 완료 후 비동기로 focus()하면 iOS는 키보드를 다시 열지 않음)
      if (typing() && document.activeElement !== f.name) f.name.focus();
      const data = { ...v, deleted: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
      // 서버가 받아준 것을 확인한 뒤에만 폼을 비움 → 실패 시 번호를 고쳐서 다시 등록
      const btn = $(".bottom-bar button", f);
      saving = true;
      btn.disabled = true;
      btn.textContent = "저장 중…";
      const slow = setTimeout(() => showMsg("연결이 느려요. 저장 확인 중이니 잠시만 기다려 주세요…"), 5000);
      try {
        await setDoc(entryRef(v.no), data);
      } catch (err) {
        console.error(err);
        const n = nextNo();
        f.no.value = n;
        noTouched = false;
        return showMsg(`⚠ ${v.no}번은 방금 다른 기기에서 먼저 등록됐어요. ${n}번으로 바꿨으니 봉투에 ${n}번으로 적고 다시 등록해 주세요.`);
      } finally {
        clearTimeout(slow);
        saving = false;
        btn.disabled = false;
        btn.textContent = "등록";
      }
      const dup = v.name && [...S.entries.values()].some((e) => !e.deleted && e.no !== v.no && normName(e.name) === normName(v.name));
      toast(`${v.no}번 등록${v.name ? ` · ${v.name}` : ""}${v.tickets ? ` · 식권 ${v.tickets}` : ""}${dup ? " · ⚠ 동명이인" : ""}`, "ok", dup ? 3500 : 2200);
      resetNew(v.no);
      f.name.focus();
    }

    function saveEdit() {
      if (blockedOffline()) return;
      const v = values();
      if (!Number.isInteger(v.no) || v.no < 1 || v.no > 99999) return showMsg("봉투번호를 확인해 주세요.");
      if (!v.name) { f.name.focus(); return showMsg("이름을 입력해 주세요."); }
      const fields = { name: v.name, relation: v.relation, memo: v.memo, tickets: v.tickets, amount: v.amount, updatedAt: serverTimestamp() };
      if (v.no === entry.no) {
        updateDoc(entryRef(entry.no), fields).catch(failed);
      } else {
        const ex = S.entries.get(v.no);
        if (ex && !ex.deleted) return showMsg(`${v.no}번은 이미 있어요${ex.name ? ` (${ex.name})` : ""}. 다른 번호를 입력해 주세요.`);
        const batch = writeBatch(db);
        batch.set(entryRef(v.no), {
          ...fields, no: v.no, deleted: false,
          createdAt: entry.createdAt || serverTimestamp(),
        });
        batch.update(entryRef(entry.no), { deleted: true, movedTo: v.no, updatedAt: serverTimestamp() });
        batch.commit().catch(failed);
        toast(`${entry.no}번 → ${v.no}번으로 변경. 봉투 번호도 고쳐 적어주세요.`, "ok", 4000);
        closeSheet();
        return;
      }
      // 금액을 새로 입력했으면 다음 금액 미입력 봉투로 바로 이동
      if (entry.amount == null && v.amount != null && !entry.deleted) {
        const n = nextMissing(entry.no);
        if (n != null) {
          toast(`${v.no}번 ${manwon(v.amount)} 저장 → ${n}번`);
          openEditSheet(n);
          return;
        }
        toast(`${v.no}번 저장 · 금액 미입력 봉투가 더 없어요 🎉`, "ok", 3500);
        closeSheet();
        return;
      }
      toast(`${v.no}번 저장`);
      closeSheet();
    }

    return {
      syncAutoNo() {
        if (!isEdit && !noTouched) f.no.value = nextNo();
      },
      applyDefaults() {
        if (!isEdit && pristine) { setTickets(defaultTickets()); setAmount(defaultAmount()); }
      },
    };
  }

  function failed(err) {
    console.error(err);
    toast("⚠ 저장 실패 — 번호가 겹치거나 권한이 없어요. 목록을 확인해 주세요.", "err", 8000);
  }

  function softDelete(no) {
    if (blockedOffline()) return;
    updateDoc(entryRef(no), { deleted: true, updatedAt: serverTimestamp() }).catch(failed);
    toast(`${no}번 삭제됨 · 목록 '삭제됨'에서 복구할 수 있어요`, "ok", 3500);
    closeSheet();
  }
  function restore(no) {
    if (blockedOffline()) return;
    updateDoc(entryRef(no), { deleted: false, movedTo: deleteField(), updatedAt: serverTimestamp() }).catch(failed);
    toast(`${no}번 복구됨`);
    closeSheet();
  }

  // ── 시트 (수정 / 설정)
  function openSheet(title) {
    const sheet = $("#sheet");
    sheet.innerHTML = `<div class="sheet-backdrop" data-close></div>
      <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="닫기">✕</button></div>
        <div class="sheet-body"></div>
      </div>`;
    sheet.hidden = false;
    document.body.classList.add("locked");
    sheet.querySelectorAll("[data-close]").forEach((x) => x.addEventListener("click", closeSheet));
    return $(".sheet-body", sheet);
  }
  function closeSheet() {
    $("#sheet").hidden = true;
    $("#sheet").innerHTML = "";
    document.body.classList.remove("locked");
  }

  function openEditSheet(no) {
    const entry = S.entries.get(no);
    if (!entry) return;
    const body = openSheet(`${no}번 · ${entry.name || "이름 없음"}${entry.deleted ? " (삭제됨)" : ""}`);
    createEntryForm(body, { mode: "edit", entry });
  }

  function openSettingsSheet() {
    const body = openSheet("장부 설정");
    const url = `${location.origin}/l/${lid}`;
    body.innerHTML = `
      <form class="settings">
        <label class="field"><span>장부 이름</span>
          <input name="title" type="text" maxlength="40" required autocomplete="off" value="${esc(S.ledger?.title)}" />
        </label>
        <label class="field"><span>처음 받은 식권 수 <small>(잔여 계산용)</small></span>
          <input name="tickets" placeholder="미설정" value="${S.ledger?.ticketsInitial ?? ""}" />
        </label>
        <fieldset class="defaults">
          <legend>등록할 때 기본값 <small>— 모든 기기에 적용</small></legend>
          <div class="half">
            <label class="field"><span>식권 (장)</span>
              <input name="defTickets" placeholder="1" value="${defaultTickets()}" />
            </label>
            <label class="field"><span>금액 (원)</span>
              <input name="defAmount" placeholder="미입력" value="${won(defaultAmount())}" />
            </label>
          </div>
          <div class="chips">
            ${[10, 15, 20, 30, 50].map((v) => `<button type="button" class="chip" data-defamt="${v * 10000}">${v}만</button>`).join("")}
            <button type="button" class="chip" data-defamt="">금액 없음</button>
          </div>
        </fieldset>
        <p class="form-msg" role="alert"></p>
        <div class="share">
          <span>공유 링크 <small>— 받은 사람은 누구나 등록·수정할 수 있어요</small></span>
          <code>${esc(url)}</code>
          <button type="button" class="ghost" data-copy>링크 복사</button>
        </div>
        <a class="link" href="/">새 장부 만들기</a>
        <div class="sheet-bar"><button class="primary" type="submit">저장</button></div>
      </form>`;
    const f = $("form", body);
    f.noValidate = true;
    digitsInput(f.tickets, { max: LIMITS.ticketsInitial });
    digitsInput(f.defTickets, { max: LIMITS.defaultTickets });
    digitsInput(f.defAmount, { max: LIMITS.amount, comma: true });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const title = clean(f.title.value);
      if (!title) { $(".form-msg", f).textContent = "장부 이름을 입력해 주세요."; f.title.focus(); return; }
      if (blockedOffline()) return;
      const t = parseAmount(f.tickets.value);
      const dt = parseAmount(f.defTickets.value);
      updateDoc(ledgerRef, {
        title, ticketsInitial: t == null ? null : Math.min(t, LIMITS.ticketsInitial),
        defaultTickets: dt == null ? DEFAULT_TICKETS : Math.min(dt, LIMITS.defaultTickets),
        defaultAmount: parseAmount(f.defAmount.value),
        updatedAt: serverTimestamp(),
      }).catch(failed);
      toast("설정 저장");
      closeSheet();
    });
    f.addEventListener("click", (e) => {
      const b = e.target.closest("[data-defamt]");
      if (b) f.defAmount.value = b.dataset.defamt ? won(Number(b.dataset.defamt)) : "";
    });
    $("[data-copy]", f).addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); toast("링크 복사됨"); }
      catch { toast("복사 실패 — 링크를 길게 눌러 복사해 주세요", "err"); }
    });
  }

  // ── CSV
  function downloadCsv() {
    const rows = [["봉투번호", "성명/단체명", "관계/대리전달", "식권(장)", "금액(원)", "메모", "상태", "등록시각"]];
    const all = [...S.entries.values()].sort((a, b) => a.no - b.no);
    for (const e of all) {
      const created = e.createdAt?.toDate ? e.createdAt.toDate().toLocaleString("ko-KR") : "";
      rows.push([e.no, e.name ?? "", e.relation ?? "", e.tickets ?? 0, e.amount ?? "", e.memo ?? "",
        e.deleted ? (e.movedTo ? `삭제(→${e.movedTo})` : "삭제") : "", created]);
    }
    const s = stats();
    rows.push([], ["합계", `${s.count}건`, "", s.tickets, s.sum, s.missing ? `금액 미입력 ${s.missing}건` : "", "", ""]);
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `${S.ledger?.title || "축의금"}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
