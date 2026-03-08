"""test_test_runner.py — Unit tests for test_runner.py parse_step() and
execute_sequence() with protocol-level ops.

Tests cover:
- parse_step() for all new ops: start, stop, repeated_start, send_byte, recv_byte
- parse_step() hex-string parsing for send_byte
- parse_step() validation errors (missing fields, unknown op)
- _map_protocol_results() mapping logic
- execute_sequence() buffering via a mock I2CDriver
- Existing ops (reset, write_bytes, read_bytes, scan, delay) unchanged

Run with::
    pytest backend/tests/test_test_runner.py
"""

from __future__ import annotations

import asyncio
import sys
import pathlib

import pytest

# Ensure sim directory is on path (needed for test_runner imports).
_BACKEND_DIR = pathlib.Path(__file__).parent.parent.resolve()
_SIM_DIR = _BACKEND_DIR / "sim"
if str(_SIM_DIR) not in sys.path:
    sys.path.insert(0, str(_SIM_DIR))
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# test_runner imports cocotb at module level; patch it before importing.
import types
import unittest.mock as mock

# Build a minimal stub for cocotb so test_runner can be imported without a
# simulation environment.
cocotb_stub = types.ModuleType("cocotb")
cocotb_stub.test = lambda **kw: (lambda f: f)  # @cocotb.test() → identity decorator

# Stub cocotb.runner
runner_stub = types.ModuleType("cocotb.runner")


def _fake_get_runner(name: str):
    return mock.MagicMock()


runner_stub.get_runner = _fake_get_runner

# Stub cocotb.triggers (used by i2c_driver.py)
triggers_stub = types.ModuleType("cocotb.triggers")
triggers_stub.RisingEdge = mock.MagicMock()
triggers_stub.ClockCycles = mock.MagicMock()
cocotb_stub.triggers = triggers_stub

sys.modules.setdefault("cocotb", cocotb_stub)
sys.modules.setdefault("cocotb.runner", runner_stub)
sys.modules.setdefault("cocotb.triggers", triggers_stub)

# Now we can safely import the module under test.
from test_runner import (  # noqa: E402
    parse_step,
    parse_sequence,
    _map_protocol_results,
    VALID_OPS,
    PROTOCOL_OPS,
)
from sim.protocol_interpreter import TxnResult  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _step(op: str, **kwargs) -> dict:
    return {"op": op, **kwargs}


# ---------------------------------------------------------------------------
# VALID_OPS / PROTOCOL_OPS membership
# ---------------------------------------------------------------------------


class TestOpsRegistries:
    def test_protocol_ops_in_valid_ops(self):
        for op in PROTOCOL_OPS:
            assert op in VALID_OPS, f"{op!r} should be in VALID_OPS"

    def test_legacy_ops_still_present(self):
        for op in ("reset", "write_bytes", "read_bytes", "scan", "delay"):
            assert op in VALID_OPS

    def test_protocol_ops_set(self):
        assert PROTOCOL_OPS == frozenset(
            {"start", "stop", "repeated_start", "send_byte", "recv_byte"}
        )


# ---------------------------------------------------------------------------
# parse_step — new ops
# ---------------------------------------------------------------------------


class TestParseStepProtocolOps:
    def test_parse_start(self):
        result = parse_step({"op": "start"})
        assert result == {"op": "start"}

    def test_parse_stop(self):
        result = parse_step({"op": "stop"})
        assert result == {"op": "stop"}

    def test_parse_repeated_start(self):
        result = parse_step({"op": "repeated_start"})
        assert result == {"op": "repeated_start"}

    def test_parse_send_byte_int(self):
        result = parse_step({"op": "send_byte", "data": 0xA0})
        assert result == {"op": "send_byte", "data": 0xA0}

    def test_parse_send_byte_hex_string(self):
        result = parse_step({"op": "send_byte", "data": "0xA0"})
        assert result["op"] == "send_byte"
        assert result["data"] == 0xA0

    def test_parse_send_byte_decimal_string(self):
        result = parse_step({"op": "send_byte", "data": "160"})
        assert result["data"] == 160

    def test_parse_send_byte_truncates_to_byte(self):
        # Values above 0xFF are masked to 0xFF range.
        result = parse_step({"op": "send_byte", "data": 0x1A0})
        assert result["data"] == 0xA0

    def test_parse_send_byte_missing_data_raises(self):
        with pytest.raises(ValueError, match="data"):
            parse_step({"op": "send_byte"})

    def test_parse_recv_byte_true(self):
        result = parse_step({"op": "recv_byte", "ack": True})
        assert result == {"op": "recv_byte", "ack": True}

    def test_parse_recv_byte_false(self):
        result = parse_step({"op": "recv_byte", "ack": False})
        assert result == {"op": "recv_byte", "ack": False}

    def test_parse_recv_byte_missing_ack_raises(self):
        with pytest.raises(ValueError, match="ack"):
            parse_step({"op": "recv_byte"})

    def test_parse_recv_byte_coerces_to_bool(self):
        # Truthy/falsy values are coerced.
        result = parse_step({"op": "recv_byte", "ack": 1})
        assert result["ack"] is True
        result2 = parse_step({"op": "recv_byte", "ack": 0})
        assert result2["ack"] is False


