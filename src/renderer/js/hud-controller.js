/**
 * XYRON CENTER - HUD Controller & View Orchestrator
 * File: src/renderer/js/hud-controller.js
 * 
 * Exposes the main HUD controller and orchestrator interface.
 */

const XyronCenterApp = require('./app.js');

class HudController extends XyronCenterApp {
  constructor() {
    super();
  }
}

// Export for CommonJS and browser environments
if (typeof window !== 'undefined') {
  window.HudController = HudController;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HudController;
}
