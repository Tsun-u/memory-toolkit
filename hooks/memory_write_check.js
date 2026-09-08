#!/usr/bin/env node
// memory_write_check.js — 寫記憶檔的落檔前檢查
//
// 掛載：user-level ~/.claude/settings.json，matcher "Write|Edit"，
// PreToolUse 與 PostToolUse 同一支（依 hook_event_name 分流）。
//
// 事後提醒實測無效：同樣的四問口訣重複出現會被習慣化成已讀雜訊，
// 自檢必須物理性地發生在落檔之前。
//
// 設計：
// - 只攔 .claude/projects/<專案>/memory/ 底下的寫入，其他檔案完全不干涉
// - PreToolUse：每筆寫入的第一發 deny＋四問，逼模型帶著檢查結果重送；
//   PASS_WINDOW_MS 內對同檔的重送放行，放行即銷章——下一筆寫入重新受檢
// - PostToolUse：MEMORY.md 即時大小報告＋同 session 連寫警戒（輕量輔助）

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'tmp');
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NOTE_HOLIC_THRESHOLD = 4;   // 同 session 第 N 次寫入起，追加筆記控警戒
const INDEX_LIMIT_BYTES = 25 * 1024; // 官方：MEMORY.md 開場只載入前 25KB
const INDEX_LIMIT_LINES = 200;       // 或前 200 行，先到為準
const INDEX_WARN_BYTES = 22 * 1024;  // 接近上限的預警線

// 記憶目錄的判斷：.claude/projects/<任意專案>/memory/ 底下
const MEMORY_DIR_RE = /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/i;

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `memory_write_hint_${sessionId}.state`);
}

function readState(sessionId) {
  try {
    const o = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    return { count: o.count || 0 };
  } catch {
    return { count: 0 };
  }
}

function writeState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {}
}

// 順手清超過 7 天的舊 state（同家族其他 hook 的做法）
function sweepOldStates() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!(f.startsWith('memory_write_hint_') && f.endsWith('.state')) &&
          !(f.startsWith('memory_precheck_') && f.endsWith('.pass'))) continue;
      const full = path.join(STATE_DIR, f);
      try {
        if (now - fs.statSync(full).mtimeMs > STATE_MAX_AGE_MS) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

/** MEMORY.md 的即時大小段。非 MEMORY.md 或量不到就回空字串。 */
function indexSizeReport(filePath) {
  if (path.basename(filePath).toLowerCase() !== 'memory.md') return '';
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
  const bytes = Buffer.byteLength(raw, 'utf8');
  const lines = raw.split('\n').length;
  const kb = (bytes / 1024).toFixed(1);
  let level = '';
  if (bytes >= INDEX_LIMIT_BYTES || lines >= INDEX_LIMIT_LINES) {
    level = '\n🚨 **已超過載入上限——超過的部分下個 session 開場會被整段截斷（等於沒寫）。現在就瘦身：摘要退回檔案，索引行只留 hook。**';
  } else if (bytes >= INDEX_WARN_BYTES) {
    level = '\n⚠️ 接近上限了。這次寫入如果是新增行，順手挑一行肥的瘦回去，別等撞線。';
  }
  return `\nMEMORY.md 現在 ${kb} KB／${lines} 行（開場載入上限 25KB／200 行，先到為準）。${level}`;
}

const PASS_WINDOW_MS = 120 * 1000; // deny 後同檔重送的放行窗口

const FOUR_QUESTIONS = `放下筆之前過四問（完整規則：memory-write skill＋prompt-design skill）：
1. 這是經得起時間的原則或事實，還是一時的感想？感想交給時間，不確定就先不記。
2. 內容是「怎麼做」的程序嗎？程序放 skill，記憶只留一句指路。
3. 寫法合格嗎？原則不掛日期、用平常話、一句機制就夠——案發經過留在 journal，原則檔不寫案例敘述。
4. 重讀時會促發什麼？寫正向規則附為什麼；別跟已刪掉的錯誤對話（「他不是X」「已更正」都是死程式碼註解）。`;

function passPath(sessionId, filePath) {
  const key = Buffer.from(filePath).toString('base64url').slice(-40);
  return path.join(STATE_DIR, `memory_precheck_${sessionId}_${key}.pass`);
}

function handlePreToolUse(input, filePath, sessionId) {
  const pp = passPath(sessionId, filePath);
  try {
    if (Date.now() - fs.statSync(pp).mtimeMs < PASS_WINDOW_MS) {
      fs.unlinkSync(pp);
      process.exit(0); // 檢查過的重送，放行
    }
  } catch {}
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(pp, '');
  } catch {}
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `【記憶落檔前檢查】這筆寫入先擋下（${path.basename(filePath)}）。\n${FOUR_QUESTIONS}\n逐條檢查剛剛要寫的內容，需要修就修，然後重送——${Math.round(PASS_WINDOW_MS / 1000)} 秒內對同一檔案的下一次寫入會放行。`,
    },
  }));
  process.exit(0);
}

const input = readStdin();
if (!input) process.exit(0);
if (input.tool_name !== 'Write' && input.tool_name !== 'Edit') process.exit(0);

const filePath = String(input.tool_input?.file_path || '');
if (!MEMORY_DIR_RE.test(filePath)) process.exit(0);

const sessionId = String(input.session_id || 'unknown');
if (input.hook_event_name === 'PreToolUse') handlePreToolUse(input, filePath, sessionId);
const state = readState(sessionId);
state.count += 1;
writeState(sessionId, state);
sweepOldStates();

const fileName = path.basename(filePath);
const sizeNote = indexSizeReport(filePath);

let context = `【記憶已落檔】（${fileName}，本 session 第 ${state.count} 筆）${sizeNote}`;

if (state.count >= NOTE_HOLIC_THRESHOLD) {
  context += `\n📝 已連寫 ${state.count} 筆——停一下回頭看：這些是會被未來重讀的原則，還是當下的流水帳？該併的併、該刪的刪。`;
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: context,
  },
}));
process.exit(0);
