"""test_protocol.py — cocotb tests for repeated start sequences.

This module verifies that the ProtocolInterpreter + I2CDriver.execute_transactions()
pipeline correctly handles repeated start patterns end-to-end against the
i2c_system_wrapper DUT.

Each @cocotb.test() is self-contained: it resets the DUT first so test
ordering does not matter.

Test coverage
-------------
test_repeated_start_eeprom_read
    Classic EEPROM pattern: write register pointer → repeated start → read N
    bytes.  Verifies read data matches what was previously written.

test_repeated_start_write_then_readback
    Write data bytes to a register range, then use a repeated start sequence
    to read them back.  Confirms that the register file contents survive the
    repeated start transition.

test_scan_with_repeated_start
    Probe a slave address using a write-only transaction flagged as
    repeated_start=True (no STOP issued).  Verifies the ack_ok result for a
    present address.

test_multi_segment_repeated_start_chain
    Four-segment chain: write → RS → read → RS → write → STOP.  Exercises
    back-to-back repeated starts within a single I2C sequence.

Runner integration
------------------
The ``run_tests()`` function at the bottom compiles the RTL with Icarus
Verilog and runs all test coroutines.  Invoke directly::

    python tests/test_protocol.py
"""

from __future__ import annotations

import pathlib
import sys

import cocotb
from cocotb.triggers import ClockCycles

# ---------------------------------------------------------------------------
# Ensure the parent sim directory is on sys.path so the driver and interpreter
# are importable when cocotb loads this module from an arbitrary cwd.
# ---------------------------------------------------------------------------
_TESTS_DIR = pathlib.Path(__file__).parent.resolve()
_SIM_DIR = _TESTS_DIR.parent.resolve()
_BACKEND_DIR = _SIM_DIR.parent.resolve()

# Add sim dir so "import i2c_driver" works (module-level import, not package).
if str(_SIM_DIR) not in sys.path:
    sys.path.insert(0, str(_SIM_DIR))

# Add backend dir so i2c_driver's "from sim.protocol_interpreter import ..."
# can resolve "sim" as a package (backend/sim/__init__.py exists).
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from i2c_driver import I2CDriver  # noqa: E402
from sim.protocol_interpreter import ProtocolInterpreter  # noqa: E402


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SLAVE_ADDR = 0x50

# Address+RW bytes for the configured slave (matches real I2C wire encoding):
#   bits [7:1] = 7-bit address, bit [0] = R/W (0=write, 1=read)
_SLAVE_WRITE_BYTE = (_SLAVE_ADDR << 1) | 0  # 0xA0
_SLAVE_READ_BYTE  = (_SLAVE_ADDR << 1) | 1  # 0xA1


# ---------------------------------------------------------------------------
# Shared setup helper
# ---------------------------------------------------------------------------


async def _setup(dut) -> tuple[I2CDriver, ProtocolInterpreter]:
    """Reset the DUT and return a ready driver + interpreter pair."""
    driver = I2CDriver(dut, slave_addr_cfg=_SLAVE_ADDR)
    await driver.reset()
    interpreter = ProtocolInterpreter()
    return driver, interpreter


# ===========================================================================
# Test 1 — classic EEPROM repeated-start read
# ===========================================================================


