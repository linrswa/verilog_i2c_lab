> **English version**: [03-backend-api.md](../03-backend-api.md)

# 後端 API：FastAPI 模擬伺服器參考文件

## 摘要

- FastAPI 應用程式（`backend/app/main.py:27`）在 `/api` 下掛載兩個路由器，並在啟動時啟動一個背景 VCD TTL 清理任務（`main.py:17`）。
- 公開六個 REST 端點：`POST /api/run`、`GET /api/waveform/{id}`、`GET /api/waveform/{id}/signals`、`GET /api/templates`、`GET /api/templates/{id}` 以及 `GET /api/health`。
- `SimulationService.run_simulation()`（`backend/app/services/runner.py:106`）是模擬的唯一非同步進入點；它使用 `asyncio.Lock` 來序列化並行操作，透過暫存 JSON 檔案與子程序進行通訊，並使用基於 mtime 的建置快取來在 RTL 原始碼未變更時跳過重新編譯。
- 模擬器產生的 VCD 檔案會被複製到 `/tmp/i2c-sim-waveforms/{uuid}.vcd`，並透過 `GET /api/waveform/{id}/signals` 提供存取；檔案會在可設定的 TTL（預設 30 分鐘）後由背景任務刪除（`backend/app/services/waveform.py:82`）。
- 協定層級的步驟（`start`、`send_byte` 等）會在子程序啟動前，使用從 `sim.protocol_interpreter` 匯入的 `validate_protocol_sequence()` 進行結構驗證（`backend/app/routes/simulation.py:14,122`）。

---

## 1. 概觀

後端是一個 FastAPI 應用程式，作為 React Flow 前端與 cocotb 模擬子程序之間的橋樑。其職責包括：

1. **請求驗證** — Pydantic 模型在產生任何模擬成本之前，就會拒絕格式錯誤的步驟酬載。
2. **子程序協調** — `SimulationService` 透過 `asyncio.create_subprocess_exec` 啟動 `test_runner.py`，使用暫存 JSON 檔案傳遞輸入並收集輸出。
3. **建置快取管理** — RTL 原始碼的 `mtime` 值會在記憶體中追蹤，以抑制不必要的 Verilator 重新編譯。
4. **VCD 儲存與提供** — 波形檔案以 UUID 名稱管理在 `/tmp/i2c-sim-waveforms/` 下，並具備基於 TTL 的清理機制。
5. **範本提供** — 預建的 JSON 步驟序列從 `backend/sim/templates/` 載入，並作為唯讀 API 資源公開。

### 模組邊界

| 層級 | 匯入方式 | 依據 |
|-------|-------------|----------|
| `backend/app/` | `from sim.<module> import ...` | `backend/app/routes/simulation.py:14` |
| `backend/sim/` | 裸匯入（`from i2c_driver import ...`） | 以 `cwd=backend/sim/` 執行，見 `runner.py:229` |

後端**絕不**直接匯入 cocotb；所有模擬邏輯都在子程序中執行。

### 並行模型

`SimulationService.__init__`（`runner.py:71`）中的單一 `asyncio.Lock`（`_sim_lock`）意味著同一時間只能執行一個模擬。等待鎖超過 `QUEUE_TIMEOUT = 120` 秒的請求會收到 HTTP 503（`runner.py:35,148`）。模擬子程序本身若未在 `DEFAULT_TIMEOUT = 60` 秒內完成，則會被終止（`runner.py:31,242`）。

---

## 2. 資料流

