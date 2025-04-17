import { renderPPP } from "ppp-tools";
import { handleInput } from "input-helper";
import { guid, removeFromArray, distBetweenPoints, hexToRGB, randomIntFromInterval } from "common-helpers";

window.addEventListener("resize", onResize);

const TARGET_FRAMERATE = 60;
const TARGET_DELTA = 1000 / TARGET_FRAMERATE;
const DEF_TILE_SIZE = 16;
const TEXTURE_CYCLE_MAX = 8;
const PI_ONE_EIGHTY = Math.PI / 180;

let textureCycleCounter = 0;

let allTextures = [];

let engineInstances = {};

let instructionRecycling = [];

let overrideOffTurn = false;

let lastRAF = null;

export function getPixelEngineInstance(holder, options) {
    if(!options) {
        options = {};
    }

    const engine = new PixelEngineInstance(holder, options);

    engineInstances[engine.id] = engine;

    return engine;
}

export function loadTexture(options) {
    const texture = new Texture(options);

    allTextures.push(texture);

    return texture;
}

export function getTargetFramerate() {
    return TARGET_FRAMERATE;
}

export function isOdd(num) {
    return num % 2;
}

export function onResize() {
    for(let instanceId in engineInstances) {
        const instance = engineInstances[instanceId];
        resizeInstance(instance);
    }
}

export class PixelEngineInstance {
    constructor(holder, options) {
        const instanceRef = this;

        this.id = guid();

        this.initOptions = options;

        this.fixedCanvas = false;
        this.holder = holder;

        if(options.fixedCanvas) {
            this.fixedCanvas = true;

            this.canvas = options.fixedCanvas;
        } else {
            
            this.holder.innerHTML = "";
            
            this.canvas = document.createElement("canvas");

            this.canvas.style.width = "100%";
            this.canvas.style.height = "100%";

            this.holder.appendChild(this.canvas);
        }

        this.holder.style.overflow = "hidden";

        this.context = this.canvas.getContext("2d", {
            willReadFrequently: true
        });


        this.canvas.style.imageRendering = "pixelated";
        this.context.imageSmoothingEnabled = false;

        this.width = 256;
        this.height = 224;
        this.tileSize = DEF_TILE_SIZE;

        this.viewX = 0;
        this.viewY = 0;

        this.viewXraw = 0;
        this.viewYraw = 0;

        this.renderFunction = null;
        this.clickFunction = null;
        this.touchstickFunction = null;
        this.hoverFunction = null;

        this.touchstickLeftX = -1;
        this.touchstickLeftY = -1;
        this.touchstickLeftId = null;
        this.touchstickLeftMX = -1;
        this.touchstickLeftMY = -1;

        this.touchstickRightX = -1;
        this.touchstickRightY = -1;
        this.touchstickRightId = null;
        this.touchstickRightMX = -1;
        this.touchstickRightMY = -1;

        this.touchstickRadius = 40;

        this.renderInstructions = [];
        this.activeLights = [];

        if(options.width) {
            this.width = options.width;
        }

        this.lighting = {
            r: 255,
            g: 255,
            b: 255,
            i: 1
        };

        this.weightedLighting = {
            r: 255,
            g: 255,
            b: 255
        };

        this.filters = [];

        handleInput({
            element: instanceRef.canvas,
            down: function(e) {
                onPointerDown(instanceRef, instanceRef.canvas, e.id, e.x, e.y, e.type, e.pressure, e.which, e.pageX, e.pageY);
            },
            move: function(e) {
                onPointerMove(instanceRef, instanceRef.canvas, e.id, e.x, e.y, e.type, e.pressure, e.which, e.pageX, e.pageY);
            },
            up: function(e) {
                onPointerUp(instanceRef, instanceRef.canvas, e.id, e.type, e.which, e.evt);
            }
        });

        this.deInit = false;

        resizeInstance(instanceRef);
    }

    getViewBounds() {
        const instance = this;

        const xMin = Math.floor(instance.viewX / instance.tileSize);
        const yMin = Math.floor(instance.viewY / instance.tileSize);

        const xMax = Math.ceil((instance.viewX + instance.width) / instance.tileSize);
        const yMax = Math.ceil((instance.viewY + instance.height) / instance.tileSize);

        const cx = Math.floor((instance.viewX + (instance.width / 2)) / instance.tileSize);
        const cy = Math.floor((instance.viewY + (instance.height / 2)) / instance.tileSize);

        return {
            w: instance.width,
            h: instance.height,
            xMin: xMin,
            yMin: yMin,
            xMax: xMax,
            yMax: yMax,
            cx: cx,
            cy: cy
        };
    }

