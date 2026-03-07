"""cocotb testbench for i2c_master — 對應原本的 i2c_master_tb.v"""

import cocotb
from cocotb.triggers import RisingEdge, FallingEdge, ClockCycles, Timer


CLK_DIV = 8  # 要跟 wrapper 裡的 parameter 一致


async def reset(dut):
    """Reset DUT and initialize signals."""
    dut.rst_n.value = 0
    dut.start.value = 0
    dut.slave_addr.value = 0b1010000  # 0x50
    dut.slave_sda_oe.value = 0
    dut.data_in.value = 0xA5
    dut.num_bytes.value = 1
    dut.repeated_start.value = 0
    await ClockCycles(dut.clk, 2)
    dut.rst_n.value = 1
    await ClockCycles(dut.clk, 2)


async def slave_ack_mock(dut):
    """模擬 slave ACK：等 8 個 SCL rising edge（data bits），然後在 ACK phase 拉低 SDA。"""
    for _ in range(8):
        await RisingEdge(dut.scl)
    await FallingEdge(dut.scl)
    await ClockCycles(dut.clk, 2)
    dut.slave_sda_oe.value = 1  # ACK
    await ClockCycles(dut.clk, 6)
    dut.slave_sda_oe.value = 0  # Release


async def slave_nack_mock(dut):
    """模擬 slave NACK：等 9 個 SCL rising edge 但不拉低 SDA。"""
    for _ in range(9):
        await RisingEdge(dut.scl)
    dut.slave_sda_oe.value = 0


async def slave_sda_mock(dut, byte_val):
    """模擬 slave 傳送一個 byte（read mode）。"""
    for i in range(7, -1, -1):
        await FallingEdge(dut.scl)
        await ClockCycles(dut.clk, 2)
        bit = (byte_val >> i) & 1
        dut.slave_sda_oe.value = 0 if bit else 1  # oe=1 拉低 SDA → bit=0
        await RisingEdge(dut.scl)
    await FallingEdge(dut.scl)
    dut.slave_sda_oe.value = 0  # Release


async def wait_done(dut, timeout_cycles=2000):
    """等待 done 信號，帶 timeout。done 後多等幾個 cycle 讓 busy 清除。"""
    for _ in range(timeout_cycles):
        await RisingEdge(dut.clk)
        if dut.done.value == 1:
            await ClockCycles(dut.clk, 5)
            return True
    return False


# ===================== Write Tests =====================

@cocotb.test()
async def test_normal_write(dut):
    """Normal Write — 兩次 ACK（address + data）"""
    await reset(dut)
    dut.rw.value = 0

    await ClockCycles(dut.clk, 4)
    dut.start.value = 1
    await ClockCycles(dut.clk, 2)
    dut.start.value = 0

    await slave_ack_mock(dut)  # Address ACK
    await slave_ack_mock(dut)  # Data ACK

    done = await wait_done(dut)
    assert done, "done never pulsed"
    assert dut.ack_error.value == 0, f"ack_error = {dut.ack_error.value}, expected 0"
    assert dut.busy.value == 0, f"busy = {dut.busy.value}, expected 0"


@cocotb.test()
async def test_nack_on_addr(dut):
    """NACK on Address"""
    await reset(dut)
    dut.rw.value = 0

    await ClockCycles(dut.clk, 4)
    dut.start.value = 1
    await ClockCycles(dut.clk, 2)
    dut.start.value = 0

    await slave_nack_mock(dut)

    done = await wait_done(dut)
    assert done, "done never pulsed"
    assert dut.ack_error.value == 1, f"ack_error = {dut.ack_error.value}, expected 1"
    assert dut.busy.value == 0, f"busy = {dut.busy.value}, expected 0"


@cocotb.test()
async def test_nack_on_data(dut):
    """NACK on Data — address ACK, data NACK"""
    await reset(dut)
    dut.rw.value = 0

    await ClockCycles(dut.clk, 4)
    dut.start.value = 1
    await ClockCycles(dut.clk, 2)
    dut.start.value = 0

    await slave_ack_mock(dut)  # Address ACK
    # No ACK for data — wait for timeout/done

    done = await wait_done(dut)
    assert done, "done never pulsed"
    assert dut.ack_error.value == 1, f"ack_error = {dut.ack_error.value}, expected 1"
    assert dut.busy.value == 0, f"busy = {dut.busy.value}, expected 0"


