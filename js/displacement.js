class ImageDisplacement {
    constructor(imgElement) {
        this.image = imgElement;
        this.settings = {
            gridSize: 256, 
            relaxation: 0.965,
            distance: 0.22,
            strength: 80,
            sleep: 3000,
            rgbMultiplier: 1.5,
            isSquareGrid: true // --- NEW: Toggle Setting ---
        };

        this.isAnimating = false;
        this.sleepTimer = null;
        this.isVisible = false; 

        if (this.image.complete && this.image.naturalHeight !== 0) {
            this.init();
        } else {
            this.image.addEventListener('load', () => this.init());
            this.image.addEventListener('error', () => console.error('Failed to load:', this.image.src));
        }
    }

    init() {
        this.parent = this.image.parentElement;
        this.image.style.opacity = '0'; 

        const rect = this.parent.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(w / -2, w / 2, h / 2, h / -2, 1, 100);
        this.camera.position.z = 10;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        const canvas = this.renderer.domElement;
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.zIndex = '1';
        this.parent.appendChild(canvas);

        this.initGPGPU();
        this.createMesh(w, h);
        this.addEventListeners();
        
        this.setupIntersectionObserver();
    }

    setupIntersectionObserver() {
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.isVisible = true;
                    this.wakeUp(); 
                } else {
                    this.isVisible = false;
                    this.sleep(); 
                }
            });
        }, {
            rootMargin: '50px 0px' 
        });

        this.observer.observe(this.parent);
    }

    sleep() {
        this.isAnimating = false;
        this.renderer.setAnimationLoop(null); 
        clearTimeout(this.sleepTimer);
    }

    wakeUp() {
        if (!this.isVisible) return; 

        if (!this.isAnimating) {
            this.isAnimating = true;
            this.renderer.setAnimationLoop(this.render.bind(this));
        }

        clearTimeout(this.sleepTimer);
        
        this.sleepTimer = setTimeout(() => {
            this.sleep(); 
        }, this.settings.sleep); 
    }

    initGPGPU() {
        this.gpgpuSize = Math.ceil(Math.sqrt(this.settings.gridSize));
        
        this.gpgpuRenderer = new THREE.GPUComputationRenderer(this.gpgpuSize, this.gpgpuSize, this.renderer);
        this.dataTexture = this.gpgpuRenderer.createTexture();
        
        const gpgpuShader = `
            uniform vec2 uMouse;
            uniform vec2 uDeltaMouse;
            uniform float uMouseMove;
            uniform float uDistance;
            uniform float uRelaxation;
            uniform float uAspect;
            uniform float uGridMode; // --- NEW: 0.0 = Col, 1.0 = Square ---

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec4 color = texture2D(uGrid, uv);
                
                vec2 aspectUv = vec2(uv.x * uAspect, uv.y);
                vec2 aspectMouse = vec2(uMouse.x * uAspect, uMouse.y);
                
                // Calculate both brush shapes
                float distSquare = distance(aspectUv, aspectMouse);
                float distColumn = abs(uv.x - uMouse.x); 
                
                // Mix between them based on the toggle
                float dist = mix(distColumn, distSquare, uGridMode);
                dist = 1.0 - smoothstep(0.0, uDistance, dist);
                
                color.rg += uDeltaMouse * dist;
                color.rg *= uRelaxation;
                
                gl_FragColor = color;
            }
        `;
        
        this.variable = this.gpgpuRenderer.addVariable('uGrid', gpgpuShader, this.dataTexture);
        
        this.variable.material.uniforms.uGridSize = new THREE.Uniform(this.gpgpuSize);
        this.variable.material.uniforms.uMouse = new THREE.Uniform(new THREE.Vector2(0, 0));
        this.variable.material.uniforms.uDeltaMouse = new THREE.Uniform(new THREE.Vector2(0, 0));
        this.variable.material.uniforms.uMouseMove = new THREE.Uniform(0);
        this.variable.material.uniforms.uDistance = new THREE.Uniform(this.settings.distance);
        this.variable.material.uniforms.uRelaxation = new THREE.Uniform(this.settings.relaxation);
        this.variable.material.uniforms.uGridMode = new THREE.Uniform(this.settings.isSquareGrid ? 1.0 : 0.0);
        
        const rect = this.parent.getBoundingClientRect();
        this.variable.material.uniforms.uAspect = new THREE.Uniform(rect.width / rect.height);

        this.gpgpuRenderer.setVariableDependencies(this.variable, [this.variable]);
        this.gpgpuRenderer.init();
    }

    createMesh(w, h) {
        const textureLoader = new THREE.TextureLoader();

        const vertexShader = `
            varying vec2 vUv;
            void main() {
                vec4 modelPosition = modelMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * viewMatrix * modelPosition;
                vUv = uv;
            }
        `;
        
        const fragmentShader = `
            uniform sampler2D uTexture;
            uniform sampler2D uGrid;
            varying vec2 vUv;
            uniform vec2 uMeshSize;
            uniform vec2 uImageResolution;
            uniform float uColumns;
            uniform float uRgbMultiplier;
            uniform float uGridMode; // --- NEW: 0.0 = Col, 1.0 = Square ---

            vec2 coverUvs(vec2 imageRes, vec2 containerRes) {
                float imageAspectX = imageRes.x / imageRes.y;
                float imageAspectY = imageRes.y / imageRes.x;
                float containerAspectX = containerRes.x / containerRes.y;
                float containerAspectY = containerRes.y / containerRes.x;
                
                vec2 ratio = vec2(
                    min(containerAspectX / imageAspectX, 1.0),
                    min(containerAspectY / imageAspectY, 1.0)
                );
                
                return vec2(
                    vUv.x * ratio.x + (1.0 - ratio.x) * 0.5,
                    vUv.y * ratio.y + (1.0 - ratio.y) * 0.5
                );
            }

            void main() {
                vec2 newUvs = coverUvs(uImageResolution, uMeshSize);

                float aspect = uMeshSize.x / uMeshSize.y;
                float columns = uColumns;
                float rows = columns / aspect; 
                
                // Always chunk the X axis
                float cellX = floor(vUv.x * columns) / columns + 0.5 / columns;
                
                // Calculate the chunky Y axis for squares
                float cellYSq = floor(vUv.y * rows) / rows + 0.5 / rows;
                
                // Mix the Y axis. If uGridMode is 0.0, it uses smooth vUv.y (columns). 
                // If 1.0, it uses chunky cellYSq (squares).
                float cellY = mix(vUv.y, cellYSq, uGridMode);
                
                vec2 gridUv = vec2(cellX, cellY);
                
                vec4 displacement = texture2D(uGrid, gridUv); 
                
                vec2 finalUvs = newUvs - displacement.rg * 0.01;
                
                vec2 shift = displacement.rg * 0.002 * uRgbMultiplier; 
                float displacementStrength = clamp(length(displacement.rg), 0.0, 2.0);
                
                vec2 redUvs = finalUvs + shift * (1.0 + displacementStrength * 0.5);
                vec2 greenUvs = finalUvs + shift * (0.5 + displacementStrength * 0.2);
                vec2 blueUvs = finalUvs - shift * (1.0 + displacementStrength * 1.5);
                
                float red = texture2D(uTexture, redUvs).r;
                float green = texture2D(uTexture, greenUvs).g;
                float blue = texture2D(uTexture, blueUvs).b;
                
                gl_FragColor = vec4(red, green, blue, 1.0);
            }
        `;

        const geometry = new THREE.PlaneGeometry(1, 1); 
        this.material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                uTexture: new THREE.Uniform(null),
                uMeshSize: new THREE.Uniform(new THREE.Vector2(w, h)),
                uImageResolution: new THREE.Uniform(new THREE.Vector2(1, 1)),
                uGrid: new THREE.Uniform(null), 
                uColumns: new THREE.Uniform(Math.ceil(Math.sqrt(this.settings.gridSize))),
                uRgbMultiplier: new THREE.Uniform(this.settings.rgbMultiplier),
                uGridMode: new THREE.Uniform(this.settings.isSquareGrid ? 1.0 : 0.0)
            }
        });
        
        textureLoader.load(this.image.src, (texture) => {
            this.material.uniforms.uTexture.value = texture;
            this.material.uniforms.uImageResolution.value.set(texture.image.naturalWidth, texture.image.naturalHeight);
            this.wakeUp(); 
        });

        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.scale.set(w, h, 1);
        this.scene.add(this.mesh);
    }

    onMouseMove(event) {
        if (!this.isVisible) return; 
        const rect = this.renderer.domElement.getBoundingClientRect();
        
        const x = (event.clientX - rect.left) / rect.width;
        const y = 1.0 - ((event.clientY - rect.top) / rect.height); 
        
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            this.wakeUp();
            
            const uv = new THREE.Vector2(x, y);
            this.variable.material.uniforms.uMouseMove.value = 1;
            const currentMouse = this.variable.material.uniforms.uMouse.value.clone();
            const delta = new THREE.Vector2().subVectors(uv, currentMouse);
            
            const aspect = rect.width / rect.height;
            delta.x *= aspect; 
            
            delta.multiplyScalar(this.settings.strength); 
            
            this.variable.material.uniforms.uDeltaMouse.value = delta;
            this.variable.material.uniforms.uMouse.value = uv;
        }
    }

    onResize() {
        if (!this.parent || !this.renderer) return;

        const rect = this.parent.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        this.renderer.setSize(w, h);
        
        this.camera.left = w / -2;
        this.camera.right = w / 2;
        this.camera.top = h / 2;
        this.camera.bottom = h / -2;
        this.camera.updateProjectionMatrix();

        this.mesh.scale.set(w, h, 1);
        this.material.uniforms.uMeshSize.value.set(w, h);
        
        if (this.variable) this.variable.material.uniforms.uAspect.value = w / h;
        
        this.wakeUp();
    }

    addEventListeners() {
        window.addEventListener('mousemove', this.onMouseMove.bind(this));
        
        if (window.ResizeObserver) {
            this.resizeObserver = new ResizeObserver(() => this.onResize());
            this.resizeObserver.observe(this.parent);
        } else {
            window.addEventListener('resize', this.onResize.bind(this));
        }
    }

    render() {
        this.variable.material.uniforms.uMouseMove.value *= 0.95;
        this.variable.material.uniforms.uDeltaMouse.value.multiplyScalar(this.settings.relaxation);
        
        this.variable.material.uniforms.uDistance.value = this.settings.distance;
        this.variable.material.uniforms.uRelaxation.value = this.settings.relaxation;

        // Sync visual settings every frame
        if (this.material) {
            this.material.uniforms.uRgbMultiplier.value = this.settings.rgbMultiplier;
            this.material.uniforms.uColumns.value = Math.ceil(Math.sqrt(this.settings.gridSize));
            
            // --- NEW: Sync grid mode ---
            const modeValue = this.settings.isSquareGrid ? 1.0 : 0.0;
            this.material.uniforms.uGridMode.value = modeValue;
            this.variable.material.uniforms.uGridMode.value = modeValue;
        }

        this.gpgpuRenderer.compute();
        
        const renderTarget = this.gpgpuRenderer.getCurrentRenderTarget(this.variable);
        this.material.uniforms.uGrid.value = renderTarget.texture || renderTarget.textures[0];
        
        this.renderer.render(this.scene, this.camera);
    }
}

