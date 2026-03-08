"""Route handlers for simulation-related API endpoints."""

import shutil
import uuid as _uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from app.services.runner import QueueTimeoutError, SimulationService
from app.services.vcd_parser import parse_vcd
from app.services.waveform import allocate_vcd_path, vcd_path_for
from sim.protocol_interpreter import validate_protocol_sequence

router = APIRouter()

# Module-level singleton — one SimulationService shared across all requests.
# asyncio.Lock inside SimulationService serialises concurrent calls.
_sim_service = SimulationService()

# Valid step operation names — legacy ops + protocol-level ops (Phase 4).
_VALID_OPS = frozenset({
    # Legacy high-level ops
    "reset", "write_bytes", "read_bytes", "scan", "delay",
    # Protocol-level ops (Phase 4)
    "start", "stop", "repeated_start", "send_byte", "recv_byte",
})

# Protocol-level ops that participate in structural sequence validation.
_PROTOCOL_OPS = frozenset({"start", "stop", "repeated_start", "send_byte", "recv_byte"})


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class StepModel(BaseModel):
    """A single test step submitted by the client."""

    op: str
    # Allow any additional fields (addr, reg, data, n, expect, …)
    model_config = {"extra": "allow"}

    @field_validator("op")
    @classmethod
    def op_must_be_valid(cls, v: str) -> str:
        if v not in _VALID_OPS:
            raise ValueError(
                f"Invalid op '{v}'. Must be one of: {sorted(_VALID_OPS)}"
            )
        return v


class RunRequest(BaseModel):
    """POST /api/run request body."""

    steps: list[StepModel]

    @field_validator("steps")
    @classmethod
    def steps_must_be_non_empty(cls, v: list[StepModel]) -> list[StepModel]:
        if not v:
            raise ValueError("steps must be a non-empty list")
        return v


class RunResponse(BaseModel):
    """POST /api/run success response."""

    passed: bool
    steps: list[dict[str, Any]]
    register_dump: dict[str, Any]
    reg_pointer: int
    waveform_id: str
    sim_time_total_ps: Optional[int]


class SignalData(BaseModel):
    """Metadata and change list for a single VCD signal."""

    width: int
    changes: list[list[Any]]


class WaveformSignalsResponse(BaseModel):
    """GET /api/waveform/{waveform_id}/signals response."""

    timescale: str
    end_time: int
    signals: dict[str, SignalData]


# ---------------------------------------------------------------------------
# POST /api/run
# ---------------------------------------------------------------------------


@router.post("/run", response_model=RunResponse)
async def run_simulation(body: RunRequest) -> RunResponse:
    """Execute a simulation for the submitted test steps.

    Accepts a JSON body with a ``steps`` array in the same format used by the
    Phase 1 CLI.  Returns the full result dict plus a ``waveform_id`` that can
    be used with ``GET /api/waveform/{id}`` to download the VCD file.

    Error responses:
    - ``422`` — request body failed validation
    - ``500`` — simulation subprocess failed or timed out
    - ``503`` — server is busy; request waited too long for the queue
    """
    # Convert validated Pydantic models back to plain dicts for the runner.
    raw_steps = [step.model_dump() for step in body.steps]

    # Validate any protocol-level steps structurally before running.
    # Only pass steps with protocol ops to the validator so legacy-only
    # sequences are not needlessly checked.
    protocol_steps = [s for s in raw_steps if s.get("op") in _PROTOCOL_OPS]
    if protocol_steps:
        # Validate the subsequence of protocol ops in isolation.
        validation_errors = validate_protocol_sequence(protocol_steps)
        if validation_errors:
            raise HTTPException(
                status_code=422,
                detail={"validation_errors": validation_errors},
            )

    # Allocate a UUID-named destination path in waveform storage before
    # running so we have the ID ready to include in the response.
    waveform_id, waveform_path = allocate_vcd_path()

    try:
        result = await _sim_service.run_simulation(raw_steps)
    except QueueTimeoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except TimeoutError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Simulation timed out: {exc}",
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Simulation failed: {exc}",
        )

    # Copy the VCD produced by the simulation to our managed storage.
    # vcd_path in result may be None (e.g. if VCD generation was disabled).
    # The path is relative to the sim directory (subprocess cwd).
    sim_vcd_path: Optional[str] = result.get("vcd_path")
    if sim_vcd_path:
        import pathlib as _pathlib
        _sim_dir = _pathlib.Path(__file__).parent.parent.parent / "sim"
        resolved_vcd = _sim_dir / sim_vcd_path
        try:
            shutil.copy2(str(resolved_vcd), waveform_path)
        except OSError:
            # Non-fatal: waveform download simply will not work for this run.
            pass

    return RunResponse(
        passed=result.get("passed", False),
        steps=result.get("steps", []),
        register_dump=result.get("register_dump", {}),
        reg_pointer=result.get("reg_pointer", 0),
        waveform_id=waveform_id,
        sim_time_total_ps=result.get("sim_time_total_ps"),
    )


# ---------------------------------------------------------------------------
# GET /api/waveform/{waveform_id}
# ---------------------------------------------------------------------------


@router.get("/waveform/{waveform_id}")
async def download_waveform(waveform_id: str) -> FileResponse:
    """Download a VCD waveform file by its UUID.

    Returns the file as application/octet-stream with a Content-Disposition
    header that prompts a browser download.  Returns 404 if the waveform ID
    does not exist or the file has already been cleaned up.
    """
    # Validate UUID format to prevent path traversal.
    try:
        _uuid.UUID(waveform_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Waveform not found")

    vcd_path = vcd_path_for(waveform_id)
    if not vcd_path.exists():
        raise HTTPException(status_code=404, detail="Waveform not found")

    return FileResponse(
        path=str(vcd_path),
        media_type="application/octet-stream",
        filename=f"{waveform_id}.vcd",
        headers={"Content-Disposition": f'attachment; filename="{waveform_id}.vcd"'},
    )


# ---------------------------------------------------------------------------
# GET /api/waveform/{waveform_id}/signals
# ---------------------------------------------------------------------------


@router.get("/waveform/{waveform_id}/signals", response_model=WaveformSignalsResponse)
async def get_waveform_signals(
    waveform_id: str,
    signals: Optional[str] = Query(
        default=None,
        description="Comma-separated signal names to include. Omit to return all signals.",
    ),
) -> WaveformSignalsResponse:
    """Return parsed VCD signal data for the specified waveform.

    The optional ``signals`` query parameter accepts a comma-separated list of
    signal leaf-names (e.g. ``signals=scl,sda``).  When omitted, all signals
    present in the VCD are returned.

    Error responses:
    - ``404`` — waveform_id not found or VCD file has been cleaned up
    - ``400`` — one or more requested signal names do not exist in the VCD
    """
    # Validate UUID format to prevent path traversal.
    try:
        _uuid.UUID(waveform_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Waveform not found")

    vcd_path = vcd_path_for(waveform_id)
    if not vcd_path.exists():
        raise HTTPException(status_code=404, detail="Waveform not found")

    # Parse the requested signal names from the query string.
    signal_names: Optional[list[str]] = None
    if signals is not None:
        signal_names = [s.strip() for s in signals.split(",") if s.strip()]

    try:
        parsed = parse_vcd(vcd_path, signal_names)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Waveform not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return WaveformSignalsResponse(
        timescale=parsed["timescale"],
        end_time=parsed["end_time"],
        signals={
            name: SignalData(width=data["width"], changes=data["changes"])
            for name, data in parsed["signals"].items()
        },
    )
