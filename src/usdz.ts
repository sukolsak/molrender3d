/**
 * Copyright (c) 2021 Sukolsak Sakshuwong.
 *
 * @author Sukolsak Sakshuwong <sukolsak@stanford.edu>
 *
 * ported from Robert Crosby's https://github.com/robmcrosby/BlenderUSDZ and
 * https://github.com/PixarAnimationStudios/USD
 */

const enum SpecifierType {
    Def = 0,
    Over = 1,
    Class = 2,
}

const enum SpecType {
    Attribute   = 1,
    Connection  = 2,
    Expression  = 3,
    Mapper      = 4,
    MapperArg   = 5,
    Prim        = 6,
    PseudoRoot  = 7,
    Relationship = 8,
    RelationshipTarget = 9,
    Variant     = 10,
    VariantSet  = 11,
}

// https://github.com/PixarAnimationStudios/USD/blob/release/pxr/usd/usd/crateDataTypes.h
export const enum ValueType {
    Invalid = 0,
    bool = 1,
    uchar = 2,
    int = 3,
    uint = 4,
    int64 = 5,
    uint64 = 6,
    half = 7,
    float = 8,
    double = 9,
    string = 10,
    token = 11,
    asset = 12,
    matrix2d = 13,
    matrix3d = 14,
    matrix4d = 15,
    quatd = 16,
    quatf = 17,
    quath = 18,
    vec2d = 19,
    vec2f = 20,
    vec2h = 21,
    vec2i = 22,
    vec3d = 23,
    vec3f = 24,
    vec3h = 25,
    vec3i = 26,
    vec4d = 27,
    vec4f = 28,
    vec4h = 29,
    vec4i = 30,
    Dictionary = 31,
    TokenListOp = 32,
    stringListOp = 33,
    PathListOp = 34,
    ReferenceListOp = 35,
    IntListOp = 36,
    Int64ListOp = 37,
    UIntListOp = 38,
    UInt64ListOp = 39,
    PathVector = 40,
    TokenVector = 41,
    Specifier = 42,
    Permission = 43,
    Variability = 44,
    VariantSelectionMap = 45,
    TimeSamples = 46,
    Payload = 47,
    DoubleVector = 48,
    LayerOffsetVector = 49,
    stringVector = 50,
    ValueBlock = 51,
    Value = 52,
    UnregisteredValue = 53,
    UnregisteredValueListOp = 54,
    PayloadListOp = 55,
}

export class UsdAttribute {
    readonly name: string;
    readonly value: any;
    readonly frames: [number, any][] = [];
    readonly qualifiers: string[] = [];
    readonly metadata: {[key: string]: any} = {};
    readonly valueType: ValueType;
    readonly valueTypeStr: string;
    readonly isArray: boolean;
    parent: UsdPrim | null = null;
    pathIndex = -1;
    private pathJump = 0;

    constructor(name: string, value: any, type: ValueType, valueTypeStr: string, isArray: boolean = false) {
        this.name = name;
        this.value = value;
        this.valueType = type;
        this.valueTypeStr = valueTypeStr;
        this.isArray = isArray;
    }

    addQualifier(qualifier: string) {
        this.qualifiers.push(qualifier);
    }

    addTimeSample(frame: number, value: any) {
        this.frames.push([frame, value]);
    }

    isConnection(): boolean {
        return this.value instanceof UsdAttribute;
    }

    isRelationship(): boolean {
        return this.value instanceof UsdPrim;
    }

    getPathJump(): number {
        this.pathJump = 0;
        if (this.parent !== null && this.parent.attributes[this.parent.attributes.length - 1] === this) {
            this.pathJump = -2;
        }
        return this.pathJump;
    }
}

class UsdPrim {
    readonly name: string;
    readonly specifierType = SpecifierType.Def;
    readonly classType: string;
    parent: UsdPrim | null = null;
    readonly metadata: {[key: string]: any} = {};
    readonly children: UsdPrim[] = [];
    readonly attributes: UsdAttribute[] = [];
    pathIndex = 0;
    pathJump = -1;

    constructor(name: string, type: string) {
        this.name = name;
        this.classType = type;
    }

    addAttribute(attribute: UsdAttribute) {
        attribute.parent = this;
        this.attributes.push(attribute);
        // return attribute
    }

    private addChild(child: UsdPrim): UsdPrim {
        child.parent = this;
        this.children.push(child);
        return child;
    }

    createChild(name: string, type: string): UsdPrim {
        return this.addChild(new UsdPrim(name, type));
    }

    updatePathIndices(pathIndex2: number): number {
        this.pathIndex = pathIndex2;
        pathIndex2++;
        for (const child of this.children) {
            pathIndex2 = child.updatePathIndices(pathIndex2);
        }
        for (const att of this.attributes) {
            att.pathIndex = this.pathIndex;
            pathIndex2++;
        }
        return pathIndex2;
    }

    private countItems(): number {
        let count = this.attributes.length + this.children.length;
        for (const child of this.children) {
            count += child.countItems();
        }
        return count;
    }

