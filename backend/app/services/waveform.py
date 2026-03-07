"""VCD waveform file storage and TTL-based cleanup."""

import asyncio
import logging
import os
import tempfile
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

# Configurable TTL via environment variable (default: 30 minutes).
_VCD_TTL_SECONDS = int(os.environ.get("VCD_TTL_MINUTES", "30")) * 60

# Background cleanup interval (5 minutes).
_CLEANUP_INTERVAL_SECONDS = 5 * 60


def _waveform_dir() -> Path:
    """Return the directory where VCD files are stored, creating it if needed."""
    base = Path(tempfile.gettempdir()) / "i2c-sim-waveforms"
    base.mkdir(parents=True, exist_ok=True)
    return base


def vcd_path_for(waveform_id: str) -> Path:
    """Return the filesystem path for a given waveform UUID."""
    return _waveform_dir() / f"{waveform_id}.vcd"


def allocate_vcd_path() -> tuple[str, Path]:
    """Allocate a new UUID-named VCD file path.

    Returns a ``(waveform_id, path)`` tuple.  The file itself is not created
    here — the simulation process writes to the returned path.
    """
    waveform_id = str(uuid.uuid4())
    return waveform_id, vcd_path_for(waveform_id)


def _delete_expired_vcds() -> int:
    """Delete VCD files whose mtime is older than the configured TTL.

    Returns the number of files deleted.
    """
    now = time.time()
    deleted = 0
    waveform_dir = _waveform_dir()
    for vcd_file in waveform_dir.glob("*.vcd"):
        try:
            age = now - vcd_file.stat().st_mtime
            if age > _VCD_TTL_SECONDS:
                vcd_file.unlink()
                logger.debug("Deleted expired VCD file: %s (age %.0fs)", vcd_file.name, age)
                deleted += 1
        except FileNotFoundError:
            # Deleted between glob and stat — harmless.
            pass
        except OSError as exc:
            logger.warning("Could not delete VCD file %s: %s", vcd_file, exc)
    return deleted


async def _cleanup_loop() -> None:
    """Background coroutine that periodically deletes expired VCD files."""
    logger.info(
        "VCD cleanup task started — TTL=%ds, interval=%ds",
        _VCD_TTL_SECONDS,
        _CLEANUP_INTERVAL_SECONDS,
    )
    while True:
        await asyncio.sleep(_CLEANUP_INTERVAL_SECONDS)
        try:
            deleted = _delete_expired_vcds()
            if deleted:
                logger.info("VCD cleanup: deleted %d expired file(s).", deleted)
        except Exception as exc:  # pragma: no cover
            logger.error("VCD cleanup error: %s", exc)


def start_cleanup_task() -> asyncio.Task[None]:
    """Schedule the background VCD cleanup coroutine and return the task.

    Must be called from inside a running asyncio event loop (e.g. from a
    FastAPI lifespan startup handler).
    """
    return asyncio.create_task(_cleanup_loop(), name="vcd-cleanup")
