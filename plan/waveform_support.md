# Waveform Viewer — Feature Plan

## Goal

在網頁上顯示 I2C simulation 產生的 VCD 波形，並與 React Flow canvas 上的 protocol steps 做**位置對齊**，讓使用者一眼看出每個 step（START、SEND_BYTE、RECV_BYTE、STOP）對應哪段波形。

**核心設計理念**：React Flow canvas 改為**水平線性佈局**（pipeline 風格），每個 node 的 x 位置直接對應其在時間軸上的區間。WaveformPanel 放在 canvas 下方，兩者共用同一個水平座標系統，達到**天然的上下對齊**，不需要額外的 highlight 同步機制。

---

## 現狀分析

### 已有的基礎

- Simulation 產生 VCD 檔（Icarus Verilog `$dumpfile/$dumpvars`）
- 後端有 `GET /api/waveform/{id}` 下載 VCD 檔
- 前端有 `DownloadVcdButton` 元件
- VCD 包含完整信號：`SDA`、`SCL`、`busy`、`done`、`start`、`ack_error`、`byte_count`、`state`（FSM）等

### 需要改動的部分

| 項目 | 現狀 | 改為 |
|------|------|------|
| React Flow 佈局 | 自由拖拉 / 垂直 chain | 水平線性，固定 y，x 按順序排列 |
| 新增 node | Drag & drop 到任意位置 | Click-to-append 到最右邊 |
| Node 連線 | 自由連接 | 自動連線（線性 chain） |
| Node 寬度 | 固定 | Simulation 後可依時間區間等比縮放 |
| Bottom pane | 不存在 | 可收縮的 WaveformPanel |
| Sidebar（左側） | Drag source | 改為 click-to-append 的按鈕面板 |
| Step 時間戳記 | 不記錄 | 每個 step 記錄 start/end sim time |

---

## 架構設計

### 整體版面

```
┌─────────────────────────────────────────────────┬──────────┐
│ Sidebar │       React Flow Canvas (horizontal)    │          │
│ [+START]│  ┌───────┐   ┌──────────┐   ┌──────┐  │  Result  │
│ [+SEND] │  │ START │──▶│ SEND 0xA0│──▶│ STOP │  │  Panel   │
│ [+RECV] │  └───────┘   └──────────┘   └──────┘  │          │
│ [+STOP] │                                        │          │
│         ├────────────────────────────────────────┤          │
│         │       Waveform Panel (collapsible)     │          │
│         │  SCL  ┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐              │          │
│         │  SDA  ─┐┌──┐  ┌─┐┌──┐  ──             │          │
│         │       ◄─START─▶◄SEND 0xA0▶◄──STOP──▶  │          │
└─────────┴────────────────────────────────────────┴──────────┘
            ▲ node x 位置 = waveform 時間區間，天然對齊
```

- **Sidebar** 在最左側，改為 click-to-append 按鈕
- **React Flow Canvas** 水平排列 nodes，固定 y 軸
- **Waveform Panel** 在 canvas 正下方，可收縮，共用水平座標
- **Result Panel** 保持在右側，高度跨越整個視窗
- Waveform Panel 只在有 simulation result 時顯示

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
  ├── Horizontal linear flow canvas (REDESIGN)
  ├── WaveformPanel (NEW: SVG waveform renderer)
  └── Node x-position ↔ Waveform time-axis alignment (NATURAL)
