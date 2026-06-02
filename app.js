import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Shader Materials ---
const customVertexShader = `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPosition;
    varying vec3 vViewPosition;

    void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        vViewPosition = cameraPosition - worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
`;

const marbleFragmentShader = `
    uniform vec3 uLightPosition;
    uniform vec3 uLightColor;
    uniform vec3 uAmbientColor;
    uniform vec3 uBaseColor;
    uniform vec3 uVeinColor;
    uniform float uTime;

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPosition;
    varying vec3 vViewPosition;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
    }

    float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        vec2 shift = vec2(100.0);
        mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
        for (int i = 0; i < 4; ++i) {
            v += a * noise(p);
            p = rot * p * 2.0 + shift;
            a *= 0.5;
        }
        return v;
    }

    void main() {
        vec2 uv = vUv * 5.0;
        float n = fbm(uv + vec2(uTime * 0.04, uTime * 0.01));
        float marble = sin(uv.y * 3.0 + n * 6.0);
        marble = marble * 0.5 + 0.5;
        marble = smoothstep(0.15, 0.85, marble);
        
        vec3 materialColor = mix(uBaseColor, uVeinColor, marble);

        vec3 N = normalize(vNormal);
        vec3 L = normalize(uLightPosition - vWorldPosition);
        vec3 V = normalize(vViewPosition);
        vec3 H = normalize(L + V);

        vec3 ambient = uAmbientColor * materialColor;
        float diff = max(dot(N, L), 0.0);
        vec3 diffuse = uLightColor * materialColor * diff;
        float spec = pow(max(dot(N, H), 0.0), 32.0);
        vec3 specular = uLightColor * vec3(0.55) * spec;

        gl_FragColor = vec4(ambient + diffuse + specular, 1.0);
    }
`;

const holoFragmentShader = `
    uniform vec3 uLightPosition;
    uniform vec3 uLightColor;
    uniform vec3 uAmbientColor;
    uniform vec3 uBaseColor;
    uniform float uTime;

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPosition;
    varying vec3 vViewPosition;

    void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewPosition);
        vec3 L = normalize(uLightPosition - vWorldPosition);
        vec3 H = normalize(L + V);

        float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.2);

        vec3 rainbow = vec3(
            sin(uTime * 1.8 + vWorldPosition.y * 6.0) * 0.5 + 0.5,
            sin(uTime * 1.8 + vWorldPosition.y * 6.0 + 2.09) * 0.5 + 0.5,
            sin(uTime * 1.8 + vWorldPosition.y * 6.0 + 4.18) * 0.5 + 0.5
        );

        vec3 materialColor = mix(uBaseColor, rainbow, fresnel * 0.8);

        vec3 ambient = uAmbientColor * materialColor;
        float diff = max(dot(N, L), 0.0);
        vec3 diffuse = uLightColor * materialColor * diff;
        float spec = pow(max(dot(N, H), 0.0), 96.0);
        vec3 specular = uLightColor * vec3(0.85) * spec;

        gl_FragColor = vec4(ambient + diffuse + specular, 1.0);
    }
`;

// --- Global Application State ---
let scene, camera, renderer, controls;
let deskMesh, paperMesh, blotterMesh;
let penGroup, currentPenMesh;
let lampLight, tipLight;

// Canvas Drawing variables
let staticPaperCanvas, writingCanvas, writingCtx, writingTexture;
let paperBumpTexture, pencilWoodTexture;

// Interaction & Animation Settings
let penType = 'fountain'; // fountain, stylus, pencil
let currentSelectedColor = '#0b2240'; // royal blue
let inkColor = '#0b2240';
let strokeWidth = 4.0;

let isWriting = true;
let isDrawingMode = false;
let isMouseDown = false;
let writeSpeed = 1.0;
let time = 0;
let pathIndex = 0;
let lastPathIndex = 0;
let lastPenPos = null;

// Mouse draw trace
let lastDrawX = null;
let lastDrawY = null;

// Keyboard state
const keys = {};

// Spline tracking
let WritingPath = [];

// Props
let holderGroup = null;
let holderPens = [];
const clock = new THREE.Clock();

// Shader Uniforms
const marbleUniforms = {
    uLightPosition: { value: new THREE.Vector3(10, 18, 12) },
    uLightColor: { value: new THREE.Color(0xfff1e0) },
    uAmbientColor: { value: new THREE.Color(0x333333) },
    uBaseColor: { value: new THREE.Color(0x0a3c2c) }, // Forest marble
    uVeinColor: { value: new THREE.Color(0xdfc19c) }, // Gold/cream veins
    uTime: { value: 0 }
};

const holoUniforms = {
    uLightPosition: { value: new THREE.Vector3(10, 18, 12) },
    uLightColor: { value: new THREE.Color(0xfff1e0) },
    uAmbientColor: { value: new THREE.Color(0x333333) },
    uBaseColor: { value: new THREE.Color(0x18181b) }, // Obsidian Titanium
    uTime: { value: 0 }
};

// --- Procedural Canvas Texture Generators ---

function createWoodTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    
    // Rich walnut dark brown base
    ctx.fillStyle = '#412918';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Wave layers for wood growth rings
    const numStripes = 90;
    for (let i = 0; i < numStripes; i++) {
        ctx.fillStyle = i % 2 === 0 ? 'rgba(48, 28, 12, 0.16)' : 'rgba(84, 56, 36, 0.1)';
        
        ctx.beginPath();
        const startY = (i / numStripes) * canvas.height;
        ctx.moveTo(0, startY);
        
        const waveAmp = 40 + Math.random() * 50;
        const waveFreq = 1.5 + Math.random() * 2.5;
        
        for (let x = 0; x <= canvas.width; x += 10) {
            // Wood knot distortion
            let knotDistortion = 0;
            const knotX = 512;
            const knotY = 480;
            const dx = x - knotX;
            const dy = startY - knotY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < 320) {
                knotDistortion = Math.sin(dist / 35) * 75 * (1 - dist / 320);
            }
            const y = startY + Math.sin((x / canvas.width) * waveFreq * Math.PI) * waveAmp + knotDistortion;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(canvas.width, canvas.height);
        ctx.lineTo(0, canvas.height);
        ctx.closePath();
        ctx.fill();
    }
    
    // Fine wood fibers
    for (let j = 0; j < 6000; j++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const w = 40 + Math.random() * 120;
        const h = 1 + Math.random() * 2;
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0, 0, 0, 0.07)' : 'rgba(255, 255, 255, 0.04)';
        ctx.fillRect(x, y, w, h);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

function createPaperTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1330; // Portrait A4-like aspect ratio
    const ctx = canvas.getContext('2d');
    
    // Soft off-white paper pulp background
    ctx.fillStyle = '#faf8f5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Subtle paper pulpy fiber noise
    for (let i = 0; i < 20000; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const len = 3 + Math.random() * 6;
        const angle = Math.random() * Math.PI * 2;
        ctx.strokeStyle = Math.random() > 0.5 ? 'rgba(0,0,0,0.012)' : 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 0.5 + Math.random() * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
        ctx.stroke();
    }
    
    // Draw notebook rules
    ctx.strokeStyle = 'rgba(75, 140, 210, 0.22)';
    ctx.lineWidth = 2.0;
    const lineSpacing = 42;
    for (let y = 140; y < canvas.height - 60; y += lineSpacing) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
    
    // Vertical margin line
    ctx.strokeStyle = 'rgba(225, 95, 95, 0.32)';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(140, 0);
    ctx.lineTo(140, canvas.height);
    ctx.stroke();
    
    return canvas;
}

function createPaperBumpTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // High-frequency noise for grain displacement
    for (let i = 0; i < 45000; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const radius = 0.4 + Math.random() * 0.7;
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

function createPencilWoodTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    // Classic pencil cedar base (yellow orange)
    ctx.fillStyle = '#dda15e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Cedar stripes
    ctx.fillStyle = '#bc6c25';
    for (let i = 0; i < 12; i++) {
        const x = Math.random() * canvas.width;
        const w = 1 + Math.random() * 4;
        ctx.fillRect(x, 0, w, canvas.height);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

function resetPaperCanvas() {
    writingCtx.drawImage(staticPaperCanvas, 0, 0, writingCanvas.width, writingCanvas.height);
    writingTexture.needsUpdate = true;
}

// --- 3D Geometry and Component Generators ---

function createPenMesh(type) {
    const group = new THREE.Group();
    
    const goldMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        metalness: 1.0,
        roughness: 0.12
    });
    
    const steelMat = new THREE.MeshStandardMaterial({
        color: 0x3a3a3d,
        metalness: 0.85,
        roughness: 0.25
    });

    if (type === 'fountain') {
        const marbleMat = new THREE.ShaderMaterial({
            vertexShader: customVertexShader,
            fragmentShader: marbleFragmentShader,
            uniforms: marbleUniforms
        });
        
        // Grip Section (Tapered metal cone/cylinder)
        const gripGeo = new THREE.CylinderGeometry(0.16, 0.11, 1.2, 16);
        const grip = new THREE.Mesh(gripGeo, steelMat);
        grip.position.y = 0.8;
        grip.castShadow = true;
        group.add(grip);
        
        // Gold bands (Decorative)
        const band1Geo = new THREE.CylinderGeometry(0.18, 0.18, 0.08, 16);
        const band1 = new THREE.Mesh(band1Geo, goldMat);
        band1.position.y = 1.44;
        band1.castShadow = true;
        group.add(band1);
        
        // Marble Barrel
        const barrelGeo = new THREE.CylinderGeometry(0.20, 0.19, 3.8, 16);
        const barrel = new THREE.Mesh(barrelGeo, marbleMat);
        barrel.position.y = 3.38;
        barrel.castShadow = true;
        group.add(barrel);
        
        // Cap end (Gold topper)
        const topperGeo = new THREE.CylinderGeometry(0.19, 0.12, 0.3, 16);
        const topper = new THREE.Mesh(topperGeo, goldMat);
        topper.position.y = 5.43;
        topper.castShadow = true;
        group.add(topper);
        
        // Nib (Calligraphy writing tip)
        const nibGeo = new THREE.ConeGeometry(0.10, 0.5, 16);
        const nib = new THREE.Mesh(nibGeo, goldMat);
        nib.scale.set(0.3, 1.0, 1.0); // Squashed to flat pen shape
        nib.position.y = 0.25;
        nib.castShadow = true;
        group.add(nib);
        
    } else if (type === 'stylus') {
        const holoMat = new THREE.ShaderMaterial({
            vertexShader: customVertexShader,
            fragmentShader: holoFragmentShader,
            uniforms: holoUniforms
        });
        
        const darkMetalMat = new THREE.MeshStandardMaterial({
            color: 0x18181c,
            metalness: 0.9,
            roughness: 0.35
        });
        
        // Glowing LED indicator
        const activeGlowMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(inkColor)
        });
        
        // Stylus Body
        const bodyGeo = new THREE.CylinderGeometry(0.15, 0.15, 5.0, 16);
        const body = new THREE.Mesh(bodyGeo, holoMat);
        body.position.y = 2.9;
        body.castShadow = true;
        group.add(body);
        
        // Tapered stylus head
        const headGeo = new THREE.CylinderGeometry(0.15, 0.08, 0.5, 16);
        const head = new THREE.Mesh(headGeo, darkMetalMat);
        head.position.y = 0.55;
        head.castShadow = true;
        group.add(head);
        
        // Glowing tip emitter ring
        const glowRingGeo = new THREE.CylinderGeometry(0.08, 0.06, 0.1, 16);
        const glowRing = new THREE.Mesh(glowRingGeo, activeGlowMat);
        glowRing.position.y = 0.25;
        glowRing.name = "glowRing"; // Named so we can find it later
        group.add(glowRing);
        
        // Stylus nib rubber point
        const softTipGeo = new THREE.ConeGeometry(0.06, 0.2, 16);
        const softTip = new THREE.Mesh(softTipGeo, darkMetalMat);
        softTip.position.y = 0.1;
        softTip.castShadow = true;
        group.add(softTip);
        
        // Stylus clip
        const clipGeo = new THREE.BoxGeometry(0.05, 1.1, 0.14);
        const clip = new THREE.Mesh(clipGeo, darkMetalMat);
        clip.position.set(0, 4.7, 0.18);
        clip.castShadow = true;
        group.add(clip);
        
    } else if (type === 'pencil') {
        const pencilWoodMat = new THREE.MeshStandardMaterial({
            map: pencilWoodTexture,
            roughness: 0.55
        });
        
        const shavedWoodMat = new THREE.MeshStandardMaterial({
            color: 0xe5c8a3,
            roughness: 0.85
        });
        
        const graphiteMat = new THREE.MeshStandardMaterial({
            color: 0x2b2b2b,
            roughness: 0.9,
            metalness: 0.1
        });
        
        const ferruleMat = new THREE.MeshStandardMaterial({
            color: 0xaaaaaa,
            metalness: 0.85,
            roughness: 0.2
        });
        
        const eraserMat = new THREE.MeshStandardMaterial({
            color: 0xff9494,
            roughness: 0.8
        });
        
        // Hexagonal body
        const bodyGeo = new THREE.CylinderGeometry(0.13, 0.13, 4.6, 6);
        const body = new THREE.Mesh(bodyGeo, pencilWoodMat);
        body.position.y = 3.0;
        body.castShadow = true;
        group.add(body);
        
        // Shaved tip cone
        const tipGeo = new THREE.ConeGeometry(0.13, 0.6, 6);
        const tip = new THREE.Mesh(tipGeo, shavedWoodMat);
        tip.position.y = 0.4;
        tip.castShadow = true;
        group.add(tip);
        
        // Graphite tip
        const leadGeo = new THREE.ConeGeometry(0.04, 0.18, 6);
        const lead = new THREE.Mesh(leadGeo, graphiteMat);
        lead.position.y = 0.09;
        lead.castShadow = true;
        group.add(lead);
        
        // Aluminum ferrule ring
        const ferruleGeo = new THREE.CylinderGeometry(0.131, 0.131, 0.35, 6);
        const ferrule = new THREE.Mesh(ferruleGeo, ferruleMat);
        ferrule.position.y = 5.475;
        ferrule.castShadow = true;
        group.add(ferrule);
        
        // Pink eraser rubber
        const eraserGeo = new THREE.CylinderGeometry(0.131, 0.131, 0.4, 6);
        const eraser = new THREE.Mesh(eraserGeo, eraserMat);
        eraser.position.y = 5.85;
        eraser.castShadow = true;
        group.add(eraser);
    }
    
    return group;
}