window.displacementInstances = []; 

const images = document.querySelectorAll('[data-effect="grid-displacement"]');
images.forEach(img => {
    window.displacementInstances.push(new ImageDisplacement(img)); 
});



// V1
// class ImageDisplacement {
//     constructor(imgElement) {
//         this.image = imgElement;
//         this.settings = {
//             gridSize: 4096, 
//             relaxation: 0.965,
//             distance: 0.22,
//             strength: 80,
//             sleep: 3000,
//             rgbMultiplier: 1.5, // NEW: Controls the intensity of the RGB split
//         };

//         this.isAnimating = false;
//         this.sleepTimer = null;
//         this.isVisible = false; 

//         if (this.image.complete && this.image.naturalHeight !== 0) {
//             this.init();
//         } else {
//             this.image.addEventListener('load', () => this.init());
//             this.image.addEventListener('error', () => console.error('Failed to load:', this.image.src));
//         }
//     }

//     init() {
//         this.parent = this.image.parentElement;
//         this.image.style.opacity = '0'; 

//         const rect = this.parent.getBoundingClientRect();
//         const w = rect.width;
//         const h = rect.height;

//         this.scene = new THREE.Scene();
//         this.camera = new THREE.OrthographicCamera(w / -2, w / 2, h / 2, h / -2, 1, 100);
//         this.camera.position.z = 10;

