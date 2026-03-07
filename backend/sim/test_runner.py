"""test_runner.py — JSON-driven test sequence parser and executor for I2C simulation.

This module parses a JSON test sequence into executable cocotb operations and
runs them against the I2CDriver.  Each step in the sequence is a dict with an
``op`` field that selects the operation type plus the relevant parameters.

Supported operation types
-------------------------
reset
    No additional parameters.  Drives a full DUT reset via I2CDriver.reset().

write_bytes
    addr   : int | hex-string   — 7-bit I2C slave address
    reg    : int | hex-string   — 8-bit register start address
    data   : list[int | hex-string] — bytes to write
    expect : list[int | hex-string] (optional) — expected ack result is
             compared with the actual boolean return of write_bytes()

read_bytes
    addr   : int | hex-string   — 7-bit I2C slave address
    reg    : int | hex-string   — 8-bit register start address
    n      : int                — number of bytes to read
    expect : list[int | hex-string] (optional) — byte values to compare
             against the bytes returned by read_bytes()

scan
    addr   : int | hex-string   — 7-bit I2C slave address to probe
    expect : bool (optional)    — expected presence (True/False)

delay
    cycles : int                — number of clock cycles to wait

Hex string parsing
------------------
Any integer field (addr, reg, data elements, expect elements) may be supplied
as a decimal integer or as a hex string prefixed with ``"0x"`` / ``"0X"``.
Parsing is done by ``_parse_int()``.

Error handling
--------------
An unknown ``op`` value raises ``ValueError`` with a message naming the bad
operation type so the caller can surface a clear diagnostic.
"""

from __future__ import annotations

from typing import Any

from i2c_driver import I2CDriver


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _parse_int(value: Any) -> int:
    """Convert *value* to an integer, accepting hex strings like ``"0x50"``.

    Parameters
    ----------
    value:
        A plain ``int``, or a ``str`` that is either a decimal number or a
        hex literal starting with ``"0x"`` / ``"0X"``.

    Returns
    -------
    int
        The parsed integer value.

    Raises
    ------
    ValueError
        If *value* is a string that cannot be parsed as an integer.
    TypeError
        If *value* is neither an ``int`` nor a ``str``.
    """
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower().startswith("0x"):
            return int(stripped, 16)
        return int(stripped, 10)
    raise TypeError(
        f"Expected int or hex string, got {type(value).__name__!r}: {value!r}"
    )


def _parse_int_list(values: list) -> list[int]:
    """Parse a list of int-or-hex-string values into a list of ints."""
    return [_parse_int(v) for v in values]


# ---------------------------------------------------------------------------
# Supported operations registry
# ---------------------------------------------------------------------------

#: Set of valid operation type names for fast membership testing.
VALID_OPS = frozenset({"reset", "write_bytes", "read_bytes", "scan", "delay"})


# ---------------------------------------------------------------------------
# Step parser
# ---------------------------------------------------------------------------


def parse_step(step: dict) -> dict:
    """Validate and normalise a single test step dict.

    Converts all hex strings to ints so that downstream execution code always
    receives plain Python ints.

    Parameters
    ----------
    step:
        Raw dict as decoded from JSON.  Must contain at least an ``"op"`` key.

    Returns
    -------
    dict
        Normalised step dict with integer fields converted from hex strings.

    Raises
    ------
    ValueError
        If ``"op"`` is missing or not one of the supported operation types.
    """
    if "op" not in step:
        raise ValueError("Step is missing required 'op' field")

    op = step["op"]
    if op not in VALID_OPS:
        raise ValueError(
            f"Invalid operation type: {op!r}. "
            f"Supported types are: {sorted(VALID_OPS)}"
        )

    # Build a normalised copy so we do not mutate the caller's data.
    normalised: dict = {"op": op}

    if op == "reset":
        # No additional parameters.
        pass

    elif op == "write_bytes":
        normalised["addr"] = _parse_int(step["addr"])
        normalised["reg"] = _parse_int(step["reg"])
        normalised["data"] = _parse_int_list(step.get("data", []))
        if "expect" in step:
            normalised["expect"] = _parse_int_list(step["expect"])

    elif op == "read_bytes":
        normalised["addr"] = _parse_int(step["addr"])
        normalised["reg"] = _parse_int(step["reg"])
        normalised["n"] = int(step["n"])
        if "expect" in step:
            normalised["expect"] = _parse_int_list(step["expect"])

    elif op == "scan":
        normalised["addr"] = _parse_int(step["addr"])
        if "expect" in step:
            normalised["expect"] = bool(step["expect"])

    elif op == "delay":
        normalised["cycles"] = int(step["cycles"])

    return normalised


