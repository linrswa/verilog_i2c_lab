# I2C Demo Project

## Environment

- **Python venv**: `.venv/` managed by `uv`. Always activate before running backend:
  ```bash
  source .venv/bin/activate
  ```
- **Backend**: FastAPI app in `backend/`. Start with:
  ```bash
  cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
  ```
- **Frontend**: Vite + React in `frontend/`, runs on `localhost:5173`
- **Simulation**: cocotb 2.0 + Icarus Verilog. cocotb 2.0 uses `cocotb_tools.runner` (not `cocotb.runner`)
- **IMPORTANT**: The backend subprocess uses `sys.executable` to spawn simulation processes. You must start the backend using the `.venv` Python so that the subprocess also uses the correct environment with cocotb installed.

## Project Structure

- `backend/sim/` — cocotb simulation code (test_runner.py, i2c_driver.py, protocol_interpreter.py)
- `backend/app/` — FastAPI routes and services
- `frontend/src/` — React Flow canvas for visual I2C protocol building
- `backend/sim/rtl/` — Verilog RTL sources
- `backend/sim/tb/` — Verilog testbench wrapper

## Key Notes

- `backend/sim/` files use bare imports (e.g., `from protocol_interpreter import ...`) because the subprocess runs with `cwd=sim/`
- `backend/app/` files use `sim.` prefix imports (e.g., `from sim.protocol_interpreter import ...`)
- Protocol sequences auto-prepend a `reset` step if not provided (DUT hangs without reset)
- Simulation (vvp) should complete within a few seconds. If a test hangs over 15 seconds, kill it — it likely indicates a bug (e.g., missing reset, waiting on a signal that never arrives)