    getLightingAtPosition(x, y) {
        const instance = this;

        let r = instance.weightedLighting.r;
        let g = instance.weightedLighting.g;
        let b = instance.weightedLighting.b;

        for(let i = 0; i < instance.activeLights.length; i++) {
            const light = instance.activeLights[i];
            const dist = distBetweenPoints(x, y, light.x, light.y);

            if(dist > light.scale) {
                continue;
            }

            const bPer = 1 - (dist / light.scale);
            const brightness = light.frame * bPer;

            if(light.frame > 0 && brightness > 0) {
                r += light.opacity * brightness;
                g += light.rotation * brightness;
                b += light.z * brightness;
            }

            if(light.frame < 0 && brightness < 0) {
                r += light.opacity * brightness;
                g += light.rotation * brightness;
                b += light.z * brightness;
            }
        }

        return {
            r: r,
            g: g,
            b: b
        };
    }

    setLighting(hex, intensity) {
        const instance = this;

        const rgb = hexToRGB(hex);

        instance.lighting.r = rgb.r;
        instance.lighting.g = rgb.g;
        instance.lighting.b = rgb.b;
        instance.lighting.i = intensity;

        const darknessWeight = 1 - intensity;

        instance.weightedLighting.r = weighColors(0, instance.lighting.r, darknessWeight, instance.lighting.i);
        instance.weightedLighting.g = weighColors(0, instance.lighting.g, darknessWeight, instance.lighting.i);
        instance.weightedLighting.b = weighColors(0, instance.lighting.b, darknessWeight, instance.lighting.i);
    }

    setFilters(filters) {
        const instance = this;

        if(!filters || filters.length == 0) {
            instance.filters = [];
            return;
        }

        if(Array.isArray(filters)) {
            instance.filters = filters;
        } else {
            instance.filters = filters.split(",");
        }
    }

    setRenderFunction(func) {
        const instance = this;
        instance.renderFunction = func;
    }

    setViewCenter(x, y) {
        const instance = this;

        const rawX = x * instance.tileSize;
        const rawY = y * instance.tileSize;

        instance.viewXraw = rawX - (instance.width / 2);
        instance.viewYraw = rawY - (instance.height / 2);

        instance.viewX = Math.round(instance.viewXraw);
        instance.viewY = Math.round(instance.viewYraw);
    }

    setClickFunction(func) {
        const instance = this;
        instance.clickFunction = func;
    }

    setHoverFunction(func) {
        const instance = this;
        instance.hoverFunction = func;
    }

    setTouchstickListener(func) {
        const instance = this;
        instance.touchstickFunction = func;
    }

    drawTile(options) {
        if(!options.texture || options.texture.loading) {
            return;
        }

        const instance = this;

        const drawOp = getFreshDrawOperation();

        drawOp.type = "tile";
        drawOp.x = Math.floor(options.x);
        drawOp.y = Math.floor(options.y);

        if(options.z != undefined) {
            drawOp.z = Math.floor(options.z);
        }

        drawOp.texture = options.texture;

        if(options.frame != undefined) {
            drawOp.frame = options.frame;
        }

        if(options.opacity != undefined) {
            drawOp.opacity = options.opacity;
        }

        instance.renderInstructions.push(drawOp);
    }

    drawSprite(options) {
        if(!options.texture || options.texture.loading) {
            return;
        }

        const instance = this;
        const drawOp = getFreshDrawOperation();

        drawOp.type = "sprite";
        drawOp.x = options.x;
        drawOp.y = options.y;

        if(options.z != undefined) {
            drawOp.z = options.z;
        }

        drawOp.texture = options.texture;

        if(options.scale) {
            drawOp.scale = options.scale;
        }

        if(options.opacity) {
            drawOp.opacity = options.opacity;
        }

        if(options.state) {
            drawOp.useState = options.state;
        }

        if(options.facing) {
            drawOp.useFacing = options.facing;
        }

        if(options.frame != undefined) {
            drawOp.frame = options.frame;
        }

        if(options.useRaw != undefined) {
            drawOp.useRaw = options.useRaw;
        }

        if(options.composit != undefined) {
            drawOp.composit = options.composit;
        }

        if(options.rotation != undefined) {
            drawOp.rotation = -options.rotation * PI_ONE_EIGHTY;
        }

        if(options.mirror != undefined) {
            drawOp.mirror = options.mirror;
        }

        if(options.ignoreLighting != undefined) {
            drawOp.ignoreLighting = options.ignoreLighting;
        }

        if(options.colorFilter != undefined && options.colorFilter.trim().length == 7) {
            drawOp.colorFilter = hexToRGB(options.colorFilter);
        }

        instance.renderInstructions.push(drawOp);
    }

    drawLight(options) {
        if(!options.color || !options.intensity || !options.radius) {
            return;
        }

        const instance = this;
        const drawOp = getFreshDrawOperation();

        drawOp.type = "light";
        drawOp.x = Math.round((options.x * instance.tileSize) - instance.viewX);
        drawOp.y = Math.round((options.y * instance.tileSize) - instance.viewY);

        drawOp.composit = options.color;

        const rgb = hexToRGB(options.color);

        drawOp.opacity = rgb.r;
        drawOp.rotation = rgb.g;
        drawOp.z = rgb.b;

        drawOp.frame = options.intensity;
        drawOp.scale = options.radius * instance.tileSize;

        instance.renderInstructions.push(drawOp);
    }