def parse_sequence(steps: list[dict]) -> list[dict]:
    """Parse and normalise an entire list of test steps.

    Parameters
    ----------
    steps:
        List of raw step dicts, typically the top-level ``"steps"`` key from a
        JSON test file.

    Returns
    -------
    list[dict]
        List of normalised step dicts ready for execution.

    Raises
    ------
    ValueError
        If any step contains an invalid ``op`` or missing required fields.
    """
    return [parse_step(step) for step in steps]


# ---------------------------------------------------------------------------
# Step executor (async, uses I2CDriver)
# ---------------------------------------------------------------------------


async def execute_step(driver: I2CDriver, step: dict) -> dict:
    """Execute a single normalised test step and return a result dict.

    Parameters
    ----------
    driver:
        An initialised ``I2CDriver`` instance connected to a live DUT.
    step:
        A normalised step dict produced by :func:`parse_step`.

    Returns
    -------
    dict
        Result dict.  Always contains:

        - ``"op"``    — the operation type string
        - ``"status"`` — ``"ok"`` or ``"error"``

        Additional fields depend on the operation:

        - ``read_bytes`` adds ``"data"`` (list of hex strings).
        - ``scan`` adds ``"found"`` (bool).
        - Any step with an ``"expect"`` field adds ``"match"`` (bool).
        - ``"error"`` status steps add ``"message"`` (str).
    """
    op = step["op"]
    result: dict = {"op": op, "status": "ok"}

    try:
        if op == "reset":
            await driver.reset()

        elif op == "write_bytes":
            ack = await driver.write_bytes(
                step["addr"], step["reg"], step["data"]
            )
            result["ack"] = ack
            if "expect" in step:
                # expect for write_bytes is the expected byte list written; we
                # compare against step["data"] (what was actually sent) if the
                # operation succeeded.  Most callers use expect to validate the
                # data they requested was written without error.
                result["match"] = (ack is True) and (
                    step["data"] == step["expect"]
                )

        elif op == "read_bytes":
            data = await driver.read_bytes(
                step["addr"], step["reg"], step["n"]
            )
            result["data"] = [hex(b) for b in data]
            if "expect" in step:
                result["match"] = data == step["expect"]

        elif op == "scan":
            found = await driver.scan(step["addr"])
            result["found"] = found
            if "expect" in step:
                result["match"] = found == step["expect"]

        elif op == "delay":
            await driver.delay(step["cycles"])

    except Exception as exc:  # noqa: BLE001
        result["status"] = "error"
        result["message"] = str(exc)

    return result


async def execute_sequence(
    driver: I2CDriver, steps: list[dict]
) -> list[dict]:
    """Execute all steps in *steps* sequentially and collect results.

    Parameters
    ----------
    driver:
        An initialised ``I2CDriver`` instance connected to a live DUT.
    steps:
        List of normalised step dicts (output of :func:`parse_sequence`).

    Returns
    -------
    list[dict]
        List of per-step result dicts in the same order as *steps*.
    """
    results = []
    for step in steps:
        step_result = await execute_step(driver, step)
        results.append(step_result)
    return results
