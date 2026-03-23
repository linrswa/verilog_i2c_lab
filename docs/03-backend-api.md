> **中文版**: [03-backend-api.md](zh-TW/03-backend-api.md)

# Backend API: FastAPI Simulation Server Reference

## TL;DR

- The FastAPI application (`backend/app/main.py:27`) mounts two routers under `/api` and starts a background VCD TTL cleanup task on startup (`main.py:17`).
- Six REST endpoints are exposed: `POST /api/run`, `GET /api/waveform/{id}`, `GET /api/waveform/{id}/signals`, `GET /api/templates`, `GET /api/templates/{id}`, and `GET /api/health`.
- `SimulationService.run_simulation()` (`backend/app/services/runner.py:106`) is the single async entry point for simulation; it serialises concurrency with an `asyncio.Lock`, communicates with the subprocess exclusively through temporary JSON files, and applies an mtime-based build cache to skip recompilation when RTL sources are unchanged.
- VCD files produced by the simulator are copied to `/tmp/i2c-sim-waveforms/{uuid}.vcd` and served through `GET /api/waveform/{id}/signals`; files are deleted after a configurable TTL (default 30 minutes) by a background task (`backend/app/services/waveform.py:82`).
- Protocol-level steps (`start`, `send_byte`, etc.) are structurally validated before the subprocess is launched using `validate_protocol_sequence()` imported from `sim.protocol_interpreter` (`backend/app/routes/simulation.py:14,122`).

---

## 1. Overview

The backend is a FastAPI application that bridges the React Flow frontend and the cocotb simulation subprocess. Its responsibilities are:

1. **Request validation** — Pydantic models reject malformed step payloads before any simulation cost is incurred.
2. **Subprocess orchestration** — `SimulationService` spawns `test_runner.py` via `asyncio.create_subprocess_exec`, passing input and collecting output through temporary JSON files.
3. **Build-cache management** — RTL source `mtime` values are tracked in memory to suppress redundant Verilator recompilations.
4. **VCD storage and serving** — waveform files are managed under `/tmp/i2c-sim-waveforms/` with UUID names and TTL-based cleanup.
5. **Template serving** — pre-built JSON step sequences are loaded from `backend/sim/templates/` and exposed as read-only API resources.

### Module boundaries

| Layer | Import style | Evidence |
|-------|-------------|----------|
| `backend/app/` | `from sim.<module> import ...` | `backend/app/routes/simulation.py:14` |
| `backend/sim/` | bare imports (`from i2c_driver import ...`) | runs with `cwd=backend/sim/` per `runner.py:229` |

The backend **never** imports cocotb directly; all simulation logic runs in the subprocess.

### Concurrency model

A single `asyncio.Lock` (`_sim_lock`) in `SimulationService.__init__` (`runner.py:71`) means only one simulation runs at a time. Requests that wait longer than `QUEUE_TIMEOUT = 120` seconds for the lock receive HTTP 503 (`runner.py:35,148`). The simulation subprocess itself is killed if it does not complete within `DEFAULT_TIMEOUT = 60` seconds (`runner.py:31,242`).

---

## 2. Data Flow

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

### IPC and storage details

| Boundary | Protocol / Format | Evidence |
|----------|------------------|----------|
| Frontend → FastAPI | HTTP POST JSON `{ "steps": [...] }` | `backend/app/routes/simulation.py:100` |
| FastAPI → subprocess | `asyncio.create_subprocess_exec` + two temp `.json` files | `runner.py:224-229` |
| Input temp file | `{ "steps": [ {"op": "...", ...} ] }` | `runner.py:161` |
| Output temp file | `{ "passed", "steps", "register_dump", "reg_pointer", "vcd_path", "sim_time_total_ps" }` | `runner.py:250` (read back) |
| VCD copy | `shutil.copy2(sim_dir / vcd_path, waveform_path)` | `simulation.py:157` |
| VCD storage path | `/tmp/i2c-sim-waveforms/{uuid}.vcd` | `waveform.py:22-23` |
| VCD TTL cleanup | background task, every 5 min, 30 min TTL | `waveform.py:17,14` |
| Signals API | `GET /api/waveform/{id}/signals?signals=scl,sda` | `simulation.py:209` |

---

## 3. Code Map