    kill() {
        const instance = this;

        instance.deInit = true;

        if(!instance.fixedCanvas && instance.holder) {
            instance.holder.innerHTML = "";
        }

        instance.initOptions = null;
        instance.holder = null;
        instance.canvas = null;
        instance.context = null;

        instance.renderFunction = null;
        instance.clickFunction = null;
        instance.touchstickFunction = null;
        instance.hoverFunction = null;

        delete engineInstances[instance.id];
    }
}

export class Texture {
    constructor(options) {
        this.id = guid();

        this.type = options.type || null;
        this.rawData = options.data || null;

        this.image = [];
        this.imageData = [];

        this.loading = true;

        this.colorReplacements = options.colors || [];

        this.pppData = null;

        this.height = 0;
        this.width = 0;

        this.frames = 0;
        this.curFrame = 0;

        this.accessories = options.accessories || null;

        this.state = options.state || null;      // standing, walking, using/attacking, dead
        this.facing = options.facing || null;     // e or w

        this.outlineColor = options.outlineColor || null;

        initTexture(this);
    }

    dispose() {
        const texture = this;

        this.loading = true;

        this.image = null;
        this.imageData = null;

        removeFromArray(allTextures, texture);
    }
}

class DrawInstruction {
    constructor() {
        this.type = null;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.texture = null;
        this.frame = -1;
        this.scale = 1;
        this.opacity = 1;
        this.useState = null;
        this.useFacing = null;
        this.useRaw = false;
        this.mirror = false;
        this.rotation = 0;
        this.composit = null;
        this.ignoreLighting = false;
        this.colorFilter = null;
    }
}

function resizeInstance(instance) {

    if(instance.deInit) {
        return;
    }

    if(instance.fixedCanvas) {
        instance.width = instance.canvas.width;
        instance.height = instance.canvas.height;
    } else {
        const holder = instance.holder;
    
        const aWidth = holder.offsetWidth;
        const aHeight = holder.offsetHeight;

        const scale = instance.width / aWidth;
        const useHeight = Math.floor(aHeight * scale);

        instance.height = useHeight;

        instance.canvas.width = instance.width;
        instance.canvas.height = instance.height;
    }

    instance.canvas.style.imageRendering = "pixelated";
    instance.context.imageSmoothingEnabled = false;
}

function globalRender(t) {
    if(lastRAF == null) {
        lastRAF = t;
    }

    let elapsed = t - lastRAF;
    lastRAF = t;

    let delta = elapsed / TARGET_DELTA;
    let fps = 1000 / elapsed;

    if(isNaN(delta)) {
        delta = 1;
    }

    for(let instanceId in engineInstances) {
        const instance = engineInstances[instanceId];

        if(instance.deInit) {
            continue;
        }

        renderInstance(instance, elapsed, delta, fps);
    }

    textureCycleCounter += delta;

    if(textureCycleCounter >= TEXTURE_CYCLE_MAX) {
        textureCycleCounter = 0;
        overrideOffTurn = !overrideOffTurn;

        for(let i = 0; i < allTextures.length; i++) {
            const texture = allTextures[i];
            cycleTexture(texture);
        }
    }

    requestAnimationFrame(globalRender);
}

// eslint-disable-next-line no-unused-vars
function onPointerDown(instance, object, id, x, y, type, pressure, which, px, py) {

    if(type == "touch" && instance.touchstickFunction) {
        const canCoord = getCanvasCoordinate(instance, x, y);

        if(canCoord.x < instance.width / 2) {
            instance.touchstickLeftX = canCoord.x;
            instance.touchstickLeftY = canCoord.y;
            instance.touchstickLeftId = id;
            instance.touchstickLeftMX = canCoord.x;
            instance.touchstickLeftMY = canCoord.y;

            reportLeftTouchMove(instance);
        } else {
            instance.touchstickRightX = canCoord.x;
            instance.touchstickRightY = canCoord.y;
            instance.touchstickRightId = id;
            instance.touchstickRightMX = canCoord.x;
            instance.touchstickRightMY = canCoord.y;

            reportRightTouchMove(instance);
        }

        return;
    }

    

    if(instance.clickFunction) {

        const dat = pointerLocationToTile(instance, x, y);

        dat.which = which;
        dat.type = type;

        instance.clickFunction(dat);
    }
}

