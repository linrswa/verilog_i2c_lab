# Waveform Viewer — Feature Plan

## Goal

在網頁上顯示 I2C simulation 產生的 VCD 波形，並與 React Flow canvas 上的 protocol steps 做**時間區間對齊**，讓使用者一眼看出每個 step（START、SEND_BYTE、RECV_BYTE、STOP）對應哪段波形。

---

## 現狀分析

### 已有的基礎

- Simulation 產生 VCD 檔（Icarus Verilog `$dumpfile/$dumpvars`）
- 後端有 `GET /api/waveform/{id}` 下載 VCD 檔
- 前端有 `DownloadVcdButton` 元件
- VCD 包含完整信號：`SDA`、`SCL`、`busy`、`done`、`start`、`ack_error`、`byte_count`、`state`（FSM）等

### 缺少的關鍵資料

- **Step 時間戳記**：目前 `execute_sequence()` 和 `_map_protocol_results()` 不記錄每個 step 的模擬時間（sim time）。沒有這個資料就無法做 step ↔ 波形的對齊。

---

## 架構設計

### 資料流

```
Simulation (cocotb)
  ├── VCD file (already exists)
  └── Step timing data (NEW: start_time_ps / end_time_ps per step)
        │
        ▼
Backend (FastAPI)
  ├── POST /api/run response 增加 step timing
  └── GET /api/waveform/{id}/signals (NEW: parse VCD → JSON)
        │
        ▼
Frontend (React)
  ├── WaveformPanel component (NEW: SVG waveform renderer)
  └── Step ↔ Waveform highlight sync
```

---

## 實作計畫

### Phase 1：後端 — 記錄 Step 時間戳記

**目標**：讓每個 step result 帶有 `start_time_ps` 和 `end_time_ps`。

**修改檔案**：
- `backend/sim/test_runner.py` — `execute_sequence()`

**做法**：
- 在 `execute_step()` 和 protocol buffer 執行前後，用 cocotb 的 `cocotb.utils.get_sim_time(units='ps')` 取得模擬時間
- 對於 legacy ops（`reset`、`write_bytes`、`read_bytes`、`scan`、`delay`），在 execute 前後各記錄一次時間
- 對於 protocol ops（`start..stop` block），需要更細緻的處理：
  - 整個 block 的時間區間可以從 `execute_transactions()` 前後取得
  - 但個別 `send_byte` / `recv_byte` 的時間區間需要從 VCD 反推（見 Phase 2 方案 B），或在 driver 層記錄
  - **建議方案**：在 `I2CDriver` 的 `_run_segment()` / `_run_write_txn()` / `_run_read_txn()` 內記錄每個 transaction 的 start/end time，再由 `_map_protocol_results()` 分配給個別 step

**Step timing 粒度選擇**：

| 粒度 | 說明 | 複雜度 |
|------|------|--------|
| Per-block | 整個 start..stop block 一個時間區間 | 低 |
| Per-transaction | 每個 Transaction 一個區間 | 中 |
| Per-step | 每個 send_byte/recv_byte 各自的區間 | 高 |

**建議從 per-transaction 開始**，已經足以在波形上標出有意義的區段（一次 write 或 read transaction），且實作量合理。後續可再細化到 per-step。

**輸出格式**（`RunResponse` 新增欄位）：

```json
{
  "steps": [
    {
      "op": "send_byte",
      "data": "0xa0",
      "status": "ok",
      "time_range_ps": [10000, 850000]
    }
  ],
  "sim_time_total_ps": 2500000
}
```

### Phase 2：後端 — VCD 解析 API

**目標**：新增 endpoint 回傳 VCD 的 signal data（JSON 格式），前端可直接繪製。

**新增檔案**：
- `backend/app/services/vcd_parser.py`

**修改檔案**：
- `backend/app/routes/simulation.py` — 新增 route
- `backend/requirements.txt` 或 `pyproject.toml` — 加入 `vcdvcd` 套件

**新增 Endpoint**：

```
GET /api/waveform/{waveform_id}/signals?signals=sda,scl
```

