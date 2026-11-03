(() => {
  let specPromise;

  function getSpec() {
    specPromise ||= fetch('/api/image-analysis-spec')
      .then(async (response) => {
        if (!response.ok) throw new Error('Image preparation policy is unavailable.');
        return response.json();
      });
    return specPromise;
  }

  function jpegOrientation(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (marker === 0xe1 && bytes[offset + 4] === 0x45 && bytes[offset + 5] === 0x78
        && bytes[offset + 6] === 0x69 && bytes[offset + 7] === 0x66) {
        const tiff = offset + 10;
        const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
        const read16 = (index) => little
          ? bytes[index] | (bytes[index + 1] << 8)
          : (bytes[index] << 8) | bytes[index + 1];
        const read32 = (index) => little
          ? (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24)) >>> 0
          : ((bytes[index] << 24) | (bytes[index + 1] << 16) | (bytes[index + 2] << 8) | bytes[index + 3]) >>> 0;
        if (read16(tiff + 2) !== 42) return 1;
        const directory = tiff + read32(tiff + 4);
        const count = read16(directory);
        for (let item = 0, entry = directory + 2; item < count; item++, entry += 12) {
          if (read16(entry) === 0x0112) return read16(entry + 8);
        }
      }
      offset += 2 + length;
    }
    return 1;
  }

  function sharpnessVariance(context, width, height) {
    const sampleWidth = Math.min(256, width), sampleHeight = Math.min(256, height);
    const sample = document.createElement('canvas');
    sample.width = sampleWidth;
    sample.height = sampleHeight;
    const sampleContext = sample.getContext('2d', { willReadFrequently: true });
    if (!sampleContext) return null;
    sampleContext.drawImage(context.canvas, 0, 0, sampleWidth, sampleHeight);
    const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const gray = new Float32Array(sampleWidth * sampleHeight);
    for (let index = 0; index < gray.length; index++) {
      const pixel = index * 4;
      gray[index] = (pixels[pixel] * 0.299) + (pixels[pixel + 1] * 0.587) + (pixels[pixel + 2] * 0.114);
    }
    let sum = 0, squared = 0, count = 0;
    for (let y = 1; y < sampleHeight - 1; y++) {
      for (let x = 1; x < sampleWidth - 1; x++) {
        const index = y * sampleWidth + x;
        const laplacian = (4 * gray[index]) - gray[index - 1] - gray[index + 1]
          - gray[index - sampleWidth] - gray[index + sampleWidth];
        sum += laplacian;
        squared += laplacian * laplacian;
        count++;
      }
    }
    return count ? (squared / count) - ((sum / count) ** 2) : null;
  }

  async function prepare(file) {
    const spec = await getSpec();
    const policy = spec.normalization;
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      throw new Error('Choose a PNG, JPG/JPEG, or WEBP chart image.');
    }
    const orientation = jpegOrientation(new Uint8Array(await file.slice(0, 262144).arrayBuffer()));
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        colorSpaceConversion: 'default',
        premultiplyAlpha: 'default',
      });
    } catch {
      throw new Error('The image could not be decoded. It may be corrupt or unsupported.');
    }
    try {
      const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
      if (sourceWidth < policy.minimum_width || sourceHeight < policy.minimum_height) {
        throw new Error(`Image is too small (${sourceWidth}×${sourceHeight}); minimum is ${policy.minimum_width}×${policy.minimum_height}.`);
      }
      const scale = Math.min(1, policy.max_dimension / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!context) throw new Error('Image preparation is not supported by this browser.');
      context.fillStyle = policy.background;
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const sharpness = sharpnessVariance(context, width, height);
      const normalizedBlob = await new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Could not encode the normalized chart image.')),
        policy.format,
        policy.jpeg_quality,
      ));
      const normalized = new File([normalizedBlob], `${file.name.replace(/\.[^.]+$/, '')}-analysis.jpg`, {
        type: policy.format,
        lastModified: file.lastModified,
      });
      const aspect = sourceWidth / sourceHeight;
      return {
        file: normalized,
        metadata: {
          mode: 'browser_canvas',
          source_format: file.type,
          source_width: sourceWidth,
          source_height: sourceHeight,
          source_bytes: file.size,
          normalized_format: policy.format,
          normalized_width: width,
          normalized_height: height,
          normalized_bytes: normalized.size,
          aspect_ratio: Number(aspect.toFixed(5)),
          unusual_aspect_ratio: aspect < policy.unusual_aspect_ratio_below || aspect > policy.unusual_aspect_ratio_above,
          exif_orientation: orientation,
          orientation_applied: true,
          color_space: policy.color_space,
          transparency_background: policy.background,
          sharpness_laplacian_variance: sharpness === null ? null : Number(sharpness.toFixed(2)),
          blur_risk: sharpness === null ? 'unavailable' : sharpness < policy.blur_variance_threshold ? 'possible' : 'not_obvious',
          glare_risk: 'visual_stage_assessment',
          crop_risk: 'visual_stage_assessment',
        },
      };
    } finally {
      bitmap.close();
    }
  }

  window.prepareChartImage = prepare;
})();
