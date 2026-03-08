"""test_protocol_interpreter.py — Unit tests for ProtocolInterpreter.

Tests cover:
- Write sequence (start → send_byte(addr+W) → send_byte(data...) → stop)
- Read sequence  (start → send_byte(addr+R) → recv_byte... → stop)
- Write-then-read with repeated start
- Long sequences that require chunking (> 14 write bytes, > 15 read bytes)
- Validation errors for invalid sequences

Run with::
    pytest backend/tests/test_protocol_interpreter.py
"""

from __future__ import annotations

import pytest

from sim.protocol_interpreter import ProtocolInterpreter, Transaction


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _steps(*pairs) -> list[dict]:
    """Build a step list from (op, kwargs) pairs for conciseness."""
    steps = []
    for pair in pairs:
        if isinstance(pair, str):
            steps.append({"op": pair})
        else:
            op, kwargs = pair
            steps.append({"op": op, **kwargs})
    return steps


# ---------------------------------------------------------------------------
# Write sequence
# ---------------------------------------------------------------------------


class TestWriteSequence:
    def test_single_data_byte(self):
        """start → send_byte(0xA0 = addr 0x50 write) → send_byte(0x10) → stop"""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},  # addr 0x50, write
            {"op": "send_byte", "data": 0x10},  # data byte
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 1
        t = txns[0]
        assert t.addr == 0x50
        assert t.rw == 0
        assert t.data_bytes == [0x10]
        assert t.read_count == 0
        assert t.repeated_start is False

    def test_multiple_data_bytes(self):
        """Write with three data bytes."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "send_byte", "data": 0x01},
            {"op": "send_byte", "data": 0x02},
            {"op": "send_byte", "data": 0x03},
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 1
        assert txns[0].data_bytes == [0x01, 0x02, 0x03]

    def test_address_only_write(self):
        """Write with only an address byte (no data — valid for bus scan / reg ptr)."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 1
        t = txns[0]
        assert t.addr == 0x50
        assert t.rw == 0
        assert t.data_bytes == []
        assert t.repeated_start is False

    def test_write_address_decoding(self):
        """Various addr+RW bytes decode to the correct 7-bit address and direction.

        Only write-mode bytes (LSB=0) are used here; a read-mode address byte
        with zero recv_bytes would produce no transaction (nothing to read).
        """
        write_cases = [
            (0x00, 0x00, 0),  # addr 0, write
            (0xFE, 0x7F, 0),  # addr 0x7F, write
            (0x4E, 0x27, 0),  # addr 0x27, write
            (0xA0, 0x50, 0),  # addr 0x50, write
        ]
        for raw, expected_addr, expected_rw in write_cases:
            steps = [
                {"op": "start"},
                {"op": "send_byte", "data": raw},
                {"op": "stop"},
            ]
            txns = ProtocolInterpreter().interpret(steps)
            assert len(txns) == 1, f"expected 1 txn for raw=0x{raw:02X}"
            assert txns[0].addr == expected_addr, f"addr mismatch for raw=0x{raw:02X}"
            assert txns[0].rw == expected_rw, f"rw mismatch for raw=0x{raw:02X}"

        # Read-mode address bytes: verify rw=1 and addr decoding via a recv_byte.
        read_cases = [
            (0x01, 0x00, 1),  # addr 0, read
            (0xFF, 0x7F, 1),  # addr 0x7F, read
            (0xA1, 0x50, 1),  # addr 0x50, read
        ]
        for raw, expected_addr, expected_rw in read_cases:
            steps = [
                {"op": "start"},
                {"op": "send_byte", "data": raw},
                {"op": "recv_byte", "ack": False},
                {"op": "stop"},
            ]
            txns = ProtocolInterpreter().interpret(steps)
            assert len(txns) == 1, f"expected 1 txn for raw=0x{raw:02X}"
            assert txns[0].addr == expected_addr, f"addr mismatch for raw=0x{raw:02X}"
            assert txns[0].rw == expected_rw, f"rw mismatch for raw=0x{raw:02X}"

    def test_long_write_chunked(self):
        """15 data bytes should be split into two transactions (14 + 1)."""
        data = list(range(15))
        steps = (
            [{"op": "start"}, {"op": "send_byte", "data": 0xA0}]
            + [{"op": "send_byte", "data": b} for b in data]
            + [{"op": "stop"}]
        )
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 2
        assert txns[0].data_bytes == data[:14]
        assert txns[0].repeated_start is False  # intermediate chunk
        assert txns[1].data_bytes == data[14:]
        assert txns[1].repeated_start is False  # final chunk (stop)

    def test_exactly_14_data_bytes_not_chunked(self):
        """Exactly 14 data bytes fits in one transaction."""
        data = list(range(14))
        steps = (
            [{"op": "start"}, {"op": "send_byte", "data": 0xA0}]
            + [{"op": "send_byte", "data": b} for b in data]
            + [{"op": "stop"}]
        )
        txns = ProtocolInterpreter().interpret(steps)
        assert len(txns) == 1
        assert txns[0].data_bytes == data


