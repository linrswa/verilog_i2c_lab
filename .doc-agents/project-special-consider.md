# Project Special Considerations

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite + React Flow (visual graph editor) + Tailwind CSS
- **Backend**: Python FastAPI + Uvicorn
- **Simulation**: cocotb 2.0 + Verilator (default) / Icarus Verilog (fallback)
- **HDL**: Verilog (IEEE 1364-2005)
- **VCD Parsing**: vcdvcd library

## Architecture Patterns

- **Subprocess IPC**: FastAPI spawns `test_runner.py` as a subprocess, communicating via temporary JSON files (not stdin/stdout)
- **OE Bus Model**: Uses output-enable + wired-AND instead of tri-state (`inout`/`pullup`) for Verilator compatibility. Key equation: `sda = ~(master_sda_oe | slave_sda_oe)`
- **Clock Generation**: cocotb `Clock` generator instead of Verilog `#delay` for cross-simulator compatibility
- **Protocol-Level Ops**: Frontend builds I2C sequences as a visual graph (start, send_byte, recv_byte, stop nodes), serialized to protocol steps via topological sort

## Import Conventions

- `backend/sim/` uses **bare imports** (e.g., `from protocol_interpreter import ...`) because subprocess runs with `cwd=sim/`
- `backend/app/` uses **`sim.` prefix imports** (e.g., `from sim.protocol_interpreter import ...`)

## Key Terminology

- **OE (Output Enable)**: Signal controlling open-drain bus driving
- **CLK_DIV**: System clock to I2C clock divider ratio
- **Protocol steps**: Low-level I2C operations (start, stop, send_byte, recv_byte, repeated_start)
- **Legacy ops**: Higher-level operations (write_bytes, read_bytes, scan) that map to protocol step sequences
- **Transaction**: Interpreted group of protocol steps representing one I2C bus transaction

## Important Directories

- `backend/sim/rtl/` — Verilog source (master, slave, top)
- `backend/sim/tb/` — Testbench wrapper for cocotb
- `backend/sim/tests/` — cocotb test suites
- `backend/sim/templates/` — Pre-built JSON test sequences
- `backend/app/routes/` — FastAPI route handlers
- `backend/app/services/` — Business logic (runner, VCD parser, waveform storage)
- `frontend/src/components/nodes/` — React Flow custom node types

## Conventions

- All documentation must be in **English**
- Verilator requires build flags: `--trace`, `--public-flat-rw`, `--timing`
- DUT auto-prepends a `reset` step if not provided (simulation hangs without reset)
- VCD files stored in `/tmp/i2c-sim-waveforms/` with UUID names and TTL-based cleanup