| Component | File Path | Evidence Location | Description |
|-----------|-----------|-------------------|-------------|
| FastAPI app & lifespan | `backend/app/main.py` | `:14,27` | Creates the `FastAPI` instance, mounts both routers with `/api` prefix, starts the VCD cleanup task on startup and cancels it on shutdown |
| CORS middleware | `backend/app/main.py` | `:34-40` | `CORSMiddleware` with `allow_origins=["*"]`; required for development where frontend runs on a different port |
| Health check | `backend/app/main.py` | `:46-49` | `GET /api/health` returns `{"status": "ok"}`; no dependencies |
| `StepModel` | `backend/app/routes/simulation.py` | `:39-53` | Pydantic model for one step; `op` field validated against `_VALID_OPS` frozenset; extra fields allowed via `model_config = {"extra": "allow"}` |
| `RunRequest` / `RunResponse` | `backend/app/routes/simulation.py` | `:56-77` | Request: `steps: list[StepModel]` (non-empty). Response: `passed`, `steps`, `register_dump`, `reg_pointer`, `waveform_id`, `sim_time_total_ps` |
| `WaveformSignalsResponse` / `SignalData` | `backend/app/routes/simulation.py` | `:80-92` | Response model for signals endpoint: `timescale` string, `end_time` in picoseconds, `signals` dict mapping leaf name → `{width, changes}` |
| `run_simulation` route | `backend/app/routes/simulation.py` | `:100-169` | `POST /api/run` handler: validates protocol ops, allocates UUID, calls `SimulationService`, copies VCD, returns `RunResponse` |
| `download_waveform` route | `backend/app/routes/simulation.py` | `:177-200` | `GET /api/waveform/{id}`: UUID format check prevents path traversal; serves file as `application/octet-stream` |
| `get_waveform_signals` route | `backend/app/routes/simulation.py` | `:209-256` | `GET /api/waveform/{id}/signals`: optional `signals` query param (comma-separated); delegates to `parse_vcd()` |
| `SimulationService` | `backend/app/services/runner.py` | `:45-71` | Singleton instantiated at module level; owns `_sim_lock` (asyncio.Lock) and `_last_compile_mtime` for build caching |
| `SimulationService.run_simulation()` | `backend/app/services/runner.py` | `:106-173` | Acquires lock with `QUEUE_TIMEOUT=120s`; writes temp input JSON; calls `_invoke_runner`; guarantees temp file cleanup in `finally` block |
| `SimulationService._invoke_runner()` | `backend/app/services/runner.py` | `:179-266` | Resolves `--skip-build` via `_needs_compile()`; builds `cmd` with `sys.executable`; spawns subprocess with `asyncio.create_subprocess_exec`; enforces `DEFAULT_TIMEOUT=60s` |
| `SimulationService._needs_compile()` | `backend/app/services/runner.py` | `:93-104` | Returns `True` on first run or when max mtime of watched RTL files exceeds `_last_compile_mtime` |
| `_RTL_SOURCES` | `backend/app/services/runner.py` | `:24-28` | Watched files: `i2c_master.v`, `i2c_slave.v`, `i2c_top.v`; `i2c_system_wrapper.v` is **not** watched (see Troubleshooting) |
| `parse_vcd()` | `backend/app/services/vcd_parser.py` | `:60-160` | Opens VCD via `vcdvcd.VCDVCD`; maps leaf signal names; converts all timestamps to picoseconds using `Decimal` arithmetic; validates requested signal names |
| `allocate_vcd_path()` | `backend/app/services/waveform.py` | `:32-39` | Generates UUID; returns `(waveform_id, Path)` without creating the file |
| `vcd_path_for()` | `backend/app/services/waveform.py` | `:27-29` | Resolves `{tmpdir}/i2c-sim-waveforms/{uuid}.vcd` |
| `start_cleanup_task()` | `backend/app/services/waveform.py` | `:82-88` | Schedules `_cleanup_loop` as an `asyncio.Task`; must be called inside a running event loop |
| `_delete_expired_vcds()` | `backend/app/services/waveform.py` | `:42-62` | Globs `*.vcd` in the waveform dir; deletes files whose `st_mtime` age exceeds `_VCD_TTL_SECONDS` |
| `list_templates()` | `backend/app/services/templates.py` | `:43-48` | Returns in-memory cache of template summaries (no `steps` key); loaded once from disk on first call |
| `get_template()` | `backend/app/services/templates.py` | `:51-77` | Reads individual `{template_id}.json` from `backend/sim/templates/` on every call; returns full dict including `steps` |
| Templates router | `backend/app/routes/templates.py` | `:12-24` | `GET /api/templates` and `GET /api/templates/{id}`; 404 if template file absent |

---

## 4. Troubleshooting

### Problem: `POST /api/run` returns HTTP 503

**Symptoms**
- Browser receives `503 Service Unavailable` with `"Server is busy — request waited 120 seconds for the simulation queue"`.
- Multiple concurrent requests from one or more clients.

