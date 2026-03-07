"""Route handlers for template-related API endpoints."""

from typing import Any, List

from fastapi import APIRouter

from app.services.templates import list_templates

router = APIRouter()


@router.get("/templates", response_model=List[dict[str, Any]])
async def get_templates() -> List[dict[str, Any]]:
    """Return all available test templates."""
    return list_templates()