//         this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
//         this.renderer.setSize(w, h);
//         this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

//         const canvas = this.renderer.domElement;
//         canvas.style.position = 'absolute';
//         canvas.style.top = '0';
//         canvas.style.left = '0';
//         canvas.style.width = '100%';
//         canvas.style.height = '100%';
//         canvas.style.zIndex = '1';
//         this.parent.appendChild(canvas);

//         this.initGPGPU();
//         this.createMesh(w, h);
//         this.addEventListeners();
        
//         this.setupIntersectionObserver();
//     }

//     setupIntersectionObserver() {
//         this.observer = new IntersectionObserver((entries) => {
//             entries.forEach(entry => {
//                 if (entry.isIntersecting) {
//                     this.isVisible = true;
//                     this.wakeUp(); 
//                 } else {
//                     this.isVisible = false;
//                     this.sleep(); 
//                 }
//             });
//         }, {
//             rootMargin: '50px 0px' 
//         });

//         this.observer.observe(this.parent);
//     }

//     sleep() {
//         this.isAnimating = false;
//         this.renderer.setAnimationLoop(null); 
//         clearTimeout(this.sleepTimer);
//     }

//     wakeUp() {
//         if (!this.isVisible) return; 

//         if (!this.isAnimating) {
//             this.isAnimating = true;
//             this.renderer.setAnimationLoop(this.render.bind(this));
//         }

