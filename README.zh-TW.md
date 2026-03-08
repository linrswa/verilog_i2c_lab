# I2C Demo — 互動式 I2C 協議模擬平台

一個全端的 I2C 協議學習與驗證平台，透過視覺化拖拉介面建構 I2C 通訊序列，並即時在 Verilog RTL 模擬環境中執行。

## 目錄

- [專案概述](#專案概述)
- [系統架構](#系統架構)
- [技術堆疊](#技術堆疊)
- [快速開始](#快速開始)
- [專案結構](#專案結構)
- [前端介面](#前端介面)
- [波形檢視器](#波形檢視器)
- [後端 API](#後端-api)
- [模擬引擎](#模擬引擎)
- [RTL 硬體設計](#rtl-硬體設計)
- [測試](#測試)

## 專案概述

本專案讓使用者可以：

1. **視覺化建構** I2C 協議序列 — 在 React Flow 畫布上拖拉節點，組成完整的 I2C 通訊流程
2. **即時模擬執行** — 將序列送至後端，透過 cocotb 驅動 Icarus Verilog 進行 RTL 級模擬
3. **波形檢視** — 內建 SVG 波形檢視器，即時顯示 SDA/SCL 訊號，並支援以 Surfer 開啟完整波形
4. **觀察結果** — 檢視每個步驟的執行結果、Slave 暫存器內容、EEPROM hex grid

適合用於 I2C 協議學習、RTL 設計驗證、或作為硬體模擬平台的參考實作。

## 系統架構

```
┌──────────────────────────────────────────┐
│            Frontend (React)              │
│  ┌──────┬───────────────┬──────────────┐ │
│  │Sidebar│  React Flow   │ Result Panel │ │
│  │節點面板│  畫布 (垂直排列) │  步驟結果    │ │
│  ├──────┴───────────────┴──────────────┤ │
│  │        WaveformPanel (SVG)          │ │
│  │   SDA/SCL 波形 + 步驟區段疊加層      │ │
│  └─────────────────────────────────────┘ │
└──────────────────┬───────────────────────┘
                   │ HTTP API (JSON)
                   ▼
┌──────────────────────────────────────────┐
│          Backend (FastAPI)               │
│   接收序列 → 驗證 → 排程模擬 → VCD 解析  │
└──────────────────┬───────────────────────┘
                   │ subprocess
                   ▼
┌──────────────────────────────────────────┐
│        Simulation (cocotb 2.0)           │
│  Protocol Interpreter → Driver           │
│  per-step timing 記錄 → 波形對齊          │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│           RTL (Verilog)                  │
│   I2C Master + I2C Slave                 │
│   Open-drain Bus + 256B 暫存器           │
└──────────────────────────────────────────┘
```

## 技術堆疊

| 層級 | 技術 |
|------|------|
| 前端 | React 19、TypeScript、Vite、React Flow (xyflow)、Tailwind CSS |
| 後端 | Python 3.9+、FastAPI、uvicorn |
| 模擬 | cocotb 2.0、Icarus Verilog |
| 測試 | pytest、pytest-asyncio、vitest |
| 套件管理 | uv (Python)、bun/npm (Frontend) |

## 快速開始

### 前置需求

- Python 3.9+
- [uv](https://docs.astral.sh/uv/) (Python 套件管理)
- Node.js 18+ 與 bun 或 npm
- [Icarus Verilog](https://steveicarus.github.io/iverilog/) (`iverilog` 指令需在 PATH 中)

### 安裝與啟動

```bash
# 1. 安裝 Python 依賴
uv sync

# 2. 啟動後端 (需使用 .venv 的 Python)
source .venv/bin/activate
cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# 3. 另開終端，安裝並啟動前端
cd frontend
bun install    # 或 npm install
bun run dev    # 或 npm run dev
```

啟動後：
- 前端：http://localhost:5173
- 後端 API：http://localhost:8000
- API 文件：http://localhost:8000/docs (Swagger UI)

> **重要**：後端必須使用 `.venv` 中的 Python 啟動，因為模擬子程序會繼承父程序的 Python 環境，需要能找到 cocotb 等套件。

## 專案結構

```
i2c_demo/
├── backend/
│   ├── app/                    # FastAPI 應用
│   │   ├── main.py             # 應用入口、中介層、生命週期管理
│   │   ├── routes/             # API 路由
│   │   │   ├── simulation.py   # 模擬執行與波形 API
│   │   │   └── templates.py    # 範本 API
│   │   └── services/           # 服務層（模擬執行、VCD 解析）
│   ├── sim/                    # cocotb 模擬程式碼
│   │   ├── test_runner.py      # cocotb 測試入口
│   │   ├── i2c_driver.py       # I2C 交易級驅動程式
│   │   ├── protocol_interpreter.py  # 協議步驟 → 交易轉換器
│   │   ├── rtl/                # Verilog RTL 原始碼
│   │   │   ├── i2c_master.v    # I2C Master 控制器
│   │   │   ├── i2c_slave.v     # I2C Slave（含 256B 暫存器）
│   │   │   └── i2c_top.v       # 頂層模組（Master + Slave + Bus）
│   │   ├── tb/                 # Testbench
│   │   │   └── tb_i2c_top.v    # cocotb 測試用 wrapper
│   │   └── templates/          # 預建測試範本
│   └── tests/                  # 後端測試
├── frontend/
│   └── src/
│       ├── App.tsx             # 主應用（React Flow 畫布 + 佈局管理）
│       ├── components/
│       │   ├── Sidebar.tsx      # 節點面板（拖拉 + 點擊新增）
│       │   ├── ResultPanel.tsx  # 結果面板（步驟結果 + EEPROM）
│       │   ├── WaveformPanel.tsx # SVG 波形檢視器
│       │   ├── Toolbar.tsx      # 工具列（執行、範本選擇）
│       │   ├── TemplateDropdown.tsx # 範本下拉選單
│       │   ├── ResizeHandle.tsx # 可拖曳面板分隔線
│       │   └── nodes/           # 自訂 React Flow 節點
│       └── lib/                 # 工具函式庫
│           ├── api.ts           # 後端 API 呼叫
│           ├── serialize.ts     # Flow → 步驟序列化
│           ├── waveform.ts      # 波形佈局常數與工具
│           ├── validate.ts      # 連線驗證
│           ├── protocol-validate.ts # 協議層級驗證
│           └── useFlowPersistence.ts # 畫布狀態持久化
├── pyproject.toml              # Python 專案設定
└── CLAUDE.md                   # Claude Code 開發指引
```

## 前端介面

### 畫布操作

前端使用 [React Flow](https://reactflow.dev/) 提供視覺化的協議序列編輯器：

- **拖拉新增**：從左側面板拖曳操作節點到畫布上
- **點擊新增**：點擊左側面板項目，自動附加到序列尾端
- **拖曳排序**：拖曳節點可重新排列順序（含 ghost 視覺效果）
- **垂直佈局**：節點自動以垂直方式排列，模擬後自動重新對齊
- **設定參數**：點擊節點可設定位址、資料等參數
- **可調面板**：側邊欄、結果面板、波形面板皆可拖曳調整大小
- **狀態持久化**：畫布狀態自動儲存至 localStorage，重新載入不遺失
- **執行模擬**：點擊「Run」送出序列至後端執行

### 節點類型

所有節點皆為協議級操作（Protocol Primitives），讓使用者精細控制 I2C 訊號：

| 節點 | 說明 |
|------|------|
| START | 發送 START 條件 |
| STOP | 發送 STOP 條件 |
| Sr (Repeated Start) | 發送 Repeated START（不先 STOP） |
| Send Byte | 發送一個位元組（含 ACK 檢查），自動解碼地址位元組 |
| Recv Byte | 接收一個位元組（可設定 ACK/NACK） |

> 後端會自動在序列開頭插入 `reset` 步驟（若未包含），以避免 DUT 因未初始化而掛起。

### 結果面板

模擬完成後，右側面板會展開顯示：
- 每個步驟的執行結果（TX/RX 位元組、ACK/NACK 狀態、地址解碼）
- Slave 目前的 register pointer 位置（橘色高亮標示）
- Slave EEPROM 的 256-byte 完整內容（16×16 hex grid，寫入過的 cell 高亮）

### 波形檢視器

模擬完成後，底部波形面板自動顯示訊號波形：

- **內建 SVG 渲染**：直接在畫面中顯示 SDA、SCL 等訊號波形
- **訊號選擇器**：可搜尋並勾選要顯示的訊號
- **步驟區段疊加**：波形上方疊加每個步驟的時間區段，含 per-byte 時間戳
- **平移與縮放**：滑鼠拖曳平移、滾輪縮放，獨立於畫布操作
- **可調標籤寬度**：拖曳訊號標籤欄分隔線調整寬度
- **Surfer 整合**：點擊連結可在新分頁以 Surfer（WASM 波形檢視器）開啟完整 VCD

## 後端 API

| 端點 | 方法 | 說明 |
|------|------|------|
| `/api/run` | POST | 執行模擬序列 |
| `/api/templates` | GET | 列出可用測試範本 |
| `/api/templates/{name}` | GET | 取得特定範本內容 |
| `/api/waveform/{id}` | GET | 下載 VCD 波形檔 |
| `/api/waveform/{id}/signals` | GET | 取得 VCD 訊號資料（解析後的 JSON） |
| `/api/health` | GET | 健康檢查 |

### 執行模擬範例

寫入 0xAB 到 register 0x00，再用 Repeated Start 讀回：

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

回應中包含 `register_dump`（EEPROM 內容）與 `reg_pointer`（目前暫存器指標位置）。

## 模擬引擎

### 執行流程

1. 前端送出 `steps` 陣列至 `/api/run`
2. 後端 `services.py` 將 steps 寫入暫存檔，啟動子程序執行 cocotb 模擬
3. `protocol_interpreter.py` 將步驟轉換為 I2C 交易
4. `i2c_driver.py` 透過 cocotb 驅動 Verilog testbench 中的訊號
5. Icarus Verilog 執行 RTL 模擬，產生波形與結果
6. 結果（含 per-step timing）以 JSON 回傳前端
7. 前端可透過 `/api/waveform/{id}/signals` 取得解析後的 VCD 訊號資料，渲染波形

### 並行控制

後端使用 `asyncio.Lock` 確保同一時間只有一個模擬在執行，其他請求會排隊等待。模擬有 60 秒超時限制。

## RTL 硬體設計

### I2C Master (`i2c_master.v`)

- 完整的 I2C Master 控制器，含狀態機（100+ 狀態）
- 支援 clock stretching
- 支援 Repeated Start（透過 `repeated_start` 訊號）
- 可設定時脈除頻器

### I2C Slave (`i2c_slave.v`)

- I2C Slave 接收器，可設定位址（預設 `7'h50`）
- 內建 256-byte 暫存器檔案
- 支援連續寫入/讀取（位址自動遞增）

### I2C Top (`i2c_top.v`)

- 頂層模組，連接 Master 與 Slave
- 模擬 open-drain 匯流排（含上拉電阻邏輯）
- SDA/SCL 雙向訊號處理

## 測試

```bash
# 後端測試
source .venv/bin/activate
pytest backend/tests/

# 前端測試
cd frontend
bun run test    # 或 npm run test
```

### 測試範本

`backend/sim/templates/` 中提供了預建的測試序列：

- **basic_write_read** — 基本寫入後讀回驗證
- **repeated_start_read** — 使用協議級操作進行 Repeated Start 讀取
- **full_test** — 綜合測試（寫入、讀取、掃描）
- **stress_test** — 壓力測試（大量連續操作）

## 授權

本專案僅供學習與展示用途。
