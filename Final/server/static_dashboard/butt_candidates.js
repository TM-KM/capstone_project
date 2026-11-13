// butt_candidates.js - '지속 변화 후보(꽁초·쓰레기)' 섹션: 요약 카드 + 필터/정렬 + 목록 + 패널 썸네일 + 검수(라벨 저장)
// script.js 의 loadEvents() 가 window.renderButtCandidates(events) 를 호출한다.
// 표시 대상: persistent_change_candidate(후보 추출) 와 cigarette_butt_detected / litter_detected(자동 감지).
// '오염도 현황' 섹션(#pollution)에는 '오염 감지 지수(시범)'를 장치별로 채운다(서버 수정 없음, 화면에서 계산).
// index.html 을 더 고칠 필요 없음: 요약/필터 영역(#butt-tools)은 표(#butt-table) 위에 이 스크립트가 만든다.
(function () {
    const CAND_TYPE = "persistent_change_candidate";
    const AUTO_TYPES = ["cigarette_butt_detected", "litter_detected"];
    const ALL_TYPES = [CAND_TYPE].concat(AUTO_TYPES);
    const LABELS = [
        ["cigarette_butt", "꽁초"],
        ["other_litter", "쓰레기(꽁초 제외)"],
        ["not_litter", "쓰레기 아님"],
        ["uncertain", "불확실"],
    ];
    const PAGE = 50;
    const reviews = {};                                   // reviews[device_id][candidate_id] = label
    const state = { type: "", status: "", sort: "new", minArea: "0", period: "", auto: 0, updated: "", limit: PAGE };
    const FETCH_LIMIT = 1000;                              // 서버가 허용하는 최대값(장치당)
    let timer = null, refreshing = false;
    let lastRows = [];

    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const apiBase = () => (window.API_BASE || "http://localhost:8000").replace(/\/+$/, "");
    const isAuto = (e) => AUTO_TYPES.indexOf(e.event_type) >= 0;
    // 팀원 추가: 메인 노트북 채널(local-ai-server)은 CCTV 가 아니라서 오염도 표에서 뺀다
    const isLocalServer = (id) => {
        if (!id) return true;
        const s = String(id).toLowerCase();
        return s.includes("local ai server") || s.includes("local-ai-server");
    };
    const labelOf = (e) => (reviews[e.device_id] || {})[e.related_detection_id] || "";
    const areaOf = (e) => { const m = /크기\s*(\d+)x(\d+)px/.exec(e.message || ""); return m ? Number(m[1]) * Number(m[2]) : 0; };

    // snapshot_ref 가 없어도 message 의 snap=... 토큰으로 찾는다.
    function snapshotId(e) {
        if (e.snapshot_ref) return String(e.snapshot_ref);
        const m = /snap=(snap_[0-9a-zA-Z]+)/.exec(e.message || "");
        return m ? m[1] : null;
    }
    // make_scene.py 로 만든 '첫 변화 전후 장면' 사진이 있으면 message 의 scene=... 토큰으로 찾는다.
    function sceneId(e) {
        const m = /scene=(snap_[0-9a-zA-Z]+)/.exec(e.message || "");
        return m ? m[1] : null;
    }
    const detailText = (e) => String(e.message || "").replace(/\s*\|\s*snap=\S+/, "").replace(/\s*\|\s*scene=\S+/, "").replace(/\s*\|\s*/g, " · ");

    // ---------- 요약 카드 + 필터 ----------
    function ensureTools() {
        let el = document.getElementById("butt-tools");
        if (el) return el;
        const table = document.getElementById("butt-table");
        if (!table || !table.parentNode) return null;
        el = document.createElement("div");
        el.id = "butt-tools";
        // 표가 scroll-box 안에 있으면 필터·통계는 그 바깥(위)에 둔다 → 표만 스크롤되고 필터는 고정
        const holder = (table.parentNode.classList && table.parentNode.classList.contains("scroll-box")) ? table.parentNode : table;
        holder.parentNode.insertBefore(el, holder);
        return el;
    }

    function drawTools() {
        const el = ensureTools();
        const count = document.getElementById("butt-count");
        const reviewed = lastRows.filter((e) => labelOf(e)).length;
        if (count) count.textContent = `${lastRows.length}건 · 검수 ${reviewed}건`;
        if (!el) return;
        const n = (lab) => lastRows.filter((e) => labelOf(e) === lab).length;
        const today = new Date().toDateString();
        const todayN = lastRows.filter((e) => new Date(e.timestamp).toDateString() === today).length;
        const card = (label, v, color) => `<div style="background:#f8fafd;border:1px solid #dbe4f0;border-radius:6px;padding:8px 14px;min-width:88px;">
            <div style="font-size:12px;color:#6b7a90;">${label}</div>
            <div style="font-size:20px;font-weight:bold;color:${color || "#1f2a3a"};">${v}</div></div>`;
        const sel = (key, opts) => `<select onchange="__buttSet('${key}', this.value)">` +
            opts.map(([v, t]) => `<option value="${v}" ${String(state[key]) === String(v) ? "selected" : ""}>${t}</option>`).join("") + "</select>";
        el.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0;">
            ${card("전체", lastRows.length)}${card("오늘 감지", todayN)}${card("검수 대기", lastRows.length - reviewed, "#d9822b")}
            ${card("꽁초", n("cigarette_butt"), "#2f6f62")}${card("쓰레기", n("other_litter"), "#2f6f62")}
            ${card("쓰레기 아님", n("not_litter"))}${card("불확실", n("uncertain"))}
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:13px;">
            <span>종류</span>${sel("type", [["", "전체"], ["candidate", "후보 추출"]])}
            <span>검수</span>${sel("status", [["", "전체"], ["none", "미검수"]].concat(LABELS))}
            <span>정렬</span>${sel("sort", [["new", "최신순"], ["old", "오래된순"], ["large", "큰 것 먼저"]])}
            <span>기간</span>${sel("period", [["", "전체"], ["24h", "최근 24시간"], ["7d", "최근 7일"]])}
            <span>최소 면적(후보)</span>${sel("minArea", [["0", "제한 없음"], ["300", "300px²"], ["500", "500px²"], ["800", "800px²"]])}
            <span style="color:#6b7a90;">표시 ${visibleRows().length}건 / 전체 ${lastRows.length}건</span>
        </div>
        <div style="font-size:12px;color:#6b7a90;margin-bottom:10px;">
            ※ '큰 것 먼저' 정렬과 '최소 면적'은 크기만 보는 단순 규칙입니다(학습 모델 점수가 아닙니다). 화면의 크기는 가로×세로 상자 값이라 평가 때 쓴 면적과 같지 않고, 기준값은 임시입니다. 작은 쓰레기를 놓칠 수 있으니 필요하면 '제한 없음'으로 확인하세요.
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:13px;">
            <button onclick="__buttRefresh()" style="padding:5px 12px;cursor:pointer;">↻ 새로고침</button>
            <span>자동 갱신</span>${sel("auto", [["0", "끔"], ["30", "30초"], ["60", "60초"]])}
            <span style="color:#6b7a90;">마지막 갱신 ${esc(state.updated || "-")} · 불러온 이벤트는 장치당 최대 ${FETCH_LIMIT}건</span>
        </div>`;
    }

    function visibleRows() {
        let rows = lastRows.filter((e) => {
            if (state.type === "auto" && !isAuto(e)) return false;
            if (state.type === "candidate" && isAuto(e)) return false;
            const minA = Number(state.minArea) || 0;           // 후보에만 적용. 크기를 못 읽은 항목(0)은 숨기지 않는다
            if (minA > 0 && !isAuto(e)) { const a = areaOf(e); if (a > 0 && a < minA) return false; }
            if (state.status === "none") return !labelOf(e);
            if (state.status) return labelOf(e) === state.status;
            return true;
        });
        const ts = (e) => String(e.timestamp || "");
        if (state.sort === "old") rows.sort((a, b) => (ts(a) < ts(b) ? -1 : 1));
        else if (state.sort === "large") rows.sort((a, b) => areaOf(b) - areaOf(a) || (ts(a) < ts(b) ? 1 : -1));
        else rows.sort((a, b) => (ts(a) < ts(b) ? 1 : -1));
        return rows;
    }

    function reviewCell(e) {
        const cid = e.related_detection_id;
        if (!cid) return "—";
        const cur = labelOf(e);
        const opts = [`<option value="" disabled ${cur ? "" : "selected"}>미검수</option>`]
            .concat(LABELS.map(([v, t]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${t}</option>`));
        return `<select class="butt-review" data-dev="${esc(e.device_id)}" data-cid="${esc(cid)}">${opts.join("")}</select>
                <span class="butt-saved" style="margin-left:6px;font-size:12px;color:#1f8a4c;"></span>`;
    }

    function sceneLink(e) {
        const sid = sceneId(e);
        if (!sid) return "";
        const url = `${apiBase()}/api/snapshots/${encodeURIComponent(sid)}`;
        return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:4px;font-size:12px;">▶ 첫 변화 전후 장면 보기</a>`;
    }

    function drawTable() {
        const tbody = document.querySelector("#butt-table tbody");
        if (!tbody) return;
        const rows = visibleRows();
        if (!rows.length) {
            const msg = lastRows.length ? "조건에 맞는 후보가 없습니다." : "수신된 지속 변화 후보가 없습니다.";
            tbody.innerHTML = `<tr><td class="muted" colspan="5">${msg}</td></tr>`;
            return;
        }
        const time = (t) => (typeof fmtTime === "function" ? fmtTime(t) : t);
        const shown = rows.slice(0, state.limit);
        tbody.innerHTML = shown.map((e) => {
            const id = snapshotId(e);
            const url = id ? `${apiBase()}/api/snapshots/${encodeURIComponent(id)}` : null;
            const thumb = url
                ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="검수 패널" loading="lazy" style="width:220px;border:1px solid #c8d4e6;border-radius:4px;display:block;"></a>`
                : "—";
            return `<tr>
                <td>${esc(time(e.timestamp))}</td>
                <td>${esc(e.device_id)}</td>
                <td>${esc(detailText(e))}</td>
                <td>${thumb}${sceneLink(e)}</td>
                <td>${reviewCell(e)}</td>
            </tr>`;
        }).join("") + (rows.length > shown.length
            ? `<tr><td colspan="5" style="text-align:center;"><button onclick="__buttMore()" style="padding:6px 14px;cursor:pointer;">더 보기 (남은 ${rows.length - shown.length}건)</button></td></tr>`
            : "");
    }


    // ---------- 오염 감지 지수(시범) ----------
    // 최근 N시간에 '사람이 확인한' 꽁초/쓰레기 감지 건수에 가중치를 곱해 더한 값. 실제 오염 수준을 잰 값이 아니다.
    // 집계 기간(시간): 화면에서 고르면 저장되고, 지도(litter_map.js)도 같은 값을 읽는다
    function loadHours() {
        try { const h = Number(localStorage.getItem("pollution_hours")); if ([24, 72, 168].indexOf(h) >= 0) return h; } catch (_) { /* 저장 못 해도 동작 */ }
        return 24;
    }
    // 개수 점수(weight)는 이제 '참고 값'이다(팀원의 누적 통계 연동용). 등급은 아래 SPREAD(퍼짐 정도)로 정한다.
    const POLLUTION = { hours: loadHours(), weight: { cigarette_butt: 1, other_litter: 3 }, warn: 1, high: 5 };
    // 퍼짐 정도 = 사람이 확정한 후보 상자가 16x9 격자(144칸) 중 차지한 칸의 비율. 등급 기준은 임시 값(주의 3칸, 높음 12칸 안팎)이며
    // 정답 20영상의 사람 등급으로 정한 값이 아니다 → 성능평가에서 기준이 나오면 여기 두 숫자만 바꾼다(litter_map.js 의 SPREAD_* 도 같이).
    const SPREAD = { warn: 0.02, high: 0.08 };
    let deviceInfo = [], deviceInfoAt = 0;

    async function loadDeviceInfo(force) {
        if (!force && deviceInfo.length && Date.now() - deviceInfoAt < 30000) return;
        try {
            const r = await fetch(`${apiBase()}/api/devices`);
            if (r.ok) { deviceInfo = (await r.json()).devices || []; deviceInfoAt = Date.now(); }
        } catch (_) { /* 장치 정보를 못 받으면 이벤트가 있는 장치만 표시 */ }
    }

    // 확정 면적 지표: 사람이 꽁초/쓰레기로 확정한 후보 상자가 화면을 얼마나 덮는지(겹치면 한 번만 셈).
    // 정답 상자로 계산한 같은 종류의 지표가 사람 등급과 상관 0.59~0.63(영상 20개, 평가자 1명)이었고 개수는 거의 무관(-0.08)이었다.
    // 다만 그 값은 영상 한 편 기준이고 여기는 24시간 누적이라 같은 값이 아니다. 해상도는 1920x1080으로 가정한다.
    const FRAME = { w: 1920, h: 1080, gx: 16, gy: 9, fine: 10 };
    function boxOf(e) {
        const m = /위치\s*(-?\d+)\s*,\s*(-?\d+)/.exec(e.message || "");
        const s = /크기\s*(\d+)x(\d+)px/.exec(e.message || "");
        return (m && s) ? { x: Number(m[1]), y: Number(m[2]), w: Number(s[1]), h: Number(s[2]) } : null;
    }
    function coverageOf(events) {
        const fw = Math.ceil(FRAME.w / FRAME.fine), fh = Math.ceil(FRAME.h / FRAME.fine);
        const fine = new Uint8Array(fw * fh), grid = new Uint8Array(FRAME.gx * FRAME.gy);
        const cw = FRAME.w / FRAME.gx, ch = FRAME.h / FRAME.gy;
        let used = 0;
        events.forEach((e) => {
            const b = boxOf(e);
            if (!b) return;
            const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(FRAME.w, b.x + b.w), y1 = Math.min(FRAME.h, b.y + b.h);
            if (x1 <= x0 || y1 <= y0) return;
            used++;
            for (let j = Math.floor(y0 / FRAME.fine); j <= Math.floor((y1 - 1) / FRAME.fine); j++)
                for (let i = Math.floor(x0 / FRAME.fine); i <= Math.floor((x1 - 1) / FRAME.fine); i++) fine[j * fw + i] = 1;
            for (let j = Math.floor(y0 / ch); j <= Math.floor((y1 - 1) / ch); j++)
                for (let i = Math.floor(x0 / cw); i <= Math.floor((x1 - 1) / cw); i++) grid[j * FRAME.gx + i] = 1;
        });
        const sum = (a) => a.reduce((s, v) => s + v, 0);
        return { used: used, cover: sum(fine) / fine.length, grid: sum(grid) / grid.length };
    }

    // ---------- 오염 분포 그림(시범): 점수 게이지 + 확정 후보 위치 지도 ----------
    // 사람이 확정한 후보 상자를 16x9 격자 위에 그린다(1920x1080 화면 가정). 진한 칸 = 그 칸에 걸친 확정 후보가 많음.
    // 실제 오염 수준을 잰 값이 아니고, 배경 영상은 없다(서버에 장면 원본이 없음).
    function ensureVisual() {
        let el = document.getElementById("pollution-visual");
        if (el) return el;
        const t = document.getElementById("pollution-table");
        if (!t || !t.parentNode || !t.parentNode.insertBefore) return null;
        el = document.createElement("div");
        el.id = "pollution-visual";
        el.style.cssText = "display:flex;gap:16px;flex-wrap:wrap;margin-top:14px;";
        t.parentNode.insertBefore(el, t.nextSibling);
        return el;
    }

    function paintMap(canvas, events) {
        const ctx = canvas.getContext("2d");
        const W = canvas.width, H = canvas.height;
        const cw = W / FRAME.gx, ch = H / FRAME.gy, sx = W / FRAME.w, sy = H / FRAME.h;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#eef2f7";
        ctx.fillRect(0, 0, W, H);
        const boxes = events.map(boxOf).filter(Boolean);
        const cnt = new Array(FRAME.gx * FRAME.gy).fill(0);
        boxes.forEach((b) => {
            const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(FRAME.w, b.x + b.w), y1 = Math.min(FRAME.h, b.y + b.h);
            if (x1 <= x0 || y1 <= y0) return;
            for (let j = Math.floor(y0 / (FRAME.h / FRAME.gy)); j <= Math.floor((y1 - 1) / (FRAME.h / FRAME.gy)); j++)
                for (let i = Math.floor(x0 / (FRAME.w / FRAME.gx)); i <= Math.floor((x1 - 1) / (FRAME.w / FRAME.gx)); i++) cnt[j * FRAME.gx + i]++;
        });
        cnt.forEach((n, k) => {
            if (!n) return;
            ctx.fillStyle = `rgba(217,83,79,${Math.min(0.85, 0.25 + 0.2 * n)})`;
            ctx.fillRect((k % FRAME.gx) * cw, Math.floor(k / FRAME.gx) * ch, cw, ch);
        });
        ctx.strokeStyle = "#cfd8e6";
        ctx.lineWidth = 1;
        for (let i = 0; i <= FRAME.gx; i++) { ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, H); ctx.stroke(); }
        for (let j = 0; j <= FRAME.gy; j++) { ctx.beginPath(); ctx.moveTo(0, j * ch); ctx.lineTo(W, j * ch); ctx.stroke(); }
        ctx.strokeStyle = "#8b1e1e";
        ctx.lineWidth = 2;
        boxes.forEach((b) => ctx.strokeRect(b.x * sx, b.y * sy, Math.max(4, b.w * sx), Math.max(4, b.h * sy)));
        if (!boxes.length) {
            ctx.fillStyle = "#6b7a90";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("확정된 후보가 없습니다", W / 2, H / 2);
        }
    }

    function drawVisual(list) {
        const el = ensureVisual();
        if (!el) return;
        const maxS = SPREAD.high * 2;
        el.innerHTML = list.map((v, i) => {
            const pct = Math.min(100, (v.frac / maxS) * 100);
            const lo = (SPREAD.warn / maxS) * 100, hi = (SPREAD.high / maxS) * 100;
            return `<div class="pv-card" data-dev="${esc(v.dev)}" style="flex:1 1 360px;max-width:560px;background:#f8fafd;border:1px solid #dbe4f0;border-radius:8px;padding:12px 14px;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;"><b>${esc(v.dev)}</b><span style="color:#6b7a90;font-size:12px;">${esc(v.location)}</span></div>
                <div style="margin:8px 0 6px;display:flex;align-items:center;gap:10px;">
                    <span style="font-size:30px;font-weight:bold;color:${v.color};">${pctText(v.frac)}</span><span style="font-size:12px;color:#6b7a90;">퍼짐(격자 점유)</span>
                    <span style="background:${v.color};color:#fff;border-radius:10px;padding:2px 12px;font-size:13px;">${v.g}</span>
                </div>
                <div style="position:relative;height:12px;border-radius:6px;background:linear-gradient(to right,#2f6f62 ${lo}%,#e8892b ${lo}%,#e8892b ${hi}%,#d9534f ${hi}%);">
                    <div style="position:absolute;top:-3px;left:calc(${pct}% - 3px);width:6px;height:18px;background:#1f2a3a;border-radius:3px;"></div>
                </div>
                <div style="position:relative;height:16px;font-size:11px;color:#6b7a90;margin:4px 0 8px;"><span style="position:absolute;left:0;">양호</span><span style="position:absolute;left:${lo}%;">주의 ${pctText(SPREAD.warn)}~</span><span style="position:absolute;left:${hi}%;">높음 ${pctText(SPREAD.high)}~</span></div>
                <div style="font-size:12px;color:#44546a;margin:2px 0 3px;">퍼짐 추이 <span style="color:#6b7a90;">(최근 ${hoursText(POLLUTION.hours)}, 확정 후보 누적)</span></div>
                <canvas id="pv-trend-${i}" width="480" height="100" style="width:100%;border:1px solid #c8d4e6;border-radius:4px;margin-bottom:8px;"></canvas>
                <canvas id="pv-canvas-${i}" width="480" height="270" style="width:100%;border:1px solid #c8d4e6;border-radius:4px;background:#eef2f7;"></canvas>
                <div style="font-size:12px;color:#44546a;margin-top:6px;">확정 면적 ${esc(v.cvText)} · 확정 후보 ${v.confirmed.length}개 (꽁초 ${v.nButt}, 쓰레기 ${v.nLit}) · 개수 점수 ${v.score}점(참고)</div>
                <div style="font-size:11px;color:#6b7a90;margin-top:2px;">※ 사람이 확정한 후보의 위치를 1920x1080 화면 기준 16x9 격자에 그린 것입니다. 진한 칸일수록 확정 후보가 많이 걸쳤습니다. 실제 오염 수준을 잰 값이 아니며 배경 영상은 없습니다.</div>
            </div>`;
        }).join("");
        list.forEach((v, i) => {
            const t = document.getElementById(`pv-trend-${i}`);
            if (t && t.getContext) { try { paintTrend(t, v.trend, v.color); } catch (_) { /* 그림만 포기 */ } }
            const c = document.getElementById(`pv-canvas-${i}`);
            if (c && c.getContext) { try { paintMap(c, v.confirmed); } catch (_) { /* 그림만 포기 */ } }
        });
    }

    function gradeSpread(frac) {
        if (frac >= SPREAD.high) return ["높음", "#d9534f"];
        if (frac >= SPREAD.warn) return ["주의", "#e8892b"];
        return ["양호", "#2f6f62"];
    }
    function pctText(frac) { return (frac * 100).toFixed(1).replace(/\.0$/, "") + "%"; }
    function hoursText(h) { return h >= 24 && h % 24 === 0 ? (h / 24 === 1 ? "24시간" : (h / 24) + "일") : h + "시간"; }

    // 퍼짐 추이: 집계 기간을 24칸으로 나눠, 각 시점까지 사람이 확정한 후보로 계산한 격자 점유(누적). 마지막 값 = 지금의 퍼짐.
    // 치워진 쓰레기는 빠지지 않으므로 줄어들지 않는다(그래서 '쌓이는 정도'로 읽어야 한다).
    function trendOf(confirmed) {
        const N = 24, end = Date.now(), start = end - POLLUTION.hours * 3600 * 1000, pts = [];
        for (let k = 1; k <= N; k++) {
            const t = start + (end - start) * k / N;
            const sub = confirmed.filter((e) => new Date(e.timestamp).getTime() <= t);
            pts.push(sub.length ? coverageOf(sub).grid : 0);
        }
        return pts;
    }
    function paintTrend(canvas, pts, color) {
        const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height, padL = 6, padR = 62, padT = 8, padB = 18;
        const top = Math.max(SPREAD.high * 1.3, Math.max.apply(null, pts) * 1.15);
        const X = (i) => padL + (W - padL - padR) * i / (pts.length - 1), Y = (v) => padT + (H - padT - padB) * (1 - v / top);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
        ctx.font = "11px sans-serif"; ctx.textBaseline = "middle";
        [["주의", SPREAD.warn, "#e8892b"], ["높음", SPREAD.high, "#d9534f"]].forEach((t) => {
            ctx.strokeStyle = t[2]; ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(padL, Y(t[1])); ctx.lineTo(W - padR + 4, Y(t[1])); ctx.stroke();
            ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = "#6b7a90"; ctx.textAlign = "left";
            ctx.fillText(t[0] + " " + pctText(t[1]), W - padR + 6, Y(t[1]));
        });
        ctx.beginPath(); ctx.moveTo(X(0), Y(0));
        pts.forEach((v, i) => { if (i) ctx.lineTo(X(i), Y(pts[i - 1])); ctx.lineTo(X(i), Y(v)); });
        ctx.lineTo(X(pts.length - 1), Y(0)); ctx.closePath();
        ctx.globalAlpha = 0.14; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
        ctx.beginPath(); pts.forEach((v, i) => { if (i) ctx.lineTo(X(i), Y(pts[i - 1])); i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
        const last = pts[pts.length - 1];
        ctx.beginPath(); ctx.arc(X(pts.length - 1), Y(last), 4, 0, 6.2832); ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = "#1f2a3a"; ctx.textAlign = "left"; ctx.font = "bold 12px sans-serif";
        ctx.fillText(pctText(last), X(pts.length - 1) + 8, Y(last) - (Y(last) < 18 ? -8 : 0));
        ctx.font = "11px sans-serif"; ctx.fillStyle = "#6b7a90"; ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left"; ctx.fillText("−" + hoursText(POLLUTION.hours), padL, H - 3);
        ctx.textAlign = "right"; ctx.fillText("지금", W - padR, H - 3);
    }

    // 오염도 표: 기본은 핵심 열(장치·위치·점수·등급·검수 대기)만, '자세히 보기'를 누르면 시각·면적·격자 열도 보인다
    function setupCompact(sec) {
        const table = document.getElementById("pollution-table");
        if (!table || document.getElementById("pollution-compact-btn")) return;
        const st = document.createElement("style");
        st.textContent = "#pollution-table.compact th:nth-child(5),#pollution-table.compact td:nth-child(5)," +
            "#pollution-table.compact th:nth-child(7),#pollution-table.compact td:nth-child(7)," +
            "#pollution-table.compact th:nth-child(8),#pollution-table.compact td:nth-child(8){display:none}" +
            "#pollution-compact-btn{margin:6px 0;border:1px solid #c9d3e3;background:#fff;color:#44546a;border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer}" +
            "#pollution-compact-btn:hover{background:#f4f6fa}";
        document.head.appendChild(st);
        let open = false;
        try { open = localStorage.getItem("pollution_detail") === "1"; } catch (_) { /* 저장 못 해도 동작 */ }
        const btn = document.createElement("button");
        btn.id = "pollution-compact-btn"; btn.type = "button";
        const paint = () => { table.classList.toggle("compact", !open); btn.textContent = open ? "간단히 보기 ▲" : "자세히 보기 ▼"; };
        btn.addEventListener("click", () => {
            open = !open; paint();
            try { localStorage.setItem("pollution_detail", open ? "1" : "0"); } catch (_) { /* 무시 */ }
        });
        paint();
        table.parentNode.insertBefore(btn, table);
        const sel = document.createElement("select");
        sel.id = "pollution-hours"; sel.title = "집계 기간(지도의 점수 배지도 같은 기간을 씁니다)";
        sel.style.cssText = "margin-left:8px;border:1px solid #c9d3e3;border-radius:999px;padding:3px 8px;font-size:12px;color:#44546a;background:#fff";
        [[24, "최근 24시간"], [72, "최근 3일"], [168, "최근 7일"]].forEach((o) => {
            const op = document.createElement("option"); op.value = o[0]; op.textContent = "집계 " + o[1]; if (o[0] === POLLUTION.hours) op.selected = true; sel.appendChild(op);
        });
        sel.addEventListener("change", () => {
            POLLUTION.hours = Number(sel.value);
            try { localStorage.setItem("pollution_hours", String(POLLUTION.hours)); } catch (_) { /* 무시 */ }
            drawPollution();
        });
        table.parentNode.insertBefore(sel, table);
    }

    function drawPollution() {
        const sec = document.getElementById("pollution");
        const tbody = document.querySelector("#pollution-table tbody");
        if (!tbody) return;
        if (sec && sec.querySelector) {                      // 안내 문구를 시범 지수 설명으로 바꾼다
            const badge = sec.querySelector("h2 .badge");
            if (badge) { badge.textContent = "시범"; }
            const note = sec.querySelector(".note");
            if (note) note.textContent = `※ 최근 ${hoursText(POLLUTION.hours)} 동안 사람이 확인한 꽁초·쓰레기 후보 상자가 화면(1920x1080 가정)의 16x9 격자 144칸 중 몇 칸에 걸쳤는지로 오염의 '퍼짐 정도'를 보여 주는 시범 지수입니다. 정답 상자로 계산한 같은 종류의 지표가 사람 등급과 상관 0.59~0.63(영상 20개, 평가자 1명)이었고 개수는 거의 무관했지만, 이 화면의 누적 값으로는 검증하지 않았습니다. 등급 기준(주의 ${pctText(SPREAD.warn)}, 높음 ${pctText(SPREAD.high)})은 임시 값이며 실제 오염 수준을 잰 값이 아닙니다. 치워진 쓰레기는 반영하지 않습니다. 꽁초 1점·쓰레기 3점의 개수 점수는 참고로만 남겼습니다. 장치 하나가 여러 영상·카메라를 받으면 겹쳐서 계산되니 카메라 하나 기준으로 해석하세요.`;
        }
        const tr = document.querySelector("#pollution-table thead tr");
        if (tr && tr.insertAdjacentHTML) {                   // 머리글에 없는 열만 덧붙인다(index.html 에 이미 있어도 중복되지 않음)
            const txt = tr.textContent || "";
            let add = "";
            if (txt.indexOf("검수 대기") < 0) add += "<th>검수 대기</th>";
            if (txt.indexOf("확정 면적") < 0) add += "<th>확정 면적 비율</th><th>격자 점유</th>";
            if (add) tr.insertAdjacentHTML("beforeend", add);
            const names = ["장치 ID", "위치", "퍼짐(격자 점유)", "등급", "측정 시각", "검수 대기", "확정 면적 비율", "개수 점수(참고)"];
            tr.querySelectorAll("th").forEach((th, i) => { if (names[i]) th.textContent = names[i]; });
        }

        setupCompact(sec);
        const since = Date.now() - POLLUTION.hours * 3600 * 1000;
        const ids = deviceInfo.map((d) => d.device_id).filter((id) => !isLocalServer(id));
        lastRows.forEach((e) => { if (e.device_id && ids.indexOf(e.device_id) < 0 && !isLocalServer(e.device_id)) ids.push(e.device_id); });
        if (!ids.length) {
            tbody.innerHTML = `<tr><td class="muted" colspan="8">장치가 없습니다.</td></tr>`;
            return;
        }
        const time = (t) => (typeof fmtTime === "function" ? fmtTime(t) : t);
        const vis = [];
        tbody.innerHTML = ids.map((dev) => {
            const info = deviceInfo.find((d) => d.device_id === dev) || {};
            const devEvents = lastRows.filter((e) => e.device_id === dev);
            let lastUpdated = "—";                           // 팀원 추가: 그 장치의 가장 최근 이벤트 시각
            devEvents.forEach((e) => { if (lastUpdated === "—" || String(e.timestamp) > String(lastUpdated)) lastUpdated = e.timestamp; });
            const recent = devEvents.filter((e) => new Date(e.timestamp).getTime() >= since);
            const nButt = recent.filter((e) => labelOf(e) === "cigarette_butt").length;
            const nLit = recent.filter((e) => labelOf(e) === "other_litter").length;
            const pending = recent.filter((e) => !labelOf(e)).length;
            const score = nButt * POLLUTION.weight.cigarette_butt + nLit * POLLUTION.weight.other_litter;   // 참고용 개수 점수
            const confirmed = recent.filter((e) => ["cigarette_butt", "other_litter"].indexOf(labelOf(e)) >= 0);
            const cv = coverageOf(confirmed);
            const frac = (nButt + nLit) === 0 || !cv.used ? 0 : cv.grid;            // 퍼짐 정도(격자 점유 비율)
            const [g, color] = gradeSpread(frac);
            const cvText = (nButt + nLit) === 0 ? "0%" : (cv.used ? `${(cv.cover * 100).toFixed(2)}%` : "—");
            const gridText = pctText(frac);
            vis.push({ dev: dev, location: info.location || "", score: score, frac: frac, g: g, color: color, nButt: nButt, nLit: nLit,
                       confirmed: confirmed, cvText: cvText, gridText: gridText, trend: trendOf(confirmed) });
            return `<tr>
                <td>${esc(dev)}</td>
                <td>${esc(info.location || "-")}</td>
                <td>${gridText} <small style="color:#6b7a90;">(확정 ${nButt + nLit}건: 꽁초 ${nButt}, 쓰레기 ${nLit})</small></td>
                <td><span style="display:inline-block;white-space:nowrap;min-width:44px;text-align:center;background:${color};color:#fff;border-radius:10px;padding:2px 10px;font-size:12px;">${g}</span></td>
                <td>${lastUpdated === "—" ? "—" : esc(time(lastUpdated))}</td>
                <td>${pending}건</td>
                <td>${cvText} <small style="color:#6b7a90;">(상자 ${cv.used}개)</small></td>
                <td>${score}점</td>
            </tr>`;
        }).join("");
        drawVisual(vis);
    }

    // 서버에서 후보·자동 감지 이벤트와 검수 결과를 다시 불러온다(장치당 최대 1000건, 기간 선택 시 since 적용)
    async function refreshNow() {
        if (refreshing) return;
        refreshing = true;
        state.updated = "갱신 중…";
        drawTools();
        let ok = false;
        try {
            await loadDeviceInfo(true);
            const ids = deviceInfo.map((d) => d.device_id);
            lastRows.forEach((e) => { if (e.device_id && ids.indexOf(e.device_id) < 0) ids.push(e.device_id); });
            const hours = state.period === "24h" ? 24 : state.period === "7d" ? 168 : 0;
            const since = hours ? new Date(Date.now() - hours * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z") : "";
            const results = await Promise.allSettled(ids.map((dev) =>
                fetch(`${apiBase()}/api/devices/${encodeURIComponent(dev)}/events?limit=${FETCH_LIMIT}` +
                      (since ? `&since=${encodeURIComponent(since)}` : ""))
                    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
                    .then((b) => (b.events || []).map((e) => Object.assign({}, e, { device_id: dev })))));
            const all = [];
            results.forEach((r) => { if (r.status === "fulfilled") { ok = true; all.push.apply(all, r.value); } });
            if (ok) {
                lastRows = all.filter((e) => ALL_TYPES.indexOf(e.event_type) >= 0);
                await fetchReviews(Array.from(new Set(lastRows.map((e) => e.device_id))));
            }
            state.updated = ok ? new Date().toLocaleTimeString("ko-KR") : "갱신 실패(서버 확인)";
        } catch (_) {
            state.updated = "갱신 실패(서버 확인)";
        }
        refreshing = false;
        state.limit = PAGE;
        drawTools();
        drawTable();
        drawPollution();
    }

    window.__buttRefresh = refreshNow;

    window.__buttSet = function (key, value) {
        if (key === "auto") {                                // 자동 갱신: 기본은 끔(팀이 자동 새로고침을 일부러 뺐음)
            state.auto = Number(value) || 0;
            if (timer) { clearInterval(timer); timer = null; }
            if (state.auto > 0) timer = setInterval(refreshNow, state.auto * 1000);
            drawTools();
            return;
        }
        state[key] = value;
        state.limit = PAGE;
        if (key === "period") { refreshNow(); return; }       // 기간은 서버에서 다시 불러온다
        drawTools();
        drawTable();
    };
    window.__buttMore = function () {
        state.limit += PAGE;
        drawTable();
    };

    async function fetchReviews(devices) {
        for (const dev of devices) {
            try {
                const r = await fetch(`${apiBase()}/api/devices/${encodeURIComponent(dev)}/reviews`);
                if (!r.ok) continue;
                const body = await r.json();
                reviews[dev] = {};
                (body.reviews || []).forEach((x) => { reviews[dev][x.candidate_id] = x.label; });
            } catch (_) { /* 서버가 구버전이면 검수 없이 목록만 표시 */ }
        }
    }

    window.renderButtCandidates = function (events) {
        lastRows = (events || []).filter((e) => ALL_TYPES.indexOf(e.event_type) >= 0);
        drawTools();
        drawTable();
        drawPollution();
        refreshNow();                                         // script.js 는 장치당 100건만 주므로 1000건까지 다시 불러온다
    };

    // 라벨 선택 -> 서버에 저장 (이벤트 위임: 표가 다시 그려져도 동작)
    document.addEventListener("change", async (ev) => {
        const sel = ev.target;
        if (!sel || !sel.classList || !sel.classList.contains("butt-review")) return;
        const dev = sel.dataset.dev, cid = sel.dataset.cid, label = sel.value;
        const note = sel.parentElement.querySelector(".butt-saved");
        // 팀원 추가: 라벨이 바뀐 만큼 누적 오염도 통계(/api/stats/pollution)에 더하거나 뺀다
        const oldScore = POLLUTION.weight[(reviews[dev] || {})[cid] || ""] || 0;
        const scoreDiff = (POLLUTION.weight[label] || 0) - oldScore;
        try {
            const r = await fetch(`${apiBase()}/api/devices/${encodeURIComponent(dev)}/reviews/${encodeURIComponent(cid)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            (reviews[dev] = reviews[dev] || {})[cid] = label;
            if (note) note.textContent = "저장됨";
            drawTools();                                  // 표는 다시 그리지 않아 '저장됨' 표시가 유지된다
            drawPollution();
            if (scoreDiff !== 0) {
                const event = lastRows.find((e) => e.related_detection_id === cid) || {};
                fetch(`${apiBase()}/api/stats/pollution`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ device_id: dev, timestamp: event.timestamp || new Date().toISOString(), score_diff: scoreDiff }),
                }).catch(() => { /* 통계 저장 실패는 검수 저장과 별개라 조용히 넘어간다 */ });
            }
        } catch (err) {
            if (note) { note.style.color = "#c0392b"; note.textContent = "저장 실패"; }
            alert("검수 결과 저장 실패: " + err.message);
        }
    });

    // 팀원 추가: '누적수치 보기' 버튼 -> 새 탭에서 stats.html
    const btnShowStats = document.getElementById("btn-show-pollution-stats");
    if (btnShowStats) {
        btnShowStats.addEventListener("click", () => {
            const ids = deviceInfo.map((d) => d.device_id).filter((id) => !isLocalServer(id));
            lastRows.forEach((e) => { if (e.device_id && ids.indexOf(e.device_id) < 0 && !isLocalServer(e.device_id)) ids.push(e.device_id); });
            window.open(`stats.html?devices=${encodeURIComponent(ids.join(","))}`, "_blank");
        });
    }
})();