**Possible Causes (most likely first)**
1. A simulation is already running (Verilator compile + cocotb can take several seconds); subsequent requests queue behind the `asyncio.Lock`.
2. A hung subprocess is holding the lock until the 60-second process timeout fires, blocking all subsequent requests for up to 120 seconds total.

**Check Locations**
- Lock timeout: `backend/app/services/runner.py:144-151` (`asyncio.wait_for` on lock acquisition)
- Queue timeout constant: `runner.py:35` (`QUEUE_TIMEOUT = 120`)
- Route error handler: `backend/app/routes/simulation.py:135-136`

**Fix Direction**
- Reduce `QUEUE_TIMEOUT` at `runner.py:35` to fail faster.
- Enable build caching (automatic via mtime at `runner.py:93-104`) to reduce per-request simulation wall time.

---

### Problem: `POST /api/run` returns HTTP 500 — "produced no result JSON"

**Symptoms**
- Response body contains `"Simulation subprocess exited with code N and produced no result JSON."` followed by stderr text.
- No VCD file is available for this run.

**Possible Causes (most likely first)**
1. The subprocess was invoked with the wrong Python interpreter (system Python instead of `.venv`), so `import cocotb` fails at startup.
2. RTL compilation failed due to a syntax error in a `.v` file or a missing Verilator installation.
3. A Python import error in `test_runner.py` or its transitive dependencies.

**Check Locations**
- Subprocess command: `backend/app/services/runner.py:215-220` (uses `sys.executable` — must point to venv Python)
- Stderr exposure: `runner.py:261-266`
- RTL source list: `runner.py:24-28`

**Fix Direction**
- Always start the backend from the activated venv: `source .venv/bin/activate && cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000`. This ensures `sys.executable` at `runner.py:216` is the venv interpreter with cocotb installed.

---

### Problem: `GET /api/waveform/{id}` or signals endpoint returns 404 after a successful run

**Symptoms**
- `waveform_id` returned by `POST /api/run` is used immediately in a subsequent `GET` but the server returns 404.
- Waveform panel in the frontend shows no signals.

**Possible Causes (most likely first)**
1. The VCD copy from `sim_build/` to managed storage silently failed (caught `OSError` at `simulation.py:158-159`); the waveform UUID was issued but the file was never written.
2. The simulator produced no VCD output — Verilator was not built with `--trace`, or `sim_vcd_path` in the result JSON was `None` (`simulation.py:151`).
3. The file expired and was deleted by the TTL cleanup task (default 30 minutes).

**Check Locations**
- VCD copy block: `backend/app/routes/simulation.py:151-160`
- Cleanup TTL: `backend/app/services/waveform.py:14` (`VCD_TTL_MINUTES` env var)
- Cleanup loop: `waveform.py:65-79`

**Fix Direction**
- Check that `result["vcd_path"]` is non-None and the file exists under `backend/sim/sim_build/` before the copy step.
- Increase TTL via `VCD_TTL_MINUTES` environment variable (e.g., `export VCD_TTL_MINUTES=120`).
- Verify `--trace` is in the Verilator build flags in `test_runner.py:948-956`.

---

### Problem: Build cache is stale — simulation runs with old RTL after editing a `.v` file

**Symptoms**
- After modifying a Verilog source file, simulation results still reflect the previous RTL behaviour.
- Logs show `--skip-build` was passed to the subprocess.

**Possible Causes (most likely first)**
1. The modified file is not in the `_RTL_SOURCES` watch list. For example, `i2c_system_wrapper.v` (the testbench top) is **not** watched (`runner.py:24-28`).
2. The file's `mtime` was not updated (e.g., restored from a backup with the original timestamp).

**Check Locations**
- Watch list: `backend/app/services/runner.py:24-28`
- Cache decision: `runner.py:93-104` (`_needs_compile`, `_current_rtl_mtime`)
- Skip-build flag injection: `runner.py:221-222`

**Fix Direction**
- Add `i2c_system_wrapper.v` to `_RTL_SOURCES` in `runner.py:24-28` if wrapper changes should also invalidate the cache:
  ```python
  _RTL_SOURCES: list[pathlib.Path] = [
      _SIM_DIR / "rtl" / "i2c_master.v",
      _SIM_DIR / "rtl" / "i2c_slave.v",
      _SIM_DIR / "rtl" / "i2c_top.v",
      _SIM_DIR / "tb" / "i2c_system_wrapper.v",  # add here
  ]
  ```
- Alternatively, `touch` the watched file to force an mtime update: `touch backend/sim/rtl/i2c_top.v`.

---

### Problem: `GET /api/waveform/{id}/signals` returns HTTP 400

