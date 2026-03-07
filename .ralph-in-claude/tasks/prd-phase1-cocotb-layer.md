# PRD: Phase 1 - Verilog Modification & cocotb Foundation Layer

## 1. Introduction/Overview

Phase 1 建立 I2C Demo Platform 的 simulation 基礎層。包含三個核心工作：

1. 將現有 I2C slave 的 register file 擴展至 256 bytes（簡化版 EEPROM 行為）
2. 建立 cocotb transaction-level driver (`i2c_driver.py`)，封裝 I2C 操作
3. 建立 test runner (`test_runner.py`)，可接收 JSON 測試序列並執行 simulation，提供 CLI 入口

完成後，使用者可透過 CLI 餵入 JSON 測試檔案，自動執行 I2C simulation 並取得結構化結果。

## 2. Goals

- 擴展 i2c_slave.v 的 register file 至 256 bytes，支援 auto-increment address wrap
- 封裝 transaction-level cocotb driver，提供 reset / write / read / scan / delay / register dump 操作
- 建立 JSON-driven test runner，可從 CLI 執行測試並輸出結構化 JSON 結果
- 使用 cocotb runner Python API（非 Makefile）執行 simulation
- 通過完整測試組驗證所有功能正確

## 3. User Stories

### Phase 1: Verilog RTL 修改

#### US-001: Slave Register File 擴展至 256 bytes

**Description:** As a developer, I want the I2C slave to have a 256-byte register file with auto-increment wrap so that it behaves like a simplified EEPROM storage.

**Acceptance Criteria:**
- [ ] `i2c_slave.v` 的 register_file 改為 `reg [7:0] register_file [0:255]`
- [ ] reg_addr 改為 8-bit，write 時 auto-increment 並 wrap 回 0（addr 255 → 0）
- [ ] read 時同樣 auto-increment wrap
- [ ] 不模擬 page write boundary 或 write cycle delay（簡化版）
- [ ] 原有的 I2C protocol 行為（ACK/NACK、start/stop detection）不受影響
- [ ] 使用 iverilog 編譯無 error/warning

#### US-002: i2c_top.v 適配更新

**Description:** As a developer, I want i2c_top.v to correctly instantiate the updated slave module so that the system-level simulation works with 256-byte storage.

**Acceptance Criteria:**
- [ ] i2c_top.v 正確連接更新後的 i2c_slave
- [ ] cocotb wrapper (`i2c_system_wrapper.v`) 與 i2c_top.v 相容
- [ ] 整個 RTL hierarchy 可用 iverilog 成功編譯

### Phase 2: cocotb Transaction Driver

#### US-003: I2CDriver 基礎框架

**Description:** As a developer, I want a Python class `I2CDriver` that wraps cocotb DUT signals so that I can perform I2C operations at transaction level without manually toggling signals.

**Acceptance Criteria:**
- [ ] 建立 `backend/sim/i2c_driver.py`
- [ ] `I2CDriver.__init__(self, dut)` 正確取得 DUT reference
- [ ] `async def reset(self)` 執行系統 reset 並等待穩定
- [ ] `async def delay(self, cycles)` 等待指定 clock cycles
- [ ] 所有 async method 使用 cocotb `await` 語法

#### US-004: I2CDriver Write 操作

**Description:** As a developer, I want `write_bytes(addr, reg, data)` to write N bytes to the I2C slave so that I can programmatically store data.

**Acceptance Criteria:**
- [ ] `async def write_bytes(self, addr: int, reg: int, data: list[int])` 完成實作
- [ ] 正確設定 slave address、register pointer、data bytes
- [ ] 透過 DUT 信號觸發 I2C master 執行 write transaction
- [ ] 回傳是否收到 ACK（偵測 NACK error）
- [ ] 支援寫入 1-256 bytes

#### US-005: I2CDriver Read 操作

**Description:** As a developer, I want `read_bytes(addr, reg, n)` to read N bytes from the I2C slave so that I can verify stored data.

