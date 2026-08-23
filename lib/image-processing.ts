const MAX_EDGE = 1_600;
const MAX_OUTPUT_BYTES = 900_000;

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
    image.onerror = () => reject(new Error('This image format could not be read by your browser.'));
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The image could not be compressed.')), 'image/webp', quality);
  });
}

export async function prepareRecipeImage(file: File): Promise<{ dataUrl: string; mimeType: string }> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Use a JPEG, PNG, or WebP image. HEIC photos need to be converted by your device first.');
  }
  if (file.size > 15_000_000) throw new Error('Images must be smaller than 15 MB before compression.');
  const source = URL.createObjectURL(file);
  try {
    const image = await loadImage(source);
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare this image.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let quality = 0.82;
    let blob = await canvasBlob(canvas, quality);
    while (blob.size > MAX_OUTPUT_BYTES && quality > 0.42) {
      quality -= 0.1;
      blob = await canvasBlob(canvas, quality);
    }
    if (blob.size > MAX_OUTPUT_BYTES) throw new Error('This image is too detailed to sync safely. Try a smaller crop.');
    return { dataUrl: await readAsDataUrl(blob), mimeType: 'image/webp' };
  } finally {
    URL.revokeObjectURL(source);
  }
}