// eslint-disable-next-line no-unused-vars
function onPointerMove(instance, object, id, x, y, type, pressure, which, px, py) {
    if(type == "touch" && instance.touchstickLeftId && instance.touchstickLeftId == id) {
        const canCoord = getCanvasCoordinate(instance, x, y);
        instance.touchstickLeftMX = canCoord.x;
        instance.touchstickLeftMY = canCoord.y;

        reportLeftTouchMove(instance);

        return;
    }

    if(type == "touch" && instance.touchstickRightId && instance.touchstickRightId == id) {
        const canCoord = getCanvasCoordinate(instance, x, y);
        instance.touchstickRightMX = canCoord.x;
        instance.touchstickRightMY = canCoord.y;

        reportRightTouchMove(instance);

        return;
    }

    if((type == "mouse" || type == "pen") && instance.hoverFunction) {
        instance.hoverFunction(pointerLocationToTile(instance, x, y));
    }
}

// eslint-disable-next-line no-unused-vars
function onPointerUp(instance, object, id, type, which, evt) {
    if(type == "touch" && instance.touchstickLeftId && instance.touchstickLeftId == id) {
        instance.touchstickLeftX = -1;
        instance.touchstickLeftY = -1;
        instance.touchstickLeftId = null;
        instance.touchstickLeftMX = -1;
        instance.touchstickLeftMY = -1;

        instance.touchstickFunction("left", 0, 0);
    }

    if(type == "touch" && instance.touchstickRightId && instance.touchstickRightId == id) {
        instance.touchstickRightX = -1;
        instance.touchstickRightY = -1;
        instance.touchstickRightId = null;
        instance.touchstickRightMX = -1;
        instance.touchstickRightMY = -1;

        instance.touchstickFunction("right", 0, 0);
    }
}

function weighColors(c1, c2, w1, w2) {
    const raw = ((w1 * c1) + (w2 * c2)) / (w1 + w2);

    if(raw > 255) {
        return 255;
    }

    return raw;
}

function initTexture(texture) {
    if(!texture || !texture.type || !texture.rawData) {
        return;
    }

    if(texture.type == "ppp" || texture.type == "ppptoken") {
        loadPPPTexture(texture);
    }
}

function getFreshDrawOperation() {

    let op = instructionRecycling.pop();

    if(op) {
        op.type = null;
        op.x = 0;
        op.y = 0;
        op.z = 0;
        op.texture = null;
        op.frame = -1;
        op.scale = 1;
        op.opacity = 1;
        op.useState = null;
        op.useFacing = null;
        op.useRaw = false;
        op.mirror = false;
        op.rotation = 0;
        op.composit = null;
        op.ignoreLighting = false;
        op.colorFilter = null;
    } else {
        op = new DrawInstruction();
    }

    return op;
}

function renderInstance(instance, elapsed, delta, fps) {

    if(instance.renderFunction) {
        instance.renderFunction(fps, delta, elapsed);
    }

    instance.canvas.width = instance.width;
    instance.canvas.height = instance.height;

    const context = instance.context;

    // sort render instructions here
    instance.renderInstructions.sort(function(a, b) {

        if(a.type == "light" && b.type != "light") {
            return -1;
        }

        if(a.type != "light" && b.type == "light") {
            return 1;
        }

        if(a.z > b.z) {
            return 1;
        }

        if(a.z < b.z) {
            return -1;
        }

        if(a.type == "tile" && b.type == "sprite") {
            return -1;
        }

        if(a.type == "sprite" && b.type == "tile") {
            return 1;
        }

        if(a.y > b.y) {
            return 1;
        }

        if(a.y < b.y) {
            return -1;
        }

        return 0;
    });

    instance.activeLights = [];

    const outputData = context.getImageData(0, 0, instance.width, instance.height);

    for(let i = 0; i < instance.renderInstructions.length; i++) {
        const inst = instance.renderInstructions[i];

        if(inst.type == "light") {
            instance.activeLights.push(inst);
        }

        if(inst.type == "tile") {
            renderTile(instance, inst, outputData);
        }

        if(inst.type == "sprite") {
            renderSprite(instance, inst, outputData);
        }
    }

    context.putImageData(outputData, 0, 0);

    while(instance.renderInstructions.length > 0) {
        const inst = instance.renderInstructions.pop();
        inst.texture = null;
        instructionRecycling.push(inst);
    }

    if(instance.touchstickFunction) {
        if(instance.touchstickLeftX > -1 && instance.touchstickLeftY > -1) {
            renderTouchStick(instance, instance.touchstickLeftX, instance.touchstickLeftY, instance.touchstickLeftMX, instance.touchstickLeftMY);
        }

        if(instance.touchstickRightX > -1 && instance.touchstickRightY > -1) {
            renderTouchStick(instance, instance.touchstickRightX, instance.touchstickRightY, instance.touchstickRightMX, instance.touchstickRightMY);
        }
    }
}