# ---------------------------------------------------------------------------
# parse_step — existing ops still work
# ---------------------------------------------------------------------------


class TestParseStepLegacyOps:
    def test_reset(self):
        assert parse_step({"op": "reset"}) == {"op": "reset"}

    def test_delay(self):
        assert parse_step({"op": "delay", "cycles": 10}) == {
            "op": "delay",
            "cycles": 10,
        }

    def test_write_bytes_basic(self):
        result = parse_step(
            {"op": "write_bytes", "addr": "0x50", "reg": "0x00", "data": [1, 2]}
        )
        assert result["addr"] == 0x50
        assert result["reg"] == 0
        assert result["data"] == [1, 2]

    def test_read_bytes_basic(self):
        result = parse_step(
            {"op": "read_bytes", "addr": 0x50, "reg": 0x00, "n": 3}
        )
        assert result["n"] == 3

    def test_scan_basic(self):
        result = parse_step({"op": "scan", "addr": 0x50})
        assert result["addr"] == 0x50

    def test_unknown_op_raises(self):
        with pytest.raises(ValueError, match="Invalid operation type"):
            parse_step({"op": "teleport"})

    def test_missing_op_raises(self):
        with pytest.raises(ValueError, match="missing required 'op'"):
            parse_step({"data": 0x00})


# ---------------------------------------------------------------------------
# _map_protocol_results
# ---------------------------------------------------------------------------


class TestMapProtocolResults:
    def _write_txn_result(self, ack_ok: bool = True) -> TxnResult:
        return TxnResult(ack_ok=ack_ok, data_read=[], bytes_written=1)

    def _read_txn_result(self, data: list, ack_ok: bool = True) -> TxnResult:
        return TxnResult(ack_ok=ack_ok, data_read=data, bytes_written=0)

    def test_simple_write_sequence(self):
        """start → send_byte(0xA0) → send_byte(0x10) → stop maps to 2 send_byte results."""
        buffered = [
            _step("start"),
            _step("send_byte", data=0xA0),
            _step("send_byte", data=0x10),
            _step("stop"),
        ]
        txn_results = [self._write_txn_result()]
        results = _map_protocol_results(buffered, txn_results)

        assert len(results) == 2
        # Address byte
        assert results[0]["op"] == "send_byte"
        assert results[0]["data"] == hex(0xA0)
        assert results[0]["status"] == "ok"
        assert results[0]["addr"] == hex(0x50)
        assert results[0]["rw"] == "write"
        # Data byte
        assert results[1]["op"] == "send_byte"
        assert results[1]["data"] == hex(0x10)
        assert results[1]["status"] == "ok"
        assert "addr" not in results[1]

    def test_simple_read_sequence(self):
        """start → send_byte(0xA1) → recv_byte(True) → recv_byte(False) → stop."""
        buffered = [
            _step("start"),
            _step("send_byte", data=0xA1),
            _step("recv_byte", ack=True),
            _step("recv_byte", ack=False),
            _step("stop"),
        ]
        txn_results = [self._read_txn_result(data=[0xBE, 0xEF])]
        results = _map_protocol_results(buffered, txn_results)

        assert len(results) == 3
        # Address byte
        assert results[0]["op"] == "send_byte"
        assert results[0]["rw"] == "read"
        # First recv
        assert results[1]["op"] == "recv_byte"
        assert results[1]["data"] == hex(0xBE)
        assert results[1]["status"] == "ok"
        # Second recv
        assert results[2]["op"] == "recv_byte"
        assert results[2]["data"] == hex(0xEF)

    def test_repeated_start_sequence(self):
        """Write txn → repeated_start → read txn — two TxnResults."""
        buffered = [
            _step("start"),
            _step("send_byte", data=0xA0),   # addr+W
            _step("send_byte", data=0x10),   # data byte
            _step("repeated_start"),
            _step("send_byte", data=0xA1),   # addr+R
            _step("recv_byte", ack=False),
            _step("stop"),
        ]
        txn_results = [
            self._write_txn_result(),
            self._read_txn_result(data=[0xCC]),
        ]
        results = _map_protocol_results(buffered, txn_results)

        assert len(results) == 4
        # Write segment
        assert results[0]["rw"] == "write"
        assert results[1]["op"] == "send_byte"
        # Read segment
        assert results[2]["rw"] == "read"
        assert results[3]["data"] == hex(0xCC)

    def test_nack_propagates_to_all_steps(self):
        """When TxnResult.ack_ok=False, all steps in that transaction report fail."""
        buffered = [
            _step("start"),
            _step("send_byte", data=0xA0),
            _step("send_byte", data=0x10),
            _step("stop"),
        ]
        txn_results = [self._write_txn_result(ack_ok=False)]
        results = _map_protocol_results(buffered, txn_results)

        assert all(r["status"] == "fail" for r in results)

    def test_no_data_bytes(self):
        """Address-only write (scan-style) — just the addr byte gets a result."""
        buffered = [
            _step("start"),
            _step("send_byte", data=0xA0),
            _step("stop"),
        ]
        txn_results = [self._write_txn_result()]
        results = _map_protocol_results(buffered, txn_results)

        assert len(results) == 1
        assert results[0]["op"] == "send_byte"
        assert results[0]["addr"] == hex(0x50)


