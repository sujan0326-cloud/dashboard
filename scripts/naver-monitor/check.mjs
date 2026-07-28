#!/usr/bin/env node
/**
 * 네이버 모바일 예약(m.booking.naver.com) 시간대 예약가능 감시 매크로
 *
 * 하는 일:
 *  - config.json 의 각 상품(itemId) × 날짜(date) 페이지를 실제 브라우저(Chromium)로 연다.
 *  - "매진/마감"이던 시간대가 "예약가능"으로 살아나는지 판별한다.
 *  - 직전 상태(state.json)와 비교해서, 새로 자리가 난 경우에만 텔레그램으로 알림을 보낸다.
 *
 * 실행:
 *  node check.mjs                # 1회 검사 (GitHub Actions 에서 이렇게 호출)
 *  node check.mjs --debug        # 스크린샷/캡처된 API 응답을 debug/ 폴더에 저장
 *  node check.mjs --no-notify    # 알림 없이 판별 결과만 출력 (테스트용)
 *
 * 알림 경로(있는 것 모두 사용):
 *  1) GitHub 이슈 → 저장소 주인에게 이메일 자동 발송 (GITHUB_TOKEN, 설정 불필요 · 기본)
 *  2) 텔레그램 푸시 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID · 선택)
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const DEBUG_DIR = path.join(__dirname, "debug");

const args = new Set(process.argv.slice(2));
const DEBUG = args.has("--debug");
const NO_NOTIFY = args.has("--no-notify");
const TEST_NOTIFY = args.has("--test-notify"); // 실제 검사 없이 테스트 알림만 보냄

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

// ── 유틸 ─────────────────────────────────────────────────────────────
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
function weekdayKST(dateStr) {
  // dateStr = YYYY-MM-DD → 해당 달력 날짜의 요일. 정오(UTC) 기준으로 계산해 시간대 경계 문제를 피한다.
  return WEEKDAY[new Date(`${dateStr}T12:00:00Z`).getUTCDay()] || "";
}

function buildUrl(target, date, bookingPath) {
  const start = encodeURIComponent(`${date}T00:00:00+09:00`);
  return (
    `https://m.booking.naver.com/booking/${bookingPath}/bizes/${target.bizId}` +
    `/items/${target.itemId}?area=pll&lang=ko&startDateTime=${start}&theme=place`
  );
}

// 브라우저 안에서 실행 — 시간대 버튼을 훑어 예약가능/매진을 분류한다.
function detectInPage() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const timeRe = /\b([01]?\d|2[0-3]):[0-5]\d\b/;
  const badWords = ["마감", "매진", "대기", "불가", "종료", "품절", "마감임박안됨"];
  const bodyText = norm(document.body.innerText);

  // 날짜 전체가 마감/불가라고 페이지가 명시하는 경우
  const noAvail =
    /예약\s*가능한?\s*(시간|일정|날짜)\S{0,6}(없|불가)/.test(bodyText) ||
    /(해당|선택)\S{0,4}(날짜|일자)\S{0,6}(마감|불가|없)/.test(bodyText) ||
    /예약\s*마감/.test(bodyText);

  const nodes = Array.from(
    document.querySelectorAll(
      'button, a, li, [role="button"], [class*="time" i], [class*="slot" i], [class*="Time" i]'
    )
  );

  const isDisabled = (el, text) => {
    if (el.hasAttribute("disabled")) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (badWords.some((w) => text.includes(w))) return true;
    let cur = el, depth = 0;
    while (cur && depth < 3) {
      const cls = cur.className && cur.className.toString ? cur.className.toString() : "";
      if (/disabl|soldout|sold-out|closed|inactive|dimmed|deactiv|impossible|dim\b/i.test(cls)) return true;
      if (cur.getAttribute && cur.getAttribute("aria-disabled") === "true") return true;
      if (cur.hasAttribute && cur.hasAttribute("disabled")) return true;
      cur = cur.parentElement;
      depth++;
    }
    return false;
  };

  const seen = new Set();
  const available = [];
  const soldout = [];
  for (const el of nodes) {
    const t = norm(el.innerText || el.textContent);
    if (!t || t.length > 40) continue; // 문단/설명 텍스트 제외
    const m = t.match(timeRe);
    if (!m) continue;
    const time = m[0];
    if (isDisabled(el, t)) {
      const k = "x" + time;
      if (!seen.has(k)) { soldout.push(time); seen.add(k); }
    } else {
      const k = "o" + time;
      if (!seen.has(k)) { available.push(time); seen.add(k); }
    }
  }
  available.sort();
  soldout.sort();
  return { available, soldout, noAvail, textSample: bodyText.slice(0, 1200) };
}

async function checkOne(browser, target, date, bookingPath) {
  const url = buildUrl(target, date, bookingPath);
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const page = await context.newPage();

  // 페이지가 내부적으로 호출하는 예약 API 응답을 그대로 수집(디버깅/향후 튜닝용)
  const apiResponses = [];
  page.on("response", async (res) => {
    const u = res.url();
    if (!/graphql|schedule|bizItem|booking\/.*\/(api|v\d)/i.test(u)) return;
    const ct = res.headers()["content-type"] || "";
    if (!ct.includes("json")) return;
    try { apiResponses.push({ url: u, status: res.status(), body: await res.json() }); }
    catch { /* 파싱 실패 무시 */ }
  });

  let error = null;
  try {
    // networkidle 은 네이버처럼 백그라운드 통신이 잦은 페이지에서 잘 안 끝난다.
    // domcontentloaded 로 빠르게 진입한 뒤, 시간대 UI가 렌더될 때까지 따로 기다린다.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (e) {
    error = `goto: ${e.message}`;
  }
  // 네트워크가 잠잠해질 기회를 최대 8초만 준다(안 끝나도 계속 진행).
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  // 시간대(HH:MM) 또는 '마감/없음' 안내가 화면에 나타나면 렌더 완료로 보고 진행.
  await page
    .waitForFunction(
      () => {
        const t = document.body ? document.body.innerText : "";
        return (
          /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(t) ||
          /예약\s*마감|가능한?\s*(시간|일정|날짜)|없습니다|매진/.test(t)
        );
      },
      { timeout: 15000 }
    )
    .catch(() => {});
  // 마지막 렌더 안정화 여유.
  await page.waitForTimeout(1500);

  let detection = { available: [], soldout: [], noAvail: false, textSample: "" };
  try {
    detection = await page.evaluate(detectInPage);
  } catch (e) {
    error = (error ? error + "; " : "") + `evaluate: ${e.message}`;
  }

  if (DEBUG) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const tag = `${target.itemId}_${date}`;
    try { await page.screenshot({ path: path.join(DEBUG_DIR, `${tag}.png`), fullPage: true }); } catch {}
    fs.writeFileSync(
      path.join(DEBUG_DIR, `${tag}.json`),
      JSON.stringify({ url, detection, apiResponses }, null, 2)
    );
  }

  await context.close();

  const isAvailable = detection.available.length > 0 && !detection.noAvail;
  return {
    key: `${target.itemId}|${date}`,
    name: target.name,
    itemId: target.itemId,
    date,
    url,
    isAvailable,
    availableTimes: detection.available,
    soldoutCount: detection.soldout.length,
    noAvail: detection.noAvail,
    apiCount: apiResponses.length,
    error,
  };
}

