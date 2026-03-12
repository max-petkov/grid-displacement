window.addEventListener('load', () => {
    
    if (!window.displacementInstances || window.displacementInstances.length === 0) {
        console.warn('No displacement instances found to connect to dat.GUI');
        return;
    }

    const guiSettings = {
        gridSize: 2048,
        strength: 80,
        relaxation: 0.965,
        distance: 0.22,
        exportSettings: function() {
            const final = {
                gridSize: this.gridSize,
                strength: this.strength,
                relaxation: this.relaxation,
                distance: this.distance
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
    
    gui.add(guiSettings, 'gridSize', 1, 2048).step(1).name('Grid Size').onFinishChange(syncGridSizeToInstances);
    
    gui.add(guiSettings, 'relaxation', 0.8, 0.999).name('Relaxation').onChange(syncUniformsToInstances);
    gui.add(guiSettings, 'strength', 0, 500).name('Strength').onChange(syncUniformsToInstances);
    gui.add(guiSettings, 'distance', 0.01, 1.0).name('Distance').onChange(syncUniformsToInstances);
    
});