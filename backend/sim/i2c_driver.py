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

    def __init__(
        self,
        dut,
        slave_addr_cfg: int = 0x50,
        clk_div: int = 50,
    ) -> None:
        self._dut = dut
        self._slave_addr_cfg = slave_addr_cfg
        # Number of system clock cycles per I2C clock phase.  Must match the
        # CLK_DIV parameter used when building i2c_top (default 50).  Used to
        # compute the timing window for feeding write payload bytes to the
        # hardware data_in signal.
        self._clk_div = clk_div

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
    # Write operations
    # ------------------------------------------------------------------

    async def write_bytes(self, addr: int, reg: int, data: list) -> bool:
        """Write *data* bytes to *addr* starting at register *reg*.

        The I2C write transaction format understood by this master is:

            START | slave_addr+W | ACK | reg_byte | ACK | data[0] | ACK | ... | STOP

        The hardware ``num_bytes`` field is 4-bit (range 1-15), so writes
        longer than 14 data bytes are split into multiple transactions.  The
        slave auto-increments its register pointer on every byte received, so
        subsequent transactions supply the updated register address and carry
        on from where the previous one left off.

        Parameters
        ----------
        addr:
            7-bit I2C slave address.
        reg:
            8-bit register start address (register pointer byte).
        data:
            List of 1-256 byte values to write.

        Returns
        -------
        bool
            ``True`` when all bytes were acknowledged, ``False`` if the master
            detected a NACK at any point during the transaction sequence.
        """
        if not data:
            return True

        # Maximum data bytes per hardware transaction (num_bytes is 4-bit,
        # one slot is consumed by the register pointer byte).
        _MAX_DATA_PER_TXN = 14

        dut = self._dut
        remaining = list(data)
        current_reg = reg & 0xFF

        while remaining:
            chunk = remaining[:_MAX_DATA_PER_TXN]
            remaining = remaining[_MAX_DATA_PER_TXN:]

            # Total bytes in this transaction: 1 (reg ptr) + len(chunk).
            total_bytes = 1 + len(chunk)

            # Build the full byte sequence for this transaction so we can feed
            # them in order: [reg_ptr, data[0], data[1], ...].
            payload = [current_reg & 0xFF] + [b & 0xFF for b in chunk]

            # Set up master control signals before asserting start.
            dut.slave_addr_in.value = addr
            dut.rw.value = 0
            dut.num_bytes.value = total_bytes
            dut.repeated_start_in.value = 0
            dut.data_in.value = payload[0]  # first byte (reg pointer)

            # Pulse start for exactly one clock cycle.
            dut.start.value = 1
            await RisingEdge(dut.clk)
            dut.start.value = 0

            # ----------------------------------------------------------------
            # Payload feeding strategy
            # ----------------------------------------------------------------
            # The master samples data_in into data_buf at HIGH_MID of the ACK
            # phase following each byte:
            #
            #   ADDR-ACK HIGH_MID  → captures payload[0] (reg pointer)
            #   WRITE-ACK-0 HIGH_MID → captures payload[1] (first data byte)
            #   WRITE-ACK-N HIGH_MID → captures payload[N+1]
            #
            # The ADDR-ACK capture and byte_count increment are SIMULTANEOUS
            # Verilog non-blocking assignments; the driver cannot react in time
            # for payload[1] using a byte_count poll.
            #
            # Fix: wait long enough to pass the ADDR+ADDR-ACK phases
            # (approximately 10 × CLK_DIV system clocks), then present
            # payload[1] while the master is still in its first WRITE phase.
            # This mirrors the approach used in test_i2c_system.py.
            #
            # For payload[2+], the WRITE-ACK fires 8 × CLK_DIV clocks after
            # byte_count increments, so observing byte_count one clock late
            # and immediately updating data_in still leaves ~8×CLK_DIV-1 clocks
            # of margin before the next capture point.
            # ----------------------------------------------------------------

            next_payload_idx = 1
            addr_ack_wait = self._clk_div * 11  # clocks to clear ADDR + ADDR-ACK

            if len(payload) > 1:
                # Wait until we are past the ADDR-ACK phase so that data_in
                # will be captured as payload[1] at WRITE-ACK-0 HIGH_MID.
                done_seen = False
                for _ in range(addr_ack_wait):
                    await RisingEdge(dut.clk)
                    if dut.done.value == 1:
                        done_seen = True
                        break

                if not done_seen:
                    dut.data_in.value = payload[next_payload_idx]
                    next_payload_idx += 1
            else:
                done_seen = False

            # Wait for the transaction to complete, feeding remaining payload
            # bytes as byte_count advances.
            #
            # The master captures data_in at HIGH_MID of WRITE-ACK-N, which is
            # the same clock edge that increments byte_count from N to N+1.
            # The driver observes the incremented byte_count one clock later —
            # too late for that same capture.
            #
            # Correction: trigger the pre-load of payload[N+1] when byte_count
            # reaches N-1 (i.e. >= next_payload_idx - 1).  At that point the
            # master has just entered the WRITE phase for byte N (8 × CLK_DIV
            # clocks long), so data_in is captured well before WRITE-ACK-N.
            while not done_seen:
                await RisingEdge(dut.clk)

                if dut.done.value == 1:
                    done_seen = True
                    break

                if next_payload_idx < len(payload):
                    current_byte_count = int(dut.byte_count.value)
                    if current_byte_count >= next_payload_idx - 1:
                        dut.data_in.value = payload[next_payload_idx]
                        next_payload_idx += 1

            # Check for NACK before proceeding to the next chunk.
            if int(dut.ack_error.value) == 1:
                return False

            # Advance the register pointer by the number of data bytes sent so
            # that the next transaction continues at the right offset (wraps at
            # 256 to mirror the slave's 8-bit auto-increment).
            current_reg = (current_reg + len(chunk)) & 0xFF

            # Brief inter-transaction gap so the slave is ready.
            await ClockCycles(dut.clk, 10)

        return True

    # ------------------------------------------------------------------
    # Read operations
    # ------------------------------------------------------------------

    async def read_bytes(self, addr: int, reg: int, n: int) -> list:
        """Read *n* bytes from *addr* starting at register *reg*.

        The I2C read sequence for this master is a stop-start (two separate
        transactions) pattern:

        1. Write transaction (register pointer):
               START | slave_addr+W | ACK | reg_byte | ACK | STOP
        2. Read transaction:
               START | slave_addr+R | ACK | data[0] | ACK | ... | data[n-1] | NACK | STOP

        The hardware ``num_bytes`` field is 4-bit (range 1-15), so reads
        longer than 15 bytes are split into multiple stop-start pairs.  The
        slave auto-increments its register pointer after each byte sent, so
        subsequent chunks supply the updated register address.

        Parameters
        ----------
        addr:
            7-bit I2C slave address.
        reg:
            8-bit register start address (register pointer byte).
        n:
            Number of bytes to read (1-256).

        Returns
        -------
        list[int]
            List of byte values read from the slave, in order.
        """
        if n <= 0:
            return []

        # Maximum bytes per hardware read transaction (num_bytes is 4-bit, max 15).
        _MAX_READ_PER_TXN = 15

        dut = self._dut
        result: list = []
        current_reg = reg & 0xFF
        remaining = n

        while remaining > 0:
            chunk_size = min(remaining, _MAX_READ_PER_TXN)

            # --- Phase 1: Write transaction to set the register pointer ---
            dut.slave_addr_in.value = addr
            dut.rw.value = 0
            dut.num_bytes.value = 1          # only the register pointer byte
            dut.repeated_start_in.value = 0
            dut.data_in.value = current_reg

            dut.start.value = 1
            await RisingEdge(dut.clk)
            dut.start.value = 0

            # Wait for done from the write transaction.
            while True:
                await RisingEdge(dut.clk)
                if dut.done.value == 1:
                    break

            # If the slave NACKed the address, abort and return what we have.
            if int(dut.ack_error.value) == 1:
                return result

            # Brief inter-transaction gap (stop-start).
            await ClockCycles(dut.clk, 10)

            # --- Phase 2: Read transaction to collect data bytes ---
            dut.slave_addr_in.value = addr
            dut.rw.value = 1
            dut.num_bytes.value = chunk_size
            dut.repeated_start_in.value = 0

            dut.start.value = 1
            await RisingEdge(dut.clk)
            dut.start.value = 0

            # Collect bytes as they arrive via data_valid.
            chunk_received: list = []
            while len(chunk_received) < chunk_size:
                await RisingEdge(dut.clk)
                if dut.done.value == 1:
                    # done fired before all bytes arrived — hardware finished early
                    break
                if dut.data_valid.value == 1:
                    chunk_received.append(int(dut.data_out.value))

            # Wait for done if we exited the loop because all data was captured
            # before the done pulse.
            if len(chunk_received) >= chunk_size:
                while True:
                    await RisingEdge(dut.clk)
                    if dut.done.value == 1:
                        break

            result.extend(chunk_received)
            remaining -= len(chunk_received)

            # Advance register pointer by bytes actually received (slave wraps at 256).
            current_reg = (current_reg + len(chunk_received)) & 0xFF

            # Brief gap before next stop-start pair if more chunks remain.
            if remaining > 0:
                await ClockCycles(dut.clk, 10)

        return result

    # ------------------------------------------------------------------
    # Scan and register dump utilities
    # ------------------------------------------------------------------

    async def scan(self, addr: int) -> bool:
        """Probe whether a slave is present at *addr* by sending a write transaction.

        A zero-byte write transaction is issued to *addr*.  If the slave ACKs
        its address byte the method returns ``True``; if no slave responds
        (NACK) it returns ``False``.

        The scan is implemented as a minimal write: only the address phase is
        needed, so we send a single register-pointer byte (0x00) and rely on
        the ack_error flag to report whether the slave was present.

        Parameters
        ----------
        addr:
            7-bit I2C slave address to probe.

        Returns
        -------
        bool
            ``True`` if a slave acknowledged the address, ``False`` otherwise.
        """
        dut = self._dut

        # Send a write transaction with a single dummy byte (register 0x00).
        # The slave will ACK its address if it is present; ack_error will be
        # set if no ACK is received.
        dut.slave_addr_in.value = addr
        dut.rw.value = 0
        dut.num_bytes.value = 1      # one byte: the register pointer
        dut.repeated_start_in.value = 0
        dut.data_in.value = 0x00     # dummy register address byte

        # Pulse start for exactly one clock cycle.
        dut.start.value = 1
        await RisingEdge(dut.clk)
        dut.start.value = 0

        # Wait for the transaction to complete.
        while True:
            await RisingEdge(dut.clk)
            if dut.done.value == 1:
                break

        # ack_error == 1 means the slave did not ACK → address not present.
        slave_found = int(dut.ack_error.value) == 0

        # Brief settling gap before the caller issues the next operation.
        await ClockCycles(dut.clk, 10)

        return slave_found

    async def get_register_dump(self) -> dict:
        """Return a snapshot of the slave's internal register file.

        Reads the ``register_file`` memory array directly from the DUT
        hierarchy without issuing any I2C transactions.  This is a pure
        simulation utility and has no effect on DUT state.

        DUT hierarchy path
        ------------------
        i2c_system_wrapper
          └── dut          (i2c_top instance, named "dut" in the wrapper)
                └── slave_inst  (i2c_slave instance)
                      └── register_file[0:255]

        Returns
        -------
        dict
            Mapping of register address (int) → byte value (int) for all 256
            registers.  Example: ``{0: 0xAB, 1: 0x00, ..., 255: 0x00}``.
        """
        slave = self._dut.dut.slave_inst
        dump: dict = {}
        for i in range(256):
            dump[i] = int(slave.register_file[i].value)
        return dump

    # ------------------------------------------------------------------
    # Convenience properties
    # ------------------------------------------------------------------

    @property
    def dut(self):
        """Direct access to the underlying cocotb DUT handle."""
        return self._dut