function cycleTexture(texture) {
    texture.curFrame++;

    if(texture.type == "ppptoken") {

        if(!texture.state) {
            texture.state = "standing";
        }

        if(texture.state == "dead") {
            texture.curFrame = 6;
        }

        if(texture.state == "standing") {
            if(texture.facing == "w") {
                texture.curFrame = 0;
            } else {
                texture.curFrame = 3;
            }
        }

        if(texture.state == "walking") {
            if(texture.facing == "w") {
                if(texture.curFrame > 1) {
                    texture.curFrame = 0;
                }
            } else {
                if(texture.curFrame < 3 || texture.curFrame > 4) {
                    texture.curFrame = 3;
                }
            }
        }

        if(texture.state == "using" || texture.state == "attacking") {
            if(texture.facing == "w") {
                texture.curFrame = 2;
            } else {
                texture.curFrame = 5;
            }
        }

        return;
    }

    if(texture.curFrame >= texture.frames) {
        texture.curFrame = 0;
    }
}

function getCanvasCoordinate(instance, x, y) {

    let hw = 0;
    let hh = 0;

    if(instance.fixedCanvas) {
        hw = instance.canvas.offsetWidth;
        hh = instance.canvas.offsetHeight;
    } else {
        const holder = instance.holder;
        hw = holder.offsetWidth;
        hh = holder.offsetHeight;
    }

    const xPer = x / hw;
    const yPer = y / hh;

    return {
        x: Math.floor(instance.width * xPer),
        y: Math.floor(instance.height * yPer)
    };
}

function reportLeftTouchMove(instance) {

    if(!instance.touchstickFunction) {
        return;
    }

    let xDiff = instance.touchstickLeftMX - instance.touchstickLeftX;
    let yDiff = instance.touchstickLeftMY - instance.touchstickLeftY;

    if(xDiff > instance.touchstickRadius) {
        xDiff = instance.touchstickRadius;
    }

    if(xDiff < -instance.touchstickRadius) {
        xDiff = -instance.touchstickRadius;
    }

    if(yDiff > instance.touchstickRadius) {
        yDiff = instance.touchstickRadius;
    }

    if(yDiff < -instance.touchstickRadius) {
        yDiff = -instance.touchstickRadius;
    }

    const xPer = xDiff / instance.touchstickRadius;
    const yPer = yDiff / instance.touchstickRadius;

    instance.touchstickFunction("left", xPer, yPer);
}

function reportRightTouchMove(instance) {

    if(!instance.touchstickFunction) {
        return;
    }

    let xDiff = instance.touchstickRightMX - instance.touchstickRightX;
    let yDiff = instance.touchstickRightMY - instance.touchstickRightY;

    if(xDiff > instance.touchstickRadius) {
        xDiff = instance.touchstickRadius;
    }

    if(xDiff < -instance.touchstickRadius) {
        xDiff = -instance.touchstickRadius;
    }

    if(yDiff > instance.touchstickRadius) {
        yDiff = instance.touchstickRadius;
    }

    if(yDiff < -instance.touchstickRadius) {
        yDiff = -instance.touchstickRadius;
    }

    const xPer = xDiff / instance.touchstickRadius;
    const yPer = yDiff / instance.touchstickRadius;

    instance.touchstickFunction("right", xPer, yPer);
}

function pointerLocationToTile(instance, x, y) {
        
    const canCoord = getCanvasCoordinate(instance, x, y);

    const canX = instance.viewX + canCoord.x;
    const canY = instance.viewY + canCoord.y;

    const tX = canX / instance.tileSize;
    const tY = canY / instance.tileSize;


    return {
        x: tX,
        y: tY
    };
}

function loadPPPTexture(texture) {
    // ppp object
    if(texture.rawData.id && texture.rawData.frames) {

        texture.height = texture.rawData.height;
        texture.width = texture.rawData.width;
        texture.frames = texture.rawData.frames.length;

        let accessories = null;
        let outlineColor = null;

        if(texture.accessories) {
            accessories = texture.accessories;
        }

        if(texture.outlineColor) {
            outlineColor = texture.outlineColor;
        }

        if(accessories) {
            for(let i = 0; i < accessories.length; i++) {
                const acc = accessories[i];

                if(acc.source) {
                    const src = acc.source;

                    if(src.width && src.width > texture.width) {
                        texture.width = src.width;
                    }

                    if(src.height && src.height > texture.height) {
                        texture.height = src.height;
                    }
                } 
            }
        }

        renderPPP({
            source: texture.rawData,
            colorReplacements: texture.colorReplacements,
            asCanvas: false,
            frame: -1,
            accessories: accessories,
            outlineColor: outlineColor,
            callback: function(img) {

                let loadsRemaining = texture.frames;

                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d", {
                    willReadFrequently: true
                });
                
                for(let i = 0; i < texture.frames; i++) {
                    const sx = texture.width * i;

                    canvas.width = texture.width;
                    canvas.height = texture.height;

                    context.drawImage(img, sx, 0, texture.width, texture.height, 0, 0, texture.width, texture.height);

                    const imgSrc = canvas.toDataURL();
                    const imgData = context.getImageData(0, 0, canvas.width, canvas.height);

                    texture.imageData.push(imgData);

                    const outimg = new Image();
                    outimg.onload = onPPPTxLoadInternal;
                    outimg.src = imgSrc;

                    texture.image.push(outimg);
                }

                function onPPPTxLoadInternal() {
                    loadsRemaining--;

                    if(loadsRemaining <= 0) {
                        texture.loading = false;
                    }
                }
            }
        });
    }
}

