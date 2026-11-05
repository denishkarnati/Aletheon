/* Minimal polled UART0 driver for the RP2040, written against Aletheon's generated register headers.
 *
 * Every address, offset and bit position below comes from the headers in include/gen/, which were generated from the
 * vendor CMSIS-SVD (raspberrypi/pico-sdk RP2040.svd). No register address is typed by hand.
 *
 * Evidence (see ../TRANSCRIPT.md and ../evidence.json):
 *   - register map: RP2040.svd, vendor-official, SHA-256 recorded in the ledger
 *   - baud divisor: 16-bit integer + 6-bit fraction, RP2040 datasheet p.422 (4.2.3.2.1) and p.433 (UARTIBRD/UARTFBRD)
 *   - divisor latch: "LCR_H write to latch in the divisors", RP2040 datasheet p.429
 *
 * ASSUMPTIONS (not checked by this file):
 *   - clk_peri is already running at UART0_CLK_HZ (the pico-sdk runtime sets 125 MHz before main()).
 *   - GPIO0/GPIO1 pads are left at their reset configuration (input enabled, no isolation).
 * STATUS: compiles for Cortex-M0+ with -Wall -Wextra -Werror. NOT yet run on a board: no serial capture exists for it.
 */
#include <stdint.h>

#include "gen/io_bank0_regs.h"
#include "gen/resets_regs.h"
#include "gen/uart0_regs.h"

#ifndef UART0_CLK_HZ
#define UART0_CLK_HZ 125000000u
#endif

/* Baud divisor in 1/64 units: BRD = UARTCLK / (16 * baud); FBRD = round(frac(BRD) * 64). Computed as
 * round(UARTCLK * 4 / baud) = round(64 * BRD) to stay in integer arithmetic. */
static uint32_t baud_div64(uint32_t clk_hz, uint32_t baud)
{
    return (uint32_t)(((uint64_t)clk_hz * 4u + baud / 2u) / baud);
}

int uart0_init(uint32_t baud)
{
    if (baud == 0u)
        return -1;
    uint32_t div = baud_div64(UART0_CLK_HZ, baud);
    uint32_t ibrd = div >> 6;
    uint32_t fbrd = div & UART0_UARTFBRD_BAUD_DIVFRAC_Msk;
    /* Divisor outside the 16-bit integer field cannot be programmed (p.422: 16-bit integer, 6-bit fraction). */
    if (ibrd == 0u || ibrd > (UART0_UARTIBRD_BAUD_DIVINT_Msk >> UART0_UARTIBRD_BAUD_DIVINT_Pos))
        return -1;

    /* Pulse UART0 through reset, then wait until the reset controller reports it done. */
    RESETS_RESET_REG |= RESETS_RESET_UART0_Msk;
    RESETS_RESET_REG &= ~RESETS_RESET_UART0_Msk;
    while ((RESETS_RESET_DONE_REG & RESETS_RESET_DONE_UART0_Msk) == 0u) {
    }

    /* Route GPIO0 -> UART0 TX and GPIO1 -> UART0 RX (FUNCSEL enum values from the SVD). */
    IO_BANK0_GPIO0_CTRL_REG = (IO_BANK0_GPIO0_CTRL_REG & ~IO_BANK0_GPIO0_CTRL_FUNCSEL_Msk) |
                              (IO_BANK0_GPIO0_CTRL_FUNCSEL_UART0_TX << IO_BANK0_GPIO0_CTRL_FUNCSEL_Pos);
    IO_BANK0_GPIO1_CTRL_REG = (IO_BANK0_GPIO1_CTRL_REG & ~IO_BANK0_GPIO1_CTRL_FUNCSEL_Msk) |
                              (IO_BANK0_GPIO1_CTRL_FUNCSEL_UART0_RX << IO_BANK0_GPIO1_CTRL_FUNCSEL_Pos);

    UART0_UARTIBRD_REG = (ibrd << UART0_UARTIBRD_BAUD_DIVINT_Pos) & UART0_UARTIBRD_BAUD_DIVINT_Msk;
    UART0_UARTFBRD_REG = (fbrd << UART0_UARTFBRD_BAUD_DIVFRAC_Pos) & UART0_UARTFBRD_BAUD_DIVFRAC_Msk;
    /* 8 data bits (WLEN = 0b11), 1 stop bit, no parity, FIFOs on. Written after the divisors so they latch. */
    UART0_UARTLCR_H_REG = (3u << UART0_UARTLCR_H_WLEN_Pos) | UART0_UARTLCR_H_FEN_Msk;
    UART0_UARTCR_REG = UART0_UARTCR_UARTEN_Msk | UART0_UARTCR_TXE_Msk | UART0_UARTCR_RXE_Msk;
    return 0;
}

void uart0_putc(char c)
{
    while (UART0_UARTFR_REG & UART0_UARTFR_TXFF_Msk) {
    }
    UART0_UARTDR_REG = (uint32_t)(uint8_t)c & UART0_UARTDR_DATA_Msk;
}

void uart0_puts(const char *s)
{
    while (*s)
        uart0_putc(*s++);
}

int uart0_getc_nonblocking(void)
{
    if (UART0_UARTFR_REG & UART0_UARTFR_RXFE_Msk)
        return -1;
    return (int)(UART0_UARTDR_REG & UART0_UARTDR_DATA_Msk);
}

/* Wait until the last bit has left the shift register (BUSY clears), e.g. before sleeping or changing baud. */
void uart0_flush(void)
{
    while (UART0_UARTFR_REG & UART0_UARTFR_BUSY_Msk) {
    }
}
