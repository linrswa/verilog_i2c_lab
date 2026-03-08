# PRD: Phase 4 — Protocol-Level I2C Primitives

## 1. Introduction/Overview

Refactor the I2C simulation stack from transaction-level operations (write_bytes, read_bytes) to protocol-level primitives (start, stop, repeated_start, send_byte, recv_byte). This enables users to compose arbitrary I2C sequences — including repeated start patterns, mixed read/write flows, and edge-case testing — by wiring together fine-grained protocol steps.

The existing RTL master already supports the `repeated_start` signal but the driver layer never uses it. This phase exposes that capability through the full stack: driver → backend JSON step format → frontend canvas nodes.

**Key architectural constraint:** The RTL master is transaction-based (it handles START + ADDR + N data bytes + STOP/REPEATED_START as one atomic operation). Protocol-level steps at the UI/API layer must be **interpreted and grouped** into master transactions by the driver layer.

## 2. Goals

- Expose protocol-level I2C control through the entire stack (driver → API → frontend)
- Enable repeated start sequences (write-then-read without STOP in between)
- Provide a protocol step interpreter that converts fine-grained steps into master transactions
- Maintain backward compatibility — existing high-level ops (write_bytes, read_bytes, scan, delay, reset) continue to work
- Add cocotb test coverage for repeated start and protocol-level sequences
- Allow users to visually compose protocol-level I2C sequences on the React Flow canvas

## 3. User Stories

### Phase 1: Driver Layer — Protocol Interpreter

#### US-001: Protocol Step Interpreter
**Description:** As a developer, I want a protocol step interpreter in the driver layer so that protocol-level step sequences can be translated into master transactions.

**Acceptance Criteria:**
- [ ] New class `ProtocolInterpreter` in `backend/sim/protocol_interpreter.py`
- [ ] `interpret(steps: list[dict]) -> list[Transaction]` method that groups protocol-level steps into master transactions
- [ ] Grouping rules:
  - `start` begins a new transaction group
  - `send_byte` after `start`: first byte is address+RW (auto-detect write/read from LSB); subsequent bytes are data
  - `recv_byte` collects bytes for a read transaction; `ack` param (True=ACK, False=NACK for last byte)
  - `repeated_start` ends current transaction with `repeated_start=1` and begins a new group
  - `stop` ends current transaction with `repeated_start=0`
- [ ] `Transaction` dataclass with fields: `addr`, `rw` (0=write, 1=read), `data_bytes`, `read_count`, `repeated_start`
- [ ] Validation: raises `ValueError` for invalid sequences (e.g., `send_byte` without `start`, mismatched `recv_byte` in write mode)
- [ ] Unit tests (pytest, no cocotb) for: write sequence, read sequence, write-then-read with repeated start, validation errors
- [ ] Typecheck passes (mypy)

#### US-002: Driver Execute Transaction List
**Description:** As a developer, I want the I2CDriver to execute a list of Transaction objects so that interpreted protocol steps can run on the hardware.

**Acceptance Criteria:**
- [ ] New method `I2CDriver.execute_transactions(txns: list[Transaction]) -> list[TxnResult]`
- [ ] For write transactions: drives `slave_addr_in`, `rw=0`, `num_bytes`, `data_in`, `repeated_start_in` — reuses existing payload-feeding logic from `write_bytes`
- [ ] For read transactions: drives `slave_addr_in`, `rw=1`, `num_bytes`, `repeated_start_in` — reuses existing data_valid capture logic from `read_bytes`
- [ ] `repeated_start_in` is set to 1 when `txn.repeated_start` is True
- [ ] `TxnResult` dataclass: `ack_ok: bool`, `data_read: list[int]`, `bytes_written: int`
- [ ] Does NOT break existing `write_bytes`/`read_bytes` methods (they remain as convenience wrappers)
- [ ] Typecheck passes (mypy)

#### US-003: Cocotb Tests for Repeated Start
**Description:** As a developer, I want cocotb tests that exercise repeated start sequences so that I can verify the RTL + driver work correctly end-to-end.

**Acceptance Criteria:**
- [ ] New test file `backend/sim/tests/test_protocol.py`
- [ ] Test: write register pointer → repeated start → read N bytes (classic EEPROM pattern)
- [ ] Test: write data → repeated start → read back same data (verify register contents)
- [ ] Test: scan via write with repeated start (addr probe without STOP)
- [ ] Test: multi-segment repeated start chain (write → RS → read → RS → write → STOP)
- [ ] All tests use `ProtocolInterpreter` + `I2CDriver.execute_transactions()`
- [ ] All tests pass with `cocotb` + Icarus Verilog
- [ ] Verify via register dump that data integrity is maintained across repeated start sequences

### Phase 2: Backend — New Protocol-Level Ops

#### US-004: Protocol-Level Step Ops in Test Runner
**Description:** As a developer, I want the test_runner to support protocol-level ops so that JSON test sequences can use fine-grained I2C steps.