**Acceptance Criteria:**
- [ ] `async def read_bytes(self, addr: int, reg: int, n: int) -> list[int]` 完成實作
- [ ] 先寫入 register pointer（write transaction），再發 read transaction 讀回 data
- [ ] 正確處理 repeated start 或 stop-start 序列
- [ ] 回傳讀取的 byte list
- [ ] 支援讀取 1-256 bytes

#### US-006: I2CDriver Scan 與 Register Dump

**Description:** As a developer, I want `scan(addr)` and `get_register_dump()` utility methods for debugging.

**Acceptance Criteria:**
- [ ] `async def scan(self, addr: int) -> bool` 送出 write transaction 檢查 ACK
- [ ] 回傳 True 表示該 address 有 slave 回應，False 表示 NACK
- [ ] `async def get_register_dump(self) -> dict` 讀取 slave 內部 register_file 狀態
- [ ] register dump 透過直接存取 DUT hierarchy（`dut.slave.register_file`）取得

### Phase 3: Test Runner + CLI

#### US-007: JSON Test Sequence Parser

**Description:** As a developer, I want a test runner that parses JSON test sequences into executable cocotb operations so that tests can be defined declaratively.

**Acceptance Criteria:**
- [ ] 建立 `backend/sim/test_runner.py`
- [ ] 支援以下 operation types: `reset`, `write_bytes`, `read_bytes`, `scan`, `delay`
- [ ] 正確解析 hex string（如 `"0x50"`）為 integer
- [ ] `expect` 欄位為 optional，有提供時進行比對
- [ ] 無效的 operation type 回傳明確錯誤訊息

#### US-008: Test Runner 執行與結果輸出

**Description:** As a developer, I want the test runner to execute a parsed test sequence and produce structured JSON results so that I can programmatically check pass/fail.

**Acceptance Criteria:**
- [ ] 執行每個 step 並記錄 status (`ok` / `error`)
- [ ] read_bytes 結果包含 `data` 欄位（hex string list）
- [ ] 有 expect 時包含 `match` 欄位（boolean）
- [ ] scan 結果包含 `found` 欄位
- [ ] 最終結果包含 `passed`（全部 step 通過）、`steps`、`register_dump`、`vcd_path`
- [ ] 輸出格式符合 plan 中定義的 JSON schema

#### US-009: cocotb Runner Integration

**Description:** As a developer, I want test_runner.py to use cocotb's Python runner API to compile and execute simulation so that no Makefile is needed.

**Acceptance Criteria:**
- [ ] 使用 `cocotb.runner.get_runner("icarus")` 建立 runner
- [ ] 正確指定 RTL source files（i2c_master.v, i2c_slave.v, i2c_top.v）和 wrapper
- [ ] 產生 VCD waveform 檔案
- [ ] simulation 完成後可取得結果

#### US-010: CLI Entry Point

**Description:** As a developer, I want a CLI command `python test_runner.py --input test.json` to run tests from terminal so that I can validate the system without writing Python code.

**Acceptance Criteria:**
- [ ] 使用 argparse 提供 `--input` 參數接受 JSON 檔案路徑
- [ ] 可選 `--output` 參數指定結果輸出路徑（預設 stdout）
- [ ] 可選 `--vcd-dir` 參數指定 VCD 輸出目錄
- [ ] 執行完畢印出 JSON 結果
- [ ] 非零 exit code 表示測試失敗或執行錯誤

### Phase 4: 驗證測試

#### US-011: 完整測試組

**Description:** As a developer, I want a comprehensive test suite to verify all driver and runner functionality so that I can be confident the system works correctly.

**Acceptance Criteria:**
- [ ] 測試 write + read back 驗證（單 byte 和多 byte）
- [ ] 測試 address boundary（addr 0 和 addr 255）
- [ ] 測試 multi-byte burst write/read（連續多 bytes）
- [ ] 測試 address wrap-around（寫到 addr 255 後 wrap 回 0）
- [ ] 測試錯誤 address 的 NACK 回應
- [ ] 測試 scan 功能（存在與不存在的 address）
- [ ] 所有測試通過

#### US-012: 範例 JSON 測試檔案

