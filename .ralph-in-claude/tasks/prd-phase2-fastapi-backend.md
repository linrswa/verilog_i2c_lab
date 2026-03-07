# PRD: Phase 2 — FastAPI Backend

## 1. Introduction/Overview

Phase 2 wraps the Phase 1 cocotb simulation layer in a FastAPI web service. Users (and the future React Flow frontend) submit JSON test sequences via REST API, the backend executes the I2C simulation via subprocess, and returns structured results plus downloadable VCD waveforms.

This phase bridges the gap between the CLI-based simulation runner and the visual frontend planned for Phase 3.

## 2. Goals

- Expose the Phase 1 test runner as a REST API that accepts JSON test sequences and returns structured results
- Provide pre-built test templates for quick experimentation
- Serve VCD waveform files for download with automatic cleanup
- Handle simulation lifecycle (compile caching, temp file management, error handling)
- Ensure the API is stable enough for Phase 3 frontend integration

## 3. User Stories

### Phase 1: Project Setup & Core Infrastructure

#### US-001: FastAPI Project Skeleton
**Description:** As a developer, I want a properly structured FastAPI project with dependencies so that I can start building API endpoints.

**Acceptance Criteria:**
- [ ] `backend/app/main.py` creates a FastAPI app with CORS middleware (allow all origins for dev)
- [ ] `backend/requirements.txt` includes fastapi, uvicorn, and any other dependencies
- [ ] `GET /api/health` returns `{"status": "ok"}`
- [ ] App can be started with `uvicorn app.main:app` from the `backend/` directory
- [ ] Typecheck/lint passes

#### US-002: Simulation Service — Core Execution
**Description:** As a backend service, I want to invoke the Phase 1 test runner as a subprocess so that API requests trigger real simulations.

**Acceptance Criteria:**
- [ ] `backend/app/services/runner.py` contains a `SimulationService` class
- [ ] `run_simulation(steps: list[dict])` method executes `test_runner.py` via `asyncio.create_subprocess_exec`
- [ ] Steps are passed via a temp JSON file (not env var — avoids shell length limits)
- [ ] Result JSON is read back from the temp file written by test_runner
- [ ] Returns a structured dict with `passed`, `steps`, `register_dump`, `vcd_path`
- [ ] Simulation timeout of 60 seconds (configurable); raises TimeoutError on expiry
- [ ] Temp files (input JSON, result JSON) are cleaned up after execution

#### US-003: Build Caching (Hybrid Compile)
**Description:** As a backend service, I want to cache the compiled Verilog binary and only recompile when RTL files change, so that repeated simulations are faster.

**Acceptance Criteria:**
- [ ] `SimulationService` checks mtime of all RTL source files against a stored timestamp
- [ ] If no RTL file has changed since last compile, skip the compile step and reuse the existing `sim_build/` binary
- [ ] If any RTL file changed, trigger a fresh compile before running
- [ ] First run always compiles
- [ ] Cache state is stored in memory (no persistence file needed — recompile on restart is fine)

#### US-004: Request Queue (Single Concurrency)
**Description:** As a backend service, I want to serialize simulation requests so that only one simulation runs at a time, preventing resource contention.

**Acceptance Criteria:**
- [ ] An `asyncio.Lock` guards the simulation execution path
- [ ] Concurrent requests wait in FIFO order (asyncio.Lock default behavior)
- [ ] If a request waits longer than 120 seconds for the lock, it returns HTTP 503 with a clear message
- [ ] The lock is released even if the simulation fails or times out

### Phase 2: API Endpoints

#### US-005: POST /api/run — Execute Simulation
**Description:** As an API consumer, I want to POST a JSON test sequence and receive the simulation results so that I can validate I2C behavior.

**Acceptance Criteria:**
- [ ] `POST /api/run` accepts a JSON body with a `steps` array (same format as Phase 1 JSON files)
- [ ] Request body is validated: `steps` must be a non-empty list, each step must have a valid `op`
- [ ] On success, returns HTTP 200 with the full result dict (`passed`, `steps`, `register_dump`, `waveform_id`)
- [ ] `waveform_id` is a UUID string that can be used with `GET /api/waveform/:id`
- [ ] On validation error, returns HTTP 422 with a descriptive error message
- [ ] On simulation failure (timeout, crash), returns HTTP 500 with error details
- [ ] On queue full/timeout, returns HTTP 503

#### US-006: GET /api/templates — List Test Templates
**Description:** As an API consumer, I want to list available test templates so that I can quickly run pre-built test sequences.

**Acceptance Criteria:**
- [ ] `GET /api/templates` returns a JSON array of template objects
- [ ] Each template object has: `id` (filename without extension), `name` (from JSON metadata or filename), `description` (from JSON metadata or empty), `step_count` (number of steps)
- [ ] Templates are loaded from `backend/sim/templates/*.json` (the Phase 1 template files)
- [ ] Response is cached in memory (reloaded on restart)

#### US-007: GET /api/templates/:id — Get Template Detail
**Description:** As an API consumer, I want to fetch a specific template's full content so that I can inspect or submit it to /api/run.

**Acceptance Criteria:**
- [ ] `GET /api/templates/{template_id}` returns the full JSON content of the template file
- [ ] Returns HTTP 404 if the template ID does not match any file
- [ ] Response includes the `steps` array ready to be submitted to `POST /api/run`

