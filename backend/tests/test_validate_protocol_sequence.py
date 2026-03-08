"""test_validate_protocol_sequence.py — Unit tests for validate_protocol_sequence.

Each test class targets one validation rule so failures are easy to isolate.

Run with::
    pytest backend/tests/test_validate_protocol_sequence.py
"""

from __future__ import annotations

import pytest

from sim.protocol_interpreter import validate_protocol_sequence


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _valid(steps: list[dict]) -> None:
    """Assert that the given steps produce no validation errors."""
    errors = validate_protocol_sequence(steps)
    assert errors == [], f"Expected no errors but got: {errors}"


def _invalid(steps: list[dict], *, substr: str) -> list[str]:
    """Assert that validation fails and at least one error contains *substr*."""
    errors = validate_protocol_sequence(steps)
    assert errors, f"Expected validation errors but got none for steps: {steps}"
    joined = " | ".join(errors)
    assert substr.lower() in joined.lower(), (
        f"Expected substring {substr!r} in errors: {errors}"
    )
    return errors


# ---------------------------------------------------------------------------
# Valid sequences (should produce empty error list)
# ---------------------------------------------------------------------------


class TestValidSequences:
    def test_empty_sequence_is_valid(self):
        """Empty sequence is valid — no protocol steps at all."""
        _valid([])

    def test_simple_write(self):
        """start → send_byte(addr+W) → send_byte(data) → stop"""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},  # addr 0x50, write
            {"op": "send_byte", "data": 0x10},
            {"op": "stop"},
        ])

    def test_simple_read(self):
        """start → send_byte(addr+R) → recv_byte → stop"""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA1},  # addr 0x50, read
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ])

    def test_address_only_write(self):
        """Write with only the address byte (bus scan pattern) is valid."""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "stop"},
        ])

    def test_write_then_read_via_repeated_start(self):
        """Classic EEPROM write-register-pointer → repeated_start → read."""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "send_byte", "data": 0x10},
            {"op": "repeated_start"},
            {"op": "send_byte", "data": 0xA1},
            {"op": "recv_byte", "ack": True},
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ])

    def test_multiple_complete_sequences(self):
        """Two independent start…stop groups in the same list."""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "stop"},
            {"op": "start"},
            {"op": "send_byte", "data": 0xA1},
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ])

    def test_boundary_address_bytes(self):
        """0x00 (minimum) and 0xFE (maximum write-mode) are valid address bytes."""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0x00},  # addr 0, write
            {"op": "stop"},
        ])
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xFE},  # addr 0x7F, write
            {"op": "stop"},
        ])
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xFF},  # addr 0x7F, read
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ])


# ---------------------------------------------------------------------------
# Rule 1: send_byte / recv_byte outside a group
# ---------------------------------------------------------------------------


class TestDataOpsOutsideGroup:
    def test_send_byte_before_start(self):
        _invalid(
            [{"op": "send_byte", "data": 0xA0}],
            substr="outside of a transaction group",
        )

    def test_recv_byte_before_start(self):
        _invalid(
            [{"op": "recv_byte", "ack": True}],
            substr="outside of a transaction group",
        )

    def test_send_byte_after_stop(self):
        """send_byte between two groups but after the first stop and before the second start."""
        errors = validate_protocol_sequence([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "stop"},
            {"op": "send_byte", "data": 0x10},  # orphan — not in any group
        ])
        assert any("outside of a transaction group" in e for e in errors)

    def test_recv_byte_after_stop(self):
        errors = validate_protocol_sequence([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA1},
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
            {"op": "recv_byte", "ack": True},  # orphan
        ])
        assert any("outside of a transaction group" in e for e in errors)


# ---------------------------------------------------------------------------
# Rule 2: start must be closed before another start
# ---------------------------------------------------------------------------


class TestNestedStart:
    def test_start_inside_open_group(self):
        _invalid(
            [
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},
                {"op": "start"},  # second start without closing first
            ],
            substr="already-open transaction group",
        )

    def test_double_start_at_beginning(self):
        errors = validate_protocol_sequence([
            {"op": "start"},
            {"op": "start"},
        ])
        assert errors  # at least one error reported


# ---------------------------------------------------------------------------
# Rule 3: address byte required before stop / repeated_start
# ---------------------------------------------------------------------------


