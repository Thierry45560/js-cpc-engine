"use strict";

// =============================================================================
//  Z80 CPU Core — Amstrad CPC / CPC+ / GX4000
//  ZEALL ready
//
//  Usage:
//    const cpu = new Z80_CPU(bus);
//
//  The `bus` object must implement:
//    bus.readMemory(addr)           → number (0–255)
//    bus.writeMemory(addr, val)     → void
//    bus.readIO(addr)               → number (0–255)
//    bus.executeTicks(n)            → void
//    bus.getIntStatus()             → number  (non-zero = interrupt pending)
//    bus.acknowledgeInterrupt()     → number  (bus value for IM0/IM2)
//
//  IO write timing (CPC-specific deferred OUT):
//    After exec(), the host must inspect:
//      cpu.ioWriteState  (0 = none, 1 = high-priority, 2 = low-priority)
//      cpu.ioWriteAddr
//      cpu.ioWriteVal
//    and reset cpu.ioWriteState = 0 after processing.
// =============================================================================

// -----------------------------------------------------------------------------
//  Flags LUT — S, Z, Y, X, P precomputed for all 256 values
// -----------------------------------------------------------------------------

const Z80_FLAGS_SZP_LUT = new Uint8Array([
    68, 0, 0, 4, 0, 4, 4, 0, 8, 12, 12, 8, 12, 8, 8, 12,
    0, 4, 4, 0, 4, 0, 0, 4, 12, 8, 8, 12, 8, 12, 12, 8,
    32, 36, 36, 32, 36, 32, 32, 36, 44, 40, 40, 44, 40, 44, 44, 40,
    36, 32, 32, 36, 32, 36, 36, 32, 40, 44, 44, 40, 44, 40, 40, 44,
    0, 4, 4, 0, 4, 0, 0, 4, 12, 8, 8, 12, 8, 12, 12, 8,
    4, 0, 0, 4, 0, 4, 4, 0, 8, 12, 12, 8, 12, 8, 8, 12,
    36, 32, 32, 36, 32, 36, 36, 32, 40, 44, 44, 40, 44, 40, 40, 44,
    32, 36, 36, 32, 36, 32, 32, 36, 44, 40, 40, 44, 40, 44, 44, 40,
    128, 132, 132, 128, 132, 128, 128, 132, 140, 136, 136, 140, 136, 140, 140, 136,
    132, 128, 128, 132, 128, 132, 132, 128, 136, 140, 140, 136, 140, 136, 136, 140,
    164, 160, 160, 164, 160, 164, 164, 160, 168, 172, 172, 168, 172, 168, 168, 172,
    160, 164, 164, 160, 164, 160, 160, 164, 172, 168, 168, 172, 168, 172, 172, 168,
    132, 128, 128, 132, 128, 132, 132, 128, 136, 140, 140, 136, 140, 136, 136, 140,
    128, 132, 132, 128, 132, 128, 128, 132, 140, 136, 136, 140, 136, 140, 140, 136,
    160, 164, 164, 160, 164, 160, 160, 164, 172, 168, 168, 172, 168, 172, 172, 168,
    164, 160, 160, 164, 160, 164, 164, 160, 168, 172, 172, 168, 172, 168, 168, 172
]);

// -----------------------------------------------------------------------------
//  Module-level constants — resolved at parse time, zero property-lookup cost
//  in hot paths (add8, sub8, inc8, dec8, cp8, flag updates…)
// -----------------------------------------------------------------------------

// Individual flag bit masks
const MASK_S = 128, MASK_Z = 64, MASK_Y = 32, MASK_H = 16;
const MASK_X = 8,   MASK_P = 4,  MASK_V = 4,  MASK_N = 2,  MASK_C = 1;

// Composite flag masks
const FLAG_SZXY  = MASK_S | MASK_Z | MASK_Y | MASK_X; // 232
const FLAG_SZYX  = MASK_S | MASK_Y | MASK_X;           // 168
const FLAG_SZ    = MASK_S | MASK_Z;                     // 192
const FLAG_YX    = MASK_Y | MASK_X;                     // 40
const FLAG_SZP   = MASK_S | MASK_Z | MASK_V | MASK_C;  // 197
const FLAG_SZN   = MASK_S | MASK_Z | MASK_C;            // 193
const FLAG_SZPV  = MASK_S | MASK_Z | MASK_V;            // 196
const FLAG_SZP_C = MASK_S | MASK_Z | MASK_P;            // 196

// Flag bit positions
const BIT_S = 7, BIT_Z = 6, BIT_P = 2;
const SHIFT_X = 2;

// Condition code to flag bit position [NZ/Z=Z, NC/C=C, PO/PE=P, P/M=S]
const COND_MAP = new Uint8Array([BIT_Z, 0, SHIFT_X, BIT_S]);

// Abstract reg index (0:B 1:C 2:D 3:E 4:H 5:L 6:F 7:A) to TypedArray byte offset
const R8_MAP = new Uint8Array([1, 0, 3, 2, 5, 4, 6, 7]);

// =============================================================================
//  Z80_CPU Class
// =============================================================================

class Z80_CPU {

    // -------------------------------------------------------------------------
    //  Constructor
    // -------------------------------------------------------------------------

    constructor(bus) {
        if (!bus) throw new Error("Z80_CPU: a bus object is required.");

        const required = ['readMemory', 'writeMemory', 'readIO', 'executeTicks', 'getIntStatus', 'acknowledgeInterrupt'];
        for (const fn of required) {
            if (typeof bus[fn] !== 'function')
                throw new Error(`Z80_CPU: bus.${fn} must be a function.`);
        }

        // Direct references — avoids repeated property chains in hot paths
        this._read    = bus.readMemory.bind(bus);
        this._write   = bus.writeMemory.bind(bus);
        this._readIO  = bus.readIO.bind(bus);
        this._ticks   = bus.executeTicks.bind(bus);
        this._intStat = bus.getIntStatus.bind(bus);
        this._ackInt  = bus.acknowledgeInterrupt.bind(bus);

        // TypedArray registers — shared ArrayBuffer enables free 8/16-bit aliasing
        // Layout: [C, B, E, D, L, H, F, A] -> r16[0]=BC r16[1]=DE r16[2]=HL r16[3]=AF
        this.regBuffer = new ArrayBuffer(8);
        this.r8  = new Uint8Array(this.regBuffer);
        this.r16 = new Uint16Array(this.regBuffer);

        this.altBuffer = new ArrayBuffer(8);
        this.alt8  = new Uint8Array(this.altBuffer);
        this.alt16 = new Uint16Array(this.altBuffer);

        // 16-bit standalone registers
        this.idxRegs = new Uint16Array([0xFFFF, 0xFFFF]); // [0]=IX [1]=IY
        this.activeIdx = 0;
        this.regPC = 0;
        this.regSP = 0xFFFF;
        this.regWZ = 0;

        // 8-bit standalone registers
        this.regI = 0; this.regR = 0; this.regIM = 0;

        // CPU state
        this.iff1 = 0; this.iff2 = 0;
        this.interruptPending = false;
        this.isHalted   = false;
        this.isPrefix   = true;
        this.isPrefixCB = false;
        this.irqVector  = 0;

        // Deferred IO write — host reads after exec() then resets ioWriteState = 0
        this.ioWriteState = 0; this.ioWriteAddr = 0; this.ioWriteVal = 0;

        // Opcode jump tables
        this.opcodes       = new Array(256);
        this.opcodesCB     = new Array(256);
        this.opcodesED     = new Array(256);
        this.opcodesDDFD   = new Array(256);
        this.opcodesDDFDCB = new Array(256);

        this.initTables();
        this.reset();
    }

    // -------------------------------------------------------------------------
    //  State
    // -------------------------------------------------------------------------

    getState() {
        return {
            A: this.r8[7], F: this.r8[6], B: this.r8[1], C: this.r8[0],
            D: this.r8[3], E: this.r8[2], H: this.r8[5], L: this.r8[4],
            AF: this.r16[3], BC: this.r16[0], DE: this.r16[1], HL: this.r16[2],
            AF_alt: this.alt16[3], BC_alt: this.alt16[0], DE_alt: this.alt16[1], HL_alt: this.alt16[2],
            IX: this.idxRegs[0], IY: this.idxRegs[1],
            SP: this.regSP, PC: this.regPC, WZ: this.regWZ,
            I: this.regI, R: this.regR, IM: this.regIM,
            iff1: this.iff1, iff2: this.iff2, halted: this.isHalted
        };
    }

