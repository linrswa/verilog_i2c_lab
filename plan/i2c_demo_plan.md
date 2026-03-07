# I2C Demo Platform 計畫

## 專案目標

建立一個可視化的 I2C 自動化測試平台，使用者可以在 React Flow 前端拖拉拼接測試流程，
後端透過 cocotb 驅動 Verilog simulation 執行，回傳測試結果與波形。

## 系統架構

```
┌─────────────────────────────────┐
│  Frontend (React Flow + Vite)   │
│  - 拖拉拼接測試 node            │
│  - 顯示執行結果 / waveform      │
│  - Bun + TypeScript             │
└──────────────┬──────────────────┘
               │ REST API (JSON)
┌──────────────▼──────────────────┐
│  Backend (FastAPI)              │
│  - 接收測試序列                 │
│  - 動態產生 cocotb test script  │
│  - 執行 simulation (iverilog)   │
│  - 回傳結果 + VCD              │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│  Simulation Layer (cocotb)      │
│  - i2c_top.v (master + slave)   │
│  - transaction-level 控制       │
│  - 256-byte EEPROM slave        │
└─────────────────────────────────┘
```

## 技術選型

| 層級 | 技術 |
|------|------|
| Frontend | Bun + TypeScript + Vite + React Flow |
| Backend | Python + FastAPI + uvicorn |
| Simulation | cocotb + Icarus Verilog |
| Verilog | 從學習 repo 複製 i2c_master.v / i2c_slave.v / i2c_top.v |

---

## Phase 1：Verilog 修改與 cocotb 基礎層

### 1-1. Slave register file 擴展至 256 bytes

- `reg [7:0] register_file [0:255]`
- reg_addr 改為可 auto-increment wrap 到 255
- 行為對齊 EEPROM（如 AT24C02）

### 1-2. cocotb Transaction Driver

建立 `i2c_driver.py`，封裝 transaction-level 操作：

```python
class I2CDriver:
    def __init__(self, dut):
        self.dut = dut

    async def reset(self):
        """系統 reset"""

    async def write_bytes(self, addr: int, reg: int, data: list[int]):
        """寫入 N bytes 到指定 register（reg pointer + data）"""

    async def read_bytes(self, addr: int, reg: int, n: int) -> list[int]:
        """寫 reg pointer 後讀回 N bytes"""

    async def scan(self, addr: int) -> bool:
        """測試某 address 是否有 slave（送 write transaction 檢查 ACK）"""

    async def delay(self, cycles: int):
        """等待 N clock cycles"""

    async def get_register_dump(self) -> dict:
        """讀取 slave 內部 register file 狀態（debug 用）"""
```

### 1-3. cocotb Test Runner

建立 `test_runner.py`，可接收 JSON 格式的測試序列並動態執行：

```python
# 輸入格式範例
[
    {"op": "reset"},
    {"op": "write_bytes", "addr": "0x50", "reg": "0x00", "data": ["0xA5", "0xB6"]},
    {"op": "delay", "cycles": 100},
    {"op": "read_bytes", "addr": "0x50", "reg": "0x00", "n": 2,
     "expect": ["0xA5", "0xB6"]},
    {"op": "scan", "addr": "0x50", "expect": true}
]
```

輸出格式：

```python
{
    "passed": true,
    "steps": [
        {"op": "reset", "status": "ok"},
        {"op": "write_bytes", "status": "ok", "ack_error": false},
        {"op": "delay", "status": "ok"},
        {"op": "read_bytes", "status": "ok", "data": ["0xA5", "0xB6"], "match": true},
        {"op": "scan", "status": "ok", "found": true, "match": true}
    ],
    "register_dump": {"0x00": "0xA5", "0x01": "0xB6", ...},
    "vcd_path": "/path/to/waveform.vcd"
}
```

---

## Phase 2：FastAPI 後端

### 2-1. API Endpoints

```
POST /api/run          接收測試序列 JSON，執行 simulation，回傳結果
GET  /api/templates    取得預設測試範本列表
GET  /api/waveform/:id 取得 VCD 波形檔（或轉換後的格式）
GET  /api/health       健康檢查
```

### 2-2. 執行流程