```mermaid
sequenceDiagram
    participant FE as Frontend (React)
    participant RT as POST /api/run (simulation.py)
    participant SVC as SimulationService (runner.py)
    participant SUB as test_runner.py (subprocess)
    participant WV as waveform.py
    participant VCD as /tmp/i2c-sim-waveforms/

    FE->>RT: POST /api/run { "steps": [...] }
    Note over RT: Pydantic validation (StepModel)<br/>Protocol structural check via<br/>validate_protocol_sequence()
    RT->>WV: allocate_vcd_path() → (uuid, path)
    RT->>SVC: run_simulation(raw_steps)

    Note over SVC: Acquire asyncio.Lock (FIFO)<br/>Write {"steps":[...]} → tmp_input_*.json<br/>Decide --skip-build (mtime cache)
    SVC->>SUB: asyncio.create_subprocess_exec<br/>sys.executable test_runner.py<br/>--input tmp_input_*.json<br/>--output tmp_output_*.json [--skip-build]

    SUB-->>SVC: Exit; tmp_output_*.json written
    SVC-->>RT: Parsed result dict
    Note over RT: shutil.copy2(sim_vcd_path, uuid.vcd)
    RT->>VCD: {uuid}.vcd stored
    RT-->>FE: RunResponse { passed, steps, register_dump,<br/>reg_pointer, waveform_id, sim_time_total_ps }

    FE->>RT: GET /api/waveform/{uuid}/signals?signals=scl,sda
    RT->>VCD: vcd_path_for(uuid)
    RT->>RT: parse_vcd(path, signal_names)
    RT-->>FE: WaveformSignalsResponse { timescale, end_time, signals }
```

### IPC 與儲存細節

| 邊界 | 協定 / 格式 | 依據 |
|----------|------------------|----------|
| Frontend → FastAPI | HTTP POST JSON `{ "steps": [...] }` | `backend/app/routes/simulation.py:100` |
| FastAPI → 子程序 | `asyncio.create_subprocess_exec` + 兩個暫存 `.json` 檔案 | `runner.py:224-229` |
| 輸入暫存檔案 | `{ "steps": [ {"op": "...", ...} ] }` | `runner.py:161` |
| 輸出暫存檔案 | `{ "passed", "steps", "register_dump", "reg_pointer", "vcd_path", "sim_time_total_ps" }` | `runner.py:250`（讀回） |
| VCD 複製 | `shutil.copy2(sim_dir / vcd_path, waveform_path)` | `simulation.py:157` |
| VCD 儲存路徑 | `/tmp/i2c-sim-waveforms/{uuid}.vcd` | `waveform.py:22-23` |
| VCD TTL 清理 | 背景任務，每 5 分鐘執行，30 分鐘 TTL | `waveform.py:17,14` |
| Signals API | `GET /api/waveform/{id}/signals?signals=scl,sda` | `simulation.py:209` |

---

## 3. 程式碼對照表

