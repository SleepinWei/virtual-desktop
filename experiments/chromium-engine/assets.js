const asset = (path, file, type) => [path, { file: new URL(file, import.meta.url), type }];
export const nativeAssets = new Map([
  asset('/native', '../../public/native.html', 'text/html; charset=utf-8'),
  asset('/native-viewer.js', '../../public/native-viewer.js', 'text/javascript; charset=utf-8'),
  asset('/native-client.js', '../../public/native-client.js', 'text/javascript; charset=utf-8'),
  asset('/native-input.js', '../../public/native-input.js', 'text/javascript; charset=utf-8'),
  asset('/native.css', '../../public/native.css', 'text/css; charset=utf-8'),
  asset('/native/frame-protocol.js', '../chromium-paint/frame-protocol.js', 'text/javascript; charset=utf-8'),
  asset('/native/frame-renderer.js', '../chromium-paint/frame-renderer.js', 'text/javascript; charset=utf-8'),
  asset('/native/font-runtime.js', '../chromium-paint/font-runtime.js', 'text/javascript; charset=utf-8'),
]);
export const nativeFixtures = new Map([
  ...['frames', 'live-fixture'].flatMap(name => [
    asset(`/${name}.html`, `../chromium-paint/${name}.html`, 'text/html; charset=utf-8'),
    asset(`/${name}.css`, `../chromium-paint/${name}.css`, 'text/css; charset=utf-8'),
    asset(`/${name}.js`, `../chromium-paint/${name}.js`, 'text/javascript; charset=utf-8'),
  ]),
  asset('/fonts/fixture-sans.otf', '../chromium-paint/fonts/fixture-sans.otf', 'font/otf'),
]);
export const nativeAllowedPaths = [...nativeFixtures.keys()];
