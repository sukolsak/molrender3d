/**
 * Copyright (c) 2019-2021 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 * @author Jesse Liang <jesse.liang@rcsb.org>
 * @author Sukolsak Sakshuwong <sukolsak@stanford.edu>
 */

import getGLContext = require('gl')
import fs = require('fs')
import { PNG } from 'pngjs'
import * as JPEG from 'jpeg-js'
import { createContext } from 'molstar/lib/mol-gl/webgl/context';
import { Canvas3D, DefaultCanvas3DParams } from 'molstar/lib/mol-canvas3d/canvas3d';
import InputObserver from 'molstar/lib/mol-util/input/input-observer';
import { ColorTheme } from 'molstar/lib/mol-theme/color';
import { SizeTheme } from 'molstar/lib/mol-theme/size';
import { CartoonRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/cartoon';
import { MolecularSurfaceRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/molecular-surface';
import { GaussianSurfaceRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/gaussian-surface';
import { BallAndStickRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/ball-and-stick';
import { CarbohydrateRepresentationProvider } from 'molstar/lib/mol-repr/structure/representation/carbohydrate'
import { Model, Structure, StructureSymmetry, QueryContext, StructureSelection } from 'molstar/lib/mol-model/structure';
import { ModelSymmetry } from 'molstar/lib/mol-model-formats/structure/property/symmetry';
import { RepresentationProvider } from 'molstar/lib/mol-repr/representation';
import { compile } from 'molstar/lib/mol-script/runtime/query/compiler';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { StructureSelectionQueries as Q } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { ImagePass } from 'molstar/lib/mol-canvas3d/passes/image';
import { PrincipalAxes } from 'molstar/lib/mol-math/linear-algebra/matrix/principal-axes';
import { Vec3, Mat3, Mat4, EPSILON } from 'molstar/lib/mol-math/linear-algebra';
import { Box3D } from 'molstar/lib/mol-math/geometry/primitives/box3d';
import Expression from 'molstar/lib/mol-script/language/expression';
import { VisualQuality } from 'molstar/lib/mol-geo/geometry/base';
import { getStructureQuality } from 'molstar/lib/mol-repr/util';
import { Color } from 'molstar/lib/mol-util/color/color';
import { ColorNames } from 'molstar/lib/mol-util/color/names';
import { Camera } from 'molstar/lib/mol-canvas3d/camera';
import { SyncRuntimeContext } from 'molstar/lib/mol-task/execution/synchronous';
import { AssetManager } from 'molstar/lib/mol-util/assets';
import { Mesh, exportObj, exportGlb, exportUsdz } from './3d-exporter';
import { GraphicsRenderObject } from 'molstar/lib/mol-gl/render-object';
import { MeshValues } from 'molstar/lib/mol-gl/renderable/mesh';

/**
 * Helper method to create PNG with given PNG data
 */
async function writePngFile(png: PNG, outPath: string) {
    await new Promise<void>(resolve => {
        png.pack().pipe(fs.createWriteStream(outPath)).on('finish', resolve)
    })
}

async function writeJpegFile(jpeg: JPEG.BufferRet, outPath: string) {
    await new Promise<void>(resolve => {
        fs.writeFile(outPath, jpeg.data, () => resolve())
    })
}

async function writeObjFile(obj: string, objOutPath: string, mtl: string, mtlOutPath: string) {
    await Promise.all([
        new Promise<void>(resolve => {
            fs.writeFile(objOutPath, obj, () => resolve());
        }),
        new Promise<void>(resolve => {
            fs.writeFile(mtlOutPath, mtl, () => resolve());
        })
    ]);
}
async function writeFile(data: Buffer, outPath: string) {
    await new Promise<void>(resolve => {
        fs.writeFile(outPath, data, () => resolve());
    });
}

const tmpMatrixPos = Vec3.zero()
function getPositions(structure: Structure) {
    const positions = new Float32Array(structure.elementCount * 3)
    for (let i = 0, m = 0, il = structure.units.length; i < il; ++i) {
        const unit = structure.units[i]
        const { elements } = unit
        const pos = unit.conformation.position
        for (let j = 0, jl = elements.length; j < jl; ++j) {
            pos(elements[j], tmpMatrixPos)
            Vec3.toArray(tmpMatrixPos, positions, m + j * 3)
        }
        m += elements.length * 3
    }
    return positions
}

function getStructureFromExpression(structure: Structure, expression: Expression) {
    const compiled = compile<StructureSelection>(expression)
    const selection = compiled(new QueryContext(structure))
    return StructureSelection.unionStructure(selection)
}

function getColorTheme(structure: Structure) {
    if (structure.polymerUnitCount === 1) return 'sequence-id'
    else if (structure.polymerUnitCount < 40) return 'polymer-index'
    else return 'polymer-id'
}

enum StructureSize { Big, Medium, Small }

/**
 * Try to match fiber-like structures like 6nk4
 */
function isFiberLike(structure: Structure) {
    const polymerSymmetryGroups = structure.unitSymmetryGroups.filter(ug => {
        return ug.units[0].polymerElements.length > 0
    })

    return (
        polymerSymmetryGroups.length === 1 &&
        polymerSymmetryGroups[0].units.length > 2 &&
        polymerSymmetryGroups[0].units[0].polymerElements.length < 15
    )
}

function getStructureSize(structure: Structure): StructureSize {
    if (structure.polymerResidueCount > 4000) {
        return StructureSize.Big
    } else if (isFiberLike(structure)) {
        return StructureSize.Small
    } else if (structure.polymerResidueCount < 10) {
        return StructureSize.Small
    } else {
        return StructureSize.Medium
    }
}

function getQuality(structure: Structure): VisualQuality {
    const quality = getStructureQuality(structure)
    switch (quality) {
        case 'lowest':
        case 'lower':
        case 'low':
            return 'low'
        default:
            return quality
    }
}

interface ReprParams {
    colorTheme: string,
    sizeTheme: string,
    quality?: VisualQuality
}

/**
 * ImageRenderer class used to initialize 3dcanvas for rendering
 */
export class ImageRenderer {

    gl: WebGLRenderingContext
    reprCtx: {wegbl: any, colorThemeRegistry: any, sizeThemeRegistry: any}
    canvas3d: Canvas3D
    imagePass: ImagePass
    assetManager = new AssetManager()

    constructor(private width: number, private height: number, private format: 'png' | 'jpeg' | 'obj' | 'glb' | 'usdz') {
        this.gl = getGLContext(this.width, this.height, {
            alpha: false,
            antialias: true,
            depth: true,
            preserveDrawingBuffer: true,
            premultipliedAlpha: false
        })
        const webgl = createContext(this.gl)
        const input = InputObserver.create()
        this.canvas3d = Canvas3D.create(webgl, input, {
            camera: {
                mode: 'orthographic',
                helper: {
                    axes: { name: 'off', params: {} }
                }
            },
            renderer: {
                ...DefaultCanvas3DParams.renderer,
                backgroundColor: ColorNames.white,
            },
            postprocessing: {
                occlusion: {
                    name: 'off', params: {}
                },
                outline: {
                    name: 'off', params: {}
                }
            }
        })
        this.imagePass = this.canvas3d.getImagePass({
            drawPass: {
                cameraHelper: {
                    axes: { name: 'off', params: {} }
                }
            },
            multiSample: {
                mode: 'on',
                sampleLevel: 3
            }
        })
        this.imagePass.setSize(this.width, this.height)

        this.reprCtx = {
            wegbl: this.canvas3d.webgl,
            colorThemeRegistry: ColorTheme.createRegistry(),
            sizeThemeRegistry: SizeTheme.createRegistry()
        }
    }

    async addRepresentation(structure: Structure, provider: RepresentationProvider<any, any, any>, params: ReprParams) {
        if (provider.ensureCustomProperties) {
            await provider.ensureCustomProperties.attach({ assetManager: this.assetManager, runtime: SyncRuntimeContext }, structure)
        }
        const repr = provider.factory(this.reprCtx, provider.getParams)
        repr.setTheme({
            color: this.reprCtx.colorThemeRegistry.create(params.colorTheme, { structure }, { carbonByChainId: false }),
            size: this.reprCtx.sizeThemeRegistry.create(params.sizeTheme, { structure })
        })
        await repr.createOrUpdate({ ...provider.defaultValues, quality: params.quality || 'auto', ignoreHydrogens: true }, structure).run()
        this.canvas3d.add(repr)
    }

    async addCartoon(structure: Structure, params: Partial<ReprParams> = {}) {
        await this.addRepresentation(structure, CartoonRepresentationProvider, {
            colorTheme: getColorTheme(structure),
            sizeTheme: 'uniform',
            ...params
        })
    }

    async addGaussianSurface(structure: Structure, params: Partial<ReprParams> = {}) {
        await this.addRepresentation(structure, GaussianSurfaceRepresentationProvider, {
            colorTheme: getColorTheme(structure),
            sizeTheme: 'uniform',
            ...params
        })
    }

    async addMolecularSurface(structure: Structure, params: Partial<ReprParams> = {}) {
        await this.addRepresentation(structure, MolecularSurfaceRepresentationProvider, {
            colorTheme: getColorTheme(structure),
            sizeTheme: 'uniform',
            ...params
        })
    }

    async addBallAndStick(structure: Structure, params: Partial<ReprParams> = {}) {
        await this.addRepresentation(structure, BallAndStickRepresentationProvider, {
            colorTheme: 'element-symbol',
            sizeTheme: 'physical',
            ...params
        })
    }

    async addCarbohydrate(structure: Structure, params: Partial<ReprParams> = {}) {
        await this.addRepresentation(structure, CarbohydrateRepresentationProvider, {
            colorTheme: 'carbohydrate-symbol',
            sizeTheme: 'uniform',
            ...params
        })
    }

    /**
     * Creates OBJ/GLB/USDZ with the current 3dcanvas data
     */
    async create3DModel(outPath: string) {
        this.canvas3d.commit(true);

        // Group meshes by color and remove unused vertices.
        const meshByColor = new Map<Color, Mesh>();
        const transform = Mat4();
        const directionTransform = Mat3();
        const normalizeIfNecessary = (v: Vec3) => {
            const squaredMagnitude = Vec3.squaredMagnitude(v);
            if (squaredMagnitude < 1 - EPSILON || squaredMagnitude > 1 + EPSILON) {
                Vec3.scale(v, v, 1 / Math.sqrt(squaredMagnitude));
            }
        };
        const renderables = <GraphicsRenderObject[]>(<any>this.imagePass.drawPass).scene.renderables; // FIXME: Access the scene properly.
        for (const renderable of renderables) {
            const values = renderable.values as MeshValues;
            const positions = values.aPosition.ref.value;
            const normals = values.aNormal.ref.value;
            const faces = values.elements.ref.value;
            const colorType = values.dColorType.ref.value;
            const colors = values.tColor.ref.value.array;
            const drawCount = values.drawCount.ref.value;
            const instanceCount = values.instanceCount.ref.value;
            const transforms = values.aTransform.ref.value;
            for (let instanceIndex = 0; instanceIndex < instanceCount; ++instanceIndex) {
                Mat4.fromArray(transform, transforms, instanceIndex * 16);
                Mat3.directionTransform(directionTransform, transform);
                const isIdentity = Mat4.isIdentity(transform);

                if (colorType === 'instance') {
                    const instance = values.aInstance.ref.value[instanceIndex];
                    const color = Color.fromArray(colors, instance * 3);
                    let mesh = meshByColor.get(color);
                    if (mesh === undefined) {
                        mesh = { positions: [], normals: [], faces: [] };
                        meshByColor.set(color, mesh);
                    }
                    const { positions: positions2, normals: normals2, faces: faces2 } = mesh;
                    const vMap = new Map<number, number>();
                    for (let i = 0; i < drawCount; ++i) {
                        const vi = faces[i];
                        let vi2 = vMap.get(vi);
                        if (vi2 === undefined) {
                            vi2 = positions2.length;
                            vMap.set(vi, vi2);
                            const position = Vec3();
                            const normal = Vec3();
                            Vec3.fromArray(position, positions, vi * 3);
                            Vec3.fromArray(normal, normals, vi * 3);
                            normalizeIfNecessary(normal);
                            if (!isIdentity) {
                                Vec3.transformMat4(position, position, transform);
                                Vec3.transformMat3(normal, normal, directionTransform);
                            }
                            positions2.push(position);
                            normals2.push(normal);
                        }
                        faces2.push(vi2);
                    }
                } else if (colorType === 'group') {
                    const groups = values.aGroup.ref.value;
                    const colorToVMap = new Map<Color, Map<number, number>>();
                    for (let i = 0; i < drawCount; i += 3) {
                        const group = groups[faces[i]];
                        const color = Color.fromArray(colors, group * 3); // We assume that each face has a uniform color.
                        let mesh = meshByColor.get(color);
                        if (mesh === undefined) {
                            mesh = { positions: [], normals: [], faces: [] };
                            meshByColor.set(color, mesh);
                        }
                        const { positions: positions2, normals: normals2, faces: faces2 } = mesh;
                        let vMap = colorToVMap.get(color);
                        if (vMap === undefined) {
                            vMap = new Map<number, number>();
                            colorToVMap.set(color, vMap);
                        }
                        for (let j = 0; j < 3; ++j) {
                            const vi = faces[i + j];
                            let vi2 = vMap.get(vi);
                            if (vi2 === undefined) {
                                vi2 = positions2.length;
                                vMap.set(vi, vi2);
                                const position = Vec3();
                                const normal = Vec3();
                                Vec3.fromArray(position, positions, vi * 3);
                                Vec3.fromArray(normal, normals, vi * 3);
                                normalizeIfNecessary(normal);
                                if (!isIdentity) {
                                    Vec3.transformMat4(position, position, transform);
                                    Vec3.transformMat3(normal, normal, directionTransform);
                                }
                                positions2.push(position);
                                normals2.push(normal);
                            }
                            faces2.push(vi2);
                        }

                    }
                } else {
                    throw new Error(`Color type '${colorType}' is currently not supported`);
                }
            }
        }

        // Rotate the model according to the camera's orientation.
        const up = Vec3();
        const forward = Vec3();
        const right = Vec3();
        const cameraState = this.canvas3d.camera.state;
        Vec3.normalize(up, cameraState.up);
        Vec3.normalize(forward, Vec3.sub(forward, cameraState.position, cameraState.target));
        Vec3.cross(right, up, forward);
        const rotationMatrix = Mat3.create(
            right[0], up[0], forward[0],
            right[1], up[1], forward[1],
            right[2], up[2], forward[2],
        );
        meshByColor.forEach(mesh => {
            for (const position of mesh.positions) {
                Vec3.transformMat3(position, position, rotationMatrix);
            }
            for (const normal of mesh.normals) {
                Vec3.transformMat3(normal, normal, rotationMatrix);
            }
        });

        // Translate and scale the model so that it sits on the y=0 plane and fits within the view.
        const box = Box3D();
        Box3D.setEmpty(box);
        meshByColor.forEach(mesh => {
            for (const position of mesh.positions) {
                Box3D.add(box, position);
            }
        });
        const translate = Vec3.create(-(box.min[0] + box.max[0]) / 2, -box.min[1], -(box.min[2] + box.max[2]) / 2);
        const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
        const scale = (this.format === 'glb') ? Math.min(0.4 / size, 0.01) : (this.format === 'usdz') ? Math.min(40 / size, 1) : 1;
        meshByColor.forEach(mesh => {
            for (const position of mesh.positions) {
                Vec3.add(position, position, translate);
                Vec3.scale(position, position, scale);
            }
        });

        if (this.format === 'obj') {
            const outPathComponents = outPath.split(/\/|\\/);
            const outName = outPathComponents[outPathComponents.length - 1];
            const { obj, mtl } = exportObj(meshByColor, outName);
            await writeObjFile(obj, `${outPath}.obj`, mtl, `${outPath}.mtl`);
        } else if (this.format === 'glb') {
            const glb = exportGlb(meshByColor);
            await writeFile(glb, `${outPath}.glb`);
        } else if (this.format === 'usdz') {
            const usdz = exportUsdz(meshByColor);
            await writeFile(usdz, `${outPath}.usdz`);
        }
    }

    async createImage(outPath: string, size: StructureSize) {
        if (this.format === 'obj' || this.format === 'glb' || this.format === 'usdz') {
            await this.create3DModel(outPath);
            return;
        }

        const occlusion = size === StructureSize.Big ? { name: 'on' as const, params: {
            kernelSize: 4,
            bias: 0.5,
            radius: 64,
        } } : { name: 'off' as const, params: {} }
        const outline = size === StructureSize.Big ? { name: 'on' as const, params: {
            scale: 1,
            threshold: 1.2,
        } } : { name: 'off' as const, params: {} }

        this.canvas3d.commit(true)

        this.imagePass.setProps({
            postprocessing: {
                occlusion,
                outline
            }
        })

        this.imagePass.render()
        const imageData = this.imagePass.colorTarget.getPixelData()

        if (this.format === 'png') {
            const generatedPng = new PNG({ width: this.width, height: this.height })
            generatedPng.data = Buffer.from(imageData.array)
            await writePngFile(generatedPng, `${outPath}.png`)
        } else if (this.format === 'jpeg') {
            const generatedJpeg = JPEG.encode({
                data: imageData.array,
                width: this.width,
                height: this.height
            }, 90)
            await writeJpegFile(generatedJpeg, `${outPath}.jpeg`)
        } else {
            throw new Error(`unknown image type '${this.format}'`)
        }
    }

    focusCamera(structure: Structure) {
        const principalAxes = PrincipalAxes.ofPositions(getPositions(structure))
        const { origin, dirA, dirC } = principalAxes.boxAxes
        const radius = Vec3.magnitude(dirA)

        // move camera far in the direction from the origin, so we get a view from the outside
        const position = Vec3()
        Vec3.scaleAndAdd(position, position, origin, 100)
        this.canvas3d.camera.setState({ position }, 0)

        // tight zoom
        this.canvas3d.camera.focus(origin, radius, 0, dirA, dirC)

        // ensure nothing is clipped off in the front
        const state = Camera.copySnapshot(Camera.createDefaultSnapshot(), this.canvas3d.camera.state)
        state.radius = structure.boundary.sphere.radius
        state.radiusMax = structure.boundary.sphere.radius
        this.canvas3d.camera.setState(state)
    }

    /**
     * Renders the assembly
     */
    async renderAssembly(asmIndex: number, model: Model, outPath: string, fileName: string) {
        const symmetry = ModelSymmetry.Provider.get(model)!
        const asmId = symmetry.assemblies[asmIndex].id
        console.log(`Rendering ${fileName} assembly ${asmId}...`)

        const modelStructure = Structure.ofModel(model)
        const structure = await StructureSymmetry.buildAssembly(modelStructure, symmetry.assemblies[asmIndex].id).run()
        const size = getStructureSize(structure)
        const quality = getQuality(structure)
        let focusStructure: Structure

        if (size === StructureSize.Big) {
            focusStructure = getStructureFromExpression(structure, Q.polymer.expression)
            await this.addGaussianSurface(focusStructure, { quality })
        } else {
            await this.addCartoon(getStructureFromExpression(structure, Q.polymer.expression), { quality })
            await this.addCarbohydrate(getStructureFromExpression(structure, Q.branchedPlusConnected.expression), { quality })
            if (size === StructureSize.Small) {
                focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.modifier.exceptBy({
                        0: MS.struct.generator.all(),
                        by: Q.water.expression
                    })
                ]))
                await this.addBallAndStick(focusStructure, { quality })
            } else {
                await this.addBallAndStick(getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.combinator.merge([
                        Q.ligandPlusConnected.expression,
                        Q.branchedConnectedOnly.expression,
                        Q.disulfideBridges.expression,
                        Q.nonStandardPolymer.expression
                    ])
                ])), { quality })
                focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.combinator.merge([
                        Q.trace.expression,
                        Q.nucleic.expression,
                        Q.branchedPlusConnected.expression,
                        Q.ligandPlusConnected.expression,
                        Q.branchedConnectedOnly.expression,
                        Q.disulfideBridges.expression,
                        Q.nonStandardPolymer.expression
                    ])
                ]))
            }
        }

        this.focusCamera(focusStructure)

        // Write png to file
        let imagePathName = `${outPath}/${fileName}_assembly-${asmId}`
        await this.createImage(imagePathName, size)

        // Finished writing to file and clear canvas
        console.log('Finished.')

        this.canvas3d.clear()
    }

    /**
     * Renders the model
     */
    async renderModel(oneIndex: number, model: Model, outPath: string, fileName: string) {
        console.log(`Rendering ${fileName} model ${model.modelNum} with index ${oneIndex}...`)

        const structure = Structure.ofModel(model)
        const size = getStructureSize(structure)
        const quality = getQuality(structure)
        let focusStructure: Structure

        if (size === StructureSize.Big) {
            focusStructure = getStructureFromExpression(structure, Q.polymer.expression)
            await this.addGaussianSurface(focusStructure, { quality })
        } else {
            await this.addCartoon(getStructureFromExpression(structure, Q.polymer.expression), { quality })
            await this.addCarbohydrate(getStructureFromExpression(structure, Q.branchedPlusConnected.expression), { quality })
            if (size === StructureSize.Small) {
                focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.modifier.exceptBy({
                        0: MS.struct.generator.all(),
                        by: Q.water.expression
                    })
                ]))
                await this.addBallAndStick(focusStructure, { quality })
            } else {
                await this.addBallAndStick(getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.combinator.merge([
                        Q.ligandPlusConnected.expression,
                        Q.branchedConnectedOnly.expression,
                        Q.disulfideBridges.expression,
                        Q.nonStandardPolymer.expression
                    ])
                ])), { quality })
                focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.combinator.merge([
                        Q.trace.expression,
                        Q.nucleic.expression,
                        Q.branchedPlusConnected.expression,
                        Q.ligandPlusConnected.expression,
                        Q.branchedConnectedOnly.expression,
                        Q.disulfideBridges.expression,
                        Q.nonStandardPolymer.expression
                    ])
                ]))
            }
        }

        this.focusCamera(focusStructure)

        // Write png to file
        let imagePathName = `${outPath}/${fileName}_model-${oneIndex}`
        await this.createImage(imagePathName, size)

        // Finished writing to file and clear canvas
        console.log('Finished.')
        this.canvas3d.clear()
    }

    /**
     * Renders the chain
     */
    async renderChain(chainName: string, model: Model, outPath: string, fileName: string) {
        console.log(`Rendering ${fileName} chain ${chainName}...`)

        const modelStructure = Structure.ofModel(model)
        const structure = getStructureFromExpression(modelStructure, MS.struct.generator.atomGroups({
            'chain-test': MS.core.rel.eq([MS.ammp('label_asym_id'), chainName])
        }))
        const size = getStructureSize(structure)
        const quality = getQuality(structure)
        let focusStructure: Structure

        if (size === StructureSize.Big) {
            focusStructure = getStructureFromExpression(structure, Q.polymer.expression)
            await this.addGaussianSurface(focusStructure, { quality })
        } else {
            await this.addCartoon(getStructureFromExpression(structure, Q.polymer.expression), { quality })
            if (size === StructureSize.Small) {
                focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.modifier.exceptBy({
                        0: MS.struct.generator.all(),
                        by: Q.water.expression
                    })
                ]))
                await this.addBallAndStick(focusStructure, { quality })
            } else {
                await this.addBallAndStick(getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.combinator.merge([
                        Q.ligandPlusConnected.expression,
                        Q.disulfideBridges.expression,
                        Q.nonStandardPolymer.expression,
                    ])
                ])), { quality })
                focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                    MS.struct.combinator.merge([
                        Q.trace.expression,
                        Q.nucleic.expression,
                        Q.ligandPlusConnected.expression,
                        Q.disulfideBridges.expression,
                        Q.nonStandardPolymer.expression,
                    ])
                ]))
            }
        }

        this.focusCamera(focusStructure)

        // Write png to file
        let imagePathName = `${outPath}/${fileName}_chain-${chainName}`
        await this.createImage(imagePathName, size)

        // Finished writing to file and clear canvas
        console.log('Finished.')
        this.canvas3d.clear()
    }

    async renderModels(models: ReadonlyArray<Model>, outPath: string, fileName: string) {
        console.log(`Rendering ${fileName} models`)

        const structure = Structure.ofTrajectory(models)
        const firstModelStructure = Structure.ofModel(models[0])
        const size = getStructureSize(firstModelStructure)
        const quality = getQuality(firstModelStructure)
        const colorTheme = firstModelStructure.polymerUnitCount === 1 ? 'sequence-id' : 'polymer-id'
        let focusStructure: Structure

        await this.addCartoon(getStructureFromExpression(structure, Q.polymer.expression), { quality, colorTheme })
        await this.addCarbohydrate(getStructureFromExpression(structure, Q.branchedPlusConnected.expression), { quality })
        if (size === StructureSize.Small) {
            focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                MS.struct.modifier.exceptBy({
                    0: MS.struct.generator.all(),
                    by: Q.water.expression
                })
            ]))
            await this.addBallAndStick(focusStructure, { quality })
        } else {
            await this.addBallAndStick(getStructureFromExpression(structure, MS.struct.modifier.union([
                MS.struct.combinator.merge([
                    Q.ligandPlusConnected.expression,
                    Q.branchedConnectedOnly.expression,
                    Q.disulfideBridges.expression,
                    Q.nonStandardPolymer.expression
                ])
            ])), { quality })
            focusStructure = getStructureFromExpression(structure, MS.struct.modifier.union([
                MS.struct.combinator.merge([
                    Q.trace.expression,
                    Q.nucleic.expression,
                    Q.branchedPlusConnected.expression,
                    Q.ligandPlusConnected.expression,
                    Q.branchedConnectedOnly.expression,
                    Q.disulfideBridges.expression,
                    Q.nonStandardPolymer.expression
                ])
            ]))
        }

        this.focusCamera(focusStructure)

        // Write png to file
        let imagePathName = `${outPath}/${fileName}_models`
        await this.createImage(imagePathName, size)

        // Finished writing to file and clear canvas
        console.log('Finished.')
        this.canvas3d.clear()
    }

    /**
     * Render chains, models, and assemblies of a single structure
     * @param inPath path to mmCIF file
     * @param outPath directory to put rendered images
     */
    async renderAll(models: ReadonlyArray<Model>, outPath: string, fileName: string) {
        // Render all models
        for (let i = 0; i < models.length; i++) {
            await this.renderModel(i + 1, models[i], outPath, fileName)
        }

        // Render all assemblies
        const assemblies = ModelSymmetry.Provider.get(models[0])?.assemblies || []
        for (let i = 0, il = assemblies.length; i < il; i++) {
            await this.renderAssembly(i, models[0], outPath, fileName)
        }

        const { entities } = models[0]
        const { label_asym_id, label_entity_id } = models[0].atomicHierarchy.chains

        // Render all polymer chains
        for (let i = 0, il = label_asym_id.rowCount; i < il; i++) {
            const eI = entities.getEntityIndex(label_entity_id.value(i))
            if (entities.data.type.value(eI) !== 'polymer') continue
            const chnName = label_asym_id.value(i)
            await this.renderChain(chnName, models[0], outPath, fileName)
        }

        // Render models ensemble
        if (models.length > 1) {
            await this.renderModels(models, outPath, fileName)
        }
    }
}