function createPenHolder() {
    holderGroup = new THREE.Group();
    
    // Premium glass cup container
    const holderGeo = new THREE.CylinderGeometry(0.8, 0.8, 2.4, 32);
    const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.3,
        roughness: 0.1,
        metalness: 0.05,
        transmission: 0.95,
        ior: 1.5,
        thickness: 0.12,
        side: THREE.DoubleSide
    });
    
    const holder = new THREE.Mesh(holderGeo, glassMat);
    holder.position.set(-8.2, 1.2, -7.5);
    holder.castShadow = true;
    holder.receiveShadow = true;
    holderGroup.add(holder);
    
    // Brass decorative top lip ring
    const rimGeo = new THREE.CylinderGeometry(0.82, 0.82, 0.08, 32);
    const brassMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        metalness: 0.9,
        roughness: 0.15
    });
    const rim = new THREE.Mesh(rimGeo, brassMat);
    rim.position.set(-8.2, 2.4, -7.5);
    rim.castShadow = true;
    holderGroup.add(rim);
    
    // Heavy brass base
    const baseGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.12, 32);
    const baseMesh = new THREE.Mesh(baseGeo, brassMat);
    baseMesh.position.set(-8.2, 0.06, -7.5);
    baseMesh.castShadow = true;
    baseMesh.receiveShadow = true;
    holderGroup.add(baseMesh);
    
    scene.add(holderGroup);
}

function updateHolderPens() {
    // Clear old pens in the holder
    for (let p of holderPens) {
        holderGroup.remove(p);
    }
    holderPens = [];
    
    const penTypes = ['fountain', 'stylus', 'pencil'];
    let offsetCount = 0;
    
    for (let type of penTypes) {
        if (type !== penType) {
            const penMesh = createPenMesh(type);
            
            // Stand the pen in the holder, tilted
            penMesh.position.set(-8.2, 1.0, -7.5);
            
            if (offsetCount === 0) {
                penMesh.rotation.set(0.18, 0, 0.32);
                penMesh.position.x += 0.15;
                penMesh.position.z += 0.12;
            } else {
                penMesh.rotation.set(-0.22, 0, -0.28);
                penMesh.position.x -= 0.15;
                penMesh.position.z -= 0.12;
            }
            
            holderGroup.add(penMesh);
            holderPens.push(penMesh);
            offsetCount++;
        }
    }
}

function addFountainPenCap() {
    const capGroup = new THREE.Group();
    
    const marbleMat = new THREE.ShaderMaterial({
        vertexShader: customVertexShader,
        fragmentShader: marbleFragmentShader,
        uniforms: marbleUniforms
    });
    
    const goldMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        metalness: 1.0,
        roughness: 0.12
    });

    const capGeo = new THREE.CylinderGeometry(0.23, 0.23, 2.1, 16);
    const cap = new THREE.Mesh(capGeo, marbleMat);
    cap.position.y = 1.05;
    cap.castShadow = true;
    cap.receiveShadow = true;
    capGroup.add(cap);

    const clipGeo = new THREE.BoxGeometry(0.05, 1.2, 0.14);
    const clip = new THREE.Mesh(clipGeo, goldMat);
    clip.position.set(0, 1.2, 0.27);
    clip.castShadow = true;
    capGroup.add(clip);

    const bandGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.2, 16);
    const band = new THREE.Mesh(bandGeo, goldMat);
    band.position.y = 0.1;
    band.castShadow = true;
    capGroup.add(band);

    const topGeo = new THREE.CylinderGeometry(0.23, 0.16, 0.2, 16);
    const topMesh = new THREE.Mesh(topGeo, goldMat);
    topMesh.position.y = 2.15;
    topMesh.castShadow = true;
    capGroup.add(topMesh);

    // Lay the cap flat on the desk blotter
    capGroup.position.set(-6.0, 0.22, -6.0);
    capGroup.rotation.x = Math.PI / 2;
    capGroup.rotation.z = Math.PI / 4.5;
    
    scene.add(capGroup);
}

