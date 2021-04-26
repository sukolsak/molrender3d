/**
 * Copyright (c) 2021 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Sukolsak Sakshuwong <sukolsak@stanford.edu>
 */

import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { Color } from 'molstar/lib/mol-util/color/color';
import { ValueType, UsdAttribute, UsdData, CrateFile } from './usdz';

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
    const binaryBuffer: ArrayBuffer[] = [];
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
        const faceBuffer = new Uint32Array(faces).buffer;
        const positionBuffer = flattenVec3s(positions).buffer;
        const normalBuffer = flattenVec3s(normals).buffer;
        binaryBuffer.push(faceBuffer, positionBuffer, normalBuffer);
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
            'byteLength': faceBuffer.byteLength,
            'target': 34963 // ELEMENT_ARRAY_BUFFER
        });
        byteOffset += faceBuffer.byteLength;
        bufferViews.push({
            'buffer': 0,
            'byteOffset': byteOffset,
            'byteLength': positionBuffer.byteLength,
            'target': 34962 // ARRAY_BUFFER
        });
        byteOffset += positionBuffer.byteLength;
        bufferViews.push({
            'buffer': 0,
            'byteOffset': byteOffset,
            'byteLength': normalBuffer.byteLength,
            'target': 34962 // ARRAY_BUFFER
        });
        byteOffset += normalBuffer.byteLength;

        accessors.push({
            'bufferView': accessorOffset,
            'byteOffset': 0,
            'componentType': 5125, // UNSIGNED_INT
            'count': faces.length,
            'type': 'SCALAR'
        });
        accessors.push({
            'bufferView': accessorOffset + 1,
            'byteOffset': 0,
            'componentType': 5126, // FLOAT
            'count': positions.length,
            'type': 'VEC3',
            'max': positionMax,
            'min': positionMin
        });
        accessors.push({
            'bufferView': accessorOffset + 2,
            'byteOffset': 0,
            'componentType': 5126, // FLOAT
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
    const binaryBufferLength = byteOffset;

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
            'byteLength': binaryBufferLength,
        }],
        'bufferViews': bufferViews,
        'accessors': accessors,
        'materials': materials
    };

    const createChunk = (chunkType: number, buf: ArrayBuffer[], byteLength: number, padChar: number): [ArrayBuffer[], number] => {
        let padding = null;
        if (byteLength % 4 !== 0) {
            const pad = 4 - (byteLength % 4);
            byteLength += pad;
            padding = new Uint8Array(pad);
            padding.fill(padChar);
        }
        const tmp = [new Uint32Array([byteLength, chunkType]).buffer, ...buf];
        if (padding) {
            tmp.push(padding.buffer);
        }
        return [ tmp, byteLength + 8 ];
    };
    const jsonString = JSON.stringify(gltf);
    const jsonBuffer = new Uint8Array(jsonString.length);
    for (let i = 0, il = jsonString.length; i < il; ++i) {
        jsonBuffer[i] = jsonString.charCodeAt(i);
    }

    const [ jsonChunk, jsonChunkLength ] = createChunk(0x4E4F534A, [jsonBuffer.buffer], jsonBuffer.length, 0x20);
    const [ binaryChunk, binaryChunkLength ] = createChunk(0x004E4942, binaryBuffer, binaryBufferLength, 0x00);
    const glbBufferLength = 12 + jsonChunkLength + binaryChunkLength;
    const glbBuffer = [
        new Uint32Array([
            0x46546C67, // magic number "gltf"
            0x00000002, // version
            glbBufferLength
        ]).buffer,
        ...jsonChunk,
        ...binaryChunk
    ];

    const glb = new Uint8Array(glbBufferLength);
    let offset = 0;
    for (const buffer of glbBuffer) {
        glb.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return glb;
}

export function exportUsdz(meshByColor: Map<Color, Mesh>) {
    const root = new UsdData('', '');
    const usdObj = root.createChild('ar', 'Xform');
    usdObj.metadata['assetInfo'] = {'name': 'ar'};
    usdObj.metadata['kind'] = 'component';

    const materials_scope = usdObj.createChild('Materials', 'Scope');

    let refId = 0;

    const vecsToFloatArray = (v: number[][]) => {
        const a = new Float32Array(v.length * 3);
        for (let i = 0; i < v.length; ++i) {
            a[i * 3] = v[i][0];
            a[i * 3 + 1] = v[i][1];
            a[i * 3 + 2] = v[i][2];
        }
        return a;
    };

    meshByColor.forEach((mesh, color) => {
        const { positions, normals, faces } = mesh;
        const positions2 = vecsToFloatArray(positions);
        const normals2 = vecsToFloatArray(normals);
        const faceVertexCounts = new Uint32Array(faces.length / 3);
        faceVertexCounts.fill(3);

        const rgb = new Float32Array(Color.toRgbNormalized(color));
        const usdMaterial = materials_scope.createChild('k' + String(refId), 'Material');

        const usdShader = usdMaterial.createChild('surfaceShader', 'Shader');
        const infoIdAtt = new UsdAttribute('info:id', 'UsdPreviewSurface', ValueType.token, 'token');
        infoIdAtt.addQualifier('uniform');
        usdShader.addAttribute(infoIdAtt);
        usdShader.addAttribute(new UsdAttribute('inputs:diffuseColor', rgb, ValueType.vec3f, 'color3f'));
        usdShader.addAttribute(new UsdAttribute('inputs:roughness', 0.2, ValueType.float, 'float'));
        const surface = new UsdAttribute('outputs:surface', null, ValueType.token, 'token');
        usdShader.addAttribute(surface);

        usdMaterial.addAttribute(new UsdAttribute('outputs:surface', surface, ValueType.Invalid, 'token'));

        const usdMesh = usdObj.createChild('m' + String(refId), 'Mesh');
        usdMesh.addAttribute(new UsdAttribute('material:binding', usdMaterial, ValueType.Invalid, 'rel'));
        usdMesh.addAttribute(new UsdAttribute('doubleSided', false, ValueType.bool, 'bool'));
        usdMesh.addAttribute(new UsdAttribute('faceVertexCounts', faceVertexCounts, ValueType.int, 'int[]', true));
        usdMesh.addAttribute(new UsdAttribute('faceVertexIndices', faces, ValueType.int, 'int[]', true));
        usdMesh.addAttribute(new UsdAttribute('points', positions2, ValueType.vec3f, 'point3f[]', true));
        const normalsAtt = new UsdAttribute('primvars:normals', normals2, ValueType.vec3f, 'normal3f[]', true);
        normalsAtt.metadata['interpolation'] = 'vertex';
        usdMesh.addAttribute(normalsAtt);
        const subdivAtt = new UsdAttribute('subdivisionScheme', 'none', ValueType.token, 'token');
        subdivAtt.addQualifier('uniform');
        usdMesh.addAttribute(subdivAtt);

        refId++;
    });

    const crateFile = new CrateFile();
    crateFile.writeUsd(root);
    const usdz = crateFile.getUsdz();
    return usdz;
}