@cocotb.test()
async def test_repeated_start_eeprom_read(dut):
    """Write a known byte to reg[0x10], then read it back via repeated start.

    Protocol sequence:
        START → 0xA0 (addr 0x50 write) → 0x10 (reg ptr) → REPEATED_START
              → 0xA1 (addr 0x50 read)  → recv_byte(ACK) → recv_byte(NACK) → STOP

    Steps match the classic EEPROM random-read pattern described in the story.
    """
    driver, interpreter = await _setup(dut)

    reg = 0x10
    expected_data = [0xBE, 0xEF]

    # --- Pre-condition: write the expected bytes so the register file is
    #     populated before the repeated-start read.
    ok = await driver.write_bytes(_SLAVE_ADDR, reg, expected_data)
    assert ok, "Pre-condition write_bytes failed (NACK)"
    await ClockCycles(dut.clk, 20)

    # --- Build the repeated-start read sequence using protocol steps.
    steps = [
        {"op": "start"},
        {"op": "send_byte", "data": _SLAVE_WRITE_BYTE},  # 0xA0 — write address
        {"op": "send_byte", "data": reg},                 # register pointer
        {"op": "repeated_start"},
        {"op": "send_byte", "data": _SLAVE_READ_BYTE},    # 0xA1 — read address
        {"op": "recv_byte", "ack": True},                 # first byte (ACK)
        {"op": "recv_byte", "ack": False},                # last byte (NACK)
        {"op": "stop"},
    ]

    txns = interpreter.interpret(steps)
    # Expect 2 transactions: write (reg ptr, repeated_start=True) + read
    assert len(txns) == 2, f"Expected 2 transactions, got {len(txns)}"
    assert txns[0].repeated_start is True,  "First txn must have repeated_start=True"
    assert txns[1].repeated_start is False, "Second txn must end with STOP"

    results = await driver.execute_transactions(txns)
    assert len(results) == 2

    # Write phase must ACK.
    assert results[0].ack_ok, "EEPROM-read write phase got NACK — slave not present?"

    # Read phase: 2 bytes received.
    assert results[1].ack_ok, "EEPROM-read read phase got NACK"
    actual = results[1].data_read
    assert actual == expected_data, (
        f"EEPROM repeated-start read mismatch: got {actual!r}, expected {expected_data!r}"
    )

    # Confirm via register dump that the registers still hold their values.
    dump = await driver.get_register_dump()
    for offset, byte_val in enumerate(expected_data):
        addr_key = (reg + offset) & 0xFF
        assert dump[addr_key] == byte_val, (
            f"Register dump mismatch at reg[0x{addr_key:02X}]: "
            f"got 0x{dump[addr_key]:02X}, expected 0x{byte_val:02X}"
        )


# ===========================================================================
# Test 2 — write data, then repeated-start read-back integrity check
# ===========================================================================


@cocotb.test()
async def test_repeated_start_write_then_readback(dut):
    """Write 4 bytes to reg[0x20] then read them back via repeated start.

    This test verifies that register file contents survive the repeated start
    transition, i.e. that data written in one I2C session is readable in a
    subsequent session that uses a repeated start.
    """
    driver, interpreter = await _setup(dut)

    reg = 0x20
    payload = [0x11, 0x22, 0x33, 0x44]

    # Write via legacy helper to guarantee the register file is populated
    # before we exercise the repeated-start path.
    ok = await driver.write_bytes(_SLAVE_ADDR, reg, payload)
    assert ok, "Setup write_bytes failed (NACK)"
    await ClockCycles(dut.clk, 20)

    # Capture register file state before the repeated-start read.
    dump_before = await driver.get_register_dump()
    for i, b in enumerate(payload):
        assert dump_before[(reg + i) & 0xFF] == b, (
            f"Register dump pre-check failed at offset {i}"
        )

    # Build the repeated-start read: write reg pointer → RS → read 4 bytes.
    steps = [
        {"op": "start"},
        {"op": "send_byte", "data": _SLAVE_WRITE_BYTE},
        {"op": "send_byte", "data": reg},
        {"op": "repeated_start"},
        {"op": "send_byte", "data": _SLAVE_READ_BYTE},
        {"op": "recv_byte", "ack": True},
        {"op": "recv_byte", "ack": True},
        {"op": "recv_byte", "ack": True},
        {"op": "recv_byte", "ack": False},  # NACK on last byte
        {"op": "stop"},
    ]

    txns = interpreter.interpret(steps)
    assert len(txns) == 2, f"Expected 2 transactions, got {len(txns)}"

    results = await driver.execute_transactions(txns)

    assert results[0].ack_ok, "Write-phase NACK in repeated-start readback test"
    assert results[1].ack_ok, "Read-phase NACK in repeated-start readback test"

    actual = results[1].data_read
    assert actual == payload, (
        f"Repeated-start readback mismatch: got {actual!r}, expected {payload!r}"
    )

    # Confirm the register dump still matches after the read (reads are non-destructive).
    dump_after = await driver.get_register_dump()
    for i, b in enumerate(payload):
        key = (reg + i) & 0xFF
        assert dump_after[key] == b, (
            f"Register file mutated after repeated-start read at offset {i}: "
            f"got 0x{dump_after[key]:02X}, expected 0x{b:02X}"
        )


# ===========================================================================
# Test 3 — address probe (scan) via write with repeated start, no STOP
# ===========================================================================


