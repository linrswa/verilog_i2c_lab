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
# Internal helpers
# ---------------------------------------------------------------------------


def _chunk_list(lst: list[int], size: int) -> list[list[int]]:
    """Split *lst* into consecutive sublists of at most *size* elements."""
    return [lst[i : i + size] for i in range(0, len(lst), size)]