//         clearTimeout(this.sleepTimer);
        
//         this.sleepTimer = setTimeout(() => {
//             this.sleep(); 
//         }, this.settings.sleep); 
//     }

//     initGPGPU() {
//         this.gpgpuSize = Math.ceil(Math.sqrt(this.settings.gridSize));
        
//         this.gpgpuRenderer = new THREE.GPUComputationRenderer(this.gpgpuSize, this.gpgpuSize, this.renderer);
//         this.dataTexture = this.gpgpuRenderer.createTexture();
        
//         const gpgpuShader = `
//             uniform vec2 uMouse;
//             uniform vec2 uDeltaMouse;
//             uniform float uMouseMove;
//             uniform float uDistance;
//             uniform float uRelaxation;
//             uniform float uAspect;

//             void main() {
//                 vec2 uv = gl_FragCoord.xy / resolution.xy;
//                 vec4 color = texture2D(uGrid, uv);
                
//                 vec2 aspectUv = vec2(uv.x * uAspect, uv.y);
//                 vec2 aspectMouse = vec2(uMouse.x * uAspect, uMouse.y);
                
//                 float dist = distance(aspectUv, aspectMouse);
//                 dist = 1.0 - smoothstep(0.0, uDistance, dist);
                
//                 color.rg += uDeltaMouse * dist;
//                 color.rg *= uRelaxation;
                
//                 gl_FragColor = color;
//             }
//         `;
        
//         this.variable = this.gpgpuRenderer.addVariable('uGrid', gpgpuShader, this.dataTexture);
        
//         this.variable.material.uniforms.uGridSize = new THREE.Uniform(this.gpgpuSize);
//         this.variable.material.uniforms.uMouse = new THREE.Uniform(new THREE.Vector2(0, 0));
//         this.variable.material.uniforms.uDeltaMouse = new THREE.Uniform(new THREE.Vector2(0, 0));
//         this.variable.material.uniforms.uMouseMove = new THREE.Uniform(0);
//         this.variable.material.uniforms.uDistance = new THREE.Uniform(this.settings.distance);
//         this.variable.material.uniforms.uRelaxation = new THREE.Uniform(this.settings.relaxation);
        
