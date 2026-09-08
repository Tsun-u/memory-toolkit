# memory-toolkit

給長期運作的 AI agent 用的記憶管理小工具組：兩份 skill（寫記憶的原則）＋兩支 hook（在對的時機提醒）。

適用於 Claude Code 的檔案式記憶工作流：agent 把長期記憶寫在 `.claude/projects/<專案>/memory/` 底下、以 `MEMORY.md` 當開場索引。核心想法是——**記憶是寫給未來自己的 prompt**，所以它需要 Clean Code 等級的維護紀律，以及在「快忘記之前」被觸發的檢查時機。

## 內容

| 檔案 | 是什麼 |
|---|---|
| `skills/memory-write/SKILL.md` | 寫記憶的完整原則：該不該記、記到哪、怎麼寫、索引怎麼維護、怎麼退役 |
| `skills/prompt-design/SKILL.md` | 寫 prompt 的四原則與自檢清單（記憶就是 prompt，兩份搭配用） |
| `hooks/memory_write_check.js` | 落檔前檢查：攔下對 memory/ 的第一次寫入、注入四問，帶著檢查結果重送才放行；MEMORY.md 逼近載入上限時即時警告 |
| `hooks/compact_memory_check.js` | compact 前後檢查：context 用量跨過警戒線時提醒「趁完整記憶還在先檢查」，compact 後再補一次安全網 |

## 為什麼 hook 要長這樣

- **落檔前擋、不是落檔後提醒**：事後提醒實測無效——同樣的口訣重複出現會被習慣化成已讀雜訊。自檢必須物理性地發生在寫入之前，所以 `memory_write_check.js` 用 PreToolUse deny 逼一次重送。
- **compact 前提醒、不是 compact 時**：PreCompact hook 的輸出不會注入 context，模型也沒有回應輪可以行動。所以改成估算 context 用量、在警戒線提前提醒，compact 後再補一格安全網。

## 安裝

1. 把兩份 skill 放進你的 skills 目錄（例如 `~/.claude/skills/memory-write/`、`~/.claude/skills/prompt-design/`）。
2. 把兩支 hook 放到任意固定路徑，然後在 `~/.claude/settings.json` 掛載：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "node \"/path/to/hooks/memory_write_check.js\"" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "node \"/path/to/hooks/memory_write_check.js\"" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "node \"/path/to/hooks/compact_memory_check.js\"" }]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [{ "type": "command", "command": "node \"/path/to/hooks/compact_memory_check.js\"" }]
      }
    ]
  }
}
```

（Windows 上把 `node` 換成你的 node.exe 完整路徑比較穩。）

3. 沒有任何相依套件，兩支 hook 都只用 Node.js 內建模組。

## 慣例與可調整處

- `memory_write_check.js` 只攔 `.claude/projects/<專案>/memory/` 底下的寫入（`MEMORY_DIR_RE`），其他檔案完全不干涉；記憶目錄放別處就改那條 regex。
- `MEMORY.md` 的 25KB／200 行上限是 Claude Code 開場載入的行為，數字寫在 hook 開頭的常數區。
- `compact_memory_check.js` 的警戒線（150k／800k tokens）同樣是開頭常數，窗口大小不同可自行調整。
- 兩支 hook 的提醒文案都在檔內字串裡，歡迎改成你家 agent 的語氣。

## License

MIT — Copyright (c) 2026 Tsun-u and ATone (宇你童行)
