"""Route handlers for simulation-related API endpoints."""

import shutil
import uuid as _uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from app.services.runner import QueueTimeoutError, SimulationService
from app.services.waveform import allocate_vcd_path, vcd_path_for

router = APIRouter()

# Module-level singleton — one SimulationService shared across all requests.
# asyncio.Lock inside SimulationService serialises concurrent calls.
_sim_service = SimulationService()

# Valid step operation names (matches Phase 1 test runner).
_VALID_OPS = frozenset({"reset", "write_bytes", "read_bytes", "scan", "delay"})


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
    waveform_id: str


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
    sim_vcd_path: Optional[str] = result.get("vcd_path")
    if sim_vcd_path:
        try:
            shutil.copy2(sim_vcd_path, waveform_path)
        except OSError:
            # Non-fatal: waveform download simply will not work for this run.
            pass

    return RunResponse(
        passed=result.get("passed", False),
        steps=result.get("steps", []),
        register_dump=result.get("register_dump", {}),
        waveform_id=waveform_id,
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
