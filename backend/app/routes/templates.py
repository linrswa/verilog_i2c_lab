"""Route handlers for template-related API endpoints."""

from typing import Any, List

from fastapi import APIRouter, HTTPException

from app.services.templates import get_template, list_templates

router = APIRouter()


@router.get("/templates", response_model=List[dict[str, Any]])
async def get_templates() -> List[dict[str, Any]]:
    """Return all available test templates."""
    return list_templates()


@router.get("/templates/{template_id}", response_model=dict[str, Any])
async def get_template_detail(template_id: str) -> dict[str, Any]:
    """Return the full content of a single template, including its steps array."""
    template = get_template(template_id)
    if template is None:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found.")
    return template