**Acceptance Criteria:**
- [ ] New ops added to `test_runner.py` `parse_step()` / `execute_step()`:
  - `start` — no parameters (marks beginning of protocol sequence)
  - `stop` — no parameters (marks end of protocol sequence)
  - `repeated_start` — no parameters
  - `send_byte` — `data: int|hex-string` (the raw byte to send, including addr+RW for first byte after start)
  - `recv_byte` — `ack: bool` (True=send ACK, False=send NACK; typically False for last byte in read)
- [ ] Protocol steps are buffered until `stop` is encountered, then the full buffer is passed to `ProtocolInterpreter.interpret()` and executed via `execute_transactions()`
- [ ] Step results for protocol sequences: each `send_byte`/`recv_byte` within a start..stop block gets its own result entry with `status: "ok"|"fail"` and relevant data
- [ ] Existing ops (reset, write_bytes, read_bytes, scan, delay) continue to work unchanged
- [ ] Typecheck passes (mypy)

#### US-005: Protocol Sequence Validation
**Description:** As a developer, I want protocol step sequences to be validated before execution so that malformed sequences produce clear error messages.

**Acceptance Criteria:**
- [ ] Validation function `validate_protocol_sequence(steps: list[dict]) -> list[str]` in `protocol_interpreter.py`
- [ ] Validates: every `start` has a matching `stop` or `repeated_start` before next `start`
- [ ] Validates: `send_byte`/`recv_byte` only appear between `start` and `stop`/`repeated_start`
- [ ] Validates: first `send_byte` after `start` is a valid 7-bit address + RW bit (value 0x00-0xFF)
- [ ] Validates: `recv_byte` only in read mode (address byte LSB=1)
- [ ] Validates: `send_byte` only in write mode (address byte LSB=0) after the address byte
- [ ] Returns list of human-readable error strings (empty = valid)
- [ ] Backend returns 422 with validation errors if protocol sequence is invalid
- [ ] Unit tests for each validation rule

#### US-006: Integration Test — Protocol Sequences via API
**Description:** As a developer, I want to verify protocol-level sequences work end-to-end through the FastAPI backend.

**Acceptance Criteria:**
- [ ] New template JSON: `backend/sim/templates/repeated_start_read.json` — write register pointer → repeated start → read pattern
- [ ] Test: POST /api/run with protocol-level steps returns correct results
- [ ] Test: POST /api/run with mixed protocol + legacy ops in same sequence
- [ ] Test: POST /api/run with invalid protocol sequence returns 422 with error details
- [ ] All tests pass via pytest + FastAPI TestClient (or manual curl)

### Phase 3: Frontend — Protocol-Level Nodes

#### US-007: Protocol Control Nodes (Start, Stop, RepeatedStart)
**Description:** As a user, I want Start, Stop, and RepeatedStart nodes on the canvas so that I can control I2C bus protocol flow.

**Acceptance Criteria:**
- [ ] `StartNode` — displays "START" label, green accent, one output handle (bottom), no input handle
- [ ] `StopNode` — displays "STOP" label, red accent, one input handle (top), no output handle
- [ ] `RepeatedStartNode` — displays "Sr" label, orange accent, one input handle (top), one output handle (bottom)
- [ ] All three registered in `nodeTypes` map
- [ ] Sidebar updated with new "Protocol" section showing these 3 node types as draggable items
- [ ] Typecheck passes
- [ ] Verify in browser: all 3 nodes render correctly with handles

#### US-008: Data Transfer Nodes (SendByte, RecvByte)
**Description:** As a user, I want SendByte and RecvByte nodes so that I can specify individual bytes in an I2C transaction.

**Acceptance Criteria:**
- [ ] `SendByteNode` — displays inline hex input for byte value (0x00-0xFF), purple accent; one input handle (top), one output handle (bottom)
- [ ] First SendByte after Start is the address+RW byte — display helper text: "Addr: 0x{byte>>1} {byte&1 ? 'R' : 'W'}" auto-computed from the byte value
- [ ] `RecvByteNode` — displays ACK/NACK toggle (select or checkbox), teal accent; one input handle (top), one output handle (bottom); shows received data as read-only field after simulation
- [ ] Both registered in `nodeTypes` map
- [ ] Sidebar "Protocol" section updated with these 2 node types
- [ ] Default values: SendByte data=0xA0 (0x50 addr + write), RecvByte ack=true
- [ ] Validation: SendByte data must be 0x00-0xFF
- [ ] Typecheck passes
- [ ] Verify in browser: both nodes render with correct fields

#### US-009: Serialization for Protocol-Level Nodes
**Description:** As a developer, I want the flow serializer to handle protocol-level nodes so that protocol sequences can be sent to the backend.

**Acceptance Criteria:**
- [ ] `serializeFlow` updated to map new node types:
  - `start` → `{op: "start"}`
  - `stop` → `{op: "stop"}`
  - `repeated_start` → `{op: "repeated_start"}`
  - `send_byte` → `{op: "send_byte", data: "0xNN"}`
  - `recv_byte` → `{op: "recv_byte", ack: true|false}`
- [ ] Mixed flows (legacy + protocol nodes) serialize correctly
- [ ] Protocol nodes can coexist with legacy nodes in the same flow (e.g., Reset → Start → SendByte → ... → Stop → Delay)
- [ ] Unit tests for: protocol-only chain, mixed chain, validation of start/stop pairing at serialization level
- [ ] Typecheck passes

