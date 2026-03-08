"""protocol_interpreter.py — Protocol step interpreter for the I2C driver layer.

Converts a sequence of fine-grained protocol-level steps (start, send_byte,
recv_byte, repeated_start, stop) into a list of Transaction objects that the
RTL master can execute atomically.

Address byte convention (real I2C wire protocol):
  Bits [7:1] = 7-bit slave address
  Bit [0]    = R/W direction (0 = write, 1 = read)

  Examples:
    0xA0 → addr 0x50, write (LSB = 0)
    0xA1 → addr 0x50, read  (LSB = 1)

Hardware constraint: num_bytes is 4-bit (max 15).
  - Write: max 14 data bytes per transaction (1 slot for register pointer byte)
  - Read:  max 15 bytes per transaction

Long sequences are automatically chunked into multiple transactions.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Transaction:
    """A single I2C master transaction for the RTL hardware.

    Parameters
    ----------
    addr:
        7-bit slave address (bits [7:1] of the address+RW byte).
    rw:
        Direction: 0 = write, 1 = read.
    data_bytes:
        Payload bytes for write transactions. Empty for read transactions.
    read_count:
        Number of bytes to read. 0 for write transactions.
    repeated_start:
        True when this transaction is followed by a repeated start (no STOP).
        False when this transaction ends with STOP.
    """

    addr: int
    rw: int  # 0 = write, 1 = read
    data_bytes: list[int] = field(default_factory=list)
    read_count: int = 0
    repeated_start: bool = False


@dataclass
class TxnResult:
    """Result of a single executed I2C transaction.

    Parameters
    ----------
    ack_ok:
        True when the slave acknowledged all address and data bytes; False
        when a NACK was detected.
    data_read:
        Bytes captured from the slave during a read transaction.  Empty for
        write transactions.
    bytes_written:
        Number of data bytes successfully written during a write transaction.
        0 for read transactions.
    start_time_ps:
        Simulation time in picoseconds at the start of this transaction.
        None when timing was not recorded (e.g. in unit tests that do not
        run under cocotb).
    end_time_ps:
        Simulation time in picoseconds at the end of this transaction.
        None when timing was not recorded.
    """

    ack_ok: bool
    data_read: list[int] = field(default_factory=list)
    bytes_written: int = 0
    start_time_ps: int | None = None
    end_time_ps: int | None = None
    byte_end_times_ps: list[int] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Hardware limits
# ---------------------------------------------------------------------------

_MAX_WRITE_DATA_BYTES = 14  # num_bytes is 4-bit; one slot consumed by reg ptr
_MAX_READ_BYTES = 15        # num_bytes is 4-bit; all slots available for data


class ProtocolInterpreter:
    """Interprets protocol-level I2C step sequences into Transaction lists.

    Usage
    -----
    interpreter = ProtocolInterpreter()
    transactions = interpreter.interpret(steps)

    Steps format
    ------------
    Each step is a dict with an ``op`` key and optional parameters:

      {"op": "start"}
      {"op": "send_byte", "data": 0xA0}   # first after start = addr+RW byte
      {"op": "send_byte", "data": 0x10}   # subsequent = data bytes
      {"op": "recv_byte",  "ack": True}    # True = ACK, False = NACK
      {"op": "repeated_start"}
      {"op": "stop"}
    """

    def interpret(self, steps: list[dict]) -> list[Transaction]:
        """Group protocol steps into a list of Transaction objects.

        Parameters
        ----------
        steps:
            Ordered list of protocol step dicts.

        Returns
        -------
        list[Transaction]
            Transactions ready for the RTL master to execute.

        Raises
        ------
        ValueError
            When the step sequence is invalid (e.g. send_byte without a
            preceding start, recv_byte in write mode, stop without start).
        """
        transactions: list[Transaction] = []

        # State tracking for the current in-progress transaction group.
        in_group = False
        addr: int = 0
        rw: int = 0
        data_bytes: list[int] = []
        read_count: int = 0
        first_send_after_start: bool = False  # True until address byte consumed

        def _flush(is_repeated_start: bool) -> None:
            """Finalise the current group and append Transaction(s) to output.

            Long write data sequences are automatically chunked to respect the
            4-bit num_bytes hardware limit.  Long read sequences are similarly
            chunked.
            """
            nonlocal in_group, addr, rw, data_bytes, read_count, first_send_after_start

            if rw == 0:
                # Write transaction — chunk data_bytes if needed.
                if not data_bytes:
                    # A write with only the address byte and no data is valid
                    # (e.g. a register-pointer-only write or a bus scan).
                    transactions.append(
                        Transaction(
                            addr=addr,
                            rw=0,
                            data_bytes=[],
                            read_count=0,
                            repeated_start=is_repeated_start,
                        )
                    )
                else:
                    chunks = _chunk_list(data_bytes, _MAX_WRITE_DATA_BYTES)
                    for i, chunk in enumerate(chunks):
                        is_last = i == len(chunks) - 1
                        transactions.append(
                            Transaction(
                                addr=addr,
                                rw=0,
                                data_bytes=chunk,
                                read_count=0,
                                repeated_start=is_repeated_start if is_last else False,
                            )
                        )
            else:
                # Read transaction — chunk read_count if needed.
                remaining = read_count
                while remaining > 0:
                    chunk_size = min(remaining, _MAX_READ_BYTES)
                    remaining -= chunk_size
                    is_last = remaining == 0
                    transactions.append(
                        Transaction(
                            addr=addr,
                            rw=1,
                            data_bytes=[],
                            read_count=chunk_size,
                            repeated_start=is_repeated_start if is_last else False,
                        )
                    )

            # Reset group state.
            in_group = False
            addr = 0
            rw = 0
            data_bytes = []
            read_count = 0
            first_send_after_start = False

        for i, step in enumerate(steps):
            op = step.get("op")

            if op == "start":
                if in_group:
                    raise ValueError(
                        f"Step {i}: 'start' received while already inside a "
                        f"transaction group. Did you forget 'stop' or 'repeated_start'?"
                    )
                in_group = True
                first_send_after_start = True
                addr = 0
                rw = 0
                data_bytes = []
                read_count = 0

            elif op == "send_byte":
                if not in_group:
                    raise ValueError(
                        f"Step {i}: 'send_byte' encountered outside of a "
                        f"transaction group (missing 'start')."
                    )
                raw_byte = step.get("data")
                if raw_byte is None:
                    raise ValueError(f"Step {i}: 'send_byte' missing 'data' field.")
                raw_byte = int(raw_byte) & 0xFF

                if first_send_after_start:
                    # This is the address+RW byte.
                    addr = (raw_byte >> 1) & 0x7F
                    rw = raw_byte & 0x01
                    first_send_after_start = False
                else:
                    # Subsequent bytes are data bytes (write mode only).
                    if rw == 1:
                        raise ValueError(
                            f"Step {i}: 'send_byte' (data byte) used after a "
                            f"read-mode address byte. Use 'recv_byte' for reads."
                        )
                    data_bytes.append(raw_byte)

            elif op == "recv_byte":
                if not in_group:
                    raise ValueError(
                        f"Step {i}: 'recv_byte' encountered outside of a "
                        f"transaction group (missing 'start')."
                    )
                if first_send_after_start:
                    raise ValueError(
                        f"Step {i}: 'recv_byte' before the address byte — "
                        f"'send_byte' must come first after 'start'."
                    )
                if rw == 0:
                    raise ValueError(
                        f"Step {i}: 'recv_byte' used in write mode (address "
                        f"byte LSB=0). 'recv_byte' is only valid after a "
                        f"read-mode address byte (LSB=1)."
                    )
                read_count += 1

            elif op == "repeated_start":
                if not in_group:
                    raise ValueError(
                        f"Step {i}: 'repeated_start' encountered outside of a "
                        f"transaction group (missing 'start')."
                    )
                if first_send_after_start:
                    raise ValueError(
                        f"Step {i}: 'repeated_start' before the address byte — "
                        f"transaction group has no address."
                    )
                _flush(is_repeated_start=True)
                # Begin a new group immediately.
                in_group = True
                first_send_after_start = True

            elif op == "stop":
                if not in_group:
                    raise ValueError(
                        f"Step {i}: 'stop' encountered outside of a transaction "
                        f"group (missing 'start')."
                    )
                if first_send_after_start:
                    raise ValueError(
                        f"Step {i}: 'stop' before the address byte — transaction "
                        f"group has no address."
                    )
                _flush(is_repeated_start=False)

            else:
                raise ValueError(f"Step {i}: Unknown op '{op}'.")

        if in_group:
            raise ValueError(
                "Protocol sequence ended without a 'stop' or 'repeated_start' "
                "to close the last transaction group."
            )

        return transactions


# ---------------------------------------------------------------------------
# Sequence validation
# ---------------------------------------------------------------------------


def validate_protocol_sequence(steps: list[dict]) -> list[str]:
    """Validate a protocol step sequence without executing it.

    Checks for structural and semantic errors in the step sequence and
    returns a list of human-readable error strings.  An empty list means the
    sequence is valid.

    Rules checked
    -------------
    1. ``send_byte`` / ``recv_byte`` must only appear between a ``start`` and
       a ``stop`` / ``repeated_start``.
    2. Every ``start`` must be closed by a ``stop`` or ``repeated_start``
       before another ``start`` is encountered.
    3. The first ``send_byte`` after a ``start`` must be a valid address+RW
       byte (0x00–0xFF).  An immediate ``stop`` or ``repeated_start`` before
       any ``send_byte`` is an error.
    4. ``recv_byte`` is only valid in read mode (address byte LSB = 1).
    5. ``send_byte`` (after the address byte) is only valid in write mode
       (address byte LSB = 0).
    6. An unclosed group at the end of the sequence is an error.

    Parameters
    ----------
    steps:
        Ordered list of protocol step dicts, each with at minimum an ``op``
        key.

    Returns
    -------
    list[str]
        Human-readable error descriptions.  Empty list = valid sequence.
    """
    errors: list[str] = []

    # Empty sequence is valid — it simply means no protocol steps.
    if not steps:
        return errors

    in_group = False
    awaiting_address = False  # True after start, until first send_byte consumed
    rw: int = 0               # 0 = write, 1 = read; only meaningful when in_group

    for i, step in enumerate(steps):
        op = step.get("op")

        if op == "start":
            if in_group:
                errors.append(
                    f"Step {i}: 'start' inside an already-open transaction group "
                    f"(missing 'stop' or 'repeated_start' before this 'start')."
                )
                # Keep going using the new start as the current group head.
            in_group = True
            awaiting_address = True
            rw = 0

        elif op == "send_byte":
            if not in_group:
                errors.append(
                    f"Step {i}: 'send_byte' outside of a transaction group "
                    f"(no preceding 'start')."
                )
            else:
                raw_byte = step.get("data")
                if raw_byte is None:
                    errors.append(
                        f"Step {i}: 'send_byte' missing required 'data' field."
                    )
                else:
                    try:
                        # Accept plain integers or hex strings like "0xA0".
                        if isinstance(raw_byte, str):
                            byte_val = int(raw_byte, 0) & 0xFF
                        else:
                            byte_val = int(raw_byte) & 0xFF
                    except (TypeError, ValueError):
                        errors.append(
                            f"Step {i}: 'send_byte' has non-integer 'data' value "
                            f"{raw_byte!r}."
                        )
                        byte_val = None  # type: ignore[assignment]

                    if byte_val is not None:
                        if awaiting_address:
                            # First send_byte after start — this is the address+RW byte.
                            # Any value 0x00-0xFF is structurally valid (already masked).
                            rw = byte_val & 0x01
                            awaiting_address = False
                        else:
                            # Subsequent send_byte — must be in write mode.
                            if rw == 1:
                                errors.append(
                                    f"Step {i}: 'send_byte' (data byte) used in read "
                                    f"mode (address byte LSB=1). Use 'recv_byte' to "
                                    f"receive bytes in read mode."
                                )

        elif op == "recv_byte":
            if not in_group:
                errors.append(
                    f"Step {i}: 'recv_byte' outside of a transaction group "
                    f"(no preceding 'start')."
                )
            elif awaiting_address:
                errors.append(
                    f"Step {i}: 'recv_byte' before the address byte — "
                    f"a 'send_byte' with the address+RW byte must come first after 'start'."
                )
            elif rw == 0:
                errors.append(
                    f"Step {i}: 'recv_byte' used in write mode (address byte LSB=0). "
                    f"'recv_byte' is only valid after a read-mode address byte (LSB=1)."
                )

        elif op == "repeated_start":
            if not in_group:
                errors.append(
                    f"Step {i}: 'repeated_start' outside of a transaction group "
                    f"(no preceding 'start')."
                )
            elif awaiting_address:
                errors.append(
                    f"Step {i}: 'repeated_start' before the address byte — "
                    f"transaction group has no address byte."
                )
            else:
                # Close current group and open a new one.
                in_group = True
                awaiting_address = True
                rw = 0

        elif op == "stop":
            if not in_group:
                errors.append(
                    f"Step {i}: 'stop' outside of a transaction group "
                    f"(no preceding 'start')."
                )
            elif awaiting_address:
                errors.append(
                    f"Step {i}: 'stop' before the address byte — "
                    f"transaction group has no address byte (start immediately followed by stop)."
                )
            else:
                in_group = False
                awaiting_address = False
                rw = 0

        # Unknown ops are not flagged here — validation is structural only.
        # The interpreter raises ValueError for unknown ops at execution time.

    if in_group:
        errors.append(
            "Protocol sequence ended without a 'stop' to close the last "
            "transaction group."
        )

    return errors


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _chunk_list(lst: list[int], size: int) -> list[list[int]]:
    """Split *lst* into consecutive sublists of at most *size* elements."""
    return [lst[i : i + size] for i in range(0, len(lst), size)]
