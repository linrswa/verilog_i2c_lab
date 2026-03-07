"""cocotb testbench for i2c_slave — 對應原本的 i2c_slave_tb.v"""

import cocotb
from cocotb.triggers import RisingEdge, FallingEdge, ClockCycles, Timer


# I2C timing parameters (ns)
I2C_PERIOD = 1000
HALF = I2C_PERIOD // 2
QUARTER = I2C_PERIOD // 4

SLAVE_ADDR = 0x50
WRONG_ADDR = 0x3A


async def reset(dut):
    """Reset DUT."""
    dut.rst_n.value = 0
    dut.master_scl_oe.value = 0
    dut.master_sda_oe.value = 0
    await Timer(200, unit="ns")
    dut.rst_n.value = 1
    await Timer(205, unit="ns")  # 偏移 5ns 避免 race condition


async def i2c_start(dut):
    """產生 START condition。"""
    dut.master_sda_oe.value = 0  # SDA → HIGH
    dut.master_scl_oe.value = 0  # SCL → HIGH
    await Timer(HALF, unit="ns")
    dut.master_sda_oe.value = 1  # SDA ↓ → START
    await Timer(QUARTER, unit="ns")
    dut.master_scl_oe.value = 1  # SCL → LOW
    await Timer(QUARTER, unit="ns")


async def i2c_stop(dut):
    """產生 STOP condition。"""
    dut.master_sda_oe.value = 1  # SDA = LOW
    await Timer(QUARTER, unit="ns")
    dut.master_scl_oe.value = 0  # SCL → HIGH
    await Timer(QUARTER, unit="ns")
    dut.master_sda_oe.value = 0  # SDA ↑ → STOP
    await Timer(HALF, unit="ns")


async def i2c_write_byte(dut, data):
    """寫一個 byte，回傳 slave 的 ACK（True = ACK, False = NACK）。"""
    for i in range(7, -1, -1):
        bit = (data >> i) & 1
        dut.master_sda_oe.value = 0 if bit else 1  # oe=1 → 拉低 SDA
        await Timer(QUARTER, unit="ns")
        dut.master_scl_oe.value = 0  # SCL ↑
        await Timer(HALF, unit="ns")
        dut.master_scl_oe.value = 1  # SCL ↓
        await Timer(QUARTER, unit="ns")

    # ACK phase
    dut.master_sda_oe.value = 0  # 釋放 SDA
    await Timer(QUARTER, unit="ns")
    dut.master_scl_oe.value = 0  # SCL ↑
    await Timer(QUARTER, unit="ns")
    ack = not bool(dut.sda.value)  # SDA=0 → ACK
    await Timer(QUARTER, unit="ns")
    dut.master_scl_oe.value = 1  # SCL ↓
    await Timer(QUARTER, unit="ns")
    return ack


async def i2c_read_byte(dut, send_ack):
    """讀一個 byte，Master 送 ACK 或 NACK。"""
    dut.master_sda_oe.value = 0  # 釋放 SDA
    data = 0
    for i in range(7, -1, -1):
        await Timer(QUARTER, unit="ns")
        dut.master_scl_oe.value = 0  # SCL ↑
        await Timer(QUARTER, unit="ns")
        bit = 1 if dut.sda.value else 0
        data |= (bit << i)
        await Timer(QUARTER, unit="ns")
        dut.master_scl_oe.value = 1  # SCL ↓
        await Timer(QUARTER, unit="ns")

    # Master ACK/NACK
    dut.master_sda_oe.value = 1 if send_ack else 0
    await Timer(QUARTER, unit="ns")
    dut.master_scl_oe.value = 0  # SCL ↑
    await Timer(HALF, unit="ns")
    dut.master_scl_oe.value = 1  # SCL ↓
    await Timer(QUARTER, unit="ns")
    dut.master_sda_oe.value = 0
    return data


# ===================== Tests =====================

@cocotb.test()
async def test_single_byte_write(dut):
    """Test 1: Single byte write — 寫 0xA5 到 reg[0x00]"""
    await reset(dut)

    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)  # Address + Write
    assert ack, "T1 addr should ACK"
    ack = await i2c_write_byte(dut, 0x00)  # Register address
    assert ack, "T1 reg_addr should ACK"
    ack = await i2c_write_byte(dut, 0xA5)  # Data
    assert ack, "T1 data should ACK"
    await i2c_stop(dut)

    await Timer(I2C_PERIOD, unit="ns")
    reg_val = dut.dut.register_file[0].value
    assert reg_val == 0xA5, f"T1 reg[0] = 0x{int(reg_val):02X}, expected 0xA5"


