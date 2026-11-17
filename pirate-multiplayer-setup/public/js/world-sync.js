(() => {
  'use strict';

  const WEATHER = {
    clear: { sky: 0x8ec5e6, horizon: 0xcfe6f2, water: 0x1d7f9a, fog: 0xcfe6f2, light: 1.0 },
    sunny: { sky: 0x7bbbe6, horizon: 0xe6f4fb, water: 0x248da5, fog: 0xe6f4fb, light: 1.08 },
    dawn: { sky: 0xe89b71, horizon: 0xf3c5a5, water: 0x397d91, fog: 0xf3c5a5, light: 0.72 },
    dusk: { sky: 0x9b5b4d, horizon: 0xe4a27c, water: 0x286b7c, fog: 0xe4a27c, light: 0.58 },
    storm: { sky: 0x35485b, horizon: 0x7e8d99, water: 0x164b5b, fog: 0x7e8d99, light: 0.38 },
    night: { sky: 0x101c38, horizon: 0x283b5a, water: 0x082f45, fog: 0x283b5a, light: 0.22 },
  };

  let latestWorld = null;
  let originalRender = null;
  let threeHooked = false;

  const formatTime = (minutes) => {
    const value = ((Number(minutes) || 0) % 1440 + 1440) % 1440;
    const h = Math.floor(value / 60), m = Math.floor(value % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  function setColor(uniform, hex) {
    if (!uniform || !uniform.value) return;
    if (uniform.value.setHex) uniform.value.setHex(hex);
    else if (uniform.value.set) uniform.value.set(hex);
  }

  function updateMaterial(material, cfg, sunDir, moonDir, isNight, world) {
    if (!material || !material.uniforms) return;
    const u = material.uniforms;
    if (u.sunDir && u.sunDir.value && u.sunDir.value.set) u.sunDir.value.copy(sunDir);
    if (u.moonDir && u.moonDir.value && u.moonDir.value.set) u.moonDir.value.copy(moonDir);
    if (u.sunK) u.sunK.value = isNight ? 0.04 : cfg.light;
    if (u.nightK) u.nightK.value = isNight ? 1 : 0;
    setColor(u.top, cfg.sky);
    setColor(u.skyTop, cfg.sky);
    setColor(u.horizon, cfg.horizon);
    setColor(u.deep, cfg.water);
    setColor(u.shallow, cfg.water);
    if (u.krDark && world.kraken) {
      const k = world.kraken;
      const active = k.active !== false && k.phase !== 'inactive' && (k.hp == null || k.hp > 0);
      u.krDark.value.set(Number(k.x) || 0, Number(k.z) || 0, Number(k.radius) || 100, active ? 1 : 0);
    }
  }

  function applyScene(scene, world) {
    if (!window.THREE || !scene || !world) return;
    const THREE = window.THREE;
    const weather = WEATHER[String(world.weather || 'clear')] || WEATHER.clear;
    const minutes = ((Number(world.timeOfDay) || 0) % 1440 + 1440) % 1440;
    const phase = minutes / 1440 * Math.PI * 2;
    const elevation = Math.sin(phase - Math.PI / 2);
    const sunDir = new THREE.Vector3(Math.cos(phase), Math.max(-0.15, elevation), -0.45).normalize();
    const moonDir = sunDir.clone().negate();
    const isNight = minutes < 360 || minutes >= 1200 || weather === 'night';
    const cfg = { ...weather, light: weather.light * (isNight ? 0.5 : 1) };

    scene.traverse((object) => {
      if (object.isDirectionalLight) {
        object.position.copy(sunDir).multiplyScalar(500);
        object.intensity = cfg.light;
      } else if (object.isHemisphereLight) {
        object.intensity = isNight ? 0.22 : (weather === 'storm' ? 0.45 : 0.75);
      }
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => updateMaterial(material, cfg, sunDir, moonDir, isNight, world));
      }
    });

    if (scene.fog && scene.fog.color && scene.fog.color.setHex) {
      scene.fog.color.setHex(cfg.fog);
      if ('near' in scene.fog) {
        scene.fog.near = weather === 'storm' ? 300 : 600;
        scene.fog.far = weather === 'storm' ? 3000 : 5600;
      }
    }
    scene.background = new THREE.Color(cfg.sky);
  }

  function hookRenderer() {
    if (threeHooked || !window.THREE || !window.THREE.WebGLRenderer) return;
    const proto = window.THREE.WebGLRenderer.prototype;
    originalRender = proto.render;
    proto.render = function (scene, camera) {
      if (latestWorld) applyScene(scene, latestWorld);
      return originalRender.call(this, scene, camera);
    };
    threeHooked = true;
  }

  function applyWorld(world) {
    if (!world || typeof world !== 'object') return;
    latestWorld = world;
    window.__serverWorld = world;

    const clock = document.getElementById('clock');
    if (clock) clock.textContent = `${formatTime(world.timeOfDay)} • ${String(world.weather || 'clear')}`;
    document.documentElement.dataset.weather = String(world.weather || 'clear');

    if (typeof window.onGameWorldUpdate === 'function') window.onGameWorldUpdate(world);
    window.dispatchEvent(new CustomEvent('game:world-update', { detail: world }));
    hookRenderer();
  }

  // The multiplayer shim dispatches handlers registered under the topic name,
  // not under a literal "emit" event.
  async function connectToRoom() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    try {
      const room = await window.claude.use('room');
      if (!room || typeof room.on !== 'function') return;
      room.on('world', (event) => {
        const world = event && event.data && event.data.world;
        if (world) applyWorld(world);
      });
      if (typeof room.emit === 'function') room.emit('world:request', {});
    } catch (error) {
      console.warn('Could not subscribe to synchronized world state:', error);
    }
  }

  hookRenderer();
  connectToRoom();
  window.addEventListener('load', hookRenderer);
})();