```

### 對齊機制

關鍵：**不需要額外的同步邏輯**。

1. Simulation 前：nodes 按固定間距水平排列（等寬）
2. Simulation 後：根據每個 step 的 `time_range_ps`，重新計算每個 node 的 x 座標和寬度
3. WaveformPanel 使用相同的 `timeToX()` 函式繪製波形
4. 因為共用同一個座標系統，上（node）下（waveform）天然對齊

```
timeToX(time_ps) = LABEL_WIDTH + (time_ps / total_time) * WAVEFORM_WIDTH
```

Node 的 x 位置和寬度：
```
node[i].x = timeToX(step[i].start_time_ps)
node[i].width = timeToX(step[i].end_time_ps) - timeToX(step[i].start_time_ps)
```

---

## 實作計畫

### Phase 1：前端 — React Flow 水平線性佈局

**目標**：將 canvas 從自由拖拉改為水平線性 pipeline。

**修改檔案**：
- `frontend/src/App.tsx` — 佈局邏輯、node 新增方式
- `frontend/src/components/FlowCanvas.tsx` — 禁用自由拖拉，水平 auto-layout
- `frontend/src/components/Sidebar.tsx` — 從 drag source 改為 click-to-append 按鈕
- `frontend/src/components/nodes/*.tsx` — 可能需要調整 node 寬度支援

**做法**：

1. **水平 auto-layout**：
   - 所有 nodes 固定在同一 y 座標
   - x 座標按順序排列：`x = i * (NODE_WIDTH + GAP)`
   - 新增 node 時自動計算位置、自動建立到前一個 node 的 edge
   - 禁用 node drag（或僅允許 reorder by drag）

2. **Sidebar 改為 click-to-append**：
   - 按鈕面板取代 drag & drop
   - 點擊按鈕 → append node 到序列最右邊
   - 保持 START/STOP 的自動管理（sequence 必須以 START 開頭、STOP 結尾）

3. **Node 刪除與重排**：
   - 刪除任意 node → 自動重新排列、重新連線
   - 可考慮支援 drag-to-reorder（拖拉改變順序，但 y 軸鎖定）

4. **React Flow 設定調整**：
   - `nodesDraggable={false}`（或僅允許水平拖拉 reorder）
   - `nodesConnectable={false}`（不允許手動連線）
   - `panOnDrag` 保留（允許 canvas 平移瀏覽長序列）
   - `zoomOnScroll` 保留

**Node 排列邏輯**（pseudocode）：

```typescript
function layoutNodes(nodes: Node[]): Node[] {
  const NODE_WIDTH = 160
  const GAP = 40
  const Y = 200  // fixed y

  return nodes.map((node, i) => ({
    ...node,
    position: { x: i * (NODE_WIDTH + GAP), y: Y },
  }))
}

function autoEdges(nodes: Node[]): Edge[] {
  return nodes.slice(0, -1).map((node, i) => ({
    id: `e-${node.id}-${nodes[i + 1].id}`,
    source: node.id,
    target: nodes[i + 1].id,
    type: 'smoothstep',
  }))
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
      "changes": [[0, 1], [5000, 0], [15000, 1]]
    },
    "scl": {
      "width": 1,
      "changes": [[0, 1], [10000, 0], [20000, 1]]
    }
  }
}
```

- `changes` 是 `[time_ps, value]` 的陣列，按時間排序
- 只回傳請求的信號（預設 `sda` + `scl`），避免傳送過多資料
- 可選支援 `state`（FSM）、`busy`、`done` 等除錯信號

**VCD 解析**：使用 `vcdvcd` 套件。I2C simulation 的 VCD 檔很小（幾 KB ~ 幾十 KB），效能不是問題。解析時需要做 signal path matching（VCD 內的名稱含 hierarchy，如 `i2c_system_wrapper.dut.scl`）。

### Phase 3：後端 — 記錄 Step 時間戳記

**目標**：讓每個 step result 帶有 `start_time_ps` 和 `end_time_ps`。

**修改檔案**：
- `backend/sim/test_runner.py` — `execute_sequence()`
- `backend/sim/i2c_driver.py` — `_run_segment()` / `_run_write_txn()` / `_run_read_txn()`

**做法**：
- 在 `I2CDriver` 的 transaction 執行方法內，用 `cocotb.utils.get_sim_time(units='ps')` 記錄每個 transaction 的 start/end time
- 由 `_map_protocol_results()` 將 timing 分配給個別 step
- 對於非 protocol ops（`reset`、`delay`），在 execute 前後各記錄一次

**Step timing 粒度**：從 **per-step** 開始，因為水平佈局需要每個 node 各自的時間區間。

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

### Phase 4：前端 — WaveformPanel 元件

**目標**：用 SVG 繪製 SDA/SCL 的 digital waveform，與上方 nodes 位置對齊。

**新增檔案**：
- `frontend/src/components/WaveformPanel.tsx`
- `frontend/src/lib/waveform.ts`（API 呼叫 + 資料轉換 + timeToX）

**修改檔案**：
- `frontend/src/lib/api.ts` — 新增 `fetchWaveformSignals()` 和型別
- `frontend/src/App.tsx` — 嵌入 WaveformPanel、傳遞共用座標

**元件設計**：

```
┌─────────────────────────────────────────────────────┐
│ WaveformPanel                              [▼ 收縮] │
│ ┌─────┬─────────────────────────────────────────┐   │
│ │ SCL │ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐ ┌┐           │   │
│ │     │ ┘└─┘└─┘└─┘└─┘└─┘└─┘└─┘└─┘└─           │   │
│ ├─────┼─────────────────────────────────────────┤   │
│ │ SDA │ ─┐ ┌───┐   ┌─┐ ┌───────┐               │   │
│ │     │  └─┘   └───┘ └─┘       └──             │   │
│ └─────┴─────────────────────────────────────────┘   │
│         ◄──node0──▶◄──node1──▶◄──node2──▶           │
│         x 座標與上方 React Flow nodes 對齊           │
└─────────────────────────────────────────────────────┘
```

**核心功能**：
1. **SVG 方波繪製**：將 `changes` 陣列轉成 SVG path
2. **Step 區間標示**：半透明色塊標示每個 step 的時間範圍（與上方 node 同寬）
3. **信號標籤**：左側顯示信號名稱（SCL、SDA）
4. **可收縮**：toggle button 收起/展開 panel
5. **Hover highlight**：hover 某段波形 → 上方對應 node 高亮（反之亦然）

**不需要做的**：
- 不需要 zoom/pan（共用 canvas 的 viewport transform）
- 不需要 signal tree / filter（只有 2-3 條信號）
- 不需要 analog waveform
- 不需要 cursor / measurement

**SVG 繪製邏輯**（pseudocode）：

```typescript
function signalToPath(changes: [number, number][], endTime: number, yHigh: number, yLow: number): string {
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

### Phase 5：前端 — Simulation 後 Node 重排 + 完整整合

**目標**：Simulation 完成後，根據 step timing 重新排列 nodes，使其與 waveform 時間軸對齊。

**修改檔案**：
- `frontend/src/App.tsx` — simulation callback 中加入 node 重排邏輯
- `frontend/src/components/WaveformPanel.tsx` — 接收 step timing 資料

**做法**：

1. Simulation 完成 → 取得每個 step 的 `time_range_ps`
2. 計算每個 node 的新 x 座標和寬度：
   ```typescript
   const totalTime = result.sim_time_total_ps
   const WAVEFORM_WIDTH = canvasWidth - LABEL_WIDTH

   nodes.forEach((node, i) => {
     const [start, end] = result.steps[i].time_range_ps
     node.position.x = LABEL_WIDTH + (start / totalTime) * WAVEFORM_WIDTH
     node.style.width = ((end - start) / totalTime) * WAVEFORM_WIDTH
   })
   ```
3. WaveformPanel 使用相同的 `timeToX()` 繪製
4. 上下天然對齊，不需要額外同步

**Hover / Click 同步**：
- 因為 node 和 waveform 共用 x 座標，hover 任一個都可以透過 `selectedStepIndex` 高亮另一個
- State 提升到 App.tsx：

```typescript
interface SharedState {
  selectedStepIndex: number | null
  hoveredStepIndex: number | null
}
```

---

## 依賴與技術選型

| 項目 | 選擇 | 理由 |
|------|------|------|
| VCD 解析 | `vcdvcd` (Python) | 輕量、API 簡單、VCD 檔小不需高效能 |
| 波形繪製 | Raw SVG in React | 信號少、不需通用 viewer；SVG 好控制位置 |
| 時間記錄 | `cocotb.utils.get_sim_time()` | cocotb 內建 API |
| State 管理 | Lifting state to App.tsx | 夠簡單，不需 Redux/Zustand |
| Flow 佈局 | 自己算 x/y + React Flow render | 不需要 dagre/elkjs（線性排列太簡單） |

---

## 實作順序

| 順序 | Phase | 說明 | 可獨立測試 |
|------|-------|------|-----------|
| 1 | Phase 1: 水平線性佈局 | 先改好 canvas，不影響後端 | 是（純前端） |
| 2 | Phase 2: VCD 解析 API | 用現有 VCD 檔測試 | 是（純後端） |
| 3 | Phase 4: WaveformPanel | 先用 mock data 或直接接 VCD API | 是（搭配 Phase 2） |
| 4 | Phase 3: Step 時間戳記 | 修改 cocotb driver，需跑 simulation 驗證 | 是（檢查 API response） |
| 5 | Phase 5: Sim 後重排 + 整合 | 需要 1-4 都完成 | 需要全部串接 |

**建議從 Phase 1 開始**：水平線性佈局是所有後續功能的 UI 基礎，且是純前端改動，可以獨立開發和測試。改完後 canvas 就準備好接收 waveform 對齊了。

---

## 風險與待確認

1. **Node 寬度 vs 時間區間**：如果某些 step（如 START/STOP）時間很短，等比縮放後 node 可能太窄看不清。可能需要設定最小寬度，或用非線性比例。

2. **Canvas 與 WaveformPanel 的 viewport 同步**：React Flow 有自己的 viewport transform（pan/zoom），WaveformPanel 需要同步這個 transform 才能保持對齊。可能需要監聽 React Flow 的 `onViewportChange` 事件。

3. **cocotb `get_sim_time` 位置**：需要確認在 `_run_segment()` 裡 await 之間呼叫 `get_sim_time()` 是否能準確反映 step 邊界。

4. **VCD 信號路徑**：VCD 內的 signal 名稱包含 hierarchy（`i2c_system_wrapper.dut.scl`），解析時需要做 path matching 或 flatten。

5. **水平佈局對 template 載入的影響**：現有 template 是垂直排列，需要更新 template 載入邏輯。

6. **Sidebar 互動模式轉換**：從 drag & drop 改為 click-to-append，需要確保 UX 足夠直覺（可能需要加 insert-at-position 功能，而非只能 append 到最後）。
