"""Simulation service — executes the I2C test runner as a subprocess."""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import tempfile
from typing import Any

# Path to the Phase 1 sim directory (backend/sim/), resolved relative to this file.
# This file lives at backend/app/services/runner.py, so:
#   .parent       → backend/app/services/
#   .parent.parent → backend/app/
#   .parent.parent.parent → backend/
#   / "sim"       → backend/sim/
_BACKEND_DIR = pathlib.Path(__file__).parent.parent.parent.resolve()
_SIM_DIR = _BACKEND_DIR / "sim"
_TEST_RUNNER = _SIM_DIR / "test_runner.py"

# RTL source files watched by US-003 (Build Caching).  Add any new .v files here.
_RTL_SOURCES: list[pathlib.Path] = [
    _SIM_DIR / "rtl" / "i2c_master.v",
    _SIM_DIR / "rtl" / "i2c_slave.v",
    _SIM_DIR / "rtl" / "i2c_top.v",
]

#: Default simulation timeout in seconds.
DEFAULT_TIMEOUT: int = 60


class SimulationService:
    """Manages execution of the cocotb-based I2C simulation.

    Each call to :meth:`run_simulation` writes steps to a temporary input JSON
    file, invokes ``test_runner.py`` as a subprocess, reads the structured
    result from a temporary output JSON file, and cleans up both temp files
    before returning.
    """

    def __init__(self, timeout: int = DEFAULT_TIMEOUT) -> None:
        """Initialise the service.

        Parameters
        ----------
        timeout:
            Maximum number of seconds to wait for the simulation subprocess
            before raising :class:`TimeoutError`.  Defaults to 60 seconds.
        """
        self.timeout = timeout
        # Build-cache state for US-003 (Hybrid Compile).
        # Stores the max mtime seen across all RTL source files at the time of
        # the last successful compile.  None means "never compiled".
        self._last_compile_mtime: float | None = None

    # ------------------------------------------------------------------
    # Build-cache helpers
    # ------------------------------------------------------------------

    def _current_rtl_mtime(self) -> float:
        """Return the maximum mtime across all RTL source files.

        Files that do not exist are skipped.  If no RTL file exists at all,
        returns 0.0 so that the first-run compile is always triggered.
        """
        mtimes: list[float] = []
        for src in _RTL_SOURCES:
            try:
                mtimes.append(src.stat().st_mtime)
            except OSError:
                # File missing — skip; will force a compile on the next
                # attempt when it exists.
                pass
        return max(mtimes) if mtimes else 0.0

    def _needs_compile(self) -> bool:
        """Return True if RTL sources have changed since the last compile.

        Returns ``True`` on the first run (``_last_compile_mtime`` is
        ``None``) or when any RTL source file has been modified since the
        last successful compile.
        """
        if self._last_compile_mtime is None:
            # First run — always compile.
            return True
        current_mtime = self._current_rtl_mtime()
        return current_mtime > self._last_compile_mtime

    async def run_simulation(self, steps: list[dict[str, Any]]) -> dict[str, Any]:
        """Execute the I2C simulation for the given test steps.

        The steps are written to a temporary JSON file and passed to
        ``test_runner.py`` via ``--input``.  The runner writes its structured
        result to a second temporary file (``--output``).  Both temp files are
        deleted after execution regardless of success or failure.

        Parameters
        ----------
        steps:
            List of raw step dicts, e.g.
            ``[{"op": "reset"}, {"op": "write_bytes", "addr": 80, ...}]``.

        Returns
        -------
        dict
            Structured result with keys:

            - ``"passed"``        — ``True`` if all steps passed (bool)
            - ``"steps"``         — list of per-step result dicts
            - ``"register_dump"`` — final register state snapshot
            - ``"vcd_path"``      — path to the VCD waveform file or ``None``

        Raises
        ------
        TimeoutError
            If the simulation subprocess does not complete within
            :attr:`timeout` seconds.
        RuntimeError
            If the subprocess exits with a non-zero status and no result JSON
            could be read back, or if the result JSON is malformed.
        """
        # Create temp files up-front so we can guarantee cleanup in the
        # finally block even if the subprocess launch itself fails.
        input_fd, input_path = tempfile.mkstemp(suffix=".json", prefix="i2c_sim_input_")
        output_fd, output_path = tempfile.mkstemp(suffix=".json", prefix="i2c_sim_output_")
        try:
            # Write the input payload — test_runner.py accepts {"steps": [...]}
            with open(input_fd, "w", encoding="utf-8") as fh:
                json.dump({"steps": steps}, fh)

            # Close the output fd; test_runner.py will write to the path.
            os.close(output_fd)

            result = await self._invoke_runner(input_path, output_path)
            return result
        finally:
            self._remove_if_exists(pathlib.Path(input_path))
            self._remove_if_exists(pathlib.Path(output_path))

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _invoke_runner(
        self, input_path: str, output_path: str
    ) -> dict[str, Any]:
        """Launch test_runner.py as a subprocess and return the parsed result.

        Checks the in-memory build cache before invoking the runner.  When
        the RTL sources have not changed since the last successful compile,
        passes ``--skip-build`` to avoid re-running Icarus compilation.
        After a fresh compile the cache timestamp is updated.

        Parameters
        ----------
        input_path:
            Path to the pre-written input JSON file.
        output_path:
            Path where test_runner.py should write the output JSON file.

        Returns
        -------
        dict
            Parsed result from the output JSON file.

        Raises
        ------
        TimeoutError
            If the process does not complete within :attr:`timeout` seconds.
        RuntimeError
            If the process fails and no valid result JSON is available.
        """
        # Decide whether we need to (re)compile before running.
        compile_needed = self._needs_compile()
        # Snapshot the current max mtime now — before the subprocess runs —
        # so that any file touched while the simulation is running still
        # triggers a recompile on the next call.
        snapshot_mtime = self._current_rtl_mtime()

        cmd = [
            sys.executable,
            str(_TEST_RUNNER),
            "--input", input_path,
            "--output", output_path,
        ]
        if not compile_needed:
            cmd.append("--skip-build")

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(_SIM_DIR),
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=self.timeout
            )
        except asyncio.TimeoutError:
            # Kill the hung process before propagating.
            try:
                process.kill()
                await process.wait()
            except ProcessLookupError:
                pass
            raise TimeoutError(
                f"Simulation timed out after {self.timeout} seconds."
            )

        returncode = process.returncode

        # Attempt to read the result JSON regardless of exit code — the runner
        # may write partial results even on failure.
        result = self._read_result_json(pathlib.Path(output_path))

        if result is not None:
            # Update the compile cache timestamp only when we actually ran a
            # fresh compile.  If we skipped the build we do not touch the
            # stored mtime — the cache remains valid.
            if compile_needed:
                self._last_compile_mtime = snapshot_mtime
            return result

        # No result file — surface stderr for diagnostics.
        stderr_text = stderr_bytes.decode(errors="replace").strip() if stderr_bytes else ""
        raise RuntimeError(
            f"Simulation subprocess exited with code {returncode} "
            f"and produced no result JSON. "
            f"stderr: {stderr_text[:500]}"
        )

    @staticmethod
    def _read_result_json(path: pathlib.Path) -> dict[str, Any] | None:
        """Read and parse a JSON result file, returning ``None`` on any error.

        Parameters
        ----------
        path:
            Filesystem path to the JSON result file.

        Returns
        -------
        dict or None
            Parsed dict if the file exists and is valid JSON, otherwise ``None``.
        """
        if not path.exists() or path.stat().st_size == 0:
            return None
        try:
            with path.open("r", encoding="utf-8") as fh:
                return json.load(fh)  # type: ignore[no-any-return]
        except (json.JSONDecodeError, OSError):
            return None

    @staticmethod
    def _remove_if_exists(path: pathlib.Path) -> None:
        """Delete *path* silently, ignoring missing-file errors."""
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