    getPathJump(): number {
        // https://github.com/PixarAnimationStudios/USD/blob/090ef0d849ced875b3b99a15e454b69148ccd8e1/pxr/usd/usd/crateFile.cpp#L2998
        const hasSibling = this.parent !== null && (this.parent.children[this.parent.children.length - 1] !== this || this.parent.attributes.length > 0);
        const hasChild = this.children.length > 0 || this.attributes.length > 0;
        if (hasSibling && hasChild) {
            this.pathJump = this.countItems() + 1;
        } else if (hasSibling) {
            this.pathJump = 0;
        } else if (hasChild) {
            this.pathJump = -1;
        } else {
            this.pathJump = -2;
        }
        return this.pathJump;
    }
}

export class UsdData extends UsdPrim {
    updatePathIndices(): number {
        let pathIndex = 1;
        for (const child of this.children) {
            pathIndex = child.updatePathIndices(pathIndex);
        }
        return 0; // Never used.
    }
}


const MAX_BLOCK_INPUT_SIZE = 0x7E000000;

const MAX_OFFSET = 65535;
const MIN_MATCH = 4;
const MFLIMIT = 12;

const tmpBuffer = new ArrayBuffer(8);
const tmpDataView = new DataView(tmpBuffer);


class PositionTable {
    private readonly table = new Int32Array(0x1000); // 4096

    private static _hash(val: number): number {
        val &= 0xFFFFFFFF;
        return Math.imul(val, 2654435761) & 0x0FFF; // max = 4095
    }

    constructor() {
        this.table.fill(-1);
    }

    getPosition(val: number): number {
        const index = PositionTable._hash(val);
        return this.table[index];
    }

    setPosition(val: number, pos: number) {
        const index = PositionTable._hash(val);
        this.table[index] = pos;
    }
}

function readLeUint32(buf: Uint8Array, pos: number): number {
    return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
}

function writeLeUint16(buf: Uint8Array, i: number, val: number) {
    buf[i] = val & 0xFF;
    buf[i + 1] = (val >> 8) & 0xFF;
}

function countMatch(buf: Uint8Array, front: number, back: number, max: number): number {
    let count = 0;
    while (back <= max) {
        if (buf[front] !== buf[back]) {
            break;
        }
        count++;
        front++;
        back++;
    }
    return count;
}

function copySequence(dst: Uint8Array, dstHead: number, literal: Uint8Array, matchOffset: number, matchLen: number): number {
    const litLen = literal.length;
    let dstPtr = dstHead;

    // Write the length of the literal
    const originalDstPtr = dstPtr;
    dstPtr++;
    if (litLen >= 15) {
        dst[originalDstPtr] = (15 << 4);
        let remLen = litLen - 15;
        while (remLen >= 255) {
            dst[dstPtr] = 255;
            dstPtr++;
            remLen -= 255;
        }
        dst[dstPtr] = remLen;
        dstPtr++;
    } else {
        dst[originalDstPtr] = litLen << 4;
    }

    // Write the literal
    dst.set(literal, dstPtr);
    dstPtr += litLen;

    if (matchLen > 0) {
        // Write the Match offset
        writeLeUint16(dst, dstPtr, matchOffset);
        dstPtr += 2;

        // Write the Match length
        matchLen -= MIN_MATCH;
        if (matchLen >= 15) {
            dst[originalDstPtr] |= 15;
            matchLen -= 15;
            while (matchLen >= 255) {
                dst[dstPtr] = 255;
                dstPtr++;
                matchLen -= 255;
            }
            dst[dstPtr] = matchLen;
            dstPtr++;
        } else {
            dst[originalDstPtr] |= matchLen;
        }
    }
    return dstPtr - dstHead;
}

function lz4CompressDefault(src: Uint8Array): Uint8Array {
    const srcLen = src.length;
    const worstCaseBlockLength = srcLen + Math.floor(srcLen / 255) + 16;
    const dst = new Uint8Array(worstCaseBlockLength);
    const posTable = new PositionTable();
    let srcPtr = 0;
    let literalHead = 0;
    let dstPtr = 0;
    const MAX_INDEX = srcLen - MFLIMIT;

    while (srcPtr < MAX_INDEX) {
        const curValue = readLeUint32(src, srcPtr);
        const matchPos = posTable.getPosition(curValue);
        if (matchPos !== -1 && curValue === readLeUint32(src, matchPos) && srcPtr - matchPos <= MAX_OFFSET) {
            const length = countMatch(src, matchPos, srcPtr, MAX_INDEX);
            if (length < MIN_MATCH) {
                break;
            }
            dstPtr += copySequence(dst, dstPtr,
                new Uint8Array(src.buffer, literalHead, srcPtr - literalHead),
                srcPtr - matchPos, length);
            srcPtr += length;
            literalHead = srcPtr;
        } else {
            posTable.setPosition(curValue, srcPtr);
            srcPtr++;
        }
    }
    // Write the last literal
    dstPtr += copySequence(dst, dstPtr,
        new Uint8Array(src.buffer, literalHead, srcLen - literalHead),
        0, 0);

    return new Uint8Array(dst.buffer, 0, dstPtr);
}