@cocotb.test()
async def test_scan_with_repeated_start(dut):
    """Probe a slave via a write transaction that ends with repeated start.

    An address-only write (no data bytes, repeated_start=True) is issued to
    the configured slave address (0x50).  The sequence never issues a STOP.
    We verify:
      - The slave ACKs its address (ack_ok=True for the probe transaction).
      - A follow-up normal write succeeds, confirming the bus was released.

    This exercises the _run_write_txn path with repeated_start=True and no
    payload bytes (pure bus scan without STOP).
    """
    driver, interpreter = await _setup(dut)

    # Build a scan sequence: write addr only → repeated start → send a real
    # byte to actually close the sequence with a normal write → STOP.
    reg = 0x30
    scan_steps = [
        {"op": "start"},
        {"op": "send_byte", "data": _SLAVE_WRITE_BYTE},  # addr probe
        {"op": "repeated_start"},
        {"op": "send_byte", "data": _SLAVE_WRITE_BYTE},  # real write addr
        {"op": "send_byte", "data": reg},                 # register pointer
        {"op": "send_byte", "data": 0xCA},                # one data byte
        {"op": "stop"},
    ]

    txns = interpreter.interpret(scan_steps)
    assert len(txns) == 2, f"Expected 2 transactions, got {len(txns)}"
    assert txns[0].repeated_start is True,  "Scan txn must have repeated_start=True"
    assert txns[0].rw == 0,                 "Scan txn must be write mode"
    assert txns[0].data_bytes == [],        "Scan txn must carry no data bytes"
    assert txns[1].repeated_start is False, "Follow-up txn must end with STOP"

    results = await driver.execute_transactions(txns)
    assert len(results) == 2

    # The scan probe must ACK (slave is present at 0x50).
    assert results[0].ack_ok, (
        f"Scan probe NACKed — slave not present at 0x{_SLAVE_ADDR:02X}"
    )

    # The follow-up write must also succeed.
    assert results[1].ack_ok, "Follow-up write after RS-scan NACKed"

    # Verify the data byte landed in the register file.
    dump = await driver.get_register_dump()
    assert dump[reg] == 0xCA, (
        f"Register 0x{reg:02X} after RS-scan write: "
        f"got 0x{dump[reg]:02X}, expected 0xCA"
    )


# ===========================================================================
# Test 4 — multi-segment chain: write → RS → read → RS → write → STOP
# ===========================================================================