**Response 格式**：

```json
{
  "timescale": "1ps",
  "end_time": 2500000,
  "signals": {
    "sda": {
      "width": 1,
      "changes": [[0, 1], [5000, 0], [15000, 1], ...]
    },
    "scl": {
      "width": 1,
      "changes": [[0, 1], [10000, 0], [20000, 1], ...]
    }
  }
}
```

- `changes` 是 `[time_ps, value]` 的陣列，按時間排序
- 只回傳請求的信號（預設 `sda` + `scl`），避免傳送過多資料
- 可選支援 `state`（FSM）、`busy`、`done` 等除錯信號

**VCD 解析選項**：

| 套件 | 優點 | 缺點 |
|------|------|------|
| `vcdvcd` | 純 Python、API 簡單、pip install | 大檔案效能一般 |
| 自己寫 parser | 不需額外依賴 | 需要處理各種 VCD edge case |

**建議用 `vcdvcd`**，I2C simulation 的 VCD 檔很小（幾 KB ~ 幾十 KB），效能不是問題。

### Phase 3：前端 — WaveformPanel 元件

**目標**：用 SVG 繪製 SDA/SCL 的 digital waveform，支援 step highlight。

**新增檔案**：
- `frontend/src/components/WaveformPanel.tsx`
- `frontend/src/lib/waveform.ts`（API 呼叫 + 資料轉換）

**修改檔案**：
- `frontend/src/lib/api.ts` — 新增 `fetchWaveformSignals()` 和型別
- `frontend/src/App.tsx`（或 layout 元件）— 嵌入 WaveformPanel

**元件設計**：

```
┌─────────────────────────────────────────────────┐
│ WaveformPanel                                   │
│ ┌─────┬───────────────────────────────────────┐ │
│ │ SCL │ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐         │ │
│ │     │ ┘└─┘└─┘└─┘└─┘└─┘└─┘└─┘└─┘└─         │ │
│ ├─────┼───────────────────────────────────────┤ │
│ │ SDA │ ─┐ ┌───┐   ┌─┐ ┌───────┐             │ │
│ │     │  └─┘   └───┘ └─┘       └──           │ │
│ ├─────┼───────────────────────────────────────┤ │
│ │     │ ██ ADDR ██  █ DATA █  █ DATA █        │ │
│ │     │  step 0      step 1    step 2         │ │
│ └─────┴───────────────────────────────────────┘ │
│           ▲ highlight 對應 selected step        │
└─────────────────────────────────────────────────┘
```

**核心功能**：
1. **SVG 方波繪製**：將 `changes` 陣列轉成 SVG path（digital signal 就是 polyline）
2. **Step 時間區間色塊**：用半透明 `<rect>` 在波形上標示每個 step 的時間範圍
3. **Hover/Click highlight**：滑鼠移到某個 step 色塊 → 高亮該區間 + 通知 React Flow 高亮對應 node
4. **信號標籤**：左側顯示信號名稱（SCL、SDA）

**不需要做的**：
- 不需要 zoom/pan（I2C simulation 時間短，固定比例即可；後續可加 horizontal scroll）
- 不需要 signal tree / filter（只有 2-3 條信號）
- 不需要 analog waveform
- 不需要 cursor / measurement

**SVG 繪製邏輯**（pseudocode）：

```typescript
function signalToPath(changes: [number, number][], endTime: number, yHigh: number, yLow: number): string {
  // changes = [[time, value], ...]
  // value: 0 → yLow, 1 → yHigh
  let d = ''
  for (let i = 0; i < changes.length; i++) {
    const [time, value] = changes[i]
    const x = timeToX(time)
    const y = value ? yHigh : yLow
    if (i === 0) {
      d += `M ${x} ${y}`
    } else {
      // Vertical transition then horizontal hold
      d += ` L ${x} ${y}`
    }
    // Hold until next change
    const nextTime = i + 1 < changes.length ? changes[i + 1][0] : endTime
    d += ` L ${timeToX(nextTime)} ${y}`
  }
  return d
}
```