function lz4Compress(src: Uint8Array): Uint8Array {
    // https://github.com/PixarAnimationStudios/USD/blob/release/pxr/base/tf/fastCompression.cpp
    const inputSize = src.length;
    if (inputSize === 0) {
        return new Uint8Array();
    }
    if (inputSize > MAX_BLOCK_INPUT_SIZE) {
        throw new Error('Buffer too large for LZ4 compression');
    }
    const tmp = lz4CompressDefault(src);
    const dst = new Uint8Array(tmp.length + 1);
    dst.set(tmp, 1);
    return dst;
}


// https://github.com/PixarAnimationStudios/USD/blob/release/pxr/usd/usd/integerCoding.cpp
function usdInt32Compress(values: number[]): Uint8Array {
    const valueLen = values.length;
    if (valueLen === 0) {
        return new Uint8Array();
    }

    // See _GetEncodedBufferSize in integerCoding.cpp
    const worstSize = 4 + Math.floor((valueLen * 2 + 7) / 8) + valueLen * 4;
    const data = new Uint8Array(worstSize);
    const dataView = new DataView(data.buffer);

    // First find the most common element value.
    let preValue = 0;
    const counts: Map<number, number> = new Map();
    for (let i = 0; i < valueLen; ++i) {
        const curValue = values[i];
        const value = curValue - preValue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
        preValue = curValue;
    }
    let commonValue = 0;
    let commonCount = 0;
    counts.forEach((count, value) => {
        if (count > commonCount) {
            commonValue = value;
            commonCount = count;
        } else if (count === commonCount && value > commonValue) {
            // Take the largest common value in case of a tie -- this gives
            // the biggest potential savings in the encoded stream.
            commonValue = value;
        }
    });

    // Now code the values.

    // Write most common value.
    dataView.setInt32(0, commonValue, true);

    let p = 4 + Math.floor((valueLen * 2 + 7) / 8);
    preValue = 0;
    for (let v = 0; v < valueLen; ++v) {
        const curValue = values[v];
        const value = curValue - preValue;
        const i = v + 16;
        if (value !== commonValue) {
            if (value <= 0x7F && value >= -0x80) {
                data[Math.floor(i / 4)] |= 1 << ((i % 4) * 2);
                dataView.setInt8(p, value);
                p++;
            } else if (value <= 0x7FFF && value >= -0x8000) {
                data[Math.floor(i / 4)] |= 2 << ((i % 4) * 2);
                dataView.setInt16(p, value, true);
                p += 2;
            } else {
                data[Math.floor(i / 4)] |= 3 << ((i % 4) * 2);
                dataView.setInt32(p, value, true);
                p += 4;
            }
        }
        preValue = curValue;
    }
    return new Uint8Array(data.buffer, 0, p);
}

function encodeInts(ints: number[]): Uint8Array {
    const tmp = new Float64Array(ints);
    return new Uint8Array(tmp.buffer);
}


function writeInt(file: ByteArray, value: number, size: number, signed: boolean = false) {
    // assert(size === 4 || size === 8 || size === 1 || size === 6);
    const bytes = new Uint8Array(size);
    const dataView = new DataView(bytes.buffer);
    if (size === 4) {
        if (signed) {
            dataView.setInt32(0, value, true);
        } else {
            dataView.setUint32(0, value, true);
        }
    } else if (size === 8) {
        if (signed) {
            // assert(value <= 0x7FFFFFFF && value >= -0x80000000);
            dataView.setInt32(0, value, true);
            if (value < 0) {
                dataView.setInt32(1, -1, true);
            }
        } else {
            // assert(value <= 0xFFFFFFFF);
            dataView.setUint32(0, value, true);
        }
    } else if (size === 1) {
        dataView.setUint8(0, value);
    } else if (size === 6) {
        dataView.setUint32(0, value & 0XFFFFFFFF, true);
        dataView.setUint16(4, Math.floor(value / 4294967296) & 0XFFFF, true);
    }
    file.write(bytes);
}

function writeDouble(file: ByteArray, value: number) {
    const bytes = new Uint8Array(8);
    const dataView = new DataView(bytes.buffer);
    dataView.setFloat64(0, value, true);
    file.write(bytes);
}

function writeInt32Compressed(file: ByteArray, data: number[]) {
    const buffer = lz4Compress(usdInt32Compress(data));
    writeInt(file, buffer.length, 8);
    file.write(buffer);
}



class ByteArray {
    private pos = 0;
    private readonly buffers: Uint8Array[] = [];

    tell(): number {
        return this.pos;
    }

    write(buffer: Uint8Array) {
        this.pos += buffer.length;
        this.buffers.push(buffer);
    }

    getBuffers(): Uint8Array[] {
        return this.buffers;
    }
}