// ── 텔레그램 알림 ─────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("⚠️  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 없어 알림을 건너뜁니다.");
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    console.error("❌ 텔레그램 전송 실패:", res.status, await res.text().catch(() => ""));
    return false;
  }
  console.log("✅ 텔레그램 알림 전송 완료");
  return true;
}

// ── ntfy.sh 휴대폰 푸시 (계정/토큰 불필요) ─────────────────────────────
// config.json 의 ntfyTopic(또는 NTFY_TOPIC 환경변수)로 지정한 토픽에 POST 하면
// 그 토픽을 구독한 ntfy 앱으로 즉시 푸시가 온다.
async function sendNtfy(hits, topic, opts = {}) {
  const t = process.env.NTFY_TOPIC || topic;
  if (!t) {
    console.warn("⚠️  ntfyTopic 이 없어 ntfy 푸시를 건너뜁니다.");
    return false;
  }
  const detail = hits
    .map(
      (h) =>
        `${h.name}\n${h.date}(${weekdayKST(h.date)}) 예약가능: ` +
        `${h.availableTimes.slice(0, 10).join(", ") || "시간대 확인"}\n${h.url}`
    )
    .join("\n\n");
  const body = opts.intro ? `${opts.intro}\n\n${detail}` : detail;
  // 주의: ntfy 헤더 값은 ASCII만 안전하므로 제목은 영문, 한글 내용은 body 에 담는다.
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(t)}`, {
    method: "POST",
    headers: {
      Title: opts.title || "Naver booking OPEN - real",
      Priority: opts.priority || "high",
      Tags: opts.tags || "tada",
      Click: hits[0]?.url || "https://m.booking.naver.com",
    },
    body,
  });
  if (!res.ok) {
    console.error("❌ ntfy 전송 실패:", res.status, await res.text().catch(() => ""));
    return false;
  }
  console.log(`✅ ntfy 푸시 전송 완료 (topic: ${t})`);
  return true;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── GitHub 이슈 알림 (저장소 주인에게 이메일 자동 발송) ────────────────
async function sendGitHubIssue(hits) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo" — Actions에서 자동 주입
  if (!token || !repo) {
    console.warn("⚠️  GITHUB_TOKEN / GITHUB_REPOSITORY 가 없어 이슈 알림을 건너뜁니다.");
    return false;
  }
  const owner = repo.split("/")[0];
  const title = `🎉 네이버 예약 자리 발생 (${hits.length}건) — ${[...new Set(hits.map((h) => h.date))].join(", ")}`;
  const lines = [
    `@${owner} 예약 가능한 자리가 생겼습니다! 아래 링크로 **바로** 예약하세요. (자리는 금방 사라질 수 있어요)`,
    "",
  ];
  for (const h of hits) {
    lines.push(`### ${h.name}`);
    lines.push(`- 📅 ${h.date} (${weekdayKST(h.date)})`);
    lines.push(`- ⏰ 예약가능: ${h.availableTimes.slice(0, 20).join(", ") || "시간대 확인"}`);
    lines.push(`- 🔗 [바로 예약하기](${h.url})`);
    lines.push("");
  }
  lines.push(`<sub>자동 감시 매크로 · ${new Date(Date.now()).toISOString()}</sub>`);

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "naver-monitor",
    },
    body: JSON.stringify({ title, body: lines.join("\n") }),
  });
  if (!res.ok) {
    console.error("❌ GitHub 이슈 생성 실패:", res.status, await res.text().catch(() => ""));
    return false;
  }
  const j = await res.json();
  console.log("✅ GitHub 이슈 생성:", j.html_url);
  return true;
}

