"""test_i2c_cocotb.py — comprehensive cocotb test suite for the I2C system.

This module verifies all I2CDriver and test_runner functionality using the
i2c_system_wrapper DUT.  Each @cocotb.test() case is self-contained: it
resets the DUT before running its assertions so that test order does not
matter.

Test coverage
-------------
test_single_byte_write_read
    Write one byte and read it back — basic write + read-back verification.
test_multi_byte_write_read
    Write several bytes and read them all back in one burst.
test_address_boundary_addr0
    Write and read at register address 0 (lower boundary).
test_address_boundary_addr255
    Write and read at register address 255 (upper boundary).
test_burst_write_read_14bytes
    Burst write 14 bytes (max per hardware transaction) and verify all.
test_burst_write_read_16bytes
    Burst write 16 bytes (spans two hardware transactions) and verify all.
test_address_wrap_around
    Write bytes starting at addr 254 so that the auto-increment wraps from
    255 back to 0, then verify the wrapped bytes.
test_nack_wrong_address
    Send a transaction to a slave address that does not exist; verify
    ack_error is asserted (NACK response).
test_scan_existing_address
    scan() on the configured slave address (0x50) must return True.
test_scan_nonexistent_address
    scan() on an address with no slave (e.g. 0x3F) must return False.

Runner integration
------------------
The ``run_tests()`` function at the bottom of this file compiles the RTL with
Icarus Verilog and runs all test coroutines using the cocotb Python runner API.
Run it directly::

    python tests/test_i2c_cocotb.py
"""

from __future__ import annotations

import pathlib
import sys

import cocotb
from cocotb.triggers import ClockCycles

# ---------------------------------------------------------------------------
# Ensure the parent sim directory is on the path so i2c_driver can be found
# when cocotb imports this module from an arbitrary working directory.
# ---------------------------------------------------------------------------
_TESTS_DIR = pathlib.Path(__file__).parent.resolve()
_SIM_DIR = _TESTS_DIR.parent.resolve()
if str(_SIM_DIR) not in sys.path:
    sys.path.insert(0, str(_SIM_DIR))

from i2c_driver import I2CDriver  # noqa: E402


# ---------------------------------------------------------------------------
# Slave address used throughout (matches the wrapper default)
# ---------------------------------------------------------------------------
_SLAVE_ADDR = 0x50


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------


async def _setup(dut) -> I2CDriver:
    """Create an I2CDriver, start the clock, and reset the DUT.

    Every test calls this first so it starts from a known, clean state.
    """
    # Kick-start the clock if cocotb hasn't already started one.
    # The wrapper generates its own clock in Verilog, so cocotb just needs
    # to await rising edges — no cocotb.start_soon(Clock(...)) needed.

    driver = I2CDriver(dut, slave_addr_cfg=_SLAVE_ADDR)
    await driver.reset()
    return driver


# ===========================================================================
# Test 1 — single-byte write + read-back
# ===========================================================================


@cocotb.test()
async def test_single_byte_write_read(dut):
    """Write 0xA5 to reg[0x10] and read it back; verify the value matches."""
    driver = await _setup(dut)

    reg = 0x10
    expected = [0xA5]

    ok = await driver.write_bytes(_SLAVE_ADDR, reg, expected)
    assert ok, "write_bytes returned NACK — expected ACK for valid slave address"

    await ClockCycles(dut.clk, 20)

    actual = await driver.read_bytes(_SLAVE_ADDR, reg, 1)
    assert actual == expected, (
        f"Single-byte read-back mismatch: got {actual!r}, expected {expected!r}"
    )


# ===========================================================================
# Test 2 — multi-byte write + read-back (small burst within one transaction)
# ===========================================================================


@cocotb.test()
async def test_multi_byte_write_read(dut):
    """Write 4 bytes to reg[0x20] and read them all back."""
    driver = await _setup(dut)

    reg = 0x20
    expected = [0x11, 0x22, 0x33, 0x44]

    ok = await driver.write_bytes(_SLAVE_ADDR, reg, expected)
    assert ok, "write_bytes NACK — expected ACK"

    await ClockCycles(dut.clk, 20)

    actual = await driver.read_bytes(_SLAVE_ADDR, reg, len(expected))
    assert actual == expected, (
        f"Multi-byte read-back mismatch: got {actual!r}, expected {expected!r}"
    )