function getUsdzFromUsdc(usdc: ByteArray): Uint8Array {
    let contentsSize = 0;
    const buffers = usdc.getBuffers();
    for (const buffer of buffers) {
        contentsSize += buffer.length;
    }

    const name = [0x74, 0x6d, 0x70, 0x2e, 0x75, 0x73, 0x64, 0x63]; // 'tmp.usdc'
    const extraSize = 64 - ((34 + name.length) % 64);
    const pre = new Uint8Array(34 + name.length + extraSize);
    const post = new Uint8Array(46 + name.length + 22);

    {
        let p = 0;
        const preDataView = new DataView(pre.buffer);

        // Local Entry Signature
        pre.set([0x50, 0x4b, 0x03, 0x04], p);
        p += 4;
        // Version for Extract, Bits, Compression Method
        preDataView.setUint16(p, 20, true);
        p += 2;
        p += 2;
        p += 2;
        // Mod Time/Date
        p += 4;
        // CRC Hash
        p += 4;
        // Size Uncompressed/Compressed
        preDataView.setUint32(p, contentsSize, true);
        p += 4;
        preDataView.setUint32(p, contentsSize, true);
        p += 4;
        // Filename/Extra Length
        preDataView.setUint16(p, name.length, true);
        p += 2;
        preDataView.setUint16(p, extraSize + 4, true);
        p += 2;
        // Filename
        pre.set(name, p);
        p += name.length;
        // Extra Header Id/Size
        preDataView.setUint16(p, 1, true);
        p += 2;
        preDataView.setUint16(p, extraSize, true);
        // p += 2;
        // Padding Bytes and File Contents
        // p += extraSize;
    }

    {
        let p = 0;
        const postDataView = new DataView(post.buffer);

        // writeCentralDir

        const cdOffset = pre.length + contentsSize;

        // Central Directory Signature
        post.set([0x50, 0x4B, 0x01, 0x02], p);
        p += 4;
        // Version Made By
        postDataView.setUint16(p, 62, true);
        p += 2;
        // Version For Extract
        postDataView.setUint16(p, 20, true);
        p += 2;
        // Bits
        p += 2;
        // Compression Method
        p += 2;
        // Time/Date
        p += 4;
        // CRC Hash
        p += 4;
        // Size Compressed/Uncompressed
        postDataView.setUint32(p, contentsSize, true);
        p += 4;
        postDataView.setUint32(p, contentsSize, true);
        p += 4;
        // Filename Length, Extra Field Length, Comment Length
        postDataView.setUint16(p, name.length, true);
        p += 2;
        p += 2;
        p += 2;
        // Disk Number Start, Internal Attrs, External Attrs
        p += 2;
        p += 2;
        p += 4;
        // Local Header Offset
        p += 4;
        // Add the file name again
        post.set(name, p);
        p += name.length;
        // Get Central Dir Length
        const cdLength = 46 + name.length;

        // writeEndCentralDir

        // End Central Directory Signature
        post.set([0x50, 0x4B, 0x05, 0x06], p);
        p += 4;
        // Disk Number and Disk Number for Central Dir
        p += 2;
        p += 2;
        // Num Central Dir Entries on Disk and Num Central Dir Entries
        postDataView.setUint16(p, 1, true);
        p += 2;
        postDataView.setUint16(p, 1, true);
        p += 2;
        // Central Dir Length/Offset
        postDataView.setUint32(p, cdLength, true);
        p += 4;
        postDataView.setUint32(p, cdOffset, true);
        // p += 4;
        // Comment Length
        // p += 2;
    }

    const usdz = new Uint8Array(pre.length + contentsSize + post.length);
    let offset = 0;
    for (const buffer of [pre, ...buffers, post]) {
        usdz.set(buffer, offset);
        offset += buffer.length;
    }
    return usdz;
}


export class CrateFile {
    private readonly file = new ByteArray();
    private readonly toc: [string, number, number][] = [];
    private readonly tokenMap: Map<string, number> = new Map();
    private readonly tokens: string[] = [];
    private readonly strings: number[] = [];
    private readonly fields: number[] = [];
    private readonly reps: number[] = []; // 64-bit
    private readonly repsMap: Map<number, number> = new Map();
    private readonly fsets: number[] = [];
    private readonly paths: [number, number, number][] = [];
    private readonly specs: [number, number, number][] = [];
    private readonly writtenDataKeys: number[][] = [];
    private readonly writtenDataValues: number[] = [];
    private framesRef = -1;
    private readonly tocStartBuffer = new Uint8Array(8);

    private addWrittenData(data: number[], vType: ValueType, ref: number) {
        this.writtenDataKeys.push(data);
        this.writtenDataValues.push(ref);
    }

    private getDataReference(data: number[], vType: ValueType): number {
        for (let i = 0; i < this.writtenDataKeys.length; ++i) {
            const key = this.writtenDataKeys[i];
            if (data.length !== key.length) {
                continue;
            }
            let j = 0;
            for (; j < data.length; ++j) {
                if (data[j] !== key[j]) {
                    break;
                }
            }
            if (j === data.length) {
                return this.writtenDataValues[i];
            }
        }
        return -1;
    }

    private getTokenIndex(token: string): number {
        const tmp2 = this.tokenMap.get(token);
        if (tmp2 !== undefined) return tmp2;
        const tmp = this.tokens.length;
        this.tokenMap.set(token, tmp);
        this.tokens.push(token);
        return tmp;
    }

    private getStringIndex(str: string): number {
        const tokenIndex = this.getTokenIndex(str);
        const i = this.strings.indexOf(tokenIndex);
        if (i !== -1) {
            return i;
        }
        this.strings.push(tokenIndex);
        return this.strings.length - 1;
    }

    private addFieldSet(fset: number[]): number {
        const index = this.fsets.length;
        this.fsets.push(...fset);
        this.fsets.push(-1);
        return index;
    }

