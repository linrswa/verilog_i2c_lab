`timescale 1ns / 1ps

// I2C 端對端 self-checking testbench
module i2c_system_tb;

    parameter CLK_DIV = 50;
    parameter CLK_PERIOD = 10;
    parameter SLAVE_ADDR = 7'h50;

    reg        clk, rst_n;
    reg        start, rw;
    reg  [6:0] slave_addr_in;
    reg  [7:0] data_in;
    reg  [3:0] num_bytes;
    reg        repeated_start_in;
    reg  [6:0] slave_addr_cfg;

    wire       busy, done, ack_error;
    wire [7:0] data_out;
    wire       data_valid;
    wire [3:0] byte_count;
    wire       slave_busy;
    wire [7:0] reg_addr;
    wire [7:0] reg_data_out;
    wire       write_valid;

    integer pass_count = 0;
    integer fail_count = 0;
    reg [7:0] read_data [0:3];

    i2c_top #(.CLK_DIV(CLK_DIV)) uut (
        .clk           (clk),
        .rst_n         (rst_n),
        .start         (start),
        .rw            (rw),
        .slave_addr    (slave_addr_in),
        .data_in       (data_in),
        .num_bytes     (num_bytes),
        .repeated_start(repeated_start_in),
        .slave_addr_cfg(slave_addr_cfg),
        .busy          (busy),
        .done          (done),
        .ack_error     (ack_error),
        .data_out      (data_out),
        .data_valid    (data_valid),
        .byte_count    (byte_count),
        .slave_busy    (slave_busy),
        .reg_addr      (reg_addr),
        .reg_data_out  (reg_data_out),
        .write_valid   (write_valid)
    );

    initial clk = 0;
    always #(CLK_PERIOD / 2) clk = ~clk;

    initial begin
        $dumpfile("i2c_system.vcd");
        $dumpvars(0, i2c_system_tb);
    end

    initial begin
        #5000000;
        $display("[TIMEOUT]");
        $finish;
    end

    // =========================================================
    // Protocol Checker
    // =========================================================
    wire sda_bus = uut.sda;
    wire scl_bus = uut.scl;
    reg  sda_d, scl_d;

    always @(posedge clk) begin
        if (rst_n) begin
            sda_d <= sda_bus;
            scl_d <= scl_bus;
            if (scl_bus === 1'b1 && scl_d === 1'b1 &&
                sda_bus !== 1'bx && sda_d !== 1'bx &&
                sda_bus !== sda_d) begin
                if (sda_d && !sda_bus)
                    $display("[PROTOCOL] START at %0t", $time);
                else if (!sda_d && sda_bus)
                    $display("[PROTOCOL] STOP at %0t", $time);
            end
        end
    end

    // =========================================================
    // Helper Tasks
    // =========================================================
    task check;
        input [255:0] name;
        input [7:0]   expected;
        input [7:0]   actual;
        begin
            if (expected === actual) begin
                $display("[PASS] %0s: expected=0x%02X actual=0x%02X",
                         name, expected, actual);
                pass_count = pass_count + 1;
            end else begin
                $display("[FAIL] %0s: expected=0x%02X actual=0x%02X",
                         name, expected, actual);
                fail_count = fail_count + 1;
            end
        end
    endtask

    task check_bit;
        input [255:0] name;
        input         expected;
        input         actual;
        begin
            if (expected === actual) begin
                $display("[PASS] %0s: expected=%0b actual=%0b",
                         name, expected, actual);
                pass_count = pass_count + 1;
            end else begin
                $display("[FAIL] %0s: expected=%0b actual=%0b",
                         name, expected, actual);
                fail_count = fail_count + 1;
            end
        end
    endtask

    task wait_idle;
        begin
            repeat (10) @(posedge clk);
        end
    endtask

    // master_write — 寫入 1~3 bytes（byte0 通常是 register addr）
    // 使用 fork/disable 處理 address NACK 導致的提前 done
    task master_write;
        input [6:0] addr;
        input [7:0] byte0;
        input [7:0] byte1;
        input [7:0] byte2;
        input [3:0] nbytes;
        input       rep_start;
        begin
            slave_addr_in     = addr;
            rw                = 0;
            num_bytes         = nbytes;
            data_in           = byte0;
            repeated_start_in = rep_start;
            start = 1;
            @(posedge clk);
            start = 0;

            fork
                begin : feed_data
                    if (nbytes > 1) begin
                        repeat (11 * CLK_DIV) @(posedge clk);
                        data_in = byte1;
                    end
                    if (nbytes > 2) begin
                        wait (byte_count == 4'd1);
                        @(posedge clk);
                        data_in = byte2;
                    end
                    @(posedge done);
                end
                begin : catch_early_done
                    @(posedge done);
                    disable feed_data;
                end
            join
        end
    endtask

    // master_read — 讀取 N bytes
    task master_read;
        input [6:0] addr;
        input [3:0] nbytes;
        integer i;
        begin
            slave_addr_in     = addr;
            rw                = 1;
            num_bytes         = nbytes;
            repeated_start_in = 0;
            start = 1;
            @(posedge clk);
            start = 0;

            for (i = 0; i < nbytes; i = i + 1) begin
                @(posedge data_valid);
                read_data[i] = data_out;
            end

            @(posedge done);
        end
    endtask

    // write_then_read — 寫 register pointer 後讀回
    // 使用兩個獨立的 transaction（STOP 後再 START）
    // slave 的 reg_addr 在 STOP 後仍然保留
    task write_then_read;
        input [6:0] addr;
        input [7:0] reg_ptr;
        input [3:0] read_nbytes;
        integer i;
        begin
            // Phase 1: 寫入 register pointer（1 byte write）
            master_write(addr, reg_ptr, 8'h00, 8'h00, 4'd1, 0);
            wait_idle;

            // Phase 2: 讀取
            master_read(addr, read_nbytes);
        end
    endtask

    // =========================================================
    // 主測試流程
    // =========================================================
    initial begin
        rst_n             = 0;
        start             = 0;
        rw                = 0;
        slave_addr_in     = 0;
        data_in           = 0;
        num_bytes         = 0;
        repeated_start_in = 0;
        slave_addr_cfg    = SLAVE_ADDR;

        repeat (5) @(posedge clk);
        rst_n = 1;
        repeat (5) @(posedge clk);

        // T1: Single byte write — 寫 0xA5 到 reg[0x00]
        $display("\n=== T1: Single byte write 0xA5 to reg[0x00] ===");
        master_write(SLAVE_ADDR, 8'h00, 8'hA5, 8'h00, 4'd2, 0);
        check("T1 reg[0]", 8'hA5, uut.slave_inst.register_file[0]);
        wait_idle;

        // T2: Single byte read back
        $display("\n=== T2: Read back reg[0x00] ===");
        write_then_read(SLAVE_ADDR, 8'h00, 4'd1);
        check("T2 read[0]", 8'hA5, read_data[0]);
        wait_idle;

        // T3: Multi-byte write — 寫 0x11, 0x22 到 reg[0x02], reg[0x03]
        $display("\n=== T3: Multi-byte write 0x11,0x22 to reg[2],[3] ===");
        master_write(SLAVE_ADDR, 8'h02, 8'h11, 8'h22, 4'd3, 0);
        check("T3 reg[2]", 8'h11, uut.slave_inst.register_file[2]);
        check("T3 reg[3]", 8'h22, uut.slave_inst.register_file[3]);
        wait_idle;

        // T4: Multi-byte read back
        $display("\n=== T4: Multi-byte read reg[2],[3] ===");
        write_then_read(SLAVE_ADDR, 8'h02, 4'd2);
        check("T4 read[0]", 8'h11, read_data[0]);
        check("T4 read[1]", 8'h22, read_data[1]);
        wait_idle;

        // T5: Address mismatch
        $display("\n=== T5: Address mismatch (0x3F) ===");
        master_write(7'h3F, 8'h00, 8'hFF, 8'h00, 4'd2, 0);
        check_bit("T5 ack_error", 1'b1, ack_error);
        check("T5 reg[0] unchanged", 8'hA5, uut.slave_inst.register_file[0]);
        wait_idle;

        // 結果
        $display("\n========================================");
        $display("  PASS: %0d  FAIL: %0d", pass_count, fail_count);
        if (fail_count == 0)
            $display("  ALL TESTS PASSED");
        else
            $display("  SOME TESTS FAILED");
        $display("========================================\n");
        $finish;
    end

endmodule