function renderTile(instance, inst, outputData) {

    if(inst.texture.loading) {
        return;
    }

    const texture = inst.texture;

    let frame = texture.curFrame;

    if(inst.frame > -1) {
        frame = inst.frame;
    }

    const frames = texture.imageData;
    const data = frames[frame];

    const opacity = inst.opacity;

    const dx = Math.round((inst.x * instance.tileSize) - instance.viewX);
    const dy = Math.round((inst.y * instance.tileSize) - instance.viewY);

    if(dx < -instance.tileSize || dy < -instance.tileSize) {
        return;
    }

    if(dx > instance.tileSize + instance.width || dy > instance.tileSize + instance.height) {
        return;
    }

    const inD = data.data;

    drawImageData(instance, texture, inD, dx, dy, 1, null, 0, opacity, false, outputData, false, null);
}

function renderSprite(instance, inst, outputData) {

    if(inst.texture.loading) {
        return;
    }

    const texture = inst.texture;
    const frames = texture.imageData;
    

    let useFrame = texture.curFrame;

    if(texture.type == "ppptoken") {
        if(inst.useState != null && inst.useFacing != null) {
            useFrame = getOverridePPPFrame(inst.useState, inst.useFacing);
        }
    }

    if(inst.frame != -1) {
        useFrame = inst.frame;
    }

    const data = frames[useFrame];

    let op = Math.round;

    if(isOdd(instance.height)) {
        op = Math.floor;
    }
    
    let uvx = instance.viewX;

    if(inst.useRaw) {
        uvx = instance.viewXraw;
    }

    const dx = Math.round((inst.x * instance.tileSize) - uvx);
    const dy = op((inst.y * instance.tileSize) - instance.viewY) - (texture.height - instance.tileSize);

    const inD = data.data;

    drawImageData(instance, texture, inD, dx, dy, inst.scale, inst.composit, inst.rotation, inst.opacity, inst.mirror, outputData, inst.ignoreLighting, inst.colorFilter);

}

function renderTouchStick(instance, cx, cy, sx, sy) {
    instance.context.strokeStyle = "#ffffff";
    instance.context.fillStyle = "rgba(255, 255, 255, 0.4)";

    instance.context.beginPath();
    instance.context.arc(cx, cy, instance.touchstickRadius, 0, Math.PI * 2);
    instance.context.stroke();

    instance.context.beginPath();
    instance.context.arc(sx, sy, Math.ceil(instance.touchstickRadius * 0.3), 0, Math.PI * 2);
    instance.context.fill();
}

function drawImageData(instance, texture, inputData, dx, dy, scale, composit, rotation, opacity, mirror, outputData, ignoreLighting, colorFilter) {

    const drawHeight = Math.round(texture.height * scale);
    const drawWidth = Math.round(texture.width * scale);

    let minX = dx;
    let maxX = dx + drawWidth;

    let minY = dy;
    let maxY = dy + drawHeight;

    if(rotation != 0) {
        const quarterHeight = Math.ceil(drawHeight / 4);

        minX -= quarterHeight;
        minY -= quarterHeight;

        maxX += quarterHeight;
        maxY += quarterHeight;
    }

    if(maxX < 0 || maxY < 0) {
        return;
    }

    if(minX > instance.width || minY > instance.height) {
        return;
    }

    const cx = Math.round((minX + maxX) / 2);
    const cy = Math.round((minY + maxY) / 2);

    for(let x = minX; x < maxX; x++) {

        if(x < 0 || x >= instance.width) {
            continue;
        }

        const ncx = x - cx;

        for(let y = minY; y < maxY; y++) {
            if(y < 0 || y >= instance.height) {
                continue;
            }

            const ncy = y - cy;

            let ucx = x;
            let ucy = y;

            if(rotation != 0) {
                const rotCos = Math.cos(rotation);
                const rotSin = Math.sin(rotation);

                ucx = Math.round((rotCos * (ncx)) - (rotSin * (ncy)) + cx);
                ucy = Math.round((rotCos * (ncy)) + (rotSin * (ncx)) + cy);
            }

            const xPer = (ucx - dx) / drawWidth;
            let srcX = Math.round(texture.width * xPer);

            if(mirror) {
                srcX = texture.width - srcX;
            }

            if(srcX < 0 || srcX >= texture.width) {
                continue;
            }

            const yPer = (ucy - dy) / drawHeight;
            let srcY = Math.round(texture.height * yPer);

            if(srcY < 0 || srcY >= texture.height) {
                continue;
            }

            const inputIndex = ((srcY * texture.width) + srcX) * 4;

            const incomingA = Math.round(inputData[inputIndex + 3] * opacity);

            if(incomingA <= 0) {
                continue;
            }

            let incomingR = inputData[inputIndex + 0];
            let incomingG = inputData[inputIndex + 1];
            let incomingB = inputData[inputIndex + 2];

            if(colorFilter) {
                incomingR += colorFilter.r;
                incomingG += colorFilter.g;
                incomingB += colorFilter.b;

                if(incomingR > 255) {
                    incomingR = 255;
                }

                if(incomingG > 255) {
                    incomingG = 255;
                }

                if(incomingB > 255) {
                    incomingB = 255;
                }
            }

            /*
            if(lightData) {
                const ldAl = lightData[inputIndex + 3];

                if(ldAl > 0) {
                    const ndr = lightData[inputIndex];
                    const ndg = lightData[inputIndex + 1];
                    const ndb = lightData[inputIndex + 2];

                    const lightLevel = (((ndr + ndg + ndb) / 3) / 255) * (ldAl / 255);

                    if(lightLevel > 0) {
                        lineIgnoreLighting = true;
                    }

                }
            }
                */

            setColorAtPoint(instance, outputData, x, y, incomingR, incomingG, incomingB, incomingA, composit, ignoreLighting);
            
        }
    }
}

