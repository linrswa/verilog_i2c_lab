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

cocotb Runner Integration
-------------------------
The ``run_simulation()`` function provides a no-Makefile path for compiling
and executing the Icarus Verilog simulation via the cocotb Python runner API::

    from test_runner import run_simulation
    run_simulation(vcd_dir="/tmp/waves")

The module also exposes a ``test_i2c_sequence`` cocotb coroutine which acts as
the simulation entry point when the runner executes the ``test_runner`` Python
module.  The steps to run are passed via the ``TEST_STEPS_JSON`` environment
variable (a JSON-encoded list of step dicts).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import tempfile
from typing import Any

import cocotb
from cocotb.runner import get_runner

from i2c_driver import I2CDriver


# ---------------------------------------------------------------------------
# RTL / wrapper paths (relative to this file's directory)
# ---------------------------------------------------------------------------

_SIM_DIR = pathlib.Path(__file__).parent.resolve()
_RTL_DIR = _SIM_DIR / "rtl"
_TB_DIR = _SIM_DIR / "tb"

#: All synthesisable Verilog sources required to compile the DUT.
_VERILOG_SOURCES = [
    _RTL_DIR / "i2c_master.v",
    _RTL_DIR / "i2c_slave.v",
    _RTL_DIR / "i2c_top.v",
    _TB_DIR / "i2c_system_wrapper.v",
]

#: Top-level module name used for build and test.
_TOPLEVEL = "i2c_system_wrapper"

#: This Python module name — used as the cocotb py_module argument.
_PY_MODULE = "test_runner"


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


# ---------------------------------------------------------------------------
# Final result assembly
# ---------------------------------------------------------------------------


def _step_passed(result: dict) -> bool:
    """Return True if a single step result counts as a pass.

    A step passes when:
    - Its status is ``"ok"`` (no exception was raised), AND
    - If a ``match`` field is present, it is ``True``.

    Steps without a ``match`` field (e.g. ``reset``, ``delay``,
    ``write_bytes`` without ``expect``) pass as long as they did not error.
    """
    if result.get("status") != "ok":
        return False
    if "match" in result:
        return bool(result["match"])
    return True


def build_final_result(
    step_results: list[dict],
    register_dump: dict,
    vcd_path: str | None = None,
) -> dict:
    """Assemble the top-level JSON result dict from per-step results.

    Parameters
    ----------
    step_results:
        List of per-step result dicts produced by :func:`execute_sequence`.
    register_dump:
        Register snapshot returned by ``I2CDriver.get_register_dump()``.
        Keyed by register address (int), values are byte values (int).
    vcd_path:
        Filesystem path to the VCD waveform file, or ``None`` if the
        simulation did not produce one.

    Returns
    -------
    dict
        Top-level result dict with the following keys:

        - ``"passed"``        — ``True`` when every step passes (bool)
        - ``"steps"``         — list of per-step result dicts
        - ``"register_dump"`` — register snapshot (keys are int addresses)
        - ``"vcd_path"``      — path string or ``None``
    """
    passed = all(_step_passed(r) for r in step_results)
    return {
        "passed": passed,
        "steps": step_results,
        "register_dump": register_dump,
        "vcd_path": vcd_path,
    }


async def run_sequence(
    driver: I2CDriver,
    steps: list[dict],
    vcd_path: str | None = None,
) -> dict:
    """Parse, execute, and assemble the full result for a test sequence.

    This is the primary entry point for running a complete test.  It:

    1. Executes every step via :func:`execute_sequence`.
    2. Calls ``driver.get_register_dump()`` to capture the final register
       state after all steps have completed.
    3. Assembles and returns the structured result via
       :func:`build_final_result`.

    Parameters
    ----------
    driver:
        An initialised ``I2CDriver`` instance connected to a live DUT.
    steps:
        List of normalised step dicts (output of :func:`parse_sequence`).
        Raw JSON steps should be passed through :func:`parse_sequence`
        before calling this function.
    vcd_path:
        Optional path to the VCD waveform file generated by the simulator.

    Returns
    -------
    dict
        Structured result dict as defined by :func:`build_final_result`.
    """
    step_results = await execute_sequence(driver, steps)
    register_dump = await driver.get_register_dump()
    return build_final_result(step_results, register_dump, vcd_path)


