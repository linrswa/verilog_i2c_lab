`timescale 1ns / 1ps

// I2C 系統頂層模組 — 連接 master + slave + bus
module i2c_top #(
    parameter CLK_DIV = 100
) (
    // 系統
    input wire clk,
    input wire rst_n,

    // Master 控制信號
    input wire       start,
    input wire       rw,
    input wire [6:0] slave_addr,
    input wire [7:0] data_in,
    input wire [3:0] num_bytes,
    input wire       repeated_start,

    // Slave 設定
    input wire [6:0] slave_addr_cfg,

    // Master 狀態輸出
    output wire       busy,
    output wire       done,
    output wire       ack_error,
    output wire [7:0] data_out,
    output wire       data_valid,
    output wire [3:0] byte_count,

    // Slave 狀態輸出
    output wire       slave_busy,
    output wire [7:0] reg_addr,
    output wire [7:0] reg_data_out,
    output wire       write_valid
);

    // I2C bus 線路
    wire sda;
    wire scl;

    // Pullup 電阻（模擬 open-drain bus）
    pullup (sda);
    pullup (scl);

    // Master instance
    i2c_master #(
        .CLK_DIV(CLK_DIV)
    ) master_inst (
        .clk      (clk),
        .rst_n    (rst_n),
        .start    (start),
        .rw       (rw),
        .slave_addr(slave_addr),
        .data_in  (data_in),
        .num_bytes(num_bytes),
        .repeated_start(repeated_start),
        .busy     (busy),
        .done     (done),
        .ack_error(ack_error),
        .data_out (data_out),
        .data_valid(data_valid),
        .byte_count(byte_count),
        .scl      (scl),
        .sda      (sda)
    );

    // Slave instance
    i2c_slave slave_inst (
        .clk      (clk),
        .rst_n    (rst_n),
        .slave_addr(slave_addr_cfg),
        .busy     (slave_busy),
        .reg_addr (reg_addr),
        .reg_data_out(reg_data_out),
        .write_valid(write_valid),
        .scl      (scl),
        .sda      (sda)
    );

endmodule
