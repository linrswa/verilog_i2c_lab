`timescale 1ns / 1ps

module i2c_slave (
    input wire clk,   // 系統時鐘
    input wire rst_n, // 非同步 reset（active low）

    // 配置
    input wire [6:0] slave_addr,  // 本 slave 的 7-bit address

    // 狀態輸出
    output reg       busy,          // transaction 進行中
    output reg [7:0] reg_addr,      // 目前操作的 register address
    output reg [7:0] reg_data_out,  // 最近一次寫入的 data（debug 用）
    output reg       write_valid,   // 有新資料被寫入 register（one-cycle pulse）

    // I2C bus
    input wire scl,  // I2C clock（由 Master 驅動）
    inout wire sda   // I2C data（open-drain, bidirectional）
);
    reg [7:0] register_file[0:255];  // 256 個 8-bit register
    // 初始化 register file，避免讀取未寫入的 register 時產生 X
    integer rf_i;
    initial begin
        for (rf_i = 0; rf_i < 256; rf_i = rf_i + 1)
            register_file[rf_i] = 8'h00;
    end
    reg [7:0] slave_addr_recive;
    reg [7:0] shift_reg;           // 接收中的 byte 暫存器
    reg sda_oe;
    reg [3:0] bit_cnt;
    reg first_byte_received;
    reg sda_prev, scl_prev;  // 用來檢測 SDA 和 SCL 的邊緣

    //// Start 和 Stop 條件的檢測////////
    wire start_condition = scl & sda_prev & ~sda;
    // Guard stop_condition: during READ-ACK the master releases SDA (0→1) while
    // SCL is still high, which looks like a STOP but is not.  Suppress
    // detection during the READ-ACK window tracked by in_read_ack_window.
    wire stop_condition = scl & ~sda_prev & sda & ~in_read_ack_window;

    //// scl ///
    wire scl_rising = (scl_prev == 0) && (scl == 1);
    wire scl_falling = (scl_prev == 1) && (scl == 0);

    //// open-drain 控制 SDA 線 ////
    assign sda = sda_oe ? 1'b0 : 1'bz;

    reg [2:0] state;
    reg [2:0] ack_state;
    // idle addr ack read write
    localparam IDLE = 3'b000, ADDR = 3'b001, ACK = 3'b010, READ = 3'b011, WRITE = 3'b100;

    // One-cycle flag set while slave is in ACK state with ack_state == READ
    // (master byte ACK) or on the immediately following cycle (state == READ).
    // Used to suppress false stop_condition detection when the master releases
    // SDA during READ-mode ACK while SCL is still high.
    reg in_read_ack_window;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            busy <= 0;
            reg_addr <= 0;
            reg_data_out <= 0;
            slave_addr_recive <= 0;
            shift_reg <= 0;
            write_valid <= 0;
            sda_oe <= 0;
            first_byte_received <= 0;

            bit_cnt <= 0;
            sda_prev <= 1;
            scl_prev <= 1;
            state <= IDLE;
            in_read_ack_window <= 0;
        end else begin
            sda_prev <= sda;
            scl_prev <= scl;
                    // Suppress false STOP detection while the slave is transmitting
            // read data (READ state) or during the ACK phase following a read
            // byte (ACK state with ack_state==READ).
            //
            // In READ mode the master legitimately releases SDA (driving it
            // from 0 to 1) while SCL is high at the start of each inter-byte
            // ACK window.  The slave must not interpret this as a STOP; it
            // detects end-of-read via the NACK signal (SDA high at scl_rising
            // in ACK state) rather than via the stop_condition wire.
            //
            // A genuine STOP issued by the master after a NACK will be
            // detected once the slave transitions to IDLE state, at which
            // point in_read_ack_window is 0 and stop_condition is unmasked.
            in_read_ack_window <= (state == READ) ||
                                  (state == ACK && ack_state == READ);
            if (stop_condition) begin
                busy   <= 0;
                sda_oe <= 0;
                state  <= IDLE;
            end else if (start_condition) begin
                busy <= 1;
                state <= ADDR;
                bit_cnt <= 0;
                sda_oe <= 0;
            end
            case (state)
                IDLE: begin
                    bit_cnt <= 0;
                end

                ADDR: begin
                    if (scl_rising) begin  // 在 SCL 上升沿讀取 SDA
                        bit_cnt <= bit_cnt + 1;
                        slave_addr_recive <= {
                            slave_addr_recive[6:0], sda
                        };  // Shift in address bits
                    end else if (scl_falling) begin
                        if (bit_cnt == 8) begin
                            if (slave_addr_recive[7:1] == slave_addr) begin
                                state <= ACK;
                                ack_state <= ADDR;
                                sda_oe <= 1;  // ACK
                            end else begin
                                state  <= IDLE;  // Address 不匹配，回到 IDLE
                                sda_oe <= 0;
                            end
                        end
                    end
                end

                ACK: begin
                    bit_cnt <= 0;
                    case (ack_state)
                        ADDR: begin
                            if (scl_falling) begin
                                sda_oe <= 0;
                                if (slave_addr_recive[0]) begin
                                    state <= READ;  // Master 要讀取資料
                                    sda_oe <= ~register_file[reg_addr][7];  // 先準備好第一個 bit
                                end else begin
                                    state <= WRITE;  // Master 要寫入資料
                                    first_byte_received <= 0;
                                end
                            end
                        end
                        READ: begin
                            if (scl_rising) begin
                                if (sda) begin
                                    state <= IDLE;
                                end else begin
                                    reg_addr <= reg_addr + 1;
                                    sda_oe <= ~register_file[reg_addr][7];  // 先準備好第一個 bit
                                    state <= READ;
                                end
                            end
                        end
                        WRITE: begin
                            write_valid <= 0;
                            if (scl_falling) begin
                                sda_oe <= 0;
                                if (first_byte_received) begin
                                    reg_addr <= reg_addr + 1;
                                end else begin
                                    first_byte_received <= 1;
                                end
                                state <= WRITE;
                            end
                        end
                        default: state <= IDLE;
                    endcase
                end
                READ: begin
                    if (scl_rising) begin
                        bit_cnt <= bit_cnt + 1;
                    end else if (scl_falling) begin
                        if (bit_cnt == 8) begin
                            sda_oe <= 0;
                            state <= ACK;
                            ack_state <= READ;
                        end else begin
                            sda_oe <= ~register_file[reg_addr][7-bit_cnt];
                        end
                    end
                end
                WRITE: begin
                    if (scl_rising) begin
                        bit_cnt <= bit_cnt + 1;
                        shift_reg <= {shift_reg[6:0], sda};
                    end else if (scl_falling) begin
                        if (bit_cnt == 8) begin
                            if (first_byte_received) begin
                                register_file[reg_addr] <= shift_reg;
                                reg_data_out <= shift_reg;
                            end else begin
                                reg_addr <= shift_reg;
                            end
                            write_valid <= first_byte_received;
                            sda_oe <= 1;
                            state <= ACK;
                            ack_state <= WRITE;
                        end
                    end
                end
                default: state <= IDLE;

            endcase
        end
    end
endmodule