1. 收到 POST /api/run 的測試序列
2. 將 JSON 序列寫入暫存檔（或 inline 產生 cocotb test）
3. 呼叫 cocotb runner 執行 simulation（subprocess）
4. 解析 results.xml + 自訂 JSON output
5. 回傳結果

### 2-3. 注意事項

- Simulation 是 blocking 且耗時，考慮用 `asyncio.subprocess` 非同步執行
- 需要 cleanup 暫存的 VCD / build 檔案
- 可加 timeout 防止 simulation hang

---

## Phase 3：React Flow 前端

### 3-1. Node 類型

| Node 類型 | 說明 | 可設定參數 |
|-----------|------|------------|
| Reset | 系統 reset | - |
| Write | 寫入 bytes | addr, reg, data[] |
| Read | 讀取 bytes | addr, reg, n, expect[] (optional) |
| Scan | 掃描 address | addr, expect (optional) |
| Delay | 等待 | cycles |
| Check Register | 檢查 register 值 | addr, reg, expected |

### 3-2. 介面設計

- 左側 sidebar：可拖拉的 node 類型列表
- 中央 canvas：React Flow 畫布，拖入 node 後連線定義執行順序
- 右側 panel：選中 node 的參數編輯
- 下方 result panel：執行結果顯示（每個 step 的 pass/fail、register dump）
- 執行按鈕：將 flow 序列化為 JSON 送到後端

### 3-3. 序列化

React Flow 的 nodes + edges 轉換為 Phase 1 定義的 JSON 測試序列：
- 按照 edge 的拓撲排序決定執行順序
- 每個 node 的參數對應到 operation 的欄位

---

## Phase 4：擴展功能

### 4-1. Multi-Slave 支援

- i2c_top.v 加入第二個 slave instance（不同 address）
- 前端可選擇目標 slave
- 可測試 address 衝突、bus arbitration 情境

### 4-2. 溫度感測器模擬

- 新增 `i2c_temp_sensor.v`，行為模擬 LM75 / TMP102
- 固定幾個 register：溫度值、config、上下限
- 前端可設定模擬溫度值，讀回時驗證格式

### 4-3. Waveform 顯示（進階）

- 前端整合 waveform viewer（如 d3-wave 或自製簡易版）
- 或提供 VCD 下載讓使用者用 Surfer 開啟

---

## 專案結構（新 repo）

```
i2c-demo/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI entry
│   │   ├── routes/
│   │   │   └── simulation.py    # API endpoints
│   │   ├── services/
│   │   │   └── runner.py        # cocotb subprocess 管理
│   │   └── templates/           # 預設測試範本 JSON
│   ├── sim/
│   │   ├── rtl/                 # Verilog 設計檔（複製自學習 repo）
│   │   │   ├── i2c_master.v
│   │   │   ├── i2c_slave.v
│   │   │   └── i2c_top.v
│   │   ├── tb/
│   │   │   └── i2c_wrapper.v    # cocotb wrapper
│   │   ├── i2c_driver.py        # transaction-level driver
│   │   └── test_runner.py       # 動態測試執行器
│   ├── requirements.txt
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── FlowCanvas.tsx   # React Flow 主畫布
│   │   │   ├── Sidebar.tsx      # Node 類型列表
│   │   │   ├── NodeEditor.tsx   # 參數編輯 panel
│   │   │   ├── ResultPanel.tsx  # 結果顯示
│   │   │   └── nodes/           # 自訂 node components
│   │   │       ├── ResetNode.tsx
│   │   │       ├── WriteNode.tsx
│   │   │       ├── ReadNode.tsx
│   │   │       ├── ScanNode.tsx
│   │   │       └── DelayNode.tsx
│   │   ├── lib/
│   │   │   ├── api.ts           # 後端 API client
│   │   │   └── serialize.ts     # flow → JSON 序列化
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   └── tsconfig.json
├── README.md
└── docker-compose.yml           # optional，方便部署
```

---

## 實作順序建議

1. **Phase 1** → 先在本地驗證 cocotb driver + JSON test runner 可以正確跑
2. **Phase 2** → 包成 FastAPI，確認 API 可以觸發 simulation 並回傳結果
3. **Phase 3** → 做前端，先用固定 node 測 API 串接，再做完整拖拉體驗
4. **Phase 4** → 功能穩定後再擴展 multi-slave / sensor