# ===========================================================================
# Test 3 — address boundary: register address 0
# ===========================================================================


@cocotb.test()
async def test_address_boundary_addr0(dut):
    """Write to register address 0 (lower boundary) and read back."""
    driver = await _setup(dut)

    reg = 0x00
    expected = [0xBB]

    ok = await driver.write_bytes(_SLAVE_ADDR, reg, expected)
    assert ok, "write_bytes NACK at addr 0"

    await ClockCycles(dut.clk, 20)

    actual = await driver.read_bytes(_SLAVE_ADDR, reg, 1)
    assert actual == expected, (
        f"addr-0 read-back: got {actual!r}, expected {expected!r}"
    )


# ===========================================================================
# Test 4 — address boundary: register address 255
# ===========================================================================


@cocotb.test()
async def test_address_boundary_addr255(dut):
    """Write to register address 255 (upper boundary) and read back."""
    driver = await _setup(dut)

    reg = 0xFF
    expected = [0xCC]

    ok = await driver.write_bytes(_SLAVE_ADDR, reg, expected)
    assert ok, "write_bytes NACK at addr 255"

    await ClockCycles(dut.clk, 20)

    actual = await driver.read_bytes(_SLAVE_ADDR, reg, 1)
    assert actual == expected, (
        f"addr-255 read-back: got {actual!r}, expected {expected!r}"
    )


# ===========================================================================
# Test 5 — burst write/read: 14 bytes (max single hardware transaction)
# ===========================================================================


@cocotb.test()
async def test_burst_write_read_14bytes(dut):
    """Burst-write 14 bytes (max per hw txn) starting at reg[0x30] and verify."""
    driver = await _setup(dut)

    reg = 0x30
    expected = list(range(0x01, 0x0F))  # 14 bytes: 0x01 … 0x0E
    assert len(expected) == 14

    ok = await driver.write_bytes(_SLAVE_ADDR, reg, expected)
    assert ok, "write_bytes NACK for 14-byte burst"

    await ClockCycles(dut.clk, 20)

    actual = await driver.read_bytes(_SLAVE_ADDR, reg, 14)
    assert actual == expected, (
        f"14-byte burst read-back mismatch: got {actual!r}, expected {expected!r}"
    )


# ===========================================================================
# Test 6 — burst write/read: 16 bytes (spans two hardware transactions)
# ===========================================================================


@cocotb.test()
async def test_burst_write_read_16bytes(dut):
    """Burst-write 16 bytes (two hw txns) starting at reg[0x40] and verify."""
    driver = await _setup(dut)

    reg = 0x40
    expected = list(range(0xA0, 0xB0))  # 16 bytes: 0xA0 … 0xAF
    assert len(expected) == 16

    ok = await driver.write_bytes(_SLAVE_ADDR, reg, expected)
    assert ok, "write_bytes NACK for 16-byte burst"

    await ClockCycles(dut.clk, 20)

    actual = await driver.read_bytes(_SLAVE_ADDR, reg, 16)
    assert actual == expected, (
        f"16-byte burst read-back mismatch: got {actual!r}, expected {expected!r}"
    )


# ===========================================================================
# Test 7 — address wrap-around (write past addr 255, wraps to 0)
# ===========================================================================