// --- Writing Path Script Generator ---

function buildWritingPath() {
    WritingPath = [];
    
    // Scale factor to map coordinates to paper area
    const sX = 0.85;
    const sY = 0.85;
    
    const strokes = [
        // T-Cross stroke
        { points: [new THREE.Vector3(-6 * sX, 4.5 * sY, 0), new THREE.Vector3(-3.2 * sX, 4.5 * sY, 0)], type: 'curve' },
        // T-Stem stroke
        { points: [new THREE.Vector3(-4.6 * sX, 4.5 * sY, 0), new THREE.Vector3(-4.6 * sX, 1.8 * sY, 0), new THREE.Vector3(-5.0 * sX, 1.4 * sY, 0), new THREE.Vector3(-5.3 * sX, 1.8 * sY, 0), new THREE.Vector3(-5.0 * sX, 2.2 * sY, 0)], type: 'curve' },
        // h-r-e-e (Continuous flowing strokes)
        { points: [
            new THREE.Vector3(-4.1 * sX, 2.2 * sY, 0), 
            new THREE.Vector3(-4.1 * sX, 4.0 * sY, 0), 
            new THREE.Vector3(-4.1 * sX, 1.4 * sY, 0), 
            new THREE.Vector3(-4.1 * sX, 2.3 * sY, 0), 
            new THREE.Vector3(-3.5 * sX, 2.3 * sY, 0), 
            new THREE.Vector3(-3.3 * sX, 1.4 * sY, 0), // h end, start r
            new THREE.Vector3(-2.9 * sX, 2.3 * sY, 0), 
            new THREE.Vector3(-2.4 * sX, 2.3 * sY, 0), 
            new THREE.Vector3(-2.6 * sX, 1.4 * sY, 0), // r end, start e1
            new THREE.Vector3(-1.9 * sX, 1.6 * sY, 0), 
            new THREE.Vector3(-1.7 * sX, 2.1 * sY, 0), 
            new THREE.Vector3(-2.1 * sX, 2.1 * sY, 0), 
            new THREE.Vector3(-2.2 * sX, 1.5 * sY, 0), 
            new THREE.Vector3(-1.7 * sX, 1.4 * sY, 0), // e1 end, start e2
            new THREE.Vector3(-1.0 * sX, 1.6 * sY, 0), 
            new THREE.Vector3(-0.8 * sX, 2.1 * sY, 0), 
            new THREE.Vector3(-1.2 * sX, 2.1 * sY, 0), 
            new THREE.Vector3(-1.3 * sX, 1.5 * sY, 0), 
            new THREE.Vector3(-0.8 * sX, 1.4 * sY, 0),
            new THREE.Vector3(-0.4 * sX, 1.8 * sY, 0)
        ], type: 'curve' },
        // Dot stroke
        { points: [new THREE.Vector3(0.1 * sX, 1.4 * sY, 0), new THREE.Vector3(0.15 * sX, 1.4 * sY, 0)], type: 'dot' },
        // j-s stroke (Connected)
        { points: [
            new THREE.Vector3(0.8 * sX, 2.3 * sY, 0), 
            new THREE.Vector3(0.8 * sX, -0.4 * sY, 0), 
            new THREE.Vector3(0.5 * sX, -0.8 * sY, 0), 
            new THREE.Vector3(0.3 * sX, -0.4 * sY, 0), 
            new THREE.Vector3(0.8 * sX, 1.2 * sY, 0), 
            new THREE.Vector3(1.1 * sX, 1.5 * sY, 0), // j end, start s
            new THREE.Vector3(1.6 * sX, 2.3 * sY, 0), 
            new THREE.Vector3(1.8 * sX, 2.3 * sY, 0), 
            new THREE.Vector3(1.4 * sX, 1.8 * sY, 0), 
            new THREE.Vector3(1.9 * sX, 1.4 * sY, 0), 
            new THREE.Vector3(2.1 * sX, 1.5 * sY, 0)
        ], type: 'curve' },
        // j-dot stroke
        { points: [new THREE.Vector3(0.8 * sX, 2.8 * sY, 0), new THREE.Vector3(0.85 * sX, 2.8 * sY, 0)], type: 'dot' },
        // Scroll flourish
        { points: [
            new THREE.Vector3(2.1 * sX, 1.0 * sY, 0), 
            new THREE.Vector3(1.2 * sX, 0.0 * sY, 0), 
            new THREE.Vector3(-1.0 * sX, -0.2 * sY, 0), 
            new THREE.Vector3(-3.2 * sX, -0.2 * sY, 0), 
            new THREE.Vector3(-4.8 * sX, -0.3 * sY, 0), 
            new THREE.Vector3(-5.5 * sX, -0.7 * sY, 0), 
            new THREE.Vector3(-5.6 * sX, -1.2 * sY, 0), 
            new THREE.Vector3(-5.0 * sX, -1.5 * sY, 0), 
            new THREE.Vector3(-4.0 * sX, -1.3 * sY, 0), 
            new THREE.Vector3(-1.8 * sX, -0.9 * sY, 0), 
            new THREE.Vector3(1.2 * sX, -0.9 * sY, 0), 
            new THREE.Vector3(3.2 * sX, -1.0 * sY, 0), 
            new THREE.Vector3(4.3 * sX, -1.3 * sY, 0), 
            new THREE.Vector3(4.5 * sX, -1.8 * sY, 0), 
            new THREE.Vector3(4.0 * sX, -2.1 * sY, 0), 
            new THREE.Vector3(3.1 * sX, -1.8 * sY, 0)
        ], type: 'curve' }
    ];

    // Mathematical Spirograph (Sits on the bottom section of paper)
    const spiroPoints = [];
    const centerX = 0;
    const centerY = -5.0;
    const R = 3.6;
    const r = 2.2;
    const p = 1.8;
    const steps = 240;
    for (let i = 0; i <= steps; i++) {
        let t = (i / steps) * Math.PI * 10; // 5 full petal rotations
        let x = centerX + (R - r) * Math.cos(t) + p * Math.cos((R - r) * t / r);
        let y = centerY + (R - r) * Math.sin(t) - p * Math.sin((R - r) * t / r);
        spiroPoints.push(new THREE.Vector3(x, y, 0));
    }
    strokes.push({ points: spiroPoints, type: 'curve' });

    // Compile into continuous WritingPath with Lift/Fly/Drop transitions
    for (let i = 0; i < strokes.length; i++) {
        const stroke = strokes[i];
        let curvePoints = [];
        
        if (stroke.type === 'dot') {
            curvePoints = stroke.points;
        } else {
            const curve = new THREE.CatmullRomCurve3(stroke.points);
            const numSamples = Math.max(30, stroke.points.length * 7);
            curvePoints = curve.getPoints(numSamples);
        }

        if (WritingPath.length > 0) {
            const startPt = WritingPath[WritingPath.length - 1];
            const endPt = curvePoints[0];
            
            // Create transition coordinates (in-air travel height = 1.2 units)
            const liftPt = new THREE.Vector3(startPt.x, startPt.y, 1.2);
            const flyPt = new THREE.Vector3(endPt.x, endPt.y, 1.2);
            
            // Lift
            const liftSteps = 10;
            for (let j = 1; j <= liftSteps; j++) {
                const alpha = j / liftSteps;
                WritingPath.push({
                    x: THREE.MathUtils.lerp(startPt.x, liftPt.x, alpha),
                    y: THREE.MathUtils.lerp(startPt.y, liftPt.y, alpha),
                    z: THREE.MathUtils.lerp(startPt.z, liftPt.z, alpha),
                    isWriting: false
                });
            }
            // Fly
            const flySteps = 16;
            for (let j = 1; j <= flySteps; j++) {
                const alpha = j / flySteps;
                WritingPath.push({
                    x: THREE.MathUtils.lerp(liftPt.x, flyPt.x, alpha),
                    y: THREE.MathUtils.lerp(liftPt.y, flyPt.y, alpha),
                    z: THREE.MathUtils.lerp(liftPt.z, flyPt.z, alpha),
                    isWriting: false
                });
            }
            // Drop
            const dropSteps = 10;
            for (let j = 1; j <= dropSteps; j++) {
                const alpha = j / dropSteps;
                WritingPath.push({
                    x: THREE.MathUtils.lerp(flyPt.x, endPt.x, alpha),
                    y: THREE.MathUtils.lerp(flyPt.y, endPt.y, alpha),
                    z: THREE.MathUtils.lerp(flyPt.z, 0, alpha),
                    isWriting: false
                });
            }
        } else {
            const endPt = curvePoints[0];
            const dropSteps = 15;
            for (let j = 0; j < dropSteps; j++) {
                const alpha = j / dropSteps;
                WritingPath.push({
                    x: endPt.x,
                    y: endPt.y,
                    z: THREE.MathUtils.lerp(1.8, 0, alpha),
                    isWriting: false
                });
            }
        }

        for (let j = 0; j < curvePoints.length; j++) {
            WritingPath.push({
                x: curvePoints[j].x,
                y: curvePoints[j].y,
                z: 0,
                isWriting: true
            });
        }
    }
}