**Description:** As a developer, I want 2-3 example JSON test files so that Phase 2 FastAPI integration has ready-made test data.

**Acceptance Criteria:**
- [ ] `backend/sim/templates/basic_write_read.json` - 基本 write + read back
- [ ] `backend/sim/templates/full_test.json` - 完整功能測試（所有 op types）
- [ ] `backend/sim/templates/stress_test.json` - boundary + burst + wrap-around 測試
- [ ] 每個 JSON 檔案格式符合 test runner 的 input schema
- [ ] 用 CLI 執行每個範例檔案都能通過

## 4. Functional Requirements

- FR-1: i2c_slave.v 必須支援 256-byte register file (`reg [7:0] register_file [0:255]`)
- FR-2: register address 在 write/read 時 auto-increment，到 255 後 wrap 回 0
- FR-3: I2CDriver 必須透過 cocotb DUT 信號驅動 I2C master 執行 transaction
- FR-4: I2CDriver.write_bytes 必須支援寫入 1-256 bytes 到指定 slave address + register
- FR-5: I2CDriver.read_bytes 必須先寫入 register pointer 再讀回指定數量的 bytes
- FR-6: I2CDriver.scan 必須能偵測指定 address 是否有 slave 回應
- FR-7: test_runner.py 必須能解析包含 reset/write_bytes/read_bytes/scan/delay 的 JSON 序列
- FR-8: test_runner.py 執行結果必須包含 passed、steps、register_dump、vcd_path
- FR-9: 每個 step 的 expect 欄位為 optional，有提供時進行比對並記錄 match 結果
- FR-10: CLI 必須支援 `--input` 參數讀取 JSON 檔案並執行 simulation
- FR-11: simulation 必須使用 cocotb runner Python API（非 Makefile subprocess）
- FR-12: simulation 執行必須產生 VCD waveform 檔案

## 5. Non-Goals (Out of Scope)

- 不模擬 AT24C02 的 page write boundary（8-byte limit）
- 不模擬 write cycle delay（5ms）或 write-in-progress NACK
- 不建立 FastAPI 後端（Phase 2 範圍）
- 不建立前端 UI（Phase 3 範圍）
- 不支援 multi-slave topology（Phase 4 範圍）
- 不實作 Makefile-based simulation flow
- 不處理 I2C clock stretching 或 bus arbitration

## 6. Technical & Design Considerations

### 檔案結構
```
backend/sim/
├── rtl/
│   ├── i2c_master.v        # 現有，不修改
│   ├── i2c_slave.v         # 修改：256-byte register file
│   └── i2c_top.v           # 可能需要適配
├── tb/
│   ├── i2c_system_wrapper.v  # cocotb wrapper
│   └── i2c_system_tb.v      # 參考用
├── templates/
│   ├── basic_write_read.json
│   ├── full_test.json
│   └── stress_test.json
├── i2c_driver.py           # transaction-level driver
├── test_runner.py          # JSON test runner + CLI
└── tests/                  # cocotb test module
    └── test_i2c_cocotb.py  # cocotb test entry point
```

### 依賴
- Python 3.9+
- cocotb >= 2.0
- Icarus Verilog (iverilog)

### 注意事項
- cocotb runner API 在 cocotb 2.0 後為穩定 API，使用 `cocotb.runner.get_runner("icarus")`
- I2CDriver 需要了解現有 i2c_master.v 的控制信號介面（cmd, data_in, addr 等）
- VCD 檔案可能很大，考慮只 dump 必要信號

## 7. Success Metrics

- 所有 12 個 user stories 的 acceptance criteria 全部通過
- CLI 執行 3 個範例 JSON 測試檔案全部 PASS
- iverilog 編譯無 error/warning
- cocotb simulation 可在 30 秒內完成單次測試序列

## 8. Open Questions

- 現有 i2c_master.v 的控制信號介面是否需要修改以支援 burst write/read？（需讀取原始碼確認）
- cocotb wrapper 是否需要更新以暴露更多 internal signals 給 register dump？
- cocotb runner API 在當前安裝的 cocotb 版本中是否可用？（需確認版本）
