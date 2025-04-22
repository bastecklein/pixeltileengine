import { renderPPP } from "ppp-tools";
import { handleInput } from "input-helper";
import { guid, removeFromArray, distBetweenPoints, hexToRGB, randomIntFromInterval, rgbToHex } from "common-helpers";

window.addEventListener("resize", onResize);

const TARGET_FRAMERATE = 60;
const TARGET_DELTA = 1000 / TARGET_FRAMERATE;
const DEF_TILE_SIZE = 16;
const TEXTURE_CYCLE_MAX = 8;
const PI_ONE_EIGHTY = Math.PI / 180;

export const EFFECT_PROGRAMS = {
    "splat": partProgSplat,
    "smoke": partProgSmoke,
    "ember": partProgEmber
};

export const ENVIRONMENTAL_EFFECTS = {
    "none": 0,
    "rain": 1,
    "snow": 2,
    "embers": 3
};

let textureCycleCounter = 0;

/**
 * @type {Texture[]}
 * @description An array to hold all loaded textures.
 */
const allTextures = [];

/**
 * @type {Object<string, PixelEngineInstance>}
 * @description A dictionary to hold all instances of PixelEngine.
 * The keys are instance IDs, and the values are the corresponding PixelEngineInstance objects.
 *  */
const engineInstances = {};

/**
 * @type {DrawInstruction[]}
 * @description A pool of draw instructions that can be recycled for efficiency.
 */
const instructionRecycling = [];

/**
 * @type {ParticleInstruction[]}
 * @description A pool of particle instructions that can be recycled for efficiency.
 */
const particleInstructionRecycling = [];

let overrideOffTurn = false;

let lastRAF = null;

/**
 * Initializes a new PixelEngine instance.
 * @param {HTMLElement} holder - The HTML element that will hold the canvas.
 * @param {Object} [options] - Optional configuration options for the instance.
 * @param {number} [options.width=256] - The width of the canvas.
 * @param {HTMLCanvasElement} [options.fixedCanvas] - The fixed canvas element to use.  The canvas will not be created or resized by the engine.
 * @returns {PixelEngineInstance} The newly created PixelEngine instance.
 */
export function getPixelEngineInstance(holder, options) {
    if(!options) {
        options = {};
    }

    const engine = new PixelEngineInstance(holder, options);
    engineInstances[engine.id] = engine;

    return engine;
}

/**
 * Loads a texture into the engine.
 * @param {Object} options - The options for the texture.
 * @param {string} options.type - The type of the texture (e.g., "ppp", "image").
 * @param {string} options.data - The data for the texture (e.g., image URL, PPP object).
 * @param {Array} [options.colors] - An array of color replacements for the texture.
 * @param {Array} [options.accessories] - An array of accessory objects for the texture.
 * @param {string} [options.state] - The state of the texture (e.g., "standing", "walking").
 * @param {string} [options.facing] - The facing direction of the texture (e.g., "e", "w").
 * @param {string} [options.outlineColor] - The outline color for the texture.
 * @returns {Texture} The loaded texture.
 */
export function loadTexture(options) {
    const texture = new Texture(options);

    allTextures.push(texture);

    return texture;
}

/**
 * Returns the engine target framerate.
 * @returns {number} The target framerate.
 * */
export function getTargetFramerate() {
    return TARGET_FRAMERATE;
}

/**
 * Checks if a number is odd.
 * @param {number} num - The number to check.
 * @returns {boolean} True if the number is odd, false otherwise.
 */
export function isOdd(num) {
    return num % 2;
}

