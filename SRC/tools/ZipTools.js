/**
 * JS CPC Module: ZipTools
 *
 * Parseurs partagés (utilisés par plusieurs modules).
 *
 *   · ZIP_Parser  - archives .ZIP (stocké + deflate via inflate())
 */

"use strict";

// ===============================================================================
// ZIP_Parser - Archives .ZIP
// ===============================================================================
//
//  Supporte : méthode 0 (stocké) et méthode 8 (deflate via inflate()).
//  Limite : pas de support ZIP64, pas de chiffrement, pas de multi-disque.
//
//  Usage :
//    const zip = new ZIP_Parser(data);   // data = Uint8Array
//    const file = zip.extract("file.dsk");
//
//  Propriétés exposées :
//    zip.filelist  - tableau d'entrées de fichier
//    zip.zipFiles  - dictionnaire filename → entrée
//    zip.fileComment

// Table de transcodage CP437 → Unicode (caractères de contrôle 0-31)
const _CP437_CTRL = [
    0, 9786, 9787, 9829, 9830, 9827, 9824, 8226, 9688, 9675, 9689, 9794,
    9792, 9834, 9835, 9788, 9658, 9668, 8597, 8252, 182, 167, 9644, 8616,
    8593, 8595, 8594, 8592, 8735, 8596, 9650, 9660
];
// Table CP437 → Unicode (caractères hauts 128-255)
const _CP437_HIGH = [
    199, 252, 233, 226, 228, 224, 229, 231, 234, 235, 232, 239, 238, 236, 196, 197,
    201, 230, 198, 244, 246, 242, 251, 249, 255, 214, 220, 162, 163, 165, 8359, 402,
    225, 237, 243, 250, 241, 209, 170, 186, 191, 8976, 172, 189, 188, 161, 171, 187,
    9617, 9618, 9619, 9474, 9508, 9569, 9570, 9558, 9557, 9571, 9553, 9559, 9565, 9564,
    9563, 9488, 9492, 9524, 9516, 9500, 9472, 9532, 9566, 9567, 9562, 9556, 9577, 9574,
    9568, 9552, 9580, 9575, 9576, 9572, 9573, 9561, 9560, 9554, 9555, 9579, 9578, 9496,
    9484, 9608, 9604, 9612, 9616, 9600, 945, 223, 915, 960, 931, 963, 181, 964, 934,
    920, 937, 948, 8734, 966, 949, 8745, 8801, 177, 8805, 8804, 8992, 8993, 247, 8776,
    176, 8729, 183, 8730, 8319, 178, 9632, 160
];

