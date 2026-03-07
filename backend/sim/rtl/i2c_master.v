`timescale 1ns / 1ps
module i2c_master (
    input wire clk,   // 系統時鐘
    input wire rst_n, // 非同步 reset（active low）

    // Transaction 控制
    input wire       start,          // 觸發一筆 transaction
    input wire       rw,             // 0 = write, 1 = read
    input wire [6:0] slave_addr,     // 7-bit slave address
    input wire [7:0] data_in,        // 寫入用的 data（write mode）
    input wire [3:0] num_bytes,      // 本次 transaction 要傳輸的 byte 數（1~15）
    input wire       repeated_start, // 1 = transaction 結束時送 repeated start 而非 STOP

    // 狀態輸出
    output reg busy,  // transaction 進行中
    output reg done,  // transaction 完成（one-cycle pulse）
    output reg ack_error,  // slave 回 NACK
    output reg [7:0] data_out,  // 讀取到的 data（read mode，每 byte 有效時更新）
    output reg data_valid,   // data_out 有效（one-cycle pulse，每讀完一個 byte 拉高一次）
    output reg [3:0] byte_count,  // 目前已傳輸的 byte 數

    // I2C bus
    output wire scl,  // I2C clock（open-drain）
    inout  wire sda   // I2C data（open-drain, bidirectional）
);

  // parameter / 內部 reg、wire 宣告
  parameter integer CLK_DIV = 100;

  localparam integer N_EDGE = 0,
                     LOW_MID = CLK_DIV / 4,
                     P_EDGE = CLK_DIV / 2,
                     HIGH_MID = 3 * CLK_DIV / 4;

  localparam integer IDLE           = 3'b000,
                     START          = 3'b001,
                     ADDR           = 3'b010,
                     WRITE          = 3'b011,
                     READ           = 3'b100,
                     ACK            = 3'b101,
                     REPEATED_START = 3'b110,
                     STOP           = 3'b111;

  reg [$clog2(CLK_DIV)-1:0] clk_div_cnt;  // clock divider counter
  reg sda_oe;
  reg scl_oe;

  reg [2:0] state;
  reg [7:0] addr_buf;
  reg [7:0] data_buf;
  reg [2:0] bit_cnt;
  reg [2:0] ack_flag;

  // clock divider counter 的 always block
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      clk_div_cnt <= 0;
    end else if (clk_div_cnt == CLK_DIV - 1) begin
      clk_div_cnt <= 0;
    end else begin
      clk_div_cnt <= clk_div_cnt + 1;
    end
  end

  // open-drain
  assign sda = sda_oe ? 1'b0 : 1'bz;  // sda_oe = 1 時拉低，否則高阻
  assign scl = scl_oe ? 1'b0 : 1'bz;  //

  // scl
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      scl_oe <= 0;
    end else begin
      case (state)
        IDLE, START: scl_oe <= 0;  // IDLE 和 START 狀態保持 SCL 高阻
        // STOP 使用 default 正常 clock，讓 slave 有 scl_falling 釋放 ACK
        default: begin
          if (clk_div_cnt < P_EDGE) begin
            scl_oe <= 1;  // 前半週期拉低 SCL
          end else begin
            scl_oe <= 0;  // 後半週期釋放 SCL
          end
        end
      endcase
    end
  end


  // FSM state transition 的 always block
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      sda_oe <= 0;
      busy <= 0;
      done <= 0;
      ack_error <= 0;
      data_valid <= 0;
      data_buf <= 0;
      data_out <= 0;
      addr_buf <= 0;
      byte_count <= 0;
      bit_cnt <= 0;
      state <= IDLE;
    end else begin
      done <= 0;
      data_valid <= 0;
      case (state)
        IDLE: begin
          sda_oe <= 0;
          busy   <= 0;
          done   <= 0;
          if (start) begin
            state <= START;
            ack_error <= 0;
            busy <= 1;
          end
        end
        START: begin
          bit_cnt <= 0;
          byte_count <= 0;
          if (clk_div_cnt == HIGH_MID) begin
            sda_oe <= 1;  // 拉低 SDA 產生 start condition
            addr_buf <= {slave_addr, rw};  // 7-bit address + write bit (0)
            state <= ADDR;
          end
        end
        ADDR: begin
          case (clk_div_cnt)
            LOW_MID: sda_oe <= ~addr_buf[7-bit_cnt];  // MSB first
            HIGH_MID: begin
              if (bit_cnt == 7) begin
                ack_flag <= ADDR;
                state <= ACK;
              end
              bit_cnt <= bit_cnt + 1;
            end
            default: begin
              sda_oe <= sda_oe;
            end
          endcase
        end
        WRITE: begin
          case (clk_div_cnt)
            LOW_MID: sda_oe <= ~data_buf[7-bit_cnt];  // MSB first
            HIGH_MID: begin
              if (bit_cnt == 7) begin
                ack_flag <= WRITE;
                state <= ACK;  // 發送完 data 後進入 ACK phase
                // sda_oe 由 ACK state 的 LOW_MID 釋放，避免在 SCL HIGH 時產生假 STOP
              end
              bit_cnt <= bit_cnt + 1;
            end
            default: begin
              sda_oe <= sda_oe;
            end
          endcase
        end
        READ: begin
          case (clk_div_cnt)
            HIGH_MID: begin
              if (bit_cnt == 7) begin
                ack_flag <= READ;
                data_valid <= 1;
                data_out <= {data_buf[6:0], sda};  // 更新 data_out
                state <= ACK;  // 讀取完一個 byte 後進入 ACK phase
              end
              data_buf <= {data_buf[6:0], sda};  // MSB first
              bit_cnt  <= bit_cnt + 1;
            end
            default: begin
              data_out   <= data_out;
              data_valid <= 0;
            end
          endcase
        end
        ACK: begin
          case (clk_div_cnt)
            LOW_MID: begin
              case (ack_flag)
                ADDR, WRITE: sda_oe <= 0;  // 釋放 SDA 等待 slave 回 ACK/NACK
                READ: begin
                  if (byte_count == num_bytes - 1) begin
                    sda_oe <= 0;  // 其他情況釋放 SDA 等待 slave 回 ACK/NACK
                  end else begin
                    sda_oe <= 1;  // 最後一個 byte 讀取完後拉低 SDA 送 NACK
                  end
                end
                default: sda_oe <= sda_oe;
              endcase
            end
            HIGH_MID: begin
              case (ack_flag)
                ADDR: begin  // address phase 不更新 data_out
                  if (sda) begin
                    ack_error <= 1;  // NACK
                    state <= STOP;  // 發生 NACK 就結束 transaction
                  end else begin
                    if (rw) begin
                      state <= READ;
                    end else begin
                      data_buf <= data_in;
                      state <= WRITE;
                    end
                  end
                end
                WRITE: begin
                  if (sda) begin
                    ack_error <= 1;  // NACK
                  end
                  byte_count <= byte_count + 1;
                  if (byte_count == num_bytes - 1) begin
                    if (repeated_start) begin
                      state <= REPEATED_START;
                    end else begin
                      state <= STOP;
                    end
                  end else begin
                    data_buf <= data_in;
                    state <= WRITE;
                  end
                end
                READ: begin
                  data_valid <= 0;
                  byte_count <= byte_count + 1;
                  sda_oe <= 0;
                  if (byte_count == num_bytes - 1) begin
                    sda_oe <= 1;  // 最後一個 byte 讀取完後送 NACK
                    if (repeated_start) begin
                      state <= REPEATED_START;
                    end else begin
                      state <= STOP;
                    end
                  end else begin
                    state <= READ;
                  end
                end
                default: state <= state;
              endcase
            end
            default: begin
              sda_oe <= sda_oe;
            end
          endcase
          bit_cnt <= 0;
        end
        STOP: begin
          case (clk_div_cnt)
            LOW_MID: sda_oe <= 1;  // 拉低 SDA
            HIGH_MID: begin
              sda_oe <= 0;  // 釋放 SDA 產生 stop condition
              done   <= 1;
              state  <= IDLE;
            end
            default: begin
              sda_oe <= sda_oe;
            end
          endcase
        end
        REPEATED_START: begin
          case (clk_div_cnt)
            LOW_MID: sda_oe <= 0;  // 釋放 SDA 產生 stop condition
            HIGH_MID: begin
              sda_oe <= 1;  // 拉低 SDA 產生 start condition
              addr_buf <= {slave_addr, rw};  // 7-bit address + write bit
              bit_cnt <= 0;
              byte_count <= 0;
              state <= ADDR;
            end
            default: begin
              sda_oe <= sda_oe;
            end
          endcase
        end
        default: state <= state;
      endcase
    end
  end
endmodule
