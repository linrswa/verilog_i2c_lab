"""VCD file parser service.

Parses VCD waveform files produced by cocotb/Icarus simulations and extracts
per-signal change data suitable for frontend waveform rendering.

Uses the ``vcdvcd`` package for VCD parsing.  VCD files contain hierarchical
signal references such as ``i2c_system_wrapper.dut.scl``; this module exposes
the leaf name (``scl``) as the canonical signal name while preserving the full
path in metadata.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any

import vcdvcd

# Conversion factor from each VCD time unit to picoseconds.
_UNIT_TO_PS: dict[str, Decimal] = {
    "fs": Decimal("1E-3"),   # 1 femtosecond = 0.001 ps
    "ps": Decimal("1"),      # 1 picosecond  = 1 ps
    "ns": Decimal("1E3"),    # 1 nanosecond  = 1,000 ps
    "us": Decimal("1E6"),    # 1 microsecond = 1,000,000 ps
    "ms": Decimal("1E9"),    # 1 millisecond = 1,000,000,000 ps
    "s":  Decimal("1E12"),   # 1 second      = 1e12 ps
}


def _leaf_name(full_reference: str) -> str:
    """Extract the leaf signal name from a hierarchical VCD reference.

    For example, ``i2c_system_wrapper.dut.scl`` → ``scl``.
    If the reference has no dots, the full reference is returned as-is.
    """
    return full_reference.rsplit(".", 1)[-1]


def _ps_per_tick(timescale: dict[str, Any]) -> Decimal:
    """Compute how many picoseconds each VCD timestamp unit represents.

    The ``timescale`` dict produced by vcdvcd contains:
    - ``"magnitude"`` — numeric scale factor (e.g. ``Decimal('1')``)
    - ``"unit"``      — time unit string (e.g. ``"ns"``)

    Returns a :class:`decimal.Decimal` to avoid floating-point precision loss.
    """
    magnitude: Decimal = timescale["magnitude"]
    unit: str = timescale["unit"]
    unit_factor = _UNIT_TO_PS.get(unit, Decimal("1"))
    return magnitude * unit_factor


def _timescale_label(timescale: dict[str, Any]) -> str:
    """Return a human-readable timescale string, e.g. ``'1ns'``."""
    return f"{timescale['magnitude']}{timescale['unit']}"


def parse_vcd(
    vcd_path: Path | str,
    signals: list[str] | None = None,
) -> dict[str, Any]:
    """Parse a VCD file and return signal change data.

    Parameters
    ----------
    vcd_path:
        Filesystem path to the VCD file.
    signals:
        Optional list of signal names to include in the output.  Names are
        matched against the **leaf** component of the full hierarchical
        reference (e.g. ``"scl"`` matches ``"i2c_system_wrapper.dut.scl"``).
        When ``None`` or empty, all signals are returned.

    Returns
    -------
    dict with keys:

    ``timescale``
        Human-readable timescale string (e.g. ``"1ns"``).
    ``end_time``
        Simulation end time in **picoseconds** (int).
    ``signals``
        Dict mapping signal leaf-name → signal metadata dict with keys:

        - ``width``   — signal bit width (int)
        - ``changes`` — list of ``[time_ps, value]`` pairs sorted by time,
                        where *time_ps* is an int and *value* is a string
                        (e.g. ``"0"``, ``"1"``, ``"x"``, ``"z"``).

    Raises
    ------
    FileNotFoundError
        If *vcd_path* does not exist.
    ValueError
        If a requested signal name is not found in the VCD file.
    """
    vcd_path = Path(vcd_path)
    if not vcd_path.exists():
        raise FileNotFoundError(f"VCD file not found: {vcd_path}")

    vcd = vcdvcd.VCDVCD(str(vcd_path))

    ts_dict = vcd.timescale
    ps_per_tick = _ps_per_tick(ts_dict)
    end_time_ps = int(vcd.endtime * ps_per_tick)

    # Build a mapping: leaf_name → list of full hierarchical references.
    # A VCD may define multiple signals that share the same leaf name (e.g.
    # two modules both containing a signal named ``clk``).  We handle this by
    # using the first match found, which is the common case for this project.
    leaf_to_refs: dict[str, list[str]] = {}
    for full_ref in vcd.references_to_ids:
        leaf = _leaf_name(full_ref)
        leaf_to_refs.setdefault(leaf, []).append(full_ref)

    # Determine which signals to include.
    if signals:
        # Validate that every requested name exists.
        unknown = [name for name in signals if name not in leaf_to_refs]
        if unknown:
            available = sorted(leaf_to_refs.keys())
            raise ValueError(
                f"Signal(s) not found in VCD: {unknown}. "
                f"Available signals: {available}"
            )
        selected_leaves = list(signals)
    else:
        # Return all signals preserving the order they appear in the VCD.
        selected_leaves = list(
            dict.fromkeys(_leaf_name(ref) for ref in vcd.signals)
        )

    output_signals: dict[str, dict[str, Any]] = {}
    for leaf in selected_leaves:
        # Use the first full reference for this leaf name.
        full_ref = leaf_to_refs[leaf][0]
        sig_id = vcd.references_to_ids[full_ref]
        sig = vcd.data[sig_id]

        # Convert time values to picoseconds.
        changes: list[list[Any]] = [
            [int(t * ps_per_tick), value]
            for t, value in sig.tv
        ]
        # tv is already sorted by time per vcdvcd documentation, but sort
        # explicitly to guarantee the contract.
        changes.sort(key=lambda pair: pair[0])

        output_signals[leaf] = {
            "width": sig.size,
            "changes": changes,
        }

    return {
        "timescale": _timescale_label(ts_dict),
        "end_time": end_time_ps,
        "signals": output_signals,
    }