# ---------------------------------------------------------------------------
# execute_sequence — buffering via mock driver
# ---------------------------------------------------------------------------


class TestExecuteSequenceBuffering:
    """Use a mock I2CDriver to verify buffering without a live simulation."""

    def _make_mock_driver(self, txn_results=None):
        """Return an async-capable mock driver."""
        if txn_results is None:
            txn_results = [TxnResult(ack_ok=True, data_read=[], bytes_written=1)]

        drv = mock.MagicMock()

        async def fake_execute_transactions(txns):
            return txn_results

        async def fake_reset():
            pass

        async def fake_delay(cycles):
            pass

        drv.execute_transactions = mock.AsyncMock(side_effect=fake_execute_transactions)
        drv.reset = mock.AsyncMock(side_effect=fake_reset)
        drv.delay = mock.AsyncMock(side_effect=fake_delay)
        return drv

    def test_protocol_sequence_buffered_and_executed(self):
        """start..stop block is executed as one call to execute_transactions."""
        from test_runner import execute_sequence

        async def _run():
            steps = [
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},
                {"op": "send_byte", "data": 0x10},
                {"op": "stop"},
            ]
            driver = self._make_mock_driver()
            results = await execute_sequence(driver, steps)
            # execute_transactions should have been called exactly once.
            driver.execute_transactions.assert_called_once()
            # Results: one per send_byte (addr + data), no entries for start/stop.
            assert len(results) == 2
            assert results[0]["op"] == "send_byte"
            assert results[1]["op"] == "send_byte"

        asyncio.run(_run())

    def test_legacy_ops_unchanged(self):
        """reset and delay execute immediately without buffering."""
        from test_runner import execute_sequence

        async def _run():
            steps = [
                {"op": "reset"},
                {"op": "delay", "cycles": 5},
            ]
            driver = self._make_mock_driver()
            results = await execute_sequence(driver, steps)
            driver.reset.assert_called_once()
            driver.delay.assert_called_once_with(5)
            driver.execute_transactions.assert_not_called()
            assert len(results) == 2

        asyncio.run(_run())

    def test_mixed_legacy_and_protocol(self):
        """Legacy ops interleaved with protocol blocks work correctly."""
        from test_runner import execute_sequence

        async def _run():
            steps = [
                {"op": "reset"},
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},
                {"op": "stop"},
                {"op": "delay", "cycles": 10},
            ]
            driver = self._make_mock_driver()
            results = await execute_sequence(driver, steps)
            # reset, one send_byte result, delay
            assert len(results) == 3
            assert results[0]["op"] == "reset"
            assert results[1]["op"] == "send_byte"
            assert results[2]["op"] == "delay"

        asyncio.run(_run())

    def test_interpreter_error_produces_error_entries(self):
        """If ProtocolInterpreter raises, each data step gets an error entry."""
        from test_runner import execute_sequence

        async def _run():
            # Send recv_byte in write mode — interpreter should raise ValueError.
            steps = [
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},  # write mode addr
                {"op": "recv_byte", "ack": True},   # invalid in write mode
                {"op": "stop"},
            ]
            driver = self._make_mock_driver()
            results = await execute_sequence(driver, steps)
            # Both send_byte and recv_byte get error entries.
            assert len(results) == 2
            assert all(r["status"] == "error" for r in results)
            assert all("message" in r for r in results)

        asyncio.run(_run())

    def test_read_sequence_results_contain_data(self):
        """recv_byte results include the byte value from TxnResult.data_read."""
        from test_runner import execute_sequence

        async def _run():
            driver = self._make_mock_driver(
                txn_results=[TxnResult(ack_ok=True, data_read=[0xDE, 0xAD], bytes_written=0)]
            )
            steps = [
                {"op": "start"},
                {"op": "send_byte", "data": 0xA1},  # read mode addr
                {"op": "recv_byte", "ack": True},
                {"op": "recv_byte", "ack": False},
                {"op": "stop"},
            ]
            results = await execute_sequence(driver, steps)
            assert len(results) == 3
            assert results[1]["data"] == hex(0xDE)
            assert results[2]["data"] == hex(0xAD)

        asyncio.run(_run())

    def test_multiple_protocol_blocks(self):
        """Two separate start..stop blocks are each executed independently."""
        from test_runner import execute_sequence

        async def _run():
            driver = self._make_mock_driver()
            steps = [
                # Block 1
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},
                {"op": "stop"},
                # Block 2
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},
                {"op": "send_byte", "data": 0x20},
                {"op": "stop"},
            ]
            results = await execute_sequence(driver, steps)
            assert driver.execute_transactions.call_count == 2
            # Block 1: 1 send_byte; Block 2: 2 send_bytes
            assert len(results) == 3

        asyncio.run(_run())