**Symptoms**
- Response body: `"Signal(s) not found in VCD: ['clk']. Available signals: [...]"`.
- The `signals` query parameter contains a name that does not exist in the VCD.

**Possible Causes**
1. Signal name mismatch — the VCD uses hierarchical references like `i2c_system_wrapper.dut.scl`; `parse_vcd` exposes only the **leaf** name (`scl`), not the full path.
2. Verilator-specific signal renaming (e.g., internal signals may be prefixed or deduplicated).

**Check Locations**
- Leaf name extraction: `backend/app/services/vcd_parser.py:31-37` (`_leaf_name()`)
- Unknown-signal error path: `vcd_parser.py:121-127`
- Route error handler: `backend/app/routes/simulation.py:246-247`

**Fix Direction**
- Omit the `signals` query parameter to retrieve all available signals, then inspect the returned names to find the correct leaf name.

---

## 5. Extension Guide

### Adding a new API endpoint

**What to add**: A new route handling a new resource or action.

**Existing files to modify**:

1. Add a route function to `backend/app/routes/simulation.py` (for simulation-related data) or `backend/app/routes/templates.py` (for template data). For a new resource domain, create `backend/app/routes/<resource>.py` following the pattern of `templates.py` (`routes/templates.py:1-24`).
2. Register the new router in `backend/app/main.py:42-43`:
   ```python
   # backend/app/main.py:42-43
   app.include_router(simulation_router, prefix="/api")
   app.include_router(templates_router, prefix="/api")
   # Add here:
   app.include_router(new_router, prefix="/api")
   ```
3. Add a typed fetch function to `frontend/src/lib/api.ts` following the pattern of `runSimulation`.

**Patterns to follow**: All routes use `response_model=` for automatic serialisation and FastAPI's built-in `HTTPException` for error responses. UUID-format inputs are validated with `uuid.UUID(id)` before any filesystem access (see `simulation.py:187-189`) to prevent path traversal.

---

### Adding a new RTL source file to the build-cache watch list

**What to add**: A new `.v` file that, when changed, should trigger a Verilator recompile.

**Existing files to modify**:

`backend/app/services/runner.py:24-28` — append the new path to `_RTL_SOURCES`:

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

Also update `backend/sim/test_runner.py` `_VERILOG_SOURCES` (documented in `docs/02-simulation.md` Extension Guide) so the file is actually compiled.

---

### Adding a new test template

**What to add**: A new JSON file under `backend/sim/templates/`.

**New file to create**: `backend/sim/templates/{template_id}.json` with the schema:

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

The template is served as-is by `get_template()` (`backend/app/services/templates.py:51-77`) on the next request. No server restart is required for `GET /api/templates/{id}` (reads from disk on every call). However, `GET /api/templates` (the list view) is cached in memory at `templates.py:12` and **will not reflect the new file until the server is restarted**.

Reference implementation: `backend/sim/templates/protocol_write.json`.

---

### Changing the VCD TTL or storage directory

The TTL is controlled by the `VCD_TTL_MINUTES` environment variable (`backend/app/services/waveform.py:14`):

```python
# backend/app/services/waveform.py:14
_VCD_TTL_SECONDS = int(os.environ.get("VCD_TTL_MINUTES", "30")) * 60
```

To use a different storage directory, modify `_waveform_dir()` at `waveform.py:20-23`:

```python
# backend/app/services/waveform.py:20-23
def _waveform_dir() -> Path:
    """Return the directory where VCD files are stored, creating it if needed."""
    base = Path(tempfile.gettempdir()) / "i2c-sim-waveforms"
    base.mkdir(parents=True, exist_ok=True)
    return base
```

Both `vcd_path_for()` and `allocate_vcd_path()` call `_waveform_dir()`, so changing that one function updates all paths consistently.

---

## Assumptions / To Be Confirmed

- `ASSUMPTION:` The `list_templates()` in-memory cache (`backend/app/services/templates.py:12`) is never invalidated during a running server process. Adding a template file at runtime requires a server restart for it to appear in `GET /api/templates`. This was observed in code but no comment confirms it is intentional design vs. an oversight.
- `ASSUMPTION:` The VCD filename `"i2c_system_cocotb.vcd"` returned as `vcd_path` in the subprocess output JSON is always a bare filename (not an absolute path), and the backend resolves it relative to `_sim_dir` at `simulation.py:154-155`. No code was found that guarantees the subprocess always uses this exact name; the VCD filename is controlled by the `VCD_FILENAME` environment variable in `test_runner.py` (documented in `docs/02-simulation.md`).

---

## Related Files Index

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