| 元件 | File Path | Evidence Location | 說明 |
|-----------|-----------|-------------------|-------------|
| FastAPI 應用程式與生命週期 | `backend/app/main.py` | `:14,27` | 建立 `FastAPI` 實例，使用 `/api` 前綴掛載兩個路由器，啟動時啟動 VCD 清理任務，關閉時取消該任務 |
| CORS 中介軟體 | `backend/app/main.py` | `:34-40` | `CORSMiddleware` 設定 `allow_origins=["*"]`；開發環境中前端在不同埠執行時需要此設定 |
| 健康檢查 | `backend/app/main.py` | `:46-49` | `GET /api/health` 回傳 `{"status": "ok"}`；無依賴 |
| `StepModel` | `backend/app/routes/simulation.py` | `:39-53` | 單一步驟的 Pydantic 模型；`op` 欄位根據 `_VALID_OPS` frozenset 驗證；透過 `model_config = {"extra": "allow"}` 允許額外欄位 |
| `RunRequest` / `RunResponse` | `backend/app/routes/simulation.py` | `:56-77` | 請求：`steps: list[StepModel]`（非空）。回應：`passed`、`steps`、`register_dump`、`reg_pointer`、`waveform_id`、`sim_time_total_ps` |
| `WaveformSignalsResponse` / `SignalData` | `backend/app/routes/simulation.py` | `:80-92` | 信號端點的回應模型：`timescale` 字串、以皮秒為單位的 `end_time`、`signals` 字典將葉節點名稱對應至 `{width, changes}` |
| `run_simulation` 路由 | `backend/app/routes/simulation.py` | `:100-169` | `POST /api/run` 處理器：驗證協定操作、分配 UUID、呼叫 `SimulationService`、複製 VCD、回傳 `RunResponse` |
| `download_waveform` 路由 | `backend/app/routes/simulation.py` | `:177-200` | `GET /api/waveform/{id}`：UUID 格式檢查防止路徑遍歷攻擊；以 `application/octet-stream` 提供檔案 |
| `get_waveform_signals` 路由 | `backend/app/routes/simulation.py` | `:209-256` | `GET /api/waveform/{id}/signals`：可選的 `signals` 查詢參數（以逗號分隔）；委派給 `parse_vcd()` |
| `SimulationService` | `backend/app/services/runner.py` | `:45-71` | 在模組層級實例化的單例；擁有 `_sim_lock`（asyncio.Lock）和用於建置快取的 `_last_compile_mtime` |
| `SimulationService.run_simulation()` | `backend/app/services/runner.py` | `:106-173` | 以 `QUEUE_TIMEOUT=120s` 取得鎖；寫入暫存輸入 JSON；呼叫 `_invoke_runner`；在 `finally` 區塊中保證暫存檔案清理 |
| `SimulationService._invoke_runner()` | `backend/app/services/runner.py` | `:179-266` | 透過 `_needs_compile()` 解析 `--skip-build`；使用 `sys.executable` 建置 `cmd`；以 `asyncio.create_subprocess_exec` 啟動子程序；強制 `DEFAULT_TIMEOUT=60s` |
| `SimulationService._needs_compile()` | `backend/app/services/runner.py` | `:93-104` | 首次執行或監看的 RTL 檔案最大 mtime 超過 `_last_compile_mtime` 時回傳 `True` |
| `_RTL_SOURCES` | `backend/app/services/runner.py` | `:24-28` | 監看的檔案：`i2c_master.v`、`i2c_slave.v`、`i2c_top.v`；`i2c_system_wrapper.v` **未**被監看（見疑難排解） |
| `parse_vcd()` | `backend/app/services/vcd_parser.py` | `:60-160` | 透過 `vcdvcd.VCDVCD` 開啟 VCD；對應葉節點信號名稱；使用 `Decimal` 算術將所有時間戳轉換為皮秒；驗證請求的信號名稱 |
| `allocate_vcd_path()` | `backend/app/services/waveform.py` | `:32-39` | 產生 UUID；回傳 `(waveform_id, Path)` 但不建立檔案 |
| `vcd_path_for()` | `backend/app/services/waveform.py` | `:27-29` | 解析 `{tmpdir}/i2c-sim-waveforms/{uuid}.vcd` |
| `start_cleanup_task()` | `backend/app/services/waveform.py` | `:82-88` | 將 `_cleanup_loop` 排程為 `asyncio.Task`；必須在執行中的事件迴圈內呼叫 |
| `_delete_expired_vcds()` | `backend/app/services/waveform.py` | `:42-62` | 在波形目錄中以 glob 搜尋 `*.vcd`；刪除 `st_mtime` 年齡超過 `_VCD_TTL_SECONDS` 的檔案 |
| `list_templates()` | `backend/app/services/templates.py` | `:43-48` | 回傳記憶體中快取的範本摘要（不含 `steps` 鍵）；首次呼叫時從磁碟載入一次 |
| `get_template()` | `backend/app/services/templates.py` | `:51-77` | 每次呼叫時從 `backend/sim/templates/` 讀取個別的 `{template_id}.json`；回傳包含 `steps` 的完整字典 |
| 範本路由器 | `backend/app/routes/templates.py` | `:12-24` | `GET /api/templates` 和 `GET /api/templates/{id}`；範本檔案不存在時回傳 404 |

---

## 4. 疑難排解

### 問題：`POST /api/run` 回傳 HTTP 503

**症狀**
- 瀏覽器收到 `503 Service Unavailable`，訊息為 `"Server is busy — request waited 120 seconds for the simulation queue"`。
- 來自一個或多個客戶端的多個並行請求。

