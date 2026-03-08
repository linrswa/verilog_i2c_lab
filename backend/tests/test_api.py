"""End-to-end integration tests for the I2C Simulation API.

All tests mock asyncio.create_subprocess_exec so the suite runs without
iverilog or cocotb installed.  The mock simulates what test_runner.py does:
it writes a fake result JSON to the --output path passed on the command line.
"""

from __future__ import annotations

import json
import pathlib
import uuid
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import waveform as waveform_module


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAKE_RESULT: dict[str, Any] = {
    "passed": True,
    "steps": [
        {"op": "reset", "passed": True},
        {"op": "write_bytes", "passed": True},
        {"op": "read_bytes", "passed": True},
    ],
    "register_dump": {"0x00": "0xA5"},
    "vcd_path": None,
}


def _make_mock_subprocess(output_path_index: int, result: dict[str, Any]) -> MagicMock:
    """Return a mock that, when awaited, writes *result* to the --output path.

    asyncio.create_subprocess_exec is an async function returning a Process
    object.  We need:
      1. The outer call to return an awaitable that yields the mock process.
      2. process.communicate() to be an awaitable returning (b"", b"").
      3. process.returncode to be 0.

    The trick: we capture the ``--output`` path from the *args* given to
    create_subprocess_exec and write our fake JSON there inside communicate().
    """
    captured: dict[str, str] = {}

    async def _communicate() -> tuple[bytes, bytes]:
        # Write the fake result to the --output path captured at call time.
        out = captured.get("output_path")
        if out:
            pathlib.Path(out).write_text(json.dumps(result), encoding="utf-8")
        return b"", b""

    async def _create_subprocess(*args: Any, **kwargs: Any) -> MagicMock:
        # args is the full command list; find the value after "--output".
        args_list: List[str] = list(args)
        try:
            idx = args_list.index("--output")
            captured["output_path"] = args_list[idx + 1]
        except (ValueError, IndexError):
            pass

        mock_proc = MagicMock()
        mock_proc.communicate = _communicate
        mock_proc.returncode = 0
        mock_proc.kill = MagicMock()
        mock_proc.wait = AsyncMock()
        return mock_proc

    return _create_subprocess  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client() -> AsyncClient:  # type: ignore[misc]
    """Async HTTP client wired directly to the FastAPI app (no real server)."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac  # type: ignore[misc]


# ---------------------------------------------------------------------------
# POST /api/run
# ---------------------------------------------------------------------------

_SIMPLE_STEPS = [
    {"op": "write_bytes", "addr": "0x50", "reg": "0x00", "data": ["0xA5"]},
    {"op": "read_bytes", "addr": "0x50", "reg": "0x00", "n": 1, "expect": ["0xA5"]},
]


@pytest.mark.anyio
async def test_post_run_returns_passed_true(client: AsyncClient) -> None:
    """POST /api/run with a valid write+read sequence returns passed: true."""
    mock_create = _make_mock_subprocess(0, _FAKE_RESULT)

    with patch("asyncio.create_subprocess_exec", new=mock_create):
        resp = await client.post("/api/run", json={"steps": _SIMPLE_STEPS})

    assert resp.status_code == 200
    body = resp.json()
    assert body["passed"] is True
    assert "waveform_id" in body
    assert isinstance(body["steps"], list)
    assert isinstance(body["register_dump"], dict)


@pytest.mark.anyio
async def test_post_run_invalid_steps_returns_422(client: AsyncClient) -> None:
    """POST /api/run with an invalid op name returns HTTP 422."""
    resp = await client.post(
        "/api/run",
        json={"steps": [{"op": "not_a_real_op"}]},
    )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_post_run_empty_steps_returns_422(client: AsyncClient) -> None:
    """POST /api/run with an empty steps list returns HTTP 422."""
    resp = await client.post("/api/run", json={"steps": []})
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/templates
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_get_templates_returns_non_empty_list(client: AsyncClient) -> None:
    """GET /api/templates returns a non-empty list of template summaries."""
    resp = await client.get("/api/templates")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) > 0
    # Each entry should have at minimum an id and name.
    for item in body:
        assert "id" in item
        assert "name" in item


# ---------------------------------------------------------------------------
# GET /api/templates/{id}
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_get_template_by_id_returns_valid_content(client: AsyncClient) -> None:
    """GET /api/templates/{id} returns valid template content including steps."""
    resp = await client.get("/api/templates/basic_write_read")
    assert resp.status_code == 200
    body = resp.json()
    assert "steps" in body
    assert isinstance(body["steps"], list)
    assert len(body["steps"]) > 0


@pytest.mark.anyio
async def test_get_template_by_id_not_found_returns_404(client: AsyncClient) -> None:
    """GET /api/templates/{id} with an unknown id returns 404."""
    resp = await client.get("/api/templates/does_not_exist")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/waveform/{id}
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_get_waveform_valid_id_returns_vcd(client: AsyncClient) -> None:
    """GET /api/waveform/{id} with a valid UUID returns a VCD file."""
    # Create a real VCD file in the waveform storage directory.
    waveform_id = str(uuid.uuid4())
    vcd_path = waveform_module.vcd_path_for(waveform_id)
    vcd_path.write_text("$timescale 1ns $end\n", encoding="utf-8")

    try:
        resp = await client.get(f"/api/waveform/{waveform_id}")
        assert resp.status_code == 200
        assert b"$timescale" in resp.content
    finally:
        vcd_path.unlink(missing_ok=True)


@pytest.mark.anyio
async def test_get_waveform_invalid_id_returns_404(client: AsyncClient) -> None:
    """GET /api/waveform/{id} with an invalid UUID returns 404."""
    resp = await client.get("/api/waveform/not-a-uuid")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_get_waveform_missing_id_returns_404(client: AsyncClient) -> None:
    """GET /api/waveform/{id} with a valid UUID that has no file returns 404."""
    missing_id = str(uuid.uuid4())
    resp = await client.get(f"/api/waveform/{missing_id}")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/health
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_get_health_returns_200(client: AsyncClient) -> None:
    """GET /api/health returns HTTP 200 with status ok."""
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("status") == "ok"


# ---------------------------------------------------------------------------
# POST /api/run — protocol sequence validation (US-005)
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_post_run_invalid_protocol_sequence_returns_422(
    client: AsyncClient,
) -> None:
    """POST /api/run with a malformed protocol sequence returns HTTP 422 with errors."""
    # start immediately followed by stop — no address byte — structurally invalid.
    invalid_protocol_steps = [
        {"op": "start"},
        {"op": "stop"},
    ]
    resp = await client.post("/api/run", json={"steps": invalid_protocol_steps})

    assert resp.status_code == 422
    body = resp.json()
    # The response detail must include a validation_errors key with at least one message.
    detail = body.get("detail", {})
    assert "validation_errors" in detail, f"Unexpected detail shape: {detail}"
    assert isinstance(detail["validation_errors"], list)
    assert len(detail["validation_errors"]) > 0


@pytest.mark.anyio
async def test_post_run_recv_byte_in_write_mode_returns_422(
    client: AsyncClient,
) -> None:
    """recv_byte after a write-mode address byte must produce a 422."""
    steps = [
        {"op": "start"},
        {"op": "send_byte", "data": "0xA0"},  # write mode
        {"op": "recv_byte", "ack": True},     # invalid in write mode
        {"op": "stop"},
    ]
    resp = await client.post("/api/run", json={"steps": steps})
    assert resp.status_code == 422
    detail = resp.json().get("detail", {})
    assert "validation_errors" in detail


@pytest.mark.anyio
async def test_post_run_valid_protocol_sequence_proceeds(
    client: AsyncClient,
) -> None:
    """A structurally valid protocol sequence passes validation and reaches the runner."""
    valid_steps = [
        {"op": "start"},
        {"op": "send_byte", "data": "0xA0"},
        {"op": "send_byte", "data": "0x10"},
        {"op": "stop"},
    ]
    mock_create = _make_mock_subprocess(0, _FAKE_RESULT)

    with patch("asyncio.create_subprocess_exec", new=mock_create):
        resp = await client.post("/api/run", json={"steps": valid_steps})

    # Should not be rejected by the validator; simulation mock returns passed=True.
    assert resp.status_code == 200
    assert resp.json()["passed"] is True
