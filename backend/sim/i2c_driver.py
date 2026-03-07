"""I2CDriver — transaction-level cocotb driver for the i2c_system_wrapper DUT.

This module wraps the DUT's control signals so that higher-level code can
perform I2C operations without manually toggling individual signals.

DUT signal map (i2c_system_wrapper):
  Inputs:  clk, rst_n, start, rw, slave_addr_in, data_in,
           num_bytes, repeated_start_in, slave_addr_cfg
  Outputs: busy, done, ack_error, data_out, data_valid, byte_count,
           slave_busy, reg_addr, reg_data_out, write_valid
"""

import cocotb
from cocotb.triggers import RisingEdge, ClockCycles


# Number of clock cycles to wait after de-asserting reset before the DUT is
# considered stable.  Matches the pattern used in test_i2c_system.py.
_RESET_ASSERT_CYCLES = 5
_RESET_SETTLE_CYCLES = 5


class I2CDriver:
    """Transaction-level driver for the I2C simulation DUT.

    Wraps the cocotb DUT handle and exposes async helpers so callers never
    have to manipulate individual signals directly.

    Parameters
    ----------
    dut:
        The cocotb DUT handle, typically the top-level module passed into a
        cocotb test coroutine.
    slave_addr_cfg:
        The 7-bit I2C address to configure on the slave device.  Defaults to
        0x50 (matching the wrapper default).
    """

    def __init__(self, dut, slave_addr_cfg: int = 0x50) -> None:
        self._dut = dut
        self._slave_addr_cfg = slave_addr_cfg

    # ------------------------------------------------------------------
    # Basic async primitives
    # ------------------------------------------------------------------

    async def delay(self, cycles: int) -> None:
        """Wait for *cycles* rising edges of the DUT clock.

        Parameters
        ----------
        cycles:
            Number of clock cycles to wait.  Must be >= 0; a value of 0 is a
            no-op.
        """
        if cycles > 0:
            await ClockCycles(self._dut.clk, cycles)

    async def reset(self) -> None:
        """Drive an active-low system reset and wait for the DUT to settle.

        Sequence
        --------
        1. Initialise all master control inputs to safe idle values.
        2. Assert rst_n = 0 for _RESET_ASSERT_CYCLES clock cycles.
        3. De-assert rst_n = 1.
        4. Wait _RESET_SETTLE_CYCLES clock cycles for internal state to
           stabilise.
        """
        dut = self._dut

        # Drive inputs to a known, safe state before asserting reset so that
        # no spurious transaction is started when rst_n is released.
        dut.rst_n.value = 0
        dut.start.value = 0
        dut.rw.value = 0
        dut.slave_addr_in.value = 0
        dut.data_in.value = 0
        dut.num_bytes.value = 0
        dut.repeated_start_in.value = 0
        dut.slave_addr_cfg.value = self._slave_addr_cfg

        # Hold reset asserted for a few cycles so all flip-flops see the low.
        await ClockCycles(dut.clk, _RESET_ASSERT_CYCLES)

        # Release reset and let the DUT settle.
        dut.rst_n.value = 1
        await ClockCycles(dut.clk, _RESET_SETTLE_CYCLES)

    # ------------------------------------------------------------------
    # Convenience properties
    # ------------------------------------------------------------------

    @property
    def dut(self):
        """Direct access to the underlying cocotb DUT handle."""
        return self._dut
