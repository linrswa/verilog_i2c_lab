`timescale 1ns / 1ps
// cocotb wrapper for i2c_top (system-level test)
module i2c_system_wrapper;

    parameter CLK_DIV = 50;
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

    i2c_top #(.CLK_DIV(CLK_DIV)) dut (
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

    // Clock generation: 100MHz
    initial clk = 0;
    always #5 clk = ~clk;

    // VCD dump
    initial begin
        $dumpfile("i2c_system_cocotb.vcd");
        $dumpvars(0, i2c_system_wrapper);
    end

endmodule
