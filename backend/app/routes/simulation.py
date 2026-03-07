"""Route handlers for simulation-related API endpoints."""

import uuid as _uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.services.waveform import vcd_path_for

router = APIRouter()

# US-005: POST /api/run — append handler here
# US-007: GET /api/templates/{template_id} — append handler here


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