    reset() {
        this.regR = this.regI = this.regIM = this.iff2 = this.iff1 = this.regPC = 0;
        this.idxRegs[0] = this.idxRegs[1] = 0xFFFF;
        this.activeIdx = 0; this.regWZ = 0;
        this.isHalted = this.interruptPending = false;
        this.isPrefix = true; this.isPrefixCB = false;
        this.ioWriteState = 0;
    }

    // -------------------------------------------------------------------------
    //  Main execution entry point
    // -------------------------------------------------------------------------

    exec() {
        let opcode;
        if (this.isPrefixCB) {
            opcode = this.fetchOpcode(); this.isPrefixCB = false; this.opcodes[opcode]();
        } else if (this.interruptPending) {
            opcode = this.fetchOpcode(); this.iff2 = this.iff1 = 1; this.interruptPending = false; this.opcodes[opcode]();
        } else if (this._intStat() !== 0 && this.iff1) {
            if (this.isPrefix) this._ticks(1);
            this.handleInterrupt();
        } else {
            opcode = this.fetchOpcode(); this.opcodes[opcode]();
        }
        this.isPrefix = true;
    }

    doNMI() { this.iff1 = 0; this.incR(); this.op_NMI(); }

    handleInterrupt() {
        this.iff2 = this.iff1 = 0;
        const busVal = this._ackInt();
        this.incR();
        switch (this.regIM) {
            case 0: this.opcodes[busVal](); break;
            case 1: this.opcodes[0xFF](); break;
            case 2: this.irqVector = (this.regI << 8) | busVal; this.op_IM2(); break;
        }
    }

    // -------------------------------------------------------------------------
    //  Fetch
    // -------------------------------------------------------------------------

    fetchOpcode() {
        const val = this._read(this.regPC);
        this.regPC = (this.regPC + 1) & 0xFFFF;
        this.regR = (this.regR & 128) | ((this.regR + 1) & 127);
        return val;
    }

    fetchByte() {
        const val = this._read(this.regPC);
        this.regPC = (this.regPC + 1) & 0xFFFF;
        return val;
    }

    fetchOffset() {
        const val = this._read(this.regPC);
        this.regPC = (this.regPC + 1) & 0xFFFF;
        return (val & 0x80) === 0 ? val : val - 256;
    }

    // -------------------------------------------------------------------------
    //  Deferred IO (CPC OUT timing)
    // -------------------------------------------------------------------------

    ioWriteHigh(addr, val) { this.ioWriteState = 1; this.ioWriteAddr = addr; this.ioWriteVal = val; }
    ioWriteLow (addr, val) { this.ioWriteState = 2; this.ioWriteAddr = addr; this.ioWriteVal = val; }

    // -------------------------------------------------------------------------
    //  Stack
    // -------------------------------------------------------------------------

    pushWord(val) {
        this.regSP = (this.regSP - 1) & 0xFFFF; this._write(this.regSP, val >>> 8);
        this._ticks(1);
        this.regSP = (this.regSP - 1) & 0xFFFF; this._write(this.regSP, val & 0xFF);
    }

    popWord() {
        const lo = this._read(this.regSP); this.regSP = (this.regSP + 1) & 0xFFFF;
        const hi = this._read(this.regSP); this.regSP = (this.regSP + 1) & 0xFFFF;
        return (hi << 8) | lo;
    }

    // -------------------------------------------------------------------------
    //  Register pairs
    // -------------------------------------------------------------------------

    getPair(p, useAF = false) {
        if (p === 3) return useAF ? this.r16[3] : this.regSP;
        return this.r16[p];
    }

    setPair(p, val, useAF = false) {
        if (p === 3) { if (useAF) this.r16[3] = val; else this.regSP = val; }
        else this.r16[p] = val;
    }

    getPairIdx(p) {
        if (p === 2) return this.idxRegs[this.activeIdx];
        if (p === 3) return this.regSP;
        return this.r16[p];
    }

    // -------------------------------------------------------------------------
    //  ALU — hot paths, module-level constants used directly (no this. lookup)
    // -------------------------------------------------------------------------