function getOverridePPPFrame(state, facing) {
    if(state == "dead") {
        return 6;
    }

    let frame = 0;

    if(state == "walking" && overrideOffTurn) {
        frame = 1;
    }

    if(state == "attacking" || state == "using") {
        frame = 2;
    }

    if(facing == "e") {
        frame += 3;
    }

    return frame;
}

function setColorAtPoint(instance, outputData, x, y, r, g, b, a, composit, ignoreLighting) {

    if(!ignoreLighting) {

        const lighting = instance.getLightingAtPosition(x, y);

        r = multiplyColors(r, lighting.r, false);
        g = multiplyColors(g, lighting.g, false);
        b = multiplyColors(b, lighting.b, false);
    }
    
    const d = outputData.data;
    const imJ = y * instance.width;
    const idx = (imJ + x) * 4;
    const dl = d.length;

    if(a >= 255 && !composit && (!instance.filters || instance.filters.length == 0)) {
        setColorAtIndex(d, idx, r, dl);
        setColorAtIndex(d, idx + 1, g, dl);
        setColorAtIndex(d, idx + 2, b, dl);
        setColorAtIndex(d, idx + 3, 255, dl);

        return;
    }

    const exR = d[idx];
    const exG = d[idx + 1];
    const exB = d[idx + 2];

    if(a && a < 255) {
        const alPer = a / 255;

        r = weighColors(exR, r , 1, alPer);
        g = weighColors(exG, g , 1, alPer);
        b = weighColors(exB, b , 1, alPer);
    }

    if(composit) {
        if(composit == "hard-light") {
            r = hardLight(r, exR);
            g = hardLight(g, exG);
            b = hardLight(b, exB);
        }

        if(composit == "lighten") {
            r = lightenColors(r, exR);
            g = lightenColors(g, exG);
            b = lightenColors(b, exB);
        }

        if(composit == "lighter") {
            r = lighterColors(r, exR);
            g = lighterColors(g, exG);
            b = lighterColors(b, exB);
        }

        if(composit == "screen") {
            r = screenColors(r, exR);
            g = screenColors(g, exG);
            b = screenColors(b, exB);
        }

        if(composit == "multiply") {
            r = multiplyColors(r, exR);
            g = multiplyColors(g, exG);
            b = multiplyColors(b, exB);
        }

        if(composit == "overlay") {
            r = screenColors(r, multiplyColors(r, exR));
            g = screenColors(r, multiplyColors(g, exG));
            b = screenColors(r, multiplyColors(b, exB));
        }

        if(composit == "darken") {
            r = darkenColors(r, exR);
            g = darkenColors(g, exG);
            b = darkenColors(b, exB);
        }

        if(composit == "darker") {
            r = darkerColors(r, exR);
            g = darkerColors(g, exG);
            b = darkerColors(b, exB);
        }
    }

    if(instance.filters && instance.filters.length > 0) {
        for(let i = 0; i < instance.filters.length; i++) {
            const filter = instance.filters[i];

            if(!filter) {
                continue;
            }

            if(filter == "red") {
                g = 0;
                b = 0;
            }

            if(filter == "cyan") {
                r = 0;
            }

            if(filter == "blue") {
                r = 0;
                g = 0;
            }

            if(filter == "green") {
                r = 0;
                b = 0;
            }

            if(filter == "crt") {
                if(y % 2 == 0) {
                    r -= 12;
                    g -= 12;
                    b -= 12;

                    if(r < 0) {
                        r = 0;
                    }

                    if(g < 0) {
                        g = 0;
                    }

                    if(b < 0) {
                        b = 0;
                    }
                }
            }

            if(filter == "lcd") {
                if(y % 2 == 0) {
                    r -= 6;
                    g -= 6;
                    b -= 6;

                    
                } else {
                    if(x % 2 == 0) {
                        r += 10;
                        g += 10;
                        b += 10;
                    }
                }

                if(r < 0) {
                    r = 0;
                }

                if(g < 0) {
                    g = 0;
                }

                if(b < 0) {
                    b = 0;
                }

                if(r > 255) {
                    r = 255;
                }

                if(g > 255) {
                    g = 255;
                }

                if(b > 255) {
                    b = 255;
                }
            }

            if(filter == "grid") {
                if(y % 2 == 0) {
                    r -= 12;
                    g -= 12;
                    b -= 12;

                    if(r < 0) {
                        r = 0;
                    }

                    if(g < 0) {
                        g = 0;
                    }

                    if(b < 0) {
                        b = 0;
                    }
                }

                if(x % 2 == 0) {
                    r += 12;
                    g += 12;
                    b += 12;

                    if(r > 255) {
                        r = 255;
                    }

                    if(g > 255) {
                        g = 255;
                    }

                    if(b > 255) {
                        b = 255;
                    }
                }
            }

            if(filter == "noise") {
                const rnd = randomIntFromInterval(0, 10) - 5;

                r += rnd;
                g += rnd;
                b += rnd;

                if(r > 255) {
                    r = 255;
                }

                if(g > 255) {
                    g = 255;
                }

                if(b > 255) {
                    b = 255;
                }

                if(r < 0) {
                    r = 0;
                }

                if(g < 0) {
                    g = 0;
                }

                if(b < 0) {
                    b = 0;
                }
            }

            if(filter == "film") {
                let ch = randomIntFromInterval(0, 6);

                if(ch == 3) {
                    const rnd = randomIntFromInterval(0, 8);

                    r += rnd;
                    g += rnd;
                    b += rnd;

                    if(r > 255) {
                        r = 255;
                    }

                    if(g > 255) {
                        g = 255;
                    }

                    if(b > 255) {
                        b = 255;
                    }
                }
            }

            if(filter == "mono") {
                const tot = Math.round(( r + g + b) / 3);

                r = tot;
                g = tot;
                b = tot;
            }

            if(filter == "invert") {
                r = 255 - r;
                g = 255 - g;
                b = 255 - b;
            }

            if(filter == "sepia") {
                r = Math.round((r * 0.393) + (g * 0.769) + (b * 0.189));
                g = Math.round((r * 0.349) + (g * 0.686) + (b * 0.168));
                b = Math.round((r * 0.272) + (g * 0.534) + (b * 0.131));

                if(r > 255) {
                    r = 255;
                }

                if(g > 255) {
                    g = 255;
                }

                if(b > 255) {
                    b = 255;
                }
            }

            if(filter == "sepiaalt") {
                if(r > 119) {
                    r = 119;
                }

                if(g > 66) {
                    g = 66;
                }

                if(b > 18) {
                    b = 18;
                }
            }
        }
    }

    setColorAtIndex(d, idx, r, dl);
    setColorAtIndex(d, idx + 1, g, dl);
    setColorAtIndex(d, idx + 2, b, dl);
    setColorAtIndex(d, idx + 3, 255, dl);
}

