# I2C Demo Platform — Roadmap

## 專案簡介

可視化 I2C 自動化測試平台。使用者在 React Flow 前端拖拉拼接 protocol-level 測試流程（START → SEND_BYTE → RECV_BYTE → STOP），後端透過 cocotb 2.0 驅動 Icarus Verilog simulation 執行，回傳測試結果與波形。

## 系統架構

```
┌─────────────────────────────────┐
│  Frontend (React Flow + Vite)   │
│  - Protocol-level node 拖拉     │
│  - 顯示執行結果 / EEPROM dump   │
│  - Bun + TypeScript             │
└──────────────┬──────────────────┘
               │ REST API (JSON)
┌──────────────▼──────────────────┐
│  Backend (FastAPI)              │
│  - 接收 protocol step 序列      │
│  - 執行 simulation (subprocess) │
│  - 回傳結果 + VCD              │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│  Simulation Layer (cocotb 2.0)  │
│  - i2c_top.v (master + slave)   │
│  - protocol interpreter         │
│  - 256-byte EEPROM slave        │
└─────────────────────────────────┘
```

## 技術選型

| 層級 | 技術 |
|------|------|
| Frontend | Bun + TypeScript + Vite + React Flow |
| Backend | Python + FastAPI + uvicorn |
| Simulation | cocotb 2.0 + Icarus Verilog |

---

## 已完成

- **Simulation 層**：I2CDriver（transaction-level + protocol-level）、ProtocolInterpreter、test_runner（JSON 驅動）、repeated start 支援、sequence validation
- **FastAPI 後端**：`POST /api/run`、`GET /api/waveform/{id}`（VCD 下載）、template API、VCD TTL cleanup
- **React Flow 前端**：Protocol-level nodes（Start, Stop, RepeatedStart, SendByte, RecvByte）、拓撲排序序列化、ResultPanel 右側 sidebar（step 結果 + EEPROM hex dump）

---

## 未來功能

### Waveform Viewer（網頁波形顯示）

詳細計畫見 [`waveform_support.md`](./waveform_support.md)。

核心目標：在網頁上用 SVG 繪製 SDA/SCL 波形，與 React Flow 的 step 做時間區間對齊，雙向 highlight 連動。

### Multi-Slave 支援

- `i2c_top.v` 加入第二個 slave instance（不同 address）
- 前端可選擇目標 slave
- 可測試 address 衝突、bus arbitration 情境

### 溫度感測器模擬

- 新增 `i2c_temp_sensor.v`，行為模擬 LM75 / TMP102
- 固定幾個 register：溫度值、config、上下限
- 前端可設定模擬溫度值，讀回時驗證格式
