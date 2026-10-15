/**
 * @file Tools_Formatters.js
 * @module Tools_Formatters
 *
 * Formatting helpers: numeric conversions (hex, decimal) and little-endian reads
 * from a buffer. Pure, stateless module with no external dependency.
 */

"use strict";

// Low-level numeric helpers

/**
 * Pads a string with zeros on the left up to the target length.
 * @param {string} str          - Source string (result of .toString(base))
 * @param {number} targetLength - Wanted width
 * @returns {string}
 */
const padLeft = (str, targetLength) => str.padStart(targetLength, "0");

/**
 * Formats an 8-bit value as 2 hexadecimal characters.
 * Example: 7 → "07"
 * @param {number} value
 * @returns {string}
 */
const toHex8 = (value) => padLeft((value & 0xFF).toString(16), 2);

/**
 * Formats a 16-bit value as 4 hexadecimal characters.
 * Example: 4096 → "1000"
 * @param {number} value
 * @returns {string}
 */
const toHex16 = (value) => padLeft((value & 0xFFFF).toString(16), 4);

/**
 * Formats a number as 3 decimal digits (used by the tape counter).
 * Example: 5 → "005"
 * @param {number} value
 * @returns {string}
 */
const toDecimal3 = (value) => padLeft(value.toString(10), 3);

// Little-endian reads from a buffer

/**
 * Reads a little-endian 16-bit integer from a buffer.
 * @param {Uint8Array} buffer
 * @param {number}     offset
 * @returns {number}
 */
const read16bitLE = (buffer, offset) =>
  (buffer[offset + 1] << 8) | buffer[offset];

/**
 * Reads a little-endian 32-bit (DWord) integer from a buffer.
 * `>>> 0` keeps the result unsigned.
 * @param {Uint8Array} buffer
 * @param {number}     offset
 * @returns {number}
 */
const read32bitLE = (buffer, offset) =>
  (((buffer[offset + 3] << 24) |
    (buffer[offset + 2] << 16) |
    (buffer[offset + 1] <<  8) |
     buffer[offset]) >>> 0);

// Array conversions

/**
 * Converts a byte sequence into an ASCII string.
 * @param {Uint8Array} buffer
 * @param {number}     offset - Start index
 * @param {number}     length - Number of characters to read
 * @returns {string}
 */
const bytesToString = (buffer, offset, length) =>
  Array.from({ length }, (_, i) =>
    String.fromCharCode(buffer[offset + i])
  ).join("");

/**
 * Converts a byte array into a readable hexadecimal string, `[xx,xx,…]`, used by
 * the floppy controller (FDC) logs.
 * @param {Uint8Array|number[]} byteArray
 * @returns {string}  e.g. "[FF,3A,00]"
 */
const arrayToHexString = (byteArray) =>
  "[" + Array.from(byteArray).map(toHex8).join(",") + "]";