// --- Core Scene Construction & Init ---

function init() {
    const container = document.getElementById('canvas-container');
    
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0d);
    
    // Camera
    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 16, 20); // Default isometric workspace angle
    
    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    
    // Orbit Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // Prevent camera clipping through table
    controls.minDistance = 8;
    controls.maxDistance = 35;
    controls.target.set(0, 0.5, 0);

    // --- Generate Procedural Textures ---
    const deskWoodTexture = createWoodTexture();
    staticPaperCanvas = createPaperTexture();
    paperBumpTexture = createPaperBumpTexture();
    pencilWoodTexture = createPencilWoodTexture();

    // Set up active drawing canvas
    writingCanvas = document.createElement('canvas');
    writingCanvas.width = 2048;
    writingCanvas.height = 2048;
    writingCtx = writingCanvas.getContext('2d');
    writingTexture = new THREE.CanvasTexture(writingCanvas);
    writingTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    
    resetPaperCanvas();

    // --- Build Room & Table Scenery ---
    
    // Wooden Desk Table top
    const deskGeo = new THREE.BoxGeometry(42, 0.3, 30);
    const deskMat = new THREE.MeshStandardMaterial({
        map: deskWoodTexture,
        roughness: 0.35,
        metalness: 0.1
    });
    deskMesh = new THREE.Mesh(deskGeo, deskMat);
    deskMesh.position.set(0, -0.15, 0);
    deskMesh.receiveShadow = true;
    scene.add(deskMesh);

    // Leather desk blotter pad
    const blotterGeo = new THREE.BoxGeometry(22, 0.04, 27);
    const blotterMat = new THREE.MeshStandardMaterial({
        color: 0x1a1614, // dark leather
        roughness: 0.7,
        metalness: 0.0
    });
    blotterMesh = new THREE.Mesh(blotterGeo, blotterMat);
    blotterMesh.position.set(0, 0.02, 0);
    blotterMesh.receiveShadow = true;
    blotterMesh.castShadow = true;
    scene.add(blotterMesh);

    // Rule Paper sheet setup (MultiMaterial)
    const paperGeo = new THREE.BoxGeometry(16, 0.04, 21.3); // Proportionate 3:4 A4 shape
    const paperSideMat = new THREE.MeshStandardMaterial({
        color: 0xdddddd,
        roughness: 0.95,
        bumpMap: paperBumpTexture,
        bumpScale: 0.001
    });
    const paperTopMat = new THREE.MeshStandardMaterial({
        map: writingTexture,
        bumpMap: paperBumpTexture,
        bumpScale: 0.003,
        roughness: 0.85,
        metalness: 0.02
    });
    
    // Order: Right, Left, Top, Bottom, Front, Back
    const paperMaterials = [
        paperSideMat, // +X
        paperSideMat, // -X
        paperTopMat,  // +Y (writing surface)
        paperSideMat, // -Y
        paperSideMat, // +Z
        paperSideMat  // -Z
    ];
    paperMesh = new THREE.Mesh(paperGeo, paperMaterials);
    paperMesh.position.set(0, 0.06, 0);
    paperMesh.receiveShadow = true;
    paperMesh.castShadow = true;
    scene.add(paperMesh);

    // Static scene props (Lamp, Pen Holder, Fountain cap)
    const lampGroup = new THREE.Group();

    const brassMat = new THREE.MeshStandardMaterial({
        color: 0xd4af37,
        metalness: 0.9,
        roughness: 0.16
    });

    const lampBaseGeo = new THREE.CylinderGeometry(1.3, 1.3, 0.1, 32);
    const lampBase = new THREE.Mesh(lampBaseGeo, brassMat);
    lampBase.position.set(10.5, 0.05, -8.0);
    lampBase.castShadow = true;
    lampBase.receiveShadow = true;
    lampGroup.add(lampBase);

    const armGeo = new THREE.CylinderGeometry(0.08, 0.08, 6.0, 16);
    const arm = new THREE.Mesh(armGeo, brassMat);
    arm.position.set(10.5, 3.0, -8.0);
    arm.rotation.z = -0.3; // Angle forward
    arm.rotation.x = 0.2;
    arm.castShadow = true;
    lampGroup.add(arm);

    const shadeGeo = new THREE.CylinderGeometry(0.55, 1.2, 1.5, 32, 1, true);
    const shadeMat = new THREE.MeshStandardMaterial({
        color: 0x1f2022,
        roughness: 0.45,
        side: THREE.DoubleSide
    });
    const shade = new THREE.Mesh(shadeGeo, shadeMat);
    shade.position.set(8.2, 6.8, -5.0);
    shade.rotation.x = Math.PI / 3.8;
    shade.rotation.z = -Math.PI / 5;
    shade.castShadow = true;
    lampGroup.add(shade);

    const bulbGeo = new THREE.SphereGeometry(0.28, 16, 16);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffeedd });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.set(8.25, 6.55, -4.75);
    lampGroup.add(bulb);
    
    scene.add(lampGroup);

    // Decorative Fountain Pen Cap
    addFountainPenCap();

    // Pen Holder Cup
    createPenHolder();

    // --- Lighting ---
    
    // Soft environmental fill
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambientLight);

    // Main Desk Lamp SpotLight (warm and focused)
    lampLight = new THREE.SpotLight(0xfff1e0, 2.2);
    lampLight.position.set(8.25, 6.55, -4.75);
    lampLight.target = paperMesh;
    lampLight.angle = Math.PI / 3.5;
    lampLight.penumbra = 0.65;
    lampLight.castShadow = true;
    lampLight.shadow.mapSize.width = 2048;
    lampLight.shadow.mapSize.height = 2048;
    lampLight.shadow.camera.near = 3;
    lampLight.shadow.camera.far = 25;
    lampLight.shadow.bias = -0.0004;
    scene.add(lampLight);

    // Dynamic localized point light at pen tip (mainly for neon glowing stylus)
    tipLight = new THREE.PointLight(0x00f0ff, 0.0, 3.5);
    tipLight.position.set(0, 1.0, 0);
    scene.add(tipLight);

    // --- Set up the Active Pen ---
    penGroup = new THREE.Group();
    scene.add(penGroup);
    
    switchPen('fountain');
    updateHolderPens();

    // Compile cursive points path
    buildWritingPath();

    // Set initial pen position
    if (WritingPath.length > 0) {
        const start = WritingPath[0];
        // 2D X -> 3D X
        // 2D Y -> 3D -Z
        // 2D Z -> 3D Y (elevated flight)
        penGroup.position.set(start.x, 0.07 + start.z, -start.y);
        lastPenPos = penGroup.position.clone();
    }

    // --- Attach Event Listeners ---
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    
    // Binding drawing and raycasting mouse events
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    
    // UI Event Linkages
    setupUIListeners();
}

