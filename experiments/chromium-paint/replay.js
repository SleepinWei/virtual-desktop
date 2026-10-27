const $ = selector => document.querySelector(selector);
let kit, manifest, surface, sequence = 0;
const maxPictureBytes = 32 * 1024 * 1024;

function report(status, details) {
  document.documentElement.dataset.status = status;
  $('#state').textContent = status === 'ready' ? 'Client replay ready' : status;
  $('#result').textContent = JSON.stringify(details, null, 2);
}

async function render() {
  const selected = ++sequence;
  report('loading', { message: 'Decoding the original Chromium picture…' });
  let picture;
  try {
    const stage = manifest.stages[Number($('#stage').value)];
    const record = stage.pictures[Number($('#picture').value)];
    if (!record || !/^pictures\/[a-zA-Z0-9._-]+\.skp$/.test(record.path)) throw new Error('No valid recorded picture is available');
    if (record.bytes > maxPictureBytes) throw new Error('Recorded picture exceeds the lab limit');
    const response = await fetch('/' + record.path);
    if (!response.ok) throw new Error(`Picture request failed: ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== record.bytes || data.length > maxPictureBytes) throw new Error('Picture size does not match the manifest');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== record.sha256) throw new Error('Picture SHA-256 does not match the manifest');
    picture = kit.MakePicture(data);
    if (!picture) throw new Error('CanvasKit rejected this Chromium SKP; the serialization versions or resources are incompatible');
    if (selected !== sequence) return;
    const bounds = Array.from(picture.cullRect());
    if (!bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Error('Invalid picture bounds');
    const canvas = $('#skp');
    surface?.delete();
    canvas.width = manifest.viewport.width; canvas.height = manifest.viewport.height;
    surface = kit.MakeSWCanvasSurface(canvas);
    if (!surface) throw new Error('Could not create a local CanvasKit surface');
    const output = surface.getCanvas();
    output.clear(kit.WHITE);
    output.drawPicture(picture);
    surface.flush();
    canvas.dataset.stage = stage.name;
    canvas.dataset.sha256 = digest;
    report('ready', {
      stage: stage.name, picture: record.path, bytes: data.length, sha256: digest,
      bounds, browser: { product: manifest.browser.product, version: manifest.browser.version, revision: manifest.browser.revision },
      client: 'canvaskit-wasm@0.42.0 / full / local software surface',
      scope: 'One recorded picture; no DOM reconstruction or automatic multi-layer compositing',
      serverRasterBypassed: false,
    });
  } catch (error) {
    if (selected === sequence) report('unsupported', { error: error.message, serverRasterBypassed: false, fallback: 'none' });
  } finally { picture?.delete(); }
}

function stageSelected() {
  const pictures = manifest.stages[Number($('#stage').value)].pictures;
  $('#picture').replaceChildren(...pictures.map((record, index) => {
    const option = document.createElement('option');
    option.value = index; option.textContent = `${index + 1}: ${record.bytes.toLocaleString()} B · ${record.sha256.slice(0, 10)}`;
    return option;
  }));
  // The first fixture has a single content layer. The selector exposes all others.
  $('#picture').value = String(pictures.reduce((largest, item, index) => item.bytes > pictures[largest].bytes ? index : largest, 0));
  render();
}

try {
  const response = await fetch('/capture.json');
  if (!response.ok) throw new Error('Run the Chromium capture experiment before opening the lab');
  manifest = await response.json();
  if (manifest.version !== 1 || !Array.isArray(manifest.stages) || !manifest.stages.length) throw new Error('Unsupported capture manifest');
  if (!Number.isInteger(manifest.viewport?.width) || !Number.isInteger(manifest.viewport?.height) || manifest.viewport.width < 1 || manifest.viewport.height < 1 || manifest.viewport.width > 4096 || manifest.viewport.height > 4096) throw new Error('Unsupported viewport');
  kit = await window.CanvasKitInit({ locateFile: file => '/' + file });
  if (typeof kit.MakePicture !== 'function') throw new Error('This CanvasKit build does not include SKP decoding');
  $('#stage').replaceChildren(...manifest.stages.map((stage, index) => {
    const option = document.createElement('option'); option.value = index; option.textContent = stage.name; return option;
  }));
  $('#stage').addEventListener('change', stageSelected);
  $('#picture').addEventListener('change', render);
  stageSelected();
} catch (error) { report('unsupported', { error: error.message, serverRasterBypassed: false, fallback: 'none' }); }