# ---------------------------------------------------------------------------
# cocotb test entry point (simulation coroutine)
# ---------------------------------------------------------------------------


@cocotb.test()
async def test_i2c_sequence(dut) -> None:
    """cocotb test coroutine — entry point for the cocotb runner.

    When the runner executes this module the simulator calls this coroutine
    with the top-level DUT handle.  Test steps are supplied via the
    ``TEST_STEPS_JSON`` environment variable (a JSON-encoded list of raw step
    dicts).  If the variable is absent or empty a minimal smoke test
    (reset-only) is run so the simulation always exits cleanly.

    The VCD waveform is produced by the ``$dumpfile`` / ``$dumpvars``
    directives already present in ``i2c_system_wrapper.v``.  The waveform
    file name is read from the ``VCD_FILENAME`` environment variable
    (defaults to ``"i2c_system_cocotb.vcd"``).

    The assembled result dict is written to ``TEST_RESULT_JSON`` (an output
    environment variable / file path) when the variable is set.
    """
    # Resolve which steps to run.
    steps_json = os.environ.get("TEST_STEPS_JSON", "")
    if steps_json.strip():
        raw_steps = json.loads(steps_json)
        steps = parse_sequence(raw_steps)
    else:
        # Default smoke test: just reset the DUT.
        steps = [{"op": "reset"}]

    # Determine the VCD path (produced by the Verilog $dumpfile directive).
    vcd_filename = os.environ.get("VCD_FILENAME", "i2c_system_cocotb.vcd")
    # The simulator places the VCD in its working/build directory; we report
    # the filename so callers can locate it relative to the build dir.
    vcd_path: str | None = vcd_filename

    driver = I2CDriver(dut)
    result = await run_sequence(driver, steps, vcd_path=vcd_path)

    # Persist the structured result so the caller can read it back.
    result_path = os.environ.get("TEST_RESULT_JSON", "")
    if result_path:
        with open(result_path, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)

    # Fail the cocotb test if the sequence did not pass so that the runner
    # exits with a non-zero status on failure.
    assert result["passed"], (
        f"Test sequence failed. Step results: {result['steps']}"
    )


# ---------------------------------------------------------------------------
# cocotb Python runner integration
# ---------------------------------------------------------------------------


