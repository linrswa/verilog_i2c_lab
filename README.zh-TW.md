# I2C Demo

互動式 I2C 協議模擬平台 — 在視覺化畫布上建構 I2C 序列，即時以 Verilog RTL 模擬執行，並觀察波形與結果。

**[English README](README.md)**

<p align="center">
  <img src="demo.gif" alt="I2C Demo" width="800">
</p>

[概述](#概述) | [快速開始](#快速開始) | [專案結構](#專案結構) | [前端介面](#前端介面) | [後端 API](#後端-api) | [RTL 硬體設計](#rtl-硬體設計) | [測試](#測試)

---

## 概述

本專案是一個全端的 I2C 協議學習與驗證平台，結合：

- **視覺化協議編輯器** — 在 React Flow 畫布上拖拉節點，組成 I2C 通訊流程
- **即時 RTL 模擬** — 透過 cocotb 驅動 Icarus Verilog，執行真實的硬體模擬
- **波形檢視** — 內建 SVG 波形渲染器，支援訊號選擇、平移縮放，並可以 Surfer 開啟完整 VCD
- **結果檢視** — 每一步驟的執行狀態、Slave EEPROM 256-byte hex grid、register pointer 追蹤

適合用於 I2C 協議學習、RTL 設計驗證、或作為硬體模擬平台的參考實作。

### 系統架構

```
┌──────────────────────────────────────────┐
│            Frontend (React)              │
│  ┌───────┬──────────────┬──────────────┐ │
│  │Sidebar│  React Flow  │ Result Panel │ │
│  │ Node  │  Canvas      │ Step Results │ │
│  │Palette│  (vertical)  │ + EEPROM     │ │
│  ├───────┴──────────────┴──────────────┤ │
│  │        WaveformPanel (SVG)          │ │
│  │   SDA/SCL traces + step overlays    │ │
│  └─────────────────────────────────────┘ │
└──────────────────┬───────────────────────┘
                   │ HTTP API (JSON)
                   ▼
┌──────────────────────────────────────────┐
│          Backend (FastAPI)               │
│   Validate → Queue → Simulate → Parse    │
└──────────────────┬───────────────────────┘
                   │ subprocess
                   ▼
┌──────────────────────────────────────────┐
│        Simulation (cocotb 2.0)           │
│  Protocol Interpreter → I2C Driver       │
│  Per-step timing capture → waveform sync │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│           RTL (Verilog)                  │
│   I2C Master + I2C Slave                 │
│   Open-drain Bus + 256B EEPROM           │
└──────────────────────────────────────────┘
```

### 技術堆疊

| 層級 | 技術 |
|------|------|
| 前端 | React 19、TypeScript、Vite、React Flow (@xyflow/react)、Tailwind CSS |
| 後端 | Python 3.9+、FastAPI、uvicorn |
| 模擬 | cocotb 2.0、Icarus Verilog |
| 測試 | pytest、pytest-asyncio、vitest |
| 套件管理 | uv (Python)、bun / npm (Frontend) |

## 快速開始

### 前置需求

- Python 3.9+
- [uv](https://docs.astral.sh/uv/) — Python 套件管理
- Node.js 18+ 與 [bun](https://bun.sh/) 或 npm
- [Icarus Verilog](https://steveicarus.github.io/iverilog/) — `iverilog` 需在 PATH 中

### 安裝與啟動

```bash
# 安裝 Python 依賴
uv sync

# 啟動後端（Terminal 1）
source .venv/bin/activate
cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
# 安裝並啟動前端（Terminal 2）
cd frontend
bun install    # 或 npm install
bun run dev    # 或 npm run dev
```

啟動後可存取：

| 服務 | 網址 |
|------|------|
| 前端 | http://localhost:5173 |
| 後端 API | http://localhost:8000 |
| Swagger 文件 | http://localhost:8000/docs |

> [!IMPORTANT]
> 後端必須使用 `.venv` 中的 Python 啟動。模擬子程序會繼承父程序的 Python 環境，需要能找到 cocotb 等套件。

## 專案結構

```
i2c_demo/
├── backend/
│   ├── app/                         # FastAPI 應用
│   │   ├── main.py                  # 入口、中介層、生命週期管理
│   │   ├── routes/                  # API 路由
│   │   │   ├── simulation.py        # 模擬執行與波形端點
│   │   │   └── templates.py         # 範本端點
│   │   └── services/                # 服務層
│   │       ├── runner.py            # 模擬執行、佇列管理
│   │       ├── vcd_parser.py        # VCD 解析
│   │       └── waveform.py          # 波形儲存、TTL 清理
│   ├── sim/                         # cocotb 模擬程式碼
│   │   ├── test_runner.py           # cocotb 測試入口
│   │   ├── i2c_driver.py            # I2C 交易級驅動程式
│   │   ├── protocol_interpreter.py  # 步驟 → 交易轉換器
│   │   ├── rtl/                     # Verilog RTL 原始碼
│   │   ├── tb/                      # Testbench
│   │   └── templates/               # 預建測試範本
│   └── tests/                       # 後端測試
├── frontend/
│   └── src/
│       ├── App.tsx                  # React Flow 畫布 + 佈局管理
│       ├── components/
│       │   ├── Sidebar.tsx          # 節點面板（拖拉新增）
│       │   ├── ResultPanel.tsx      # 結果面板 + EEPROM hex grid
│       │   ├── WaveformPanel.tsx    # SVG 波形檢視器
│       │   ├── Toolbar.tsx          # 工具列（執行、範本）
│       │   └── nodes/              # 自訂 React Flow 節點
│       └── lib/                    # 工具函式（API、序列化、驗證）
└── pyproject.toml                  # Python 專案設定
```

## 前端介面

### 畫布操作

前端使用 [React Flow](https://reactflow.dev/) 提供視覺化的協議序列編輯器：

- **拖拉新增** — 從左側面板拖曳節點到畫布，或點擊自動附加到序列尾端
- **拖曳排序** — 拖曳節點可重新排列順序（含 ghost 視覺效果）
- **垂直自動佈局** — 節點垂直排列，模擬後自動重新對齊
- **可調面板** — 側邊欄、結果面板、波形面板皆可拖曳調整大小
- **狀態持久化** — 畫布狀態自動儲存至 localStorage

### 節點類型

所有節點皆為協議級操作（Protocol Primitives）：

| 節點 | 說明 |
|------|------|
| **START** | 發送 START 條件 |
| **STOP** | 發送 STOP 條件 |
| **Sr** | Repeated START（不先 STOP） |
| **Send Byte** | 發送一個位元組，自動解碼地址位元組（如 `0xA0` → Addr `0x50` W） |
| **Recv Byte** | 接收一個位元組，可設定 ACK / NACK |

> [!NOTE]
> 後端會自動在序列開頭插入 `reset` 步驟（若未包含），以避免 DUT 因未初始化而掛起。

### 結果面板

模擬完成後，右側面板顯示：

- 每個步驟的 TX/RX 位元組、ACK/NACK 狀態、地址解碼
- Slave register pointer 位置（橘色高亮）
- 256-byte EEPROM hex grid（寫入過的 cell 藍色高亮）

### 波形檢視器

底部面板自動顯示模擬訊號波形：

- **SVG 即時渲染** — SDA、SCL 及其他 VCD 訊號
- **訊號選擇器** — 可搜尋並勾選要顯示的訊號
- **步驟區段疊加** — 每個步驟的時間區段標註，含 per-byte 時間戳
- **平移與縮放** — 滑鼠拖曳平移、滾輪縮放
- **Surfer 整合** — 點擊連結可在新分頁以 [Surfer](https://surfer-project.org/) WASM 波形檢視器開啟完整 VCD

## 後端 API

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/run` | POST | 執行模擬序列 |
| `/api/templates` | GET | 列出可用測試範本 |
| `/api/templates/{name}` | GET | 取得特定範本內容 |
| `/api/waveform/{id}` | GET | 下載 VCD 波形檔 |
| `/api/waveform/{id}/signals` | GET | 取得解析後的 VCD 訊號資料 |
| `/api/health` | GET | 健康檢查 |

### 使用範例

寫入 `0xAB` 到 register `0x00`，再用 Repeated Start 讀回：

```bash
curl -X POST http://localhost:8000/api/run \
  -H "Content-Type: application/json" \
  -d '{
    "steps": [
      {"op": "start"},
      {"op": "send_byte", "data": "0xA0"},
      {"op": "send_byte", "data": "0x00"},
      {"op": "send_byte", "data": "0xAB"},
      {"op": "stop"},
      {"op": "start"},
      {"op": "send_byte", "data": "0xA0"},
      {"op": "send_byte", "data": "0x00"},
      {"op": "repeated_start"},
      {"op": "send_byte", "data": "0xA1"},
      {"op": "recv_byte", "ack": false},
      {"op": "stop"}
    ]
  }'
```

回應包含 `register_dump`（EEPROM 內容）、`reg_pointer`（暫存器指標）及 `waveform_id`（可用於取得波形資料）。

### 模擬引擎

**執行流程：**

1. 前端送出 `steps` 陣列至 `/api/run`
2. 後端驗證序列並寫入暫存檔，啟動 cocotb 子程序
3. `protocol_interpreter.py` 將步驟轉換為 I2C 交易
4. `i2c_driver.py` 透過 cocotb 驅動 Verilog testbench
5. Icarus Verilog 執行 RTL 模擬，產生 VCD 波形
6. 結果（含 per-step timing）以 JSON 回傳前端

> [!TIP]
> 後端使用 `asyncio.Lock` 確保同一時間只有一個模擬在執行。模擬有 60 秒超時限制，若超時表示可能有 bug（如缺少 reset）。

## RTL 硬體設計

### I2C Master (`i2c_master.v`)

- 8 狀態 FSM（`IDLE`, `START`, `ADDR`, `WRITE`, `READ`, `ACK`, `REPEATED_START`, `STOP`），支援 clock stretching 與 Repeated Start
- 可設定時脈除頻器（預設 50 system clocks per I2C phase）

### I2C Slave (`i2c_slave.v`)

- 可設定位址（預設 `7'h50`），內建 256-byte 暫存器檔案
- 支援連續讀寫，位址自動遞增

### I2C Top (`i2c_top.v`)

- 頂層模組，連接 Master + Slave，模擬 open-drain 匯流排（含上拉電阻邏輯）

## 測試

```bash
# 後端測試
source .venv/bin/activate
pytest backend/tests/

# 前端測試
cd frontend
bun run test
```

### 測試範本

`backend/sim/templates/` 中提供預建的測試序列：

| 範本 | 說明 |
|------|------|
| `basic_write_read` | 基本寫入後讀回驗證 |
| `protocol_write` | 協議級寫入操作 |
| `protocol_write_read` | 寫入 + Repeated Start 讀回 |
| `repeated_start_read` | Repeated Start 讀取 |
| `full_test` | 綜合測試（寫入、讀取、掃描） |
| `stress_test` | 壓力測試（大量連續操作） |