# ---------------------------------------------------------------------------
# Read sequence
# ---------------------------------------------------------------------------


class TestReadSequence:
    def test_single_read_byte(self):
        """start → send_byte(0xA1 = addr 0x50 read) → recv_byte(ACK) → stop"""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA1},  # addr 0x50, read
            {"op": "recv_byte", "ack": True},
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 1
        t = txns[0]
        assert t.addr == 0x50
        assert t.rw == 1
        assert t.data_bytes == []
        assert t.read_count == 1
        assert t.repeated_start is False

    def test_multiple_read_bytes(self):
        """Read 3 bytes (2 ACK + 1 NACK)."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA1},
            {"op": "recv_byte", "ack": True},
            {"op": "recv_byte", "ack": True},
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 1
        assert txns[0].read_count == 3

    def test_long_read_chunked(self):
        """16 recv_bytes should split into two transactions (15 + 1)."""
        steps = (
            [{"op": "start"}, {"op": "send_byte", "data": 0xA1}]
            + [{"op": "recv_byte", "ack": True}] * 16
            + [{"op": "stop"}]
        )
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 2
        assert txns[0].read_count == 15
        assert txns[0].repeated_start is False
        assert txns[1].read_count == 1
        assert txns[1].repeated_start is False

    def test_exactly_15_read_bytes_not_chunked(self):
        """Exactly 15 recv_bytes fits in one transaction."""
        steps = (
            [{"op": "start"}, {"op": "send_byte", "data": 0xA1}]
            + [{"op": "recv_byte", "ack": True}] * 15
            + [{"op": "stop"}]
        )
        txns = ProtocolInterpreter().interpret(steps)
        assert len(txns) == 1
        assert txns[0].read_count == 15


# ---------------------------------------------------------------------------
# Write-then-read with repeated start
# ---------------------------------------------------------------------------


class TestRepeatedStart:
    def test_write_then_read(self):
        """Classic EEPROM pattern: write reg ptr → repeated_start → read N bytes.

        start → send_byte(0xA0) → send_byte(0x10) → repeated_start
                → send_byte(0xA1) → recv_byte(ACK) → recv_byte(NACK) → stop

        Expected:
          Transaction 1: addr=0x50, rw=WRITE, data=[0x10], repeated_start=True
          Transaction 2: addr=0x50, rw=READ,  read_count=2, repeated_start=False
        """
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "send_byte", "data": 0x10},
            {"op": "repeated_start"},
            {"op": "send_byte", "data": 0xA1},
            {"op": "recv_byte", "ack": True},
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 2

        t1 = txns[0]
        assert t1.addr == 0x50
        assert t1.rw == 0
        assert t1.data_bytes == [0x10]
        assert t1.read_count == 0
        assert t1.repeated_start is True

        t2 = txns[1]
        assert t2.addr == 0x50
        assert t2.rw == 1
        assert t2.data_bytes == []
        assert t2.read_count == 2
        assert t2.repeated_start is False

    def test_multiple_repeated_starts(self):
        """Three segments linked by repeated starts: write → RS → read → RS → write."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},  # write to 0x50
            {"op": "send_byte", "data": 0xAB},
            {"op": "repeated_start"},
            {"op": "send_byte", "data": 0xA1},  # read from 0x50
            {"op": "recv_byte", "ack": True},
            {"op": "repeated_start"},
            {"op": "send_byte", "data": 0x4E},  # write to 0x27
            {"op": "send_byte", "data": 0xFF},
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 3

        assert txns[0].addr == 0x50
        assert txns[0].rw == 0
        assert txns[0].data_bytes == [0xAB]
        assert txns[0].repeated_start is True

        assert txns[1].addr == 0x50
        assert txns[1].rw == 1
        assert txns[1].read_count == 1
        assert txns[1].repeated_start is True

        assert txns[2].addr == 0x27
        assert txns[2].rw == 0
        assert txns[2].data_bytes == [0xFF]
        assert txns[2].repeated_start is False

    def test_repeated_start_address_only_write(self):
        """Address-only write (no data bytes) followed by repeated start."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},  # addr 0x50, write
            {"op": "repeated_start"},
            {"op": "send_byte", "data": 0xA1},  # addr 0x50, read
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ]
        txns = ProtocolInterpreter().interpret(steps)

        assert len(txns) == 2
        assert txns[0].rw == 0
        assert txns[0].data_bytes == []
        assert txns[0].repeated_start is True
        assert txns[1].rw == 1
        assert txns[1].read_count == 1
        assert txns[1].repeated_start is False


# ---------------------------------------------------------------------------
# Validation errors
# ---------------------------------------------------------------------------


class TestValidationErrors:
    def test_send_byte_without_start(self):
        steps = [{"op": "send_byte", "data": 0xA0}]
        with pytest.raises(ValueError, match="outside of a transaction group"):
            ProtocolInterpreter().interpret(steps)

    def test_recv_byte_without_start(self):
        steps = [{"op": "recv_byte", "ack": True}]
        with pytest.raises(ValueError, match="outside of a transaction group"):
            ProtocolInterpreter().interpret(steps)

    def test_stop_without_start(self):
        steps = [{"op": "stop"}]
        with pytest.raises(ValueError, match="outside of a transaction group"):
            ProtocolInterpreter().interpret(steps)

    def test_repeated_start_without_start(self):
        steps = [{"op": "repeated_start"}]
        with pytest.raises(ValueError, match="outside of a transaction group"):
            ProtocolInterpreter().interpret(steps)

    def test_recv_byte_in_write_mode(self):
        """recv_byte after a write-mode address byte must raise ValueError."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},  # write mode (LSB=0)
            {"op": "recv_byte", "ack": True},
        ]
        with pytest.raises(ValueError, match="recv_byte.*write mode|write mode.*recv_byte"):
            ProtocolInterpreter().interpret(steps)

    def test_send_byte_data_in_read_mode(self):
        """Data send_byte after a read-mode address byte must raise ValueError."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA1},  # read mode (LSB=1)
            {"op": "send_byte", "data": 0x10},  # data byte not allowed in read mode
        ]
        with pytest.raises(ValueError, match="send_byte.*read.mode|read.mode.*send_byte"):
            ProtocolInterpreter().interpret(steps)

    def test_nested_start(self):
        """A second 'start' inside an open group must raise ValueError."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "start"},  # nested — invalid
        ]
        with pytest.raises(ValueError, match="already inside"):
            ProtocolInterpreter().interpret(steps)

    def test_unclosed_group(self):
        """A sequence ending without 'stop' must raise ValueError."""
        steps = [
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "send_byte", "data": 0x10},
            # missing stop
        ]
        with pytest.raises(ValueError, match="without a 'stop'"):
            ProtocolInterpreter().interpret(steps)

    def test_send_byte_missing_data_field(self):
        steps = [
            {"op": "start"},
            {"op": "send_byte"},  # no 'data' key
        ]
        with pytest.raises(ValueError, match="missing 'data' field"):
            ProtocolInterpreter().interpret(steps)

    def test_recv_byte_before_address(self):
        """recv_byte before the address byte should raise ValueError."""
        steps = [
            {"op": "start"},
            {"op": "recv_byte", "ack": True},  # no address yet
        ]
        with pytest.raises(ValueError, match="before the address byte"):
            ProtocolInterpreter().interpret(steps)

    def test_stop_before_address(self):
        """stop immediately after start (no address byte) should raise ValueError."""
        steps = [
            {"op": "start"},
            {"op": "stop"},
        ]
        with pytest.raises(ValueError, match="before the address byte"):
            ProtocolInterpreter().interpret(steps)

    def test_repeated_start_before_address(self):
        """repeated_start immediately after start (no address byte) should raise ValueError."""
        steps = [
            {"op": "start"},
            {"op": "repeated_start"},
        ]
        with pytest.raises(ValueError, match="before the address byte"):
            ProtocolInterpreter().interpret(steps)

    def test_unknown_op(self):
        steps = [{"op": "wiggle"}]
        with pytest.raises(ValueError, match="Unknown op"):
            ProtocolInterpreter().interpret(steps)

    def test_empty_steps(self):
        """Empty step list produces an empty transaction list — not an error."""
        txns = ProtocolInterpreter().interpret([])
        assert txns == []
