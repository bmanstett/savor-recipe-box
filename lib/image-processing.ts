const MAX_EDGES = [1_600, 1_280, 1_024, 800];
const MAX_OUTPUT_BYTES = 900_000;
const MIN_QUALITY = 0.42;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('This photo format could not be read by your browser. If it is a HEIC or RAW photo, ask your device to share it as JPEG first.'));
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The image could not be compressed.')), type, quality);
  });
}

export async function prepareRecipeImage(file: File): Promise<{ dataUrl: string; mimeType: string }> {
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error('Choose a photo or image file.');
  }
  if (file.size > 25_000_000) throw new Error('Images must be smaller than 25 MB before compression.');
  const source = URL.createObjectURL(file);
  try {
    const image = await loadImage(source);
    // Safari cannot encode WebP from a canvas; it silently substitutes an
    // oversized PNG, so verify the blob type and fall back to JPEG.
    let encoder = 'image/webp';
    let previousEdge = 0;
    for (const maxEdge of MAX_EDGES) {
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      if (Math.max(width, height) === previousEdge) break;
      previousEdge = Math.max(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not prepare this image.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      let quality = 0.82;
      let blob = await canvasBlob(canvas, encoder, quality);
      if (blob.type !== encoder) {
        encoder = 'image/jpeg';
        blob = await canvasBlob(canvas, encoder, quality);
      }
      while (blob.size > MAX_OUTPUT_BYTES && quality > MIN_QUALITY) {
        quality -= 0.1;
        blob = await canvasBlob(canvas, encoder, quality);
      }
      if (blob.type === encoder && blob.size <= MAX_OUTPUT_BYTES) {
        return { dataUrl: await readAsDataUrl(blob), mimeType: blob.type };
      }
    }
    throw new Error('This image is too detailed to sync safely. Try a smaller crop.');
  } finally {
    URL.revokeObjectURL(source);
  }
}
