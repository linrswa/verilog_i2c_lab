"""cocotb testbench for i2c_top (system-level) — 對應原本的 i2c_system_tb.v"""

import cocotb
from cocotb.triggers import RisingEdge, FallingEdge, ClockCycles, First


CLK_DIV = 50
SLAVE_ADDR = 0x50


async def reset(dut):
    """Reset and initialize."""
    dut.rst_n.value = 0
    dut.start.value = 0
    dut.rw.value = 0
    dut.slave_addr_in.value = 0
    dut.data_in.value = 0
    dut.num_bytes.value = 0
    dut.repeated_start_in.value = 0
    dut.slave_addr_cfg.value = SLAVE_ADDR
    await ClockCycles(dut.clk, 5)
    dut.rst_n.value = 1
    await ClockCycles(dut.clk, 5)


async def wait_done(dut, timeout_cycles=100000):
    """等待 done 信號。"""
    for _ in range(timeout_cycles):
        await RisingEdge(dut.clk)
        if dut.done.value == 1:
            return True
    return False


async def master_write(dut, addr, byte0, byte1=0, byte2=0, nbytes=1, rep_start=False):
    """Master write transaction — 支援 address NACK 導致的提前 done。"""
    dut.slave_addr_in.value = addr
    dut.rw.value = 0
    dut.num_bytes.value = nbytes
    dut.data_in.value = byte0
    dut.repeated_start_in.value = 1 if rep_start else 0

    dut.start.value = 1
    await RisingEdge(dut.clk)
    dut.start.value = 0

    # 用 background task 監聽 done，同時 feed data
    done_event = cocotb.triggers.Event()
    early_done = False

    async def watch_done():
        nonlocal early_done
        while True:
            await RisingEdge(dut.clk)
            if dut.done.value == 1:
                early_done = True
                done_event.set()
                return

    watcher = cocotb.start_soon(watch_done())

    if nbytes > 1 and not early_done:
        # Race: 等 data feeding 時間或 early done
        for _ in range(11 * CLK_DIV):
            if early_done:
                break
            await RisingEdge(dut.clk)
        if not early_done:
            dut.data_in.value = byte1

    if nbytes > 2 and not early_done:
        while not early_done:
            await RisingEdge(dut.clk)
            if dut.byte_count.value == 1:
                break
        if not early_done:
            dut.data_in.value = byte2

    if not early_done:
        await done_event.wait()

    watcher.cancel()


async def master_read(dut, addr, nbytes):
    """Master read transaction，回傳 list of bytes。"""
    dut.slave_addr_in.value = addr
    dut.rw.value = 1
    dut.num_bytes.value = nbytes
    dut.repeated_start_in.value = 0

    dut.start.value = 1
    await RisingEdge(dut.clk)
    dut.start.value = 0

    read_data = []
    while len(read_data) < nbytes:
        await RisingEdge(dut.clk)
        if dut.data_valid.value == 1:
            read_data.append(int(dut.data_out.value))

    done = await wait_done(dut)
    assert done, "Timeout waiting for done"
    return read_data


async def write_then_read(dut, addr, reg_ptr, read_nbytes):
    """寫 register pointer 後讀回。"""
    await master_write(dut, addr, reg_ptr, nbytes=1)
    await ClockCycles(dut.clk, 10)
    return await master_read(dut, addr, read_nbytes)


async def wait_idle(dut):
    await ClockCycles(dut.clk, 10)


# ===================== Tests =====================

@cocotb.test()
async def test_single_byte_write(dut):
    """T1: Single byte write 0xA5 to reg[0x00]"""
    await reset(dut)
    await master_write(dut, SLAVE_ADDR, 0x00, 0xA5, nbytes=2)
    reg_val = dut.dut.slave_inst.register_file[0].value
    assert reg_val == 0xA5, f"T1 reg[0] = 0x{int(reg_val):02X}, expected 0xA5"
    await wait_idle(dut)


@cocotb.test()
async def test_single_byte_read_back(dut):
    """T2: Write 0xA5 to reg[0], then read back"""
    await reset(dut)
    # 先寫入
    await master_write(dut, SLAVE_ADDR, 0x00, 0xA5, nbytes=2)
    await wait_idle(dut)

    # 讀回
    data = await write_then_read(dut, SLAVE_ADDR, 0x00, 1)
    assert data[0] == 0xA5, f"T2 read[0] = 0x{data[0]:02X}, expected 0xA5"
    await wait_idle(dut)


@cocotb.test()
async def test_multi_byte_write(dut):
    """T3: Multi-byte write 0x11, 0x22 to reg[2], reg[3]"""
    await reset(dut)
    await master_write(dut, SLAVE_ADDR, 0x02, 0x11, 0x22, nbytes=3)
    assert dut.dut.slave_inst.register_file[2].value == 0x11, \
        f"T3 reg[2] = 0x{int(dut.dut.slave_inst.register_file[2].value):02X}, expected 0x11"
    assert dut.dut.slave_inst.register_file[3].value == 0x22, \
        f"T3 reg[3] = 0x{int(dut.dut.slave_inst.register_file[3].value):02X}, expected 0x22"
    await wait_idle(dut)


@cocotb.test()
async def test_multi_byte_read(dut):
    """T4: Multi-byte read back reg[2]=0x11, reg[3]=0x22"""
    await reset(dut)
    # 先寫入
    await master_write(dut, SLAVE_ADDR, 0x02, 0x11, 0x22, nbytes=3)
    await wait_idle(dut)

    # 讀回
    data = await write_then_read(dut, SLAVE_ADDR, 0x02, 2)
    assert data[0] == 0x11, f"T4 read[0] = 0x{data[0]:02X}, expected 0x11"
    assert data[1] == 0x22, f"T4 read[1] = 0x{data[1]:02X}, expected 0x22"
    await wait_idle(dut)


@cocotb.test()
async def test_address_mismatch(dut):
    """T5: Address mismatch — should get ack_error"""
    await reset(dut)
    await master_write(dut, 0x3F, 0x00, 0xFF, nbytes=2)
    assert dut.ack_error.value == 1, \
        f"T5 ack_error = {dut.ack_error.value}, expected 1"

    # 確認 reg[0] 沒被改到（先寫入已知值再測試）
    await wait_idle(dut)