    private addFieldItem(field: number, vType: ValueType, array: boolean, inline: boolean, compressed: boolean, payload: number): number {
        const repIndex = this.reps.length;

        // const ARRAY_BIT = (1 << 63);
        // const INLINE_BIT = (1 << 62);
        // const COMPRESSED_BIT = (1 << 61);
        // const PAYLOAD_MASK = (1 << 48) - 1;

        // assert(payload <= 0x7FFFFFFF && payload >= 0 && field <= 0XFF);
        tmpDataView.setUint32(0, payload, true);

        let upper = 0;
        // upper &= 0xFFFF;
        let key = payload + (field * 4294967296); // Math.pow(2,32)

        // rep = (vType << 48) | (payload & PAYLOAD_MASK)
        upper |= vType << 16;
        if (array) {
            // rep |= ARRAY_BIT
            upper |= (1 << 31);
            key += 4398046511104; // Math.pow(2,42)
        }
        if (compressed) {
            // rep |= COMPRESSED_BIT
            upper |= (1 << 29);
            key += 1099511627776; // Math.pow(2,40)
        }
        if (inline) {
            // rep |= INLINE_BIT
            upper |= (1 << 30);
            key += 2199023255552; // Math.pow(2,41)
        }
        tmpDataView.setUint32(4, upper, true);
        const rep = tmpDataView.getFloat64(0, true);

        const tmp = this.repsMap.get(key);
        if (tmp !== undefined) {
            return tmp;
        }
        this.repsMap.set(key, repIndex);
        this.fields.push(field);
        this.reps.push(rep);
        return repIndex;
    }