#### US-008: GET /api/waveform/:id — Download VCD
**Description:** As an API consumer, I want to download the VCD waveform file from a simulation run so that I can view it in Surfer or another waveform viewer.

**Acceptance Criteria:**
- [ ] `GET /api/waveform/{waveform_id}` returns the VCD file as `application/octet-stream` with `Content-Disposition: attachment`
- [ ] Returns HTTP 404 if the waveform ID does not exist or has expired
- [ ] VCD files are stored in a temp directory with UUID-based naming
- [ ] Files are automatically deleted after 30 minutes (TTL)

### Phase 3: VCD Lifecycle & Cleanup

#### US-009: VCD Storage & TTL Cleanup
**Description:** As a backend service, I want VCD files to be automatically cleaned up after a TTL period so that disk space is not wasted.

**Acceptance Criteria:**
- [ ] VCD files are stored in a configurable temp directory (default: system temp dir / `i2c-sim-waveforms/`)
- [ ] Each simulation run creates a VCD file named `{uuid}.vcd`
- [ ] A background task runs every 5 minutes to delete VCD files older than 30 minutes
- [ ] The background task starts with the FastAPI app lifecycle (startup event)
- [ ] TTL is configurable via environment variable `VCD_TTL_MINUTES` (default: 30)

### Phase 4: Integration & Error Handling

#### US-010: End-to-End Integration Test
**Description:** As a developer, I want integration tests that verify the full API flow (submit sequence, check results, download VCD) so that I can confidently deploy.

**Acceptance Criteria:**
- [ ] Test file at `backend/tests/test_api.py` using `httpx.AsyncClient` with FastAPI's `TestClient`
- [ ] Test: POST /api/run with a simple write+read sequence returns `passed: true`
- [ ] Test: POST /api/run with invalid steps returns HTTP 422
- [ ] Test: GET /api/templates returns a non-empty list
- [ ] Test: GET /api/templates/{id} returns valid template content
- [ ] Test: GET /api/waveform/{id} with valid ID returns a VCD file
- [ ] Test: GET /api/waveform/{id} with invalid ID returns 404
- [ ] Test: GET /api/health returns 200
- [ ] Tests can run without iverilog installed (mock the subprocess call)

## 4. Functional Requirements

- FR-1: The system must accept JSON test sequences via `POST /api/run` and return structured results
- FR-2: The system must execute simulations via `asyncio.create_subprocess_exec` calling `test_runner.py`
- FR-3: The system must serialize simulation requests so only one runs at a time
- FR-4: The system must cache compiled Verilog binaries and only recompile when RTL source files change
- FR-5: The system must store VCD waveform files with UUID identifiers and serve them via `GET /api/waveform/:id`
- FR-6: The system must automatically delete VCD files older than the configured TTL (default 30 minutes)
- FR-7: The system must serve pre-built test templates from `backend/sim/templates/` via `GET /api/templates`
- FR-8: The system must return appropriate HTTP error codes: 422 for validation errors, 500 for simulation failures, 503 for queue timeout
- FR-9: The system must enforce a simulation timeout (default 60 seconds) to prevent hung simulations

## 5. Non-Goals (Out of Scope)

- WebSocket or real-time progress streaming (defer to future phase)
- User authentication or authorization
- Multiple concurrent simulations (single-queue is sufficient)
- Persistent simulation history or database
- Docker containerization (optional, not required)
- Frontend (Phase 3)
- Multi-slave or sensor simulation (Phase 4)

## 6. Technical Considerations

- **Subprocess execution:** Use `asyncio.create_subprocess_exec` (not `subprocess.run`) to avoid blocking the event loop
- **Path resolution:** `SimulationService` needs to know the path to `test_runner.py` and RTL sources. Use paths relative to the `backend/sim/` directory.
- **CORS:** Allow all origins in dev mode for frontend development convenience
- **Environment:** Requires `iverilog` and `cocotb` installed in the Python environment. The integration tests should mock subprocess calls to avoid this dependency.
- **File structure:**
  ```
  backend/
  ├── app/
  │   ├── main.py              # FastAPI app, CORS, lifespan
  │   ├── routes/
  │   │   └── simulation.py    # API route handlers
  │   └── services/
  │       ├── runner.py         # SimulationService
  │       └── waveform.py       # VCD storage & cleanup
  ├── tests/
  │   └── test_api.py           # Integration tests
  ├── sim/                      # (existing Phase 1 code)
  └── requirements.txt
  ```

## 7. Success Metrics

- All 4 API endpoints respond correctly to valid and invalid requests
- A full write+read test sequence submitted via API returns correct results matching Phase 1 CLI output
- VCD files are downloadable within TTL and cleaned up after expiry
- Simulation completes within 60 seconds for typical test sequences (< 50 steps)
- Integration tests pass with mocked subprocess

## 8. Open Questions

- Should `POST /api/run` also accept a `template_id` field to run a pre-built template directly, or should the frontend fetch the template first and then POST its steps? (Leaning toward: frontend fetches first — simpler API)
- Should we add a `POST /api/run` option to skip VCD generation for faster execution? (Leaning toward: not now, add later if needed)