class TestAddressByteRequired:
    def test_stop_immediately_after_start(self):
        """start → stop without any send_byte is invalid."""
        _invalid(
            [{"op": "start"}, {"op": "stop"}],
            substr="address byte",
        )

    def test_repeated_start_immediately_after_start(self):
        """start → repeated_start without any send_byte is invalid."""
        _invalid(
            [
                {"op": "start"},
                {"op": "repeated_start"},
            ],
            substr="address byte",
        )

    def test_recv_byte_before_address_byte(self):
        """recv_byte immediately after start (no address byte yet) is invalid."""
        _invalid(
            [
                {"op": "start"},
                {"op": "recv_byte", "ack": True},
            ],
            substr="address byte",
        )


# ---------------------------------------------------------------------------
# Rule 4: recv_byte only in read mode (address byte LSB = 1)
# ---------------------------------------------------------------------------


class TestRecvByteReadModeOnly:
    def test_recv_byte_after_write_address(self):
        """recv_byte after LSB=0 address byte must be flagged."""
        _invalid(
            [
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},  # write mode
                {"op": "recv_byte", "ack": True},
            ],
            substr="write mode",
        )

    def test_recv_byte_after_read_address_is_valid(self):
        """recv_byte after LSB=1 address byte is fine."""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA1},  # read mode
            {"op": "recv_byte", "ack": False},
            {"op": "stop"},
        ])

    def test_multiple_recv_bytes_in_write_mode_each_reported(self):
        """Each recv_byte in write mode produces its own error."""
        errors = validate_protocol_sequence([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},  # write mode
            {"op": "recv_byte", "ack": True},
            {"op": "recv_byte", "ack": False},
        ])
        write_mode_errors = [e for e in errors if "write mode" in e]
        assert len(write_mode_errors) == 2


# ---------------------------------------------------------------------------
# Rule 5: send_byte (data, after address) only in write mode (LSB = 0)
# ---------------------------------------------------------------------------


class TestSendByteWriteModeOnly:
    def test_send_byte_data_after_read_address(self):
        """Data send_byte after LSB=1 address byte must be flagged."""
        _invalid(
            [
                {"op": "start"},
                {"op": "send_byte", "data": 0xA1},  # read mode
                {"op": "send_byte", "data": 0x10},  # invalid in read mode
            ],
            substr="read mode",
        )

    def test_send_byte_data_after_write_address_is_valid(self):
        """Data send_byte after LSB=0 address byte is fine."""
        _valid([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},  # write mode
            {"op": "send_byte", "data": 0x10},
            {"op": "stop"},
        ])


# ---------------------------------------------------------------------------
# Rule 6: unclosed group at end of sequence
# ---------------------------------------------------------------------------


class TestUnclosedGroup:
    def test_missing_stop_at_end(self):
        _invalid(
            [
                {"op": "start"},
                {"op": "send_byte", "data": 0xA0},
                {"op": "send_byte", "data": 0x10},
                # no stop
            ],
            substr="without a 'stop'",
        )

    def test_incomplete_after_repeated_start(self):
        """A repeated_start opens a new group; if unclosed it must be reported."""
        errors = validate_protocol_sequence([
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "repeated_start"},
            {"op": "send_byte", "data": 0xA1},
            {"op": "recv_byte", "ack": False},
            # missing stop
        ])
        assert any("without a 'stop'" in e for e in errors)


# ---------------------------------------------------------------------------
# send_byte missing data field
# ---------------------------------------------------------------------------


class TestSendByteMissingData:
    def test_missing_data_field(self):
        _invalid(
            [
                {"op": "start"},
                {"op": "send_byte"},  # no 'data' key
            ],
            substr="missing required 'data' field",
        )


# ---------------------------------------------------------------------------
# stop / repeated_start outside group
# ---------------------------------------------------------------------------


class TestControlOpsOutsideGroup:
    def test_stop_without_start(self):
        _invalid([{"op": "stop"}], substr="outside of a transaction group")

    def test_repeated_start_without_start(self):
        _invalid([{"op": "repeated_start"}], substr="outside of a transaction group")


# ---------------------------------------------------------------------------
# Backend 422 integration: validate_protocol_sequence returns empty for
# non-protocol sequences (regression guard).
# ---------------------------------------------------------------------------


class TestNonProtocolStepsIgnored:
    def test_legacy_ops_not_in_scope(self):
        """Legacy ops are not passed to this validator; empty input = valid."""
        _valid([])  # caller filters to protocol ops only before calling

    def test_mixed_sequence_protocol_part_only(self):
        """Simulate what the route handler does: filter to protocol ops first."""
        all_steps = [
            {"op": "reset"},
            {"op": "start"},
            {"op": "send_byte", "data": 0xA0},
            {"op": "stop"},
            {"op": "delay", "ms": 10},
        ]
        protocol_only = [s for s in all_steps if s["op"] in {"start", "stop", "repeated_start", "send_byte", "recv_byte"}]
        _valid(protocol_only)