### Phase 4：前端 — Step ↔ Waveform 雙向同步

**目標**：React Flow 的 node 選取與 WaveformPanel 的 highlight 雙向連動。

**修改檔案**：
- `frontend/src/App.tsx`（或 state management）
- `frontend/src/components/WaveformPanel.tsx`
- `frontend/src/components/ResultPanel.tsx`（可能整合）

**同步機制**：

```
React Flow node click
  → setSelectedStepIndex(i)
    → WaveformPanel scrolls/highlights step i's time range
    → ResultPanel highlights step i's row

WaveformPanel step region click
  → setSelectedStepIndex(i)
    → React Flow highlights node i (fitView or select)
    → ResultPanel highlights step i's row
```

**State 設計**：

```typescript
// 共享 state（lifting state up 或用 context）
interface WaveformState {
  selectedStepIndex: number | null
  hoveredStepIndex: number | null
  signals: WaveformSignalData | null  // from API
  stepTimeRanges: [number, number][]  // from simulation result
}
```

---

## 版面配置

現有版面：

```
┌──────────────────────────────────┬──────────┐
│                                  │          │
│         React Flow Canvas        │  Result  │
│                                  │  Panel   │
│                                  │          │
└──────────────────────────────────┴──────────┘
```

加入 WaveformPanel 後的版面：

```
┌──────────────────────────────────┬──────────┐
│                                  │          │
│         React Flow Canvas        │  Result  │
│                                  │  Panel   │
│                                  │          │
├──────────────────────────────────┤          │
│         Waveform Panel           │          │
│   SCL ┌┐┌┐┌┐┌┐┌┐                │          │
│   SDA ─┐┌──┐┌─┐                 │          │
└──────────────────────────────────┴──────────┘
```

- WaveformPanel 放在 React Flow 下方，可折疊
- ResultPanel 保持在右側，高度跨越整個視窗
- WaveformPanel 只在有 simulation result 時顯示

---

## 依賴與技術選型

| 項目 | 選擇 | 理由 |
|------|------|------|
| VCD 解析 | `vcdvcd` (Python) | 輕量、API 簡單、VCD 檔小不需高效能 |
| 波形繪製 | Raw SVG in React | 信號少、不需通用 viewer；SVG 好控制 highlight |
| 時間記錄 | `cocotb.utils.get_sim_time()` | cocotb 內建 API |
| State 管理 | React Context or lifting state | 夠簡單，不需 Redux/Zustand |

---

## 實作順序與建議

| 順序 | Phase | 預估工作量 | 可獨立測試 |
|------|-------|-----------|-----------|
| 1 | Phase 2: VCD 解析 API | 小 | 是（用現有 VCD 檔測試） |
| 2 | Phase 3: WaveformPanel 基本繪製 | 中 | 是（先用 mock data） |
| 3 | Phase 1: Step 時間戳記 | 中 | 是（檢查 API response） |
| 4 | Phase 4: 雙向同步 | 小 | 需要 1-3 都完成 |

**建議從 Phase 2 開始**：VCD 解析是最獨立的，可以用現有的 VCD 檔（`backend/sim/tests/i2c_system_cocotb.vcd`）直接測試，不需要跑 simulation。

---

## 風險與待確認

1. **Step timing 粒度**：per-transaction 是否足夠？如果使用者希望看到每個 bit 的對應，需要 per-step 甚至 per-bit 粒度，複雜度會大幅增加。建議先做 per-transaction，看實際效果再決定是否細化。

2. **cocotb `get_sim_time` 位置**：需要確認在 `_run_segment()` 裡 await 之間呼叫 `get_sim_time()` 是否能準確反映 transaction 邊界。

3. **VCD 信號路徑**：VCD 內的 signal 名稱包含 hierarchy（`i2c_system_wrapper.dut.scl`），解析時需要做 path matching 或 flatten。

4. **大型 VCD**：目前 I2C simulation 的 VCD 很小，但如果未來有更長的 sequence，可能需要做 downsampling 或 lazy loading。目前不需要擔心。