//         const rect = this.parent.getBoundingClientRect();
//         this.variable.material.uniforms.uAspect = new THREE.Uniform(rect.width / rect.height);

//         this.gpgpuRenderer.setVariableDependencies(this.variable, [this.variable]);
//         this.gpgpuRenderer.init();
//     }

//     createMesh(w, h) {
//         const textureLoader = new THREE.TextureLoader();

//         const vertexShader = `
//             varying vec2 vUv;
//             void main() {
//                 vec4 modelPosition = modelMatrix * vec4(position, 1.0);
//                 gl_Position = projectionMatrix * viewMatrix * modelPosition;
//                 vUv = uv;
//             }
//         `;
        
//         const fragmentShader = `
//             uniform sampler2D uTexture;
//             uniform sampler2D uGrid;
//             varying vec2 vUv;
//             uniform vec2 uMeshSize;
//             uniform vec2 uImageResolution;
//             uniform float uColumns;
//             uniform float uRgbMultiplier; // NEW: Hooked to settings

//             vec2 coverUvs(vec2 imageRes, vec2 containerRes) {
//                 float imageAspectX = imageRes.x / imageRes.y;
//                 float imageAspectY = imageRes.y / imageRes.x;
//                 float containerAspectX = containerRes.x / containerRes.y;
//                 float containerAspectY = containerRes.y / containerRes.x;
                
//                 vec2 ratio = vec2(
//                     min(containerAspectX / imageAspectX, 1.0),
//                     min(containerAspectY / imageAspectY, 1.0)
//                 );
                
//                 return vec2(
//                     vUv.x * ratio.x + (1.0 - ratio.x) * 0.5,
//                     vUv.y * ratio.y + (1.0 - ratio.y) * 0.5
//                 );
//             }

//             void main() {
//                 vec2 newUvs = coverUvs(uImageResolution, uMeshSize);

//                 float aspect = uMeshSize.x / uMeshSize.y;
//                 float columns = uColumns;
//                 float rows = columns / aspect; 
                
//                 vec2 gridUv = vec2(
//                     floor(vUv.x * columns) / columns,
//                     floor(vUv.y * rows) / rows
//                 );
                
//                 gridUv += vec2(0.5 / columns, 0.5 / rows);
                
//                 vec4 displacement = texture2D(uGrid, gridUv); 
                
//                 vec2 finalUvs = newUvs - displacement.rg * 0.01;
                
//                 // --- SHARPER RGB SPLIT LOGIC ---
//                 // Base shift amplified by the new GUI setting
//                 vec2 shift = displacement.rg * 0.002 * uRgbMultiplier; 
//                 float displacementStrength = clamp(length(displacement.rg), 0.0, 2.0);
                
//                 // Push red slightly forward
//                 vec2 redUvs = finalUvs + shift * (1.0 + displacementStrength * 0.5);
//                 // Keep green relatively central
//                 vec2 greenUvs = finalUvs + shift * (0.5 + displacementStrength * 0.2);
//                 // Push blue in the OPPOSITE direction for a high-contrast chromatic aberration
//                 vec2 blueUvs = finalUvs - shift * (1.0 + displacementStrength * 1.5);
                
//                 float red = texture2D(uTexture, redUvs).r;
//                 float green = texture2D(uTexture, greenUvs).g;
//                 float blue = texture2D(uTexture, blueUvs).b;
                
//                 gl_FragColor = vec4(red, green, blue, 1.0);
//             }
//         `;

//         const geometry = new THREE.PlaneGeometry(1, 1); 
//         this.material = new THREE.ShaderMaterial({
//             vertexShader,
//             fragmentShader,
//             uniforms: {
//                 uTexture: new THREE.Uniform(null),
//                 uMeshSize: new THREE.Uniform(new THREE.Vector2(w, h)),
//                 uImageResolution: new THREE.Uniform(new THREE.Vector2(1, 1)),
//                 uGrid: new THREE.Uniform(null), 
//                 uColumns: new THREE.Uniform(Math.ceil(Math.sqrt(this.settings.gridSize))),
//                 uRgbMultiplier: new THREE.Uniform(this.settings.rgbMultiplier) // NEW: Pass uniform
//             }
//         });
        