    private addFieldTokens(field: string, data: string[]): number {
        const tokenIndex = this.getTokenIndex(field);
        const tokens: number[] = [];
        for (const token of data) {
            const token2 = token.replace(/"/g, '');
            tokens.push(this.getTokenIndex(token2));
        }

        const ref = this.file.tell();
        writeInt(this.file, tokens.length, 8);
        for (const token of tokens) {
            writeInt(this.file, token, 4);
        }

        return this.addFieldItem(tokenIndex, ValueType.token, true, false, false, ref);
    }

    private addFieldToken(field: string, data: string): number {
        const tokenIndex = this.getTokenIndex(field);
        const token = this.getTokenIndex(data.replace(/"/g, ''));
        return this.addFieldItem(tokenIndex, ValueType.token, false, true, false, token);
    }

    private addFieldTokenVector(field: string, tokens: string[]): number {
        const tokenIndex = this.getTokenIndex(field);
        const data: number[] = [];
        for (const token of tokens) {
            const token2 = token.replace(/"/g, '');
            data.push(this.getTokenIndex(token2));
        }
        let ref = this.getDataReference(data, ValueType.TokenVector);
        if (ref < 0) {
            ref = this.file.tell();
            this.addWrittenData(data, ValueType.TokenVector, ref);
            writeInt(this.file, data.length, 8);
            for (const token of data) {
                writeInt(this.file, token, 4);
            }
            this.file.write(new Uint8Array(4));
        }
        return this.addFieldItem(tokenIndex, ValueType.TokenVector, false, false, false, ref);
    }

    private addFieldPathListOp(field: string, pathIndex: number): number {
        const tokenIndex = this.getTokenIndex(field);
        const ref = this.file.tell();
        const op = 3;
        writeInt(this.file, op, 1);
        writeInt(this.file, 1, 8); // Number of indices
        writeInt(this.file, pathIndex, 4);
        return this.addFieldItem(tokenIndex, ValueType.PathListOp, false, false, false, ref);
    }

    private addFieldPathVector(field: string, pathIndex: number): number {
        const tokenIndex = this.getTokenIndex(field);
        const ref = this.file.tell();
        writeInt(this.file, 1, 8); // Number of indices
        writeInt(this.file, pathIndex, 4);
        return this.addFieldItem(tokenIndex, ValueType.PathVector, false, false, false, ref);
    }

    private addFieldSpecifier(field: string, spec: SpecifierType): number {
        const tokenIndex = this.getTokenIndex(field);
        return this.addFieldItem(tokenIndex, ValueType.Specifier, false, true, false, spec);
    }

    private addFieldInts(field: string, data: number[]): number {
        const tokenIndex = this.getTokenIndex(field);
        const compress = data.length >= 16;
        let ref = this.getDataReference(data, ValueType.int);
        if (ref < 0) {
            ref = this.file.tell();
            this.addWrittenData(data, ValueType.int, ref);
            writeInt(this.file, data.length, 8);
            if (compress) {
                writeInt32Compressed(this.file, data);
            } else {
                for (const i of data) {
                    writeInt(this.file, i, 4, true);
                }
            }
        }
        return this.addFieldItem(tokenIndex, ValueType.int, true, false, compress, ref);
    }

    private addFieldFloat(field: string, data: number): number {
        const tokenIndex = this.getTokenIndex(field);
        tmpDataView.setFloat32(0, data, true);
        const data2 = tmpDataView.getInt32(0, true);
        return this.addFieldItem(tokenIndex, ValueType.float, false, true, false, data2);
    }

    private addFieldVectors(field: string, data: Float32Array): number {
        const tokenIndex = this.getTokenIndex(field);
        const ref = this.file.tell();
        writeInt(this.file, data.length / 3, 8);
        // FIXME: Endian?
        this.file.write(new Uint8Array(data.buffer));
        return this.addFieldItem(tokenIndex, ValueType.vec3f, true, false, false, ref);
    }

    private addFieldVector(field: string, data: Float32Array): number {
        const tokenIndex = this.getTokenIndex(field);
        const ref = this.file.tell();
        // FIXME: Endian?
        this.file.write(new Uint8Array(data.buffer));
        return this.addFieldItem(tokenIndex, ValueType.vec3f, false, false, false, ref);
    }

    private addFieldBool(field: string, data: boolean): number {
        const tokenIndex = this.getTokenIndex(field);
        const data2 = data ? 1 : 0;
        return this.addFieldItem(tokenIndex, ValueType.bool, false, true, false, data2);
    }

    private addFieldVariability(field: string, data: boolean): number {
        const tokenIndex = this.getTokenIndex(field);
        const data2 = data ? 1 : 0;
        return this.addFieldItem(tokenIndex, ValueType.Variability, false, true, false, data2);
    }

    private addFieldDictionary(field: string, data: [string: string]): number {
        const tokenIndex = this.getTokenIndex(field);
        const ref = this.file.tell();
        writeInt(this.file, Object.keys(data).length, 8);
        for (const key in data) {
            const value = data[key];
            writeInt(this.file, this.getStringIndex(key), 4);
            writeInt(this.file, 8, 8);
            writeInt(this.file, this.getStringIndex(value), 4);
            writeInt(this.file, 1074397184, 4);
        }
        return this.addFieldItem(tokenIndex, ValueType.Dictionary, false, false, false, ref);
    }

    private addFieldTimeSamples(field: string, data: [number, any][], vType: ValueType): number {
        const tokenIndex = this.getTokenIndex(field);
        const count = data.length;
        const size = 8 * (count + 2);
        let elem = 0;
        // if (type(data[0][1]) == list && len(data[0][1]) > 1)
        //     elem = 128;
        const frames: number[] = [];
        const refs: number[] = [];
        for (const frameValue of data) {
            const [frame, value] = frameValue;
            frames.push(frame);
            const ref = this.file.tell();
            //writeValue(this.file, value, vType);
            // https://github.com/robmcrosby/BlenderUSDZ/blob/e8a002849b85df3daba339912f4cc91fb042fe6d/io_scene_usdz/crate_file.py#L51
            if (vType === ValueType.vec3f) {
                this.file.write(new Uint8Array((value as Float32Array).buffer));
            } else if (vType === ValueType.matrix4d) {
                this.file.write(new Uint8Array((new Float64Array(value)).buffer));
            }
            refs.push(ref);
        }
        const ref = this.file.tell();
        if (this.framesRef > 0) {
            writeInt(this.file, 8, 8);
            writeInt(this.file, this.framesRef + 8, 6);
            writeInt(this.file, ValueType.DoubleVector, 1);
            writeInt(this.file, 0, 1);
        } else {
            this.framesRef = ref;
            writeInt(this.file, size, 8);
            writeInt(this.file, count, 8);
            for (const frame of frames) {
                writeDouble(this.file, frame);
            }
            writeInt(this.file, ref + 8, 6);
            writeInt(this.file, ValueType.DoubleVector, 1);
            writeInt(this.file, 0, 1);
        }
        writeInt(this.file, 8, 8);
        writeInt(this.file, count, 8);
        for (const ref2 of refs) {
            writeInt(this.file, ref2, 6);
            writeInt(this.file, vType, 1);
            writeInt(this.file, elem, 1);
        }
        return this.addFieldItem(tokenIndex, ValueType.TimeSamples, false, false, false, ref);
    }

    private addField(field: string, usdAtt: UsdAttribute): number {
        const value = usdAtt.value!;
        const vType = usdAtt.valueType;
        if (vType === ValueType.token) {
            if (usdAtt.isArray) {
                return this.addFieldTokens(field, value as string[]);
            }
            return this.addFieldToken(field, value as string);
        }
        if (vType === ValueType.Specifier) {
            return this.addFieldSpecifier(field, value as SpecifierType);
        }
        if (vType === ValueType.int) {
            return this.addFieldInts(field, value as number[]);
        }
        if (vType === ValueType.float) {
            return this.addFieldFloat(field, value as number);
        }
        if (vType === ValueType.vec3f) {
            if (usdAtt.isArray) {
                return this.addFieldVectors(field, value as Float32Array);
            }
            return this.addFieldVector(field, value as Float32Array);
        }
        if (vType === ValueType.bool) {
            return this.addFieldBool(field, value as boolean);
        }
        if (vType === ValueType.Variability) {
            return this.addFieldVariability(field, value as boolean);
        }
        if (vType === ValueType.Dictionary) {
            return this.addFieldDictionary(field, value as [string: string]);
        }
        throw new Error('Unknown type');
    }

    private addPath(path: number, token: number, jump: number, prim: boolean) {
        if (prim) {
            token *= -1;
        }
        this.paths.push([path, token, jump]);
    }

    private addSpec(fset: number, sType: SpecType): number {
        const path = this.specs.length;
        this.specs.push([path, fset, sType]);
        return path;
    }

    private writeBootstrap() {
        this.file.write(new Uint8Array([80, 88, 82, 45, 85, 83, 68, 67])); // "PXR-USDC"
        // Version
        this.file.write(new Uint8Array([0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        // Table of Contents Offset
        // writeInt(this.file, tocOffset, 8);
        this.file.write(this.tocStartBuffer); // To be written later.
        this.file.write(new Uint8Array(64));
    }

    private writeTokensSection() {
        const start = this.file.tell();
        writeInt(this.file, this.tokens.length, 8);
        let bufferLen = 0;
        for (const token of this.tokens) {
            bufferLen += token.length + 1;
        }
        const buffer = new Uint8Array(bufferLen);
        let p = 0;
        for (const token of this.tokens) {
            for (let i = 0; i < token.length; ++i) {
                buffer[p++] = token.charCodeAt(i);
            }
            p++;
        }
        writeInt(this.file, buffer.length, 8);
        const buffer2 = lz4Compress(buffer);
        writeInt(this.file, buffer2.length, 8);
        this.file.write(buffer2);
        const size = this.file.tell() - start;
        this.toc.push(['TOKENS', start, size]);
    }

    private writeStringsSection() {
        const start = this.file.tell();
        writeInt(this.file, this.strings.length, 8);
        for (const i of this.strings) {
            writeInt(this.file, i, 4);
        }
        const size = this.file.tell() - start;
        this.toc.push(['STRINGS', start, size]);
    }

    private writeFieldsSection() {
        const start = this.file.tell();
        writeInt(this.file, this.fields.length, 8);
        writeInt32Compressed(this.file, this.fields);
        const buffer = lz4Compress(encodeInts(this.reps));
        writeInt(this.file, buffer.length, 8);
        this.file.write(buffer);
        const size = this.file.tell() - start;
        this.toc.push(['FIELDS', start, size]);
    }

    private writeFieldSetsSection() {
        const start = this.file.tell();
        writeInt(this.file, this.fsets.length, 8);
        writeInt32Compressed(this.file, this.fsets);
        const size = this.file.tell() - start;
        this.toc.push(['FIELDSETS', start, size]);
    }

    private writePathsSection() {
        const start = this.file.tell();
        const paths: number[] = [];
        const tokens: number[] = [];
        const jumps: number[] = [];
        for (const [path, token, jump] of this.paths) {
            paths.push(path);
            tokens.push(token);
            jumps.push(jump);
        }
        writeInt(this.file, this.paths.length, 8);
        writeInt(this.file, this.paths.length, 8);
        writeInt32Compressed(this.file, paths);
        writeInt32Compressed(this.file, tokens);
        writeInt32Compressed(this.file, jumps);
        const size = this.file.tell() - start;
        this.toc.push(['PATHS', start, size]);
    }

    private writeSpecsSection() {
        const start = this.file.tell();
        const paths: number[] = [];
        const fsets: number[] = [];
        const types: number[] = [];
        for (const [path, fset, type] of this.specs) {
            paths.push(path);
            fsets.push(fset);
            types.push(type);
        }
        writeInt(this.file, this.specs.length, 8);
        writeInt32Compressed(this.file, paths);
        writeInt32Compressed(this.file, fsets);
        writeInt32Compressed(this.file, types);
        const size = this.file.tell() - start;
        this.toc.push(['SPECS', start, size]);
    }

    private writeSections() {
        this.writeTokensSection();
        this.writeStringsSection();
        this.writeFieldsSection();
        this.writeFieldSetsSection();
        this.writePathsSection();
        this.writeSpecsSection();
    }

    private writeTableOfContents() {
        const tocStart = this.file.tell();
        writeInt(this.file, this.toc.length, 8);
        for (const [name, start, size] of this.toc) {
            const buffer = new Uint8Array(16);
            for (let i = 0; i < name.length; ++i) {
                buffer[i] = name.charCodeAt(i);
            }
            this.file.write(buffer);
            writeInt(this.file, start, 8);
            writeInt(this.file, size, 8);
        }
        new DataView(this.tocStartBuffer.buffer).setUint32(0, tocStart, true);
    }

    private writeUsdConnection(usdAtt: UsdAttribute) {
        const fset: number[] = [];
        const pathIndex = (usdAtt.value as UsdAttribute).pathIndex;
        fset.push(this.addFieldToken('typeName', 'token'));
        for (const q of usdAtt.qualifiers) {
            if (q === 'uniform') {
                fset.push(this.addFieldVariability('variability', true));
            } else if (q === 'custom') {
                fset.push(this.addFieldBool('custom', true));
            }
        }
        fset.push(this.addFieldPathListOp('connectionPaths', pathIndex));
        fset.push(this.addFieldPathVector('connectionChildren', pathIndex));
        const fsetIndex = this.addFieldSet(fset);
        usdAtt.pathIndex = this.addSpec(fsetIndex, SpecType.Attribute);
        const nameToken = this.getTokenIndex(usdAtt.name);
        const pathJump = usdAtt.getPathJump();
        this.addPath(usdAtt.pathIndex, nameToken, pathJump, true);
    }

    private writeUsdRelationship(usdAtt: UsdAttribute) {
        const fset: number[] = [];
        const pathIndex = (usdAtt.value as UsdPrim).pathIndex;
        fset.push(this.addFieldVariability('variability', true));
        fset.push(this.addFieldPathListOp('targetPaths', pathIndex));
        fset.push(this.addFieldPathVector('targetChildren', pathIndex));
        const fsetIndex = this.addFieldSet(fset);
        usdAtt.pathIndex = this.addSpec(fsetIndex, SpecType.Relationship);
        const nameToken = this.getTokenIndex(usdAtt.name);
        const pathJump = usdAtt.getPathJump();
        this.addPath(usdAtt.pathIndex, nameToken, pathJump, true);
    }

    private writeUsdAttribute(usdAtt: UsdAttribute) {
        const fset: number[] = [];
        fset.push(this.addFieldToken('typeName', usdAtt.valueTypeStr));
        for (const q of usdAtt.qualifiers) {
            if (q === 'uniform') {
                fset.push(this.addFieldVariability('variability', true));
            } else if (q === 'custom') {
                fset.push(this.addFieldBool('custom', true));
            }
        }
        for (const name in usdAtt.metadata) {
            const value = usdAtt.metadata[name];
            fset.push(this.addFieldToken(name, value as string));
        }
        if (usdAtt.value !== null) {
            fset.push(this.addField('default', usdAtt));
        }
        if (usdAtt.frames.length > 0) {
            fset.push(this.addFieldTimeSamples('timeSamples', usdAtt.frames, usdAtt.valueType));
        }
        const fsetIndex = this.addFieldSet(fset);
        usdAtt.pathIndex = this.addSpec(fsetIndex, SpecType.Attribute);
        const nameToken = this.getTokenIndex(usdAtt.name);
        const pathJump = usdAtt.getPathJump();
        this.addPath(usdAtt.pathIndex, nameToken, pathJump, true);
    }

    private writeUsdPrim(usdPrim: UsdPrim) {
        // Add Prim Properties
        const fset: number[] = [];
        fset.push(this.addFieldSpecifier('specifier', usdPrim.specifierType));
        fset.push(this.addFieldToken('typeName', usdPrim.classType));
        for (const name in usdPrim.metadata) {
            const value = usdPrim.metadata[name];
            if (name === 'inherits') {
                const path = (value as UsdPrim).pathIndex;
                fset.push(this.addFieldPathListOp('inheritPaths', path));
            } else if (name === 'references') {
                throw new Error('Not implemented');
            } else if (typeof value === 'object') {
                fset.push(this.addFieldDictionary(name, value));
            } else if (typeof value === 'string') {
                fset.push(this.addFieldToken(name, value));
            } else if (typeof value === 'number') {
                fset.push(this.addFieldFloat(name, value));
            } else if (typeof value === 'boolean') {
                fset.push(this.addFieldBool(name, value));
            }
        }
        if (usdPrim.attributes.length > 0) {
            const tokens = usdPrim.attributes.map(child => child.name);
            fset.push(this.addFieldTokenVector('properties', tokens));
        }
        if (usdPrim.children.length > 0) {
            const tokens = usdPrim.children.map(child => child.name);
            fset.push(this.addFieldTokenVector('primChildren', tokens));
        }
        const fsetIndex = this.addFieldSet(fset);
        usdPrim.pathIndex = this.addSpec(fsetIndex, SpecType.Prim);
        const nameToken = this.getTokenIndex(usdPrim.name);
        const pathJump = usdPrim.getPathJump();
        // Add Prim Path
        this.addPath(usdPrim.pathIndex, nameToken, pathJump, false);
        // Write Prim Children
        for (const child of usdPrim.children) {
            this.writeUsdPrim(child);
        }
        // Write Prim Attributes
        for (const attribute of usdPrim.attributes) {
            if (attribute.isConnection()) {
                this.writeUsdConnection(attribute);
            } else if (attribute.isRelationship()) {
                this.writeUsdRelationship(attribute);
            } else {
                this.writeUsdAttribute(attribute);
            }
        }
    }

    writeUsd(usdData: UsdData) {
        usdData.updatePathIndices();
        this.writeBootstrap();
        // Add Root Metadata
        const fset: number[] = [];
        for (const name in usdData.metadata) {
            const value = usdData.metadata[name];
            if (typeof value === 'number') {
                fset.push(this.addFieldFloat(name, value));
            } else if (typeof value === 'string') {
                fset.push(this.addFieldToken(name, value));
            } else if (typeof value === 'boolean') {
                fset.push(this.addFieldBool(name, value));
            }
        }
        if (usdData.children.length > 0) {
            const tokens = usdData.children.map(child => child.name);
            fset.push(this.addFieldTokenVector('primChildren', tokens));
        }
        const fsetIndex = this.addFieldSet(fset);
        usdData.pathIndex = this.addSpec(fsetIndex, SpecType.PseudoRoot);
        // Add First Path
        const nameToken = this.getTokenIndex('');
        const pathJump = usdData.getPathJump();
        this.addPath(usdData.pathIndex, nameToken, pathJump, false);
        // Write the Children
        for (const child of usdData.children) {
            this.writeUsdPrim(child);
        }
        // Finish Writing the Crate File
        this.writeSections();
        this.writeTableOfContents();
    }

    getUsdz(): Uint8Array {
        return getUsdzFromUsdc(this.file);
    }
}