@cocotb.test()
async def test_multi_segment_repeated_start_chain(dut):
    """Three-segment chain exercising back-to-back repeated starts.

    Sequence (classic I2C random-read then write-then-read pattern):
        1. write reg pointer 0x40 → REPEATED_START
        2. read reg[0x40..0x41] (2 bytes) → REPEATED_START
        3. write reg[0x42] = [0xCC] → STOP

    Registers 0x40 and 0x41 are pre-seeded via write_bytes so the read
    segment has deterministic data to verify.

    Verifies:
      - All three segments ACK correctly.
      - Read segment returns the pre-seeded data from reg[0x40..0x41].
      - Third-segment write lands at reg[0x42].
      - Register dump confirms all values after the chain.
    """
    driver, interpreter = await _setup(dut)

    reg_read_start = 0x40
    pre_seed_data  = [0xAA, 0xBB]
    reg_write2     = 0x42
    write2_data    = [0xCC]

    # --- Pre-condition: seed reg[0x40..0x41] so the read segment has data. ---
    ok = await driver.write_bytes(_SLAVE_ADDR, reg_read_start, pre_seed_data)
    assert ok, "Pre-condition write_bytes failed"
    await ClockCycles(dut.clk, 20)

    # --- Multi-segment chain.
    #
    # Segment 1: write register pointer 0x40 only → RS
    #   After this, the slave's register pointer is at 0x40 (one byte written
    #   to the pointer register, then RS — pointer not auto-incremented past
    #   the address byte since the write contained only the pointer).
    #   Actually: pointer byte sets addr to 0x40, slave auto-increments to 0x41
    #   after accepting the pointer byte. But for a subsequent read the slave
    #   reads from the current pointer which after accepting the addr byte is 0x40.
    #
    # Segment 2: read 2 bytes → RS
    #   Reads reg[0x40]=0xAA, reg[0x41]=0xBB.
    #
    # Segment 3: write reg ptr 0x42 + 0xCC → STOP
    # ---------------------------------------------------------------------------
    steps = [
        # Segment 1 — write register pointer only (EEPROM-style pointer set)
        {"op": "start"},
        {"op": "send_byte", "data": _SLAVE_WRITE_BYTE},   # 0xA0 — write address
        {"op": "send_byte", "data": reg_read_start},       # reg ptr = 0x40
        {"op": "repeated_start"},
        # Segment 2 — read 2 bytes
        {"op": "send_byte", "data": _SLAVE_READ_BYTE},     # 0xA1 — read address
        {"op": "recv_byte", "ack": True},                  # reg[0x40] = 0xAA
        {"op": "recv_byte", "ack": False},                 # reg[0x41] = 0xBB, NACK last
        {"op": "repeated_start"},
        # Segment 3 — write reg ptr 0x42 + data 0xCC
        {"op": "send_byte", "data": _SLAVE_WRITE_BYTE},   # 0xA0
        {"op": "send_byte", "data": reg_write2},           # reg ptr = 0x42
        {"op": "send_byte", "data": write2_data[0]},       # 0xCC
        {"op": "stop"},
    ]

    txns = interpreter.interpret(steps)
    assert len(txns) == 3, f"Expected 3 transactions, got {len(txns)}"
    assert txns[0].repeated_start is True,  "Txn 0 must have repeated_start=True"
    assert txns[1].repeated_start is True,  "Txn 1 must have repeated_start=True"
    assert txns[2].repeated_start is False, "Txn 2 must end with STOP"

    # Txn 0: write only reg ptr byte, rw=0
    assert txns[0].rw == 0, "Txn 0 must be write"
    assert txns[0].data_bytes == [reg_read_start], (
        f"Txn 0 data_bytes: got {txns[0].data_bytes!r}, expected [{reg_read_start:#04x}]"
    )
    # Txn 1: read 2 bytes, rw=1
    assert txns[1].rw == 1, "Txn 1 must be read"
    assert txns[1].read_count == 2, "Txn 1 must read 2 bytes"
    # Txn 2: write, rw=0
    assert txns[2].rw == 0, "Txn 2 must be write"

    results = await driver.execute_transactions(txns)
    assert len(results) == 3

    # All segments must ACK.
    assert results[0].ack_ok, "Segment 1 (write reg ptr) NACKed"
    assert results[1].ack_ok, "Segment 2 (read)  NACKed"
    assert results[2].ack_ok, "Segment 3 (write) NACKed"

    # Segment 2 read must return the pre-seeded values.
    assert results[1].data_read == pre_seed_data, (
        f"Multi-segment read: got {results[1].data_read!r}, "
        f"expected {pre_seed_data!r}"
    )

    # Confirm full register dump integrity.
    dump = await driver.get_register_dump()

    assert dump[0x40] == 0xAA, (
        f"reg[0x40] after chain: got 0x{dump[0x40]:02X}, expected 0xAA"
    )
    assert dump[0x41] == 0xBB, (
        f"reg[0x41] after chain: got 0x{dump[0x41]:02X}, expected 0xBB"
    )
    assert dump[0x42] == 0xCC, (
        f"reg[0x42] after chain: got 0x{dump[0x42]:02X}, expected 0xCC"
    )


# ===========================================================================
# Runner — compile RTL and execute all tests via the cocotb Python runner API
# ===========================================================================


def run_tests(
    *,
    build_dir: str | None = None,
    vcd_dir: str | None = None,
) -> None:
    """Compile RTL with Icarus Verilog and run all @cocotb.test() cases.

    Parameters
    ----------
    build_dir:
        Directory for Icarus build artefacts.  Defaults to
        ``backend/sim/sim_build``.
    vcd_dir:
        Kept for API symmetry with other runners; the wrapper Verilog owns the
        $dumpfile path.
    """
    from cocotb_tools.runner import get_runner  # noqa: PLC0415

    rtl_dir = _SIM_DIR / "rtl"
    tb_dir  = _SIM_DIR / "tb"

    verilog_sources = [
        rtl_dir / "i2c_master.v",
        rtl_dir / "i2c_slave.v",
        rtl_dir / "i2c_top.v",
        tb_dir  / "i2c_system_wrapper.v",
    ]

    resolved_build_dir = (
        pathlib.Path(build_dir) if build_dir else _SIM_DIR / "sim_build"
    )

    runner = get_runner("icarus")
    runner.build(
        verilog_sources=[str(s) for s in verilog_sources],
        hdl_toplevel="i2c_system_wrapper",
        build_dir=str(resolved_build_dir),
        always=True,
    )
    runner.test(
        hdl_toplevel="i2c_system_wrapper",
        test_module="test_protocol",
        build_dir=str(resolved_build_dir),
        test_dir=str(_TESTS_DIR),
    )


if __name__ == "__main__":
    run_tests()