**可能原因（按可能性排序）**
1. 模擬正在執行中（Verilator 編譯加上 cocotb 可能需要數秒）；後續請求會在 `asyncio.Lock` 後排隊。
2. 掛起的子程序持有鎖直到 60 秒的程序逾時觸發，使所有後續請求最多被阻塞 120 秒。

**檢查位置**
- 鎖逾時：`backend/app/services/runner.py:144-151`（對鎖取得使用 `asyncio.wait_for`）
- 佇列逾時常數：`runner.py:35`（`QUEUE_TIMEOUT = 120`）
- 路由錯誤處理：`backend/app/routes/simulation.py:135-136`

**修正方向**
- 降低 `runner.py:35` 的 `QUEUE_TIMEOUT` 以更快失敗。
- 啟用建置快取（透過 `runner.py:93-104` 的 mtime 自動運作）以減少每次請求的模擬耗時。

---

### 問題：`POST /api/run` 回傳 HTTP 500 — "produced no result JSON"

**症狀**
- 回應本體包含 `"Simulation subprocess exited with code N and produced no result JSON."`，後接 stderr 文字。
- 此次執行沒有可用的 VCD 檔案。

**可能原因（按可能性排序）**
1. 子程序使用了錯誤的 Python 直譯器（系統 Python 而非 `.venv`），導致 `import cocotb` 在啟動時失敗。
2. RTL 編譯因 `.v` 檔案的語法錯誤或缺少 Verilator 安裝而失敗。
3. `test_runner.py` 或其傳遞性依賴中的 Python 匯入錯誤。

**檢查位置**
- 子程序命令：`backend/app/services/runner.py:215-220`（使用 `sys.executable` — 必須指向 venv Python）
- Stderr 暴露：`runner.py:261-266`
- RTL 原始碼清單：`runner.py:24-28`

**修正方向**
- 務必從已啟動的 venv 啟動後端：`source .venv/bin/activate && cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000`。這確保 `runner.py:216` 的 `sys.executable` 是安裝了 cocotb 的 venv 直譯器。

---

### 問題：成功執行後 `GET /api/waveform/{id}` 或信號端點回傳 404

**症狀**
- `POST /api/run` 回傳的 `waveform_id` 立即用於後續 `GET` 請求，但伺服器回傳 404。
- 前端的波形面板未顯示信號。

**可能原因（按可能性排序）**
1. 從 `sim_build/` 到受管儲存區的 VCD 複製靜默失敗（在 `simulation.py:158-159` 捕獲的 `OSError`）；波形 UUID 已發出，但檔案從未寫入。
2. 模擬器未產生 VCD 輸出 — Verilator 未以 `--trace` 建置，或結果 JSON 中的 `sim_vcd_path` 為 `None`（`simulation.py:151`）。
3. 檔案已過期並被 TTL 清理任務刪除（預設 30 分鐘）。

**檢查位置**
- VCD 複製區塊：`backend/app/routes/simulation.py:151-160`
- 清理 TTL：`backend/app/services/waveform.py:14`（`VCD_TTL_MINUTES` 環境變數）
- 清理迴圈：`waveform.py:65-79`

**修正方向**
- 在複製步驟之前，檢查 `result["vcd_path"]` 是否為非 None 且檔案存在於 `backend/sim/sim_build/` 下。
- 透過 `VCD_TTL_MINUTES` 環境變數增加 TTL（例如 `export VCD_TTL_MINUTES=120`）。
- 驗證 `test_runner.py:948-956` 中的 Verilator 建置旗標包含 `--trace`。

---

### 問題：建置快取過時 — 編輯 `.v` 檔案後模擬仍使用舊的 RTL

**症狀**
- 修改 Verilog 原始碼檔案後，模擬結果仍反映先前的 RTL 行為。
- 日誌顯示 `--skip-build` 被傳遞給子程序。

**可能原因（按可能性排序）**
1. 修改的檔案不在 `_RTL_SOURCES` 監看清單中。例如，`i2c_system_wrapper.v`（測試平台頂層）**未**被監看（`runner.py:24-28`）。
2. 檔案的 `mtime` 未更新（例如從備份還原時保留了原始時間戳）。