function composeMessage(hits, opts = {}) {
  const header = opts.isTest
    ? "🔔 <b>[테스트 알림] 실제 예약 자리가 아닙니다</b>\n(알림이 잘 오는지 점검하는 테스트입니다)"
    : "🎉 <b>네이버 예약 자리가 생겼어요!</b>";
  const lines = [header, ""];
  for (const h of hits) {
    const wd = weekdayKST(h.date);
    const times = h.availableTimes.slice(0, 12).join(", ") + (h.availableTimes.length > 12 ? " …" : "");
    lines.push(`• <b>${esc(h.name)}</b>`);
    lines.push(`  📅 ${h.date} (${wd})`);
    lines.push(`  ⏰ 예약가능: ${esc(times || "시간대 확인")}`);
    lines.push(`  🔗 <a href="${esc(h.url)}">바로 예약하기</a>`);
    lines.push("");
  }
  lines.push("<i>* 자동 감시 매크로 · 자리는 금방 사라질 수 있어요, 바로 확인하세요.</i>");
  return lines.join("\n");
}

// ── 메인 ─────────────────────────────────────────────────────────────
async function main() {
  const config = readJSON(CONFIG_PATH, null);
  if (!config || !Array.isArray(config.targets)) {
    console.error("config.json 을 읽을 수 없습니다.");
    process.exit(1);
  }
  const prevState = readJSON(STATE_PATH, {});
  const bookingPath = config.bookingPath ?? 12;

  // 테스트 모드: 실제 검사 없이 알림 채널만 점검한다(폰 푸시가 오는지 확인용).
  if (TEST_NOTIFY) {
    const sample = config.targets.slice(0, 1).map((t) => ({
      name: `[테스트·예시] ${t.name}`,
      date: t.dates[0],
      url: buildUrl(t, t.dates[0], bookingPath),
      availableTimes: ["(테스트값)"],
    }));
    console.log("🔔 테스트 알림을 전송합니다(ntfy · 텔레그램)…");
    await sendNtfy(sample, config.ntfyTopic, {
      // ntfy 제목 헤더는 ASCII만 안전 → 영문 [TEST] 로 확실히 구분
      title: "[TEST] 테스트 알림 - not real",
      intro:
        "🔔 [테스트 알림] 이것은 실제 예약 자리가 아닙니다.\n" +
        "알림이 정상적으로 오는지 점검하는 테스트입니다. (아래 값은 예시)",
      tags: "test_tube",
    });
    await sendTelegram(composeMessage(sample, { isTest: true }));
    console.log("테스트 완료. 위 채널에 '[테스트]' 알림이 도착했는지 확인하세요.");
    return;
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const results = [];
  try {
    for (const target of config.targets) {
      for (const date of target.dates) {
        process.stdout.write(`검사 중: ${target.name} / ${date} … `);
        const r = await checkOne(browser, target, date, bookingPath);
        results.push(r);
        console.log(
          r.error
            ? `오류(${r.error})`
            : r.isAvailable
            ? `🟢 예약가능 (${r.availableTimes.join(", ")})`
            : `🔴 매진/없음 (매진 ${r.soldoutCount}, API ${r.apiCount})`
        );
      }
    }
  } finally {
    await browser.close();
  }

  // 상태 갱신 + 새로 자리 난 것만 알림
  const newState = {};
  const hits = [];
  for (const r of results) {
    newState[r.key] = {
      isAvailable: r.isAvailable,
      availableTimes: r.availableTimes,
      checkedAt: new Date(Date.now()).toISOString(),
    };
    const prev = prevState[r.key];
    // 직전에 예약가능이 아니었는데(=매진이었거나 기록 없음) 지금 가능해졌으면 알림
    if (r.isAvailable && (!prev || prev.isAvailable !== true)) {
      hits.push(r);
    }
  }

  if (hits.length && !NO_NOTIFY) {
    // 세 경로 모두 시도 — 설정된 것만 실제로 발송된다.
    await sendGitHubIssue(hits);
    await sendNtfy(hits, config.ntfyTopic);
    await sendTelegram(composeMessage(hits));
  } else if (hits.length && NO_NOTIFY) {
    console.log("\n(--no-notify) 알림 대상:\n" + composeMessage(hits).replace(/<[^>]+>/g, ""));
  } else {
    console.log("\n새로 생긴 자리가 없습니다.");
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2));

  // GitHub Actions 요약(Actions 탭에서 상태 확인용)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .map((r) => {
        const s = r.error ? `⚠️ 오류` : r.isAvailable ? "🟢 예약가능" : "🔴 매진/없음";
        const times = r.availableTimes.join(", ") || "-";
        return `| ${r.name} | ${r.date} (${weekdayKST(r.date)}) | ${s} | ${times} |`;
      })
      .join("\n");
    const summary =
      `### 네이버 예약 감시 결과\n\n` +
      `실행: ${new Date(Date.now()).toISOString()}  ·  새 알림: **${hits.length}건**\n\n` +
      `| 상품 | 날짜 | 상태 | 예약가능 시간 |\n|---|---|---|---|\n${rows}\n`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

main().catch((e) => {
  console.error("치명적 오류:", e);
  process.exit(1);
});