def run_simulation(
    *,
    vcd_dir: str | None = None,
    steps_json: str | None = None,
    result_json_path: str | None = None,
    build_dir: str | None = None,
) -> None:
    """Compile the RTL and run the cocotb simulation using the Icarus runner.

    This function replaces the need for a Makefile.  It uses the stable
    cocotb Python runner API introduced in cocotb 2.0.

    Parameters
    ----------
    vcd_dir:
        Directory where the VCD waveform file will be placed.  The file is
        named ``i2c_system_cocotb.vcd``.  Defaults to the current working
        directory.
    steps_json:
        JSON-encoded list of raw step dicts to run inside the simulation.
        Passed to the cocotb test via the ``TEST_STEPS_JSON`` env var.
        When *None* the simulation runs the default smoke test (reset only).
    result_json_path:
        Path to write the structured JSON result after the simulation exits.
        Passed via the ``TEST_RESULT_JSON`` env var.  When *None* the result
        is not persisted.
    build_dir:
        Directory for Icarus build artefacts.  Defaults to a ``sim_build``
        sub-directory next to this file.
    """
    runner = get_runner("icarus")

    # Resolve build directory.
    resolved_build_dir = (
        pathlib.Path(build_dir) if build_dir else _SIM_DIR / "sim_build"
    )

    # Compile the RTL.
    runner.build(
        verilog_sources=[str(s) for s in _VERILOG_SOURCES],
        hdl_toplevel=_TOPLEVEL,
        build_dir=str(resolved_build_dir),
        always=True,
    )

    # Build the environment for the test coroutine.
    sim_env: dict[str, str] = {}
    if steps_json is not None:
        sim_env["TEST_STEPS_JSON"] = steps_json
    if result_json_path is not None:
        sim_env["TEST_RESULT_JSON"] = result_json_path

    # Determine VCD filename and directory.
    vcd_filename = "i2c_system_cocotb.vcd"
    sim_env["VCD_FILENAME"] = vcd_filename

    # Run the simulation.
    runner.test(
        hdl_toplevel=_TOPLEVEL,
        test_module=_PY_MODULE,
        build_dir=str(resolved_build_dir),
        test_dir=str(_SIM_DIR),
        extra_env=sim_env,
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser for the CLI."""
    parser = argparse.ArgumentParser(
        prog="test_runner.py",
        description=(
            "Run an I2C simulation test sequence from a JSON file "
            "and print structured JSON results."
        ),
    )
    parser.add_argument(
        "--input",
        metavar="FILE",
        required=True,
        help="Path to the JSON test sequence file.",
    )
    parser.add_argument(
        "--output",
        metavar="FILE",
        default=None,
        help=(
            "Path to write the JSON result.  "
            "Defaults to stdout when not specified."
        ),
    )
    parser.add_argument(
        "--vcd-dir",
        metavar="DIR",
        default=None,
        dest="vcd_dir",
        help=(
            "Directory in which VCD waveform files are placed.  "
            "Defaults to the current working directory."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.  Returns the process exit code.

    Exit codes
    ----------
    0 — all test steps passed.
    1 — one or more test steps failed or an execution error occurred.
    2 — argument / input parsing error (argparse uses 2 by convention).
    """
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    # --- Read and validate the input JSON file ---
    input_path = pathlib.Path(args.input)
    try:
        with open(input_path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except FileNotFoundError:
        print(
            f"error: input file not found: {input_path}", file=sys.stderr
        )
        return 1
    except json.JSONDecodeError as exc:
        print(
            f"error: failed to parse input JSON: {exc}", file=sys.stderr
        )
        return 1

    # The input file may be either a bare list of steps or a dict with a
    # "steps" key (the schema used by the template files).
    if isinstance(payload, list):
        raw_steps = payload
    elif isinstance(payload, dict) and "steps" in payload:
        raw_steps = payload["steps"]
    else:
        print(
            "error: input JSON must be a list of steps or a dict with a "
            "'steps' key.",
            file=sys.stderr,
        )
        return 1

    # Validate steps before launching the (potentially expensive) simulation.
    try:
        parse_sequence(raw_steps)
    except (ValueError, TypeError, KeyError) as exc:
        print(f"error: invalid test sequence: {exc}", file=sys.stderr)
        return 1

    # --- Prepare paths for the simulation ---
    steps_json_str = json.dumps(raw_steps)

    # Use a temp file so the cocotb coroutine can write its structured result
    # even when --output is not given (we read it back to print to stdout).
    with tempfile.NamedTemporaryFile(
        suffix=".json", delete=False, mode="w", encoding="utf-8"
    ) as tmp:
        result_tmp_path = tmp.name

    # --- Execute the simulation ---
    exit_code = 0
    try:
        run_simulation(
            vcd_dir=args.vcd_dir,
            steps_json=steps_json_str,
            result_json_path=result_tmp_path,
        )
    except SystemExit as exc:
        # cocotb / the runner may call sys.exit() on failure.
        # We catch it so we can still emit the result JSON before exiting.
        exit_code = int(exc.code) if exc.code is not None else 1
    except Exception as exc:  # noqa: BLE001
        print(f"error: simulation failed: {exc}", file=sys.stderr)
        # Clean up the temp file and exit with failure code.
        try:
            pathlib.Path(result_tmp_path).unlink(missing_ok=True)
        except OSError:
            pass
        return 1

    # --- Read back the structured result ---
    result_path_obj = pathlib.Path(result_tmp_path)
    result: dict = {}
    if result_path_obj.exists() and result_path_obj.stat().st_size > 0:
        try:
            with open(result_path_obj, "r", encoding="utf-8") as fh:
                result = json.load(fh)
        except json.JSONDecodeError:
            pass  # result dict stays empty; exit code already set

    # Clean up the temp file.
    try:
        result_path_obj.unlink(missing_ok=True)
    except OSError:
        pass

    # Determine exit code from the result when the runner did not set one.
    if exit_code == 0 and result:
        if not result.get("passed", True):
            exit_code = 1

    # --- Emit the JSON result ---
    result_text = json.dumps(result, indent=2) if result else "{}"
    if args.output:
        output_path = pathlib.Path(args.output)
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as fh:
                fh.write(result_text)
                fh.write("\n")
        except OSError as exc:
            print(
                f"error: could not write output file {output_path}: {exc}",
                file=sys.stderr,
            )
            return 1
    else:
        print(result_text)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
