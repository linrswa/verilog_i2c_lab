# I2C Demo

Interactive I2C protocol simulation platform — build I2C sequences on a visual canvas, run real-time Verilog RTL simulations, and inspect waveforms and results.

**[中文版 README](README.zh-TW.md)**

[Overview](#overview) | [Getting Started](#getting-started) | [Project Structure](#project-structure) | [Frontend](#frontend) | [Backend API](#backend-api) | [RTL Design](#rtl-design) | [Testing](#testing)

---

## Overview

A full-stack platform for learning and verifying the I2C protocol, combining:

- **Visual protocol editor** — drag-and-drop nodes on a React Flow canvas to compose I2C communication sequences
- **Real-time RTL simulation** — cocotb drives Icarus Verilog for actual hardware-level simulation
- **Waveform viewer** — built-in SVG signal renderer with signal selection, pan/zoom, and Surfer WASM integration for full VCD analysis
- **Result inspection** — per-step execution status, slave EEPROM 256-byte hex grid, and register pointer tracking

Ideal for I2C protocol learning, RTL design verification, or as a reference implementation for hardware simulation platforms.

### Architecture

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

### Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, TypeScript, Vite, React Flow (@xyflow/react), Tailwind CSS |
| Backend | Python 3.9+, FastAPI, uvicorn |
| Simulation | cocotb 2.0, Icarus Verilog |
| Testing | pytest, pytest-asyncio, vitest |
| Package Mgmt | uv (Python), bun / npm (Frontend) |

## Getting Started

### Prerequisites

- Python 3.9+
- [uv](https://docs.astral.sh/uv/) — Python package manager
- Node.js 18+ with [bun](https://bun.sh/) or npm
- [Icarus Verilog](https://steveicarus.github.io/iverilog/) — `iverilog` must be on PATH

### Installation

```bash
# Install Python dependencies
uv sync

# Start the backend (Terminal 1)
source .venv/bin/activate
cd backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
# Install and start the frontend (Terminal 2)
cd frontend
bun install    # or npm install
bun run dev    # or npm run dev
```

Once running:

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Swagger Docs | http://localhost:8000/docs |

> [!IMPORTANT]
> The backend must be started using the `.venv` Python. The simulation subprocess inherits the parent's Python environment and needs access to cocotb and other packages.

## Project Structure

```
i2c_demo/
├── backend/
│   ├── app/                         # FastAPI application
│   │   ├── main.py                  # Entry point, middleware, lifespan
│   │   ├── routes/                  # API routes
│   │   │   ├── simulation.py        # Simulation & waveform endpoints
│   │   │   └── templates.py         # Template endpoints
│   │   └── services/                # Service layer
│   │       ├── runner.py            # Simulation runner, queue management
│   │       ├── vcd_parser.py        # VCD parsing
│   │       └── waveform.py          # Waveform storage, TTL cleanup
│   ├── sim/                         # cocotb simulation code
│   │   ├── test_runner.py           # cocotb test entry point
│   │   ├── i2c_driver.py            # I2C transaction-level driver
│   │   ├── protocol_interpreter.py  # Steps → transaction converter
│   │   ├── rtl/                     # Verilog RTL sources
│   │   ├── tb/                      # Testbench
│   │   └── templates/               # Pre-built test templates
│   └── tests/                       # Backend tests
├── frontend/
│   └── src/
│       ├── App.tsx                  # React Flow canvas + layout
│       ├── components/
│       │   ├── Sidebar.tsx          # Node palette (drag to add)
│       │   ├── ResultPanel.tsx      # Result panel + EEPROM hex grid
│       │   ├── WaveformPanel.tsx    # SVG waveform viewer
│       │   ├── Toolbar.tsx          # Toolbar (run, templates)
│       │   └── nodes/              # Custom React Flow nodes
│       └── lib/                    # Utilities (API, serialization, validation)
└── pyproject.toml                  # Python project config
```

## Frontend

### Canvas

The frontend uses [React Flow](https://reactflow.dev/) as a visual protocol sequence editor:

- **Drag to add** — drag nodes from the sidebar onto the canvas, or click to append to the end
- **Drag to reorder** — rearrange nodes with ghost visual feedback
- **Vertical auto-layout** — nodes stack vertically and realign after simulation
- **Resizable panels** — sidebar, result panel, and waveform panel are all resizable
- **State persistence** — canvas state auto-saves to localStorage

### Node Types

All nodes are protocol-level primitives:

| Node | Description |
|------|-------------|
| **START** | Issue a START condition |
| **STOP** | Issue a STOP condition |
| **Sr** | Repeated START (without STOP) |
| **Send Byte** | Transmit one byte with ACK check; auto-decodes address bytes (e.g. `0xA0` → Addr `0x50` W) |
| **Recv Byte** | Receive one byte with configurable ACK / NACK |

> [!NOTE]
> The backend auto-prepends a `reset` step if not included, to prevent the DUT from hanging due to uninitialized state.

### Result Panel

After simulation, the right panel displays:

- Per-step TX/RX bytes, ACK/NACK status, and address decoding
- Slave register pointer position (highlighted in orange)
- 256-byte EEPROM hex grid (written cells highlighted in blue)

### Waveform Viewer

The bottom panel renders simulation signal waveforms:

- **SVG rendering** — SDA, SCL, and other VCD signals displayed inline
- **Signal selector** — searchable checkbox list to toggle signals
- **Step overlays** — time region markers for each step with per-byte timestamps
- **Pan & zoom** — mouse drag to pan, scroll wheel to zoom
- **Surfer integration** — open the full VCD in a new tab with the [Surfer](https://surfer-project.org/) WASM waveform viewer

## Backend API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/run` | POST | Execute a simulation sequence |
| `/api/templates` | GET | List available test templates |
| `/api/templates/{name}` | GET | Get a specific template |
| `/api/waveform/{id}` | GET | Download the VCD waveform file |
| `/api/waveform/{id}/signals` | GET | Get parsed VCD signal data |
| `/api/health` | GET | Health check |

### Example

Write `0xAB` to register `0x00`, then read it back using Repeated Start:

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

The response includes `register_dump` (EEPROM contents), `reg_pointer` (current register pointer), and `waveform_id` (for fetching waveform data).

### Simulation Engine

**Execution flow:**

1. Frontend sends `steps` array to `/api/run`
2. Backend validates the sequence, writes to a temp file, spawns a cocotb subprocess
3. `protocol_interpreter.py` converts steps into I2C transactions
4. `i2c_driver.py` drives the Verilog testbench via cocotb
5. Icarus Verilog runs the RTL simulation and generates a VCD waveform
6. Results (with per-step timing) are returned as JSON

> [!TIP]
> The backend uses `asyncio.Lock` to ensure only one simulation runs at a time. Simulations have a 60-second timeout — if exceeded, it likely indicates a bug (e.g. missing reset).

## RTL Design

### I2C Master (`i2c_master.v`)

- Full state machine (100+ states) with clock stretching and Repeated Start support
- Configurable clock divider (default: 50 system clocks per I2C phase)

### I2C Slave (`i2c_slave.v`)

- Configurable address (default `7'h50`) with 256-byte register file
- Continuous read/write with auto-incrementing address pointer

### I2C Top (`i2c_top.v`)

- Top-level module connecting Master + Slave with open-drain bus emulation (pull-up resistor logic)

## Testing

```bash
# Backend tests
source .venv/bin/activate
pytest backend/tests/

# Frontend tests
cd frontend
bun run test
```

### Test Templates

Pre-built test sequences are available in `backend/sim/templates/`:

| Template | Description |
|----------|-------------|
| `basic_write_read` | Basic write followed by read-back verification |
| `protocol_write` | Protocol-level write operation |
| `protocol_write_read` | Write + Repeated Start read-back |
| `repeated_start_read` | Repeated Start read |
| `full_test` | Comprehensive test (write, read, scan) |
| `stress_test` | Stress test (many consecutive operations) |