**檢查位置**
- 監看清單：`backend/app/services/runner.py:24-28`
- 快取決策：`runner.py:93-104`（`_needs_compile`、`_current_rtl_mtime`）
- Skip-build 旗標注入：`runner.py:221-222`

**修正方向**
- 若 wrapper 的變更也應使快取失效，請將 `i2c_system_wrapper.v` 加入 `runner.py:24-28` 的 `_RTL_SOURCES`：
  ```python
  _RTL_SOURCES: list[pathlib.Path] = [
      _SIM_DIR / "rtl" / "i2c_master.v",
      _SIM_DIR / "rtl" / "i2c_slave.v",
      _SIM_DIR / "rtl" / "i2c_top.v",
      _SIM_DIR / "tb" / "i2c_system_wrapper.v",  # add here
  ]
  ```
- 或者 `touch` 被監看的檔案以強制更新 mtime：`touch backend/sim/rtl/i2c_top.v`。

---

### 問題：`GET /api/waveform/{id}/signals` 回傳 HTTP 400

**症狀**
- 回應本體：`"Signal(s) not found in VCD: ['clk']. Available signals: [...]"`。
- `signals` 查詢參數包含 VCD 中不存在的名稱。

**可能原因**
1. 信號名稱不匹配 — VCD 使用階層式參考如 `i2c_system_wrapper.dut.scl`；`parse_vcd` 只公開**葉節點**名稱（`scl`），而非完整路徑。
2. Verilator 特有的信號重新命名（例如內部信號可能被加上前綴或去重複化）。

**檢查位置**
- 葉節點名稱擷取：`backend/app/services/vcd_parser.py:31-37`（`_leaf_name()`）
- 未知信號錯誤路徑：`vcd_parser.py:121-127`
- 路由錯誤處理：`backend/app/routes/simulation.py:246-247`

**修正方向**
- 省略 `signals` 查詢參數以取得所有可用信號，然後檢查回傳的名稱以找到正確的葉節點名稱。

---

## 5. 擴展指南

### 新增 API 端點

**要新增的內容**：處理新資源或動作的新路由。

**需要修改的現有檔案**：

1. 將路由函式新增至 `backend/app/routes/simulation.py`（用於模擬相關資料）或 `backend/app/routes/templates.py`（用於範本資料）。若為新的資源領域，請依照 `templates.py` 的模式建立 `backend/app/routes/<resource>.py`（`routes/templates.py:1-24`）。
2. 在 `backend/app/main.py:42-43` 註冊新路由器：
   ```python
   # backend/app/main.py:42-43
   app.include_router(simulation_router, prefix="/api")
   app.include_router(templates_router, prefix="/api")
   # Add here:
   app.include_router(new_router, prefix="/api")
   ```
3. 依照 `runSimulation` 的模式，在 `frontend/src/lib/api.ts` 新增型別化的 fetch 函式。

**應遵循的模式**：所有路由使用 `response_model=` 進行自動序列化，並使用 FastAPI 內建的 `HTTPException` 回傳錯誤回應。UUID 格式的輸入在任何檔案系統存取之前會以 `uuid.UUID(id)` 驗證（見 `simulation.py:187-189`），以防止路徑遍歷攻擊。

---

### 將新的 RTL 原始碼檔案加入建置快取監看清單

**要新增的內容**：一個新的 `.v` 檔案，當變更時應觸發 Verilator 重新編譯。

**需要修改的現有檔案**：

`backend/app/services/runner.py:24-28` — 將新路徑附加至 `_RTL_SOURCES`：

```python
# backend/app/services/runner.py:24-28
_RTL_SOURCES: list[pathlib.Path] = [
    _SIM_DIR / "rtl" / "i2c_master.v",
    _SIM_DIR / "rtl" / "i2c_slave.v",
    _SIM_DIR / "rtl" / "i2c_top.v",
    # Add here:
    _SIM_DIR / "rtl" / "new_module.v",
]
```