/**
 * Décode un tableau d'octets CP437 en chaîne JavaScript.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function _decodeCp437(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += String.fromCharCode(
            b < 32  ? _CP437_CTRL[b]  :
            b > 127 ? _CP437_HIGH[b & 127] : b
        );
    }
    return out;
}

/**
 * Décode un tableau d'octets UTF-8 en chaîne JavaScript.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function _decodeUtf8(bytes) {
    let out = "", i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        if (b < 128) {
            out += String.fromCharCode(b); i++;
        } else if (b > 191 && b < 224) {
            out += String.fromCharCode((b & 31) << 6 | (bytes[i + 1] & 63)); i += 2;
        } else {
            out += String.fromCharCode((b & 15) << 12 | (bytes[i + 1] & 63) << 6 | (bytes[i + 2] & 63)); i += 3;
        }
    }
    return out;
}

/** Constructeur ZIP_Parser - analyse l'index central de l'archive. */
function ZIP_Parser(data) {
    this.filelist    = [];
    this.zipFiles    = {};
    this.fileComment = "";
    this.data        = data;

    if (data.length < 22) throw new Error("Invalid ZIP: file too short");
    if (read32bitLE(data, 0) !== 0x04034B50) throw new Error("Invalid ZIP: bad local magic");

    // Recherche de la signature End-of-Central-Directory (0x06054B50)
    let eocdPos = data.length - 22;
    while (eocdPos >= 0 && read32bitLE(data, eocdPos) !== 0x06054B50) eocdPos--;
    if (eocdPos < 0) throw new Error("ZIP: could not find end of central directory");

    const eocd = data.subarray(eocdPos, eocdPos + 22);
    if (read16bitLE(eocd, 4) !== 0 || read16bitLE(eocd, 6) !== 0) throw new Error("ZIP: multi-disk not supported");

    this.fileComment = _decodeCp437(data.subarray(eocdPos + 22));
    if (this.fileComment.length !== read16bitLE(eocd, 20)) throw new Error("ZIP: invalid comment");

    // Lecture du répertoire central
    const cdSize   = read32bitLE(eocd, 12);
    const cdOffset = read32bitLE(eocd, 16);
    const cd       = data.subarray(cdOffset, cdOffset + cdSize);

    let pos = 0;
    while (pos < cdSize) {
        if (read32bitLE(cd, pos) !== 0x02014B50) throw new Error("ZIP: bad central directory magic");

        const entry = {
            filename         : "",
            fileDate         : new Date(1980, 0, 1),
            fileComment      : "",
            extraField       : "",
            compressionMethod: 0,
            zipVersionNeeded : 0,
            zipVersionMadeBy : 0,
            zipDiskNumStart  : 0,
            zipInternalAttr  : 0,
            zipExternalAttr  : 0,
            zipLocalHeaderOffset: 0,
            zipCrc32             : 0,
            zipCompressedSize    : 0,
            zipUncompressedSize  : 0,
            zipIsEncrypted       : false
        };

        entry.zipVersionMadeBy  = cd[pos + 4];
        entry.zipVersionNeeded  = cd[pos + 5];
        entry.zipDiskNumStart   = cd[pos + 6];
        entry.zipInternalAttr   = cd[pos + 7];
        entry.zipExternalAttr   = read16bitLE(cd, pos + 8);
        entry.zipIsEncrypted    = ((entry.zipExternalAttr >>> 11) & 1) === 1;
        entry.compressionMethod = read16bitLE(cd, pos + 10);

        const modTime    = read16bitLE(cd, pos + 12);
        const modDate    = read16bitLE(cd, pos + 14);
        entry.fileDate   = new Date(
            (modDate >> 9) + 1980, (modDate >> 5 & 15) - 1, modDate & 31,
            modTime >> 11, (modTime >> 5) & 63, 2 * (modTime & 31)
        );

        entry.zipCrc32             = read32bitLE(cd, pos + 16);
        entry.zipCompressedSize    = read32bitLE(cd, pos + 20);
        entry.zipUncompressedSize  = read32bitLE(cd, pos + 24);
        entry.zipLocalHeaderOffset = read32bitLE(cd, pos + 42);

        if (entry.zipDiskNumStart > 20) throw new Error("ZIP: cannot decode this version");

        const nameLen    = read16bitLE(cd, pos + 28);
        const extraLen   = read16bitLE(cd, pos + 30);
        const commentLen = read16bitLE(cd, pos + 32);
        const nameBytes  = cd.subarray(pos + 46, pos + 46 + nameLen);

        entry.filename    = entry.zipIsEncrypted ? _decodeUtf8(nameBytes) : _decodeCp437(nameBytes);
        entry.extraField  = cd.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
        entry.fileComment = entry.zipIsEncrypted
            ? _decodeUtf8(cd.subarray(pos + 46 + nameLen + extraLen, pos + 46 + nameLen + extraLen + commentLen))
            : _decodeCp437(cd.subarray(pos + 46 + nameLen + extraLen, pos + 46 + nameLen + extraLen + commentLen));

        // Vérifications d'intégrité
        const BIG = 1.8446744073709552e19;
        if (entry.zipUncompressedSize === BIG || entry.zipUncompressedSize === 0xFFFFFFFF
            || entry.zipCompressedSize === 0xFFFFFFFF || entry.zipLocalHeaderOffset === 0xFFFFFFFF) {
            throw new Error("ZIP: ZIP64 not supported");
        }
        if (entry.zipExternalAttr & 1) throw new Error("ZIP: encrypted zip not supported");

        this.filelist.push(entry);
        this.zipFiles[entry.filename] = entry;

        pos += 46 + nameLen + extraLen + commentLen;
    }
}

/**
 * Extrait un fichier par son nom.
 * @param {string} filename
 * @returns {Uint8Array} données décompressées
 */
ZIP_Parser.prototype.extract = function (filename) {
    const entry = this.zipFiles[filename];
    if (!entry) throw new Error(`ZIP: file not present in archive: ${filename}`);

    // Lecture du header local (pour obtenir les tailles réelles de nom+extra)
    const lhOffset = entry.zipLocalHeaderOffset;
    const lh       = this.data.subarray(lhOffset, lhOffset + 30);
    if (read32bitLE(lh, 0) !== 0x04034B50) throw new Error("ZIP: bad local file header magic");

    const lhNameLen  = read16bitLE(lh, 26);
    const lhExtraLen = read16bitLE(lh, 28);
    const dataStart  = lhOffset + 30 + lhNameLen + lhExtraLen;

    // Vérifie que le nom du header local correspond au répertoire central
    const lhName = entry.zipIsEncrypted
        ? _decodeUtf8(this.data.subarray(lhOffset + 30, lhOffset + 30 + lhNameLen))
        : _decodeCp437(this.data.subarray(lhOffset + 30, lhOffset + 30 + lhNameLen));
    if (lhName !== entry.filename) throw new Error("ZIP: filename mismatch between directory and local header");

    const compressed = this.data.subarray(dataStart, dataStart + entry.zipCompressedSize);

    if      (entry.compressionMethod === 0) return compressed;
    else if (entry.compressionMethod === 8) return inflate(compressed);
    else throw new Error(`ZIP: unknown compression method: ${entry.compressionMethod}`);
};