#### US-010: Protocol Sequence Visual Indicators
**Description:** As a user, I want visual feedback about protocol sequence validity on the canvas so that I can see errors before running.

**Acceptance Criteria:**
- [ ] Start and Stop nodes show a warning icon if unpaired (Start without matching Stop in chain, or vice versa)
- [ ] SendByte/RecvByte nodes show warning if not between Start and Stop
- [ ] First SendByte after Start shows the decoded address + R/W direction as helper text
- [ ] RecvByte shows warning if used in write mode (address byte LSB=0)
- [ ] Validation runs on every flow change (node/edge add/remove) and results are stored in node.data
- [ ] Typecheck passes
- [ ] Verify in browser: warnings appear for invalid protocol sequences

## 4. Functional Requirements

- FR-1: The ProtocolInterpreter must convert protocol-level step sequences into grouped master transactions that the existing RTL can execute
- FR-2: The RTL master's `repeated_start` input signal must be driven correctly (1 = repeated start, 0 = stop) based on the protocol step sequence
- FR-3: Protocol-level ops (start, stop, repeated_start, send_byte, recv_byte) must coexist with legacy ops (reset, write_bytes, read_bytes, scan, delay) in the same test sequence
- FR-4: The backend must buffer protocol steps between start..stop and execute them as one atomic protocol sequence
- FR-5: The frontend must provide 5 new node types (Start, Stop, RepeatedStart, SendByte, RecvByte) in a separate "Protocol" sidebar section
- FR-6: Protocol sequence validation must run both server-side (422 errors) and client-side (visual warnings on canvas)
- FR-7: The first SendByte after Start must be interpretable as an address+RW byte (7-bit address in bits [7:1], RW in bit [0])
- FR-8: Existing tests and functionality must not break (backward compatible)

## 5. Non-Goals (Out of Scope)

- No RTL modifications — the existing master's transaction-based interface is sufficient (protocol interpretation happens in Python)
- No "macro" or composite node saving in this phase — that is a future feature (Phase 5: save low-level node compositions as reusable high-level templates)
- No clock stretching or multi-master support
- No arbitration or bus error simulation
- No 10-bit addressing mode
- No high-speed / fast-mode I2C variants
- No undo/redo for protocol sequence editing

## 6. Technical & Design Considerations

### Protocol Interpreter Architecture

The interpreter sits between the JSON step format and the I2CDriver:

```
JSON steps → test_runner.py → ProtocolInterpreter → Transaction[] → I2CDriver.execute_transactions()
```

Protocol steps are **buffered** between `start` and `stop` markers, then interpreted as a group. This is necessary because the RTL master operates at the transaction level.

### Address Byte Convention

The first `send_byte` after `start` is always the address+RW byte:
- Bits [7:1] = 7-bit slave address
- Bit [0] = R/W direction (0=write, 1=read)
- Example: `0xA0` = address 0x50, write; `0xA1` = address 0x50, read

This matches the real I2C wire protocol, making it educational.

### Transaction Grouping Example

User-visible protocol steps:
```
start → send_byte(0xA0) → send_byte(0x10) → repeated_start → send_byte(0xA1) → recv_byte(ACK) → recv_byte(NACK) → stop
```

Interpreter groups into 2 transactions:
```
Transaction 1: addr=0x50, rw=WRITE, data=[0x10], repeated_start=true
Transaction 2: addr=0x50, rw=READ,  read_count=2, repeated_start=false
```

### Sidebar Layout Update

The sidebar should have two sections:
1. **Basic** (existing): Reset, Write, Read, Scan, Delay
2. **Protocol**: Start, Stop, Repeated Start, SendByte, RecvByte

### Future: Macro Nodes (Phase 5 consideration)

The user wants to eventually save compositions of low-level nodes as reusable high-level nodes. Design node data structures to be serializable/composable — e.g., a "macro" could be stored as a subgraph JSON that gets expanded at serialization time.

## 7. Success Metrics

- Repeated start write-then-read sequence executes correctly and returns expected data
- Protocol-level steps produce identical results to equivalent legacy ops (e.g., `start → send_byte(0xA0) → send_byte(0x10) → send_byte(0xFF) → stop` equals `write_bytes(addr=0x50, reg=0x10, data=[0xFF])`)
- All existing cocotb tests continue to pass
- User can compose a write→repeated_start→read sequence on the canvas and execute it successfully

## 8. Open Questions

- Should `recv_byte` always require explicit ACK/NACK selection, or should the system auto-NACK the last recv_byte before stop? (Current: explicit — more educational but more nodes to place)
- Should we add a "Byte Count" or "N Bytes" mode to RecvByte to reduce node count for multi-byte reads? (e.g., `recv_bytes(n=4, last_nack=true)`)
- How should errors be reported for individual bytes within a protocol sequence? (Current plan: each send_byte/recv_byte gets its own step result)
- Should the protocol sidebar section be collapsible to reduce visual clutter for users who only need basic nodes?