// --- Pen Switching & Styling Updates ---

function switchPen(type) {
    if (currentPenMesh) {
        penGroup.remove(currentPenMesh);
    }
    
    currentPenMesh = createPenMesh(type);
    penGroup.add(currentPenMesh);
    penType = type;

    // Apply specific parameters for each writing tool
    if (type === 'fountain') {
        inkColor = currentSelectedColor;
        strokeWidth = 3.6;
        tipLight.color.setHex(0xfff1e0);
        tipLight.intensity = 0.12; // faint metallic reflection glow
    } else if (type === 'stylus') {
        // Holographic stylus glows with the selected preset color!
        inkColor = currentSelectedColor === '#1c1c1c' ? '#ff00ea' : currentSelectedColor; // avoid writing black in neon mode
        if (inkColor === '#0b2240') inkColor = '#00f0ff'; // default to cyan glow
        
        strokeWidth = 5.5;
        tipLight.color.setStyle(inkColor);
        tipLight.intensity = 0.85; // vibrant neon bloom
        
        // Update shader stylus internal glow ring mesh
        const ring = currentPenMesh.getObjectByName("glowRing");
        if (ring) {
            ring.material.color.setStyle(inkColor);
        }
    } else if (type === 'pencil') {
        inkColor = '#323235'; // pencil graphite
        strokeWidth = 1.6;
        tipLight.color.setHex(0xffffff);
        tipLight.intensity = 0.0; // Pencils don't emit light
    }
    
    // Sync stylus uniforms base color
    holoUniforms.uBaseColor.value.setStyle(type === 'stylus' ? '#18181b' : '#000000');
}

