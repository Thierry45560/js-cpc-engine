"use strict";

/**
 * @module VirtualPrinter
 * @description Emulates the Amstrad CPC parallel printer port.
 *
 * Receives bytes from the I/O bus (port A12=0, strobe on bit 7),
 * translates CPC character codes to Unicode, and appends output lines
 * to a DOM element (`#printer-output`), or falls back to the browser console
 * if that element is absent.
 *
 * Standalone module — no dependency on any other CPC module.
 */
const VirtualPrinter = {

    /** Accumulation buffer for the current line being printed. @type {string} */
    buffer: "",

    /**
     * CPC-specific character code overrides mapped to their French equivalents.
     * The standard CPC character set deviates from ASCII above code 64.
     * @type {Object.<number, string>}
     */
    cpcToFr: {
        64: 'à', 91: '[', 92: 'ç', 93: ']', 94: '^',
        123: 'é', 124: 'ù', 125: 'è', 126: '¨'
    },

    /**
     * Returns the printer card element, or null if absent.
     * The card may not exist in all HTML templates.
     * @returns {HTMLElement|null}
     */
    _card()   { return document.getElementById('printer-card');   },

    /**
     * Returns the printer output container element, or null if absent.
     * @returns {HTMLElement|null}
     */
    _output() { return document.getElementById('printer-output'); },

    /**
     * Reads the printer status port.
     * Bit 6 of PPI Port B: 0 = printer ready (Busy=0).
     * Always returns 0 so the CPC firmware considers the printer available.
     * @param {number} _addr - Port address (unused).
     * @returns {number} Always 0.
     */
    readPort(_addr) { return 0; },

    /**
     * Renders a completed line of text to the DOM output element,
     * or logs it to the browser console if the DOM element is absent.
     * Reveals the printer card on first output.
     * Automatically scrolls to the latest line.
     * @param {string} text - Line content to display.
     */
    printLine(text) {
        const output = this._output();

        if (!output) {
            console.log(
                "%c[CPC PRINTER]: " + text,
                "background:#111;color:#0f0;border-left:3px solid #0a0;padding:2px;"
            );
            return;
        }

        const card = this._card();
        if (card && card.style.display === 'none') card.style.display = '';

        const line = document.createElement('div');
        line.className = 'printer-line';
        line.textContent = text || '\u00A0';
        output.appendChild(line);

        output.scrollTop = output.scrollHeight;
    },

    /**
     * Clears the print buffer, removes all output lines, and hides the card.
     */
    clear() {
        this.buffer = "";
        const output = this._output();
        if (output) output.innerHTML = '';
        const card = this._card();
        if (card) card.style.display = 'none';
    },

    /**
     * Receives one byte from the CPC I/O bus.
     *
     * The Amstrad firmware sends each character twice:
     *   - First pass:  bit 7 = 1 (strobe high) — data valid
     *   - Second pass: bit 7 = 0 (strobe low)  — data latched
     * Only the high-strobe pass (bit 7 = 1) is processed to avoid duplicates.
     *
     * CR (code 13) flushes the current buffer as a new printed line.
     * Codes < 32 are control characters and are silently discarded.
     * Codes ≥ 32 are translated via `cpcToFr` (if mapped) or treated as ASCII.
     *
     * Printer is selected when address bit 12 is 0.
     *
     * @param {number} addr - 16-bit port address.
     * @param {number} data - 8-bit data byte (bit 7 = strobe, bits 6:0 = character code).
     */
    writePort(addr, data) {
        if ((addr & 0x1000) === 0) {
            if (data & 0x80) {
                const charCode = data & 0x7F;
                if (charCode === 13) {
                    this.printLine(this.buffer);
                    this.buffer = "";
                } else if (charCode >= 32) {
                    this.buffer += this.cpcToFr[charCode] || String.fromCharCode(charCode);
                }
            }
        }
    }
};
