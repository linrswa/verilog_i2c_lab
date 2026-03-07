"""FastAPI application entry point."""

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.simulation import router as simulation_router
from app.services.waveform import start_cleanup_task


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup: launch the background VCD TTL cleanup task.
    cleanup_task = start_cleanup_task()
    yield
    # Shutdown: cancel the cleanup task cleanly.
    cleanup_task.cancel()
    try:
        await cleanup_task
    except Exception:
        pass


app = FastAPI(
    title="I2C Simulation API",
    description="REST API for running cocotb-based I2C simulations.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(simulation_router, prefix="/api")


@app.get("/api/health")
async def health() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "ok"}