    add8(operand, carryIn) {
        const a = this.r8[7], res = a + operand + carryIn;
        const hc = ((a & 15) + (operand & 15) + carryIn) & MASK_H;
        const ov = (((a & 128) === (operand & 128)) && ((a & 128) !== (res & 128))) ? MASK_V : 0;
        this.r8[7] = res;
        this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[7]] & FLAG_SZXY) | ((res >>> 8) & 1) | hc | ov;
    }

    sub8(operand, borrowIn) {
        const a = this.r8[7], res = a - operand - borrowIn;
        const hc = ((a & 15) - (operand & 15) - borrowIn) & MASK_H;
        const ov = (((a & 128) !== (operand & 128)) && ((a & 128) !== (res & 128))) ? MASK_V : 0;
        this.r8[7] = res;
        this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[7]] & FLAG_SZXY) | ((res >>> 8) & 1) | hc | ov | MASK_N;
    }

    inc8(val) {
        const hc = ((val & 15) + 1) & MASK_H, ov = (val === 127) ? MASK_V : 0, res = (val + 1) & 0xFF;
        this.r8[6] = (Z80_FLAGS_SZP_LUT[res] & FLAG_SZXY) | hc | ov | (this.r8[6] & MASK_C);
        return res;
    }

    dec8(val) {
        const hc = ((val & 15) - 1) & MASK_H, ov = (val === 128) ? MASK_V : 0, res = (val - 1) & 0xFF;
        this.r8[6] = (Z80_FLAGS_SZP_LUT[res] & FLAG_SZXY) | hc | ov | MASK_N | (this.r8[6] & MASK_C);
        return res;
    }

    and8(operand) { this.r8[7] &= operand; this.r8[6] = Z80_FLAGS_SZP_LUT[this.r8[7]] | MASK_H; }
    or8 (operand) { this.r8[7] |= operand; this.r8[6] = Z80_FLAGS_SZP_LUT[this.r8[7]]; }
    xor8(operand) { this.r8[7] ^= operand; this.r8[6] = Z80_FLAGS_SZP_LUT[this.r8[7]]; }

    cp8(operand) {
        const a = this.r8[7], res = a - operand, c = (res >>> 8) & 1, res8 = res & 0xFF;
        const hc = ((a & 15) - (operand & 15)) & MASK_H;
        const ov = (((a & 128) !== (operand & 128)) && ((a & 128) !== (res8 & 128))) ? MASK_V : 0;
        this.r8[6] = (Z80_FLAGS_SZP_LUT[res8] & FLAG_SZ) | (operand & FLAG_YX) | c | hc | ov | MASK_N;
    }

    // -------------------------------------------------------------------------
    //  Block instructions
    // -------------------------------------------------------------------------

    doBlockTransfer(step) {
        const bc = (this.r16[0] - 1) & 0xFFFF; this.r16[0] = bc;
        const hl = this.r16[2], val = this._read(hl), de = this.r16[1];
        this._write(de, val);
        this.r16[1] = (de + step) & 0xFFFF; this.r16[2] = (hl + step) & 0xFFFF;
        const n = this.r8[7] + val;
        this.r8[6] = (this.r8[6] & FLAG_SZN) | ((bc !== 0) ? MASK_P : 0) | ((n & 2) << 4) | (n & MASK_X);
    }

    doBlockCompare(step) {
        this.regWZ = (this.regWZ + step) & 0xFFFF;
        const bc = (this.r16[0] - 1) & 0xFFFF; this.r16[0] = bc;
        const hl = this.r16[2], val = this._read(hl);
        this.r16[2] = (hl + step) & 0xFFFF;
        const res = (this.r8[7] - val) & 0xFF;
        const hc = ((this.r8[7] & 15) - (val & 15)) & MASK_H;
        const n  = (res - (hc >> 4)) & 0xFF;
        this.r8[6] = (Z80_FLAGS_SZP_LUT[res] & FLAG_SZ) | hc | ((bc !== 0) ? MASK_P : 0) | ((n & 2) << 4) | (n & MASK_X) | MASK_N | (this.r8[6] & MASK_C);
    }

    repeatBlock() {
        if (this.r16[0] !== 0) { this._ticks(1); this.regPC = (this.regPC - 2) & 0xFFFF; this.regWZ = (this.regPC + 1) & 0xFFFF; }
    }

    repeatCompare() {
        if (this.r16[0] !== 0 && (this.r8[6] & MASK_Z) === 0) {
            this._ticks(2); this.isPrefix = false;
            this.regPC = (this.regPC - 2) & 0xFFFF; this.regWZ = (this.regPC + 1) & 0xFFFF;
        }
    }

    repeatIO() {
        if (this.r8[1] !== 0) { this._ticks(1); this.regPC = (this.regPC - 2) & 0xFFFF; }
    }

    // -------------------------------------------------------------------------
    //  Bit rotations
    // -------------------------------------------------------------------------

    op_RLC_helper(val) { const c = val >>> 7;  const r = ((val << 1) & 0xFF) | c;       this.r8[6] = Z80_FLAGS_SZP_LUT[r] | c;       return r; }
    op_RRC_helper(val) { const c = val & 1;    const r = (val >>> 1) | (c << 7);        this.r8[6] = Z80_FLAGS_SZP_LUT[r] | c;       return r; }
    op_RL_helper (val) { const r = ((val << 1) & 0xFF) | (this.r8[6] & MASK_C);        this.r8[6] = Z80_FLAGS_SZP_LUT[r] | (val >>> 7); return r; }
    op_RR_helper (val) { const r = (val >>> 1) | ((this.r8[6] & MASK_C) << 7);         this.r8[6] = Z80_FLAGS_SZP_LUT[r] | (val & 1);   return r; }
    op_SLA_helper(val) { const r = (val << 1) & 0xFF;                                   this.r8[6] = Z80_FLAGS_SZP_LUT[r] | (val >>> 7); return r; }
    op_SRA_helper(val) { const r = (val & 128) | (val >> 1);                            this.r8[6] = Z80_FLAGS_SZP_LUT[r] | (val & 1);   return r; }
    op_SLL_helper(val) { const r = ((val << 1) & 0xFF) | 1;                             this.r8[6] = Z80_FLAGS_SZP_LUT[r] | (val >>> 7); return r; }
    op_SRL_helper(val) { const r = val >>> 1;                                            this.r8[6] = Z80_FLAGS_SZP_LUT[r] | (val & 1);   return r; }

    incR() {
        this.regR = ((this.regR + 1) & 127) | (this.regR & 128);
        if (this.isHalted) { this.isHalted = false; this.regPC = (this.regPC + 1) & 0xFFFF; }
    }

    // -------------------------------------------------------------------------
    //  Instructions
    // -------------------------------------------------------------------------

    op_NOP()  { this._ticks(1); }
    op_HALT() { this._ticks(1); this.isHalted = true; this.regPC = (this.regPC - 1) & 0xFFFF; }
    op_DI()   { this._ticks(1); this.iff1 = 0; this.iff2 = 0; this.interruptPending = false; }
    op_EI()   { this._ticks(1); this.interruptPending = true; }

    op_NMI() { this._ticks(2); this.pushWord(this.regPC); this.regPC = 0x0066; }

    op_IM2() {
        this._ticks(5); this.pushWord(this.regPC);
        const lo = this._read(this.irqVector), hi = this._read((this.irqVector + 1) & 0xFFFF);
        this.regPC = (hi << 8) | lo;
    }

    op_LD_r_r(dest, src) { this._ticks(1); this.r8[R8_MAP[dest]] = this.r8[R8_MAP[src]]; }

    op_LD_r_n(reg) { const v = this.fetchByte(); this._ticks(2); this.r8[R8_MAP[reg]] = v; }

    op_LD_r_HL(reg) { this._ticks(2); this.r8[R8_MAP[reg]] = this._read(this.r16[2]); }
    op_LD_HL_r(reg) { this._ticks(2); this._write(this.r16[2], this.r8[R8_MAP[reg]]); }

    op_LD_HL_n() { const v = this.fetchByte(); this._ticks(3); this._write(this.r16[2], v); }

    op_LD_A_BC() { this._ticks(2); this.regWZ = (this.r16[0] + 1) & 0xFFFF; this.r8[7] = this._read(this.r16[0]); }
    op_LD_A_DE() { this._ticks(2); this.regWZ = (this.r16[1] + 1) & 0xFFFF; this.r8[7] = this._read(this.r16[1]); }

    op_LD_A_nn() {
        const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo;
        this._ticks(4); this.r8[7] = this._read(addr); this.regWZ = (addr + 1) & 0xFFFF;
    }

    op_LD_BC_A() { this._ticks(2); this.regWZ = (this.r8[7] << 8) | ((this.r16[0] + 1) & 0xFF); this._write(this.r16[0], this.r8[7]); }
    op_LD_DE_A() { this._ticks(2); this.regWZ = (this.r8[7] << 8) | ((this.r16[1] + 1) & 0xFF); this._write(this.r16[1], this.r8[7]); }

    op_LD_nn_A() {
        const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo;
        this._ticks(4); this._write(addr, this.r8[7]); this.regWZ = (this.r8[7] << 8) | ((addr + 1) & 0xFF);
    }

    op_LD_dd_nn(pair) {
        const lo = this.fetchByte(), hi = this.fetchByte();
        this._ticks(3); this.setPair(pair, (hi << 8) | lo, false);
    }

    op_LD_HL_nn() {
        const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo;
        this._ticks(5); this.r8[4] = this._read(addr); this.regWZ = (addr + 1) & 0xFFFF; this.r8[5] = this._read(this.regWZ);
    }

    op_LD_nn_HL() {
        const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo;
        this._ticks(4); this._write(addr, this.r8[4]);
        this._ticks(1); this.regWZ = (addr + 1) & 0xFFFF; this._write(this.regWZ, this.r8[5]);
    }

    op_LD_SP_HL() { this._ticks(2); this.isPrefix = false; this.regSP = this.r16[2]; }

    op_PUSH_qq(pair) { this._ticks(3); this.pushWord(this.getPair(pair, true)); }
    op_POP_qq (pair) { this._ticks(3); this.setPair(pair, this.popWord(), true); }

    op_EX_DE_HL() { this._ticks(1); const t = this.r16[1]; this.r16[1] = this.r16[2]; this.r16[2] = t; }
    op_EX_AF_AF() { this._ticks(1); const t = this.r16[3]; this.r16[3] = this.alt16[3]; this.alt16[3] = t; }

    op_EXX() {
        this._ticks(1);
        const t0 = this.r16[0], t1 = this.r16[1], t2 = this.r16[2];
        this.r16[0] = this.alt16[0]; this.r16[1] = this.alt16[1]; this.r16[2] = this.alt16[2];
        this.alt16[0] = t0; this.alt16[1] = t1; this.alt16[2] = t2;
    }

    op_EX_SP_HL() {
        this._ticks(5); this.isPrefix = false;
        const l = this.r8[4]; this.r8[4] = this._read(this.regSP); this._write(this.regSP, l);
        this._ticks(1);
        const h = this.r8[5]; this.r8[5] = this._read((this.regSP + 1) & 0xFFFF); this._write((this.regSP + 1) & 0xFFFF, h);
        this.regWZ = this.r16[2];
    }

    op_INC_r(reg) { this._ticks(1); this.r8[R8_MAP[reg]] = this.inc8(this.r8[R8_MAP[reg]]); }
    op_DEC_r(reg) { this._ticks(1); this.r8[R8_MAP[reg]] = this.dec8(this.r8[R8_MAP[reg]]); }
    op_INC_HL()   { this._ticks(3); this._write(this.r16[2], this.inc8(this._read(this.r16[2]))); }
    op_DEC_HL()   { this._ticks(3); this._write(this.r16[2], this.dec8(this._read(this.r16[2]))); }

    op_ADD_A_r(reg) { this._ticks(1); this.add8(this.r8[R8_MAP[reg]], 0); }
    op_ADD_A_n()    { const v = this.fetchByte(); this._ticks(2); this.add8(v, 0); }
    op_ADD_A_HL()   { this._ticks(2); this.add8(this._read(this.r16[2]), 0); }

    op_ADC_A_r(reg) { this._ticks(1); this.add8(this.r8[R8_MAP[reg]], this.r8[6] & 1); }
    op_ADC_A_n()    { const v = this.fetchByte(); this._ticks(2); this.add8(v, this.r8[6] & 1); }
    op_ADC_A_HL()   { this._ticks(2); this.add8(this._read(this.r16[2]), this.r8[6] & 1); }

    op_SUB_r(reg) { this._ticks(1); this.sub8(this.r8[R8_MAP[reg]], 0); }
    op_SUB_n()    { const v = this.fetchByte(); this._ticks(2); this.sub8(v, 0); }
    op_SUB_HL()   { this._ticks(2); this.sub8(this._read(this.r16[2]), 0); }

    op_SBC_A_r(reg) { this._ticks(1); this.sub8(this.r8[R8_MAP[reg]], this.r8[6] & 1); }
    op_SBC_A_n()    { const v = this.fetchByte(); this._ticks(2); this.sub8(v, this.r8[6] & 1); }
    op_SBC_A_HL()   { this._ticks(2); this.sub8(this._read(this.r16[2]), this.r8[6] & 1); }

    op_AND_r(reg) { this._ticks(1); this.and8(this.r8[R8_MAP[reg]]); }
    op_AND_n()    { const v = this.fetchByte(); this._ticks(2); this.and8(v); }
    op_AND_HL()   { this._ticks(2); this.and8(this._read(this.r16[2])); }

    op_OR_r(reg) { this._ticks(1); this.or8(this.r8[R8_MAP[reg]]); }
    op_OR_n()    { const v = this.fetchByte(); this._ticks(2); this.or8(v); }
    op_OR_HL()   { this._ticks(2); this.or8(this._read(this.r16[2])); }

    op_XOR_r(reg) { this._ticks(1); this.xor8(this.r8[R8_MAP[reg]]); }
    op_XOR_n()    { const v = this.fetchByte(); this._ticks(2); this.xor8(v); }
    op_XOR_HL()   { this._ticks(2); this.xor8(this._read(this.r16[2])); }

    op_CP_r(reg) { this._ticks(1); this.cp8(this.r8[R8_MAP[reg]]); }
    op_CP_n()    { const v = this.fetchByte(); this._ticks(2); this.cp8(v); }
    op_CP_HL()   { this._ticks(2); this.cp8(this._read(this.r16[2])); }

    op_DAA() {
		this._ticks(1);
		const aBefore = this.r8[7];
		const fBefore = this.r8[6];
		let correction = 0;
		let carry = fBefore & MASK_C;
		const halfCarry = fBefore & MASK_H;
		const nFlag = fBefore & MASK_N;
		if (halfCarry || (aBefore & 0x0F) > 9) {
			correction |= 0x06;
		}
		if (carry || aBefore > 0x99) {
			correction |= 0x60;
			carry = MASK_C; // Le carry devient/reste 1
		}

		if (nFlag) {
			this.r8[7] = (aBefore - correction) & 0xFF;
		} else {
			this.r8[7] = (aBefore + correction) & 0xFF;
		}
		const newH = (aBefore ^ this.r8[7]) & MASK_H;
		this.r8[6] = Z80_FLAGS_SZP_LUT[this.r8[7]] | nFlag | newH | carry;
	}

    op_CPL() {
        this._ticks(1); this.r8[7] = (~this.r8[7]) & 0xFF;
        this.r8[6] = (this.r8[6] & FLAG_SZP) | (this.r8[7] & FLAG_YX) | MASK_H | MASK_N;
    }

    op_CCF() {
        this._ticks(1);
        this.r8[6] = (this.r8[6] & FLAG_SZPV) | ((this.r8[6] & MASK_C) << 4) | (this.r8[7] & FLAG_YX) | ((~(this.r8[6] & MASK_C)) & 1);
    }

    op_SCF() {
        this._ticks(1);
        this.r8[6] = (this.r8[6] & FLAG_SZPV) | (this.r8[7] & FLAG_YX) | MASK_C;
    }

    op_ADD_HL_ss(pair) {
        this._ticks(3);
        const hl = this.r16[2]; this.regWZ = (hl + 1) & 0xFFFF;
        const ss = this.getPair(pair, false);
        const hc = (((hl & 4095) + (ss & 4095)) >>> 8) & MASK_H;
        const res = hl + ss; this.r16[2] = res;
        this.r8[6] = (this.r8[6] & FLAG_SZP_C) | (this.r8[5] & FLAG_YX) | hc | (res >>> 16);
    }

    op_INC_ss(pair) { this._ticks(2); this.isPrefix = false; this.setPair(pair, (this.getPair(pair, false) + 1) & 0xFFFF, false); }
    op_DEC_ss(pair) { this._ticks(2); this.isPrefix = false; this.setPair(pair, (this.getPair(pair, false) - 1) & 0xFFFF, false); }

    op_RLCA() { this._ticks(1); const c = this.r8[7] >>> 7; this.r8[7] = ((this.r8[7] << 1) & 0xFF) | c; this.r8[6] = (this.r8[6] & FLAG_SZP_C) | (this.r8[7] & FLAG_YX) | c; }
    op_RLA()  { this._ticks(1); const c = this.r8[7] >>> 7; this.r8[7] = ((this.r8[7] << 1) & 0xFF) | (this.r8[6] & MASK_C); this.r8[6] = (this.r8[6] & FLAG_SZP_C) | (this.r8[7] & FLAG_YX) | c; }
    op_RRCA() { this._ticks(1); const c = this.r8[7] & 1;   this.r8[7] = (this.r8[7] >>> 1) | (c << 7); this.r8[6] = (this.r8[6] & FLAG_SZP_C) | (this.r8[7] & FLAG_YX) | c; }
    op_RRA()  { this._ticks(1); const c = this.r8[7] & 1;   this.r8[7] = (this.r8[7] >>> 1) | ((this.r8[6] & MASK_C) << 7); this.r8[6] = (this.r8[6] & FLAG_SZP_C) | (this.r8[7] & FLAG_YX) | c; }

    op_JP_nn() { const lo = this.fetchByte(), hi = this.fetchByte(); this._ticks(3); this.regWZ = this.regPC = (hi << 8) | lo; }

    op_JP_cc_nn(cc) {
        const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo;
        this._ticks(3); this.regWZ = addr;
        if (((this.r8[6] >>> COND_MAP[cc >> 1]) & 1) === (cc & 1)) this.regPC = addr;
    }

    op_JR_e()   { const o = this.fetchOffset(); this._ticks(3); this.regWZ = this.regPC = (this.regPC + o) & 0xFFFF; }
    op_JR_C_e() { const o = this.fetchOffset(); this._ticks(2); if  (this.r8[6] & MASK_C) { this._ticks(1); this.regWZ = this.regPC = (this.regPC + o) & 0xFFFF; } }
    op_JR_NC_e(){ const o = this.fetchOffset(); this._ticks(2); if (!(this.r8[6] & MASK_C)) { this._ticks(1); this.regWZ = this.regPC = (this.regPC + o) & 0xFFFF; } }
    op_JR_Z_e() { const o = this.fetchOffset(); this._ticks(2); if  (this.r8[6] & MASK_Z) { this._ticks(1); this.regWZ = this.regPC = (this.regPC + o) & 0xFFFF; } }
    op_JR_NZ_e(){ const o = this.fetchOffset(); this._ticks(2); if (!(this.r8[6] & MASK_Z)) { this._ticks(1); this.regWZ = this.regPC = (this.regPC + o) & 0xFFFF; } }

    op_DJNZ_e() {
        const o = this.fetchOffset(); this._ticks(3);
        this.r8[1] = (this.r8[1] - 1) & 0xFF;
        if (this.r8[1] !== 0) { this._ticks(1); this.regWZ = this.regPC = (this.regPC + o) & 0xFFFF; }
    }

    op_CALL_nn() {
        const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo;
        this._ticks(4); this.pushWord(this.regPC); this.regWZ = this.regPC = addr;
    }

    op_CALL_cc_nn(cc) {
        const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo;
        this._ticks(3); this.regWZ = addr;
        if (((this.r8[6] >>> COND_MAP[cc >> 1]) & 1) === (cc & 1)) {
            this._ticks(1); this.pushWord(this.regPC); this.regPC = addr;
        }
    }

    op_RET() { this._ticks(3); this.regWZ = this.regPC = this.popWord(); }

    op_RET_cc(cc) {
        this._ticks(2);
        if (((this.r8[6] >>> COND_MAP[cc >> 1]) & 1) === (cc & 1)) {
            this._ticks(2); this.regWZ = this.regPC = this.popWord();
        } else { this.isPrefix = false; }
    }

    op_RST_p(addr) { this._ticks(3); this.pushWord(this.regPC); this.regWZ = this.regPC = addr; }
    op_JP_HL()     { this._ticks(1); this.regPC = this.r16[2]; }

    op_IN_A_n() {
        const port = this.fetchByte(); this._ticks(3);
        const addr = (this.r8[7] << 8) | port;
        this.regWZ = (addr + 1) & 0xFFFF; this.r8[7] = this._readIO(addr);
    }

    op_OUT_n_A() {
        const port = this.fetchByte(); this._ticks(2);
        const addr = (this.r8[7] << 8) | port;
        this.regWZ = (addr + 1) & 0xFFFF; this.ioWriteHigh(addr, this.r8[7]); this._ticks(1);
    }

    // -------------------------------------------------------------------------
    //  Prefix decoders
    // -------------------------------------------------------------------------

    decodeCB() { const op = this.fetchOpcode(); this.opcodesCB[op](); }
    decodeED() { const op = this.fetchOpcode(); this.opcodesED[op](); }

    decodeDDFD(prefix) {
        this.activeIdx = (prefix === 0xDD) ? 0 : 1;
        const savedPC = this.regPC, savedR = this.regR;
        const op = this.fetchOpcode(), func = this.opcodesDDFD[op];
        if (func) {
            func();
        } else {
            // Unrecognised DD/FD opcode: discard prefix, treat opcode as base (documented Z80 behaviour)
            this.regPC = savedPC; this.regR = savedR;
            this._ticks(1); this.isPrefixCB = true;
        }
    }

    decodeDDFDCB() {
        const offset = this.fetchOffset(), op = this.fetchByte(), func = this.opcodesDDFDCB[op];
        if (func) func(offset);
        else throw new Error(`Z80: Unknown DDFDCB opcode 0x${op.toString(16).padStart(2, '0')}`);
    }

    // -------------------------------------------------------------------------
    //  Opcode table builder
    // -------------------------------------------------------------------------

    initTables() {
        // Error stubs
        for (let i = 0; i < 256; i++) {
            this.opcodes[i]       = () => { throw new Error(`Z80: Unknown base opcode 0x${i.toString(16).padStart(2, '0')}`); };
            this.opcodesCB[i]     = () => { throw new Error(`Z80: Unknown CB opcode 0x${i.toString(16).padStart(2, '0')}`); };
            this.opcodesED[i]     = () => { throw new Error(`Z80: Unknown ED opcode 0x${i.toString(16).padStart(2, '0')}`); };
            this.opcodesDDFDCB[i] = () => { throw new Error(`Z80: Unknown DDFDCB opcode 0x${i.toString(16).padStart(2, '0')}`); };
        }

        // ---- BASE OPCODES ----
        // Zero-param: .bind(this) → single call frame instead of double-wrapping lambda
        this.opcodes[0x00] = this.op_NOP.bind(this);
        this.opcodes[0x08] = this.op_EX_AF_AF.bind(this);
        this.opcodes[0x10] = this.op_DJNZ_e.bind(this);
        this.opcodes[0x18] = this.op_JR_e.bind(this);
        this.opcodes[0x20] = this.op_JR_NZ_e.bind(this);
        this.opcodes[0x28] = this.op_JR_Z_e.bind(this);
        this.opcodes[0x30] = this.op_JR_NC_e.bind(this);
        this.opcodes[0x38] = this.op_JR_C_e.bind(this);

        for (let p = 0; p < 4; p++) {
            this.opcodes[0x01 | (p << 4)] = () => this.op_LD_dd_nn(p);
            this.opcodes[0x03 | (p << 4)] = () => this.op_INC_ss(p);
            this.opcodes[0x09 | (p << 4)] = () => this.op_ADD_HL_ss(p);
            this.opcodes[0x0B | (p << 4)] = () => this.op_DEC_ss(p);
            this.opcodes[0xC1 | (p << 4)] = () => this.op_POP_qq(p);
            this.opcodes[0xC5 | (p << 4)] = () => this.op_PUSH_qq(p);
        }

        for (let r = 0; r < 8; r++) {
            if (r === 6) {
                this.opcodes[0x34] = this.op_INC_HL.bind(this);
                this.opcodes[0x35] = this.op_DEC_HL.bind(this);
                this.opcodes[0x36] = this.op_LD_HL_n.bind(this);
            } else {
                this.opcodes[0x04 | (r << 3)] = () => this.op_INC_r(r);
                this.opcodes[0x05 | (r << 3)] = () => this.op_DEC_r(r);
                this.opcodes[0x06 | (r << 3)] = () => this.op_LD_r_n(r);
            }
        }

        for (let dest = 0; dest < 8; dest++) {
            for (let src = 0; src < 8; src++) {
                const op = 0x40 | (dest << 3) | src;
                if (dest === 6 && src === 6) this.opcodes[op] = this.op_HALT.bind(this);
                else if (dest === 6)         this.opcodes[op] = () => this.op_LD_HL_r(src);
                else if (src === 6)          this.opcodes[op] = () => this.op_LD_r_HL(dest);
                else                         this.opcodes[op] = () => this.op_LD_r_r(dest, src);
            }
        }

        const aluOps = [
            (s) => this.op_ADD_A_r(s), (s) => this.op_ADC_A_r(s),
            (s) => this.op_SUB_r(s),   (s) => this.op_SBC_A_r(s),
            (s) => this.op_AND_r(s),   (s) => this.op_XOR_r(s),
            (s) => this.op_OR_r(s),    (s) => this.op_CP_r(s)
        ];
        const aluHL = [
            this.op_ADD_A_HL.bind(this), this.op_ADC_A_HL.bind(this),
            this.op_SUB_HL.bind(this),   this.op_SBC_A_HL.bind(this),
            this.op_AND_HL.bind(this),   this.op_XOR_HL.bind(this),
            this.op_OR_HL.bind(this),    this.op_CP_HL.bind(this)
        ];
        for (let type = 0; type < 8; type++) {
            for (let src = 0; src < 8; src++) {
                const op = 0x80 | (type << 3) | src;
                this.opcodes[op] = (src === 6) ? aluHL[type] : () => aluOps[type](src);
            }
        }

        for (let cc = 0; cc < 8; cc++) {
            this.opcodes[0xC0 | (cc << 3)] = () => this.op_RET_cc(cc);
            this.opcodes[0xC2 | (cc << 3)] = () => this.op_JP_cc_nn(cc);
            this.opcodes[0xC4 | (cc << 3)] = () => this.op_CALL_cc_nn(cc);
            this.opcodes[0xC7 | (cc << 3)] = () => this.op_RST_p(cc << 3);
        }

        this.opcodes[0x02] = this.op_LD_BC_A.bind(this);  this.opcodes[0x0A] = this.op_LD_A_BC.bind(this);
        this.opcodes[0x12] = this.op_LD_DE_A.bind(this);  this.opcodes[0x1A] = this.op_LD_A_DE.bind(this);
        this.opcodes[0x22] = this.op_LD_nn_HL.bind(this); this.opcodes[0x2A] = this.op_LD_HL_nn.bind(this);
        this.opcodes[0x32] = this.op_LD_nn_A.bind(this);  this.opcodes[0x3A] = this.op_LD_A_nn.bind(this);

        this.opcodes[0x07] = this.op_RLCA.bind(this); this.opcodes[0x0F] = this.op_RRCA.bind(this);
        this.opcodes[0x17] = this.op_RLA.bind(this);  this.opcodes[0x1F] = this.op_RRA.bind(this);
        this.opcodes[0x27] = this.op_DAA.bind(this);  this.opcodes[0x2F] = this.op_CPL.bind(this);
        this.opcodes[0x37] = this.op_SCF.bind(this);  this.opcodes[0x3F] = this.op_CCF.bind(this);

        this.opcodes[0xC3] = this.op_JP_nn.bind(this);    this.opcodes[0xCD] = this.op_CALL_nn.bind(this);
        this.opcodes[0xC9] = this.op_RET.bind(this);      this.opcodes[0xE9] = this.op_JP_HL.bind(this);
        this.opcodes[0xC6] = this.op_ADD_A_n.bind(this);  this.opcodes[0xCE] = this.op_ADC_A_n.bind(this);
        this.opcodes[0xD6] = this.op_SUB_n.bind(this);    this.opcodes[0xDE] = this.op_SBC_A_n.bind(this);
        this.opcodes[0xE6] = this.op_AND_n.bind(this);    this.opcodes[0xEE] = this.op_XOR_n.bind(this);
        this.opcodes[0xF6] = this.op_OR_n.bind(this);     this.opcodes[0xFE] = this.op_CP_n.bind(this);

        this.opcodes[0xD3] = this.op_OUT_n_A.bind(this);  this.opcodes[0xDB] = this.op_IN_A_n.bind(this);
        this.opcodes[0xD9] = this.op_EXX.bind(this);      this.opcodes[0xEB] = this.op_EX_DE_HL.bind(this);
        this.opcodes[0xE3] = this.op_EX_SP_HL.bind(this); this.opcodes[0xF9] = this.op_LD_SP_HL.bind(this);
        this.opcodes[0xF3] = this.op_DI.bind(this);       this.opcodes[0xFB] = this.op_EI.bind(this);

        this.opcodes[0xCB] = this.decodeCB.bind(this);
        this.opcodes[0xED] = this.decodeED.bind(this);
        this.opcodes[0xDD] = () => this.decodeDDFD(0xDD);
        this.opcodes[0xFD] = () => this.decodeDDFD(0xFD);

        // ---- CB OPCODES ----
        const cbRots = [
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_RLC_helper(this.r8[R8_MAP[s]]); },
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_RRC_helper(this.r8[R8_MAP[s]]); },
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_RL_helper (this.r8[R8_MAP[s]]); },
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_RR_helper (this.r8[R8_MAP[s]]); },
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_SLA_helper(this.r8[R8_MAP[s]]); },
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_SRA_helper(this.r8[R8_MAP[s]]); },
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_SLL_helper(this.r8[R8_MAP[s]]); },
            (s) => { this._ticks(2); this.r8[R8_MAP[s]] = this.op_SRL_helper(this.r8[R8_MAP[s]]); }
        ];
        const cbRotsHL = [
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_RLC_helper(m)); },
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_RRC_helper(m)); },
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_RL_helper (m)); },
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_RR_helper (m)); },
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_SLA_helper(m)); },
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_SRA_helper(m)); },
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_SLL_helper(m)); },
            () => { this._ticks(4); const m = this._read(this.r16[2]); this._write(this.r16[2], this.op_SRL_helper(m)); }
        ];
        for (let opType = 0; opType < 8; opType++) {
            for (let r = 0; r < 8; r++) {
                this.opcodesCB[(opType << 3) | r] = (r === 6) ? cbRotsHL[opType] : () => cbRots[opType](r);
            }
        }
        for (let b = 0; b < 8; b++) {
            for (let r = 0; r < 8; r++) {
                if (r === 6) {
                    this.opcodesCB[0x40 | (b << 3) | 6] = () => { this._ticks(3); const v = this._read(this.r16[2]) & (1 << b); this.r8[6] = (Z80_FLAGS_SZP_LUT[v] & FLAG_SZPV) | ((this.regWZ >>> 8) & FLAG_YX) | MASK_H | (this.r8[6] & MASK_C); };
                    this.opcodesCB[0x80 | (b << 3) | 6] = () => { this._ticks(4); const a = this.r16[2]; this._write(a, this._read(a) & ~(1 << b)); };
                    this.opcodesCB[0xC0 | (b << 3) | 6] = () => { this._ticks(4); const a = this.r16[2]; this._write(a, this._read(a) |  (1 << b)); };
                } else {
                    this.opcodesCB[0x40 | (b << 3) | r] = () => { this._ticks(2); const v = this.r8[R8_MAP[r]]; const yx = v & FLAG_YX; const bit = v & (1 << b); this.r8[6] = (Z80_FLAGS_SZP_LUT[bit] & FLAG_SZPV) | yx | MASK_H | (this.r8[6] & MASK_C); };
                    this.opcodesCB[0x80 | (b << 3) | r] = () => { this._ticks(2); this.r8[R8_MAP[r]] &= ~(1 << b); };
                    this.opcodesCB[0xC0 | (b << 3) | r] = () => { this._ticks(2); this.r8[R8_MAP[r]] |=  (1 << b); };
                }
            }
        }

        // ---- ED OPCODES ----
        this.opcodesED[0x57] = () => { this._ticks(3); this.isPrefix = false; this.r8[7] = this.regI; this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[7]] & FLAG_SZXY) | (this.iff2 << BIT_P) | (this.r8[6] & MASK_C); };
        this.opcodesED[0x5F] = () => { this._ticks(3); this.isPrefix = false; this.r8[7] = this.regR; this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[7]] & FLAG_SZXY) | (this.iff2 << BIT_P) | (this.r8[6] & MASK_C); };
        this.opcodesED[0x47] = () => { this._ticks(3); this.isPrefix = false; this.regI = this.r8[7]; };
        this.opcodesED[0x4F] = () => { this._ticks(3); this.isPrefix = false; this.regR = this.r8[7]; };

        for (let p = 0; p < 4; p++) {
            this.opcodesED[0x4B | (p << 4)] = () => { this._ticks(6); const addr = (this.fetchByte() | (this.fetchByte() << 8)); this.regWZ = (addr + 1) & 0xFFFF; this.setPair(p, this._read(addr) | (this._read(this.regWZ) << 8), false); };
            this.opcodesED[0x43 | (p << 4)] = () => { this._ticks(5); const addr = (this.fetchByte() | (this.fetchByte() << 8)); const val = this.getPair(p, false); this._write(addr, val & 0xFF); this._ticks(1); this.regWZ = (addr + 1) & 0xFFFF; this._write(this.regWZ, val >>> 8); };
            this.opcodesED[0x4A | (p << 4)] = () => { this._ticks(4); const hl = this.r16[2]; this.regWZ = (hl + 1) & 0xFFFF; const c = this.r8[6] & 1, ss = this.getPair(p, false), res = hl + ss + c; this.r16[2] = res; this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[5]] & FLAG_SZYX) | (((res & 0xFFFF) === 0) ? MASK_Z : 0) | (res >>> 16) | ((((hl & 4095) + (ss & 4095) + c) >>> 8) & MASK_H) | ((((hl & 0x8000) === (ss & 0x8000)) && ((hl & 0x8000) !== (res & 0x8000))) ? MASK_V : 0); };
            this.opcodesED[0x42 | (p << 4)] = () => { this._ticks(4); const hl = this.r16[2]; this.regWZ = (hl + 1) & 0xFFFF; const c = this.r8[6] & 1, ss = this.getPair(p, false), res = hl - ss - c; this.r16[2] = res; this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[5]] & FLAG_SZYX) | (((res & 0xFFFF) === 0) ? MASK_Z : 0) | ((res >>> 16) & 1) | ((((hl & 4095) - (ss & 4095) - c) >>> 8) & MASK_H) | ((((hl & 0x8000) !== (ss & 0x8000)) && ((hl & 0x8000) !== (res & 0x8000))) ? MASK_V : 0) | MASK_N; };
        }

        this.opcodesED[0xA0] = () => { this._ticks(5); this.isPrefix = false; this.doBlockTransfer(1);  };
        this.opcodesED[0xB0] = () => { this._ticks(5); this.isPrefix = false; this.doBlockTransfer(1);  this.repeatBlock(); };
        this.opcodesED[0xA8] = () => { this._ticks(5); this.isPrefix = false; this.doBlockTransfer(-1); };
        this.opcodesED[0xB8] = () => { this._ticks(5); this.isPrefix = false; this.doBlockTransfer(-1); this.repeatBlock(); };
        this.opcodesED[0xA1] = () => { this._ticks(4); this.doBlockCompare(1);  };
        this.opcodesED[0xB1] = () => { this._ticks(4); this.doBlockCompare(1);  this.repeatCompare(); };
        this.opcodesED[0xA9] = () => { this._ticks(4); this.doBlockCompare(-1); };
        this.opcodesED[0xB9] = () => { this._ticks(4); this.doBlockCompare(-1); this.repeatCompare(); };

        [0x44,0x4C,0x54,0x5C,0x64,0x6C,0x74,0x7C].forEach(op => this.opcodesED[op] = () => { this._ticks(2); const a = -this.r8[7], hc = (-(this.r8[7] & 15)) & MASK_H, ov = (this.r8[7] === 128) ? MASK_V : 0; this.r8[7] = a; this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[7]] & FLAG_SZXY) | ((a >>> 8) & 1) | hc | ov | MASK_N; });
        [0x46,0x4E,0x66,0x6E].forEach(op => this.opcodesED[op] = () => { this._ticks(2); this.regIM = 0; });
        [0x56,0x76].forEach(op          => this.opcodesED[op] = () => { this._ticks(2); this.regIM = 1; });
        [0x5E,0x7E].forEach(op          => this.opcodesED[op] = () => { this._ticks(2); this.regIM = 2; });

        this.opcodesED[0x6F] = () => { this._ticks(5); const addr = this.r16[2]; this.regWZ = (addr + 1) & 0xFFFF; const mem = this._read(addr), al = this.r8[7] & 15; this.r8[7] = (this.r8[7] & 240) | (mem >>> 4); this._write(addr, ((mem & 15) << 4) | al); this.r8[6] = Z80_FLAGS_SZP_LUT[this.r8[7]] | (this.r8[6] & MASK_C); };
        this.opcodesED[0x67] = () => { this._ticks(5); const addr = this.r16[2]; this.regWZ = (addr + 1) & 0xFFFF; const mem = this._read(addr), al = this.r8[7] & 15; this.r8[7] = (this.r8[7] & 240) | (mem & 15); this._write(addr, (al << 4) | (mem >>> 4)); this.r8[6] = Z80_FLAGS_SZP_LUT[this.r8[7]] | (this.r8[6] & MASK_C); };

        [0x45,0x4D,0x55,0x5D,0x65,0x6D,0x75,0x7D].forEach(op => this.opcodesED[op] = () => { this._ticks(4); this.iff1 = this.iff2; this.regWZ = this.regPC = this.popWord(); });

        for (let r = 0; r < 8; r++) {
            if (r !== 6) {
                this.opcodesED[0x40 | (r << 3)] = () => { this._ticks(4); const bc = this.r16[0]; this.regWZ = (bc + 1) & 0xFFFF; const val = this._readIO(bc); this.r8[R8_MAP[r]] = val; this.r8[6] = Z80_FLAGS_SZP_LUT[val] | (this.r8[6] & MASK_C); };
                this.opcodesED[0x41 | (r << 3)] = () => { this._ticks(2); const bc = this.r16[0]; this.regWZ = (bc + 1) & 0xFFFF; this.ioWriteLow(bc, this.r8[R8_MAP[r]]); this._ticks(2); };
            }
        }
        this.opcodesED[0x70] = () => { this._ticks(4); const bc = this.r16[0]; this.regWZ = (bc + 1) & 0xFFFF; this.r8[6] = Z80_FLAGS_SZP_LUT[this._readIO(bc)] | (this.r8[6] & MASK_C); };
        this.opcodesED[0x71] = () => { this._ticks(2); const bc = this.r16[0]; this.regWZ = (bc + 1) & 0xFFFF; this.ioWriteLow(bc, 0); this._ticks(2); };

        const makeINOut = (isIn, isDec, rep) => () => {
            this._ticks(isIn ? 5 : 4);
            if (!isIn) this.r8[1] = (this.r8[1] - 1) & 0xFF;
            const bc = this.r16[0]; this.regWZ = (bc + (isDec ? -1 : 1)) & 0xFFFF;
            const hl = this.r16[2]; let val;
            if (isIn) { val = this._readIO(bc); this._write(hl, val); this.r8[1] = (this.r8[1] - 1) & 0xFF; }
            else      { val = this._read(hl); this.ioWriteHigh(bc, val); this._ticks(1); }
            this.r16[2] = (hl + (isDec ? -1 : 1)) & 0xFFFF;
            const tmp = val + ((this.r8[0] + (isDec ? -1 : 1)) & 0xFF), c = (tmp >>> 8) & 1;
            this.r8[6] = (Z80_FLAGS_SZP_LUT[this.r8[1]] & FLAG_SZXY) | (val >>> 7) | (Z80_FLAGS_SZP_LUT[(tmp & 7) ^ this.r8[1]] & MASK_V) | (c << 4) | c;
            if (rep) this.repeatIO();
        };

        this.opcodesED[0xA2] = makeINOut(true,  false, false); // INI
        this.opcodesED[0xB2] = makeINOut(true,  false, true);  // INIR
        this.opcodesED[0xAA] = makeINOut(true,  true,  false); // IND
        this.opcodesED[0xBA] = makeINOut(true,  true,  true);  // INDR
        this.opcodesED[0xA3] = makeINOut(false, false, false); // OUTI
        this.opcodesED[0xB3] = makeINOut(false, false, true);  // OTIR
        this.opcodesED[0xAB] = makeINOut(false, true,  false); // OUTD
        this.opcodesED[0xBB] = makeINOut(false, true,  true);  // OTDR

        // ---- DDFD OPCODES (copy base, then override) ----
        this.opcodesDDFD = [...this.opcodes];

        const idxHigh    = ()  => (this.idxRegs[this.activeIdx] >>> 8);
        const idxLow     = ()  => (this.idxRegs[this.activeIdx] & 0xFF);
        const setIdxHigh = (v) => { this.idxRegs[this.activeIdx] = (this.idxRegs[this.activeIdx] & 0x00FF) | (v << 8); };
        const setIdxLow  = (v) => { this.idxRegs[this.activeIdx] = (this.idxRegs[this.activeIdx] & 0xFF00) | v; };

        [0x44,0x45,0x4C,0x4D,0x54,0x55,0x5C,0x5D,0x60,0x61,0x62,0x63,0x64,0x65,0x67,0x68,0x69,0x6A,0x6B,0x6C,0x6D,0x7C,0x7D,0x6F].forEach(op => {
            const dest = (op >>> 3) & 7, src = op & 7;
            this.opcodesDDFD[op] = () => {
                this._ticks(2);
                const val = (src === 4) ? idxHigh() : (src === 5) ? idxLow() : this.r8[R8_MAP[src]];
                if (dest === 4) setIdxHigh(val); else if (dest === 5) setIdxLow(val); else this.r8[R8_MAP[dest]] = val;
            };
        });

        this.opcodesDDFD[0x26] = () => { this._ticks(3); setIdxHigh(this.fetchByte()); };
        this.opcodesDDFD[0x2E] = () => { this._ticks(3); setIdxLow(this.fetchByte()); };
        this.opcodesDDFD[0x24] = () => { this._ticks(2); setIdxHigh(this.inc8(idxHigh())); };
        this.opcodesDDFD[0x2C] = () => { this._ticks(2); setIdxLow(this.inc8(idxLow())); };
        this.opcodesDDFD[0x25] = () => { this._ticks(2); setIdxHigh(this.dec8(idxHigh())); };
        this.opcodesDDFD[0x2D] = () => { this._ticks(2); setIdxLow(this.dec8(idxLow())); };

        this.opcodesDDFD[0x84] = () => { this._ticks(2); this.add8(idxHigh(), 0); };
        this.opcodesDDFD[0x85] = () => { this._ticks(2); this.add8(idxLow(),  0); };
        this.opcodesDDFD[0x8C] = () => { this._ticks(2); this.add8(idxHigh(), this.r8[6] & 1); };
        this.opcodesDDFD[0x8D] = () => { this._ticks(2); this.add8(idxLow(),  this.r8[6] & 1); };
        this.opcodesDDFD[0x94] = () => { this._ticks(2); this.sub8(idxHigh(), 0); };
        this.opcodesDDFD[0x95] = () => { this._ticks(2); this.sub8(idxLow(),  0); };
        this.opcodesDDFD[0x9C] = () => { this._ticks(2); this.sub8(idxHigh(), this.r8[6] & 1); };
        this.opcodesDDFD[0x9D] = () => { this._ticks(2); this.sub8(idxLow(),  this.r8[6] & 1); };
        this.opcodesDDFD[0xA4] = () => { this._ticks(2); this.and8(idxHigh()); };
        this.opcodesDDFD[0xA5] = () => { this._ticks(2); this.and8(idxLow()); };
        this.opcodesDDFD[0xAC] = () => { this._ticks(2); this.xor8(idxHigh()); };
        this.opcodesDDFD[0xAD] = () => { this._ticks(2); this.xor8(idxLow()); };
        this.opcodesDDFD[0xB4] = () => { this._ticks(2); this.or8(idxHigh()); };
        this.opcodesDDFD[0xB5] = () => { this._ticks(2); this.or8(idxLow()); };
        this.opcodesDDFD[0xBC] = () => { this._ticks(2); this.cp8(idxHigh()); };
        this.opcodesDDFD[0xBD] = () => { this._ticks(2); this.cp8(idxLow()); };

        for (let r = 0; r < 8; r++) {
            if (r !== 6) {
                this.opcodesDDFD[0x46 | (r << 3)] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.r8[R8_MAP[r]] = this._read(this.regWZ); };
                this.opcodesDDFD[0x70 | r]         = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this._write(this.regWZ, this.r8[R8_MAP[r]]); };
            }
        }

        this.opcodesDDFD[0x21] = () => { const lo = this.fetchByte(), hi = this.fetchByte(); this._ticks(4); this.idxRegs[this.activeIdx] = (hi << 8) | lo; };
        this.opcodesDDFD[0x22] = () => { const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo; this._ticks(5); this._write(addr, this.idxRegs[this.activeIdx] & 0xFF); this._ticks(1); this.regWZ = (addr + 1) & 0xFFFF; this._write(this.regWZ, this.idxRegs[this.activeIdx] >>> 8); };
        this.opcodesDDFD[0x23] = () => { this._ticks(3); this.isPrefix = false; this.idxRegs[this.activeIdx] = (this.idxRegs[this.activeIdx] + 1) & 0xFFFF; };
        this.opcodesDDFD[0x2A] = () => { const lo = this.fetchByte(), hi = this.fetchByte(), addr = (hi << 8) | lo; this._ticks(6); const alo = this._read(addr); this.regWZ = (addr + 1) & 0xFFFF; this.idxRegs[this.activeIdx] = (this._read(this.regWZ) << 8) | alo; };
        this.opcodesDDFD[0x2B] = () => { this._ticks(3); this.isPrefix = false; this.idxRegs[this.activeIdx] = (this.idxRegs[this.activeIdx] - 1) & 0xFFFF; };
        this.opcodesDDFD[0x34] = () => { this._ticks(6); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this._write(this.regWZ, this.inc8(this._read(this.regWZ))); };
        this.opcodesDDFD[0x35] = () => { this._ticks(6); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this._write(this.regWZ, this.dec8(this._read(this.regWZ))); };
        this.opcodesDDFD[0x36] = () => { const off = this.fetchOffset(), val = this.fetchByte(); this._ticks(6); this.regWZ = (this.idxRegs[this.activeIdx] + off) & 0xFFFF; this._write(this.regWZ, val); };

        this.opcodesDDFD[0x86] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.add8(this._read(this.regWZ), 0); };
        this.opcodesDDFD[0x8E] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.add8(this._read(this.regWZ), this.r8[6] & 1); };
        this.opcodesDDFD[0x96] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.sub8(this._read(this.regWZ), 0); };
        this.opcodesDDFD[0x9E] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.sub8(this._read(this.regWZ), this.r8[6] & 1); };
        this.opcodesDDFD[0xA6] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.and8(this._read(this.regWZ)); };
        this.opcodesDDFD[0xAE] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.xor8(this._read(this.regWZ)); };
        this.opcodesDDFD[0xB6] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.or8 (this._read(this.regWZ)); };
        this.opcodesDDFD[0xBE] = () => { this._ticks(5); this.regWZ = (this.idxRegs[this.activeIdx] + this.fetchOffset()) & 0xFFFF; this.cp8 (this._read(this.regWZ)); };

        for (let p = 0; p < 4; p++) {
            this.opcodesDDFD[0x09 | (p << 4)] = () => { this._ticks(4); this.regWZ = (this.idxRegs[this.activeIdx] + 1) & 0xFFFF; const ss = this.getPairIdx(p), a = this.idxRegs[this.activeIdx], res = a + ss; this.idxRegs[this.activeIdx] = res; this.r8[6] = (this.r8[6] & FLAG_SZP_C) | ((res >>> 8) & FLAG_YX) | ((((a & 4095) + (ss & 4095)) >>> 8) & MASK_H) | (res >>> 16); };
        }

        this.opcodesDDFD[0xE1] = () => { this._ticks(4); this.idxRegs[this.activeIdx] = this.popWord(); };
        this.opcodesDDFD[0xE5] = () => { this._ticks(4); this.pushWord(this.idxRegs[this.activeIdx]); };
        this.opcodesDDFD[0xE3] = () => { this._ticks(6); this.isPrefix = false; const idx = this.idxRegs[this.activeIdx], l = this._read(this.regSP), h = this._read((this.regSP + 1) & 0xFFFF); this.regWZ = (h << 8) | l; this.idxRegs[this.activeIdx] = this.regWZ; this._write(this.regSP, idx & 0xFF); this._ticks(1); this._write((this.regSP + 1) & 0xFFFF, idx >>> 8); };
        this.opcodesDDFD[0xE9] = () => { this._ticks(2); this.regPC = this.idxRegs[this.activeIdx]; };
        this.opcodesDDFD[0xF9] = () => { this._ticks(3); this.isPrefix = false; this.regSP = this.idxRegs[this.activeIdx]; };
        this.opcodesDDFD[0xCB] = this.decodeDDFDCB.bind(this);

        // ---- DDFDCB OPCODES ----
        // Pre-built once — avoids per-call allocation (the original hot-path bug)
        const ddfdcbRots = [
            this.op_RLC_helper.bind(this), this.op_RRC_helper.bind(this),
            this.op_RL_helper.bind(this),  this.op_RR_helper.bind(this),
            this.op_SLA_helper.bind(this), this.op_SRA_helper.bind(this),
            this.op_SLL_helper.bind(this), this.op_SRL_helper.bind(this)
        ];
        for (let opType = 0; opType < 8; opType++) {
            for (let r = 0; r < 8; r++) {
                this.opcodesDDFDCB[(opType << 3) | r] = (off) => {
                    this._ticks(7);
                    this.regWZ = (this.idxRegs[this.activeIdx] + off) & 0xFFFF;
                    const val = ddfdcbRots[opType](this._read(this.regWZ));
                    this._write(this.regWZ, val);
                    if (r !== 6) this.r8[R8_MAP[r]] = val;
                };
            }
        }
        for (let b = 0; b < 8; b++) {
            for (let r = 0; r < 8; r++) {
                this.opcodesDDFDCB[0x40 | (b << 3) | r] = (off) => { this._ticks(6); this.regWZ = (this.idxRegs[this.activeIdx] + off) & 0xFFFF; const v = this._read(this.regWZ) & (1 << b); this.r8[6] = (Z80_FLAGS_SZP_LUT[v] & FLAG_SZPV) | ((this.regWZ >>> 8) & FLAG_YX) | MASK_H | (this.r8[6] & MASK_C); };
                this.opcodesDDFDCB[0x80 | (b << 3) | r] = (off) => { this._ticks(7); this.regWZ = (this.idxRegs[this.activeIdx] + off) & 0xFFFF; const v = this._read(this.regWZ) & ~(1 << b); this._write(this.regWZ, v); if (r !== 6) this.r8[R8_MAP[r]] = v; };
                this.opcodesDDFDCB[0xC0 | (b << 3) | r] = (off) => { this._ticks(7); this.regWZ = (this.idxRegs[this.activeIdx] + off) & 0xFFFF; const v = this._read(this.regWZ) |  (1 << b); this._write(this.regWZ, v); if (r !== 6) this.r8[R8_MAP[r]] = v; };
            }
        }
    }
}