@cocotb.test()
async def test_address_wrap_around(dut):
    """Write 3 bytes starting at reg[0xFE]: bytes land at 0xFE, 0xFF, 0x00.

    Verifies that the slave's 8-bit register address auto-increments and wraps
    from 255 back to 0 as specified.
    """
    driver = await _setup(dut)

    # First clear reg[0] to a known value so we can detect the wrapped write.
    await driver.write_bytes(_SLAVE_ADDR, 0x00, [0x00])
    await ClockCycles(dut.clk, 20)

    # Write 3 bytes starting at 0xFE: [0xDD, 0xEE, 0xFF]
    # Expected layout: reg[0xFE]=0xDD, reg[0xFF]=0xEE, reg[0x00]=0xFF
    start_reg = 0xFE
    payload = [0xDD, 0xEE, 0xFF]

    ok = await driver.write_bytes(_SLAVE_ADDR, start_reg, payload)
    assert ok, "write_bytes NACK during wrap-around test"

    await ClockCycles(dut.clk, 20)

    # Read back reg[0xFE] and reg[0xFF].
    tail = await driver.read_bytes(_SLAVE_ADDR, 0xFE, 2)
    assert tail == [0xDD, 0xEE], (
        f"Wrap-around: regs 0xFE/0xFF got {tail!r}, expected [0xDD, 0xEE]"
    )

    # Read back reg[0x00] — should contain the wrapped byte.
    wrapped = await driver.read_bytes(_SLAVE_ADDR, 0x00, 1)
    assert wrapped == [0xFF], (
        f"Wrap-around: reg[0x00] got {wrapped!r}, expected [0xFF]"
    )


# ===========================================================================
# Test 8 — NACK on wrong slave address
# ===========================================================================


@cocotb.test()
async def test_nack_wrong_address(dut):
    """Sending to a non-existent address must result in NACK (ack_error = 1)."""
    driver = await _setup(dut)

    # 0x3F is not the configured slave address, so no ACK should come back.
    wrong_addr = 0x3F
    ok = await driver.write_bytes(wrong_addr, 0x00, [0xAA])

    assert not ok, (
        f"write_bytes to non-existent addr 0x{wrong_addr:02X} returned ACK — "
        "expected NACK (False)"
    )


# ===========================================================================
# Test 9 — scan: existing slave address
# ===========================================================================


@cocotb.test()
async def test_scan_existing_address(dut):
    """scan() on the configured slave address 0x50 must return True."""
    driver = await _setup(dut)

    found = await driver.scan(_SLAVE_ADDR)
    assert found is True, (
        f"scan(0x{_SLAVE_ADDR:02X}) returned {found!r}, expected True"
    )


# ===========================================================================
# Test 10 — scan: non-existent slave address
# ===========================================================================


@cocotb.test()
async def test_scan_nonexistent_address(dut):
    """scan() on a non-existent address must return False."""
    driver = await _setup(dut)

    absent_addr = 0x3F
    found = await driver.scan(absent_addr)
    assert found is False, (
        f"scan(0x{absent_addr:02X}) returned {found!r}, expected False"
    )


# ===========================================================================
# Runner — compile and execute all tests via the cocotb Python API
# ===========================================================================


def run_tests(
    *,
    build_dir: str | None = None,
    vcd_dir: str | None = None,
) -> None:
    """Compile RTL with Icarus and run all @cocotb.test() cases in this file.

    Parameters
    ----------
    build_dir:
        Directory for Icarus build artefacts.  Defaults to
        ``backend/sim/sim_build``.
    vcd_dir:
        Directory where the VCD waveform is written.  Not used directly here
        (the wrapper Verilog drives the $dumpfile path), but kept for API
        consistency with test_runner.run_simulation().
    """
    from cocotb_tools.runner import get_runner  # noqa: PLC0415

    rtl_dir = _SIM_DIR / "rtl"
    tb_dir = _SIM_DIR / "tb"

    verilog_sources = [
        rtl_dir / "i2c_master.v",
        rtl_dir / "i2c_slave.v",
        rtl_dir / "i2c_top.v",
        tb_dir / "i2c_system_wrapper.v",
    ]

    resolved_build_dir = pathlib.Path(build_dir) if build_dir else _SIM_DIR / "sim_build"

    runner = get_runner("icarus")
    runner.build(
        verilog_sources=[str(s) for s in verilog_sources],
        hdl_toplevel="i2c_system_wrapper",
        build_dir=str(resolved_build_dir),
        always=True,
    )
    runner.test(
        hdl_toplevel="i2c_system_wrapper",
        test_module="test_i2c_cocotb",
        build_dir=str(resolved_build_dir),
        test_dir=str(_TESTS_DIR),
    )


if __name__ == "__main__":
    run_tests()