//         textureLoader.load(this.image.src, (texture) => {
//             this.material.uniforms.uTexture.value = texture;
//             this.material.uniforms.uImageResolution.value.set(texture.image.naturalWidth, texture.image.naturalHeight);
//             this.wakeUp(); 
//         });

//         this.mesh = new THREE.Mesh(geometry, this.material);
//         this.mesh.scale.set(w, h, 1);
//         this.scene.add(this.mesh);
//     }

//     onMouseMove(event) {
//         if (!this.isVisible) return; 
//         const rect = this.renderer.domElement.getBoundingClientRect();
        
//         const x = (event.clientX - rect.left) / rect.width;
//         const y = 1.0 - ((event.clientY - rect.top) / rect.height); 
        
//         if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
//             this.wakeUp();
            
//             const uv = new THREE.Vector2(x, y);
//             this.variable.material.uniforms.uMouseMove.value = 1;
//             const currentMouse = this.variable.material.uniforms.uMouse.value.clone();
//             const delta = new THREE.Vector2().subVectors(uv, currentMouse);
            
//             const aspect = rect.width / rect.height;
//             delta.x *= aspect; 
            
//             delta.multiplyScalar(this.settings.strength); 
            
//             this.variable.material.uniforms.uDeltaMouse.value = delta;
//             this.variable.material.uniforms.uMouse.value = uv;
//         }
//     }

//     onResize() {
//         if (!this.parent || !this.renderer) return;

//         const rect = this.parent.getBoundingClientRect();
//         const w = rect.width;
//         const h = rect.height;

//         this.renderer.setSize(w, h);
        
//         this.camera.left = w / -2;
//         this.camera.right = w / 2;
//         this.camera.top = h / 2;
//         this.camera.bottom = h / -2;
//         this.camera.updateProjectionMatrix();

//         this.mesh.scale.set(w, h, 1);
//         this.material.uniforms.uMeshSize.value.set(w, h);
        
//         if (this.variable) this.variable.material.uniforms.uAspect.value = w / h;
        
//         this.wakeUp();
//     }

//     addEventListeners() {
//         window.addEventListener('mousemove', this.onMouseMove.bind(this));
        
//         if (window.ResizeObserver) {
//             this.resizeObserver = new ResizeObserver(() => this.onResize());
//             this.resizeObserver.observe(this.parent);
//         } else {
//             window.addEventListener('resize', this.onResize.bind(this));
//         }
//     }

//    render() {
//         this.variable.material.uniforms.uMouseMove.value *= 0.95;
//         this.variable.material.uniforms.uDeltaMouse.value.multiplyScalar(this.settings.relaxation);
        
//         this.variable.material.uniforms.uDistance.value = this.settings.distance;
//         this.variable.material.uniforms.uRelaxation.value = this.settings.relaxation;

//         if (this.material) {
//             this.material.uniforms.uRgbMultiplier.value = this.settings.rgbMultiplier;
            
//             // --- ADD THIS LINE ---
//             // Force the visual grid to match the exact dimensions of the physics grid
//             this.material.uniforms.uColumns.value = Math.ceil(Math.sqrt(this.settings.gridSize));
//         }

//         this.gpgpuRenderer.compute();
        
//         const renderTarget = this.gpgpuRenderer.getCurrentRenderTarget(this.variable);
//         this.material.uniforms.uGrid.value = renderTarget.texture || renderTarget.textures[0];
        
//         this.renderer.render(this.scene, this.camera);
//     }
// }

// window.displacementInstances = []; 

// const images = document.querySelectorAll('[data-effect="grid-displacement"]');
// images.forEach(img => {
//     window.displacementInstances.push(new ImageDisplacement(img)); 
// });
