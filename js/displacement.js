class ImageDisplacement {
    constructor(imgElement) {
        this.image = imgElement;
        this.settings = {
            gridSize: 2048, 
            relaxation: 0.965,
            distance: 0.22,
            strength: 80,
            sleep: 3000,
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
        
        // Start watching the element's scroll position
        this.setupIntersectionObserver();
    }

    // --- OPTIMIZATION LOGIC ---

    setupIntersectionObserver() {
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.isVisible = true;
                    this.wakeUp(); // Wake up when scrolled into view
                } else {
                    this.isVisible = false;
                    this.sleep();  // Immediately kill the GPU loop when hidden
                }
            });
        }, {
            // Fires slightly before the image actually enters the screen so it's ready
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
        // Block the wake-up command if the element is not currently visible!
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

    // --- WEBGL LOGIC ---

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

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec4 color = texture2D(uGrid, uv);
                
                float dist = distance(uv, uMouse);
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
                vec4 displacement = texture2D(uGrid, vUv); 
                
                vec2 finalUvs = newUvs - displacement.rg * 0.01;
                vec4 finalImage = texture2D(uTexture, finalUvs);
                
                vec2 shift = displacement.rg * 0.001;
                float displacementStrength = clamp(length(displacement.rg), 0.0, 2.0);
                
                vec2 redUvs = finalUvs + shift * (1.0 + displacementStrength * 0.25);
                vec2 blueUvs = finalUvs + shift * (1.0 + displacementStrength * 1.5);
                vec2 greenUvs = finalUvs + shift * (1.0 + displacementStrength * 2.0);
                
                finalImage.r = texture2D(uTexture, redUvs).r;
                finalImage.g = texture2D(uTexture, greenUvs).g;
                finalImage.b = texture2D(uTexture, blueUvs).b;
                
                gl_FragColor = finalImage;
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
        if (!this.isVisible) return; // Ignore tracking if off-screen

        const rect = this.renderer.domElement.getBoundingClientRect();
        
        const x = (event.clientX - rect.left) / rect.width;
        const y = 1.0 - ((event.clientY - rect.top) / rect.height); 
        
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            this.wakeUp();
            
            const uv = new THREE.Vector2(x, y);
            this.variable.material.uniforms.uMouseMove.value = 1;
            const currentMouse = this.variable.material.uniforms.uMouse.value.clone();
            const delta = new THREE.Vector2().subVectors(uv, currentMouse);
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

        this.gpgpuRenderer.compute();
        
        const renderTarget = this.gpgpuRenderer.getCurrentRenderTarget(this.variable);
        this.material.uniforms.uGrid.value = renderTarget.texture || renderTarget.textures[0];
        
        this.renderer.render(this.scene, this.camera);
    }
}

// Global array to hold the instances for the GUI script
window.displacementInstances = [];

const images = document.querySelectorAll('[data-effect="grid-displacement"]');
images.forEach(img => {
    window.displacementInstances.push(new ImageDisplacement(img));
});