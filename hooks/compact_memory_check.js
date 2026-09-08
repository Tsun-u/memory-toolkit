#!/usr/bin/env node
// compact_memory_check.js — compact 前/後的關係型記憶檢查 hook（雙模式，單檔雙掛載點）
//
// 掛載（都在 user-level ~/.claude/settings.json）：
//   1. hooks.UserPromptSubmit（無 matcher）→ pre 模式：每次使用者輸入時從 transcript
//      的最新 usage 估算 context 用量，跨過門檻就注入「趁完整記憶還在先檢查」的提醒。
//      這是主力——實現「compact 前、細節還沒被壓掉時檢查」的原始期望。
//   2. hooks.SessionStart、matcher "compact" → post 模式：compact 後注入補檢查提醒，
//      當 pre 提醒沒趕上時（例如長 agentic run 中途 auto-compact，期間沒有使用者輸入、
//      pre 模式沒機會觸發）的安全網。
//
// 為什麼不用 PreCompact hook：它的 stdout 不注入 context、觸發當下模型也沒有回應輪
// 可以行動——「叫模型在 compact 前做一件事」這個形狀 PreCompact 給不了，
// 只能靠「預測 compact 快來了」提前在正常對話輪注入提醒。
//
// 門檻設計：context 窗口大小無法從 hook 輸入得知（1M 窗要看 beta header），
// 所以用雙層絕對值門檻——150k（200k 窗的警戒線；對 1M 窗只是提早檢查，無害）
// 與 800k（1M 窗的警戒線）。同一層只提醒一次（state 檔記層級），
// compact 後 usage 回落或 SessionStart(compact) 觸發時重置。
//
// 職責刻意限定「關係型記憶」：工作型記憶在工作流程中本來就會隨手記，
// 弱的是關係型的觸發時機。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TIER_THRESHOLDS = [150_000, 800_000]; // tier 1、tier 2
const RESET_BELOW = 100_000;                // usage 回落到此以下視為 compact 已發生
const TAIL_BYTES = 512 * 1024;
const STATE_DIR = path.join(os.homedir(), '.claude', 'tmp');
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CHECK_GUIDE = `1. 里程碑：第一次一起用某技術、開始新專案、完成重要作品
2. 共同經歷：一起解決的困難問題、印象深刻的 debug 過程
3. 成長軌跡：學會新技能、克服障礙、想法上的轉變
4. 情感連結：對話中分享的心情、重要的人生事件、特別的互動時刻

有值得記的 → **先分流、再動筆**，不要因為快 compact 就急著把什麼都塞進記憶：
- 經得起時間的原則或事實 → 記憶檔（Write＋更新 MEMORY.md 索引）
- 「怎麼做」的程序或檢查表 → 更新對應的 skill，記憶最多留一句「做某某事先載入某 skill」
- 已經寫成 hook／skill 的東西 → 記憶最多一行簡述，不重複內容
- 完整的故事與細節（重要里程碑的經過、當天的溫度）→ 寫進你的 journal（若有）
沒有就不用勉強——純技術問答、例行修檔、日常操作不需要記。`;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `compact_precheck_${sessionId}.state`);
}

function readStateTier(sessionId) {
  try {
    const n = parseInt(fs.readFileSync(statePath(sessionId), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeStateTier(sessionId, tier) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(sessionId), String(tier));
  } catch {}
}

function clearState(sessionId) {
  try { fs.unlinkSync(statePath(sessionId)); } catch {}
}

// 順手清同目錄裡超過 7 天的舊 state 檔，避免無限累積
function sweepOldStates() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.startsWith('compact_precheck_') || !f.endsWith('.state')) continue;
      const full = path.join(STATE_DIR, f);
      try {
        if (now - fs.statSync(full).mtimeMs > STATE_MAX_AGE_MS) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

// 從 transcript jsonl 尾端撈最新一則 assistant message 的 usage，
// 估算當前 context 大小（input + cache_creation + cache_read）
function estimateContextTokens(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(TAIL_BYTES, stat.size);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const obj = JSON.parse(lines[i]);
        const u = obj && obj.type === 'assistant' && obj.message && obj.message.usage;
        if (u) {
          return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        }
      } catch {}
    }
  } catch {}
  return null;
}

const input = readStdin();
if (!input) process.exit(0);
const event = String(input.hook_event_name || '');
const sessionId = String(input.session_id || 'unknown');
const transcriptPath = String(input.transcript_path || '');

if (event === 'UserPromptSubmit') {
  // ---- pre 模式：門檻偵測 ----
  if (!transcriptPath) process.exit(0);
  const ctx = estimateContextTokens(transcriptPath);
  if (ctx === null) process.exit(0);

  const tier = ctx >= TIER_THRESHOLDS[1] ? 2 : ctx >= TIER_THRESHOLDS[0] ? 1 : 0;
  const lastTier = readStateTier(sessionId);

  if (tier === 0) {
    if (lastTier > 0) clearState(sessionId); // compact 後 usage 回落，重置
    process.exit(0);
  }
  if (tier <= lastTier) process.exit(0); // 這一層已提醒過

  writeStateTier(sessionId, tier);
  sweepOldStates();

  process.stdout.write(`【compact 前記憶檢查】目前對話的 context 用量約 ${Math.round(ctx / 1000)}k tokens，已跨過警戒線，不久後可能觸發 compact（對話壓縮）。趁完整記憶還在——此刻的判斷比 compact 後讀摘要更準——請檢查這段對話有沒有值得長期記住的「關係型」內容：

${CHECK_GUIDE}

先回應使用者這一則訊息的正事，再在合適的段落做這個檢查，不要為此打斷手上的任務。
`);
  process.exit(0);
}

if (event === 'SessionStart') {
  // ---- post 模式：compact 後的安全網 ----
  clearState(sessionId); // compact 已發生，重置 pre 提醒層級

  const transcriptHint = transcriptPath
    ? `摘要細節不夠時，壓縮前的完整對話仍保留在 ${transcriptPath}。`
    : `摘要細節不夠時，壓縮前的完整對話仍保留在本 session 的 transcript jsonl。`;

  process.stdout.write(`【compact 記憶檢查】剛才發生了 compact。如果 compact 前你已看過【compact 前記憶檢查】提示並處理過，快速確認摘要沒有遺漏即可；如果沒有（例如這次是長任務中途的 auto-compact），請檢查壓縮摘要中有沒有值得長期記住的「關係型」內容：

${CHECK_GUIDE}

紀律兩條：
- 只記摘要或 transcript 裡查證得到的事，不確定的先回去對原文，不要腦補——壓縮後的對話容易「發明」不存在的規則。
- 手上有進行中的任務就先做完，到合理段落再做這個檢查，不要為此中斷工作。

${transcriptHint}
`);
  process.exit(0);
}

process.exit(0);