同時更新 `backend/sim/test_runner.py` 的 `_VERILOG_SOURCES`（記載於 `docs/02-simulation.md` 擴展指南），以確保檔案被實際編譯。

---

### 新增測試範本

**要新增的內容**：`backend/sim/templates/` 下的新 JSON 檔案。

**要建立的新檔案**：`backend/sim/templates/{template_id}.json`，結構如下：

```json
{
  "name": "Human-readable name",
  "description": "What this sequence tests",
  "steps": [
    {"op": "start"},
    {"op": "send_byte", "data": "0xA0"},
    {"op": "stop"}
  ]
}
```

該範本會在下次請求時由 `get_template()`（`backend/app/services/templates.py:51-77`）原樣提供。`GET /api/templates/{id}`（從磁碟讀取）不需要重啟伺服器。然而，`GET /api/templates`（列表檢視）的快取存放在 `templates.py:12` 的記憶體中，**在伺服器重啟之前不會反映新檔案**。

參考實作：`backend/sim/templates/protocol_write.json`。

---

### 變更 VCD TTL 或儲存目錄

TTL 由 `VCD_TTL_MINUTES` 環境變數控制（`backend/app/services/waveform.py:14`）：

```python
# backend/app/services/waveform.py:14
_VCD_TTL_SECONDS = int(os.environ.get("VCD_TTL_MINUTES", "30")) * 60
```

若要使用不同的儲存目錄，請修改 `waveform.py:20-23` 的 `_waveform_dir()`：

```python
# backend/app/services/waveform.py:20-23
def _waveform_dir() -> Path:
    """Return the directory where VCD files are stored, creating it if needed."""
    base = Path(tempfile.gettempdir()) / "i2c-sim-waveforms"
    base.mkdir(parents=True, exist_ok=True)
    return base
```

`vcd_path_for()` 和 `allocate_vcd_path()` 都會呼叫 `_waveform_dir()`，因此修改這一個函式就能一致地更新所有路徑。

---

## 假設 / 待確認事項

- `假設：``list_templates()` 的記憶體快取（`backend/app/services/templates.py:12`）在執行中的伺服器程序期間永不失效。在執行階段新增範本檔案需要重啟伺服器才能在 `GET /api/templates` 中出現。這是在程式碼中觀察到的，但沒有註解確認這是刻意設計還是疏忽。
- `假設：`子程序輸出 JSON 中回傳的 VCD 檔名 `"i2c_system_cocotb.vcd"` 始終是純檔名（非絕對路徑），後端在 `simulation.py:154-155` 相對於 `_sim_dir` 解析它。沒有找到保證子程序始終使用此確切名稱的程式碼；VCD 檔名由 `test_runner.py` 中的 `VCD_FILENAME` 環境變數控制（記載於 `docs/02-simulation.md`）。

---

## 相關檔案索引

- `/home/linrswa/dev/verilog/i2c_lab/backend/app/main.py`
- `/home/linrswa/dev/verilog/i2c_lab/backend/app/routes/simulation.py`
- `/home/linrswa/dev/verilog/i2c_lab/backend/app/routes/templates.py`
- `/home/linrswa/dev/verilog/i2c_lab/backend/app/services/runner.py`
- `/home/linrswa/dev/verilog/i2c_lab/backend/app/services/vcd_parser.py`
- `/home/linrswa/dev/verilog/i2c_lab/backend/app/services/waveform.py`
- `/home/linrswa/dev/verilog/i2c_lab/backend/app/services/templates.py`
- `/home/linrswa/dev/verilog/i2c_lab/backend/sim/templates/protocol_write.json`
- `/home/linrswa/dev/verilog/i2c_lab/backend/sim/templates/protocol_write_read.json`
- `/home/linrswa/dev/verilog/i2c_lab/backend/sim/templates/repeated_start_read.json`
- `/home/linrswa/dev/verilog/i2c_lab/docs/00-architecture.md`
- `/home/linrswa/dev/verilog/i2c_lab/docs/02-simulation.md`