@cocotb.test()
async def test_multi_byte_write(dut):
    """Test 2: Multi-byte write — 寫 0x11, 0x22 到 reg[0x02], reg[0x03]"""
    await reset(dut)

    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)
    assert ack, "T2 addr should ACK"
    ack = await i2c_write_byte(dut, 0x02)  # Register address
    assert ack, "T2 reg_addr should ACK"
    ack = await i2c_write_byte(dut, 0x11)  # Data 1
    assert ack, "T2 data1 should ACK"
    ack = await i2c_write_byte(dut, 0x22)  # Data 2
    assert ack, "T2 data2 should ACK"
    await i2c_stop(dut)

    await Timer(I2C_PERIOD, unit="ns")
    assert dut.dut.register_file[2].value == 0x11, \
        f"T2 reg[2] = 0x{int(dut.dut.register_file[2].value):02X}, expected 0x11"
    assert dut.dut.register_file[3].value == 0x22, \
        f"T2 reg[3] = 0x{int(dut.dut.register_file[3].value):02X}, expected 0x22"


@cocotb.test()
async def test_single_byte_read(dut):
    """Test 3: Single byte read — 先寫 0xA5 到 reg[0x00]，再讀回來"""
    await reset(dut)

    # 先寫入
    await i2c_start(dut)
    await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)
    await i2c_write_byte(dut, 0x00)
    await i2c_write_byte(dut, 0xA5)
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    # 設定 register pointer
    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)
    assert ack, "T3 write addr should ACK"
    ack = await i2c_write_byte(dut, 0x00)
    assert ack, "T3 reg_addr should ACK"
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    # 讀取
    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 1)  # Read
    assert ack, "T3 read addr should ACK"
    data = await i2c_read_byte(dut, send_ack=False)  # NACK
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    assert data == 0xA5, f"T3 read data = 0x{data:02X}, expected 0xA5"


@cocotb.test()
async def test_multi_byte_read(dut):
    """Test 4: Multi-byte read — 讀 reg[0x02]=0x11, reg[0x03]=0x22"""
    await reset(dut)

    # 先寫入 reg[2]=0x11, reg[3]=0x22
    await i2c_start(dut)
    await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)
    await i2c_write_byte(dut, 0x02)
    await i2c_write_byte(dut, 0x11)
    await i2c_write_byte(dut, 0x22)
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    # 設定 register pointer
    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)
    assert ack, "T4 write addr should ACK"
    ack = await i2c_write_byte(dut, 0x02)
    assert ack, "T4 reg_addr should ACK"
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    # 讀取 2 bytes
    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 1)
    assert ack, "T4 read addr should ACK"
    data1 = await i2c_read_byte(dut, send_ack=True)   # ACK（繼續讀）
    data2 = await i2c_read_byte(dut, send_ack=False)   # NACK（最後一個）
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    assert data1 == 0x11, f"T4 data1 = 0x{data1:02X}, expected 0x11"
    assert data2 == 0x22, f"T4 data2 = 0x{data2:02X}, expected 0x22"


@cocotb.test()
async def test_repeated_start_write_then_read(dut):
    """Test 5: Write + Repeated Start + Read"""
    await reset(dut)

    # 寫 0xBE 到 reg[0x05]
    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)
    assert ack, "T5 write addr should ACK"
    ack = await i2c_write_byte(dut, 0x05)
    assert ack, "T5 reg_addr should ACK"
    ack = await i2c_write_byte(dut, 0xBE)
    assert ack, "T5 data should ACK"
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    assert dut.dut.register_file[5].value == 0xBE, \
        f"T5 reg[5] = 0x{int(dut.dut.register_file[5].value):02X}, expected 0xBE"

    # Repeated Start read back
    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 0)
    assert ack, "T5 write addr2 should ACK"
    ack = await i2c_write_byte(dut, 0x05)
    assert ack, "T5 reg_addr2 should ACK"
    await i2c_start(dut)  # Repeated START
    ack = await i2c_write_byte(dut, (SLAVE_ADDR << 1) | 1)
    assert ack, "T5 read addr should ACK"
    data = await i2c_read_byte(dut, send_ack=False)
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")

    assert data == 0xBE, f"T5 read back = 0x{data:02X}, expected 0xBE"


@cocotb.test()
async def test_address_mismatch(dut):
    """Test 6: Address mismatch — slave 不應回 ACK"""
    await reset(dut)

    await i2c_start(dut)
    ack = await i2c_write_byte(dut, (WRONG_ADDR << 1) | 0)
    assert not ack, "T6 wrong address should NACK"
    await i2c_stop(dut)
    await Timer(I2C_PERIOD, unit="ns")