function multiplyColors(c1, c2, alreadySingled) {
    if(alreadySingled) {
        return colorSingle(c1 * c2);
    } else {
        return colorSingle(singleColor(c1) * singleColor(c2));
    }
}

function setColorAtIndex(data, index, color, dLen) {
    if(index < dLen) {
        data[index] = color;
    }
}

function hardLight(c1,c2) {

    if(c2 < 130) {
        return multiplyColors(singleColor(c1),singleColor(c2) * 2,true);
    } else {
        return screenColors(singleColor(c1),2 * singleColor(c2) - 1,true);
    }
}

function lightenColors(c1, c2) {
    return Math.max(c1,c2);
}

function lighterColors(c1, c2) {
    const col = c1 + c2;

    if(col > 255) {
        return 255;
    }

    return col;
}

function screenColors(c1, c2, alreadySingled) {
    if(alreadySingled) {
        return colorSingle(1 - ((1 - c1) * (1 - c2)));
    } else {
        const s1 = singleColor(c1);
        const s2 = singleColor(c2);

        return colorSingle(1 - ((1 - s1) * (1 - s2)));
    }
}

function darkenColors(c1, c2) {
    return Math.min(c1,c2);
}

function darkerColors(c1, c2) {
    let col = c1 - c2;

    if(col < 0) {
        col = 0;
    }

    return col;
}

function colorSingle(s) {
    return Math.round(s * 255);
}

function singleColor(c) {
    return c / 255;
}

export default {
    getPixelEngineInstance,
    loadTexture,
    getTargetFramerate,
    isOdd,
    onResize,
    PixelEngineInstance,
    Texture
};

globalRender();