/**
 * Force a resize of all engine instances.
 * @returns {void}
 */
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

        this.width = options.width || 256;
        this.height = 224;
        this.tileSize = DEF_TILE_SIZE;

        this.rndAngle = 0;

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
        this.programParticles = [];

        this.environmentalEffect = ENVIRONMENTAL_EFFECTS.none;

        this.roundingOp = Math.round;

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

    /**
     * Sets the environmental effect for the instance.
     * @param {number} effect - The environmental effect to set (e.g., ENVIRONMENTAL_EFFECTS.rain).
     */
    setEnvironmentalEffect(effect) {
        if(effect) {
            this.environmentalEffect = effect;
        } else {
            this.environmentalEffect = ENVIRONMENTAL_EFFECTS.none;
        }
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

    drawParticle(options) {
        if(!options.color) {
            return;
        }

        const drawOp = getFreshDrawOperation();

        drawOp.type = "particle";

        drawOp.useState = options.color;

        drawOp.x = options.x || 0;
        drawOp.y = options.y || 0;
        drawOp.z = options.z || 0;

        drawOp.scale = options.scale || 1;
        drawOp.opacity = options.opacity || 1;
        drawOp.composit = options.composit || null;
        drawOp.ignoreLighting = options.ignoreLighting || false;
        drawOp.colorFilter = options.colorFilter || null;

        drawOp.useRaw = options.useRaw || false;

        this.renderInstructions.push(drawOp);
    }

    playParticleEffect(options) {
        if(!options.effect) {
            return;
        }

        const program = EFFECT_PROGRAMS[options.effect];

        if(program) {
            program(this, options);
        }
    }

    insertParticleInstruction(options) {
        const instruction = getFreshParticleOperation();

        instruction.x = options.x || 0;
        instruction.y = options.y || 0;
        instruction.z = options.z || 0;

        instruction.zI = options.zI || 0;

        instruction.color = options.color || "#ff0000";
        instruction.size = options.size || 1;
        instruction.colorVariance = options.colorVariance || 0;

        instruction.vx = options.vx || 0;
        instruction.vy = options.vy || 0;
        instruction.vz = options.vz || 0;

        instruction.gz = options.gz || 0.01;
        instruction.tv = options.tv || 0.04;

        instruction.composit = options.composit || null;
        instruction.life = options.life || -1;

        instruction.opacity = options.opacity || 1;

        instruction.stayOnGround = options.stayOnGround || false;
        instruction.lifeOnGround = options.lifeOnGround || -1;

        instruction.glowRadius = options.glowRadius || 0;
        instruction.glowBrightness = options.glowBrightness || 0;

        instruction.fadeSpeed = options.fadeSpeed || 0;

        instruction.trails = options.trails || false;
        instruction.ignoreLighting = options.ignoreLighting || false;
        instruction.useRaw = options.useRaw || false;
        instruction.useGlobalAngle = options.useGlobalAngle || false;
        instruction.loopsBack = options.loopsBack || false;
        instruction.splatOnImpact = options.splatOnImpact || false;

        if(instruction.colorVariance != 0) {
            instruction.color = variateHexColor(instruction.color, instruction.colorVariance);
        }

        this.programParticles.push(instruction);
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

/**
 * Class representing a draw instruction.
 * @property {string} type - The type of the draw instruction (e.g., "tile", "sprite", "light", "particle").
 * @property {number} x - The x-coordinate of the draw instruction.
 * @property {number} y - The y-coordinate of the draw instruction.
 * @property {number} z - The zIndex of the draw instruction.
 * @property {Texture} texture - The texture associated with the draw instruction.
 * @property {number} frame - The frame index of the texture to use.
 * @property {number} scale - The scale factor for the draw instruction.
 * @property {number} opacity - The opacity of the draw instruction.
 * @property {string} useState - The state of the sprite (e.g., "standing", "walking", "dead", "using", "attacking").  For particles, this is the color.
 * @property {string} useFacing - The facing direction of the sprite (e.g., "e", "w").
 * @property {boolean} useRaw - Whether to use raw coordinates for the draw instruction.
 * @property {boolean} mirror - Whether to mirror the sprite.
 * @property {number} rotation - The rotation angle of the sprite in radians.
 * @property {string} composit - The operation to use for compositing.
 * @property {boolean} ignoreLighting - Whether to ignore lighting effects.
 * @property {object} colorFilter - The color filter to apply to the sprite.
 */
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

/**
 * Class representing a particle instruction, a retained instruction between rendering frames
 * that tracks the life of a particle.
 * @property {number} x - The x-coordinate of the particle.
 * @property {number} y - The y-coordinate of the particle.
 * @property {number} z - The z-coordinate of the particle.
 * @property {number} zI - The z-index of the particle.
 * @property {string} color - The color of the particle.
 * @property {number} colorVariance - The variance in color for the particle.
 * @property {number} size - The size of the particle (in pixels)
 * @property {number} vx - The x velocity of the particle.
 * @property {number} vy - The y velocity of the particle.
 * @property {number} vz - The z velocity of the particle.
 * @property {number} gz - The gravity effect on the particle.
 * @property {number} tv - The terminal velocity of the particle.
 * @property {string} composit - The compositing operation for the particle.
 * @property {number} life - The remaining life of the particle.
 * @property {boolean} cashed - Whether the particle has completed its life and can be recycled.
 * @property {number} opacity - The opacity of the particle.
 * @property {boolean} stayOnGround - If the particle should stop moving when it hits the simulated ground.
 * @property {number} lifeOnGround - The remaining life of the particle when it is on the ground.
 * @property {number} glowRadius - The radius of the glow effect for the particle.  Will draw a light effect.
 * @property {number} glowBrightness - The brightness of the glow effect for the particle.
 * @property {number} fadeSpeed - The speed at which the particle fades out.
 * @property {boolean} trails - Whether the particle should leave a trail.
 * @property {boolean} ignoreLighting - Whether the particle should ignore lighting effects.
 * @property {boolean} useRaw - Whether to use raw coordinates for the particle.
 * @property {boolean} useGlobalAngle - Whether to use a global angle for the particle.
 * @property {boolean} loopsBack - Whether the particle should loop back to the other side of the screen if it leaves the view bounds
 * @property {boolean} splatOnImpact - Whether the particle should splat on impact with the ground.
 */
class ParticleInstruction {
    constructor() {
        this.x = 0;
        this.y = 0;
        this.z = 0;

        this.zI = 0;

        this.color = "#ff0000";
        this.colorVariance = 0;
        this.size = 1;

        this.vx = 0;
        this.vy = 0;
        this.vz = 0;
        
        this.gz = 0.01;
        this.tv = 0.04;

        this.composit = null;

        this.life = -1;
        this.cashed = false;

        this.opacity = 1;

        this.stayOnGround = false;
        this.lifeOnGround = -1;

        this.glowRadius = 0;
        this.glowBrightness = 0;

        this.fadeSpeed = 0;

        this.trails = false;
        this.ignoreLighting = false;
        this.useRaw = false;
        this.useGlobalAngle = false;
        this.loopsBack = false;
        this.splatOnImpact = false;
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

    if(isOdd(instance.height)) {
        instance.roundingOp = Math.floor;
    } else {
        instance.roundingOp = Math.round;
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

/**
 * Get a new draw operation from the recycling pool or create a new one if none are available.
 * @returns {DrawInstruction} A new or recycled DrawInstruction object.
 */
function getFreshDrawOperation() {

    const op = instructionRecycling.pop();

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
        return new DrawInstruction();
    }

    return op;
}

function renderInstance(instance, elapsed, delta, fps) {

    if(instance.renderFunction) {
        instance.renderFunction(fps, delta, elapsed);
    }

    instance.rndAngle += delta * 0.002;

    if(instance.rndAngle > 360) {
        instance.rndAngle -= 360;
    }

    const currentBounds = instance.getViewBounds();

    runEnvironmentalConditions(instance, currentBounds);
   
    const completePrograms = [];

    for(let i = 0; i < instance.programParticles.length; i++) {
        const inst = instance.programParticles[i];

        if(inst.cashed) {
            completePrograms.push(inst);
            continue;
        }

        updateParticle(instance, inst, delta, currentBounds);
    }

    while(completePrograms.length > 0) {
        const inst = completePrograms.pop();

        removeFromArray(instance.programParticles, inst);

        if(particleInstructionRecycling.length < 1000) {
            particleInstructionRecycling.push(inst);
        }
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

        if(inst.type == "particle") {
            renderParticle(instance, inst, outputData);
        }
    }

    context.putImageData(outputData, 0, 0);

    while(instance.renderInstructions.length > 0) {
        const inst = instance.renderInstructions.pop();
        inst.texture = null;

        if(instructionRecycling.length < 1000) {
            instructionRecycling.push(inst);
        }
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

function getCanvasCoordinatePrecise(instance, x, y) {
    let hw = 0;
    let hh = 0;

    if(instance.fixedCanvas) {
        hw = instance.canvas.width;
        hh = instance.canvas.height;
    } else {
        const holder = instance.holder;
        hw = holder.offsetWidth;
        hh = holder.offsetHeight;
    }

    const xPer = x / hw;
    const yPer = y / hh;

    return {
        x: instance.width * xPer,
        y: instance.height * yPer
    };
}

function getCanvasCoordinate(instance, x, y) {

    const precice = getCanvasCoordinatePrecise(instance, x, y);

    return {
        x: Math.floor(precice.x),
        y: Math.floor(precice.y)
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


    let uvx = instance.viewX;

    if(inst.useRaw) {
        uvx = instance.viewXraw;
    }

    const dx = Math.round((inst.x * instance.tileSize) - uvx);
    const dy = instance.roundingOp((inst.y * instance.tileSize) - instance.viewY) - (texture.height - instance.tileSize);

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

/**
 * Calculate the screen effect of two color values.
 * @param {number} c1 - The first color value.
 * @param {number} c2 - The second color value.
 * @param {boolean} alreadySingled - Whether the color values are already in the 0-1 range.
 * @returns {number} The resulting color value after applying the screen effect.
 * If the result exceeds 255, it returns 255.
 * If the result is negative, it returns 0.
 */
function screenColors(c1, c2, alreadySingled) {
    if(alreadySingled) {
        return colorSingle(1 - ((1 - c1) * (1 - c2)));
    } else {
        const s1 = singleColor(c1);
        const s2 = singleColor(c2);

        return colorSingle(1 - ((1 - s1) * (1 - s2)));
    }
}

/**
 * Get the darker of two color values.
 * @param {number} c1 - The first color value.
 * @param {number} c2 - The second color value.
 * @returns {number} The darker color value.
 * If both colors are equal, it returns the color value.
 */
function darkenColors(c1, c2) {
    return Math.min(c1,c2);
}

/**
 * Calculate the difference between two color values.
 * @param {number} c1 - The first color value.
 * @param {number} c2 - The second color value.
 * @returns {number} The difference between the two color values.
 * If the difference is negative, it returns 0.
 */
function darkerColors(c1, c2) {
    let col = c1 - c2;

    if(col < 0) {
        col = 0;
    }

    return col;
}

/**
 * Convert a color value from 0-1 range to a 0-255 range.
 * @param {number} s - The color value (0-1).
 * @returns {number} The color value in the range of 0-255.
 */
function colorSingle(s) {
    return Math.round(s * 255);
}

/**
 * Convert a color value from 0-255 range to a 0-1 range.
 * @param {number} c - The color value (0-255).
 * @returns {number} The color value in the range of 0-1.
 */
function singleColor(c) {
    return c / 255;
}

/**
 * Get a new particle operation from the recycling pool or create a new one if none are available.
 * @returns {ParticleInstruction} A new or recycled ParticleInstruction object.
 */
function getFreshParticleOperation() {
    const op = particleInstructionRecycling.pop();

    if(op) {
        op.x = 0;
        op.y = 0;
        op.z = 0;

        op.zI = 0;

        op.color = "#ff0000";
        op.colorVariance = 0;
        op.size = 1;

        op.vx = 0;
        op.vy = 0;
        op.vz = 0;
        
        op.gz = 0.01;
        op.tv = 0.04;

        op.composit = null;

        op.life = -1;
        op.cashed = false;

        op.opacity = 1;

        op.stayOnGround = false;
        op.lifeOnGround = -1;

        op.glowRadius = 0;
        op.glowBrightness = 0;

        op.fadeSpeed = 0;

        op.trails = false;
        op.ignoreLighting = false;
        op.useRaw = false;
        op.useGlobalAngle = false;
        op.loopsBack = false;
        op.splatOnImpact = false;
    } else {
        return new ParticleInstruction();
    }

    return op;
}

/**
 * Program for the "Splat" effect.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {Object} options - Options for the splat effect.
 * @param {string} options.color - Color of the splat.
 * @param {number} options.size - Size of each splat particle.
 * @param {number} options.amount - Number of splat particles to create.
 * @param {number} options.x - X coordinate of the splat center.
 * @param {number} options.y - Y coordinate of the splat center.
 * @param {number} options.z - Simulated elevation of the splat.
 * @param {number} options.zI - zIndex of the effect.
 * @param {boolean} options.useRaw - Whether to use raw coordinates.
 * @param {boolean} options.stayOnGround - Whether the splat should stay on the ground.
 */
function partProgSplat(instance, options) {
    const color = options.color || "#ff0000";
    const size = options.size || 1;
    const zIndex = options.zI || 0;
    const z = options.z || 0.5;
    const useRaw = options.useRaw || false;

    let amount = options.amount || randomIntFromInterval(15, 60);

    while(amount > 0) {
        amount--;

        const vx = (randomIntFromInterval(0, 100) - 50) / 1000;
        const vy = (randomIntFromInterval(0, 100) - 50) / 1000;
        const vz = (randomIntFromInterval(0, 100) - 50) / 1000;

        instance.insertParticleInstruction({
            color: color,
            x: options.x,
            y: options.y,
            z: z,
            zI: zIndex,
            vx: vx,
            vy: vy,
            vz: vz,
            size: size,
            stayOnGround: options.stayOnGround || true,
            lifeOnGround: 800,
            useRaw: useRaw,
        });
    }
}

/**
 * Update the particle instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {ParticleInstruction} inst - The particle instruction to update.
 * @param {number} delta - The time delta since the last update.
 * @param {Object} bounds - The current view bounds.
 */
function updateParticle(instance, inst, delta, bounds) {
    if(delta > 20) {
        delta = 1;
    }

    inst.opacity -= inst.fadeSpeed * delta;

    if(inst.opacity <= 0) {
        inst.cashed = true;
        return;
    }

    if(inst.life > -1) {
        inst.life -= delta;

        if(inst.life <= 0) {
            inst.cashed = true;
            return;
        }
    }

    const ox = inst.x;
    const oy = inst.y;
    const oz = inst.z;

    if(inst.useGlobalAngle) {
        inst.x += (Math.sin(instance.rndAngle) * 2) * delta;
    } else {
        inst.x += inst.vx * delta;
    }
    
    inst.y += inst.vy * delta;

    if(inst.life == -1) {
        if(inst.x < bounds.xMin && inst.vx < 0) {
            if(inst.loopsBack) {
                inst.x = bounds.xMax;
            } else {
                inst.cashed = true;
            }
            return;
        }
    
        if(inst.x > bounds.xMax && inst.vx > 0) {
            if(inst.loopsBack) {
                inst.x = bounds.xMin;
            } else {
                inst.cashed = true;
            }
            return;
        }
    
        if(inst.y < bounds.yMin && inst.vy < 0) {
            inst.cashed = true;
            return;
        }
    
        if(inst.y > bounds.yMax && inst.vy > 0) {
            inst.cashed = true;
            return;
        }
    }
    
    let velZ = inst.vz;

    if(velZ > inst.tv) {
        velZ = inst.tv;
    }

    inst.vz += inst.gz * delta;

    inst.z -= velZ * delta;

    if(inst.z <= 0) {
        if(inst.stayOnGround) {
            inst.z = 0;
            inst.vx = 0;
            inst.vy = 0;
            inst.vz = 0;
            inst.gz = 0;
            inst.tv = 0;

            if(inst.life == -1 && inst.lifeOnGround > -1) {
                inst.life = inst.lifeOnGround;
            }
        } else {
            inst.cashed = true;

            if(inst.splatOnImpact) {
                partProgSplat(instance, {
                    color: inst.color,
                    size: inst.size,
                    amount: randomIntFromInterval(0, 6),
                    x: ox,
                    y: oy,
                    z: oz,
                    zI: inst.zI,
                    useRaw: inst.useRaw,
                    stayOnGround: false
                });
            }

            return;
        }
    }

    if(inst.trails) {
        instance.insertParticleInstruction({
            x: ox,
            y: oy,
            z: oz,
            vx: 0,
            vy: 0,
            vz: 0,
            gz: 0,
            tv: 0,
            color: inst.color,
            size: inst.size,
            opacity: inst.opacity,
            composit: inst.composit,
            fadeSpeed: inst.fadeSpeed + 0.02,
            ignoreLighting: inst.ignoreLighting,
            trails: false,
            useRaw: inst.useRaw,
        });
    }

    if(inst.glowRadius > 0 && inst.glowBrightness > 0) {
        instance.drawLight({
            color: inst.color,
            x: inst.x,
            y: inst.y,
            intensity: inst.glowBrightness,
            radius: inst.glowRadius
        });
    }

    const renderZIndex = inst.zI + Math.floor(inst.z);

    instance.drawParticle({
        x: inst.x,
        y: inst.y,
        z: renderZIndex,
        color: inst.color,
        scale: inst.size,
        opacity: inst.opacity,
        composit: inst.composit,
        ignoreLighting: inst.ignoreLighting,
        useRaw: inst.useRaw,
    });
}

/**
 * Render the particle instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {DrawInstruction} inst - The draw instruction to render.
 * @param {Object} outputData - The output data to render to.
 */
function renderParticle(instance, inst, outputData) {
    const color = inst.useState;

    if(!color || inst.opacity <= 0) {
        return;
    }

    let uvx = instance.viewX;

    if(inst.useRaw) {
        uvx = instance.viewXraw;
    }

    const elevationOffset = Math.round(inst.z * instance.tileSize);

    const dx = Math.round((inst.x * instance.tileSize) - uvx);
    const dy = (instance.roundingOp((inst.y * instance.tileSize) - instance.viewY) - (inst.scale - instance.tileSize)) - elevationOffset;

    let minX = dx;
    let maxX = dx + inst.scale;

    let minY = dy;
    let maxY = dy + inst.scale;

    const rgb = hexToRGB(color);

    let r = rgb.r;
    let g = rgb.g;
    let b = rgb.b;

    const a = Math.round(inst.opacity * 255);

    if(inst.colorFilter) {
        r += inst.colorFilter.r;
        g += inst.colorFilter.g;
        b += inst.colorFilter.b;

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

    for(let x = minX; x < maxX; x++) {
        if(x < 0 || x >= instance.width) {
            continue;
        }

        for(let y = minY; y < maxY; y++) {
            if(y < 0 || y >= instance.height) {
                continue;
            }

            setColorAtPoint(instance, outputData, x, y, r, g, b, a, inst.composit, inst.ignoreLighting);
        }
    }
}

/**
 * Run the environmental conditions for the given instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {Object} bounds - The current view bounds.
 */
function runEnvironmentalConditions(instance, bounds) {
    if(instance.environmentalEffect == ENVIRONMENTAL_EFFECTS.none) {
        return;
    }

    if(instance.environmentalEffect == ENVIRONMENTAL_EFFECTS.rain) {
        handleInstanceRain(instance, bounds);
    }

    if(instance.environmentalEffect == ENVIRONMENTAL_EFFECTS.snow) {
        handleInstanceSnow(instance, bounds);
    }

    if(instance.environmentalEffect == ENVIRONMENTAL_EFFECTS.embers) {
        handleInstanceEmbers(instance, bounds);
    }
}

/** 
 * Handle the rain effect for the given instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {Object} bounds - The current view bounds.
 */
function handleInstanceRain(instance, bounds) {
    let dropCount = randomIntFromInterval(0, 3);

    while(dropCount > 0) {
        dropCount--;

        const rx = randomIntFromInterval((bounds.xMin - 1) * 100, (bounds.xMax + 1) * 100);
        const ry = randomIntFromInterval((bounds.yMin - 1) * 100, (bounds.yMax + 1) * 100);

        const rv = randomIntFromInterval(6, 14) / 100;

        instance.insertParticleInstruction({
            x: rx / 100,
            y: ry / 100,
            z: instance.height / instance.tileSize,
            vx: 0,
            vy: rv,
            vz: 0,
            gz: 0,
            tv: 0,
            color: "#42A5F5",
            size: 1,
            opacity: 0.3,
            composit: null,
            ignoreLighting: false,
            trails: true,
            useRaw: false
        });
    }
}

/**
 * Handle the snow effect for the given instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {Object} bounds - The current view bounds.
 */
function handleInstanceSnow(instance, bounds) {
    const snowChance = randomIntFromInterval(0, 5);

    if(snowChance == 2) {
        const rx = randomIntFromInterval((bounds.xMin - 1) * 100, (bounds.xMax + 1) * 100);
        const ry = randomIntFromInterval((bounds.yMin - 1) * 100, (bounds.yMax + 1) * 100);

        const rv = randomIntFromInterval(1, 6) / 100;

        instance.insertParticleInstruction({
            x: rx / 100,
            y: ry / 100,
            z: instance.height / instance.tileSize,
            vx: Math.sin(instance.rndAngle) * 2,
            vy: rv,
            vz: 0,
            gz: 0,
            tv: 0,
            color: "#ffffff",
            size: 1,
            opacity: 0.8,
            composit: null,
            ignoreLighting: false,
            trails: false,
            useRaw: false,
            useGlobalAngle: true,
            loopsBack: true,
            stayOnGround: true,
            lifeOnGround: 300
        });
    }
}

/**
 * Handle the embers effect for the given instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {Object} bounds - The current view bounds.
 */
function handleInstanceEmbers(instance, bounds) {
    const rx = randomIntFromInterval((bounds.xMin - 1) * 100, (bounds.xMax + 1) * 100);
    const ry = randomIntFromInterval((bounds.yMin - 1) * 100, (bounds.yMax + 1) * 100);

    partProgEmber(instance, {
        x: rx / 100,
        y: ry / 100,
        maxChance: 5,
        loopBack: true
    });
}

/**
 * Render a smoke effect for the given instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {Object} options - Options for the smoke effect.
 * @param {string} options.color - Color of the smoke.
 * @param {number} options.x - X coordinate of the smoke origin.
 * @param {number} options.y - Y coordinate of the smoke origin.
 * @param {number} options.z - Simulated elevation of the smoke origin.
 * @param {number} options.zI - zIndex of the effect.
 */
function partProgSmoke(instance, options) {
    const chance = randomIntFromInterval(0, 16);

    if(chance < 13) {
        return;
    }

    const color = options.color || "#666666";

    const vx = (randomIntFromInterval(0, 100) / 10000) - 0.005;
    const vy = (randomIntFromInterval(0, 100) / 10000) - 0.005;

    const z = options.z || 0;
    const zIndex = options.zI || 0;

    instance.insertParticleInstruction({
        x: options.x,
        y: options.y,
        z: z,
        zI: zIndex,
        color: color,
        vx: vx,
        vy: vy,
        vz: -0.0002,
        gz: -0.0002,
        fadeSpeed: 0.01,
        colorVariance: 32
    });
}

function variateHexColor(hex, variance) {
    const rgb = hexToRGB(hex);

    const r = rgb.r + randomIntFromInterval(-variance, variance);
    const g = rgb.g + randomIntFromInterval(-variance, variance);
    const b = rgb.b + randomIntFromInterval(-variance, variance);

    return rgbToHex(r, g, b);
}

/**
 * Render an ember effect for the given instance.
 * @param {PixelEngineInstance} instance - The pixel engine instance.
 * @param {Object} options - Options for the ember effect.
 * @param {string} options.color - Color of the ember.
 * @param {number} options.maxChance - Maximum chance of ember generation.
 * @param {number} options.x - X coordinate of the ember origin.
 * @param {number} options.y - Y coordinate of the ember origin.
 * @param {number} options.z - Simulated elevation of the ember origin.
 * @param {number} options.zI - zIndex of the effect.
 * @param {number} options.colorVariance - Variance in color for the ember.
 * @param {boolean} options.loopBack - Whether the ember should loop back.
 */
function partProgEmber(instance, options) {

    const maxChance = options.maxChance || 40;

    const chance = randomIntFromInterval(0, maxChance);

    if(chance > 0) {
        return;
    }

    const z = options.z || 0;
    const zIndex = options.zI || 0;
    const color = options.color || "#EF6C00";
    const colorVariance = options.colorVariance || 12;
    const loopBack = options.loopBack || false;

    const rv = randomIntFromInterval(1, 2) / 100;

    instance.insertParticleInstruction({
        x: options.x,
        y: options.y,
        z: z,
        zI: zIndex,
        vx: Math.sin(instance.rndAngle) * 2,
        vy: rv,
        vz: 0,
        gz: -0.01,
        tv: 0,
        color: color,
        size: 1,
        opacity: 0.6,
        composit: "screen",
        ignoreLighting: false,
        trails: false,
        useRaw: false,
        useGlobalAngle: true,
        loopsBack: loopBack,
        colorVariance: colorVariance
    });
}

export default {
    getPixelEngineInstance,
    loadTexture,
    getTargetFramerate,
    isOdd,
    onResize,
    PixelEngineInstance,
    Texture,
    EFFECT_PROGRAMS,
    ENVIRONMENTAL_EFFECTS
};

globalRender();