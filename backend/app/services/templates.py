"""Template service — loads and caches I2C test templates from disk."""

import json
from pathlib import Path
from typing import Any, List, Optional

# Resolved once at import time; works regardless of the working directory.
_TEMPLATES_DIR = Path(__file__).parent.parent.parent / "sim" / "templates"

# In-memory cache: populated on first call to list_templates(), held for the
# lifetime of the process (reloaded on restart as required by the story).
_cache: Optional[List[dict[str, Any]]] = None


def _load_templates() -> List[dict[str, Any]]:
    """Read every *.json file in the templates directory and build the list."""
    templates: List[dict[str, Any]] = []

    for path in sorted(_TEMPLATES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # Skip files that cannot be parsed; log nothing — not critical.
            continue

        template_id = path.stem
        name: str = data.get("name", template_id)
        description: str = data.get("description", "")
        steps: List[Any] = data.get("steps", [])

        templates.append(
            {
                "id": template_id,
                "name": name,
                "description": description,
                "step_count": len(steps),
            }
        )

    return templates


def list_templates() -> List[dict[str, Any]]:
    """Return the cached template list, loading from disk on first call."""
    global _cache
    if _cache is None:
        _cache = _load_templates()
    return _cache