function updateTipLight(position, isActive) {
    tipLight.position.set(position.x, position.y + 0.18, position.z);
    
    if (penType === 'stylus') {
        tipLight.intensity = isActive ? 0.95 : 0.45;
    } else if (penType === 'fountain') {
        tipLight.intensity = isActive ? 0.15 : 0.0;
    } else {
        tipLight.intensity = 0.0;
    }
}

// --- Interactions and UI bindings ---

function setupUIListeners() {
    // Select pen drawers
    document.querySelectorAll('.btn-pen').forEach(button => {
        button.addEventListener('click', (e) => {
            const btn = e.currentTarget;
            document.querySelectorAll('.btn-pen').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const selectedPen = btn.getAttribute('data-pen');
            switchPen(selectedPen);
            updateHolderPens();
        });
    });

    // Preset color dots
    document.querySelectorAll('.color-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
            
            const color = dot.getAttribute('data-color');
            currentSelectedColor = color;
            
            // Apply immediately to current pen
            if (penType === 'fountain') {
                inkColor = color;
            } else if (penType === 'stylus') {
                inkColor = color === '#1c1c1c' ? '#ff00ea' : color;
                tipLight.color.setStyle(inkColor);
                const ring = currentPenMesh.getObjectByName("glowRing");
                if (ring) ring.material.color.setStyle(inkColor);
            }
        });
    });

    // Action toggle drawing mode
    const btnDrawMode = document.getElementById('btn-draw-mode');
    btnDrawMode.addEventListener('click', () => {
        isDrawingMode = !isDrawingMode;
        btnDrawMode.classList.toggle('active', isDrawingMode);
        
        if (isDrawingMode) {
            btnDrawMode.innerHTML = `<span class="icon">🤖</span> Resume Auto-Write`;
            isWriting = false;
            // Float the pen up
            penGroup.position.y = 0.07 + 0.5;
        } else {
            btnDrawMode.innerHTML = `<span class="icon">✍️</span> Enable Mouse Drawing`;
            isWriting = true;
            pathIndex = 0; // restart auto sequence
            resetPaperCanvas();
        }
    });

    // Action Clear
    document.getElementById('btn-clear').addEventListener('click', () => {
        resetPaperCanvas();
        if (!isDrawingMode && !isWriting) {
            pathIndex = 0;
        }
    });

    // Action Play / Pause Auto-write
    const btnPlayPause = document.getElementById('btn-play-pause');
    btnPlayPause.addEventListener('click', () => {
        if (isDrawingMode) return; // Ignore in drawing mode
        isWriting = !isWriting;
        btnPlayPause.classList.toggle('paused', !isWriting);
        
        const icon = document.getElementById('play-pause-icon');
        const txt = document.getElementById('play-pause-text');
        
        if (isWriting) {
            icon.innerText = '⏸';
            txt.innerText = 'Pause Auto-Write';
        } else {
            icon.innerText = '▶';
            txt.innerText = 'Play Auto-Write';
        }
    });

    // Speed input slider
    const speedSlider = document.getElementById('write-speed');
    speedSlider.addEventListener('input', (e) => {
        writeSpeed = parseFloat(e.target.value);
    });
}

// Keyboard input listeners
function onKeyDown(e) {
    keys[e.key.toLowerCase()] = true;
}

function onKeyUp(e) {
    keys[e.key.toLowerCase()] = false;
    
    // Spacebar triggers view reset
    if (e.code === 'Space') {
        e.preventDefault();
        resetCamera();
    }
}

function resetCamera() {
    // Smooth reset
    const duration = 500;
    const startCamPos = camera.position.clone();
    const endCamPos = new THREE.Vector3(0, 16, 20);
    const startTarget = controls.target.clone();
    const endTarget = new THREE.Vector3(0, 0.5, 0);
    const startTime = performance.now();

    function animateReset(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1.0);
        
        // Cubic easing
        const ease = 1 - Math.pow(1 - progress, 3);
        
        camera.position.lerpVectors(startCamPos, endCamPos, ease);
        controls.target.lerpVectors(startTarget, endTarget, ease);
        controls.update();
        
        if (progress < 1) {
            requestAnimationFrame(animateReset);
        }
    }
    requestAnimationFrame(animateReset);
}

// Mouse Drawing & Raycasting handlers
const raycaster = new THREE.Raycaster();
const mouseVec = new THREE.Vector2();

function getPaperIntersection(event) {
    // Calculate normalized device coordinates
    mouseVec.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouseVec.y = -(event.clientY / window.innerHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouseVec, camera);
    const intersects = raycaster.intersectObject(paperMesh);
    
    if (intersects.length > 0) {
        return intersects[0];
    }
    return null;
}

function onPointerDown(event) {
    if (!isDrawingMode) return;
    
    const hit = getPaperIntersection(event);
    if (hit) {
        isMouseDown = true;
        
        // Calculate canvas coordinates immediately
        const uv = hit.uv;
        const W = writingCanvas.width;
        const H = writingCanvas.height;
        lastDrawX = uv.x * W;
        lastDrawY = (1.0 - uv.y) * H;
        
        // Drop pen down to touch the sheet
        penGroup.position.copy(hit.point);
        penGroup.position.y = 0.07; // touch paper surface
        lastPenPos = penGroup.position.clone();
        
        controls.enabled = false; // Disable OrbitControls rotation while drawing
    }
}