@cocotb.test()
async def test_multi_byte_write(dut):
    """Multi-byte Write（3 bytes）"""
    await reset(dut)
    dut.rw.value = 0
    dut.num_bytes.value = 3
    dut.data_in.value = 0xA5

    await ClockCycles(dut.clk, 4)
    dut.start.value = 1
    await ClockCycles(dut.clk, 2)
    dut.start.value = 0

    await slave_ack_mock(dut)       # Address ACK
    dut.data_in.value = 0xB6
    await slave_ack_mock(dut)       # Byte 0 ACK
    dut.data_in.value = 0xC7
    await slave_ack_mock(dut)       # Byte 1 ACK
    await slave_ack_mock(dut)       # Byte 2 ACK

    done = await wait_done(dut)
    assert done, "done never pulsed"
    assert dut.ack_error.value == 0, f"ack_error = {dut.ack_error.value}, expected 0"
    assert dut.busy.value == 0, f"busy = {dut.busy.value}, expected 0"
    assert dut.byte_count.value == 3, f"byte_count = {dut.byte_count.value}, expected 3"


# ===================== Read Tests =====================

@cocotb.test()
async def test_normal_read(dut):
    """Normal Read — 讀回 0xAA"""
    await reset(dut)
    dut.rw.value = 1

    await ClockCycles(dut.clk, 4)
    dut.start.value = 1
    await ClockCycles(dut.clk, 2)
    dut.start.value = 0

    await slave_ack_mock(dut)        # Address ACK
    await slave_sda_mock(dut, 0xAA)  # Slave sends 0xAA

    done = await wait_done(dut)
    assert done, "done never pulsed"
    assert dut.ack_error.value == 0, f"ack_error = {dut.ack_error.value}, expected 0"
    assert dut.busy.value == 0, f"busy = {dut.busy.value}, expected 0"
    assert dut.data_out.value == 0xAA, f"data_out = 0x{int(dut.data_out.value):02X}, expected 0xAA"


@cocotb.test()
async def test_multi_byte_read(dut):
    """Multi-byte Read（2 bytes）"""
    await reset(dut)
    dut.rw.value = 1
    dut.num_bytes.value = 2

    await ClockCycles(dut.clk, 4)
    dut.start.value = 1
    await ClockCycles(dut.clk, 2)
    dut.start.value = 0

    await slave_ack_mock(dut)        # Address ACK

    # 用 list 收集 data_valid 的結果
    read_bytes = []

    async def capture_data():
        while len(read_bytes) < 2:
            await RisingEdge(dut.clk)
            if dut.data_valid.value == 1:
                read_bytes.append(int(dut.data_out.value))

    async def drive_slave():
        await slave_sda_mock(dut, 0xAA)  # Byte 0
        await slave_sda_mock(dut, 0x55)  # Byte 1

    # 同時進行
    cap_task = cocotb.start_soon(capture_data())
    await drive_slave()
    done = await wait_done(dut)

    assert done, "done never pulsed"
    assert dut.ack_error.value == 0
    assert dut.busy.value == 0
    assert len(read_bytes) >= 2, f"Only captured {len(read_bytes)} bytes"
    assert read_bytes[0] == 0xAA, f"byte 0 = 0x{read_bytes[0]:02X}, expected 0xAA"
    assert read_bytes[1] == 0x55, f"byte 1 = 0x{read_bytes[1]:02X}, expected 0x55"
    assert dut.byte_count.value == 2, f"byte_count = {dut.byte_count.value}, expected 2"


# ===================== Repeated Start Test =====================

@cocotb.test()
async def test_repeated_start(dut):
    """Repeated Start — write then read"""
    await reset(dut)
    dut.repeated_start.value = 1
    dut.rw.value = 0  # First: write

    await ClockCycles(dut.clk, 4)
    dut.start.value = 1
    await ClockCycles(dut.clk, 2)
    dut.start.value = 0

    await slave_ack_mock(dut)  # Address ACK
    await slave_ack_mock(dut)  # Data ACK
    dut.repeated_start.value = 0

    # 等待 repeated start，切換到 read
    await RisingEdge(dut.scl)
    dut.rw.value = 1

    await slave_ack_mock(dut)         # Address ACK（read）
    await slave_sda_mock(dut, 0x55)   # Slave sends 0x55

    done = await wait_done(dut)
    assert done, "done never pulsed"
    assert dut.ack_error.value == 0
    assert dut.busy.value == 0
    assert dut.data_out.value == 0x55, f"data_out = 0x{int(dut.data_out.value):02X}, expected 0x55"
