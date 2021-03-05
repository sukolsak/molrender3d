/**
 * Copyright (c) 2021 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Sukolsak Sakshuwong <sukolsak@stanford.edu>
 */

import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { Color } from 'molstar/lib/mol-util/color/color';

function computeBounding(points: Vec3[]) {
    const min = Vec3.create(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
    const max = Vec3.create(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE);
    for (const point of points) {
        min[0] = Math.min(point[0], min[0]);
        min[1] = Math.min(point[1], min[1]);
        min[2] = Math.min(point[2], min[2]);
        max[0] = Math.max(point[0], max[0]);
        max[1] = Math.max(point[1], max[1]);
        max[2] = Math.max(point[2], max[2]);
    }
    return { min, max };
}

export interface Mesh {
    positions: Vec3[],
    normals: Vec3[],
    faces: number[]
}

export function exportObj(meshByColor: Map<Color, Mesh>, outName: string) {
    const objLines: string[] = [];
    const mtlLines: string[] = [];
    objLines.push('mtllib ' + outName + '.mtl');
    let refId = 0;
    let pointOffset = 1;
    meshByColor.forEach((mesh, color) => {
        const { positions, normals, faces } = mesh;
        objLines.push('g m' + refId);
        objLines.push('usemtl k' + refId);
        for (const position of positions) {
            objLines.push('v ' + position[0] + ' ' + position[1] + ' ' + position[2]);
        }
        for (const normal of normals) {
            objLines.push('vn ' + normal[0] + ' ' + normal[1] + ' ' + normal[2]);
        }
        for (let i = 0; i < faces.length; i += 3) {
            let line = 'f';
            for (let j = 0; j < 3; ++j) {
                const point = pointOffset + faces[i + j];
                line += ' ' + point + '//' + point;
            }
            objLines.push(line);
        }
        pointOffset += positions.length;
        const [r, g, b] = Color.toRgbNormalized(color);
        mtlLines.push('newmtl k' + refId + '\n' +
            'Ns 163\n' +
            'Ni 0.001\n' +
            'illum 2\n' +
            'Ka 0.20 0.20 0.20\n' +
            'Kd ' + r + ' ' + g + ' ' + b + '\n' +
            'Ks 0.25 0.25 0.25');
        refId += 1;
    });
    const obj = objLines.join('\n');
    const mtl = mtlLines.join('\n');
    return { obj, mtl };
}

export function exportGlb(meshByColor: Map<Color, Mesh>) {
    const primitives: Record<string, any>[] = [];
    const accessors: Record<string, any>[] = [];
    const bufferViews: Record<string, any>[] = [];
    const buffers: Buffer[] = [];
    const materials: Record<string, any>[] = [];
    let byteOffset = 0;

    const flattenVec3s = (vs: Vec3[]) => {
        const array = new Float32Array(vs.length * 3);
        for (let i = 0; i < vs.length; ++i) {
            Vec3.toArray(vs[i], array, i * 3);
        }
        return array;
    };

    meshByColor.forEach((mesh, color) => {
        const { positions, normals, faces } = mesh;
        const accessorOffset = accessors.length;
        const faceBuffer = Buffer.from(new Uint32Array(faces).buffer);
        const positionBuffer = Buffer.from(flattenVec3s(positions).buffer);
        const normalBuffer = Buffer.from(flattenVec3s(normals).buffer);
        buffers.push(faceBuffer, positionBuffer, normalBuffer);
        const materialOffset = materials.length;
        const { min: positionMin, max: positionMax } = computeBounding(positions);

        primitives.push({
            'attributes': {
                'POSITION': accessorOffset + 1,
                'NORMAL': accessorOffset + 2
            },
            'indices': accessorOffset,
            'material': materialOffset
        });

        bufferViews.push({
            'buffer': 0,
            'byteOffset': byteOffset,
            'byteLength': faceBuffer.length,
            'target': 34963
        });
        byteOffset += faceBuffer.length;
        bufferViews.push({
            'buffer': 0,
            'byteOffset': byteOffset,
            'byteLength': positionBuffer.length,
            'target': 34962
        });
        byteOffset += positionBuffer.length;
        bufferViews.push({
            'buffer': 0,
            'byteOffset': byteOffset,
            'byteLength': normalBuffer.length,
            'target': 34962
        });
        byteOffset += normalBuffer.length;

        accessors.push({
            'bufferView': accessorOffset,
            'byteOffset': 0,
            'componentType': 5125, // unsigned int
            'count': faces.length,
            'type': 'SCALAR'
        });
        accessors.push({
            'bufferView': accessorOffset + 1,
            'byteOffset': 0,
            'componentType': 5126, // float
            'count': positions.length,
            'type': 'VEC3',
            'max': positionMax,
            'min': positionMin
        });
        accessors.push({
            'bufferView': accessorOffset + 2,
            'byteOffset': 0,
            'componentType': 5126, // float
            'count': normals.length,
            'type': 'VEC3'
        });

        const [r, g, b] = Color.toRgbNormalized(color);
        materials.push({
            'pbrMetallicRoughness': {
                'baseColorFactor': [r, g, b, 1.0],
                'metallicFactor': 0,
                'roughnessFactor': 0.5
            }
        });
    });
    const binaryBuffer = Buffer.concat(buffers);

    const gltf = {
        'asset': {
            'version': '2.0'
        },
        'scenes': [{
            'nodes': [ 0 ]
        }],
        'nodes': [{
            'mesh': 0
        }],
        'meshes': [{
            'primitives': primitives
        }],
        'buffers': [{
            'byteLength': binaryBuffer.length,
        }],
        'bufferViews': bufferViews,
        'accessors': accessors,
        'materials': materials
    };

    const createChunk = (chunkType: number, buf: Buffer, padChar: number) => {
        let bufBytes = buf.length;
        let padding = null;
        if (bufBytes % 4 !== 0) {
            const pad = 4 - (bufBytes % 4);
            bufBytes += pad;
            padding = Buffer.alloc(pad, padChar);
        }
        const tmp = [Buffer.from(new Uint32Array([bufBytes, chunkType]).buffer), buf];
        if (padding) {
            tmp.push(padding);
        }
        return Buffer.concat(tmp);
    };
    const jsonChunk = createChunk(0x4E4F534A, Buffer.from(JSON.stringify(gltf)), 0x20);
    const binaryChunk = createChunk(0x004E4942, binaryBuffer, 0x00);
    const glb = Buffer.concat([
        Buffer.from(new Uint32Array([
            0x46546C67, // magic number "gltf"
            0x00000002, // version
            12 + jsonChunk.length + binaryChunk.length // total length
        ]).buffer),
        jsonChunk,
        binaryChunk
    ]);
    return glb;
}
