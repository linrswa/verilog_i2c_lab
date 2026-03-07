"""Route handlers for simulation-related API endpoints."""

from fastapi import APIRouter
from fastapi.responses import FileResponse

from app.services.waveform import vcd_path_for

router = APIRouter()

# US-005: POST /api/run — append handler here
# US-007: GET /api/templates/{template_id} — append handler here
# US-008: GET /api/waveform/{waveform_id} — append handler here
