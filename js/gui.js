window.addEventListener('load', () => {
    
    if (!window.displacementInstances || window.displacementInstances.length === 0) {
        console.warn('No displacement instances found to connect to dat.GUI');
        return;
    }

    const guiSettings = {
        gridSize: 256, 
        relaxation: 0.965,
        distance: 0.22,
        strength: 80,
        rgbMultiplier: 1.5,
        isSquareGrid: true, // --- NEW: Add to GUI settings ---
        exportSettings: function() {
            const final = {
                gridSize: this.gridSize,
                strength: this.strength,
                relaxation: this.relaxation,
                distance: this.distance,
                rgbMultiplier: this.rgbMultiplier,
                isSquareGrid: this.isSquareGrid
            };
            console.log("🔥 Final Settings:");
            console.log(JSON.stringify(final, null, 4));
            alert("Settings printed to console! (Press F12 to view)");
        }
    };

    const syncUniformsToInstances = () => {
        window.displacementInstances.forEach(instance => {
            instance.settings.strength = guiSettings.strength;
            instance.settings.relaxation = guiSettings.relaxation;
            instance.settings.distance = guiSettings.distance;
            instance.settings.rgbMultiplier = guiSettings.rgbMultiplier;
            instance.settings.isSquareGrid = guiSettings.isSquareGrid; // --- NEW: Sync boolean ---
            instance.wakeUp();
        });
    };

    const syncGridSizeToInstances = () => {
        window.displacementInstances.forEach(instance => {
            instance.settings.gridSize = guiSettings.gridSize;
            instance.initGPGPU();
            instance.wakeUp();   
        });
    };

    const gui = new dat.GUI();
    
    gui.add(guiSettings, 'isSquareGrid').name('Square Grid Mode').onChange(syncUniformsToInstances);
    gui.add(guiSettings, 'gridSize', 1, 10000).step(1).name('Grid Size').onFinishChange(syncGridSizeToInstances);
    gui.add(guiSettings, 'relaxation', 0.8, 0.999).name('Relaxation').onChange(syncUniformsToInstances);
    gui.add(guiSettings, 'strength', 0, 500).name('Strength').onChange(syncUniformsToInstances);
    gui.add(guiSettings, 'distance', 0.01, 1.0).name('Distance').onChange(syncUniformsToInstances);
    gui.add(guiSettings, 'rgbMultiplier', 0.0, 5.0).step(0.1).name('RGB Intensity').onChange(syncUniformsToInstances);
    
    gui.add(guiSettings, 'exportSettings').name('Export to Console');
});
