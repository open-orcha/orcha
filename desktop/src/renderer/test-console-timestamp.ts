// Chromium's console has timeStamp; vitest's does not. React's dev build checks for it once,
// when react-dom loads, to decide whether to log its Performance-panel tracks. Stub it before
// anything imports react-dom so tests run the same React path as the app's renderer does
// (reactPerfTracks.test.tsx, GH #347). test-setup.ts imports this file first.
if (typeof console.timeStamp !== 'function') console.timeStamp = () => {}
