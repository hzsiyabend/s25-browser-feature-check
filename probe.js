'use strict';

const logNode = document.getElementById('probe-log');
const records = [];
let devicePromise;
let stopped = false;

function record(caseId, outcome, detail = {}) {
  records.push({
    time: new Date().toISOString(),
    caseId,
    outcome,
    detail,
    page: location.href
  });
  logNode.textContent = JSON.stringify(records, null, 2);
  try { localStorage.setItem('s25-boundary-probe', JSON.stringify(records)); } catch (_) {}
}

function stop(reason) {
  stopped = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  record('session', 'STOP', {reason});
}

async function getDevice() {
  if (!devicePromise) {
    devicePromise = (async () => {
      if (!navigator.gpu) throw new Error('WebGPU unavailable');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('WebGPU adapter unavailable');
      const device = await adapter.requestDevice();
      device.lost.then(info => stop(`GPU device lost: ${info.reason}: ${info.message}`));
      return device;
    })();
  }
  return devicePromise;
}

function bounded(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: 10s timeout`)), 10000))
  ]);
}

async function validation(device, operation) {
  device.pushErrorScope('validation');
  let thrown = null;
  try { operation(); } catch (error) { thrown = `${error.name}: ${error.message}`; }
  const gpuError = await bounded(device.popErrorScope(), 'error scope');
  return {thrown, gpuError: gpuError ? `${gpuError.name}: ${gpuError.message}` : null};
}

async function runCase(id, expected, action) {
  const button = document.getElementById(id);
  if (stopped || button.disabled) return;
  button.disabled = true;
  const start = performance.now();
  record(id, 'START', {expected});
  try {
    const detail = await bounded(action(await getDevice()), id);
    const observed = detail.thrown ? 'JS_REJECT' : detail.gpuError ? 'GPU_REJECT' : 'PASS';
    record(id, observed, {...detail, elapsedMs: Math.round(performance.now() - start)});
    if ((expected === 'pass' && observed !== 'PASS') ||
        (expected === 'reject' && observed === 'PASS')) {
      stop('Unexpected result; no further cases in this session');
    }
  } catch (error) {
    record(id, 'ERROR', {error: `${error.name}: ${error.message}`});
    stop('Case error or timeout');
  }
}

async function rgbaCase(device, short) {
  const texture = device.createTexture({
    size: [2, 2], format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
  });
  const pixels = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255
  ]);
  const input = short ? pixels.subarray(0, 15) : pixels;
  try {
    const result = await validation(device, () => device.queue.writeTexture(
      {texture}, input, {bytesPerRow: 8, rowsPerImage: 2},
      {width: 2, height: 2, depthOrArrayLayers: 1}
    ));
    if (result.thrown || result.gpuError || short) return {...result, inputBytes: input.length};

    const buffer = device.createBuffer({
      size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        {texture}, {buffer, bytesPerRow: 256, rowsPerImage: 2},
        {width: 2, height: 2, depthOrArrayLayers: 1}
      );
      device.queue.submit([encoder.finish()]);
      await bounded(device.queue.onSubmittedWorkDone(), 'GPU submit');
      await bounded(buffer.mapAsync(GPUMapMode.READ), 'GPU map');
      const bytes = new Uint8Array(buffer.getMappedRange());
      const observed = [...bytes.slice(0, 8), ...bytes.slice(256, 264)];
      const pixelMatch = observed.every((value, i) => value === pixels[i]);
      buffer.unmap();
      if (!pixelMatch) throw new Error(`RGBA readback mismatch: ${observed.join(',')}`);
      return {...result, inputBytes: input.length, pixelMatch};
    } finally { buffer.destroy(); }
  } finally { texture.destroy(); }
}

async function frameCase(device, mode) {
  if (typeof VideoFrame === 'undefined') throw new Error('VideoFrame unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 4, 4);
  const frame = new VideoFrame(canvas, {timestamp: 0});
  const texture = device.createTexture({
    size: [4, 4], format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
  });
  try {
    if (mode === 'closed') frame.close();
    const source = {source: frame};
    const size = {width: 4, height: 4};
    if (mode === 'crop') {
      source.origin = {x: 3, y: 0};
      size.width = 2;
    }
    const result = await validation(device, () => device.queue.copyExternalImageToTexture(
      source, {texture}, size
    ));
    if (!result.thrown && !result.gpuError) {
      await bounded(device.queue.onSubmittedWorkDone(), 'external image copy');
    }
    return {...result, mode, sourceSize: [4, 4], copySize: [size.width, size.height]};
  } finally {
    frame.close();
    texture.destroy();
  }
}

async function idbRoundTrip() {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
  const dbName = 's25-idb-backend-check-20261104';
  const db = await bounded(new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('probe')) {
        request.result.createObjectStore('probe');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  }), 'IndexedDB open');
  try {
    const value = 'diagnostic-ok';
    const write = db.transaction('probe', 'readwrite');
    const committed = new Promise((resolve, reject) => {
      write.oncomplete = resolve;
      write.onerror = () => reject(write.error || new Error('IndexedDB write failed'));
      write.onabort = () => reject(write.error || new Error('IndexedDB write aborted'));
    });
    write.objectStore('probe').put(value, 'sentinel');
    await bounded(committed, 'IndexedDB write');
    const read = db.transaction('probe', 'readonly').objectStore('probe').get('sentinel');
    const observed = await bounded(new Promise((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error || new Error('IndexedDB read failed'));
    }), 'IndexedDB read');
    if (observed !== value) throw new Error(`IndexedDB readback mismatch: ${observed}`);
    return {dbName, roundTrip: true};
  } finally { db.close(); }
}

async function runStorageCase() {
  const id = 'idb-roundtrip';
  const button = document.getElementById(id);
  if (stopped || button.disabled) return;
  button.disabled = true;
  const start = performance.now();
  record(id, 'START', {expected: 'pass'});
  try {
    const detail = await bounded(idbRoundTrip(), id);
    record(id, 'PASS', {...detail, elapsedMs: Math.round(performance.now() - start)});
  } catch (error) {
    record(id, 'ERROR', {error: `${error.name}: ${error.message}`});
    stop('IndexedDB error or timeout');
  }
}

document.getElementById('rgba-valid').onclick = () => runCase('rgba-valid', 'pass',
  device => rgbaCase(device, false));
document.getElementById('rgba-short').onclick = () => runCase('rgba-short', 'reject',
  device => rgbaCase(device, true));
document.getElementById('frame-valid').onclick = () => runCase('frame-valid', 'pass',
  device => frameCase(device, 'valid'));
document.getElementById('frame-closed').onclick = () => runCase('frame-closed', 'reject',
  device => frameCase(device, 'closed'));
document.getElementById('frame-crop').onclick = () => runCase('frame-crop', 'reject',
  device => frameCase(device, 'crop'));
document.getElementById('idb-roundtrip').onclick = runStorageCase;