function onPointerMove(event) {
    if (!isDrawingMode) return;
    
    const hit = getPaperIntersection(event);
    
    if (hit) {
        const uv = hit.uv;
        const W = writingCanvas.width;
        const H = writingCanvas.height;
        const px = uv.x * W;
        const py = (1.0 - uv.y) * H;
        
        if (isMouseDown) {
            // Draw line on paper texture
            if (lastDrawX !== null && lastDrawY !== null) {
                writingCtx.beginPath();
                writingCtx.moveTo(lastDrawX, lastDrawY);
                writingCtx.lineTo(px, py);
                writingCtx.strokeStyle = inkColor;
                writingCtx.lineWidth = strokeWidth;
                writingCtx.lineCap = 'round';
                writingCtx.lineJoin = 'round';
                writingCtx.stroke();
                writingTexture.needsUpdate = true;
            }
            
            lastDrawX = px;
            lastDrawY = py;
            
            // Move pen exactly to intersection point
            penGroup.position.copy(hit.point);
            penGroup.position.y = 0.07;
            
            // Dynamic angle tilt based on velocity drag
            if (lastPenPos) {
                const diff = penGroup.position.clone().sub(lastPenPos);
                const targetRotX = Math.PI / 6 + diff.z * 2.5;
                const targetRotZ = -Math.PI / 6 - diff.x * 2.5;
                penGroup.rotation.x = THREE.MathUtils.lerp(penGroup.rotation.x, targetRotX, 0.25);
                penGroup.rotation.z = THREE.MathUtils.lerp(penGroup.rotation.z, targetRotZ, 0.25);
            }
            lastPenPos = penGroup.position.clone();
            updateTipLight(penGroup.position, true);
            
        } else {
            // Float the pen above the paper sheet in follow mode
            const floatPos = hit.point.clone();
            floatPos.y = 0.07 + 0.4; // 0.4 units height offset
            penGroup.position.copy(floatPos);
            
            // Gentle tilt toward natural hand hold
            penGroup.rotation.x = THREE.MathUtils.lerp(penGroup.rotation.x, Math.PI / 7, 0.15);
            penGroup.rotation.z = THREE.MathUtils.lerp(penGroup.rotation.z, -Math.PI / 7, 0.15);
            
            updateTipLight(penGroup.position, false);
        }
    }
}

function onPointerUp() {
    isMouseDown = false;
    lastDrawX = null;
    lastDrawY = null;
    controls.enabled = true; // Re-enable camera rotation
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation Loop ---

function animate() {
    requestAnimationFrame(animate);
    
    const delta = clock.getDelta();
    time = clock.getElapsedTime();
    
    // 1. Update shader time uniforms
    marbleUniforms.uTime.value = time;
    holoUniforms.uTime.value = time;
    
    // 2. Perform camera orbiting via keyboard inputs
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    
    const rotSpeed = 1.2 * delta; // Frame-rate independent speed
    let camChanged = false;
    
    if (keys['w'] || keys['arrowup']) { spherical.phi -= rotSpeed; camChanged = true; }
    if (keys['s'] || keys['arrowdown']) { spherical.phi += rotSpeed; camChanged = true; }
    if (keys['a'] || keys['arrowleft']) { spherical.theta -= rotSpeed; camChanged = true; }
    if (keys['d'] || keys['arrowright']) { spherical.theta += rotSpeed; camChanged = true; }
    
    if (camChanged) {
        // Limit phi to keep view above table (0.1 to Math.PI/2 - 0.05)
        spherical.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, spherical.phi));
        spherical.makeSafe();
        camera.position.setFromSpherical(spherical).add(controls.target);
    }
    
    // 3. Auto-writer writing path step updates
    if (isWriting && WritingPath.length > 0) {
        // Update writing trajectory speed index
        pathIndex += writeSpeed * delta * 75.0; 
        const currIdx = Math.floor(pathIndex);
        const prevIdx = Math.floor(lastPathIndex);
        
        if (currIdx !== prevIdx) {
            // Draw missing points to secure smooth line rendering
            for (let i = prevIdx + 1; i <= currIdx; i++) {
                const pt = WritingPath[i % WritingPath.length];
                const prevPt = WritingPath[(i - 1 + WritingPath.length) % WritingPath.length];
                
                if (pt.isWriting && prevPt.isWriting) {
                    const W = writingCanvas.width;
                    const H = writingCanvas.height;
                    
                    // Map path coordinates (-9 to +9) to canvas layout width/height
                    const x1 = ((prevPt.x + 8.0) / 16.0) * W;
                    const y1 = ((10.65 - prevPt.y) / 21.3) * H;
                    
                    const x2 = ((pt.x + 8.0) / 16.0) * W;
                    const y2 = ((10.65 - pt.y) / 21.3) * H;
                    
                    writingCtx.beginPath();
                    writingCtx.moveTo(x1, y1);
                    writingCtx.lineTo(x2, y2);
                    writingCtx.strokeStyle = inkColor;
                    writingCtx.lineWidth = strokeWidth;
                    writingCtx.lineCap = 'round';
                    writingCtx.lineJoin = 'round';
                    writingCtx.stroke();
                    writingTexture.needsUpdate = true;
                }
            }
            
            // Loop path index and clear sheet at sequence boundary
            if (currIdx >= WritingPath.length) {
                pathIndex = 0;
                lastPathIndex = 0;
                resetPaperCanvas();
            } else {
                const currentPt = WritingPath[currIdx];
                
                // Map path coordinates back to 3D workspace coordinate bounds
                // 2D X -> 3D X
                // 2D Y -> 3D -Z
                // 2D Z -> 3D Y (Height elevation)
                const pt3D = new THREE.Vector3(currentPt.x, 0.07 + currentPt.z, -currentPt.y);
                penGroup.position.copy(pt3D);
                
                // Tilt rotation adjustments
                if (lastPenPos) {
                    const vel = pt3D.clone().sub(lastPenPos);
                    
                    let targetRotX = Math.PI / 6.0;
                    let targetRotZ = -Math.PI / 6.0;
                    
                    if (currentPt.isWriting) {
                        targetRotX += vel.z * 2.8;
                        targetRotZ -= vel.x * 2.8;
                    } else {
                        // Standing almost upright in air travel
                        targetRotX = Math.PI / 10;
                        targetRotZ = -Math.PI / 10;
                    }
                    
                    penGroup.rotation.x = THREE.MathUtils.lerp(penGroup.rotation.x, targetRotX, 0.16);
                    penGroup.rotation.z = THREE.MathUtils.lerp(penGroup.rotation.z, targetRotZ, 0.16);
                }
                
                lastPenPos = pt3D.clone();
                updateTipLight(pt3D, currentPt.isWriting);
                lastPathIndex = pathIndex;
            }
        }
    }
    
    controls.update();
    renderer.render(scene, camera);
}

// Start Application
init();
animate();
