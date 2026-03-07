"""cocotb Python runner — 取代 Makefile"""

import os
import shutil
import sys
from pathlib import Path

from cocotb_tools.runner import get_runner

COCOTB_DIR = Path(__file__).parent
I2C_DIR = COCOTB_DIR.parent

TESTS = {
    "slave": {
        "sources": [I2C_DIR / "i2c_slave.v", COCOTB_DIR / "i2c_slave_wrapper.v"],
        "toplevel": "i2c_slave_wrapper",
        "module": "test_i2c_slave",
    },
    "master": {
        "sources": [I2C_DIR / "i2c_master.v", COCOTB_DIR / "i2c_master_wrapper.v"],
        "toplevel": "i2c_master_wrapper",
        "module": "test_i2c_master",
    },
    "system": {
        "sources": [
            I2C_DIR / "i2c_master.v",
            I2C_DIR / "i2c_slave.v",
            I2C_DIR / "i2c_top.v",
            COCOTB_DIR / "i2c_system_wrapper.v",
        ],
        "toplevel": "i2c_system_wrapper",
        "module": "test_i2c_system",
    },
}


def run_test(name: str, waves: bool) -> None:
    cfg = TESTS[name]
    runner = get_runner("icarus")
    runner.build(
        sources=[str(s) for s in cfg["sources"]],
        hdl_toplevel=cfg["toplevel"],
        build_dir=str(COCOTB_DIR / "sim_build" / name),
    )
    runner.test(
        hdl_toplevel=cfg["toplevel"],
        test_module=cfg["module"],
        test_dir=str(COCOTB_DIR),
    )

    if waves:
        vcd_name = f"i2c_{name}_cocotb.vcd" if name != "system" else "i2c_system_cocotb.vcd"
        vcd_src = COCOTB_DIR / vcd_name
        if vcd_src.exists():
            waveform_dir = COCOTB_DIR / "waveform"
            waveform_dir.mkdir(exist_ok=True)
            shutil.move(str(vcd_src), str(waveform_dir / vcd_name))


def main() -> None:
    args = sys.argv[1:]
    waves = "--waves" in args
    targets = [a for a in args if a != "--waves"]

    if waves:
        os.environ["WAVES"] = "1"

    if not targets:
        targets = list(TESTS.keys())

    for t in targets:
        if t not in TESTS:
            print(f"Unknown test: {t}")
            print(f"Available: {', '.join(TESTS.keys())}")
            sys.exit(1)

    for t in targets:
        print(f"\n{'='*40}")
        print(f"  Running: {t}")
        print(f"{'='*40}\n")
        run_test(t, waves)


if __name__ == "__main__":
    main()
